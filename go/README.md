# Verify for Go

Open a Revyl cloud browser, iOS simulator, or Android emulator, run instruction and validation steps, take screenshots, and close the session. This is a standard-library-only Go SDK, not a test runner. It does not provide `test`, `describe`, or `expect`.

## Install

Use Go 1.26.9 or later and a Revyl account. Set `REVYL_API_KEY` through your shell or CI secret manager, or sign in with `revyl auth login`.

The module lives in the repository's `go/` subdirectory. After the Go SDK merges into `main`, install it with:

```sh
go get github.com/RevylAI/verify/go@main
```

There is no Go release tag yet. `@main` resolves to a pseudo-version; commit the resulting `go.mod` and `go.sum` in your app to pin it. A future submodule release must use the repository tag `go/v0.1.0`, after which installation will be `go get github.com/RevylAI/verify/go@v0.1.0`. The npm version does not version this Go module.

## Core API

Inside a function returning `error`, with `verify "github.com/RevylAI/verify/go"`, `context`, and `time` imported:

```go
s, err := verify.Open(ctx, verify.Target{Platform: verify.Android, BundleID: "com.example.app"})
if err != nil {
	return err
}
defer func() {
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = s.Close(cleanup)
}()
if _, err := s.Instruction(ctx, "Open the cart"); err != nil {
	return err
}
if _, err := s.Validation(ctx, "The cart shows one item"); err != nil {
	return err
}
_, err = s.Screenshot(ctx, "artifacts/cart.png")
return err
```

This sketch ignores cleanup errors for brevity; the complete example below reports them. Go has no automatic process-exit cleanup: explicitly close every successful session, including on error. Use a fresh, bounded cleanup context so canceling the work context does not prevent cleanup. `Close` is idempotent. An abrupt process termination cannot run deferred functions.

`Close` requests a device stop (or cancels startup when no session ID was returned); success acknowledges the request, not confirmed physical release. Concurrent/repeated calls share the first close result, including an error. It does not retry a failed close as a new operation.

## Use inside `go test`

Save this as `checkout_test.go` in your own module. This example starts a real, billable cloud session when you run it; use only an account and workload you are authorized to run.

```go
package checkout_test

import (
    "context"
    "testing"
    "time"

    verify "github.com/RevylAI/verify/go"
)

func TestCheckout(t *testing.T) {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
    defer cancel()
    s, err := verify.Open(ctx, verify.Target{
        Platform: verify.Web,
        AppID:    "00000000-0000-4000-8000-000000000000",
        URL:      "https://example.com",
    })
    if err != nil {
        t.Fatal(err)
    }
    defer func() {
        cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        if err := s.Close(cleanup); err != nil {
            t.Errorf("close session: %v", err)
        }
    }()
    t.Log("Watch:", s.ViewerURL())
    if _, err := s.Instruction(ctx, "Open the shopping cart"); err != nil {
        t.Fatal(err)
    }
    if _, err := s.Validation(ctx, "The shopping cart is empty"); err != nil {
        t.Fatal(err)
    }
    if _, err := s.Screenshot(ctx, "artifacts/cart.png"); err != nil {
        t.Fatal(err)
    }
}
```

Run with `go test -v -timeout 6m`. `t.Fatal` runs deferred cleanup. The URL and app ID above are placeholders, not a runnable store fixture.

## Targets and options

- **Web:** `Target{Platform: verify.Web, AppID: "…", URL: "https://…"}` registers a deployed HTTPS URL as a web build. Alternatively supply `BuildID`, or omit URL and build ID to select the latest web build on `Branch` (the app's default branch if omitted). `Viewport` accepts `Width`, `Height`, and optional `DeviceScaleFactor`; `SignIn` accepts `Path`, `Secret` (the stored secret's name, never its value), and optional `Persona`.
- **iOS and Android:** set `Platform` to `verify.IOS` or `verify.Android` and exactly one of `AppID`, `BuildID`, `ArtifactURL` (HTTPS), or `BundleID` (an app already installed). `DeviceModel` and `OSVersion` are optional. `URL`, `Branch`, `Viewport`, and `SignIn` are web-only.
- `Target.StartTimeout` bounds startup (default 10 minutes); `IdleTimeoutSeconds` sets the session's idle timeout (default 600 seconds). All methods also honor the caller's context.
- `OpenOptions{StepTimeout: 3*time.Minute}` changes the default step timeout. Per-call `StepOptions{Timeout: time.Minute}` and `ValidationOptions{Timeout: time.Minute, Soft: true}` override it. Run one step at a time per session.
- `OpenOptions{BackendURL: "https://…", AppURL: "https://…", HTTPClient: client}` overrides transport configuration. `REVYL_BACKEND_URL` and `REVYL_APP_URL` are also supported. Defaults are Revyl production; credentials must match the selected backend. Backend URLs require HTTPS, except HTTP on loopback. Redirects are rejected, not followed with credentials.

Requests have bounded deadlines even when passed `context.Background()`: ordinary HTTP requests use 30 seconds, session creation up to 2 minutes, and accepted-step cancellation up to 5 seconds on a fresh context. Responses are limited to 16 MiB, including screenshots. Safe reads and idempotent build-registration/stop requests retry at most twice on transient failures; session creation, launch, and step submission are never replayed. Caller cancellation remains detectable with `errors.Is(err, context.Canceled)` or `context.DeadlineExceeded`, alongside `verify.ErrTimeout`.

The Go SDK does not read `verify.config.ts`, resolve named targets, provide an init CLI, or support Mac/Linux computers. Every step runs on the live session; there is no cached replay.

## Results and errors

`Instruction` and `Validation` return `StepResult{Type, Text, Reason, Passed, Duration}`. Failed instructions return `ErrInstructionFailed`; failed validation verdicts return `ErrValidationFailed`. `Soft: true` returns a false verdict without an error, but a missing verdict, failed execution, or cancellation still returns an error such as `ErrStepFailed`. `Screenshot` returns PNG bytes and optionally writes a path, creating parent directories.

Errors support `errors.Is(err, verify.ErrTimeout)` and `errors.As(err, &sdkError)` where `var sdkError *verify.Error`. Stable codes distinguish invalid arguments/configuration, missing/rejected credentials, startup failure, ended/busy sessions, unavailable operations, action failure/uncertainty, step failure, and timeout. `Error.Cause` is available through `errors.Unwrap` when present. Do not replay mutations after `ErrActionUncertain`: the action may already have happened. Inspect the session in Revyl instead.

Credentials resolve from `REVYL_API_KEY`, then `~/.revyl/credentials.json`. A usable CLI login marked `local_auth_override` takes precedence over the environment key, matching the TypeScript SDK and Revyl CLI. Expired access tokens fall back to a stored API key. Never put keys, tokens, or private session content in source, fixtures, or logs.

Instruction and validation text is sent to Revyl for remote processing. The Go SDK does not log that text locally; do not include credentials or sensitive content in step descriptions.

## Develop

From `go/`:

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test -race ./...
```

The repository's tests use loopback fake servers and the shared `testdata/device-contract.json` fixtures. They isolate home directories and credentials and never create live sessions. Fake-server coverage verifies the client contract, not production device behavior.
