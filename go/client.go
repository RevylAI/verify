package verify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	backendURL = "https://backend.revyl.ai"
	appURL     = "https://app.revyl.ai"
	Version    = "0.1.0"
)

type client struct {
	base  string
	token string
	http  *http.Client
}

type response struct {
	status      int
	body        []byte
	contentType string
	cfRay       string
}

func newClient(options OpenOptions) (*client, string, error) {
	token, err := credentials()
	if err != nil {
		return nil, "", err
	}
	base := options.BackendURL
	if base == "" {
		base = os.Getenv("REVYL_BACKEND_URL")
	}
	if base == "" {
		base = backendURL
	}
	base, err = validatedOrigin(base)
	if err != nil {
		return nil, "", err
	}
	viewer := options.AppURL
	if viewer == "" {
		viewer = os.Getenv("REVYL_APP_URL")
	}
	if viewer == "" {
		viewer = appURL
	}
	_, err = validatedOrigin(viewer)
	if err != nil {
		return nil, "", failure(ErrConfigInvalid, "App URL must use HTTPS without credentials, query, or fragment (HTTP is allowed on loopback).")
	}
	viewer = strings.TrimRight(viewer, "/")
	h := http.Client{}
	if options.HTTPClient != nil {
		h = *options.HTTPClient
	}
	h.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &client{base: base, token: token, http: &h}, viewer, nil
}

func validatedOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Opaque != "" {
		return "", failure(ErrConfigInvalid, "Backend URL is not a valid URL.")
	}
	loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if (u.Scheme != "https" && !(u.Scheme == "http" && loopback)) || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") {
		return "", failure(ErrConfigInvalid, "Backend URL must use HTTPS without credentials, query, or fragment (HTTP is allowed on loopback).")
	}
	return u.Scheme + "://" + u.Host, nil
}

func credentials() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", failure(ErrAuthMissing, "Cannot locate the Revyl CLI login directory.")
	}
	var stored struct {
		APIKey            string `json:"api_key"`
		AccessToken       string `json:"access_token"`
		ExpiresAt         string `json:"expires_at"`
		LocalAuthOverride bool   `json:"local_auth_override"`
	}
	raw, err := os.ReadFile(filepath.Join(home, ".revyl", "credentials.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", failure(ErrAuthMissing, "Cannot read the Revyl CLI login. Run 'revyl auth login' again.")
	}
	if err == nil {
		if json.Unmarshal(raw, &stored) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return "", failure(ErrAuthMissing, "Revyl CLI credentials are not valid JSON. Run 'revyl auth login' again.")
		}
	}
	storedToken := stored.APIKey
	if stored.AccessToken != "" {
		expiry, parseErr := time.Parse(time.RFC3339Nano, stored.ExpiresAt)
		if stored.ExpiresAt == "" || (parseErr == nil && !time.Now().Add(time.Minute).After(expiry)) {
			storedToken = stored.AccessToken
		}
	}
	key := strings.TrimSpace(os.Getenv("REVYL_API_KEY"))
	if key != "" && !strings.HasPrefix(key, "${") && !(stored.LocalAuthOverride && storedToken != "") {
		return key, nil
	}
	if storedToken != "" {
		return storedToken, nil
	}
	return "", failure(ErrAuthMissing, "No Revyl credentials found. Set REVYL_API_KEY or run 'revyl auth login'.")
}

func contextError(ctx context.Context) error {
	return &Error{Code: ErrTimeout, Message: "Revyl operation exceeded its deadline or was cancelled.", Cause: ctx.Err()}
}

func pause(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return contextError(ctx)
	case <-timer.C:
		return nil
	}
}

func (c *client) send(ctx context.Context, method, path string, body any, retry bool, timeout time.Duration, worker bool) (response, error) {
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			return response{}, failure(ErrInvalidArgument, "Request cannot be encoded as JSON.")
		}
	}
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			return response{}, contextError(ctx)
		}
		result, err := c.sendOnce(ctx, method, path, encoded, timeout, worker)
		transient := err != nil || result.status == 502 || result.status == 503 || result.status == 504
		if !retry || !transient || attempt >= 2 || ctx.Err() != nil {
			return result, err
		}
		delay := 500 * time.Millisecond
		if attempt > 0 {
			delay = 1500 * time.Millisecond
		}
		if err := pause(ctx, delay); err != nil {
			return response{}, err
		}
	}
}

func (c *client) sendOnce(ctx context.Context, method, path string, body []byte, timeout time.Duration, worker bool) (response, error) {
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, method, c.base+path, bytes.NewReader(body))
	if err != nil {
		return response{}, failure(ErrAPI, "Could not construct Revyl request.")
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "revyl-verify/"+Version+" "+runtime.Version())
	req.Header.Set("X-Revyl-Client", "verify")
	if worker {
		req.Header.Set("X-Revyl-Agent", "Verify")
	}
	if method == "POST" && strings.HasPrefix(path, "/api/v1/computer-runs/") && strings.HasSuffix(path, "/operations") {
		req.Header.Set("Prefer", "respond-async")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	r, err := c.http.Do(req)
	if err != nil {
		if requestCtx.Err() != nil {
			return response{}, contextError(requestCtx)
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return response{}, &Error{Code: ErrTimeout, Message: "Revyl HTTP client timed out.", Cause: context.DeadlineExceeded}
		}
		return response{}, failure(ErrAPI, "Could not reach Revyl; the request was not replayed unless it is safe to retry.")
	}
	defer r.Body.Close()
	maxBytes := int64(16 * 1024 * 1024)
	if strings.HasPrefix(path, "/api/v1/computer-runs/") && strings.HasSuffix(path, "/screen/screenshot") {
		maxBytes = 4*((128*1024*1024+2)/3) + 4096
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
	if err != nil {
		if requestCtx.Err() != nil {
			return response{}, contextError(requestCtx)
		}
		return response{}, failure(ErrAPI, "Could not read the Revyl response.")
	}
	if int64(len(data)) > maxBytes {
		return response{}, failure(ErrAPI, "Revyl response exceeds the response size limit.")
	}
	return response{status: r.StatusCode, body: data, contentType: r.Header.Get("Content-Type"), cfRay: r.Header.Get("Cf-Ray")}, nil
}

func decode(r response, into any) error {
	if json.Unmarshal(r.body, into) != nil || bytes.Equal(bytes.TrimSpace(r.body), []byte("null")) {
		return failure(ErrAPI, "Revyl returned an invalid JSON response.")
	}
	return nil
}

func httpError(r response) error {
	code := ErrAPI
	if r.status == 401 || r.status == 403 {
		code = ErrAuthRejected
	}
	return responseFailure(r, code, fmt.Sprintf("Revyl request failed (HTTP %d).", r.status))
}

func (c *client) json(ctx context.Context, method, path string, body any, retry bool, timeout time.Duration, into any) error {
	r, err := c.send(ctx, method, path, body, retry, timeout, false)
	if err != nil {
		return err
	}
	if r.status < 200 || r.status >= 300 {
		return httpError(r)
	}
	return decode(r, into)
}
