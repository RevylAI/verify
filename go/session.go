package verify

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type OpenOptions struct {
	BackendURL  string
	AppURL      string
	HTTPClient  *http.Client
	StepTimeout time.Duration
	Log         func(string)
}

type StepOptions struct{ Timeout time.Duration }
type ValidationOptions struct {
	Timeout time.Duration
	Soft    bool
}
type StepResult struct {
	Type     string
	Text     string
	Passed   bool
	Reason   string
	Duration time.Duration
}

type Session struct {
	client                   *client
	id                       string
	runID                    string
	viewer                   string
	platform                 Platform
	stepTimeout              time.Duration
	mu                       sync.Mutex
	stepRunning              bool
	closeDone                chan struct{}
	closeErr                 error
	lifetime                 context.Context
	stopLifetime             context.CancelFunc
	log                      func(string)
	expiresAt                time.Time
	computerScreenReadyUntil time.Time
	viewerBase               string
	childOpens               sync.WaitGroup
	children                 []*Session
}

func (s *Session) ID() string           { return s.id }
func (s *Session) ViewerURL() string    { return s.viewer }
func (s *Session) ExpiresAt() time.Time { return s.expiresAt }

func openOptions(options []OpenOptions) (OpenOptions, error) {
	if len(options) > 1 {
		return OpenOptions{}, failure(ErrInvalidArgument, "Open and Attach accept at most one options value.")
	}
	var opt OpenOptions
	if len(options) == 1 {
		opt = options[0]
	}
	if opt.StepTimeout == 0 {
		opt.StepTimeout = 3 * time.Minute
	}
	if opt.StepTimeout < time.Second {
		return OpenOptions{}, failure(ErrInvalidArgument, "StepTimeout must be at least one second.")
	}
	return opt, nil
}

func Open(ctx context.Context, target Target, options ...OpenOptions) (*Session, error) {
	if err := target.validate(false); err != nil {
		return nil, err
	}
	opt, err := openOptions(options)
	if err != nil {
		return nil, err
	}
	callerCtx := ctx
	ctx, cancel := context.WithTimeout(callerCtx, target.StartTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, contextError(ctx)
	}
	c, viewer, err := newClient(opt)
	if err != nil {
		return nil, err
	}
	if target.Platform.computer() {
		return startComputer(ctx, c, viewer, target, opt)
	}
	request := map[string]any{"platform": target.Platform, "idle_timeout_seconds": target.IdleTimeoutSeconds}
	var id string
	if target.Platform == Web {
		build, err := c.webBuild(ctx, target)
		if err != nil {
			return nil, err
		}
		id, err = newUUID()
		if err != nil {
			return nil, failure(ErrAPI, "Could not generate a session ID.")
		}
		request["session_id"], request["app_id"], request["build_id"] = id, target.AppID, build
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
		for key, value := range map[string]string{"app_id": target.AppID, "build_id": target.BuildID, "app_url": target.ArtifactURL, "device_model": target.DeviceModel, "os_version": target.OSVersion} {
			if value != "" {
				request[key] = value
			}
		}
	}
	var start struct {
		SessionID string `json:"session_id"`
		RunID     string `json:"workflow_run_id"`
	}
	if err := c.json(ctx, "POST", "/api/v1/execution/start_device", request, false, 2*time.Minute, &start); err != nil {
		return nil, err
	}
	if (target.Platform == Web && start.SessionID != id) || (target.Platform != Web && start.RunID == "") {
		return nil, failure(ErrSessionStartFailed, "Revyl did not acknowledge the new session.")
	}
	s := &Session{client: c, id: start.SessionID, runID: start.RunID, platform: target.Platform, stepTimeout: opt.StepTimeout, log: opt.Log}
	s.viewer = viewer + "/sessions/" + url.PathEscape(s.id)
	err = s.ready(ctx, target)
	if err == nil && target.Platform != Web {
		err = s.waitFirstScreen(ctx, callerCtx)
	}
	if err != nil {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cleanupCancel()
		_ = s.Close(cleanupCtx)
		return nil, err
	}
	return s, nil
}

func (c *client) webBuild(ctx context.Context, t Target) (string, error) {
	if t.BuildID != "" {
		return t.BuildID, nil
	}
	path := "/api/v1/apps/" + url.PathEscape(t.AppID)
	if t.URL != "" {
		body := map[string]string{"url": t.URL}
		if t.Branch != "" {
			body["branch_name"] = t.Branch
		}
		var build struct {
			ID string `json:"id"`
		}
		if err := c.json(ctx, "POST", path+"/builds/external", body, true, 30*time.Second, &build); err != nil {
			return "", err
		}
		if build.ID == "" {
			return "", failure(ErrAPI, "Revyl registered the URL without a build ID.")
		}
		return build.ID, nil
	}
	q := url.Values{"artifact_kinds": {"web_external", "web_bundle"}, "include_jobs": {"false"}, "page": {"1"}, "page_size": {"1"}}
	if t.Branch != "" {
		q.Set("branch_name", t.Branch)
	} else {
		var app struct {
			Platform string `json:"platform"`
			BranchID string `json:"default_branch_id"`
		}
		if err := c.json(ctx, "GET", path, nil, true, 30*time.Second, &app); err != nil {
			return "", err
		}
		if app.Platform != "" && strings.ToLower(app.Platform) != "web" {
			return "", failure(ErrConfigInvalid, "Revyl app is not a web app.")
		}
		if app.BranchID != "" {
			q.Set("branch_id", app.BranchID)
		}
	}
	var builds struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := c.json(ctx, "GET", path+"/builds?"+q.Encode(), nil, true, 30*time.Second, &builds); err != nil {
		return "", err
	}
	if len(builds.Items) == 0 || builds.Items[0].ID == "" {
		return "", failure(ErrSessionStartFailed, "Revyl app has no web build. Set URL or create a web build first.")
	}
	return builds.Items[0].ID, nil
}

func (s *Session) ready(ctx context.Context, target Target) error {
	if target.Platform == Web {
		for {
			var detail struct {
				Status string `json:"status"`
				RunID  string `json:"workflow_run_id"`
			}
			if err := s.client.json(ctx, "GET", "/api/v1/execution/device-sessions/"+url.PathEscape(s.id), nil, true, 30*time.Second, &detail); err != nil {
				return err
			}
			switch detail.Status {
			case "completed", "failed", "cancelled", "timeout", "stopping":
				return failure(ErrSessionStartFailed, "Web session ended before becoming ready. See "+s.viewer)
			case "running":
				if detail.RunID != "" {
					s.runID = detail.RunID
					r, err := s.client.send(ctx, "GET", s.workerPath("screenshot"), nil, false, 30*time.Second, true)
					if err != nil {
						return err
					}
					if r.status == 200 && validPNG(r.body) {
						return nil
					}
					var detail struct {
						Error string `json:"error"`
					}
					_ = json.Unmarshal(r.body, &detail)
					if r.status != 503 && r.status != 409 && detail.Error != "not_ready" {
						if r.status == 200 {
							return failure(ErrActionFailed, "Revyl readiness screenshot is not a PNG.")
						}
						return s.workerError("GET", r)
					}
				}
			}
			if err := pause(ctx, 2*time.Second); err != nil {
				return err
			}
		}
	}
	for {
		var connection struct {
			Status string `json:"status"`
			URL    string `json:"worker_ws_url"`
		}
		if err := s.client.json(ctx, "GET", "/api/v1/execution/streaming/worker-connection/"+url.PathEscape(s.runID), nil, true, 30*time.Second, &connection); err != nil {
			return err
		}
		if connection.Status == "ready" && connection.URL != "" {
			break
		}
		if connection.Status == "cancelled" || connection.Status == "stopped" || connection.Status == "failed" {
			return failure(ErrSessionStartFailed, "Device assignment failed.")
		}
		if err := pause(ctx, 2*time.Second); err != nil {
			return err
		}
	}
	connectCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	for {
		r, err := s.client.send(connectCtx, "GET", s.workerPath("health"), nil, true, 30*time.Second, true)
		if err != nil {
			return err
		}
		if r.status == 200 {
			var health struct {
				Connected bool `json:"device_connected"`
			}
			if err := decode(r, &health); err != nil {
				return err
			}
			if health.Connected {
				break
			}
		} else if r.status != 503 {
			return s.workerError("GET", r)
		}
		if err := pause(connectCtx, 2*time.Second); err != nil {
			return err
		}
	}
	if target.BundleID != "" {
		r, err := s.worker(ctx, "POST", "launch", map[string]string{"bundle_id": target.BundleID}, false, 30*time.Second)
		if err != nil {
			return err
		}
		var launched struct {
			Success bool `json:"success"`
		}
		if err := decode(r, &launched); err != nil {
			return err
		}
		if !launched.Success {
			return failure(ErrSessionStartFailed, "Could not launch the installed app.")
		}
	}
	return nil
}

func (s *Session) workerPath(action string) string {
	return "/api/v1/execution/device-proxy/" + url.PathEscape(s.runID) + "/" + action
}

var sessionNotRunning = regexp.MustCompile(`(?i)session is (not running|not active|stopping)`)

func (s *Session) workerError(method string, r response) error {
	var detail struct {
		Error     string          `json:"error"`
		Detail    json.RawMessage `json:"detail"`
		Message   string          `json:"message"`
		Uncertain bool            `json:"execution_uncertain"`
	}
	_ = json.Unmarshal(r.body, &detail)
	reason := detail.Message
	var text string
	if json.Unmarshal(detail.Detail, &text) == nil {
		reason = text
	}
	code := ErrActionFailed
	switch {
	case r.status == 401 || r.status == 403:
		return httpError(r)
	case r.status == 501 || detail.Error == "not_available_on_platform" || detail.Error == "step_output_not_available":
		code = ErrNotAvailableOnPlatform
	case r.status == 404 || r.status == 410:
		code = ErrSessionEnded
	case r.status == 409:
		code = ErrSessionBusy
		if sessionNotRunning.MatchString(reason) || sessionNotRunning.MatchString(detail.Error) {
			code = ErrSessionEnded
		}
	case method == "POST" && (detail.Uncertain || detail.Error == "request_timeout" || detail.Error == "connection_closed" || detail.Error == "protocol_error"):
		code = ErrActionUncertain
	}
	return responseFailure(r, code, fmt.Sprintf("Revyl session request failed (HTTP %d). See %s", r.status, s.viewer))
}

func (s *Session) sessionEndError() error {
	s.mu.Lock()
	closed := s.closeDone != nil
	s.mu.Unlock()
	if closed {
		return failure(ErrSessionEnded, "The session was closed.")
	}
	if s.lifetime != nil && s.lifetime.Err() != nil {
		return failure(ErrSessionEnded, "The parent session was closed.")
	}
	if !s.expiresAt.IsZero() && !time.Now().Before(s.expiresAt) {
		return failure(ErrSessionEnded, "The session lifetime has expired.")
	}
	return nil
}

func (s *Session) worker(ctx context.Context, method, action string, body any, retry bool, timeout time.Duration) (response, error) {
	if err := s.sessionEndError(); err != nil {
		return response{}, err
	}
	requestCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if !s.expiresAt.IsZero() {
		var expireCancel context.CancelFunc
		requestCtx, expireCancel = context.WithDeadline(requestCtx, s.expiresAt)
		defer expireCancel()
	}
	if s.lifetime != nil {
		stop := context.AfterFunc(s.lifetime, cancel)
		defer stop()
		if s.lifetime.Err() != nil {
			cancel()
		}
	}
	r, err := s.client.send(requestCtx, method, s.workerPath(action), body, retry, timeout, true)
	if err != nil {
		if ended := s.sessionEndError(); ended != nil {
			return response{}, ended
		}
	}
	if err == nil && (r.status < 200 || r.status >= 300) {
		err = s.workerError(method, r)
	}
	return r, err
}

func (s *Session) Close(ctx context.Context) error {
	s.mu.Lock()
	if done := s.closeDone; done != nil {
		s.mu.Unlock()
		select {
		case <-done:
			return s.closeErr
		default:
		}
		select {
		case <-done:
			return s.closeErr
		case <-ctx.Done():
			return contextError(ctx)
		}
	}
	s.closeDone = make(chan struct{})
	s.mu.Unlock()
	if s.platform.computer() {
		s.stopLifetime()
		childErr := s.closeChildren(ctx)
		err := s.closeComputer(ctx)
		if err != nil {
			err = errors.Join(err, childErr)
		} else if childErr != nil {
			s.computerLog("child stop failed; parent physical release is confirmed")
		}
		s.mu.Lock()
		s.closeErr = err
		close(s.closeDone)
		s.mu.Unlock()
		return err
	}
	closeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	path := "/api/v1/execution/device/sessions/" + url.PathEscape(s.id) + "/stop"
	if s.id == "" {
		path = "/api/v1/execution/device/status/cancel/" + url.PathEscape(s.runID)
	}
	var result map[string]any
	err := s.client.json(closeCtx, "POST", path, nil, true, 30*time.Second, &result)
	s.mu.Lock()
	s.closeErr = err
	close(s.closeDone)
	s.mu.Unlock()
	return err
}

func (s *Session) closeChildren(ctx context.Context) error {
	budget := 5 * time.Second
	if deadline, ok := ctx.Deadline(); ok {
		budget = min(budget, max(time.Until(deadline)/2, 0))
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	done := make(chan struct{})
	go func() {
		s.childOpens.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		return contextError(ctx)
	}
	s.mu.Lock()
	children := append([]*Session(nil), s.children...)
	s.mu.Unlock()
	var err error
	for _, child := range children {
		err = errors.Join(err, child.Close(ctx))
	}
	return err
}

func validPNG(data []byte) bool {
	return len(data) >= 24 && bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) && binary.BigEndian.Uint32(data[16:20]) > 0 && binary.BigEndian.Uint32(data[20:24]) > 0
}

func (s *Session) Screenshot(ctx context.Context, paths ...string) ([]byte, error) {
	if len(paths) > 1 {
		return nil, failure(ErrInvalidArgument, "Screenshot accepts at most one path.")
	}
	if s.platform.computer() {
		return s.computerScreenshot(ctx, paths...)
	}
	ctx, cancel := context.WithTimeout(ctx, 95*time.Second)
	defer cancel()
	r, err := s.worker(ctx, "GET", "screenshot", nil, true, 30*time.Second)
	if err != nil {
		return nil, err
	}
	if !validPNG(r.body) {
		return nil, failure(ErrActionFailed, "Revyl returned a screenshot that is not a PNG.")
	}
	if len(paths) == 1 && paths[0] != "" {
		if err := os.MkdirAll(filepath.Dir(paths[0]), 0o755); err != nil {
			return nil, &Error{Code: ErrActionFailed, Message: "Could not create screenshot directory.", Cause: err}
		}
		if err := os.WriteFile(paths[0], r.body, 0o600); err != nil {
			return nil, &Error{Code: ErrActionFailed, Message: "Could not write screenshot.", Cause: err}
		}
	}
	return r.body, nil
}

func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
