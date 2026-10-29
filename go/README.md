# Verify for Go

Open a Revyl cloud browser or mobile device for instruction and validation steps, or a Mac/Linux computer for commands and files. This is a standard-library-only Go SDK, not a test runner. It does not provide `test`, `describe`, or `expect`.

## Install

Use Go 1.26.9 or later and a Revyl account. Set `REVYL_API_KEY` through your shell or CI secret manager, or sign in with `revyl auth login`. A usable stored login marked `local_auth_override` takes precedence over the environment key; otherwise the environment key wins.

The module lives in the repository's `go/` subdirectory. Install the tagged release with:

```sh
go get github.com/RevylAI/verify/go@v0.1.0
```

Go releases use independent repository tags such as `go/v0.1.0`; npm versions do not version this module. Commit the resulting `go.mod` and `go.sum` in your app to pin dependencies.

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

After connection and any explicit mobile bundle launch, `Open` observes screenshots for up to 10 seconds, bounded by its startup context, looking for distinct RGB pixels in the central 80% of a PNG. This is best-effort blank-frame detection: the runtime has no rendered-readiness signal, and content does not prove that the intended app is foreground or loaded. Exhaustion, unavailable screenshots, and undecodable images produce a debug note through `OpenOptions.Log` and continue; caller cancellation still returns an error and attempts cleanup. Begin with an instruction that waits for the screen your workflow needs.

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
- **Mac and Linux computers:** `Target{Platform: verify.Mac}` or `Target{Platform: verify.Linux}` creates a workspace; only `StartTimeout` is accepted alongside the platform. Both are early access; ask support@revyl.ai about access. Mac commands are not portable to Linux, so use platform-aware argv when needed. A 429 `ErrComputerLimit` means queued work or a concurrency limit; Verify does not guess which cause applies or retry creation. See [computer availability](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors).
- `Target.StartTimeout` bounds startup (default 10 minutes); on web/mobile, `IdleTimeoutSeconds` sets the session's idle timeout (default 600 seconds). All methods also honor the caller's context.
- `OpenOptions{StepTimeout: 3*time.Minute}` changes the default step timeout. Per-call `StepOptions{Timeout: time.Minute}` and `ValidationOptions{Timeout: time.Minute, Soft: true}` override it. Run one step at a time per session.
- Redirects are rejected, not followed with credentials.
- `OpenOptions{Log: func(line string) { ... }}` opts into computer lifecycle, evidence-gap messages, and mobile best-effort first-screen debug notes; the default is quiet for all targets. Keep that callback concurrency-safe if operations run concurrently. A confirmed execution result remains usable when its report evidence is pending or failed; the callback identifies that gap without logging private output or recording URLs.

Requests have bounded deadlines even when passed `context.Background()`: ordinary HTTP requests use 30 seconds, device session creation up to 2 minutes, and accepted-step cancellation up to 5 seconds on a fresh context. Ordinary responses are limited to 16 MiB; computer screenshots allow up to 128 MiB of decoded image data. Safe reads and idempotent device build-registration/stop requests retry at most twice on transient failures; session creation, launch, and step/operation submission are never replayed. Caller cancellation remains detectable with `errors.Is(err, context.Canceled)` or `context.DeadlineExceeded`, alongside `verify.ErrTimeout` for device operations; interrupted computer mutation observation returns `verify.ErrActionUncertain`.

The Go SDK does not read `verify.config.ts`, resolve named targets, or provide an init CLI. Every step runs on the live session; there is no cached replay. Instruction and validation methods on computers return `ErrNotAvailableOnPlatform` locally; computer-only methods on web/mobile do the same.

## Attach and hosted app sessions

The `Attach`, hosted `Open`, `Navigate`, and `Report` APIs are unreleased additions; use a reviewed source revision until the next Go release includes them.

`verify.Attach(ctx, computerID, options...)` connects to an existing active computer using the same credentials and `OpenOptions` as `verify.Open`. It reads the computer report, verifies the ID, OS, state, and future expiry, and returns a normal `*Session`. Failed attachment never creates or stops a computer. Successful attachment takes cleanup ownership by default: explicitly close it, even if another process created it. Do not let two independent owners close the same computer unexpectedly.

To attach without taking ownership, set `stop := false` and pass `verify.OpenOptions{StopOnClose: &stop}` to `Attach`. `nil` and a pointer to `true` preserve owning behavior. For a computer owned by another caller, such as a CI runner, this lets `Close` cancel pending child starts and close children within the existing five-second phase without stopping the computer. Its owner remains responsible for releasing it, and child-cleanup failures are returned. Ownership is never inferred from environment variables. The Go SDK does not register automatic process-exit cleanup.

Call `computer.Open(ctx, target)` to start a web, iOS, or Android app session inside that computer, rather than on an unrelated worker. It reuses the computer's credentials, backend, viewer, HTTP client, step timeout, and log callback. Both `AppID` and `BuildID` must be exact Revyl UUIDs. Hosted targets cannot select `URL`, `Branch`, `ArtifactURL`, `BundleID`, `DeviceModel`, or `OSVersion`. Web targets allow `Viewport`, `SignIn`, `IdleTimeoutSeconds`, and `StartTimeout`; native targets allow the two timeouts and always request simulation.

Mac computers can host web and iOS; Linux computers can host web and Android. These are client-side compatibility limits, not a capacity guarantee: the server can refuse any hosted start. Linux hosted web depends on server runtime capability; accepting the target in the SDK does not imply it works in every runtime. Computers remain early access.

Inside a function returning `error`, with a computer ID and existing app/build UUIDs supplied by your caller:

```go
computer, err := verify.Attach(ctx, computerID)
if err != nil {
	return err
}
defer func() {
	cleanup, cancel := context.WithTimeout(context.Background(), 310*time.Second)
	defer cancel()
	_ = computer.Close(cleanup)
}()
browser, err := computer.Open(ctx, verify.Target{
	Platform: verify.Web,
	AppID:    webAppID,
	BuildID:  webBuildID,
})
if err != nil {
	return err
}
if err := browser.Navigate(ctx, "http://localhost:3000"); err != nil {
	return err
}
_, err = browser.Validation(ctx, "The application home page is visible")
return err
```

Select an existing HTTPS web build for startup, then navigate to a guest-local HTTP service once ready. `Navigate(ctx, url)` is web-only and submits `open_url` once, without retries. HTTP and HTTPS URLs of up to 2048 characters are accepted, including localhost; credentials, whitespace, control characters, backslashes, and invalid ports are rejected. On a hosted child, localhost refers to its parent computer; on an ordinary cloud web session, it refers to that web runtime, not your computer or another Revyl computer. A cold development server may need a warm-up request before navigation succeeds. If navigation returns `ACTION_UNCERTAIN`, the request may still commit; re-navigating is the caller's choice. The runtime is responsible for enforcing its navigation network policy. It checks the success envelope and returns only an error, without logging the URL. Hosted sessions reuse `Instruction`, `Validation`, `Screenshot`, and `Close`.

Each hosted start gets a distinct preallocated session ID and is never replayed. Ambiguous startup failures attempt cleanup of that child ID; definite refusals do not. Child startup failure never stops the parent. Parent close prevents new child opens and cancels in-flight startup. It spends at most five seconds total waiting for startup cleanup and closing children, or half the caller's remaining deadline if shorter, then requests parent stop with the remaining budget. Prompt child cleanup finishes before parent stop; slow child cleanup cannot consume the whole stop budget. The server's parent stop also stops its children. Confirmed physical parent release completes cleanup even if a child stop failed; the optional log callback reports that failure without response content. Otherwise cleanup errors remain observable. Child readiness is bounded by both `StartTimeout` and the computer's remaining lifetime; older computer reports without an expiry cannot host sessions. Child worker operations also honor the parent's expiry and close cancellation; cleanup and reports remain available afterward. Explicitly closing a child does not close its parent.

`session.Report(ctx)` returns a JSON object as `map[string]any` for normal, hosted, and computer sessions, including after close. It reads the device-session endpoint for app sessions and the computer report endpoint for computers; computer identity and state are validated. A session with no known ID returns `ErrNotFound` locally without a request. Reports may contain private session data: do not log or publish them indiscriminately.

## Mac and Linux commands and files

Use `verify.Linux` for the same file/command API on a Linux guest, with platform-appropriate argv.

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

**Breaking wire change:** computer-operation arguments use `argv_b64` (one padded URL-safe base64 UTF-8 string per argument) and file paths use `path_b64`, with no raw `argv` or `path`. This SDK is incompatible with the previous backend contract. Deploy the encoded-only backend before publishing or upgrading to this SDK. Public APIs and decoded limits are unchanged; `stdin` and file `data` retain their existing standard base64 encoding, and process commands are unchanged. Encoding is not encryption, and Verify does not fall back to plaintext or replay the request.

Computer `Screenshot` retries exact structured `screen_unavailable` (HTTP 409/503) and `screen_starting` (HTTP 409) during the fixed 30-second window after active readiness, with 500 ms backoff doubling up to 2 seconds. Context cancellation, close, expiry, and observation limits still apply. The window never resets on another call; exhaustion returns `ErrSessionBusy` with a desktop-not-ready message. Unrelated errors, authentication failures, malformed responses, and transport failures are not retried. Callers do not need a startup sleep, and mutations are never replayed by this behavior.

Operations submit once, then poll the deterministic operation ID after an asynchronous acceptance. Unconfirmed outcomes return `ErrActionUncertain`, never an automatic mutation replay. Closing a computer cancels observation of in-flight operations and submits stop once; it succeeds only when the server confirms physical release in a terminal state. An uncertain release is an error, and repeated `Close` calls return the cached result rather than resubmitting stop. Use a fresh cleanup context with up to 310 seconds, as above; canceled work must not cancel cleanup.

An unclaimed start may fail with `no_host` after 120 seconds from creation. Verify stops readiness polling and attempts bounded cleanup; this does not shorten the default 10-minute startup timeout for already-claimed guests or prove that physical release succeeded.

`Recording(ctx)` works after `Close` and checks the terminal report and confirmed physical release before requesting retained recording metadata. It returns `*ComputerRecording{URL, Duration, StartedAt}` without downloading the video; `Duration` and `StartedAt` are nullable pointers. Recording processing is asynchronous, so a 404 `recording_unavailable` returns `(nil, nil)`; other errors remain typed. Before confirmed terminal release, it returns `ErrSessionBusy`. Signed recording URLs last up to one hour, are private, and are never logged; call `Recording` again to refresh metadata rather than retaining an expired URL.

## Results and errors

`Instruction` and `Validation` return `StepResult{Type, Text, Reason, Passed, Duration}`. Failed instructions return `ErrInstructionFailed`; failed validation verdicts return `ErrValidationFailed`. `Soft: true` returns a false verdict without an error, but a missing verdict, failed execution, or cancellation still returns an error such as `ErrStepFailed`. `Screenshot` returns PNG bytes and optionally writes a path, creating parent directories.

Errors support `errors.Is(err, verify.ErrTimeout)` and `errors.As(err, &sdkError)` where `var sdkError *verify.Error`. Stable codes distinguish invalid arguments/configuration, missing/rejected credentials, startup failure, ended/busy sessions, unavailable operations, action failure/uncertainty, step failure, and timeout. `Error.Cause` is available through `errors.Unwrap` when present. Do not replay mutations after `ErrActionUncertain`: the action may already have happened. Inspect the session in Revyl instead.

`ErrEdgeBlocked` (`EDGE_BLOCKED`) identifies HTTP 403 with a `text/html` content type and nonempty `cf-ray`, unless the body is syntactically valid JSON. HTML branding is not required; `cf-ray` alone is not enough. Other responses retain their existing mapping, including JSON 401/403 authentication errors. Edge-block errors expose `HTTPStatus` but no body or ray ID. Check network access or contact support; Verify does not retry blocked requests.

`Error.HTTPStatus` exposes the HTTP status when a server response caused the error (zero for local failures), and `Error.Reason` is an optional `RefusalReason` drawn only from known service refusal codes. Constants such as `ReasonComputerAtCapacity`, `ReasonComputerCannotHostPlatform`, and `ReasonWebRuntimeUnavailable` let callers distinguish capacity, compatibility, and runtime refusals without parsing messages. Unknown server content is never copied into `Reason`. Existing non-hosted codes remain unchanged, including `ErrAPI` for a web 409, `ErrComputerLimit` for computer admission limits, and `ErrNotAvailableOnPlatform` for computer runtime unavailability.

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
