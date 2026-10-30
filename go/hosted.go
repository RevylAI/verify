package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

var hostedRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,255}$`)

func Attach(ctx context.Context, computerID string, options ...OpenOptions) (*Session, error) {
	if !uuidPattern.MatchString(computerID) {
		return nil, failure(ErrInvalidArgument, "Computer ID must be a Revyl UUID.")
	}
	opt, err := openOptions(options)
	if err != nil {
		return nil, err
	}
	c, viewer, err := newClient(opt)
	if err != nil {
		return nil, err
	}
	s := &Session{client: c, id: computerID, viewerBase: viewer, viewer: viewer + "/sessions/" + url.PathEscape(computerID) + "?kind=computer", stepTimeout: opt.StepTimeout, log: opt.Log}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, err := s.computerRequest(ctx, http.MethodGet, "/report", nil)
	if err != nil {
		return nil, err
	}
	report, err := s.readComputerReport(r)
	if err != nil {
		return nil, err
	}
	if report.OS != "macos" && report.OS != "linux" || report.ExpiresAt == nil {
		return nil, invalidComputerResponse()
	}
	if report.State != "active" || !time.Now().Before(*report.ExpiresAt) {
		return nil, failure(ErrSessionEnded, "The computer is not active or its lifetime has expired.")
	}
	s.platform = Mac
	if report.OS == "linux" {
		s.platform = Linux
	}
	s.expiresAt = *report.ExpiresAt
	s.leaveComputerRunning = opt.StopOnClose != nil && !*opt.StopOnClose
	s.lifetime, s.stopLifetime = context.WithCancel(context.Background())
	return s, nil
}

func CurrentComputer(ctx context.Context, options ...OpenOptions) (*Session, error) {
	computerID := strings.TrimSpace(os.Getenv("REVYL_COMPUTER_ID"))
	if computerID == "" {
		return nil, failure(ErrComputerIDMissing, "No current Revyl computer is available. Run this job on a revyl-macos runner.")
	}
	opt, err := openOptions(options)
	if err != nil {
		return nil, err
	}
	if opt.StopOnClose == nil {
		stopOnClose := false
		opt.StopOnClose = &stopOnClose
	}
	return Attach(ctx, computerID, opt)
}

func (s *Session) Open(ctx context.Context, target Target) (*Session, error) {
	if !s.platform.computer() {
		return nil, failure(ErrNotAvailableOnPlatform, "Only a computer can host a session.")
	}
	if target.Platform.computer() {
		return nil, failure(ErrInvalidArgument, "Hosted targets must be web, ios, or android.")
	}
	if err := target.validate(true); err != nil {
		return nil, err
	}
	if s.platform == Mac && target.Platform == Android || s.platform == Linux && target.Platform == IOS {
		return nil, &Error{Code: ErrNotAvailableOnPlatform, Reason: ReasonComputerCannotHostPlatform, Message: "This computer cannot host the requested platform."}
	}
	s.mu.Lock()
	if s.expiresAt.IsZero() {
		s.mu.Unlock()
		return nil, failure(ErrAPI, "A confirmed computer expiry is required before hosting a session.")
	}
	if s.closeDone != nil || !s.expiresAt.IsZero() && !time.Now().Before(s.expiresAt) {
		s.mu.Unlock()
		return nil, failure(ErrSessionEnded, "The computer was closed or expired.")
	}
	s.childOpens.Add(1)
	s.mu.Unlock()
	defer s.childOpens.Done()
	ctx, cancel := context.WithTimeout(ctx, target.StartTimeout)
	defer cancel()
	if !s.expiresAt.IsZero() {
		var expire context.CancelFunc
		ctx, expire = context.WithDeadline(ctx, s.expiresAt)
		defer expire()
	}
	stop := context.AfterFunc(s.lifetime, cancel)
	defer stop()
	if s.lifetime.Err() != nil {
		cancel()
	}
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	id, err := newUUID()
	if err != nil {
		return nil, failure(ErrAPI, "Could not generate a hosted session ID.")
	}
	child := &Session{client: s.client, id: id, platform: target.Platform, viewer: s.viewerBase + "/sessions/" + url.PathEscape(id), stepTimeout: s.stepTimeout, log: s.log, expiresAt: s.expiresAt, lifetime: s.lifetime}
	request := map[string]any{"platform": target.Platform, "session_id": id, "computer_session_id": s.id, "app_id": target.AppID, "build_id": target.BuildID, "idle_timeout_seconds": target.IdleTimeoutSeconds}
	if target.Platform == Web {
		web := map[string]any{}
		if target.Viewport != nil {
			web["viewport"] = target.Viewport
		}
		if target.SignIn != nil {
			web["sign_in"] = target.SignIn
		}
		request["web"] = web
	} else {
		request["is_simulation"] = true
	}
	r, err := s.client.send(ctx, http.MethodPost, "/api/v1/execution/start_device", request, false, 2*time.Minute, false)
	reason := refusalReason(r)
	if err == nil && ((r.status >= 400 && r.status < 500 && r.status != 408) || (r.status == 503 && reason != "" && reason != ReasonRequestTimeout && reason != ReasonProtocolError)) {
		return nil, hostedStartError(r)
	}
	s.mu.Lock()
	s.children = append(s.children, child)
	s.mu.Unlock()
	if err == nil && (r.status < 200 || r.status >= 300) {
		err = hostedStartError(r)
	}
	if err == nil {
		var start struct {
			SessionID string          `json:"session_id"`
			RunID     string          `json:"workflow_run_id"`
			Platform  json.RawMessage `json:"platform"`
		}
		err = decode(r, &start)
		if err == nil {
			var platform Platform
			if start.SessionID != id || !hostedRunIDPattern.MatchString(start.RunID) || len(start.Platform) != 0 && (json.Unmarshal(start.Platform, &platform) != nil || platform != target.Platform) {
				err = failure(ErrSessionStartFailed, "Revyl did not acknowledge the hosted session.")
			} else {
				child.runID = start.RunID
			}
		}
	}
	if err == nil {
		err = child.ready(ctx, target)
	}
	if err == nil && target.Platform != Web {
		err = child.waitFirstScreen(ctx, ctx)
	}
	if err == nil {
		s.mu.Lock()
		closing := s.closeDone != nil
		s.mu.Unlock()
		if closing {
			err = failure(ErrSessionEnded, "The computer is closing.")
		} else if ctx.Err() != nil {
			err = contextError(ctx)
		}
	}
	if err != nil {
		cleanup, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cleanupCancel()
		return nil, errors.Join(err, child.Close(cleanup))
	}
	return child, nil
}

func hostedStartError(r response) error {
	code := ErrAPI
	reason := refusalReason(r)
	switch {
	case r.status == 401 || r.status == 403:
		code = ErrAuthRejected
	case reason == ReasonComputerNotFound || r.status == 404:
		code = ErrNotFound
	case reason == ReasonComputerNotRunning:
		code = ErrSessionEnded
	case reason == ReasonComputerCannotHostPlatform || reason == ReasonWebRuntimeUnavailable || reason == ReasonWebRuntimeNotConfigured || reason == ReasonRuntimeUnavailable || reason == ReasonComputerRuntimeUnavailable || reason == ReasonNotAvailableOnPlatform:
		code = ErrNotAvailableOnPlatform
	case reason == ReasonComputerLimit || reason == ReasonComputerAtCapacity:
		code = ErrComputerLimit
	case strings.Contains(string(reason), "_build_"):
		code = ErrInvalidArgument
	case strings.HasSuffix(string(reason), "_session_conflict"):
		code = ErrSessionBusy
	case r.status == 422:
		code = ErrInvalidArgument
	case r.status == 400:
		code = ErrInvalidArgument
	case r.status == 409:
		code = ErrSessionBusy
	case r.status == 408 || r.status >= 500:
		code = ErrActionUncertain
	}
	return responseFailure(r, code, fmt.Sprintf("Revyl refused the hosted session (HTTP %d).", r.status))
}

func (s *Session) Navigate(ctx context.Context, rawURL string) error {
	if s.platform != Web {
		return &Error{Code: ErrNotAvailableOnPlatform, Reason: ReasonNotAvailableOnPlatform, Message: "Navigate is available only on web sessions."}
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" || u.User != nil || !strings.EqualFold(u.Scheme, "http") && !strings.EqualFold(u.Scheme, "https") || textLength(rawURL) > 2048 || strings.ContainsRune(rawURL, '\\') || strings.IndexFunc(rawURL, func(r rune) bool { return unicode.IsControl(r) || unicode.IsSpace(r) }) >= 0 {
		return failure(ErrInvalidArgument, "Navigation requires an HTTP(S) URL of at most 2048 characters without credentials, whitespace, controls, or backslashes.")
	}
	if port := u.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 0 || value > 65535 {
			return failure(ErrInvalidArgument, "Navigation requires a valid URL port.")
		}
	}
	r, err := s.worker(ctx, http.MethodPost, "open_url", map[string]string{"url": rawURL}, false, 30*time.Second)
	if err != nil {
		var sdkError *Error
		if errors.As(err, &sdkError) && sdkError.Code == ErrActionUncertain && sdkError.Reason == ReasonRequestTimeout {
			sdkError.Message = "Web navigation did not confirm within the action budget and may still complete. The session is still open; Verify did not replay the request. See " + s.viewer
		}
		return err
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(r.body, &result) != nil || result == nil {
		return failure(ErrAPI, "Revyl returned an invalid navigation response.")
	}
	success, ok := result["success"]
	var succeeded *bool
	if !ok || json.Unmarshal(success, &succeeded) != nil || succeeded == nil {
		return failure(ErrAPI, "Revyl returned an invalid navigation response.")
	}
	if action, ok := result["action"]; ok {
		var value string
		if json.Unmarshal(action, &value) != nil || value != "navigate" {
			return failure(ErrAPI, "Revyl returned an invalid navigation action.")
		}
	}
	var statusCode int
	if rawStatus, ok := result["status_code"]; ok {
		if json.Unmarshal(rawStatus, &statusCode) != nil || statusCode < 100 || statusCode > 599 {
			return failure(ErrAPI, "Revyl returned an invalid navigation status code.")
		}
	}
	if !*succeeded {
		return failure(ErrActionFailed, "Web navigation did not succeed.")
	}
	return nil
}

func (s *Session) Report(ctx context.Context) (map[string]any, error) {
	if s.id == "" {
		return nil, failure(ErrNotFound, "The session ID is unknown; a report is not available.")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var r response
	var err error
	if s.platform.computer() {
		r, err = s.computerRequest(ctx, http.MethodGet, "/report", nil)
		if err == nil {
			_, err = s.readComputerReport(r)
		}
	} else {
		r, err = s.client.send(ctx, http.MethodGet, "/api/v1/execution/device-sessions/"+url.PathEscape(s.id), nil, true, 30*time.Second, false)
		if err == nil && (r.status < 200 || r.status >= 300) {
			err = httpError(r)
		}
	}
	if err != nil {
		return nil, err
	}
	var report map[string]any
	if err := decode(r, &report); err != nil {
		return nil, err
	}
	return report, nil
}
