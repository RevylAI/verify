# Verify for Go

Open a Revyl cloud browser or mobile device for instruction and validation steps, or a Mac/Linux computer for commands and files. This is a standard-library-only Go SDK, not a test runner. It does not provide `test`, `describe`, or `expect`.

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

On web/mobile, `Close` requests a device stop (or cancels startup when no session ID was returned); success acknowledges the request, not confirmed physical release. Computers require confirmed physical release. Concurrent/repeated calls share the first close result, including an error. It does not retry a failed close as a new operation.

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
- **Mac and Linux computers:** `Target{Platform: verify.Mac}` or `Target{Platform: verify.Linux}` creates a workspace; only `StartTimeout` is accepted alongside the platform. Both are early access, available only in approved Revyl staging environments, and are not yet available in Revyl production. Linux runs Ubuntu 24.04 arm64 in the hosted computer runtime; Mac commands are not portable to Linux, so use explicit `/bin/sh` or platform-aware argv when needed. Use the approved backend/app overrides and credentials for your environment. A 429 `ErrComputerLimit` means queued work or a concurrency limit; Verify does not guess which cause applies or retry creation. See [computer availability](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors).
- `Target.StartTimeout` bounds startup (default 10 minutes); on web/mobile, `IdleTimeoutSeconds` sets the session's idle timeout (default 600 seconds). All methods also honor the caller's context.
- `OpenOptions{StepTimeout: 3*time.Minute}` changes the default step timeout. Per-call `StepOptions{Timeout: time.Minute}` and `ValidationOptions{Timeout: time.Minute, Soft: true}` override it. Run one step at a time per session.
- `OpenOptions{BackendURL: "https://…", AppURL: "https://…", HTTPClient: client}` overrides transport configuration. `REVYL_BACKEND_URL` and `REVYL_APP_URL` are also supported. Defaults are Revyl production; credentials must match the selected backend. Backend URLs require HTTPS, except HTTP on loopback. Redirects are rejected, not followed with credentials.
- `OpenOptions{Log: func(line string) { ... }}` opts into computer lifecycle and evidence-gap messages; the default is quiet for all targets. Keep that callback concurrency-safe if operations run concurrently. A confirmed execution result remains usable when its report evidence is pending or failed; the callback identifies that gap without logging private output or recording URLs.

Requests have bounded deadlines even when passed `context.Background()`: ordinary HTTP requests use 30 seconds, device session creation up to 2 minutes, and accepted-step cancellation up to 5 seconds on a fresh context. Ordinary responses are limited to 16 MiB; computer screenshots allow up to 128 MiB of decoded image data. Safe reads and idempotent device build-registration/stop requests retry at most twice on transient failures; session creation, launch, and step/operation submission are never replayed. Caller cancellation remains detectable with `errors.Is(err, context.Canceled)` or `context.DeadlineExceeded`, alongside `verify.ErrTimeout` for device operations; interrupted computer mutation observation returns `verify.ErrActionUncertain`.

The Go SDK does not read `verify.config.ts`, resolve named targets, or provide an init CLI. Every step runs on the live session; there is no cached replay. Instruction and validation methods on computers return `ErrNotAvailableOnPlatform` locally; computer-only methods on web/mobile do the same.

## Mac and Linux commands and files

The following Mac example runs against the environment you select through `REVYL_BACKEND_URL` and `REVYL_APP_URL`. Set those to your approved early-access environment and use matching credentials before running it. Use `verify.Linux` for the same file/command API on a Linux guest, with platform-appropriate argv. This does not make computers available in production.

```go
package workspace

import (
	"context"
	"errors"
	"fmt"
	"time"

	verify "github.com/RevylAI/verify/go"
)

func CheckWorkspace(ctx context.Context) (err error) {
	s, err := verify.Open(ctx, verify.Target{Platform: verify.Mac})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 310*time.Second)
		defer cancel()
		err = errors.Join(err, s.Close(cleanup))
	}()
	result, err := s.Exec(ctx, []string{"printf", "%s", "hello"}, verify.ExecOptions{Timeout: 30 * time.Second})
	if err != nil {
		return err
	}
	if result.Stdout != "hello" {
		return fmt.Errorf("unexpected command output")
	}
	if err := s.WriteFile(ctx, "hello.bin", []byte{0, 255, 1}); err != nil {
		return err
	}
	data, err := s.ReadFile(ctx, "hello.bin")
	if err != nil {
		return err
	}
	if len(data) != 3 {
		return fmt.Errorf("unexpected file length")
	}
	return nil
}
```

`Exec` sends an argv array, not a shell string. `ExecOptions.Stdin` is binary input. Nonzero exits return `ErrCommandFailed` with optional decoded `Error.ExecResult`; to inspect a nonzero result without that error, pass `ExecOptions{Check: &check}` where `check := false`. `ReadFile` and `WriteFile` use byte slices. `Stat` returns `FileStat{Kind, Size}`; `Processes` returns session-owned `ComputerProcess{ID, State, ExitCode}` handles, and `Terminate` accepts one of those IDs, not an OS PID. Computer lifetime is 60 minutes from create; operation timeouts cannot extend it. `ExpiresAt()` exposes the server's deadline (zero for devices or older reports without one); expired computers reject new operations, but cleanup and recording retrieval remain available.

Computer paths must be workspace-relative with no empty, dot, parent, backslash, colon, or control-character components. Limits are 64 argv entries and 16 KiB for argv plus stdin, 64 KiB per file write, and 1 MiB per file read or combined stdout/stderr. `OperationOptions.Timeout` and `ExecOptions.Timeout` are whole-millisecond durations from 1 ms to 5 minutes, defaulting to 30 seconds. Request observation is separately bounded to 310 seconds and honors context cancellation.

Operations submit once, then poll the deterministic operation ID after an asynchronous acceptance. Unconfirmed outcomes return `ErrActionUncertain`, never an automatic mutation replay. Closing a computer cancels observation of in-flight operations and submits stop once; it succeeds only when the server confirms physical release in a terminal state. An uncertain release is an error, and repeated `Close` calls return the cached result rather than resubmitting stop. Use a fresh cleanup context with up to 310 seconds, as above; canceled work must not cancel cleanup.

An unclaimed start may fail with `no_host` after 120 seconds from creation. Verify stops readiness polling and attempts bounded cleanup; this does not shorten the default 10-minute startup timeout for already-claimed guests or prove that physical release succeeded.

`Recording(ctx)` works after `Close` and checks the terminal report and confirmed physical release before requesting retained recording metadata. It returns `*ComputerRecording{URL, Duration, StartedAt}` without downloading the video; `Duration` and `StartedAt` are nullable pointers. Recording processing is asynchronous, so a 404 `recording_unavailable` returns `(nil, nil)`; other errors remain typed. Before confirmed terminal release, it returns `ErrSessionBusy`. Signed recording URLs last up to one hour, are private, and are never logged; call `Recording` again to refresh metadata rather than retaining an expired URL.

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

The repository's tests use loopback fake servers and shared `testdata/device-contract.json` and `testdata/computer-contract.json` fixtures. They isolate home directories and credentials and never create live sessions. Fake-server coverage verifies the client contract, not production device or computer behavior.
