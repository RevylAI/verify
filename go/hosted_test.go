package verify_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	verify "github.com/RevylAI/verify/go"
)

func newHostedFake(t *testing.T, handler func(http.ResponseWriter, *http.Request, map[string]any) bool) *fakeRevyl {
	t.Helper()
	return newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if handler != nil && handler(w, r, body) {
			return true
		}
		if r.Method == "POST" && r.URL.Path == computerPath {
			writeJSON(w, 200, map[string]any{"computer_session_id": body["computer_session_id"], "state": "active", "expires_at": time.Now().Add(time.Hour)})
			return true
		}
		if r.Method == "POST" && r.URL.Path == startPath {
			id, ok := body["session_id"].(string)
			if !ok {
				id = sessionID
			}
			writeJSON(w, 200, map[string]any{"session_id": id, "workflow_run_id": "run-1"})
			return true
		}
		return false
	})
}

func attachOptions(f *fakeRevyl) verify.OpenOptions {
	return verify.OpenOptions{BackendURL: f.server.URL, AppURL: "https://viewer.test", HTTPClient: f.server.Client(), StepTimeout: time.Second}
}

func TestAttachOwnershipAndTransport(t *testing.T) {
	for _, osName := range []string{"macos", "linux"} {
		t.Run(osName, func(t *testing.T) {
			expires := time.Now().Add(time.Hour).UTC()
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path == computerPath+"/"+sessionID+"/report" {
					writeJSON(w, 200, map[string]any{"computer_session_id": sessionID, "state": "active", "os": osName, "expires_at": expires})
					return true
				}
				return false
			})
			s, err := verify.Attach(context.Background(), sessionID, attachOptions(f))
			if err != nil {
				t.Fatal(err)
			}
			if s.ID() != sessionID || !s.ExpiresAt().Equal(expires) || s.ViewerURL() != "https://viewer.test/sessions/"+sessionID+"?kind=computer" {
				t.Fatal("attach lost identity, expiry, or viewer")
			}
			t.Setenv("REVYL_API_KEY", "changed-token")
			t.Setenv("REVYL_BACKEND_URL", "https://unused.test")
			if _, err := s.Exec(context.Background(), []string{"true"}); err != nil {
				t.Fatal(err)
			}
			child, err := s.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := s.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(f.calls("POST", computerPath)) != 0 || len(f.calls("POST", computerPath+"/"+sessionID+"/stop")) != 1 || len(f.calls("POST", "/api/v1/execution/device/sessions/"+child.ID()+"/stop")) != 1 {
				t.Fatal("attach created a parent or lost cleanup ownership")
			}
			for _, path := range []string{startPath, computerPath + "/" + sessionID + "/operations"} {
				if got := f.calls("POST", path)[0].Header.Get("Authorization"); got != "Bearer test-token" {
					t.Fatalf("attach reread credentials for %s", path)
				}
			}
		})
	}
}

func TestAttachRejectsWithoutMutation(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(map[string]any) any
		code verify.Code
	}{
		{"wrong-id", func(v map[string]any) any { v["computer_session_id"] = appID; return v }, verify.ErrAPI},
		{"missing-id", func(v map[string]any) any { delete(v, "computer_session_id"); return v }, verify.ErrAPI},
		{"missing-os", func(v map[string]any) any { delete(v, "os"); return v }, verify.ErrAPI},
		{"invalid-os", func(v map[string]any) any { v["os"] = "mac"; return v }, verify.ErrAPI},
		{"missing-expiry", func(v map[string]any) any { delete(v, "expires_at"); return v }, verify.ErrAPI},
		{"invalid-expiry", func(v map[string]any) any { v["expires_at"] = "not-a-date"; return v }, verify.ErrAPI},
		{"null-expiry", func(v map[string]any) any { v["expires_at"] = nil; return v }, verify.ErrAPI},
		{"expired", func(v map[string]any) any { v["expires_at"] = time.Now().Add(-time.Second); return v }, verify.ErrSessionEnded},
		{"starting", func(v map[string]any) any { v["state"] = "starting"; return v }, verify.ErrSessionEnded},
		{"closing", func(v map[string]any) any { v["state"] = "closing"; return v }, verify.ErrSessionEnded},
		{"stopped", func(v map[string]any) any { v["state"] = "stopped"; return v }, verify.ErrSessionEnded},
		{"invalid-state", func(v map[string]any) any { v["state"] = "unknown"; return v }, verify.ErrAPI},
		{"array", func(map[string]any) any { return []any{} }, verify.ErrAPI},
		{"null", func(map[string]any) any { return nil }, verify.ErrAPI},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if strings.HasSuffix(r.URL.Path, "/report") {
					report := map[string]any{"computer_session_id": sessionID, "state": "active", "os": "macos", "expires_at": time.Now().Add(time.Hour)}
					writeJSON(w, 200, tc.edit(report))
					return true
				}
				return false
			})
			s, err := verify.Attach(context.Background(), sessionID, attachOptions(f))
			requireCode(t, err, tc.code)
			if s != nil || len(f.requests) != 1 || f.requests[0].Method != "GET" {
				t.Fatal("failed attach mutated the server")
			}
		})
	}
	f := newHostedFake(t, nil)
	for _, id := range []string{"", "not-a-uuid", " " + sessionID, sessionID + "/report"} {
		_, err := verify.Attach(context.Background(), id, attachOptions(f))
		requireCode(t, err, verify.ErrInvalidArgument)
	}
	_, err := verify.Attach(context.Background(), sessionID, attachOptions(f), attachOptions(f))
	requireCode(t, err, verify.ErrInvalidArgument)
	badTimeout := attachOptions(f)
	badTimeout.StepTimeout = time.Millisecond
	_, err = verify.Attach(context.Background(), sessionID, badTimeout)
	requireCode(t, err, verify.ErrInvalidArgument)
	if len(f.requests) != 0 {
		t.Fatal("invalid attach arguments reached the server")
	}
}

func TestHostedTargetsAndReadiness(t *testing.T) {
	for _, pair := range [][2]verify.Platform{{verify.Mac, verify.Web}, {verify.Mac, verify.IOS}, {verify.Linux, verify.Web}, {verify.Linux, verify.Android}} {
		t.Run(string(pair[0])+"/"+string(pair[1]), func(t *testing.T) {
			f := newHostedFake(t, nil)
			parent := f.open(verify.Target{Platform: pair[0]})
			target := verify.Target{Platform: pair[1], AppID: appID, BuildID: buildID, IdleTimeoutSeconds: 90}
			if target.Platform == verify.Web {
				target.Viewport = &verify.Viewport{Width: 800, Height: 600}
				target.SignIn = &verify.SignIn{Path: "/login", Secret: "test-login"}
			}
			child, err := parent.Open(context.Background(), target)
			if err != nil {
				t.Fatal(err)
			}
			if child.ID() == parent.ID() || child.ViewerURL() != "https://viewer.test/sessions/"+child.ID() {
				t.Fatal("child identity is not distinct")
			}
			calls := f.calls("POST", startPath)
			want := map[string]any{"session_id": child.ID(), "computer_session_id": parent.ID(), "platform": string(pair[1]), "app_id": appID, "build_id": buildID, "idle_timeout_seconds": float64(90)}
			if target.Platform == verify.Web {
				want["web"] = map[string]any{"viewport": map[string]any{"width": float64(800), "height": float64(600)}, "sign_in": map[string]any{"path": "/login", "secret_name": "test-login"}}
			} else {
				want["is_simulation"] = true
			}
			if len(calls) != 1 || !reflectMaps(calls[0].Body, want) {
				t.Fatalf("hosted payload = %#v, want %#v", calls, want)
			}
			if _, err := child.Instruction(context.Background(), "Open settings"); err != nil {
				t.Fatal(err)
			}
			if _, err := child.Validation(context.Background(), "Settings are visible"); err != nil {
				t.Fatal(err)
			}
			if _, err := child.Screenshot(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := child.Report(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := child.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 0 {
				t.Fatal("child cleanup stopped its parent")
			}
			if err := parent.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(f.calls("POST", "/api/v1/execution/device/sessions/"+child.ID()+"/stop")) != 1 {
				t.Fatal("parent repeated child cleanup")
			}
		})
	}
}

func TestHostedValidationBeforeStart(t *testing.T) {
	for _, platform := range []verify.Platform{verify.Web, verify.IOS, verify.Android} {
		t.Run(string(platform), func(t *testing.T) {
			f := newHostedFake(t, nil)
			host := verify.Mac
			if platform == verify.Android {
				host = verify.Linux
			}
			parent := f.open(verify.Target{Platform: host})
			for _, change := range []func(*verify.Target){
				func(v *verify.Target) { v.AppID = "" },
				func(v *verify.Target) { v.BuildID = "" },
				func(v *verify.Target) { v.AppID = "not-uuid" },
				func(v *verify.Target) { v.BuildID = "not-uuid" },
				func(v *verify.Target) { v.URL = "https://example.test" },
				func(v *verify.Target) { v.Branch = "main" },
				func(v *verify.Target) { v.ArtifactURL = "https://example.test/app.zip" },
				func(v *verify.Target) { v.BundleID = "example.app" },
				func(v *verify.Target) { v.DeviceModel = "model" },
				func(v *verify.Target) { v.OSVersion = "1" },
				func(v *verify.Target) { v.StartTimeout = time.Second },
				func(v *verify.Target) { v.IdleTimeoutSeconds = 1 },
				func(v *verify.Target) { v.Viewport = &verify.Viewport{Width: 1, Height: 1} },
				func(v *verify.Target) { v.SignIn = &verify.SignIn{Path: "bad"} },
			} {
				target := verify.Target{Platform: platform, AppID: appID, BuildID: buildID}
				change(&target)
				_, err := parent.Open(context.Background(), target)
				requireCode(t, err, verify.ErrInvalidArgument)
			}
			if len(f.calls("POST", startPath)) != 0 {
				t.Fatal("invalid hosted target started a session")
			}
		})
	}
	f := newHostedFake(t, nil)
	parent := f.open(verify.Target{Platform: verify.Mac})
	_, err := parent.Open(context.Background(), verify.Target{Platform: verify.Android, AppID: appID, BuildID: buildID})
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
	_, err = parent.Open(context.Background(), verify.Target{Platform: verify.Linux})
	requireCode(t, err, verify.ErrInvalidArgument)
	web := f.open(verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	_, err = web.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	requireCode(t, err, verify.ErrNotAvailableOnPlatform)
}

func TestHostedRefusals(t *testing.T) {
	for _, tc := range []struct {
		reason verify.RefusalReason
		status int
		code   verify.Code
	}{
		{verify.ReasonWebRuntimeUnavailable, 409, verify.ErrNotAvailableOnPlatform},
		{verify.ReasonComputerLimit, 429, verify.ErrComputerLimit},
		{verify.ReasonRuntimeUnavailable, 503, verify.ErrNotAvailableOnPlatform},
		{verify.ReasonComputerRuntimeUnavailable, 503, verify.ErrNotAvailableOnPlatform},
		{verify.ReasonComputerAtCapacity, 409, verify.ErrComputerLimit},
		{verify.ReasonComputerNotRunning, 409, verify.ErrSessionEnded},
		{verify.ReasonComputerCannotHostPlatform, 409, verify.ErrNotAvailableOnPlatform},
		{verify.ReasonComputerNotFound, 404, verify.ErrNotFound},
		{verify.ReasonWebBuildRequired, 422, verify.ErrInvalidArgument},
		{verify.ReasonWebBuildNotSupported, 422, verify.ErrInvalidArgument},
		{verify.ReasonIOSBuildRequired, 422, verify.ErrInvalidArgument},
		{verify.ReasonIOSBuildNotSupported, 422, verify.ErrInvalidArgument},
		{verify.ReasonAndroidBuildRequired, 422, verify.ErrInvalidArgument},
		{verify.ReasonAndroidBuildNotSupported, 422, verify.ErrInvalidArgument},
		{verify.ReasonWebSessionConflict, 409, verify.ErrSessionBusy},
		{verify.ReasonIOSSessionConflict, 409, verify.ErrSessionBusy},
		{verify.ReasonAndroidSessionConflict, 409, verify.ErrSessionBusy},
		{verify.ReasonNotAvailableOnPlatform, 503, verify.ErrNotAvailableOnPlatform},
	} {
		for _, shape := range []string{"detail", "nested", "error"} {
			t.Run(string(tc.reason)+"/"+shape, func(t *testing.T) {
				f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
					if r.URL.Path != startPath {
						return false
					}
					body := map[string]any{shape: string(tc.reason), "message": "private response"}
					if shape == "nested" {
						body = map[string]any{"detail": map[string]any{"error": tc.reason, "message": "private response"}}
					}
					writeJSON(w, tc.status, body)
					return true
				})
				parent := f.open(verify.Target{Platform: verify.Mac})
				_, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
				requireCode(t, err, tc.code)
				var sdkError *verify.Error
				if !errors.As(err, &sdkError) || sdkError.Reason != tc.reason || sdkError.HTTPStatus != tc.status || strings.Contains(err.Error(), "private response") {
					t.Fatalf("incorrect refusal metadata: %#v", sdkError)
				}
				if len(f.calls("POST", startPath)) != 1 || len(f.requests) != 2 {
					t.Fatal("refusal retried startup or stopped a child/parent")
				}
			})
		}
	}
}

func TestHostedAmbiguousStartCleanup(t *testing.T) {
	for _, mode := range []string{"lost-response", "request-timeout", "unknown-503", "bad-json", "wrong-id", "missing-id", "missing-run", "invalid-run", "numeric-run", "wrong-platform", "null-platform", "failed-readiness"} {
		t.Run(mode, func(t *testing.T) {
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if r.URL.Path == startPath {
					switch mode {
					case "lost-response":
						connection, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
						} else {
							_ = connection.Close()
						}
					case "unknown-503":
						writeJSON(w, 503, map[string]any{"error": "private unknown failure"})
					case "request-timeout":
						writeJSON(w, 408, map[string]any{"error": "request timed out"})
					case "bad-json":
						_, _ = w.Write([]byte("{"))
					case "wrong-id":
						writeJSON(w, 200, map[string]any{"session_id": sessionID, "workflow_run_id": "run-1"})
					case "missing-id":
						writeJSON(w, 200, map[string]any{"workflow_run_id": "run-1"})
					case "missing-run":
						writeJSON(w, 200, map[string]any{"session_id": body["session_id"]})
					case "invalid-run":
						writeJSON(w, 200, map[string]any{"session_id": body["session_id"], "workflow_run_id": "bad/run"})
					case "numeric-run":
						writeJSON(w, 200, map[string]any{"session_id": body["session_id"], "workflow_run_id": 123})
					case "wrong-platform":
						writeJSON(w, 200, map[string]any{"session_id": body["session_id"], "workflow_run_id": "run-1", "platform": "ios"})
					case "null-platform":
						writeJSON(w, 200, map[string]any{"session_id": body["session_id"], "workflow_run_id": "run-1", "platform": nil})
					default:
						return false
					}
					return true
				}
				if mode == "failed-readiness" && strings.HasPrefix(r.URL.Path, "/api/v1/execution/device-sessions/") {
					writeJSON(w, 200, map[string]any{"status": "failed"})
					return true
				}
				return false
			})
			parent := f.open(verify.Target{Platform: verify.Mac})
			child, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			if err == nil || child != nil {
				t.Fatal("failed start returned a session")
			}
			calls := f.calls("POST", startPath)
			if len(calls) != 1 {
				t.Fatal("ambiguous startup was replayed")
			}
			id := calls[0].Body["session_id"].(string)
			if len(f.calls("POST", "/api/v1/execution/device/sessions/"+id+"/stop")) != 1 || len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 0 {
				t.Fatal("ambiguous startup failed to clean only its allocated child")
			}
			if _, err := parent.Exec(context.Background(), []string{"true"}); err != nil {
				t.Fatalf("parent unusable after child failure: %v", err)
			}
		})
	}
}

func TestParentCloseWaitsForOpeningChildCleanup(t *testing.T) {
	readiness := make(chan struct{})
	cleanupStarted := make(chan struct{})
	allowCleanup := make(chan struct{})
	f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if strings.HasPrefix(r.URL.Path, "/api/v1/execution/device-sessions/") {
			close(readiness)
			<-r.Context().Done()
			return true
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/execution/device/sessions/") && strings.HasSuffix(r.URL.Path, "/stop") {
			close(cleanupStarted)
			<-allowCleanup
			writeJSON(w, 200, map[string]any{"success": true})
			return true
		}
		return false
	})
	parent := f.open(verify.Target{Platform: verify.Mac})
	opened := make(chan error, 1)
	go func() {
		_, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
		opened <- err
	}()
	<-readiness
	closed := make(chan error, 1)
	go func() { closed <- parent.Close(context.Background()) }()
	<-cleanupStarted
	_, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	requireCode(t, err, verify.ErrSessionEnded)
	if len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 0 {
		t.Fatal("parent stopped before in-flight child cleanup")
	}
	select {
	case <-closed:
		t.Fatal("parent close did not wait for child cleanup")
	default:
	}
	close(allowCleanup)
	if err := <-opened; err == nil {
		t.Fatal("opening child survived parent close")
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if len(f.calls("POST", startPath)) != 1 || len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 1 {
		t.Fatal("close replayed or allowed a new startup")
	}
}

func TestParentClosesConcurrentReturnedChildren(t *testing.T) {
	f := newHostedFake(t, nil)
	parent := f.open(verify.Target{Platform: verify.Mac})
	var wg sync.WaitGroup
	children := make(chan *verify.Session, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			child, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			if err != nil {
				t.Error(err)
				return
			}
			children <- child
		}()
	}
	wg.Wait()
	close(children)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := parent.Close(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	ids := map[string]bool{}
	for child := range children {
		if ids[child.ID()] || child.ID() == parent.ID() {
			t.Fatal("concurrent children shared an ID")
		}
		ids[child.ID()] = true
		if len(f.calls("POST", "/api/v1/execution/device/sessions/"+child.ID()+"/stop")) != 1 {
			t.Fatal("returned child was not closed exactly once")
		}
		_, err := child.Screenshot(context.Background())
		requireCode(t, err, verify.ErrSessionEnded)
	}
	if len(ids) != 4 || len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 1 {
		t.Fatal("concurrent parent cleanup was incomplete")
	}
}

func TestParentStopAfterChildCleanupFailure(t *testing.T) {
	for _, confirmed := range []bool{true, false} {
		t.Run(fmt.Sprint(confirmed), func(t *testing.T) {
			var logs []string
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if strings.HasPrefix(r.URL.Path, "/api/v1/execution/device/sessions/") && strings.HasSuffix(r.URL.Path, "/stop") {
					writeJSON(w, 400, map[string]any{"detail": "private child failure"})
					return true
				}
				if !confirmed && strings.HasPrefix(r.URL.Path, computerPath+"/") && strings.HasSuffix(r.URL.Path, "/stop") {
					id := strings.Split(strings.TrimPrefix(r.URL.Path, computerPath+"/"), "/")[0]
					writeJSON(w, 200, map[string]any{"computer_session_id": id, "state": "closing", "release": "pending"})
					return true
				}
				return false
			})
			options := attachOptions(f)
			options.Log = func(line string) { logs = append(logs, line) }
			parent, err := verify.Open(context.Background(), verify.Target{Platform: verify.Mac}, options)
			if err != nil {
				t.Fatal(err)
			}
			child, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			if err != nil {
				t.Fatal(err)
			}
			err = parent.Close(context.Background())
			if confirmed {
				if err != nil || !strings.Contains(strings.Join(logs, "\n"), "child stop failed; parent physical release is confirmed") {
					t.Fatalf("confirmed parent did not report child cleanup failure: %v", err)
				}
			} else {
				requireCode(t, err, verify.ErrActionUncertain)
			}
			if len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 1 || len(f.calls("POST", "/api/v1/execution/device/sessions/"+child.ID()+"/stop")) != 1 {
				t.Fatal("child cleanup failure prevented parent stop")
			}
			if strings.Contains(strings.Join(logs, "\n"), "private child failure") {
				t.Fatal("cleanup log leaked response content")
			}
		})
	}
}

func TestHostedStartupBoundedByParentExpiry(t *testing.T) {
	expiry := time.Now().Add(150 * time.Millisecond)
	f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if strings.HasSuffix(r.URL.Path, "/report") {
			writeJSON(w, 200, map[string]any{"computer_session_id": sessionID, "os": "macos", "state": "active", "expires_at": expiry})
			return true
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/execution/device-sessions/") {
			<-r.Context().Done()
			return true
		}
		return false
	})
	parent, err := verify.Attach(context.Background(), sessionID, attachOptions(f))
	if err != nil {
		t.Fatal(err)
	}
	defer parent.Close(context.Background())
	started := time.Now()
	_, err = parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	requireCode(t, err, verify.ErrTimeout)
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second {
		t.Fatal("startup ignored parent expiry")
	}
	_, err = parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	requireCode(t, err, verify.ErrSessionEnded)
	if len(f.calls("POST", startPath)) != 1 {
		t.Fatal("expired parent started a child")
	}
}

func TestHostedRequiresKnownParentExpiry(t *testing.T) {
	f := newComputerFake(t, nil)
	parent := f.open(verify.Target{Platform: verify.Mac})
	_, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	requireCode(t, err, verify.ErrAPI)
	if len(f.calls("POST", startPath)) != 0 {
		t.Fatal("unknown parent expiry allowed unbounded child startup")
	}
}

func TestHostedOperationsHonorParentExpiry(t *testing.T) {
	for _, action := range []string{"screenshot", "open_url", "instruction", "validation", "step_status"} {
		t.Run(action, func(t *testing.T) {
			var block atomic.Bool
			var expires time.Time
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
				if r.URL.Path == computerPath {
					expires = time.Now().Add(250 * time.Millisecond)
					writeJSON(w, 200, map[string]any{"computer_session_id": body["computer_session_id"], "state": "active", "expires_at": expires})
					return true
				}
				if !block.Load() {
					return false
				}
				if action == "step_status" && r.URL.Path == proxyPath+"execute_step" {
					writeJSON(w, 200, map[string]any{"status": "accepted", "step_id": "step-1"})
					return true
				}
				workerAction := action
				if action == "instruction" || action == "validation" {
					workerAction = "execute_step"
				}
				if r.URL.Path == proxyPath+workerAction {
					<-r.Context().Done()
					return true
				}
				if strings.HasPrefix(r.URL.Path, proxyPath+"step_cancel/") {
					writeJSON(w, 200, map[string]any{"success": true})
					return true
				}
				return false
			})
			parent := f.open(verify.Target{Platform: verify.Mac})
			child, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			if err != nil {
				t.Fatal(err)
			}
			block.Store(true)
			started := time.Now()
			switch action {
			case "screenshot":
				_, err = child.Screenshot(context.Background())
			case "open_url":
				err = child.Navigate(context.Background(), "http://localhost:3000")
			case "instruction", "step_status":
				_, err = child.Instruction(context.Background(), "Open settings")
			case "validation":
				_, err = child.Validation(context.Background(), "Settings are visible")
			}
			requireCode(t, err, verify.ErrSessionEnded)
			if time.Now().Before(expires) || time.Since(started) > time.Second {
				t.Fatal("child operation ignored parent expiry")
			}
			before := len(f.calls("POST", proxyPath+"open_url"))
			requireCode(t, child.Navigate(context.Background(), "http://localhost:3000"), verify.ErrSessionEnded)
			if len(f.calls("POST", proxyPath+"open_url")) != before {
				t.Fatal("expired child navigation reached worker")
			}
			if err := child.Close(context.Background()); err != nil {
				t.Fatalf("child cleanup blocked by expiry: %v", err)
			}
			if err := parent.Close(context.Background()); err != nil {
				t.Fatalf("parent cleanup blocked by expiry: %v", err)
			}
		})
	}
}

func TestParentCloseCancelsReturnedChildWorker(t *testing.T) {
	for _, action := range []string{"screenshot", "open_url", "execute_step"} {
		t.Run(action, func(t *testing.T) {
			var block atomic.Bool
			started := make(chan struct{})
			cancelled := make(chan struct{})
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if block.Load() && r.URL.Path == proxyPath+action {
					close(started)
					<-r.Context().Done()
					close(cancelled)
					return true
				}
				return false
			})
			parent := f.open(verify.Target{Platform: verify.Mac})
			child, err := parent.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			if err != nil {
				t.Fatal(err)
			}
			block.Store(true)
			result := make(chan error, 1)
			go func() {
				var err error
				switch action {
				case "screenshot":
					_, err = child.Screenshot(context.Background())
				case "open_url":
					err = child.Navigate(context.Background(), "http://localhost:3000")
				case "execute_step":
					_, err = child.Instruction(context.Background(), "Open settings")
				}
				result <- err
			}()
			<-started
			if err := parent.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				requireCode(t, err, verify.ErrSessionEnded)
			case <-time.After(time.Second):
				t.Fatal("parent close did not cancel child worker")
			}
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatal("worker request context was not cancelled")
			}
			if len(f.calls("POST", "/api/v1/execution/device/sessions/"+child.ID()+"/stop")) != 1 || len(f.calls("POST", computerPath+"/"+parent.ID()+"/stop")) != 1 {
				t.Fatal("parent cancellation prevented cleanup")
			}
		})
	}
}

func TestNavigateValidationAndEnvelope(t *testing.T) {
	f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if r.URL.Path == proxyPath+"open_url" {
			writeJSON(w, 200, map[string]any{"success": true, "action": "navigate", "status_code": 200})
			return true
		}
		return false
	})
	s := f.open(verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	for _, rawURL := range []string{"http://localhost:3000/path?query=value#section", "http://127.0.0.1", "http://[::1]:3000/", "https://example.test/page"} {
		if err := s.Navigate(context.Background(), rawURL); err != nil {
			t.Fatalf("valid navigation: %v", err)
		}
		calls := f.calls("POST", proxyPath+"open_url")
		if !reflectMaps(calls[len(calls)-1].Body, map[string]any{"url": rawURL}) {
			t.Fatal("navigation payload changed URL")
		}
	}
	for _, rawURL := range []string{"", "/relative", "//example.test", "javascript:alert(1)", "file:///tmp/file", "https://user:secret@example.test", "https://example.test/\\x", "https://example.test/\n", "https://example.test/\x00", "https://", "http://localhost:65536", "http://localhost:bad", "https://example.test/a b", "https://example.test/\u00a0", "https://example.test/" + strings.Repeat("a", 2048)} {
		err := s.Navigate(context.Background(), rawURL)
		requireCode(t, err, verify.ErrInvalidArgument)
		if rawURL != "" && strings.Contains(err.Error(), rawURL) {
			t.Fatal("invalid navigation leaked URL")
		}
	}
	if len(f.calls("POST", proxyPath+"open_url")) != 4 {
		t.Fatal("invalid URL reached worker")
	}
	parent := f.open(verify.Target{Platform: verify.Mac})
	requireCode(t, parent.Navigate(context.Background(), "http://localhost"), verify.ErrNotAvailableOnPlatform)
}

func TestNavigateDoesNotRetryAndValidatesSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   any
		code   verify.Code
	}{
		{"absent-action", 200, map[string]any{"success": true}, ""},
		{"failed", 200, map[string]any{"success": false, "action": "navigate"}, verify.ErrActionFailed},
		{"missing-success", 200, map[string]any{"action": "navigate"}, verify.ErrAPI},
		{"null-success", 200, map[string]any{"success": nil}, verify.ErrAPI},
		{"wrong-action", 200, map[string]any{"success": true, "action": "launch"}, verify.ErrAPI},
		{"null-action", 200, map[string]any{"success": true, "action": nil}, verify.ErrAPI},
		{"empty-action", 200, map[string]any{"success": true, "action": ""}, verify.ErrAPI},
		{"fractional-status", 200, map[string]any{"success": true, "status_code": 200.5}, verify.ErrAPI},
		{"string-status", 200, map[string]any{"success": true, "status_code": "200"}, verify.ErrAPI},
		{"null-status", 200, map[string]any{"success": true, "status_code": nil}, verify.ErrAPI},
		{"low-status", 200, map[string]any{"success": true, "status_code": 99}, verify.ErrAPI},
		{"high-status", 200, map[string]any{"success": true, "status_code": 600}, verify.ErrAPI},
		{"array", 200, []any{}, verify.ErrAPI},
		{"null", 200, nil, verify.ErrAPI},
		{"unavailable", 503, map[string]any{"error": "private reason"}, verify.ErrActionFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path == proxyPath+"open_url" {
					writeJSON(w, tc.status, tc.body)
					return true
				}
				return false
			})
			s := f.open(verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
			err := s.Navigate(context.Background(), "http://localhost:3000/private")
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, tc.code)
				if strings.Contains(err.Error(), "/private") || strings.Contains(err.Error(), "private reason") {
					t.Fatal("navigation error leaked private content")
				}
			}
			if len(f.calls("POST", proxyPath+"open_url")) != 1 {
				t.Fatal("navigation was retried")
			}
		})
	}
}

func TestReportsValidateObjectsAndRemainReadableAfterClose(t *testing.T) {
	for _, platform := range []verify.Platform{verify.Web, verify.IOS, verify.Android, verify.Mac, verify.Linux} {
		t.Run(string(platform), func(t *testing.T) {
			f := newHostedFake(t, nil)
			target := verify.Target{Platform: platform}
			if platform == verify.Web || platform == verify.IOS || platform == verify.Android {
				target.AppID = appID
			}
			s := f.open(target)
			if err := s.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			report, err := s.Report(context.Background())
			if err != nil || report == nil {
				t.Fatalf("report after close: %v", err)
			}
			path := "/api/v1/execution/device-sessions/" + s.ID()
			if platform == verify.Mac || platform == verify.Linux {
				path = computerPath + "/" + s.ID() + "/report"
			}
			if len(f.calls("GET", path)) == 0 {
				t.Fatal("report used the wrong endpoint")
			}
		})
	}
	for _, body := range []any{nil, []any{}, "text", 1} {
		t.Run(fmt.Sprint(body), func(t *testing.T) {
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if strings.HasPrefix(r.URL.Path, "/api/v1/execution/device-sessions/") {
					writeJSON(w, 200, body)
					return true
				}
				return false
			})
			s := f.open(verify.Target{Platform: verify.IOS, AppID: appID})
			_, err := s.Report(context.Background())
			requireCode(t, err, verify.ErrAPI)
		})
	}
}

func TestLegacyErrorsExposeOnlyAllowlistedReasons(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   any
		reason verify.RefusalReason
	}{
		{409, map[string]any{"detail": "web_runtime_unavailable"}, verify.ReasonWebRuntimeUnavailable},
		{409, map[string]any{"detail": map[string]any{"error": "web_runtime_unavailable", "message": "private"}}, verify.ReasonWebRuntimeUnavailable},
		{409, map[string]any{"error": "web_runtime_unavailable"}, verify.ReasonWebRuntimeUnavailable},
		{409, map[string]any{"detail": "private", "message": "web_runtime_unavailable"}, ""},
		{409, map[string]any{"detail": "web_runtime_unavailable private"}, ""},
		{409, map[string]any{"detail": map[string]any{"code": "web_runtime_unavailable"}}, ""},
		{409, map[string]any{"detail": []string{"web_runtime_unavailable"}}, ""},
		{409, map[string]any{"detail": "web_runtime_unavailable", "error": map[string]any{"private": true}}, verify.ReasonWebRuntimeUnavailable},
	} {
		t.Run(fmt.Sprintf("%v", tc.body), func(t *testing.T) {
			f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path == startPath {
					writeJSON(w, tc.status, tc.body)
					return true
				}
				return false
			})
			_, err := verify.Open(context.Background(), verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID}, attachOptions(f))
			requireCode(t, err, verify.ErrAPI)
			var sdkError *verify.Error
			if !errors.As(err, &sdkError) || sdkError.Reason != tc.reason || sdkError.HTTPStatus != tc.status || strings.Contains(err.Error(), "private") {
				t.Fatalf("legacy error changed or leaked content: %v", err)
			}
		})
	}
	for _, tc := range []struct {
		status int
		reason verify.RefusalReason
		code   verify.Code
	}{{429, verify.ReasonComputerLimit, verify.ErrComputerLimit}, {503, verify.ReasonRuntimeUnavailable, verify.ErrNotAvailableOnPlatform}} {
		t.Run(string(tc.reason), func(t *testing.T) {
			f := newComputerFake(t, func(_ *fakeRevyl, w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path == computerPath {
					writeJSON(w, tc.status, map[string]any{"detail": map[string]any{"error": tc.reason}})
					return true
				}
				return false
			})
			_, err := verify.Open(context.Background(), verify.Target{Platform: verify.Mac}, attachOptions(f))
			requireCode(t, err, tc.code)
			var sdkError *verify.Error
			if !errors.As(err, &sdkError) || sdkError.Reason != tc.reason || sdkError.HTTPStatus != tc.status || len(f.requests) != 1 {
				t.Fatal("computer error metadata or refusal cleanup changed")
			}
		})
	}
}

func TestAttachHTTPFailureDoesNotStopComputer(t *testing.T) {
	f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if strings.HasSuffix(r.URL.Path, "/report") {
			writeJSON(w, 404, map[string]any{"detail": "private"})
			return true
		}
		return false
	})
	_, err := verify.Attach(context.Background(), sessionID, attachOptions(f))
	requireCode(t, err, verify.ErrAPI)
	if len(f.requests) != 1 {
		t.Fatal("failed attach tried to clean up")
	}
}

func TestNavigationBadJSONDoesNotReplay(t *testing.T) {
	f := newHostedFake(t, func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if r.URL.Path == proxyPath+"open_url" {
			_ = json.NewEncoder(w).Encode(map[string]any{"success": "true"})
			return true
		}
		return false
	})
	s := f.open(verify.Target{Platform: verify.Web, AppID: appID, BuildID: buildID})
	requireCode(t, s.Navigate(context.Background(), "https://example.test"), verify.ErrAPI)
	if len(f.calls("POST", proxyPath+"open_url")) != 1 {
		t.Fatal("invalid navigation response retried")
	}
}
