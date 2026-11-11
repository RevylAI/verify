# Verify for Go

Open a Revyl cloud browser or mobile device for instruction and validation steps, or a Mac computer for commands and files. This is a standard-library-only Go SDK, not a test runner. It does not provide `test`, `describe`, or `expect`.

## Install

Use Go 1.26.9 or later and a Revyl account. Set `REVYL_API_KEY` through your shell or CI secret manager, or use a login saved in `~/.revyl/credentials.json`: run `npx @revyl/verify login` or `revyl auth login` once, or let the TypeScript or Python SDK sign you in. The Go SDK never opens a browser itself. A usable stored login marked `local_auth_override` takes precedence over the environment key; otherwise the environment key wins.

The module lives in the repository's `go/` subdirectory. Install the tagged release with:

```sh
go get github.com/RevylAI/verify/go@v0.3.1
```

Go releases use independent repository tags such as `go/v0.3.1`; npm versions do not version this module. Commit the resulting `go.mod` and `go.sum` in your app to pin dependencies.

## Quick start: iOS Settings

This program opens the iOS Settings app on a cloud simulator, which every account can run before uploading a build. It starts a real, billable session.

```sh
mkdir verify-go && cd verify-go
go mod init example.com/verify-go
go get github.com/RevylAI/verify/go@v0.3.1
```

Save this as `main.go`:

```go
package main

import (
	"context"
	"log"
	"time"

	verify "github.com/RevylAI/verify/go"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	ctx := context.Background()
	s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Close(cleanup)
	}()
	log.Println("Watch:", s.ViewerURL())
	if _, err := s.Instruction(ctx, "Open General, then About"); err != nil {
		return err
	}
	if _, err := s.Validation(ctx, "The screen shows the operating system version"); err != nil {
		return err
	}
	_, err = s.Screenshot(ctx, "about.png")
	return err
}
```

Run it with `go run .`. It prints the session link, exits 0 when the validation passes, and saves `about.png`. Use `verify.Android` with `BundleID: "com.android.settings"` for Android, or `AppID` for your own uploaded app.

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
- **Mac computers:** `Target{Platform: verify.Mac}` creates a workspace; only `StartTimeout` is accepted alongside the platform. Mac computers are early access; ask support@revyl.ai about access. A 429 `ErrComputerLimit` means queued work or a concurrency limit; Verify does not guess which cause applies or retry creation. See [computer availability](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors).
- `Target.StartTimeout` bounds startup (default 10 minutes); on web/mobile, `IdleTimeoutSeconds` sets the session's idle timeout (default 600 seconds). All methods also honor the caller's context.
- `Open` takes at most one `OpenOptions` value, plus `WithModel`, `WithCustomModel` or `WithAgent` to run steps on your own model; `Instruction` and `Validation` take the same options for one step. `OpenOptions{StepTimeout: 3*time.Minute}` changes the default step timeout. Per-call `StepOptions{Timeout: time.Minute}` and `ValidationOptions{Timeout: time.Minute, Soft: true}` override it. Run one step at a time per session.
- Redirects are rejected, not followed with credentials.
- `OpenOptions{Log: func(line string) { ... }}` opts into computer lifecycle, evidence-gap messages, mobile best-effort first-screen debug notes, and the turns of steps run on your own model; the default is quiet for all targets. Keep that callback concurrency-safe if operations run concurrently. A confirmed execution result remains usable when its report evidence is pending or failed; the callback identifies that gap without logging private output or recording URLs.

Requests have bounded deadlines even when passed `context.Background()`: ordinary HTTP requests use 30 seconds, device session creation up to 2 minutes, and accepted-step cancellation up to 5 seconds on a fresh context. Ordinary responses are limited to 16 MiB; computer screenshots allow up to 128 MiB of decoded image data. Safe reads and idempotent device build-registration/stop requests retry at most twice on transient failures; session creation, launch, and step/operation submission are never replayed. Caller cancellation remains detectable with `errors.Is(err, context.Canceled)` or `context.DeadlineExceeded`, alongside `verify.ErrTimeout` for device operations; interrupted computer mutation observation returns `verify.ErrActionUncertain`.

The Go SDK does not read `verify.config.ts`, resolve named targets, or provide an init CLI. Every step runs on the live session; there is no cached replay. Instruction and validation methods on computers return `ErrNotAvailableOnPlatform` locally; computer-only methods on web/mobile do the same.

## Which call works where

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `Tap`, `Type`, `Swipe`, `PressKey`, `Locate`, `ScreenSize` | Yes | Yes | Yes | No, use `Exec` and files |
| `Back` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `OpenURL` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `LaunchApp` | No, use `OpenURL` or `Navigate` | Yes | Yes | No |
| `Navigate` | Yes | No, use `OpenURL` | No, use `OpenURL` | No |
| `Instruction`, `Validation`, your own model | Yes | Yes | Yes | No, use `Exec` |
| `Screenshot` | Yes | Yes | Yes | Yes |
| `Exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

Coordinates follow the rule in [Exact actions](#exact-actions). A call a platform doesn't support returns `ErrNotAvailableOnPlatform`, and its message names the alternative.

## Exact actions

**Since Go `v0.3.0`. Early access.** Web, iOS and Android sessions take device actions that need no agent. A location is a `verify.Point{X, Y}` in whole, non-negative screenshot pixels from the top-left corner, or a `verify.Element("Login button")` that Revyl's grounding model finds on the current screen.

```go
if _, err := s.Tap(ctx, verify.Element("General")); err != nil {
	return err
}
if _, err := s.Type(ctx, verify.Element("Search field"), "Bluetooth"); err != nil {
	return err
}
if err := s.Swipe(ctx, verify.SwipeUp); err != nil {
	return err
}
point, err := s.Locate(ctx, "Wi-Fi row")
```

| Method | What it does |
| --- | --- |
| `Tap(ctx, at)` | Taps and returns the `Point` tapped |
| `Type(ctx, at, text, TypeOptions{Clear})` | Taps a text field and types into it, clearing it first unless `Clear` points to `false` |
| `Swipe(ctx, direction, SwipeOptions{From})` | Swipes from a location or the screen's center; `SwipeUp` moves the finger up, which scrolls content down |
| `PressKey(ctx, verify.KeyEnter)` | Presses `KeyEnter` or `KeyBackspace` on the focused field |
| `Back(ctx)` | Browser history on Web, the back button on Android; iOS returns `ErrNotAvailableOnPlatform` |
| `OpenURL(ctx, url)` | Opens a URL or deep link on a device, or loads an http(s) URL in a browser |
| `LaunchApp(ctx, bundleID)` | Launches an installed app on a device |
| `Locate(ctx, description)` | Returns Revyl's best match on the current screen, without acting |
| `ScreenSize(ctx)` | Returns the screenshot's `Size{Width, Height}` in pixels |

A failed action returns `ErrActionFailed`, including when Revyl cannot find an element or nothing at a point can take the action. Actions are sent once and never repeated: one cut off by the context's deadline, or whose outcome Revyl can't confirm, returns `ErrActionUncertain`, so check the session before acting again. If Verify can't reach Revyl, the action returns `ErrAPI` and isn't resent either, so check the session before trying it again. Each request is bounded at 30 seconds even on `context.Background()`.

Exact actions return when Revyl has accepted them, not when the screen has finished changing. After `Swipe`, `OpenURL` or `LaunchApp`, let the screen settle or check it before you `Locate` or tap coordinates. `Locate` returns Revyl's best match on the current screen and can return a point for an element that is off screen, so bring the element on screen first. A point outside `ScreenSize` is off screen, and an action at it is refused.

**Coordinates.** Prefer a description, such as `Tap(ctx, verify.Element("Sign in button"))`: Revyl finds the element on the current screen, and you never handle coordinates. Otherwise a point is `verify.Point{X, Y}` in screenshot pixels on every platform: whole numbers from the top-left corner of the image `Screenshot` returns. So a position you read off a screenshot goes to `Tap`, `Type` and `Swipe` unchanged. `ScreenSize` returns the screenshot's width and height, and `Locate` and the points `Tap` and `Type` return use the same pixels. A point outside the screenshot is refused with `ErrInvalidArgument` before any action is sent, and the message names the valid range. On iOS, Verify converts the pixels to the screen's points for you. On Web they equal CSS pixels at the default device scale factor of 1, and you still pass screenshot pixels at any other. This holds from TypeScript 0.4.1, Python 0.2.1 and Go v0.3.1; earlier versions took iOS points.

```go
if _, err := s.Screenshot(ctx, ".verify/screen.png"); err != nil { // open it and find the element
	return err
}
if _, err := s.Tap(ctx, verify.Point{X: 660, Y: 1500}); err != nil { // the position as you read it, on every platform
	return err
}
size, err := s.ScreenSize(ctx) // the screenshot's size: X is 0 to size.Width - 1
```

## Your own model

**Since Go `v0.3.0`. Early access.** `Instruction` and `Validation` normally run on Revyl's agent. Pass a model and the agent loop runs in your process instead, on a model you choose, with your own key. Revyl still provides the browser or device and, by default, finds the elements your model names on screen. Leave the model out and nothing changes.

```go
s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"},
	verify.WithModel("anthropic/claude-sonnet-5-5")) // every step on your model
if err != nil {
	return err
}
step, err := s.Instruction(ctx, "Open General, then About")
if err != nil {
	return err
}
log.Println(step.Model.ID, len(step.Model.Turns), step.Model.InputTokens, step.Model.OutputTokens)
_, err = s.Validation(ctx, "The screen shows the iOS version", verify.WithModel("openai/gpt-5.5")) // or one step
```

`WithModel("provider/model")` reads the provider's key from its usual environment variable. Everything after the first slash is the provider's own model name, so `"openrouter/anthropic/claude-sonnet-5-5"` works.

| Prefix | Key variable | Endpoint |
| --- | --- | --- |
| `anthropic/` | `ANTHROPIC_API_KEY` | Anthropic Messages API |
| `openai/` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `google/` | `GOOGLE_API_KEY`, or `GEMINI_API_KEY` when it is unset | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `openrouter/` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `groq/` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| `cerebras/` | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` |
| `xai/` | `XAI_API_KEY` | `https://api.x.ai/v1` |
| `ollama/` | none | `http://localhost:11434/v1` |

A missing key returns `ErrModelKeyMissing` naming the variable, before `Open` reads your Revyl credentials or makes any request. An unknown prefix returns `ErrInvalidArgument`. A model on a Mac computer returns `ErrNotAvailableOnPlatform`. Verify doesn't check a key's prefix or shape. The model must accept images and support tool calls.

For any other server that speaks OpenAI's chat completions with tools and image input (vLLM, LiteLLM, LM Studio, a gateway), pass `WithCustomModel`:

```go
verify.WithCustomModel(verify.CustomModel{
	ID:       "qwen-3.8-27b",                      // the model name the server expects
	BaseURL:  "https://my-gateway.example/v1",     // the root that serves /chat/completions
	APIKey:   os.Getenv("MY_GATEWAY_KEY"),         // optional, sent as a bearer token
	Headers:  map[string]string{"x-team": "mobile"}, // optional
	Provider: "qwen",                              // optional, reported as "qwen/qwen-3.8-27b"
})
```

The key comes only from `APIKey`: Verify never reads an environment variable for a custom endpoint, so a key meant for one provider can't reach another server.

By default your model names the element it wants ("General row") and Revyl's grounding model finds it (`GroundingRevyl`), so a small, fast vision model is usually enough. `GroundingModel` has the model give screenshot coordinates instead; it keeps element descriptions away from Revyl but needs a model that points accurately.

**What goes where.** Your model sees the system prompt, the step text, a short log of the actions it took so far and whether they worked, and the current screenshot, downscaled so its longest side is at most 1280 pixels. Revyl receives each device action, the element descriptions your model writes (not with `GroundingModel`), and the model's name for the session report. Revyl does not receive the step text, the prompts, your model's output or your key. Keys go only to the provider's endpoint and are replaced with `[redacted]` in error messages, as are custom header values.

**Results and limits.** `StepResult.Model` is a `*ModelRun{ID, Grounding, Turns, InputTokens, OutputTokens}`, with each turn's action, `OK`, model and action durations and tokens. Input tokens include cached input. With `OpenOptions.Log` set, each turn logs its action, which includes up to 40 characters of typed text, and the step logs its turns and tokens, not the step text. An instruction stops after 20 turns, and a validation after 3 attempts without a verdict (`ErrStepFailed`). The step's timeout bounds the whole step and reaches every device request; a mutating action cut off by it returns `ErrActionUncertain` and is never repeated. One model call has 60 seconds, retries included, and is retried twice on 408, 409, 429 and 5xx, honoring `Retry-After` up to 10 seconds. Output is capped at 4096 tokens on Anthropic, OpenAI and Google and 2048 elsewhere; a reply cut off at the cap returns `ErrModelError` and a tool call in it is never run. Three turns in a row without a tool call return `ErrModelError`. Provider failures return `ErrModelError` with the provider's reason and the next step: a 401 or 403 names the host and the variables the key and address came from, a 404 names the path Verify added, and text-only or tool-less models are named as such.

### Behind a proxy or gateway

Two ways work:

1. Keep `WithModel` and point the provider's base-URL variable at the proxy, the same variables Anthropic's and OpenAI's SDKs read:

   ```sh
   export ANTHROPIC_BASE_URL=https://llm-proxy.example.com/anthropic   # with or without a trailing /v1
   export ANTHROPIC_API_KEY=<the proxy's key>
   # or OPENAI_BASE_URL=https://llm-proxy.example.com/openai/v1 with OPENAI_API_KEY
   ```

2. Or name the proxy in code, when it speaks OpenAI's chat completions: `verify.WithCustomModel(verify.CustomModel{ID: "claude-sonnet-5-5", BaseURL: "https://llm-proxy.example.com/v1", APIKey: os.Getenv("PROXY_KEY")})`.

A base address works with or without a trailing `/v1`. For Anthropic, Verify calls `<base>/v1/messages`, or `<base>/messages` when the base already ends in a version such as `/v1`. For OpenAI-compatible addresses, Verify adds `/v1` only to a bare host, so `https://gw.example.com` and `https://gw.example.com/v1` both call `https://gw.example.com/v1/chat/completions`, and a path such as `/openai/v1` is used as given. If the proxy rejects the key, the error names the host and the variable the key and address came from, never the key. If it answers 404, the error names the path Verify added to the base address.

### Custom agents

For control beyond a model name, configure a `LocalAgent` and pass it with `WithAgent` on `Open` or one step. `WithModel` and `WithCustomModel` build exactly this agent. Passing both a model and an agent returns `ErrInvalidArgument`.

```go
model, err := verify.OpenAICompatible(verify.OpenAICompatibleOptions{BaseURL: "http://localhost:11434/v1", Model: "qwen3-vl:8b"})
if err != nil {
	return err
}
s, err := verify.Open(ctx, target, verify.WithAgent(verify.LocalAgent{
	Model:        model,
	Grounding:    verify.GroundingModel, // default GroundingRevyl
	MaxTurns:     10,                    // default 20, at most 100
	ModelTimeout: 2 * time.Minute,       // default 1 minute
}))
```

- `verify.Anthropic(AnthropicOptions{Model, APIKey, BaseURL, MaxTokens, MaxRetries})` uses `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` for what you leave empty. `verify.OpenAICompatible(OpenAICompatibleOptions{Model, BaseURL, APIKey, Headers, Provider, MaxTokens, MaxRetries})` uses `OPENAI_BASE_URL` and `OPENAI_API_KEY` only when `BaseURL` is empty, and then sends OpenAI's `max_completion_tokens`. Both return `ErrModelKeyMissing` or `ErrInvalidArgument` when they can't be built.
- To use another SDK or runtime, implement `verify.ModelAdapter`: `Name() string` and `Complete(ctx, ModelRequest) (ModelReply, error)`. The request has the system prompt, the text, the screenshot and the tools; the reply has the chosen tool call, text, token usage and whether it was truncated.
- `MaxImageSide` (default 1280, from 256 to 4096) sets the longest screenshot side sent to the model.

[examples/byomodel](examples/byomodel/main.go) runs both forms on iOS Settings and adds exact actions: `cd go && go run ./examples/byomodel` with `REVYL_API_KEY` and `ANTHROPIC_API_KEY` set (or `MODEL=cerebras/qwen-3.8-27b` with `CEREBRAS_API_KEY`). [examples/customagent](examples/customagent/main.go) runs a custom agent on Ollama. Both start real, billable sessions.

## Attach and hosted app sessions

The `Attach`, hosted `Open`, `Navigate`, `Report`, and `CurrentComputer` APIs are included in Go `v0.2.0`. The release also uses the encoded computer-operation wire format required by the production backend.

## Inside a revyl-macos GitHub Actions job

`verify.CurrentComputer(ctx, options...)` attaches to `REVYL_COMPUTER_ID` using normal credential resolution, non-owning by default. It never creates a computer and returns `ErrComputerIDMissing` when the ID is unset or blank. Invalid IDs return `ErrInvalidArgument`. The job's owner releases the computer; closing the attachment only cleans up hosted children.

Use Go `v0.2.0` or later and a runner configured to inject `REVYL_COMPUTER_ID` and a short-lived `REVYL_API_KEY`. A workflow can supply its own key instead. With the Go toolchain and project module dependencies installed, add this step to a job with `runs-on: revyl-macos`:

```yaml
- name: Run Verify
  run: |
    cat > "$RUNNER_TEMP/verify_current.go" <<'GO'
    package main
    import (
        "context"
        "log"
        verify "github.com/RevylAI/verify/go"
    )
    func main() {
        if err := run(); err != nil { log.Fatal(err) }
    }
    func run() (err error) {
        computer, err := verify.CurrentComputer(context.Background())
        if err != nil { return err }
        defer func() {
            if closeErr := computer.Close(context.Background()); err == nil {
                err = closeErr
            }
        }()
        _, err = computer.Screenshot(context.Background(), "computer.png")
        return err
    }
    GO
    go run "$RUNNER_TEMP/verify_current.go"
```

The helper accepts explicit `BackendURL` and `AppURL` through `OpenOptions` and never reads URL environment variables. Set `own := true` and `StopOnClose: &own` only to take ownership deliberately: closing it can end the job's computer. `nil` defaults to non-owning for `CurrentComputer`; it still defaults to owning for `Attach`. Use `computer.Open(ctx, target)` with an exact app/build pair for hosted app sessions.

### Attach to a specified computer

`verify.Attach(ctx, computerID, options...)` connects to an existing active computer using the same credentials and `OpenOptions` as `verify.Open`. It reads the computer report, verifies the ID, OS, state, and future expiry, and returns a normal `*Session`. Failed attachment never creates or stops a computer. Successful attachment takes cleanup ownership by default: explicitly close it, even if another process created it. Do not let two independent owners close the same computer unexpectedly.

To attach without taking ownership, set `stop := false` and pass `verify.OpenOptions{StopOnClose: &stop}` to `Attach`. `nil` and a pointer to `true` preserve owning behavior. For a computer owned by another caller, such as a CI runner, this lets `Close` cancel pending child starts and close children within the existing five-second phase without stopping the computer. Its owner remains responsible for releasing it, and child-cleanup failures are returned. Ownership is never inferred from environment variables. The Go SDK does not register automatic process-exit cleanup.

Call `computer.Open(ctx, target)` to start a web, iOS, or Android app session inside that computer, rather than on an unrelated worker. It reuses the computer's credentials, backend, viewer, HTTP client, step timeout, and log callback. Both `AppID` and `BuildID` must be exact Revyl UUIDs. Hosted targets cannot select `URL`, `Branch`, `ArtifactURL`, `BundleID`, `DeviceModel`, or `OSVersion`. Web targets allow `Viewport`, `SignIn`, `IdleTimeoutSeconds`, and `StartTimeout`; native targets allow the two timeouts and always request simulation.

Mac computers can host web and iOS. This is a client-side compatibility limit, not a capacity guarantee: the server can refuse any hosted start. Computers remain early access.

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

## Mac commands and files

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

`Exec` sends an argv array, not a shell string. `ExecOptions.Stdin` is binary input. Nonzero exits return `ErrCommandFailed` with optional decoded `Error.ExecResult`; to inspect a nonzero result without that error, pass `ExecOptions{Check: &check}` where `check := false`. `ReadFile` and `WriteFile` use byte slices. `Stat` returns `FileStat{Kind, Size}`; `Processes` returns session-owned `ComputerProcess{ID, State, ExitCode}` handles, and `Terminate` accepts one of those IDs, not an OS PID. Computer lifetime is fixed by the server from create (two hours today); operation timeouts cannot extend it. `ExpiresAt()` exposes the server's deadline (zero for devices or older reports without one); expired computers reject new operations, but cleanup and recording retrieval remain available.

Computer paths must be workspace-relative with no empty, dot, parent, backslash, colon, or control-character components. Limits are 64 argv entries and 16 KiB for argv plus stdin, 64 KiB per file write, and 1 MiB per file read or combined stdout/stderr. `OperationOptions.Timeout` and `ExecOptions.Timeout` are whole-millisecond durations from 1 ms to 5 minutes, defaulting to 30 seconds. Request observation is separately bounded to 310 seconds and honors context cancellation.

**Breaking wire change:** Go `v0.2.0` requires the encoded-only backend, which is already live on revyl.ai. Computer-operation arguments use `argv_b64` (one padded URL-safe base64 UTF-8 string per argument) and file paths use `path_b64`, with no raw `argv` or `path`. Public APIs and decoded limits are unchanged; `stdin` and file `data` retain their existing standard base64 encoding, and process commands are unchanged. Encoding is not encryption, and Verify does not fall back to plaintext or replay the request.

Computer `Screenshot` retries exact structured `screen_unavailable` (HTTP 409/503) and `screen_starting` (HTTP 409) during the fixed 30-second window after active readiness, with 500 ms backoff doubling up to 2 seconds. Context cancellation, close, expiry, and observation limits still apply. The window never resets on another call; exhaustion returns `ErrSessionBusy` with a desktop-not-ready message. Unrelated errors, authentication failures, malformed responses, and transport failures are not retried. Callers do not need a startup sleep, and mutations are never replayed by this behavior.

Operations submit once, then poll the deterministic operation ID after an asynchronous acceptance. Unconfirmed outcomes return `ErrActionUncertain`, never an automatic mutation replay. Closing a computer cancels observation of in-flight operations and submits stop once; it succeeds only when the server confirms physical release in a terminal state. An uncertain release is an error, and repeated `Close` calls return the cached result rather than resubmitting stop. Use a fresh cleanup context with up to 310 seconds, as above; canceled work must not cancel cleanup.

An unclaimed start may fail with `no_host` after 120 seconds from creation. Verify stops readiness polling and attempts bounded cleanup; this does not shorten the default 10-minute startup timeout for already-claimed guests or prove that physical release succeeded.

`Recording(ctx)` works after `Close` and checks the terminal report and confirmed physical release before requesting retained recording metadata. It returns `*ComputerRecording{URL, Duration, StartedAt}` without downloading the video; `Duration` and `StartedAt` are nullable pointers. Recording processing is asynchronous, so a 404 `recording_unavailable` returns `(nil, nil)`; other errors remain typed. Before confirmed terminal release, it returns `ErrSessionBusy`. Signed recording URLs last up to one hour, are private, and are never logged; call `Recording` again to refresh metadata rather than retaining an expired URL.

## Results and errors

`Instruction` and `Validation` return `StepResult{Type, Text, Reason, Passed, Duration, Model}`; `Model` is set only when the step ran on your own model. Failed instructions return `ErrInstructionFailed`; failed validation verdicts return `ErrValidationFailed`. `Soft: true` returns a false verdict without an error, but a missing verdict, failed execution, or cancellation still returns an error such as `ErrStepFailed`. `Screenshot` returns PNG bytes and optionally writes a path, creating parent directories.

Errors support `errors.Is(err, verify.ErrTimeout)` and `errors.As(err, &sdkError)` where `var sdkError *verify.Error`. Stable codes distinguish invalid arguments/configuration, missing/rejected credentials, startup failure, ended/busy sessions, unavailable operations, action failure/uncertainty, step failure, model failure (`ErrModelError`) and a missing model key (`ErrModelKeyMissing`), and timeout. `Error.Cause` is available through `errors.Unwrap` when present. Do not replay mutations after `ErrActionUncertain`: the action may already have happened. Inspect the session in Revyl instead.

`ErrEdgeBlocked` (`EDGE_BLOCKED`) identifies HTTP 403 with a `text/html` content type and nonempty `cf-ray`, unless the body is syntactically valid JSON. HTML branding is not required; `cf-ray` alone is not enough. Other responses retain their existing mapping, including JSON 401/403 authentication errors. Edge-block errors expose `HTTPStatus` but no body or ray ID. Check network access or contact support; Verify does not retry blocked requests.

`Error.HTTPStatus` exposes the HTTP status when a server response caused the error (zero for local failures), and `Error.Reason` is an optional `RefusalReason` drawn only from known service refusal codes. Constants such as `ReasonComputerAtCapacity`, `ReasonComputerCannotHostPlatform`, and `ReasonWebRuntimeUnavailable` let callers distinguish capacity, compatibility, and runtime refusals without parsing messages. Unknown server content is never copied into `Reason`. Existing non-hosted codes remain unchanged, including `ErrAPI` for a web 409, `ErrComputerLimit` for computer admission limits, and `ErrNotAvailableOnPlatform` for computer runtime unavailability.

Credentials resolve from `REVYL_API_KEY`, then `~/.revyl/credentials.json`. A usable CLI login marked `local_auth_override` takes precedence over the environment key, matching the TypeScript SDK and Revyl CLI. Expired access tokens fall back to a stored API key. Never put keys, tokens, or private session content in source, fixtures, or logs.

Instruction and validation text is sent to Revyl for remote processing, unless the step runs on your own model. The Go SDK does not log that text locally; do not include credentials or sensitive content in step descriptions.

## Develop

From `go/`:

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test -race ./...
```

The repository's tests use loopback fake servers and shared `testdata/device-contract.json` and `testdata/computer-contract.json` fixtures. They isolate home directories and credentials and never create live sessions. Fake-server coverage verifies the client contract, not production device or computer behavior.
