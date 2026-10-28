package verify_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	verify "github.com/RevylAI/verify/go"
)

const (
	appID     = "0b6a8c3e-1111-4222-8333-944455556666"
	buildID   = "9a9a9a9a-1111-4222-8333-944455556666"
	sessionID = "11111111-2222-4333-8444-555555555555"
	startPath = "/api/v1/execution/start_device"
	proxyPath = "/api/v1/execution/device-proxy/run-1/"
)

type recordedRequest struct {
	Method string
	Path   string
	Query  map[string][]string
	Header http.Header
	Body   map[string]any
}

type fakeRevyl struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
	fixtures map[string]json.RawMessage
	handler  func(http.ResponseWriter, *http.Request, map[string]any) bool
}

func newFake(t *testing.T) *fakeRevyl {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("REVYL_API_KEY", "test-token")
	data, err := os.ReadFile("testdata/device-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRevyl{t: t}
	if err := json.Unmarshal(data, &f.fixtures); err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewServer(http.HandlerFunc(f.serveHTTP))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeRevyl) serveHTTP(w http.ResponseWriter, r *http.Request) {
	body := make(map[string]any)
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			f.t.Errorf("decode fake request: %v", err)
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
	}
	f.mu.Lock()
	f.requests = append(f.requests, recordedRequest{r.Method, r.URL.Path, r.URL.Query(), r.Header.Clone(), body})
	f.mu.Unlock()
	if f.handler != nil && f.handler(w, r, body) {
		return
	}
	switch {
	case r.Method == "POST" && r.URL.Path == startPath:
		if body["platform"] == "web" {
			response := f.fixture("webStart")
			response["session_id"] = body["session_id"]
			writeJSON(w, 200, response)
		} else {
			f.reply(w, "androidStart")
		}
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/v1/execution/device-sessions/"):
		f.reply(w, "webReady")
	case r.Method == "GET" && r.URL.Path == "/api/v1/execution/streaming/worker-connection/run-1":
		f.reply(w, "workerConnection")
	case r.Method == "GET" && r.URL.Path == proxyPath+"health":
		f.reply(w, "health")
	case r.Method == "GET" && r.URL.Path == proxyPath+"screenshot":
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(testPNG())
	case r.Method == "POST" && r.URL.Path == proxyPath+"launch":
		writeJSON(w, 200, map[string]any{"success": true, "action": "launch"})
	case r.Method == "POST" && r.URL.Path == proxyPath+"execute_step":
		if body["step_type"] == "validation" {
			f.reply(w, "validationPassed")
		} else {
			f.reply(w, "stepResult")
		}
	case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/stop"):
		f.reply(w, "stop")
	case r.Method == "POST" && r.URL.Path == "/api/v1/apps/"+appID+"/builds/external":
		writeJSON(w, 200, map[string]any{"id": buildID})
	case r.Method == "GET" && r.URL.Path == "/api/v1/apps/"+appID:
		writeJSON(w, 200, map[string]any{"id": appID, "platform": "web", "default_branch_id": "default-branch"})
	case r.Method == "GET" && r.URL.Path == "/api/v1/apps/"+appID+"/builds":
		writeJSON(w, 200, map[string]any{"items": []any{map[string]any{"id": buildID}}})
	default:
		f.t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		writeJSON(w, 599, map[string]any{"detail": "unmatched fake route"})
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (f *fakeRevyl) fixture(name string) map[string]any {
	var value map[string]any
	if err := json.Unmarshal(f.fixtures[name], &value); err != nil {
		panic(err)
	}
	return value
}

func (f *fakeRevyl) reply(w http.ResponseWriter, name string) { writeJSON(w, 200, f.fixture(name)) }

func (f *fakeRevyl) calls(method, path string) []recordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	var found []recordedRequest
	for _, r := range f.requests {
		if r.Method == method && r.Path == path {
			found = append(found, r)
		}
	}
	return found
}

func (f *fakeRevyl) open(target verify.Target) *verify.Session {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := verify.Open(ctx, target, verify.OpenOptions{BackendURL: f.server.URL, AppURL: "https://viewer.test", HTTPClient: f.server.Client()})
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			f.t.Errorf("cleanup close: %v", err)
		}
	})
	return s
}

func testPNG() []byte {
	data := make([]byte, 33)
	copy(data, []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82})
	binary.BigEndian.PutUint32(data[16:20], 1280)
	binary.BigEndian.PutUint32(data[20:24], 800)
	return data
}

func requireCode(t *testing.T, err error, code verify.Code) {
	t.Helper()
	if !errors.Is(err, code) {
		t.Fatalf("error = %v, want code %s", err, code)
	}
	var typed *verify.Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("error does not expose *verify.Error with code %s", code)
	}
}

func TestMobileRequests(t *testing.T) {
	for _, platform := range []verify.Platform{verify.IOS, verify.Android} {
		for _, source := range []string{"app", "build", "artifact", "bundle"} {
			t.Run(string(platform)+"/"+source, func(t *testing.T) {
				f := newFake(t)
				target := verify.Target{Platform: platform, DeviceModel: "test-device", OSVersion: "test-os", IdleTimeoutSeconds: 90}
				want := map[string]any{"platform": string(platform), "is_simulation": true, "device_model": "test-device", "os_version": "test-os", "idle_timeout_seconds": float64(90)}
				switch source {
				case "app":
					target.AppID = appID
					want["app_id"] = appID
				case "build":
					target.BuildID = buildID
					want["build_id"] = buildID
				case "artifact":
					target.ArtifactURL = "https://example.test/app.zip"
					want["app_url"] = target.ArtifactURL
				case "bundle":
					target.BundleID = "com.example.app"
				}
				s := f.open(target)
				if s.ID() != sessionID || s.ViewerURL() != "https://viewer.test/sessions/"+sessionID {
					t.Fatal("incorrect session identity or viewer URL")
				}
				calls := f.calls("POST", startPath)
				if len(calls) != 1 || !reflect.DeepEqual(calls[0].Body, want) {
					t.Fatalf("start body = %#v, want %#v", calls, want)
				}
				launches := f.calls("POST", proxyPath+"launch")
				if source == "bundle" {
					if len(launches) != 1 || launches[0].Body["bundle_id"] != target.BundleID {
						t.Fatal("bundle target did not launch the installed app")
					}
				} else if len(launches) != 0 {
					t.Fatal("unexpected launch mutation")
				}
				if calls[0].Header.Get("X-Revyl-Client") != "verify" || !strings.Contains(calls[0].Header.Get("User-Agent"), "revyl-verify/") {
					t.Fatal("missing client attribution headers")
				}
			})
		}
	}
}

func TestWebRequests(t *testing.T) {
	for _, source := range []string{"url", "build", "branch", "default-branch"} {
		t.Run(source, func(t *testing.T) {
			f := newFake(t)
			target := verify.Target{Platform: verify.Web, AppID: appID, IdleTimeoutSeconds: 120}
			switch source {
			case "url":
				target.URL = "https://example.test/store"
				target.Branch = "preview"
			case "build":
				target.BuildID = buildID
			case "branch":
				target.Branch = "preview"
			}
			s := f.open(target)
			calls := f.calls("POST", startPath)
			if len(calls) != 1 {
				t.Fatal("web start count is not one")
			}
			body := calls[0].Body
			if body["platform"] != "web" || body["app_id"] != appID || body["build_id"] != buildID || body["session_id"] != s.ID() || s.ID() == "" || body["idle_timeout_seconds"] != float64(120) {
				t.Fatalf("incorrect web start: %#v", body)
			}
			if _, ok := body["is_simulation"]; ok {
				t.Fatal("web request contains mobile simulation field")
			}
			registered := f.calls("POST", "/api/v1/apps/"+appID+"/builds/external")
			builds := f.calls("GET", "/api/v1/apps/"+appID+"/builds")
			if source == "url" {
				if len(registered) != 1 || !reflect.DeepEqual(registered[0].Body, map[string]any{"url": target.URL, "branch_name": "preview"}) {
					t.Fatal("incorrect external-build registration")
				}
			} else if len(registered) != 0 {
				t.Fatal("unexpected external-build registration")
			}
			if source == "branch" || source == "default-branch" {
				if len(builds) != 1 {
					t.Fatal("missing latest-build lookup")
				}
				q := builds[0].Query
				if !reflect.DeepEqual(q["artifact_kinds"], []string{"web_external", "web_bundle"}) || q["include_jobs"][0] != "false" || q["page_size"][0] != "1" {
					t.Fatalf("incorrect build query: %#v", q)
				}
				if source == "branch" && q["branch_name"][0] != "preview" {
					t.Fatal("missing named branch")
				}
				if source == "default-branch" && q["branch_id"][0] != "default-branch" {
					t.Fatal("missing default branch")
				}
			} else if len(builds) != 0 {
				t.Fatal("unexpected build lookup")
			}
		})
	}
}

func TestSyncAndAsyncSteps(t *testing.T) {
	for _, async := range []bool{false, true} {
		t.Run(fmt.Sprintf("async=%t", async), func(t *testing.T) {
			f := newFake(t)
			polls := 0
			if async {
				f.handler = func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
					switch r.URL.Path {
					case proxyPath + "execute_step":
						writeJSON(w, 202, f.fixture("stepAccepted"))
						return true
					case proxyPath + "step_status/step-1":
						polls++
						if polls == 1 {
							f.reply(w, "stepRunning")
						} else {
							writeJSON(w, 200, map[string]any{"step_id": "step-1", "status": "completed", "result": f.fixture("stepResult")})
						}
						return true
					}
					return false
				}
			}
			s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
			result, err := s.Instruction(context.Background(), "  Open the cart  ")
			if err != nil {
				t.Fatal(err)
			}
			if result.Type != "instruction" || result.Text != "Open the cart" || !result.Passed || result.Reason != "Done" || result.Duration < 0 {
				t.Fatalf("incorrect result: %#v", result)
			}
			calls := f.calls("POST", proxyPath+"execute_step")
			want := map[string]any{"step_type": "instruction", "step_description": "Open the cart", "session_id": sessionID, "workflow_run_id": "run-1"}
			if len(calls) != 1 || !reflect.DeepEqual(calls[0].Body, want) || calls[0].Header.Get("X-Revyl-Agent") != "Verify" {
				t.Fatalf("incorrect execute request: %#v", calls)
			}
			if async && polls != 2 {
				t.Fatalf("polls = %d, want 2", polls)
			}
		})
	}
}

func TestValidationVerdicts(t *testing.T) {
	for _, tc := range []struct {
		name, fixture string
		soft          bool
		code          verify.Code
		passed        bool
	}{
		{"pass", "validationPassed", false, "", true},
		{"hard-fail", "validationFailed", false, verify.ErrValidationFailed, false},
		{"soft-fail", "validationFailed", true, "", false},
		{"no-verdict", "stepResult", true, verify.ErrStepFailed, false},
		{"no-verdict-hard", "stepResult", false, verify.ErrStepFailed, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path != proxyPath+"execute_step" {
					return false
				}
				f.reply(w, tc.fixture)
				return true
			}
			s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
			result, err := s.Validation(context.Background(), "The cart is visible", verify.ValidationOptions{Soft: tc.soft})
			if tc.code != "" {
				requireCode(t, err, tc.code)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if result.Type != "validation" || result.Passed != tc.passed {
				t.Fatalf("incorrect verdict: %#v", result)
			}
		})
	}
}

func TestScreenshotAndClose(t *testing.T) {
	f := newFake(t)
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	path := filepath.Join(t.TempDir(), "nested", "screen.png")
	got, err := s.Screenshot(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, testPNG()) || !bytes.Equal(got, onDisk) {
		t.Fatal("screenshot bytes changed")
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
	if len(f.calls("POST", "/api/v1/execution/device/sessions/"+sessionID+"/stop")) != 1 {
		t.Fatal("close replayed stop")
	}
	_, err = s.Instruction(context.Background(), "Open settings")
	requireCode(t, err, verify.ErrSessionEnded)
	_, err = s.Screenshot(context.Background())
	requireCode(t, err, verify.ErrSessionEnded)
}

func TestCredentials(t *testing.T) {
	for _, tc := range []struct {
		name, env, stored, want string
		missing                 bool
	}{
		{"environment", " test-env ", `{"api_key":"stored"}`, "test-env", false},
		{"local-override", "test-env", `{"access_token":"browser","local_auth_override":true}`, "browser", false},
		{"stored-access", "", `{"access_token":"browser"}`, "browser", false},
		{"expired-access", "", `{"access_token":"expired","expires_at":"2020-01-01T00:00:00Z","api_key":"stored"}`, "stored", false},
		{"invalid-expiry", "", `{"access_token":"expired","expires_at":"invalid","api_key":"stored"}`, "stored", false},
		{"expired-override", "test-env", `{"access_token":"expired","expires_at":"2020-01-01T00:00:00Z","local_auth_override":true}`, "test-env", false},
		{"placeholder", "${{ secrets.REVYL_API_KEY }}", "", "", true},
		{"missing", "", "", "", true},
		{"malformed", "", `{not-json`, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			t.Setenv("REVYL_API_KEY", tc.env)
			if tc.stored != "" {
				dir := filepath.Join(os.Getenv("HOME"), ".revyl")
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(tc.stored), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if tc.missing {
				_, err := verify.Open(context.Background(), verify.Target{Platform: verify.Android, AppID: appID}, verify.OpenOptions{BackendURL: f.server.URL})
				requireCode(t, err, verify.ErrAuthMissing)
				if len(f.calls("POST", startPath)) != 0 {
					t.Fatal("missing credentials reached server")
				}
				return
			}
			f.open(verify.Target{Platform: verify.Android, AppID: appID})
			if f.calls("POST", startPath)[0].Header.Get("Authorization") != "Bearer "+tc.want {
				t.Fatal("wrong credential source")
			}
		})
	}
}

func TestReadRetriesButNoMutationReplay(t *testing.T) {
	t.Run("read-retry", func(t *testing.T) {
		f := newFake(t)
		s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
		attempts := 0
		f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
			if r.URL.Path != proxyPath+"screenshot" {
				return false
			}
			attempts++
			if attempts < 3 {
				writeJSON(w, 503, map[string]any{"detail": "temporary"})
				return true
			}
			return false
		}
		if _, err := s.Screenshot(context.Background()); err != nil {
			t.Fatal(err)
		}
		if attempts != 3 {
			t.Fatalf("read attempts = %d, want 3", attempts)
		}
	})
	for _, mutation := range []string{"start", "step"} {
		t.Run(mutation+"-not-replayed", func(t *testing.T) {
			f := newFake(t)
			path := startPath
			if mutation == "step" {
				path = proxyPath + "execute_step"
			}
			f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path != path {
					return false
				}
				writeJSON(w, 503, map[string]any{"error": "request_timeout", "execution_uncertain": true})
				return true
			}
			if mutation == "start" {
				_, err := verify.Open(context.Background(), verify.Target{Platform: verify.Android, AppID: appID}, verify.OpenOptions{BackendURL: f.server.URL})
				if err == nil {
					t.Fatal("failed start succeeded")
				}
			} else {
				s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
				_, err := s.Instruction(context.Background(), "Open the cart")
				requireCode(t, err, verify.ErrActionUncertain)
			}
			if len(f.calls("POST", path)) != 1 {
				t.Fatal("unsafe mutation was replayed")
			}
		})
	}
}

func TestWorkerErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   map[string]any
		code   verify.Code
	}{
		{"auth", 401, map[string]any{"detail": "Unauthorized"}, verify.ErrAuthRejected},
		{"busy", 409, map[string]any{"detail": "A step is already executing. Wait for it to complete before sending another."}, verify.ErrSessionBusy},
		{"ended-conflict", 409, map[string]any{"detail": "Session is not running"}, verify.ErrSessionEnded},
		{"gone", 410, map[string]any{"detail": "Gone"}, verify.ErrSessionEnded},
		{"unavailable", 501, map[string]any{"error": "step_output_not_available"}, verify.ErrNotAvailableOnPlatform},
		{"failed", 400, map[string]any{"detail": "Rejected"}, verify.ErrActionFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path != proxyPath+"execute_step" {
					return false
				}
				writeJSON(w, tc.status, tc.body)
				return true
			}
			s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
			_, err := s.Instruction(context.Background(), "Open the cart")
			requireCode(t, err, tc.code)
		})
	}
}

func TestInvalidTargetsBeforeNetwork(t *testing.T) {
	for _, target := range []verify.Target{
		{}, {Platform: verify.Android},
		{Platform: verify.IOS, AppID: "not-a-uuid"},
		{Platform: verify.Android, AppID: appID, BundleID: "com.example.app"},
		{Platform: verify.Android, ArtifactURL: "http://example.test/app.zip"},
		{Platform: verify.Android, AppID: appID, URL: "https://example.test"},
		{Platform: verify.Web, URL: "https://example.test"},
		{Platform: verify.Web, AppID: appID, URL: "http://example.test"},
		{Platform: verify.Web, AppID: appID, URL: "https://example.test", BuildID: buildID},
		{Platform: verify.Android, AppID: appID, IdleTimeoutSeconds: -1},
		{Platform: verify.Android, AppID: appID, StartTimeout: -time.Second},
	} {
		t.Run(fmt.Sprintf("%+v", target), func(t *testing.T) {
			f := newFake(t)
			_, err := verify.Open(context.Background(), target, verify.OpenOptions{BackendURL: f.server.URL})
			requireCode(t, err, verify.ErrInvalidArgument)
			if len(f.calls("POST", startPath)) != 0 {
				t.Fatal("invalid target reached server")
			}
		})
	}
}

func TestWebViewportAndSignIn(t *testing.T) {
	f := newFake(t)
	s := f.open(verify.Target{
		Platform: verify.Web, AppID: appID, BuildID: buildID,
		Viewport: &verify.Viewport{Width: 1280, Height: 800, DeviceScaleFactor: 2},
		SignIn:   &verify.SignIn{Path: "/login", Secret: "test-login", Persona: "shopper"},
	})
	want := map[string]any{
		"viewport": map[string]any{"width": float64(1280), "height": float64(800), "device_scale_factor": float64(2)},
		"sign_in":  map[string]any{"path": "/login", "secret_name": "test-login", "persona": "shopper"},
	}
	if !reflect.DeepEqual(f.calls("POST", startPath)[0].Body["web"], want) {
		t.Fatal("incorrect web options serialization")
	}
	if _, err := s.Instruction(context.Background(), "Open the cart"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Validation(context.Background(), "The cart is visible"); err != nil {
		t.Fatal(err)
	}
	steps := f.calls("POST", proxyPath+"execute_step")
	if len(steps) != 2 || steps[0].Body["session_id"] != s.ID() || steps[1].Body["step_type"] != "validation" {
		t.Fatal("web steps did not use the live-step contract")
	}
}

func TestCancelledStepCancelsRemotelyWithFreshContext(t *testing.T) {
	f := newFake(t)
	f.handler = func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		switch r.URL.Path {
		case proxyPath + "execute_step":
			if body["step_type"] != "instruction" {
				return false
			}
			writeJSON(w, 202, f.fixture("stepAccepted"))
			return true
		case proxyPath + "step_cancel/step-1":
			if r.Context().Err() != nil {
				t.Error("step cancellation reused expired context")
			}
			writeJSON(w, 200, map[string]any{"status": "cancelled"})
			return true
		}
		return false
	}
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := s.Instruction(ctx, "Open the cart")
	requireCode(t, err, verify.ErrTimeout)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("timeout did not preserve context deadline cause")
	}
	if len(f.calls("POST", proxyPath+"step_cancel/step-1")) != 1 {
		t.Fatal("accepted step was not cancelled exactly once")
	}
	if len(f.calls("POST", proxyPath+"execute_step")) != 1 {
		t.Fatal("cancelled mutation was replayed")
	}
	if _, err := s.Validation(context.Background(), "The cart is visible"); err != nil {
		t.Fatal(err)
	}
}

func TestStartupFailureClosesSession(t *testing.T) {
	for _, mode := range []string{"cancelled", "failed"} {
		t.Run(mode, func(t *testing.T) {
			f := newFake(t)
			f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				if r.URL.Path != "/api/v1/execution/streaming/worker-connection/run-1" {
					return false
				}
				status := "not_ready"
				if mode == "failed" {
					status = "failed"
				}
				writeJSON(w, 200, map[string]any{"status": status})
				return true
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			_, err := verify.Open(ctx, verify.Target{Platform: verify.Android, AppID: appID}, verify.OpenOptions{BackendURL: f.server.URL})
			want := verify.ErrTimeout
			if mode == "failed" {
				want = verify.ErrSessionStartFailed
			}
			requireCode(t, err, want)
			if len(f.calls("POST", "/api/v1/execution/device/sessions/"+sessionID+"/stop")) != 1 {
				t.Fatal("startup failure did not stop the accepted session")
			}
		})
	}
}

func TestTerminalStepFailures(t *testing.T) {
	for _, mode := range []string{"instruction-failed", "validation-execution-failed", "cancelled", "malformed", "missing-terminal-result"} {
		t.Run(mode, func(t *testing.T) {
			f := newFake(t)
			f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
				switch r.URL.Path {
				case proxyPath + "execute_step":
					switch mode {
					case "instruction-failed", "validation-execution-failed":
						result := f.fixture("validationPassed")
						result["success"] = false
						writeJSON(w, 200, result)
					case "malformed":
						_, _ = w.Write([]byte("not-json"))
					default:
						writeJSON(w, 202, f.fixture("stepAccepted"))
					}
					return true
				case proxyPath + "step_status/step-1":
					status := "completed"
					if mode == "cancelled" {
						status = "cancelled"
					}
					writeJSON(w, 200, map[string]any{"status": status})
					return true
				}
				return false
			}
			s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
			var err error
			want := verify.ErrStepFailed
			if mode == "instruction-failed" {
				_, err = s.Instruction(context.Background(), "Open settings")
				want = verify.ErrInstructionFailed
			} else {
				_, err = s.Validation(context.Background(), "Settings are visible", verify.ValidationOptions{Soft: true})
			}
			if mode == "malformed" || mode == "missing-terminal-result" {
				want = verify.ErrAPI
			}
			requireCode(t, err, want)
		})
	}
}

func TestInvalidStepArgumentsAndConcurrentStep(t *testing.T) {
	f := newFake(t)
	started := make(chan struct{})
	release := make(chan struct{})
	f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if r.URL.Path != proxyPath+"execute_step" {
			return false
		}
		close(started)
		select {
		case <-release:
			f.reply(w, "stepResult")
		case <-r.Context().Done():
		}
		return true
	}
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	for _, text := range []string{"", "  ", strings.Repeat("x", 4001), strings.Repeat("😀", 2001)} {
		_, err := s.Instruction(context.Background(), text)
		requireCode(t, err, verify.ErrInvalidArgument)
	}
	_, err := s.Instruction(context.Background(), "Open settings", verify.StepOptions{Timeout: time.Millisecond})
	requireCode(t, err, verify.ErrInvalidArgument)
	if len(f.calls("POST", proxyPath+"execute_step")) != 0 {
		t.Fatal("invalid steps reached server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.Instruction(ctx, "Open settings"); done <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("step did not start")
	}
	_, err = s.Validation(ctx, "Settings are visible")
	requireCode(t, err, verify.ErrInvalidArgument)
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestExplicitURLOptionsAndRedirectRejection(t *testing.T) {
	t.Run("explicit options", func(t *testing.T) {
		f := newFake(t)
		s, err := verify.Open(context.Background(), verify.Target{Platform: verify.Android, AppID: appID}, verify.OpenOptions{BackendURL: f.server.URL, AppURL: "https://viewer.test/"})
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := s.Close(ctx); err != nil {
				t.Error(err)
			}
		}()
		if s.ViewerURL() != "https://viewer.test/sessions/"+sessionID {
			t.Fatal("app URL override was not used")
		}
	})
	t.Run("redirect", func(t *testing.T) {
		f := newFake(t)
		var mu sync.Mutex
		redirected := 0
		destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			redirected++
			mu.Unlock()
			writeJSON(w, 200, f.fixture("androidStart"))
		}))
		defer destination.Close()
		f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
			http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
			return true
		}
		_, err := verify.Open(context.Background(), verify.Target{Platform: verify.Android, AppID: appID}, verify.OpenOptions{BackendURL: f.server.URL, HTTPClient: f.server.Client()})
		requireCode(t, err, verify.ErrAPI)
		mu.Lock()
		defer mu.Unlock()
		if redirected != 0 {
			t.Fatal("redirect leaked a request to another origin")
		}
	})
}

func TestUnsupportedAndInvalidOptions(t *testing.T) {
	for _, backend := range []string{"not-a-url", "http://example.test", "https://user:password@example.test", "https://example.test?token=placeholder", "https://example.test#fragment"} {
		t.Run(backend, func(t *testing.T) {
			newFake(t)
			_, err := verify.Open(context.Background(), verify.Target{Platform: verify.Android, AppID: appID}, verify.OpenOptions{BackendURL: backend})
			requireCode(t, err, verify.ErrConfigInvalid)
		})
	}
}

func TestInvalidScreenshot(t *testing.T) {
	f := newFake(t)
	f.handler = func(w http.ResponseWriter, r *http.Request, _ map[string]any) bool {
		if r.URL.Path != proxyPath+"screenshot" {
			return false
		}
		_, _ = w.Write([]byte("not-a-png"))
		return true
	}
	s := f.open(verify.Target{Platform: verify.Android, AppID: appID})
	_, err := s.Screenshot(context.Background())
	requireCode(t, err, verify.ErrActionFailed)
}

func TestErrorWrapping(t *testing.T) {
	newFake(t)
	err := &verify.Error{Code: verify.ErrTimeout, Message: "deadline", Cause: context.DeadlineExceeded}
	wrapped := fmt.Errorf("operation: %w", err)
	requireCode(t, wrapped, verify.ErrTimeout)
	if !errors.Is(wrapped, context.DeadlineExceeded) || errors.Is(wrapped, verify.ErrAPI) {
		t.Fatal("incorrect error chain matching")
	}
	if verify.ErrTimeout.Error() != "TIMEOUT" {
		t.Fatal("code does not implement error")
	}
}
