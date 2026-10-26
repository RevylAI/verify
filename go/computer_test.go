package verify_test

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	verify "github.com/RevylAI/verify/go"
)

const computerPath = "/api/v1/computer-runs"

func newComputerFake(t *testing.T, handler func(*fakeRevyl, http.ResponseWriter, *http.Request, map[string]any) bool) *fakeRevyl {
	t.Helper()
	f := newFake(t)
	data, err := os.ReadFile("testdata/computer-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &f.fixtures); err != nil {
		t.Fatal(err)
	}
	f.handler = func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if handler != nil && handler(f, w, r, body) {
			return true
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, computerPath), "/")
		id := ""
		if len(parts) > 1 {
			id = parts[1]
		}
		switch {
		case r.Method == "POST" && r.URL.Path == computerPath:
			result := f.fixture("active")
			result["computer_session_id"] = body["computer_session_id"]
			writeJSON(w, 200, result)
		case r.Method == "POST" && r.URL.Path == computerPath+"/"+id+"/stop":
			result := f.fixture("stopped")
			result["computer_session_id"] = id
			writeJSON(w, 200, result)
		case r.Method == "GET" && r.URL.Path == computerPath+"/"+id+"/report":
			result := f.fixture("active")
			result["computer_session_id"] = id
			writeJSON(w, 200, result)
		case r.Method == "POST" && r.URL.Path == computerPath+"/"+id+"/operations":
			writeComputerOperation(f, w, body, f.fixture("exec"))
		case r.Method == "GET" && r.URL.Path == computerPath+"/"+id+"/screen/screenshot":
			writeJSON(w, 200, map[string]any{"width": 1280, "height": 800, "png": base64.StdEncoding.EncodeToString(testPNG())})
		default:
			return false
		}
		return true
	}
	return f
}

func operationID(session, request string) string {
	namespace, err := hex.DecodeString(strings.ReplaceAll(session, "-", ""))
	if err != nil || len(namespace) != 16 {
		panic("invalid test session UUID")
	}
	hash := sha1.New()
	_, _ = hash.Write(namespace)
	_, _ = hash.Write([]byte(request))
	id := hash.Sum(nil)[:16]
	id[6] = id[6]&0x0f | 0x50
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func writeComputerOperation(f *fakeRevyl, w http.ResponseWriter, body map[string]any, execution any) {
	result := f.fixture("operation")
	result["computer_session_id"] = body["computer_session_id"]
	result["operation_id"] = operationID(body["computer_session_id"].(string), body["request_id"].(string))
	result["execution"] = execution
	writeJSON(w, 200, result)
}

func operationResult(result map[string]any) map[string]any {
	return map[string]any{"outcome": "succeeded", "result": result}
}

func TestComputerLifecycleAndExec(t *testing.T) {
	f := newComputerFake(t, nil)
	s := f.open(verify.Target{Platform: verify.Mac})
	create := f.calls("POST", computerPath)
	if len(create) != 1 || !reflectMaps(create[0].Body, map[string]any{"computer_session_id": s.ID(), "os": "macos"}) {
		t.Fatal("incorrect computer create body")
	}
	if s.ViewerURL() != "https://viewer.test/sessions/"+s.ID()+"?kind=computer" {
		t.Fatal("incorrect computer viewer URL")
	}
	result, err := s.Exec(context.Background(), []string{"printf", "%s", "a b"}, verify.ExecOptions{Stdin: []byte("input"), Timeout: 300 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.Stdout != "ok\n" || result.Stderr != "" {
		t.Fatalf("incorrect exec result: %#v", result)
	}
	calls := f.calls("POST", computerPath+"/"+s.ID()+"/operations")
	if len(calls) != 1 {
		t.Fatal("exec submission count is not one")
	}
	want := map[string]any{"kind": "exec", "argv": []any{"printf", "%s", "a b"}, "stdin": "aW5wdXQ=", "timeout_ms": float64(300000)}
	if !reflectMaps(calls[0].Body["command"].(map[string]any), want) || calls[0].Header.Get("Prefer") != "respond-async" {
		t.Fatalf("incorrect exec command: %#v", calls[0].Body)
	}
	if calls[0].Header.Get("X-Revyl-Client") != "verify" || calls[0].Body["computer_session_id"] != s.ID() {
		t.Fatal("missing computer attribution or identity")
	}
	fixture := f.fixture("uuidV5")
	if operationID(fixture["session_id"].(string), fixture["request_id"].(string)) != fixture["operation_id"] {
		t.Fatal("test UUIDv5 calculation does not match shared fixture")
	}
	request := calls[0].Body["request_id"].(string)
	if len(request) != 36 || request[14] != '4' || !strings.ContainsRune("89ab", rune(request[19])) {
		t.Fatal("request ID is not a UUIDv4")
	}
	if _, err := s.Instruction(context.Background(), "Open settings"); !errors.Is(err, verify.ErrNotAvailableOnPlatform) {
		t.Fatalf("Mac instruction error = %v", err)
	}
	if _, err := s.Validation(context.Background(), "Settings visible", verify.ValidationOptions{Soft: true}); !errors.Is(err, verify.ErrNotAvailableOnPlatform) {
		t.Fatalf("Mac validation error = %v", err)
	}
	if len(f.calls("POST", computerPath+"/"+s.ID()+"/operations")) != 1 {
		t.Fatal("unsupported agent step reached server")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Close(context.Background()); err != nil {
				t.Errorf("close: %v", err)
			}
		}()
	}
	wg.Wait()
	if len(f.calls("POST", computerPath+"/"+s.ID()+"/stop")) != 1 {
		t.Fatal("computer stop was replayed")
	}
	_, err = s.Exec(context.Background(), []string{"true"})
	requireCode(t, err, verify.ErrSessionEnded)
}

func reflectMaps(a, b map[string]any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func TestComputerNonzeroExit(t *testing.T) {
	f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if !strings.HasSuffix(r.URL.Path, "/operations") {
			return false
		}
		writeComputerOperation(f, w, body, f.fixture("nonzero"))
		return true
	})
	s := f.open(verify.Target{Platform: verify.Mac})
	_, err := s.Exec(context.Background(), []string{"false"})
	requireCode(t, err, verify.ErrCommandFailed)
	var sdkError *verify.Error
	if !errors.As(err, &sdkError) || sdkError.ExecResult == nil || sdkError.ExecResult.ExitCode != 7 || sdkError.ExecResult.Stderr != "no" {
		t.Fatal("command error lost exit details")
	}
	check := false
	result, err := s.Exec(context.Background(), []string{"false"}, verify.ExecOptions{Check: &check})
	if err != nil || result.ExitCode != 7 || result.Stderr != "no" {
		t.Fatalf("unchecked exit = %#v, %v", result, err)
	}
}

func TestComputerAsyncNoReplay(t *testing.T) {
	var submitted map[string]any
	polls := 0
	f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if strings.HasSuffix(r.URL.Path, "/operations") {
			submitted = body
			writeJSON(w, 202, nil)
			return true
		}
		if strings.Contains(r.URL.Path, "/operations/") {
			polls++
			expected := operationID(submitted["computer_session_id"].(string), submitted["request_id"].(string))
			if !strings.HasSuffix(r.URL.Path, "/"+expected) {
				t.Error("poll did not use deterministic UUIDv5 operation ID")
			}
			if polls == 1 {
				writeJSON(w, 202, nil)
			} else {
				writeComputerOperation(f, w, submitted, f.fixture("exec"))
			}
			return true
		}
		return false
	})
	s := f.open(verify.Target{Platform: verify.Mac})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := s.Exec(ctx, []string{"true"}); err != nil {
		t.Fatal(err)
	}
	if polls != 2 || len(f.calls("POST", computerPath+"/"+s.ID()+"/operations")) != 1 {
		t.Fatal("pending operation replayed or did not poll twice")
	}
}

func TestComputerFilesProcessesAndScreenshot(t *testing.T) {
	f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if !strings.HasSuffix(r.URL.Path, "/operations") {
			return false
		}
		command := body["command"].(map[string]any)
		kind := command["kind"].(string)
		result := map[string]any{"kind": kind}
		switch kind {
		case "file_read":
			result["data"] = "_-8="
		case "file_write":
			result["byte_count"] = 3
		case "file_stat":
			result["file_kind"], result["size_bytes"] = "file", 3
		case "process_list":
			result["processes"] = []any{
				map[string]any{"handle": map[string]any{"computer_session_id": body["computer_session_id"], "handle_id": sessionID}, "state": "running"},
				map[string]any{"handle": map[string]any{"computer_session_id": body["computer_session_id"], "handle_id": appID}, "state": "exited", "exit_code": 7},
			}
		case "process_terminate":
			result["termination"] = "confirmed"
		default:
			t.Errorf("unexpected command kind %s", kind)
		}
		writeComputerOperation(f, w, body, operationResult(result))
		return true
	})
	s := f.open(verify.Target{Platform: verify.Mac})
	ctx := context.Background()
	data, err := s.ReadFile(ctx, "dir/a")
	if err != nil || !bytes.Equal(data, []byte{255, 239}) {
		t.Fatalf("read bytes = %v, %v", data, err)
	}
	if err := s.WriteFile(ctx, "dir/a", []byte{0, 255, 1}); err != nil {
		t.Fatal(err)
	}
	stat, err := s.Stat(ctx, "dir/a")
	if err != nil || stat.Kind != "file" || stat.Size != 3 {
		t.Fatalf("stat = %#v, %v", stat, err)
	}
	processes, err := s.Processes(ctx)
	if err != nil || len(processes) != 2 || processes[0].ID != sessionID || processes[0].ExitCode != nil || processes[1].ExitCode == nil || *processes[1].ExitCode != 7 {
		t.Fatalf("processes = %#v, %v", processes, err)
	}
	if err := s.Terminate(ctx, sessionID); err != nil {
		t.Fatal(err)
	}
	calls := f.calls("POST", computerPath+"/"+s.ID()+"/operations")
	for i, kind := range []string{"file_read", "file_write", "file_stat", "process_list", "process_terminate"} {
		command := calls[i].Body["command"].(map[string]any)
		if command["kind"] != kind || command["timeout_ms"] != float64(30000) {
			t.Fatalf("command = %#v", command)
		}
	}
	write := calls[1].Body["command"].(map[string]any)
	if write["data"] != "AP8B" || write["path"] != "dir/a" {
		t.Fatal("write did not encode bytes or preserve relative path")
	}
	handle := calls[4].Body["command"].(map[string]any)["handle"].(map[string]any)
	if !reflectMaps(handle, map[string]any{"computer_session_id": s.ID(), "handle_id": sessionID}) {
		t.Fatal("terminate handle is not session-scoped")
	}
	path := filepath.Join(t.TempDir(), "nested", "screen.png")
	shot, err := s.Screenshot(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(shot, testPNG()) || !bytes.Equal(shot, onDisk) {
		t.Fatal("computer screenshot did not preserve PNG")
	}
}

func TestComputerHTTPErrorMapping(t *testing.T) {
	for _, tc := range []struct {
		status int
		detail string
		code   verify.Code
	}{
		{403, "computer_not_enabled", verify.ErrNotAvailableOnPlatform}, {401, "unauthenticated", verify.ErrAuthRejected}, {403, "forbidden", verify.ErrAuthRejected},
		{409, "run_closed", verify.ErrSessionEnded}, {404, "inaccessible", verify.ErrNotFound}, {404, "invalid_handle", verify.ErrNotFound},
		{404, "operation_not_found", verify.ErrActionUncertain}, {409, "owner_unavailable", verify.ErrActionUncertain}, {409, "request_conflict", verify.ErrSessionBusy},
		{429, "operation_limit", verify.ErrSessionBusy}, {422, "invalid_request", verify.ErrInvalidArgument}, {503, "evidence_unavailable", verify.ErrActionUncertain},
		{503, "runtime_unavailable", verify.ErrNotAvailableOnPlatform}, {503, "start_failed", verify.ErrSessionStartFailed}, {429, "computer_limit", verify.ErrComputerLimit},
	} {
		t.Run(tc.detail, func(t *testing.T) {
			f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				writeJSON(w, tc.status, map[string]any{"detail": tc.detail})
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			_, err := s.Exec(context.Background(), []string{"true"})
			requireCode(t, err, tc.code)
			if len(f.calls("POST", computerPath+"/"+s.ID()+"/operations")) != 1 {
				t.Fatal("failed operation was replayed")
			}
		})
	}
}

func TestComputerExecutionMapping(t *testing.T) {
	for _, tc := range []struct {
		name      string
		execution map[string]any
		code      verify.Code
	}{
		{"missing", map[string]any{"outcome": "failed", "error_code": "not_found"}, verify.ErrNotFound},
		{"denied", map[string]any{"outcome": "failed", "error_code": "access_denied"}, verify.ErrAccessDenied},
		{"timeout-confirmed", map[string]any{"outcome": "timed_out", "error_code": "timed_out", "termination": "confirmed"}, verify.ErrTimeout},
		{"timeout-unknown", map[string]any{"outcome": "timed_out", "error_code": "timed_out", "termination": "unknown"}, verify.ErrActionUncertain},
		{"unknown", map[string]any{"outcome": "unknown", "error_code": "lost_ack", "termination": "unknown"}, verify.ErrActionUncertain},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				writeComputerOperation(f, w, body, tc.execution)
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			_, err := s.Exec(context.Background(), []string{"true"})
			requireCode(t, err, tc.code)
		})
	}
}

func TestComputerInvalidInputs(t *testing.T) {
	f := newComputerFake(t, nil)
	s := f.open(verify.Target{Platform: verify.Mac})
	ctx := context.Background()
	for _, path := range []string{"", "/etc/passwd", "../a", "a//b", "a/./b", "a\\b", "a\nb", "a:b", strings.Repeat("x", 1025)} {
		_, err := s.ReadFile(ctx, path)
		requireCode(t, err, verify.ErrInvalidArgument)
		_, err = s.Stat(ctx, path)
		requireCode(t, err, verify.ErrInvalidArgument)
		requireCode(t, s.WriteFile(ctx, path, nil), verify.ErrInvalidArgument)
	}
	for _, argv := range [][]string{nil, {}, {""}, {"a\x00"}, make([]string, 65), {strings.Repeat("x", 16385)}} {
		_, err := s.Exec(ctx, argv)
		requireCode(t, err, verify.ErrInvalidArgument)
	}
	_, err := s.Exec(ctx, []string{"a"}, verify.ExecOptions{Stdin: make([]byte, 16384)})
	requireCode(t, err, verify.ErrInvalidArgument)
	for _, timeout := range []time.Duration{-time.Second, time.Nanosecond, 300*time.Second + time.Millisecond} {
		_, err := s.Exec(ctx, []string{"true"}, verify.ExecOptions{Timeout: timeout})
		requireCode(t, err, verify.ErrInvalidArgument)
	}
	requireCode(t, s.WriteFile(ctx, "a", make([]byte, 65537)), verify.ErrInvalidArgument)
	requireCode(t, s.Terminate(ctx, "123"), verify.ErrInvalidArgument)
	if len(f.calls("POST", computerPath+"/"+s.ID()+"/operations")) != 0 {
		t.Fatal("invalid input reached operations endpoint")
	}
}

func TestComputerBinaryAndMalformedResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		kind   string
		result map[string]any
		want   verify.Code
	}{
		{"maximum-file", "read", map[string]any{"kind": "file_read", "data": base64.URLEncoding.EncodeToString(bytes.Repeat([]byte{255}, 1048576))}, ""},
		{"oversized-file", "read", map[string]any{"kind": "file_read", "data": base64.StdEncoding.EncodeToString(make([]byte, 1048577))}, verify.ErrAPI},
		{"invalid-base64", "read", map[string]any{"kind": "file_read", "data": "%%%="}, verify.ErrAPI},
		{"noncanonical-base64", "read", map[string]any{"kind": "file_read", "data": "AB=="}, verify.ErrAPI},
		{"unbounded-output", "exec", map[string]any{"kind": "exec", "exit_code": 0, "stdout": base64.StdEncoding.EncodeToString(make([]byte, 524289)), "stderr": base64.StdEncoding.EncodeToString(make([]byte, 524288))}, verify.ErrAPI},
		{"wrong-kind", "exec", map[string]any{"kind": "file_write", "byte_count": 3}, verify.ErrAPI},
		{"wrong-byte-count", "write", map[string]any{"kind": "file_write", "byte_count": 2}, verify.ErrAPI},
		{"negative-size", "stat", map[string]any{"kind": "file_stat", "file_kind": "file", "size_bytes": -1}, verify.ErrAPI},
		{"fractional-size", "stat", map[string]any{"kind": "file_stat", "file_kind": "file", "size_bytes": 0.5}, verify.ErrAPI},
		{"unconfirmed-terminate", "terminate", map[string]any{"kind": "process_terminate", "termination": "unknown"}, verify.ErrAPI},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				writeComputerOperation(f, w, body, operationResult(tc.result))
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			var err error
			switch tc.kind {
			case "read":
				var data []byte
				data, err = s.ReadFile(context.Background(), "a")
				if tc.want == "" && !bytes.Equal(data, bytes.Repeat([]byte{255}, 1048576)) {
					t.Fatal("maximum file truncated")
				}
			case "exec":
				_, err = s.Exec(context.Background(), []string{"true"})
			case "write":
				err = s.WriteFile(context.Background(), "a", []byte("hey"))
			case "stat":
				_, err = s.Stat(context.Background(), "a")
			case "terminate":
				err = s.Terminate(context.Background(), sessionID)
			}
			if tc.want != "" {
				requireCode(t, err, tc.want)
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestComputerPendingAndIdentityValidation(t *testing.T) {
	for _, mode := range []string{"pending-object", "wrong-session", "wrong-operation", "invalid-evidence", "invalid-json"} {
		t.Run(mode, func(t *testing.T) {
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				if mode == "pending-object" {
					writeJSON(w, 202, map[string]any{"status": "pending"})
					return true
				}
				if mode == "invalid-json" {
					_, _ = w.Write([]byte("not-json"))
					return true
				}
				result := f.fixture("operation")
				result["computer_session_id"] = body["computer_session_id"]
				result["operation_id"] = operationID(body["computer_session_id"].(string), body["request_id"].(string))
				switch mode {
				case "wrong-session":
					result["computer_session_id"] = sessionID
				case "wrong-operation":
					result["operation_id"] = appID
				case "invalid-evidence":
					result["evidence"] = "invented"
				}
				writeJSON(w, 200, result)
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			_, err := s.Exec(context.Background(), []string{"true"})
			requireCode(t, err, verify.ErrAPI)
		})
	}
}

func TestComputerAdmissionAndStartup(t *testing.T) {
	for _, mode := range []string{"starting", "failed", "cancelled", "refused-detail", "refused-error", "runtime-unavailable", "auth", "invalid-argument"} {
		t.Run(mode, func(t *testing.T) {
			var id string
			f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if r.URL.Path == computerPath {
					id = body["computer_session_id"].(string)
					switch mode {
					case "refused-detail":
						writeJSON(w, 403, map[string]any{"detail": "computer_not_enabled"})
					case "refused-error":
						writeJSON(w, 503, map[string]any{"error": "computer_not_enabled"})
					case "runtime-unavailable":
						writeJSON(w, 503, map[string]any{"detail": "runtime_unavailable"})
					case "auth":
						writeJSON(w, 401, map[string]any{"detail": "unauthenticated"})
					case "invalid-argument":
						writeJSON(w, 422, map[string]any{"detail": "invalid_request"})
					default:
						state := "starting"
						if mode == "failed" {
							state = "failed"
						}
						writeJSON(w, 200, map[string]any{"computer_session_id": id, "state": state, "failure_reason": "private runtime payload"})
					}
					return true
				}
				return false
			})
			timeout := 5 * time.Second
			if mode == "cancelled" {
				timeout = 100 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			s, err := verify.Open(ctx, verify.Target{Platform: verify.Mac}, verify.OpenOptions{BackendURL: f.server.URL})
			if mode == "starting" {
				if err != nil {
					t.Fatal(err)
				}
				if err := s.Close(context.Background()); err != nil {
					t.Fatal(err)
				}
				if len(f.calls("GET", computerPath+"/"+id+"/report")) != 1 {
					t.Fatal("startup did not poll report")
				}
				return
			}
			want := verify.ErrNotAvailableOnPlatform
			switch mode {
			case "failed":
				want = verify.ErrSessionStartFailed
			case "cancelled":
				want = verify.ErrTimeout
			case "auth":
				want = verify.ErrAuthRejected
			case "invalid-argument":
				want = verify.ErrInvalidArgument
			}
			requireCode(t, err, want)
			if strings.Contains(err.Error(), "private runtime payload") {
				t.Fatal("startup leaked server payload")
			}
			stops := len(f.calls("POST", computerPath+"/"+id+"/stop"))
			wantStops := 0
			if mode == "failed" || mode == "cancelled" {
				wantStops = 1
			}
			if stops != wantStops {
				t.Fatalf("stop count %d, want %d", stops, wantStops)
			}
		})
	}
}

func TestComputerCloseReleaseAndInflightCancellation(t *testing.T) {
	for _, tc := range []struct {
		state, release string
		code           verify.Code
	}{{"stopped", "unknown", verify.ErrActionUncertain}, {"starting", "pending", verify.ErrActionUncertain}, {"active", "confirmed", verify.ErrAPI}, {"owner_lost", "confirmed", ""}} {
		t.Run(tc.state+"-"+tc.release, func(t *testing.T) {
			f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/stop") {
					return false
				}
				id := strings.Split(strings.TrimPrefix(r.URL.Path, computerPath+"/"), "/")[0]
				writeJSON(w, 200, map[string]any{"computer_session_id": id, "state": tc.state, "release": tc.release})
				return true
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, err := verify.Open(ctx, verify.Target{Platform: verify.Mac}, verify.OpenOptions{BackendURL: f.server.URL})
			if err != nil {
				t.Fatal(err)
			}
			first := s.Close(ctx)
			repeated, cancelRepeated := context.WithCancel(context.Background())
			cancelRepeated()
			second := s.Close(repeated)
			if tc.code != "" {
				requireCode(t, first, tc.code)
				requireCode(t, second, tc.code)
			} else if first != nil || second != nil {
				t.Fatalf("close = %v, %v", first, second)
			}
			if len(f.calls("POST", computerPath+"/"+s.ID()+"/stop")) != 1 {
				t.Fatal("failed close was replayed")
			}
		})
	}
	t.Run("inflight", func(t *testing.T) {
		started := make(chan struct{})
		aborted := make(chan struct{})
		f := newComputerFake(t, func(_ *fakeRevyl, _ http.ResponseWriter, r *http.Request, _ map[string]any) bool {
			if !strings.HasSuffix(r.URL.Path, "/operations") {
				return false
			}
			close(started)
			<-r.Context().Done()
			close(aborted)
			return true
		})
		s := f.open(verify.Target{Platform: verify.Mac})
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() { _, err := s.Exec(ctx, []string{"sleep", "10"}); done <- err }()
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("operation did not start")
		}
		if err := s.Close(ctx); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			requireCode(t, err, verify.ErrActionUncertain)
		case <-ctx.Done():
			t.Fatal("close did not cancel inflight operation")
		}
		select {
		case <-aborted:
		case <-ctx.Done():
			t.Fatal("inflight HTTP request remained open")
		}
	})
}

func TestComputerTransportFailureAndContextUncertainty(t *testing.T) {
	for _, mode := range []string{"transport", "context"} {
		t.Run(mode, func(t *testing.T) {
			f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				if mode == "context" {
					<-r.Context().Done()
					return true
				}
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return true
				}
				_ = conn.Close()
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err := s.Exec(ctx, []string{"true"})
			requireCode(t, err, verify.ErrActionUncertain)
			if len(f.calls("POST", computerPath+"/"+s.ID()+"/operations")) != 1 {
				t.Fatal("uncertain mutation replayed")
			}
		})
	}
}

func TestMobileComputerMethodsUnavailable(t *testing.T) {
	f := newFake(t)
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	ctx := context.Background()
	_, err := s.Exec(ctx, []string{"true"})
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	_, err = s.ReadFile(ctx, "a")
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	requireCode(t, s.WriteFile(ctx, "a", nil), verify.ErrNotAvailableOnPlatform)
	_, err = s.Stat(ctx, "a")
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	_, err = s.Processes(ctx)
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	requireCode(t, s.Terminate(ctx, sessionID), verify.ErrNotAvailableOnPlatform)
}

func TestComputerEvidenceLogs(t *testing.T) {
	for _, evidence := range []string{"pending", "failed"} {
		t.Run(evidence, func(t *testing.T) {
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				result := f.fixture("operation")
				result["computer_session_id"] = body["computer_session_id"]
				result["operation_id"] = operationID(body["computer_session_id"].(string), body["request_id"].(string))
				result["evidence"] = evidence
				writeJSON(w, 200, result)
				return true
			})
			var mu sync.Mutex
			var lines []string
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			s, err := verify.Open(ctx, verify.Target{Platform: verify.Mac}, verify.OpenOptions{BackendURL: f.server.URL, Log: func(line string) { mu.Lock(); defer mu.Unlock(); lines = append(lines, line) }})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Exec(ctx, []string{"true"}); err != nil {
				t.Fatal(err)
			}
			if err := s.Close(ctx); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			logs := strings.Join(lines, "\n")
			if !strings.Contains(logs, "report evidence "+evidence) || !strings.Contains(logs, "not yet available in Revyl production") {
				t.Fatalf("missing evidence or availability log: %s", logs)
			}
		})
	}
}

func TestComputerProcessResponseValidation(t *testing.T) {
	for _, mode := range []string{"cross-session", "duplicate", "invalid-id", "invalid-state", "running-with-exit", "invalid-exit", "missing-list", "oversized-list"} {
		t.Run(mode, func(t *testing.T) {
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				handle := map[string]any{"computer_session_id": body["computer_session_id"], "handle_id": sessionID}
				process := map[string]any{"handle": handle, "state": "running"}
				processes := []any{process}
				switch mode {
				case "cross-session":
					handle["computer_session_id"] = appID
				case "duplicate":
					processes = append(processes, process)
				case "invalid-id":
					handle["handle_id"] = "123"
				case "invalid-state":
					process["state"] = "unknown"
				case "running-with-exit":
					process["exit_code"] = 0
				case "invalid-exit":
					process["state"] = "exited"
					process["exit_code"] = 256
				case "oversized-list":
					processes = make([]any, 65)
				}
				result := map[string]any{"kind": "process_list", "processes": processes}
				if mode == "missing-list" {
					delete(result, "processes")
				}
				writeComputerOperation(f, w, body, operationResult(result))
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			_, err := s.Processes(context.Background())
			requireCode(t, err, verify.ErrAPI)
		})
	}
}

func TestComputerScreenshotValidation(t *testing.T) {
	for _, mode := range []string{"null", "mismatched-dimensions", "oversized-dimensions", "invalid-base64", "invalid-png"} {
		t.Run(mode, func(t *testing.T) {
			f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/screen/screenshot") {
					return false
				}
				if mode == "null" {
					writeJSON(w, 200, nil)
					return true
				}
				result := map[string]any{"width": 1280, "height": 800, "png": base64.StdEncoding.EncodeToString(testPNG())}
				switch mode {
				case "mismatched-dimensions":
					result["width"] = 1200
				case "oversized-dimensions":
					result["width"] = 4096
				case "invalid-base64":
					result["png"] = "bad"
				case "invalid-png":
					result["png"] = "bm90LXBuZw=="
				}
				writeJSON(w, 200, result)
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			_, err := s.Screenshot(context.Background())
			requireCode(t, err, verify.ErrAPI)
		})
	}
}

func TestComputerTargetsRejectDeviceFields(t *testing.T) {
	for name, target := range map[string]verify.Target{
		"app": {AppID: appID}, "bundle": {BundleID: "com.example.app"}, "url": {URL: "https://example.test"}, "build": {BuildID: buildID}, "artifact": {ArtifactURL: "https://example.test/app.zip"},
		"branch": {Branch: "main"}, "model": {DeviceModel: "test-model"}, "os": {OSVersion: "test-os"}, "idle": {IdleTimeoutSeconds: 600}, "viewport": {Viewport: &verify.Viewport{Width: 1280, Height: 800}}, "sign-in": {SignIn: &verify.SignIn{Path: "/", Secret: "test"}},
	} {
		t.Run(name, func(t *testing.T) {
			f := newComputerFake(t, nil)
			target.Platform = verify.Mac
			_, err := verify.Open(context.Background(), target, verify.OpenOptions{BackendURL: f.server.URL})
			requireCode(t, err, verify.ErrInvalidArgument)
			if len(f.calls("POST", computerPath)) != 0 {
				t.Fatal("invalid computer target reached server")
			}
		})
	}
}

func TestComputerPollingRetriesWithoutResubmission(t *testing.T) {
	var submitted map[string]any
	polls := 0
	f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if strings.HasSuffix(r.URL.Path, "/operations") {
			submitted = body
			writeJSON(w, 202, nil)
			return true
		}
		if strings.Contains(r.URL.Path, "/operations/") {
			polls++
			if polls < 3 {
				writeJSON(w, 503, map[string]any{"detail": "evidence_unavailable"})
			} else {
				writeComputerOperation(f, w, submitted, f.fixture("exec"))
			}
			return true
		}
		return false
	})
	s := f.open(verify.Target{Platform: verify.Mac})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := s.Exec(ctx, []string{"true"}); err != nil {
		t.Fatal(err)
	}
	if polls != 3 || len(f.calls("POST", computerPath+"/"+s.ID()+"/operations")) != 1 {
		t.Fatal("poll retry resubmitted mutation or did not retry twice")
	}
}

func TestComputerExecInvalidUTF8(t *testing.T) {
	for _, tc := range []struct {
		bytes []byte
		want  string
	}{
		{[]byte{255, 255}, "��"}, {[]byte{226, 130}, "�"}, {[]byte{226, 130, 65}, "�A"},
		{[]byte{240, 159, 146}, "�"}, {[]byte{237, 160, 128}, "���"}, {[]byte{192, 128}, "��"},
		{[]byte{225, 128, 65}, "�A"}, {[]byte{240, 144, 128}, "�"}, {[]byte{224, 128, 128}, "���"}, {[]byte{244, 144, 128, 128}, "����"},
	} {
		t.Run(fmt.Sprintf("%x", tc.bytes), func(t *testing.T) {
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if !strings.HasSuffix(r.URL.Path, "/operations") {
					return false
				}
				writeComputerOperation(f, w, body, operationResult(map[string]any{"kind": "exec", "exit_code": 0, "stdout": base64.StdEncoding.EncodeToString(tc.bytes), "stderr": ""}))
				return true
			})
			s := f.open(verify.Target{Platform: verify.Mac})
			result, err := s.Exec(context.Background(), []string{"true"})
			if err != nil {
				t.Fatal(err)
			}
			if result.Stdout != tc.want {
				t.Fatalf("UTF-8 decoding = %q, want %q like TypeScript", result.Stdout, tc.want)
			}
		})
	}
}

func TestComputerScreenshotExceedsOrdinaryResponseLimit(t *testing.T) {
	image := make([]byte, 13*1024*1024)
	copy(image, testPNG())
	f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if !strings.HasSuffix(r.URL.Path, "/screen/screenshot") {
			return false
		}
		writeJSON(w, 200, map[string]any{"width": 1280, "height": 800, "png": base64.StdEncoding.EncodeToString(image)})
		return true
	})
	s := f.open(verify.Target{Platform: verify.Mac})
	result, err := s.Screenshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(result, image) {
		t.Fatal("computer screenshot truncated at ordinary response size limit")
	}
}

func TestLinuxComputerOperations(t *testing.T) {
	f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if !strings.HasSuffix(r.URL.Path, "/operations") {
			return false
		}
		command := body["command"].(map[string]any)
		var result map[string]any
		switch command["kind"] {
		case "exec":
			return false
		case "file_write":
			result = map[string]any{"kind": "file_write", "byte_count": 3}
		case "file_read":
			result = map[string]any{"kind": "file_read", "data": "AP8B"}
		case "file_stat":
			result = map[string]any{"kind": "file_stat", "file_kind": "file", "size_bytes": 3}
		case "process_list":
			result = map[string]any{"kind": "process_list", "processes": []any{map[string]any{"handle": map[string]any{"computer_session_id": body["computer_session_id"], "handle_id": sessionID}, "state": "running"}}}
		case "process_terminate":
			result = map[string]any{"kind": "process_terminate", "termination": "confirmed"}
		}
		writeComputerOperation(f, w, body, operationResult(result))
		return true
	})
	s := f.open(verify.Target{Platform: verify.Linux})
	start := f.calls("POST", computerPath)
	if len(start) != 1 || !reflectMaps(start[0].Body, map[string]any{"computer_session_id": s.ID(), "os": "linux"}) {
		t.Fatal("Linux did not request os:linux")
	}
	if s.ViewerURL() != "https://viewer.test/sessions/"+s.ID()+"?kind=computer" {
		t.Fatal("Linux viewer did not use computer link")
	}
	ctx := context.Background()
	result, err := s.Exec(ctx, []string{"printf", "%s", "hello"})
	if err != nil || result.Stdout != "ok\n" {
		t.Fatalf("Linux exec = %#v, %v", result, err)
	}
	if err := s.WriteFile(ctx, "hello.bin", []byte{0, 255, 1}); err != nil {
		t.Fatal(err)
	}
	data, err := s.ReadFile(ctx, "hello.bin")
	if err != nil || !bytes.Equal(data, []byte{0, 255, 1}) {
		t.Fatalf("Linux read = %v, %v", data, err)
	}
	stat, err := s.Stat(ctx, "hello.bin")
	if err != nil || stat.Kind != "file" || stat.Size != 3 {
		t.Fatalf("Linux stat = %#v, %v", stat, err)
	}
	processes, err := s.Processes(ctx)
	if err != nil || len(processes) != 1 || processes[0].ID != sessionID {
		t.Fatalf("Linux processes = %#v, %v", processes, err)
	}
	if err := s.Terminate(ctx, sessionID); err != nil {
		t.Fatal(err)
	}
	shot, err := s.Screenshot(ctx)
	if err != nil || !bytes.Equal(shot, testPNG()) {
		t.Fatalf("Linux screenshot error = %v", err)
	}
	_, err = s.Instruction(ctx, "Open settings")
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	_, err = s.Validation(ctx, "Settings are visible")
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.calls("POST", computerPath+"/"+s.ID()+"/stop")) != 1 {
		t.Fatal("Linux stop replayed")
	}
}

func TestComputerAdmissionForBothPlatforms(t *testing.T) {
	for _, platform := range []verify.Platform{verify.Mac, verify.Linux} {
		for _, tc := range []struct {
			name   string
			status int
			body   map[string]any
			code   verify.Code
		}{
			{"disabled", 403, map[string]any{"detail": "computer_not_enabled"}, verify.ErrNotAvailableOnPlatform},
			{"runtime", 503, map[string]any{"detail": "runtime_unavailable"}, verify.ErrNotAvailableOnPlatform},
			{"capacity", 429, map[string]any{"detail": "computer_limit"}, verify.ErrComputerLimit},
		} {
			t.Run(string(platform)+"/"+tc.name, func(t *testing.T) {
				f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
					if r.URL.Path != computerPath {
						return false
					}
					writeJSON(w, tc.status, tc.body)
					return true
				})
				_, err := verify.Open(context.Background(), verify.Target{Platform: platform}, verify.OpenOptions{BackendURL: f.server.URL})
				requireCode(t, err, tc.code)
				if len(f.calls("POST", computerPath)) != 1 {
					t.Fatal("admission refusal retried create")
				}
				f.mu.Lock()
				count := len(f.requests)
				f.mu.Unlock()
				if count != 1 {
					t.Fatal("definite admission refusal attempted cleanup or another request")
				}
				message := strings.ToLower(err.Error())
				if tc.code == verify.ErrComputerLimit && (!strings.Contains(message, "queued") || !strings.Contains(message, "concurrency")) {
					t.Fatal("computer limit message does not describe both possible causes")
				}
				if platform == verify.Linux && strings.Contains(message, "no mac") {
					t.Fatal("Linux availability error uses Mac-only wording")
				}
			})
		}
	}
}

func TestComputerNoHostStopsStartupPolling(t *testing.T) {
	for _, platform := range []verify.Platform{verify.Mac, verify.Linux} {
		t.Run(string(platform), func(t *testing.T) {
			var id string
			f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if r.URL.Path == computerPath {
					id = body["computer_session_id"].(string)
					writeJSON(w, 200, map[string]any{"computer_session_id": id, "state": "starting"})
					return true
				}
				if strings.HasSuffix(r.URL.Path, "/report") {
					result := f.fixture("noHost")
					result["computer_session_id"] = id
					writeJSON(w, 200, result)
					return true
				}
				return false
			})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err := verify.Open(ctx, verify.Target{Platform: platform}, verify.OpenOptions{BackendURL: f.server.URL})
			requireCode(t, err, verify.ErrSessionStartFailed)
			if len(f.calls("GET", computerPath+"/"+id+"/report")) != 1 {
				t.Fatal("no_host continued polling")
			}
			if len(f.calls("POST", computerPath+"/"+id+"/stop")) != 1 {
				t.Fatal("no_host did not attempt exactly one cleanup")
			}
			message := strings.ToLower(err.Error())
			if !strings.Contains(message, "120") || !strings.Contains(message, "host") {
				t.Fatal("no_host does not explain 120-second unclaimed-start deadline")
			}
		})
	}
}

func TestComputerRecordings(t *testing.T) {
	for _, platform := range []verify.Platform{verify.Mac, verify.Linux} {
		for _, mode := range []string{"available", "null-metadata", "unavailable", "active", "terminal-unreleased", "active-released", "wrong-report-id", "malformed-duration", "malformed-time", "malformed-url", "other-404"} {
			t.Run(string(platform)+"/"+mode, func(t *testing.T) {
				var id string
				f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
					if r.URL.Path == computerPath {
						id = body["computer_session_id"].(string)
						return false
					}
					if strings.HasSuffix(r.URL.Path, "/report") {
						report := f.fixture("stopped")
						report["computer_session_id"] = id
						switch mode {
						case "active":
							report["state"] = "active"
							report["release"] = "pending"
						case "terminal-unreleased":
							report["release"] = "unknown"
						case "active-released":
							report["state"] = "active"
						case "wrong-report-id":
							report["computer_session_id"] = appID
						}
						writeJSON(w, 200, report)
						return true
					}
					if strings.HasSuffix(r.URL.Path, "/recording") {
						if mode == "unavailable" {
							writeJSON(w, 404, f.fixture("recordingUnavailable"))
							return true
						}
						if mode == "other-404" {
							writeJSON(w, 404, map[string]any{"error": "inaccessible"})
							return true
						}
						recording := f.fixture("recording")
						switch mode {
						case "null-metadata":
							recording["duration_seconds"] = nil
							recording["started_at"] = nil
						case "malformed-duration":
							recording["duration_seconds"] = -1
						case "malformed-time":
							recording["started_at"] = "not-a-time"
						case "malformed-url":
							recording["url"] = "not-a-url"
						}
						writeJSON(w, 200, recording)
						return true
					}
					return false
				})
				var mu sync.Mutex
				var lines []string
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				s, err := verify.Open(ctx, verify.Target{Platform: platform}, verify.OpenOptions{BackendURL: f.server.URL, Log: func(line string) { mu.Lock(); defer mu.Unlock(); lines = append(lines, line) }})
				if err != nil {
					t.Fatal(err)
				}
				if err := s.Close(ctx); err != nil {
					t.Fatal(err)
				}
				recording, err := s.Recording(ctx)
				switch mode {
				case "active", "terminal-unreleased", "active-released":
					requireCode(t, err, verify.ErrSessionBusy)
					if len(f.calls("GET", computerPath+"/"+id+"/recording")) != 0 {
						t.Fatal("recording fetched before terminal confirmed release")
					}
				case "wrong-report-id", "malformed-duration", "malformed-time", "malformed-url":
					requireCode(t, err, verify.ErrAPI)
				case "other-404":
					if err == nil {
						t.Fatal("unrelated recording 404 silently treated as unavailable")
					}
				case "unavailable":
					if err != nil || recording != nil {
						t.Fatal("recording_unavailable should return nil,nil")
					}
				case "null-metadata":
					if err != nil || recording == nil || recording.Duration != nil || recording.StartedAt != nil {
						t.Fatal("nullable recording metadata was not preserved")
					}
				default:
					if err != nil {
						t.Fatal(err)
					}
					fixture := f.fixture("recording")
					started, _ := time.Parse(time.RFC3339, fixture["started_at"].(string))
					if recording == nil || recording.URL != fixture["url"] || recording.Duration == nil || *recording.Duration != 12500*time.Millisecond || recording.StartedAt == nil || !recording.StartedAt.Equal(started) {
						t.Fatal("incorrect recording metadata")
					}
				}
				mu.Lock()
				defer mu.Unlock()
				logs := strings.Join(lines, "\n")
				if strings.Contains(logs, "signature=") || strings.Contains(logs, "media.example.test") {
					t.Fatal("signed recording URL leaked to log callback")
				}
				if len(f.calls("GET", computerPath+"/"+id+"/report")) != 1 {
					t.Fatal("recording did not check latest report")
				}
			})
		}
	}
}

func TestDeviceRecordingUnavailable(t *testing.T) {
	f := newFake(t)
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	_, err := s.Recording(context.Background())
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
}

func TestComputerExpiry(t *testing.T) {
	for _, platform := range []verify.Platform{verify.Mac, verify.Linux} {
		for _, mode := range []string{"future", "expired", "invalid", "missing"} {
			t.Run(string(platform)+"/"+mode, func(t *testing.T) {
				var id string
				f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
					if r.URL.Path == computerPath {
						id = body["computer_session_id"].(string)
						report := f.fixture("activeWithExpiry")
						report["computer_session_id"] = id
						if mode == "expired" {
							report["expires_at"] = "2020-01-01T00:00:00Z"
						}
						if mode == "invalid" {
							report["expires_at"] = "not-a-time"
						}
						if mode == "missing" {
							delete(report, "expires_at")
						}
						writeJSON(w, 200, report)
						return true
					}
					if strings.HasSuffix(r.URL.Path, "/report") {
						report := f.fixture("stopped")
						report["computer_session_id"] = id
						writeJSON(w, 200, report)
						return true
					}
					if strings.HasSuffix(r.URL.Path, "/recording") {
						writeJSON(w, 404, f.fixture("recordingUnavailable"))
						return true
					}
					return false
				})
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				s, err := verify.Open(ctx, verify.Target{Platform: platform}, verify.OpenOptions{BackendURL: f.server.URL})
				if mode == "invalid" {
					requireCode(t, err, verify.ErrAPI)
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if s.ExpiresAt().IsZero() && mode != "missing" {
					t.Fatal("computer expiry was not exposed")
				}
				if mode == "missing" && !s.ExpiresAt().IsZero() {
					t.Fatal("missing server expiry should remain zero")
				}
				if mode == "expired" {
					_, err := s.Exec(ctx, []string{"true"})
					requireCode(t, err, verify.ErrSessionEnded)
					_, err = s.Screenshot(ctx)
					requireCode(t, err, verify.ErrSessionEnded)
					if len(f.calls("POST", computerPath+"/"+id+"/operations")) != 0 {
						t.Fatal("expired computer submitted an operation")
					}
				} else if _, err := s.Exec(ctx, []string{"true"}); err != nil {
					t.Fatal(err)
				}
				if err := s.Close(ctx); err != nil {
					t.Fatal(err)
				}
				if recording, err := s.Recording(ctx); recording != nil || err != nil {
					t.Fatal("close or recording was blocked by expired session lifetime")
				}
			})
		}
	}
	f := newFake(t)
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	if !s.ExpiresAt().IsZero() {
		t.Fatal("device exposed an invented expiry")
	}
}

func TestComputerExpiryCancelsInflightObservation(t *testing.T) {
	var expiry time.Time
	started := make(chan struct{})
	f := newComputerFake(t, func(f *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if r.URL.Path == computerPath {
			expiry = time.Now().Add(250 * time.Millisecond)
			report := f.fixture("active")
			report["computer_session_id"] = body["computer_session_id"]
			report["expires_at"] = expiry.Format(time.RFC3339Nano)
			writeJSON(w, 200, report)
			return true
		}
		if strings.HasSuffix(r.URL.Path, "/operations") {
			close(started)
			<-r.Context().Done()
			return true
		}
		return false
	})
	s := f.open(verify.Target{Platform: verify.Linux})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := s.Exec(ctx, []string{"sleep", "10"})
	requireCode(t, err, verify.ErrActionUncertain)
	if ctx.Err() != nil {
		t.Fatal("operation waited for caller deadline instead of computer expiry")
	}
	select {
	case <-started:
	default:
		t.Fatal("operation never reached server")
	}
	if !s.ExpiresAt().Equal(expiry) {
		t.Fatal("server expiry changed")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expiry cancellation lost deadline cause")
	}
}
