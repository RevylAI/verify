package verify

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const computerAvailability = "Mac and Linux computers are early access, not yet available in Revyl production. Staging access requires organization and OS enablement. See https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors"
const maxComputerOutput = 1048576
const computerObservationTimeout = 310 * time.Second

type OperationOptions struct{ Timeout time.Duration }

type ExecOptions struct {
	Timeout time.Duration
	Stdin   []byte
	Check   *bool
}

type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

type FileStat struct {
	Kind string
	Size int64
}

type ComputerProcess struct {
	ID       string
	State    string
	ExitCode *int
}

type ComputerRecording struct {
	URL       string
	Duration  *time.Duration
	StartedAt *time.Time
}

type computerReport struct {
	ID            string     `json:"computer_session_id"`
	OS            string     `json:"os"`
	State         string     `json:"state"`
	Release       string     `json:"release"`
	FailureReason string     `json:"failure_reason"`
	ExpiresAt     *time.Time `json:"expires_at"`
}

type processHandle struct {
	SessionID string `json:"computer_session_id"`
	ID        string `json:"handle_id"`
}

type computerResult struct {
	Kind        string  `json:"kind"`
	ExitCode    *int    `json:"exit_code"`
	Stdout      string  `json:"stdout"`
	Stderr      string  `json:"stderr"`
	Data        *string `json:"data"`
	ByteCount   *int    `json:"byte_count"`
	FileKind    string  `json:"file_kind"`
	Size        *int64  `json:"size_bytes"`
	Termination string  `json:"termination"`
	Processes   *[]struct {
		Handle   processHandle `json:"handle"`
		State    string        `json:"state"`
		ExitCode *int          `json:"exit_code"`
	} `json:"processes"`
}

func invalidComputerResponse() error {
	return failure(ErrAPI, "Revyl returned an invalid computer response.")
}

func startComputer(ctx context.Context, c *client, viewer string, target Target, options OpenOptions) (*Session, error) {
	id, err := newUUID()
	if err != nil {
		return nil, failure(ErrAPI, "Could not generate a computer session ID.")
	}
	lifetime, stop := context.WithCancel(context.Background())
	s := &Session{client: c, id: id, platform: target.Platform, viewer: viewer + "/sessions/" + url.PathEscape(id) + "?kind=computer", viewerBase: viewer, lifetime: lifetime, stopLifetime: stop, log: options.Log, stepTimeout: options.StepTimeout}
	s.computerLog("starting " + string(s.platform) + " computer " + s.viewer + ". " + computerAvailability)
	computerOS := "macos"
	if target.Platform == Linux {
		computerOS = "linux"
	}
	createAcknowledged := false
	err = func() error {
		r, err := s.computerRequest(ctx, "POST", "", map[string]string{"computer_session_id": id, "os": computerOS})
		if err != nil {
			return err
		}
		createAcknowledged = true
		for {
			report, err := s.readComputerReport(r)
			if err != nil {
				return err
			}
			if report.State == "active" {
				s.computerScreenReadyUntil = time.Now().Add(30 * time.Second)
				if report.ExpiresAt != nil {
					s.expiresAt = *report.ExpiresAt
				}
				return nil
			}
			if report.State != "starting" {
				reason := report.State
				if report.FailureReason == "no_host" {
					reason += ": no_host; the unclaimed start expired after 120 seconds without a free host"
				} else if report.FailureReason == "device_limit" {
					reason += ": device_limit; queued work or the concurrency limit prevented the start"
				}
				return failure(ErrSessionStartFailed, fmt.Sprintf("The %s computer ended before it was ready (%s). See %s", s.platform, reason, s.viewer))
			}
			if err := pause(ctx, 2*time.Second); err != nil {
				return err
			}
			r, err = s.computerRequest(ctx, "GET", "/report", nil)
			if err != nil {
				return err
			}
		}
	}()
	if err == nil {
		s.computerLog("ready")
		return s, nil
	}
	if !createAcknowledged && (errors.Is(err, ErrAuthRejected) || errors.Is(err, ErrEdgeBlocked) || errors.Is(err, ErrNotAvailableOnPlatform) || errors.Is(err, ErrInvalidArgument) || errors.Is(err, ErrComputerLimit)) {
		stop()
	} else {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), computerObservationTimeout)
		defer cancel()
		_ = s.Close(cleanup)
	}
	if ctx.Err() != nil {
		return nil, &Error{Code: ErrTimeout, Message: fmt.Sprintf("The %s computer was not ready within %d ms. A possible cause is that no computer host could be assigned. %s. Inspect %s", s.platform, target.StartTimeout.Milliseconds(), computerAvailability, s.viewer), Cause: ctx.Err()}
	}
	return nil, err
}

func (s *Session) computerLog(message string) {
	if s.log != nil {
		s.log(string(s.platform) + ": " + message)
	}
}

func (s *Session) computerAgentUnavailable(method string) error {
	return failure(ErrNotAvailableOnPlatform, method+"() is not available on "+string(s.platform)+" computers; use exec() and file operations. See "+s.viewer)
}

func (s *Session) assertComputerOpen() error {
	if !s.platform.computer() {
		return failure(ErrNotAvailableOnPlatform, "This operation runs on computer targets, not web or mobile sessions.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closeDone != nil {
		return failure(ErrSessionEnded, "The computer was closed.")
	}
	if !s.expiresAt.IsZero() && !time.Now().Before(s.expiresAt) {
		return failure(ErrSessionEnded, "The computer lifetime has expired. See "+s.viewer)
	}
	return nil
}

func (s *Session) readComputerReport(r response) (computerReport, error) {
	var report computerReport
	if decode(r, &report) != nil || report.ID != s.id {
		return report, invalidComputerResponse()
	}
	switch report.State {
	case "starting", "active", "closing", "stopped", "failed", "owner_lost":
		return report, nil
	default:
		return report, invalidComputerResponse()
	}
}

func (s *Session) computerRequest(ctx context.Context, method, suffix string, body any) (response, error) {
	path := "/api/v1/computer-runs"
	if suffix != "" {
		path += "/" + s.id + suffix
	}
	timeout := 30 * time.Second
	if suffix == "/stop" || strings.HasPrefix(suffix, "/operations") {
		timeout = computerObservationTimeout
	}
	r, err := s.client.send(ctx, method, path, body, method == "GET" && suffix != "/screen/screenshot", timeout, false)
	if err != nil {
		var typed *Error
		cause := err
		if errors.As(err, &typed) {
			cause = typed.Cause
		}
		if method == "POST" || strings.HasPrefix(suffix, "/operations/") {
			return r, &Error{Code: ErrActionUncertain, Message: "Computer request outcome is unconfirmed. Verify will not repeat it. See " + s.viewer, Cause: cause}
		}
		if typed != nil {
			return r, &Error{Code: typed.Code, Message: "Could not read the computer state. See " + s.viewer, Cause: cause}
		}
		return r, err
	}
	if r.status >= 200 && r.status < 300 {
		return r, nil
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(r.body, &raw)
	var detail string
	for _, key := range []string{"detail", "message", "error"} {
		if raw[key] == nil || string(raw[key]) == "null" {
			continue
		}
		_ = json.Unmarshal(raw[key], &detail)
		break
	}
	if reason := refusalReason(r); reason != "" {
		detail = string(reason)
	}
	if suffix == "/screen/screenshot" && ((detail == "screen_unavailable" && (r.status == 409 || r.status == 503)) || (detail == "screen_starting" && r.status == 409)) {
		return r, nil
	}
	if detail == "computer_not_enabled" || (r.status == 503 && detail == "runtime_unavailable") {
		return r, responseFailure(r, ErrNotAvailableOnPlatform, fmt.Sprintf("Revyl refused the computer request (%s). %s. Ask support@revyl.ai about staging organization enablement. See %s", detail, computerAvailability, s.viewer))
	}
	if r.status == 429 && detail == "computer_limit" {
		return r, responseFailure(r, ErrComputerLimit, "Computer admission was refused because of queued work (including iOS) or the concurrency limit. Verify will not retry the start. See "+s.viewer)
	}
	if method == "GET" && suffix == "/recording" && r.status == 404 && detail == "recording_unavailable" {
		return r, nil
	}
	code := ErrAPI
	switch {
	case r.status == 401 || r.status == 403:
		code = ErrAuthRejected
	case detail == "run_closed":
		code = ErrSessionEnded
	case detail == "inaccessible" || detail == "invalid_handle":
		code = ErrNotFound
	case detail == "operation_not_found" || detail == "owner_unavailable":
		code = ErrActionUncertain
	case detail == "invalid_request" || r.status == 422:
		code = ErrInvalidArgument
	case detail == "start_failed":
		code = ErrSessionStartFailed
	case r.status == 409 || detail == "operation_limit":
		code = ErrSessionBusy
	case strings.HasPrefix(suffix, "/operations/") && r.status >= 500:
		code = ErrActionUncertain
	case method == "POST" && (r.status >= 500 || r.status < 400):
		code = ErrActionUncertain
	}
	reason := fmt.Sprintf("HTTP %d", r.status)
	switch detail {
	case "computer_not_enabled", "run_closed", "inaccessible", "invalid_handle", "operation_not_found", "owner_unavailable", "invalid_request", "unauthenticated", "forbidden", "runtime_unavailable", "start_failed", "computer_limit", "request_conflict", "run_conflict", "evidence_conflict", "evidence_unavailable", "authentication_unavailable", "operation_limit", "screen_starting", "screen_unavailable":
		reason = detail
	}
	return r, responseFailure(r, code, fmt.Sprintf("Revyl refused the computer request (%s). See %s", reason, s.viewer))
}

func (s *Session) closeComputer(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, computerObservationTimeout)
	defer cancel()
	r, err := s.computerRequest(ctx, "POST", "/stop", nil)
	if err == nil {
		var report computerReport
		report, err = s.readComputerReport(r)
		if err == nil {
			if report.Release != "confirmed" {
				err = failure(ErrActionUncertain, "Computer stop was requested, but physical release is unconfirmed. Inspect "+s.viewer)
			} else if report.State != "stopped" && report.State != "failed" && report.State != "owner_lost" {
				err = invalidComputerResponse()
			}
		}
	}
	if err == nil {
		s.computerLog("closed")
		return nil
	}
	if errors.Is(err, ErrActionUncertain) {
		var typed *Error
		errors.As(err, &typed)
		err = &Error{Code: ErrActionUncertain, Reason: typed.Reason, HTTPStatus: typed.HTTPStatus, Message: typed.Message + " A possible cause is that no computer host could be assigned. " + computerAvailability, Cause: typed.Cause}
	}
	s.computerLog("close failed; inspect " + s.viewer)
	return err
}

func (s *Session) observationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	deadline := time.Now().Add(computerObservationTimeout)
	if !s.expiresAt.IsZero() && s.expiresAt.Before(deadline) {
		deadline = s.expiresAt
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	stop := context.AfterFunc(s.lifetime, cancel)
	if s.lifetime.Err() != nil {
		cancel()
	}
	return ctx, func() { stop(); cancel() }
}

func operationTimeout(options []OperationOptions) (int64, error) {
	if len(options) > 1 {
		return 0, failure(ErrInvalidArgument, "Computer operation accepts at most one options value.")
	}
	timeout := 30 * time.Second
	if len(options) == 1 && options[0].Timeout != 0 {
		timeout = options[0].Timeout
	}
	if timeout < time.Millisecond || timeout > 5*time.Minute || timeout%time.Millisecond != 0 {
		return 0, failure(ErrInvalidArgument, "Computer operation timeout must be an integer from 1 to 300000 ms.")
	}
	return timeout.Milliseconds(), nil
}

func guestPath(path string) error {
	if path == "" || len(path) > 1024 || strings.ContainsAny(path, "\\:") {
		return failure(ErrInvalidArgument, "Computer paths must be workspace-relative, without empty, dot, parent, backslash, colon, or control-character components.")
	}
	for _, c := range []byte(path) {
		if c < 32 || c == 127 {
			return failure(ErrInvalidArgument, "Computer paths cannot contain control characters.")
		}
	}
	for _, component := range strings.Split(path, "/") {
		if component == "" || component == "." || component == ".." {
			return failure(ErrInvalidArgument, "Computer paths must be workspace-relative without empty, dot, or parent components.")
		}
	}
	return nil
}

func computerOperationID(sessionID, requestID string) string {
	namespace, _ := hex.DecodeString(strings.ReplaceAll(sessionID, "-", ""))
	h := sha1.New()
	_, _ = h.Write(namespace)
	_, _ = h.Write([]byte(requestID))
	b := h.Sum(nil)[:16]
	b[6] = b[6]&0x0f | 0x50
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (s *Session) computerOperation(ctx context.Context, command map[string]any, allowNonzero bool) (result computerResult, err error) {
	if err := s.assertComputerOpen(); err != nil {
		return result, err
	}
	requestID, err := newUUID()
	if err != nil {
		return result, failure(ErrAPI, "Could not generate a computer request ID.")
	}
	operationID := computerOperationID(s.id, requestID)
	ctx, cancel := s.observationContext(ctx)
	defer cancel()
	defer func() {
		if err != nil && ctx.Err() != nil {
			err = &Error{Code: ErrActionUncertain, Message: fmt.Sprintf("Computer operation %s stopped being observed; its outcome is unconfirmed. See %s", operationID, s.viewer), Cause: ctx.Err()}
		}
	}()
	wireCommand := maps.Clone(command)
	switch command["kind"] {
	case "exec":
		argv := command["argv"].([]string)
		encoded := make([]string, len(argv))
		for i, arg := range argv {
			encoded[i] = base64.URLEncoding.EncodeToString([]byte(arg))
		}
		wireCommand["argv_b64"] = encoded
		delete(wireCommand, "argv")
	case "file_read", "file_write", "file_stat":
		wireCommand["path_b64"] = base64.URLEncoding.EncodeToString([]byte(command["path"].(string)))
		delete(wireCommand, "path")
	}
	r, err := s.computerRequest(ctx, "POST", "/operations", map[string]any{"computer_session_id": s.id, "request_id": requestID, "command": wireCommand})
	if err != nil {
		return result, err
	}
	for {
		if r.status != 202 {
			var envelope struct {
				ID        string `json:"computer_session_id"`
				OpID      string `json:"operation_id"`
				Evidence  string `json:"evidence"`
				Execution *struct {
					Outcome     string          `json:"outcome"`
					ErrorCode   string          `json:"error_code"`
					Termination string          `json:"termination"`
					Result      *computerResult `json:"result"`
				} `json:"execution"`
			}
			if decode(r, &envelope) != nil || envelope.ID != s.id || envelope.OpID != operationID || (envelope.Evidence != "recorded" && envelope.Evidence != "pending" && envelope.Evidence != "failed") || envelope.Execution == nil {
				return result, invalidComputerResponse()
			}
			execution := envelope.Execution
			kind := command["kind"].(string)
			if execution.Outcome == "succeeded" || (execution.Outcome == "failed" && execution.ErrorCode == "exec_nonzero" && allowNonzero) {
				if execution.Result == nil || execution.Result.Kind != kind {
					return result, invalidComputerResponse()
				}
				result = *execution.Result
				if result.Kind == "exec" && (result.ExitCode == nil || (execution.Outcome == "succeeded" && *result.ExitCode != 0) || (execution.Outcome == "failed" && *result.ExitCode == 0)) {
					return result, invalidComputerResponse()
				}
				if envelope.Evidence != "recorded" {
					s.computerLog(fmt.Sprintf("operation %s: execution observed, report evidence %s", operationID, envelope.Evidence))
				}
				return result, nil
			}
			switch execution.Outcome {
			case "failed":
				code := ErrAPI
				switch execution.ErrorCode {
				case "exec_nonzero":
					if kind != "exec" || execution.Result == nil || execution.Result.Kind != "exec" || execution.Result.ExitCode == nil || *execution.Result.ExitCode == 0 {
						return result, invalidComputerResponse()
					}
					observed, err := decodeExec(*execution.Result)
					if err != nil {
						return result, err
					}
					return result, &Error{Code: ErrCommandFailed, Message: fmt.Sprintf("Computer exec failed (exec_nonzero, exit code %d). See %s", observed.ExitCode, s.viewer), ExecResult: &observed}
				case "not_found":
					code = ErrNotFound
				case "access_denied":
					code = ErrAccessDenied
				default:
					return result, invalidComputerResponse()
				}
				return result, failure(code, fmt.Sprintf("Computer %s failed (%s). See %s", kind, execution.ErrorCode, s.viewer))
			case "timed_out":
				if execution.Termination == "unknown" {
					return result, failure(ErrActionUncertain, fmt.Sprintf("Computer %s timed out; termination is unconfirmed. Verify will not repeat it. See %s", kind, s.viewer))
				}
				if execution.Termination != "confirmed" {
					return result, invalidComputerResponse()
				}
				return result, failure(ErrTimeout, fmt.Sprintf("Computer %s timed out; termination was confirmed. See %s", kind, s.viewer))
			case "unknown":
				return result, failure(ErrActionUncertain, fmt.Sprintf("Computer %s outcome is unconfirmed. Verify will not repeat it. Inspect operation %s at %s", kind, operationID, s.viewer))
			default:
				return result, invalidComputerResponse()
			}
		}
		if !bytes.Equal(bytes.TrimSpace(r.body), []byte("null")) {
			return result, invalidComputerResponse()
		}
		if err := pause(ctx, 2*time.Second); err != nil {
			return result, err
		}
		r, err = s.computerRequest(ctx, "GET", "/operations/"+operationID, nil)
		if err != nil {
			return result, err
		}
	}
}

func decodeComputerBytes(value string, max int) ([]byte, error) {
	if len(value) > ((max+2)/3)*4 || len(value)%4 != 0 {
		return nil, invalidComputerResponse()
	}
	normalized := strings.NewReplacer("-", "+", "_", "/").Replace(value)
	data, err := base64.StdEncoding.Strict().DecodeString(normalized)
	if err != nil || len(data) > max || base64.StdEncoding.EncodeToString(data) != normalized {
		return nil, invalidComputerResponse()
	}
	return data, nil
}

func decodeExec(result computerResult) (ExecResult, error) {
	if result.Kind != "exec" || result.ExitCode == nil || *result.ExitCode < -255 || *result.ExitCode > 255 {
		return ExecResult{}, invalidComputerResponse()
	}
	stdout, err := decodeComputerBytes(result.Stdout, maxComputerOutput)
	if err != nil {
		return ExecResult{}, err
	}
	stderr, err := decodeComputerBytes(result.Stderr, maxComputerOutput)
	if err != nil || len(stdout)+len(stderr) > maxComputerOutput {
		return ExecResult{}, invalidComputerResponse()
	}
	return ExecResult{ExitCode: *result.ExitCode, Stdout: computerText(stdout), Stderr: computerText(stderr)}, nil
}

func computerText(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var text strings.Builder
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		if r == utf8.RuneError && size == 1 {
			lead := data[0]
			expected := 1
			switch {
			case lead >= 0xc2 && lead <= 0xdf:
				expected = 2
			case lead >= 0xe0 && lead <= 0xef:
				expected = 3
			case lead >= 0xf0 && lead <= 0xf4:
				expected = 4
			}
			for size < expected && size < len(data) {
				next := data[size]
				if next < 0x80 || next > 0xbf || (size == 1 && ((lead == 0xe0 && next < 0xa0) || (lead == 0xed && next > 0x9f) || (lead == 0xf0 && next < 0x90) || (lead == 0xf4 && next > 0x8f))) {
					break
				}
				size++
			}
		}
		text.WriteRune(r)
		data = data[size:]
	}
	return text.String()
}

func (s *Session) Exec(ctx context.Context, argv []string, options ...ExecOptions) (ExecResult, error) {
	if !s.platform.computer() {
		return ExecResult{}, s.assertComputerOpen()
	}
	if len(options) > 1 {
		return ExecResult{}, failure(ErrInvalidArgument, "Exec accepts at most one options value.")
	}
	var opt ExecOptions
	if len(options) == 1 {
		opt = options[0]
	}
	if len(argv) < 1 || len(argv) > 64 || argv[0] == "" {
		return ExecResult{}, failure(ErrInvalidArgument, "exec() takes 1-64 string arguments without NUL bytes; argv and stdin together must fit in 16384 bytes.")
	}
	size := len(opt.Stdin)
	for _, arg := range argv {
		if strings.ContainsRune(arg, 0) {
			return ExecResult{}, failure(ErrInvalidArgument, "Exec arguments cannot contain NUL bytes.")
		}
		size += len(arg)
	}
	if size > 16384 {
		return ExecResult{}, failure(ErrInvalidArgument, "Exec argv and stdin together must fit in 16384 bytes.")
	}
	timeout, err := operationTimeout([]OperationOptions{{Timeout: opt.Timeout}})
	if err != nil {
		return ExecResult{}, err
	}
	result, err := s.computerOperation(ctx, map[string]any{"kind": "exec", "argv": argv, "stdin": base64.StdEncoding.EncodeToString(opt.Stdin), "timeout_ms": timeout}, opt.Check != nil && !*opt.Check)
	if err != nil {
		return ExecResult{}, err
	}
	return decodeExec(result)
}

func (s *Session) ReadFile(ctx context.Context, path string, options ...OperationOptions) ([]byte, error) {
	if !s.platform.computer() {
		return nil, s.assertComputerOpen()
	}
	if err := guestPath(path); err != nil {
		return nil, err
	}
	timeout, err := operationTimeout(options)
	if err != nil {
		return nil, err
	}
	result, err := s.computerOperation(ctx, map[string]any{"kind": "file_read", "path": path, "timeout_ms": timeout}, false)
	if err != nil {
		return nil, err
	}
	if result.Data == nil {
		return nil, invalidComputerResponse()
	}
	return decodeComputerBytes(*result.Data, maxComputerOutput)
}

func (s *Session) WriteFile(ctx context.Context, path string, data []byte, options ...OperationOptions) error {
	if !s.platform.computer() {
		return s.assertComputerOpen()
	}
	if err := guestPath(path); err != nil {
		return err
	}
	if len(data) > 65536 {
		return failure(ErrInvalidArgument, "writeFile() takes at most 65536 bytes.")
	}
	timeout, err := operationTimeout(options)
	if err != nil {
		return err
	}
	result, err := s.computerOperation(ctx, map[string]any{"kind": "file_write", "path": path, "data": base64.StdEncoding.EncodeToString(data), "timeout_ms": timeout}, false)
	if err == nil && (result.ByteCount == nil || *result.ByteCount != len(data)) {
		return invalidComputerResponse()
	}
	return err
}

func (s *Session) Stat(ctx context.Context, path string, options ...OperationOptions) (FileStat, error) {
	if !s.platform.computer() {
		return FileStat{}, s.assertComputerOpen()
	}
	if err := guestPath(path); err != nil {
		return FileStat{}, err
	}
	timeout, err := operationTimeout(options)
	if err != nil {
		return FileStat{}, err
	}
	result, err := s.computerOperation(ctx, map[string]any{"kind": "file_stat", "path": path, "timeout_ms": timeout}, false)
	if err != nil {
		return FileStat{}, err
	}
	if (result.FileKind != "file" && result.FileKind != "directory") || result.Size == nil || *result.Size < 0 || *result.Size > 9007199254740991 {
		return FileStat{}, invalidComputerResponse()
	}
	return FileStat{Kind: result.FileKind, Size: *result.Size}, nil
}

func (s *Session) Processes(ctx context.Context, options ...OperationOptions) ([]ComputerProcess, error) {
	if !s.platform.computer() {
		return nil, s.assertComputerOpen()
	}
	timeout, err := operationTimeout(options)
	if err != nil {
		return nil, err
	}
	result, err := s.computerOperation(ctx, map[string]any{"kind": "process_list", "timeout_ms": timeout}, false)
	if err != nil {
		return nil, err
	}
	if result.Processes == nil || len(*result.Processes) > 64 {
		return nil, invalidComputerResponse()
	}
	processes := make([]ComputerProcess, 0, len(*result.Processes))
	seen := make(map[string]bool)
	for _, process := range *result.Processes {
		if process.Handle.SessionID != s.id || !uuidPattern.MatchString(process.Handle.ID) || (process.State != "running" && process.State != "exited") || (process.ExitCode != nil && (*process.ExitCode < -255 || *process.ExitCode > 255 || process.State == "running")) || seen[process.Handle.ID] {
			return nil, invalidComputerResponse()
		}
		seen[process.Handle.ID] = true
		processes = append(processes, ComputerProcess{ID: process.Handle.ID, State: process.State, ExitCode: process.ExitCode})
	}
	return processes, nil
}

func (s *Session) Terminate(ctx context.Context, processID string, options ...OperationOptions) error {
	if !s.platform.computer() {
		return s.assertComputerOpen()
	}
	if !uuidPattern.MatchString(processID) {
		return failure(ErrInvalidArgument, "terminate() takes a process handle id from processes(), not an OS PID.")
	}
	timeout, err := operationTimeout(options)
	if err != nil {
		return err
	}
	result, err := s.computerOperation(ctx, map[string]any{"kind": "process_terminate", "handle": processHandle{SessionID: s.id, ID: processID}, "timeout_ms": timeout}, false)
	if err == nil && result.Termination != "confirmed" {
		return invalidComputerResponse()
	}
	return err
}

func (s *Session) computerScreenshot(ctx context.Context, paths ...string) ([]byte, error) {
	if err := s.assertComputerOpen(); err != nil {
		return nil, err
	}
	ctx, cancel := s.observationContext(ctx)
	defer cancel()
	observationCtx := ctx
	notReady := func() error {
		return failure(ErrSessionBusy, "The computer desktop is not ready for screenshots after its 30-second startup window. Try again later. See "+s.viewer)
	}
	var r response
	var err error
	transient := false
	for backoff := 500 * time.Millisecond; ; backoff = min(backoff*2, 2*time.Second) {
		if err = s.assertComputerOpen(); err != nil {
			return nil, err
		}
		r, err = s.computerRequest(ctx, "GET", "/screen/screenshot", nil)
		if err != nil {
			if transient && observationCtx.Err() == nil && ctx.Err() != nil && !time.Now().Before(s.computerScreenReadyUntil) {
				return nil, notReady()
			}
			return nil, err
		}
		if r.status >= 200 && r.status < 300 {
			break
		}
		remaining := time.Until(s.computerScreenReadyUntil)
		if remaining <= 0 {
			return nil, notReady()
		}
		if !transient {
			ctx, cancel = context.WithDeadline(ctx, s.computerScreenReadyUntil)
			defer cancel()
		}
		transient = true
		if err := pause(ctx, min(backoff, remaining)); err != nil {
			if observationCtx.Err() == nil && !time.Now().Before(s.computerScreenReadyUntil) {
				return nil, notReady()
			}
			return nil, err
		}
		if !time.Now().Before(s.computerScreenReadyUntil) {
			return nil, notReady()
		}
	}
	var screenshot struct {
		Width  int     `json:"width"`
		Height int     `json:"height"`
		PNG    *string `json:"png"`
	}
	if decode(r, &screenshot) != nil || screenshot.PNG == nil {
		return nil, invalidComputerResponse()
	}
	data, err := decodeComputerBytes(*screenshot.PNG, 128*maxComputerOutput)
	if err != nil || !validPNG(data) || screenshot.Width < 1 || screenshot.Width > 4095 || screenshot.Height < 1 || screenshot.Height > 4095 || int(binary.BigEndian.Uint32(data[16:20])) != screenshot.Width || int(binary.BigEndian.Uint32(data[20:24])) != screenshot.Height {
		return nil, invalidComputerResponse()
	}
	if len(paths) == 1 && paths[0] != "" {
		if err := os.MkdirAll(filepath.Dir(paths[0]), 0o755); err != nil {
			return nil, &Error{Code: ErrActionFailed, Message: "Could not create screenshot directory.", Cause: err}
		}
		if err := os.WriteFile(paths[0], data, 0o600); err != nil {
			return nil, &Error{Code: ErrActionFailed, Message: "Could not write screenshot.", Cause: err}
		}
	}
	return data, nil
}

func (s *Session) Recording(ctx context.Context) (*ComputerRecording, error) {
	if !s.platform.computer() {
		return nil, s.assertComputerOpen()
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, err := s.computerRequest(ctx, "GET", "/report", nil)
	if err != nil {
		return nil, err
	}
	report, err := s.readComputerReport(r)
	if err != nil {
		return nil, err
	}
	if report.Release != "confirmed" || (report.State != "stopped" && report.State != "failed" && report.State != "owner_lost") {
		return nil, failure(ErrSessionBusy, "Recording is available only after confirmed physical release. See "+s.viewer)
	}
	r, err = s.computerRequest(ctx, "GET", "/recording", nil)
	if err != nil || r.status == 404 {
		return nil, err
	}
	var raw struct {
		URL       string   `json:"url"`
		Duration  *float64 `json:"duration_seconds"`
		StartedAt *string  `json:"started_at"`
	}
	if decode(r, &raw) != nil {
		return nil, invalidComputerResponse()
	}
	parsed, err := url.Parse(raw.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, invalidComputerResponse()
	}
	recording := &ComputerRecording{URL: raw.URL}
	if raw.Duration != nil {
		if math.IsNaN(*raw.Duration) || math.IsInf(*raw.Duration, 0) || *raw.Duration < 0 || *raw.Duration >= float64(math.MaxInt64)/float64(time.Second) {
			return nil, invalidComputerResponse()
		}
		duration := time.Duration(*raw.Duration * float64(time.Second))
		recording.Duration = &duration
	}
	if raw.StartedAt != nil {
		startedAt, err := time.Parse(time.RFC3339Nano, *raw.StartedAt)
		if err != nil {
			return nil, invalidComputerResponse()
		}
		recording.StartedAt = &startedAt
	}
	return recording, nil
}
