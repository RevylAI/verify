# Verify for Go

Open a Revyl cloud browser or mobile device for instruction and validation steps, or a Mac computer for commands and files. This Go SDK uses the standard library plus `gopkg.in/yaml.v3`, which reads `.revyl/config.yaml` for session profiles. It is not a test runner. It does not provide `test`, `describe`, or `expect`.

## Install

Use Go 1.26.9 or later and a Revyl account. Set `REVYL_API_KEY` through your shell or CI secret manager, or use a login saved in `~/.revyl/credentials.json`: run `npx @revyl/verify login` or `revyl auth login` once, or let the TypeScript or Python SDK sign you in. The Go SDK never opens a browser itself. A usable stored login marked `local_auth_override` takes precedence over the environment key; otherwise the environment key wins.

The module lives in the repository's `go/` subdirectory. Install the tagged release with:

```sh
go get github.com/RevylAI/verify/go@v0.7.0
```

Go releases use independent repository tags such as `go/v0.7.0`; npm versions do not version this module. Commit the resulting `go.mod` and `go.sum` in your app to pin dependencies.

## Set up your coding agent

The `revyl-verify` skill teaches a coding agent (Claude Code, Cursor, Codex, Capy and others) when and how to check a web page, an app or a Mac with Verify, in Go as well as TypeScript. With Node.js 22.18 or later, run this at the repository root. It writes the skill to `.agents/skills/` and `.claude/skills/`, adds a short Verify section to `AGENTS.md` (or to `CLAUDE.md` when the repository has that and no `AGENTS.md`), and changes nothing when run again:

```sh
npx @revyl/verify init --no-config --no-install
```

Without Node.js, copy the skill into the two folders agents read:

```sh
for dir in .agents/skills .claude/skills; do
  mkdir -p "$dir/revyl-verify"
  curl -fsSL https://raw.githubusercontent.com/RevylAI/verify/main/skills/revyl-verify/SKILL.md -o "$dir/revyl-verify/SKILL.md"
done
```

Or install the Verify plugin in your agent; see [Set up your coding agent](https://github.com/RevylAI/verify#set-up-your-coding-agent).

## Quick start: iOS Settings

This program opens the iOS Settings app on a cloud simulator, which every account can run before uploading a build. It starts a real, billable session.

```sh
mkdir verify-go && cd verify-go
go mod init example.com/verify-go
go get github.com/RevylAI/verify/go@v0.7.0
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
	s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"}, verify.OpenOptions{Log: func(line string) { log.Println(line) }})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Close(cleanup)
	}()
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

Run it with `go run .`. It prints `ios: starting ios session <link>` as soon as the session exists, while the simulator is still starting, exits 0 when the validation passes, and saves `about.png`. Use `verify.Android` with `BundleID: "com.android.settings"` for Android, or `AppID` for your own uploaded app.

## Core API

Inside a function returning `error`, with `verify "github.com/RevylAI/verify/go"`, `context`, `log`, and `time` imported:

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
total, err := s.Extract(ctx, "the cart total")
if err != nil {
	return err
}
log.Println("Total:", total.Value)
_, err = s.Screenshot(ctx, "artifacts/cart.png")
return err
```

This sketch ignores cleanup errors for brevity; the complete example below reports them. Go has no automatic process-exit cleanup: explicitly close every successful session, including on error. Use a fresh, bounded cleanup context so canceling the work context does not prevent cleanup. `Close` is idempotent. An abrupt process termination cannot run deferred functions.

`Extract(ctx, text)` reads one value off the screen and returns it in `StepResult.Value`. Describe one value that is visible now, such as `"the order number"`. On web, iOS and Android it runs on Revyl's agent, like `Instruction` and `Validation`; on a Mac computer it runs on the Mac's own model and needs a Mac opened with inference (see [Validation and Extract on a Mac](#validation-and-extract-on-a-mac)). When nothing is read, it returns `ErrStepFailed` with the reason: describe a value that is on the screen now. A session opened with `WithModel`, `WithCustomModel` or `WithAgent` returns `ErrInvalidArgument`, because `Extract` runs on Revyl's agent: read the value from `Screenshot` with your model instead. `ExtractOptions{Timeout: time.Minute}` overrides the step timeout.

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
- **iOS and Android:** set `Platform` to `verify.IOS` or `verify.Android` and exactly one of `AppID`, `BuildID`, `ArtifactURL` (HTTPS), or `BundleID` (an app already installed). `DeviceModel` and `OSVersion` are optional and written as Revyl names them, such as `DeviceModel: "iPhone 16", OSVersion: "iOS 18.5"` or `DeviceModel: "Pixel 7", OSVersion: "Android 14"`. A value Revyl doesn't offer returns `ErrInvalidArgument` listing the values it accepts, and no session starts. An `AppID` or `BuildID` Revyl can't find returns `ErrInvalidArgument` naming what wasn't found and how to fix it, and no session starts. A `BundleID` that can't be launched returns `ErrSessionStartFailed` naming the bundle ID, with the session link. `URL`, `Branch`, `Viewport`, and `SignIn` are web-only.
- **Mac computers:** `Target{Platform: verify.Mac}` creates a workspace; only `StartTimeout`, `Timeout` and `Inference` are accepted alongside the platform. `Inference: new(true)` runs it on a Mac whose own vision model is loaded, so `Validation` and `Extract` work on it; see [Validation and Extract on a Mac](#validation-and-extract-on-a-mac). Mac computers are available to organizations on a current paid Revyl plan. When Revyl says Pro would unlock Macs for a Free-plan organization (`computer_not_enabled` with `unlocks_with_card: true`), `Open` and `OpenPersistent` return `ErrNotAvailableOnPlatform` with `Reason` `ReasonUpgradeRequired`, and the message gives Revyl's upgrade offer and its HTTPS billing link, or says to add a card in Revyl's billing settings when Revyl sends no offer. A 429 `ErrComputerLimit` means queued work or a concurrency limit; Verify does not guess which cause applies or retry creation. See [computer availability](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors).
- `Target.StartTimeout` bounds startup (default 10 minutes); on web/mobile, `IdleTimeoutSeconds` sets the session's idle timeout (default 600 seconds). All methods also honor the caller's context.
- `Open` takes at most one `OpenOptions` value, plus `WithModel`, `WithCustomModel` or `WithAgent` to run steps on your own model; `Instruction` and `Validation` take the same options for one step. `OpenOptions{StepTimeout: 3*time.Minute}` changes the default step timeout. Per-call `StepOptions{Timeout: time.Minute}`, `ValidationOptions{Timeout: time.Minute, Soft: true}` and `ExtractOptions{Timeout: time.Minute}` override it. Run one step at a time per session, on computers too.
- `OpenOptions{Profile: "signed-in"}` runs a session profile from your project's `.revyl/config.yaml` before `Open` returns; `Profile: "none"` runs no profile. Left empty, the project's `session.default_profile` runs when it sets one. Web, iOS, Android and Mac computers. See [Session profiles](#session-profiles).
- `OpenOptions.SessionProfileProjectID`: a Revyl project UUID to read the named session profile from Git instead of your checkout. Requires `Profile` to name a session profile, not `"none"`. Verify reads no local `.revyl/config.yaml` and sends no local script or Git branch. An empty project ID keeps checkout behavior.
- Redirects are rejected, not followed with credentials.
- `OpenOptions{Log: func(line string) { ... }}` opts into progress lines: `<platform>: starting <platform> session <link>` as soon as the session ID exists, before the browser or device is ready, then `ready`, on web, iOS, Android and hosted sessions; computer lifecycle; evidence-gap messages; mobile best-effort first-screen debug notes; and the turns of steps run on your own model. The default is quiet for all targets, so pass `Log: func(line string) { log.Println(line) }` to see the session link while a slow start runs. Keep that callback concurrency-safe if operations run concurrently. A confirmed execution result remains usable when its report evidence is pending or failed; the callback identifies that gap without logging private output or recording URLs.

Requests have bounded deadlines even when passed `context.Background()`: ordinary HTTP requests use 30 seconds, device session creation up to 2 minutes, and accepted-step cancellation up to 5 seconds on a fresh context. Ordinary responses are limited to 16 MiB; computer screenshots allow up to 128 MiB of decoded image data. Safe reads and idempotent device build-registration/stop requests retry at most twice on transient failures; session creation, launch, and step/operation submission are never replayed. Caller cancellation remains detectable with `errors.Is(err, context.Canceled)` or `context.DeadlineExceeded`, alongside `verify.ErrTimeout` for device operations; interrupted computer mutation observation returns `verify.ErrActionUncertain`.

The Go SDK does not read `verify.config.ts`, resolve named targets, or provide an init CLI. Every step runs on the live session; there is no cached replay. `Instruction` on a computer returns `ErrNotAvailableOnPlatform` locally, and its message names `Tap(ctx, verify.Element("the Save button"))` and `Type(ctx, verify.Element("the search field"), text)`. `Validation` and `Extract` work on a Mac opened with `Inference: new(true)`, and return `ErrNotAvailableOnPlatform` locally on a Linux computer. Computer-only methods on web/mobile return `ErrNotAvailableOnPlatform` locally too.

## Session profiles

A session profile is a script from your Revyl project that prepares a session before your first step: it signs a user in, seeds data, or sets launch values. Revyl runs the script, never Verify: on Revyl's hosted runner for a browser or an iOS or Android device, and on the Mac itself for a Mac computer. `Open` returns once Revyl reports that the profile succeeded.

```go
// Run the "signed-in" profile from session.profiles in .revyl/config.yaml
s, err := verify.Open(ctx, verify.Target{Platform: verify.Web, AppID: "…", BuildID: "…"}, verify.OpenOptions{Profile: "signed-in"})

// Start without any profile, not even the project's default
bare, err := verify.Open(ctx, verify.Target{Platform: verify.Web, AppID: "…", BuildID: "…"}, verify.OpenOptions{Profile: "none"})
```

| `Profile` | What Verify sends |
| --- | --- |
| `"signed-in"` | That profile, with the project and the script from this checkout. |
| `""` (left out) | The checkout's `session.default_profile` when set. On web, iOS and Android, a capable backend skips it if the project doesn't target the launched app. Otherwise nothing is sent. |
| `"none"` | No profile, not even the default: Verify sends no profile fields, so the start request is the same as before profiles existed. Needs no `.revyl/config.yaml`. |

Profiles work on web, iOS, Android and Mac computers. On a Linux computer, a profile name returns `ErrNotAvailableOnPlatform` before anything is sent, and no default runs; `"none"` is accepted without a project option. Hosted sessions (`computer.Open`), `Attach` and `CurrentComputer` never run a profile: `computer.Open` takes no options, and `Attach` and `CurrentComputer` return `ErrInvalidArgument` when `Profile` or `SessionProfileProjectID` is set.

For an implicit checkout default on web, iOS or Android, Verify reads `GET /api/v1/backend-capabilities?contract=session_profile_starts`. If `capabilities` includes `device_session_session_profile_picks`, it sends `instruction: "default"` with the default's name and the same checkout files and source. Revyl runs it when the project targets the launched app, or when no registered app launches; otherwise the session starts without a profile. A missing capability or a failed read keeps today's `instruction: "named"` request. Explicit profiles and Mac computer defaults always use `named` and make no capability request.

### Without a checkout

Pass `SessionProfileProjectID` with a named `Profile` to use the project's session profile from Git, without any local `.revyl/config.yaml`:

```go
s, err := verify.Open(ctx, verify.Target{Platform: verify.Mac}, verify.OpenOptions{
	Profile: "signed-in",
	SessionProfileProjectID: "0b9e6f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
})
```

Verify sends `session_profile` with `instruction: "named"` and the profile name, and `session_profile_source` with only `project_id`. It sends no `session_profile_files` or `git_branch_name`; Revyl reads the project's default branch in Git. A local config, even if present, is ignored. An invalid nonempty project UUID or an empty or `"none"` profile returns `ErrInvalidArgument` before any request. Refusals, repository retries and waiting for the profile follow the same rules as checkout starts; an explicit profile is never silently skipped on an older backend.

### Where Verify reads the profile

Without `SessionProfileProjectID`, Verify reads `.revyl/config.yaml` in the working directory (`os.Getwd()`) or the nearest folder above it that has one: the file `revyl init` writes in your app's checkout. In `go test`, the working directory is the package's folder, so the file is found when it sits in that folder or above it. Verify needs `project.id` and the profile under `session.profiles`, and reads nothing else from the file:

```yaml
project:
  id: 0b9e6f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b    # your Revyl project's id
session:
  default_profile: signed-in                  # optional: runs when you leave Profile empty
  profiles:
    signed-in:
      script: scripts/sign-in.sh              # has a "/": a file path from the project folder, the one holding .revyl/
      requires_repository_checkout: true      # optional: Revyl clones the repository before the script runs
    seeded-cart:
      script: seed-cart                       # no "/": .revyl/scripts/seed-cart.js, .py, .sh or .ts, else the Library Script named seed-cart
```

With the profile's name, Verify sends:

- **The project:** `project.id`, and the checkout's Git branch, found the way the Revyl CLI finds it: the branch checked out in the project folder; on GitHub Actions or Buildkite, the branch CI built, including a pull request's own branch (`owner:branch` for a fork) when the checkout is that pull request's code, even on a detached HEAD. Verify leaves the branch out when it finds none or Git fails. Revyl reads the files it needs from Git at the head of that branch. When Git doesn't have the branch, Revyl reads the default branch, and Verify logs `Git has no branch "<branch>", so session profile <name> reads the repository's default branch instead`.
- **The script from this checkout:** the profile's definition and its script file as they are on disk, uncommitted changes included, so you can edit a script and run it without committing. A path script must stay inside the repository (under the nearest folder that holds `.git`, or the project folder outside Git) and be executable (`chmod +x`, with a `#!` line). A script file must be UTF-8 text of at most 64 KiB. A script name with no file in `.revyl/scripts` is a Library Script, which Revyl reads from your organization.

On a browser or device, the script runs on Revyl's hosted runner, not on your machine: it doesn't see your localhost, your files or your Revyl login. On a Mac computer, it runs on that Mac. The script's environment variables and the output files it writes are Revyl's contract: see [Session profiles](https://docs.revyl.com/devices/session-profiles) in the Revyl docs.

### Waiting

`Open` returns when the session is ready and Revyl reports the profile's status as `succeeded`, within the target's `StartTimeout` (10 minutes by default) and the caller's context. While it waits, it logs `<platform>: waiting for session profile <name>` through `OpenOptions.Log`. Verify never shows the script's output: Revyl doesn't send it, because setup scripts often print secrets. On a Mac computer, Revyl refuses commands and screen actions with HTTP 409 `session_profile_running` while the profile runs, without running them. If a call on a computer, such as one you `Attach` to, still gets that refusal, Verify waits and sends the same call again, for up to the start timeout (10 minutes for `Attach` and `CurrentComputer`), then returns `ErrTimeout` naming the profile. It repeats only calls Revyl refused that way.

### Session profile errors

Neither errors nor logs contain the script's content or output. Check the code with `errors.Is(err, verify.ErrSessionProfileFailed)` and read the details with `errors.As(err, &sdkError)`. A refusal keeps Revyl's code in `sdkError.Reason`, such as `verify.ReasonProjectNotFound` (`project_not_found`), and Revyl's sentence in the message.

| Error | When | What to do |
| --- | --- | --- |
| `ErrInvalidArgument` | `Profile` isn't a profile name (1-64 lowercase letters, digits or hyphens) or `"none"` | Pass a name from `session.profiles`, or `"none"` |
| `ErrNotAvailableOnPlatform` | A Linux computer, or a session started without reporting its profile, which Verify then stops | Leave out `Profile`, or pass `Profile: "none"` |
| `ErrConfigNotFound` | `Profile` names a profile, but no `.revyl/config.yaml` is in the working directory or above it | Run from your app's checkout, or pass `Profile: "none"` |
| `ErrConfigInvalid` | `.revyl/config.yaml` isn't valid YAML, `project.id` isn't a UUID, or `session.profiles` doesn't define the name (the message lists the ones it does); or Revyl refused with `session_profile_undefined`, `project_not_found` (`project.id` isn't in this API key's organization) or `repository_connection_missing` (connect the repository's GitHub or GitLab app to the project in Revyl) | The message names the file and the fix |
| `ErrSessionProfileFailed` | Verify couldn't send the script (missing, outside the repository, not executable, over 64 KiB or not UTF-8); Revyl couldn't find it (`session_profile_script_unavailable`); or the profile ran and failed. `sdkError.Outcome` says how and `sdkError.FailureReason` says why | Follow the message, as the next table says. Revyl stops a session whose profile failed, so Verify doesn't |
| `ErrAPI` | Revyl couldn't read the repository in 3 attempts (`repository_unavailable`). Verify repeats the same start twice before it gives up | Try again in a few minutes |

| `sdkError.Outcome` | Meaning | Fix |
| --- | --- | --- |
| `script_failed` | The script exited with an error | Run the script yourself from the project folder to see its output |
| `script_timed_out` | The script ran past Revyl's 300-second limit | Make it finish sooner |
| `script_unavailable` | The script isn't in this checkout or in Git, or the Library Script is missing | Commit the script or add it to `.revyl/scripts`, or create the Library Script |
| `output_invalid` | A file the script wrote broke a rule; `FailureReason` names the file and the line | Fix what the script writes there |
| `runner_failed` | Something failed on Revyl's side | Open the session again |

## Which call works where

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `Tap` with a `verify.Point` or a `verify.Element`, `ScreenSize` | Yes | Yes | Yes | Yes |
| `Locate` | Yes | Yes | Yes | No, tap a `verify.Element`, which returns the point it clicked, or read the point off `Screenshot` |
| `Type(ctx, verify.Element("…"), text)`, the way to type | Yes | Yes | Yes | Yes: clicks the field, selects its text unless `Clear` points to `false`, then types |
| `DoubleTap`, `LongPress`, `Swipe`, `Drag` | Yes | Yes | Yes | No |
| `PressKey(ctx, key, KeyOptions{Modifiers})` | Yes: `KeyEnter`, `KeyBackspace`, `KeyTab`, `KeyEscape`, arrows and more, with modifiers | `KeyEnter` and `KeyBackspace` only | `KeyEnter` and `KeyBackspace` only | Yes: the Web keys and modifiers, where `ModifierMeta` is Command |
| `TypeFocused` | Yes, types into the focused field; `ErrActionFailed` (`no_focused_input`) when none has focus | No, use `Type(ctx, verify.Element("…"), text)` | No, use `Type(ctx, verify.Element("…"), text)` | Yes, with `Clear` pointing to `false` |
| `Back` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `GoHome` | No, use `OpenURL` or `Navigate` | Yes, the home screen | Yes, the home screen | No |
| `OpenURL` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `LaunchApp` | No, use `OpenURL` or `Navigate` | Yes | Yes | No |
| `Navigate` | Yes | No, use `OpenURL` | No, use `OpenURL` | No |
| `CDP`, for chromedp, Playwright and Puppeteer | Yes, see [CDP](#cdp-playwright-puppeteer) | No | No | No |
| `Instruction` | Yes | Yes | Yes | No, use `Tap(ctx, verify.Element("the Save button"))` and `Type(ctx, verify.Element("the search field"), text)` |
| `Validation`, `Extract` | Yes | Yes | Yes | Yes, on a Mac opened with `Inference: new(true)`; see [Validation and Extract on a Mac](#validation-and-extract-on-a-mac) |
| Your own model (`WithModel`, `WithCustomModel`, `WithAgent`) | Yes, except `Extract` | Yes, except `Extract` | Yes, except `Extract` | No |
| `Screenshot` | Yes | Yes | Yes | Yes |
| `Exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

Coordinates follow the rule in [Exact actions](#exact-actions). A call a platform doesn't support returns `ErrNotAvailableOnPlatform`, and its message names the alternative.

## Exact actions

**Since Go `v0.3.0`. Early access.** Web, iOS and Android sessions take device actions that need no agent. `DoubleTap`, `LongPress`, `Drag`, `TypeFocused`, `GoHome`, and Web keys and modifiers in `PressKey`, are new in `v0.4.0`. `Tap` (with a point or an `Element`), `ScreenSize`, `TypeFocused` and `PressKey` on a Mac computer's screen are new in `v0.5.0`, and `Type` there in `v0.6.1`; see [Mac screen](#mac-screen). A location is a `verify.Point{X, Y}` in whole, non-negative screenshot pixels from the top-left corner, or a `verify.Element("Login button")` that Revyl's grounding model finds on the current screen.

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
if err != nil {
	return err
}
if _, err := s.LongPress(ctx, point, verify.LongPressOptions{Duration: 800 * time.Millisecond}); err != nil { // 1.5 s by default
	return err
}
if err := s.Drag(ctx, verify.Element("General row"), verify.Element("Search field")); err != nil { // the list follows the finger
	return err
}
if err := s.GoHome(ctx); err != nil { // the home screen, on iOS and Android
	return err
}
```

**Typing: one rule on every platform.** To type, call `s.Type(ctx, verify.Element("Email field"), text)`: it taps the field you describe and types into it, replacing its text unless `TypeOptions.Clear` points to `false`. It works the same on Web, iOS, Android and a Mac computer. `TypeFocused` types wherever focus already is, without tapping, and only on Web and computers; on Web, when no field has focus it returns `ErrActionFailed` with `Reason` `ReasonNoFocusedInput` (`no_focused_input`) and types nothing.

On Web, type into a field, then where the focus moves, and press more keys:

```go
if _, err := s.Type(ctx, verify.Element("Username field"), "standard_user"); err != nil { // taps the field, then types
	return err
}
if err := s.PressKey(ctx, verify.KeyTab); err != nil { // focus moves to the password field
	return err
}
if err := s.TypeFocused(ctx, "secret_sauce"); err != nil { // replaces the focused field's text unless Clear points to false
	return err
}
if err := s.PressKey(ctx, verify.Key("a"), verify.KeyOptions{Modifiers: []verify.KeyModifier{verify.ModifierCtrl}}); err != nil { // a chord
	return err
}
if err := s.PressKey(ctx, verify.KeyEscape); err != nil {
	return err
}
```

| Method | What it does |
| --- | --- |
| `Tap(ctx, at)` | Taps (clicks on Web and Mac computers) and returns the `Point` tapped. On a Mac computer a tap on a `verify.Element` takes several seconds and can click a look-alike, so check the point |
| `DoubleTap(ctx, at)` | Double-taps (double-clicks on Web) and returns the `Point` |
| `LongPress(ctx, at, LongPressOptions{Duration})` | Presses and holds for `Duration`, whole milliseconds from 1 millisecond to 5 seconds (zero means 1.5 seconds), and returns the `Point` |
| `Type(ctx, at, text, TypeOptions{Clear})` | The way to type, on every platform. Taps a text field and types into it, clearing it first unless `Clear` points to `false`, and returns the `Point` tapped. On a Mac computer it clicks the field, selects its text with Command+A unless `Clear` points to `false`, and types |
| `TypeFocused(ctx, text, TypeOptions{Clear})` | Web and Mac computers: types into the field that already has focus, without clicking. Prefer `Type(ctx, verify.Element("…"), text)`. On Web, with no field focused nothing is typed and it returns `ErrActionFailed` with `Reason` `ReasonNoFocusedInput`; on a Mac computer the keys go to whatever has focus, so check the result. On Web it replaces the field's text unless `Clear` points to `false`. On a Mac computer `Clear` must point to `false`: it types where the cursor is, and leaving `Clear` unset returns `ErrInvalidArgument`. To replace text there, select it first with `PressKey(ctx, verify.Key("a"), verify.KeyOptions{Modifiers: []verify.KeyModifier{verify.ModifierMeta}})`. On iOS and Android it returns `ErrNotAvailableOnPlatform` before anything is sent; use `Type(ctx, verify.Element("…"), text)` |
| `Swipe(ctx, direction, SwipeOptions{From})` | Swipes from a location or the screen's center; `SwipeUp` moves the finger up, which scrolls content down |
| `Drag(ctx, from, to)` | Presses at one location, moves to the other and releases, for example to reorder a list, move a slider or select text |
| `PressKey(ctx, key, KeyOptions{Modifiers})` | Presses a key on the focused element. Every platform takes `KeyEnter` and `KeyBackspace`. Web and Mac computers also take `KeyTab`, `KeyEscape`, `KeyDelete`, `KeySpace`, `KeyArrowUp`, `KeyArrowDown`, `KeyArrowLeft`, `KeyArrowRight`, `KeyHome`, `KeyEnd`, `KeyPageUp` and `KeyPageDown`, and `Modifiers`: up to four of `ModifierCtrl`, `ModifierShift`, `ModifierAlt` and `ModifierMeta`, held while the key is pressed. With modifiers a lowercase letter or digit works too, such as `verify.Key("a")`. The shortcut key differs: select all with `ModifierMeta` on a Mac computer, where it is Command and `ModifierAlt` is Option, and with `ModifierCtrl` on Web, where `ModifierMeta` is not the shortcut key. Other keys and any modifiers return `ErrNotAvailableOnPlatform` on iOS and Android |
| `Back(ctx)` | Browser history on Web, the back button on Android; iOS returns `ErrNotAvailableOnPlatform` |
| `GoHome(ctx)` | Goes to the home screen on iOS and Android; Web returns `ErrNotAvailableOnPlatform` |
| `OpenURL(ctx, url)` | Opens a URL or deep link on a device, or loads an http(s) URL in a browser |
| `LaunchApp(ctx, bundleID)` | Launches an installed app on a device |
| `Locate(ctx, description)` | Returns Revyl's best match on the current screen, without acting |
| `ScreenSize(ctx)` | Returns the screenshot's `Size{Width, Height}` in pixels |

A failed action returns `ErrActionFailed`, including when Revyl cannot find an element or nothing at a point can take the action. Actions are sent once and never repeated: one cut off by the context's deadline, or whose outcome Revyl can't confirm, returns `ErrActionUncertain`, so check the session before acting again. If Verify can't reach Revyl, the action returns `ErrAPI` and isn't resent either, so check the session before trying it again. Each request is bounded at 30 seconds even on `context.Background()`.

Exact actions return when Revyl has accepted them, not when the screen has finished changing. After `Swipe`, `Drag`, `GoHome`, `OpenURL` or `LaunchApp`, let the screen settle or check it before you `Locate` or tap coordinates. `Locate` returns Revyl's best match on the current screen and can return a point for an element that is off screen, so bring the element on screen first. A point outside `ScreenSize` is off screen, and an action at it is refused.

**Fast input: `Settle: new(false)`.** On Web, the browser runtime waits after every `Tap`, `DoubleTap`, `LongPress`, `Type`, `TypeFocused`, `Swipe`, `Drag` and `PressKey` until the page stops changing, for up to about 6 seconds. A running game or animation never stops changing, so each call takes the whole wait and the next one queues behind it. Set `Settle` to point to `false` in the call's options (`TapOptions` for `Tap` and `DoubleTap`, `DragOptions` for `Drag`, and `LongPressOptions`, `TypeOptions`, `SwipeOptions` or `KeyOptions` for the rest) for games, animations and rapid input, such as pressing an arrow key every few hundred milliseconds: the call returns as soon as the input is sent, usually within a second. The catch is that it returns before the screen may have changed, so when you need to see the result, take a `Screenshot` or run a `Validation`, and don't rely on the next screenshot showing it. A `verify.Element` is still found before the input; `Settle` skips only the wait after it. iOS, Android and Mac computers don't wait for the screen after these calls, so `Settle` is accepted there and changes nothing. Leaving `Settle` unset, or pointing it to `true`, keeps the wait.

```go
for range 10 {
	if err := s.PressKey(ctx, verify.KeyArrowLeft, verify.KeyOptions{Settle: new(false)}); err != nil { // returns without waiting for the page to settle
		return err
	}
	time.Sleep(300 * time.Millisecond)
}
if _, err := s.Validation(ctx, "The player is at the left edge"); err != nil { // check the result when you need it
	return err
}
```

**Coordinates.** Prefer a description, such as `Tap(ctx, verify.Element("Sign in button"))`: Revyl finds the element on the current screen, and you never handle coordinates. Otherwise a point is `verify.Point{X, Y}` in screenshot pixels on every platform: whole numbers from the top-left corner of the image `Screenshot` returns. So a position you read off a screenshot goes to `Tap`, `Type`, `Swipe` and every other exact action unchanged. `ScreenSize` returns the screenshot's width and height, and `Locate` and the points `Tap`, `DoubleTap`, `LongPress` and `Type` return use the same pixels. A point outside the screenshot is refused with `ErrInvalidArgument` before any action is sent, and the message names the valid range. On iOS, Verify converts the pixels to the screen's points for you. On Web they equal CSS pixels at the default device scale factor of 1, and you still pass screenshot pixels at any other. This holds from TypeScript 0.4.1, Python 0.2.1 and Go v0.3.1; earlier versions took iOS points. On a Mac computer a point is in screenshot pixels too, and a tap on a `verify.Element` returns the point it clicked in the same pixels. Verify refuses a negative point before sending it, and Revyl refuses one past the screen's edge without clicking; both return `ErrInvalidArgument` naming the valid range.

```go
if _, err := s.Screenshot(ctx, ".verify/screen.png"); err != nil { // open it and find the element
	return err
}
if _, err := s.Tap(ctx, verify.Point{X: 660, Y: 1500}); err != nil { // the position as you read it, on every platform
	return err
}
size, err := s.ScreenSize(ctx) // the screenshot's size: X is 0 to size.Width - 1
```

## CDP (Playwright, Puppeteer)

Web only. `s.CDP(ctx)` returns a Chrome DevTools Protocol (CDP) endpoint for the session's cloud browser, so a program can attach chromedp, or a script Playwright or Puppeteer, next to Verify's steps. `Instruction`, `Validation`, `Screenshot` and the exact actions keep working while a client is attached.

```go
endpoint, err := s.CDP(ctx) // connect once, within 60 seconds
if err != nil {
	return err
}
allocCtx, disconnect := remote.NewAllocator(ctx, endpoint.URL, remote.NoModifyURL) // github.com/chromedp/chromedp/remote
defer disconnect()                                                                  // closes the connection only
browserCtx, cancel := chromedp.NewContext(allocCtx)
defer cancel()
targets, err := chromedp.Targets(browserCtx)
if err != nil {
	return err
}
var tab target.ID // github.com/chromedp/cdproto/target
for _, t := range targets {
	if t.Type == "page" { // the session's own tab
		tab = t.TargetID
		break
	}
}
// Attach to that tab, and leave it open when the context ends.
tabCtx, detach := chromedp.NewContext(browserCtx, chromedp.WithTargetID(tab), chromedp.WithDetachOnCancel())
defer detach()
heading, err := chromedp.Run(tabCtx, chromedp.Text(chromedp.CSS(".title")))
_, err = s.Validation(ctx, "A list of products is shown")
```

It returns a `verify.CDPEndpoint` with `URL` and `ExpiresAt` (`time.Time`). [examples/cdp](examples/cdp/main.go) runs the whole program with chromedp v0.24: DOM, a click, console and network events, and a Verify validation while attached. It is its own Go module, so chromedp is not a dependency of Verify: `cd go/examples/cdp && go run .` with `REVYL_WEB_APP_ID` set. Older chromedp versions name the allocator `chromedp.NewRemoteAllocator(ctx, url, chromedp.NoModifyURL)`.

- **The URL is a single-use credential.** It accepts one connection and expires at `ExpiresAt`, 60 seconds after `CDP` returns it. Call `CDP` again for each new connection. Don't log it, store it or pass it on; `fmt` prints the endpoint with the URL as `[redacted]`, but a CDP client's connection errors can include it, so remove it before you log one. Any connection attempt uses the URL up, even one that fails, so call `CDP` again before you retry.
- **One connection at a time.** A second connection to the same session is refused until the first disconnects. Once the allocator's cancel function (`disconnect` above) has returned, the next URL from `CDP` connects.
- **The connection ends with the session.** `Close`, the session's timeout or a failure closes it. After `Close`, `CDP` returns `ErrSessionEnded` without a request, and an earlier URL no longer works.
- **Use the session's page.** In chromedp, attach to its target with `WithTargetID` and `WithDetachOnCancel`, as above, so that cancelling doesn't close the session's tab. In Playwright it is `browser.contexts()[0].pages()[0]`, and `browser.newContext()` is refused, because a session has one browser context. A tab you open with `context.newPage()` becomes the session's active tab: Verify steps, screenshots and the recording follow it until you close it, and then return to the session's tab. While another tab is open, `pages()[0]` may not be the session's tab, so find it by URL. In Puppeteer, connect with `defaultViewport: null` and use `(await browser.pages())[0]` while the session has one tab.
- **Closing the browser only disconnects.** Playwright's and Puppeteer's `browser.close()` disconnect the script, and the session keeps running; call `Close` to end it. In Puppeteer, `browser.disconnect()` is the explicit form.
- **Navigation is http(s) and `about:blank` only.** `file://`, `chrome://`, `data:`, `javascript:` and other schemes are refused with a CDP error.
- **Downloads are off.** Download-behavior commands are accepted, but nothing is downloaded and no download path can be set.
- **The window size is fixed.** Viewport and window-size emulation (chromedp's `EmulateViewport`) and `Browser.close` are refused; the browser keeps the size the session opened with. Set the target's `Viewport` to choose it.
- **Refusals are CDP errors that start with `Revyl:`**, so the program sees why.
- **A reply over 24 MB is dropped** with the CDP error `Revyl: the reply was larger than 24 MB and was dropped`; the connection and the session keep working.
- **Files come from your machine.** Playwright's `setInputFiles()` with files from the script's machine works; file paths on the browser's host are refused.
- Everything else works as with a local Chrome: the DOM, evaluating JavaScript, console and network events, request interception and screenshots.

On iOS, Android and Mac computers `CDP` returns `ErrNotAvailableOnPlatform` before any request; use `Instruction`, `Validation`, `Screenshot` and the exact actions there, or `Exec` and `Screenshot` on a computer. A session that is no longer running returns `ErrSessionEnded`, a view-only session `ErrAuthRejected`, and a Revyl backend without CDP `ErrNotAvailableOnPlatform` saying so. HTTP 503 returns `ErrAPI`, and calling `CDP` again is safe.

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
- To use another SDK or runtime, implement `verify.ModelAdapter`: `Name() string` and `Complete(ctx, ModelRequest) (ModelReply, error)`. The request has the system prompt, the text, the screenshot and the tools; the reply has the chosen tool call, text, token usage and whether it was truncated. `ctx` ends when `ModelTimeout` or the step's timeout runs out; pass it to your SDK's request. When `ModelTimeout` ends it, Verify returns `ErrTimeout` ("<name> did not answer in time. Raise LocalAgent ModelTimeout for slow or local models."), whatever error your adapter returned.
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

Mac computers can host web and iOS. This is a client-side compatibility limit, not a capacity guarantee: the server can refuse any hosted start. Inside a Mac opened with inference, the session's steps run on the Mac's model first; see [iOS and Web sessions inside an inference Mac](#ios-and-web-sessions-inside-an-inference-mac).

Inside a function returning `error`, with a computer ID and existing app/build UUIDs supplied by your caller:

```go
stop := false // not yours, so Close leaves it running
computer, err := verify.Attach(ctx, computerID, verify.OpenOptions{StopOnClose: &stop})
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
if err := browser.Navigate(ctx, "https://www.saucedemo.com"); err != nil {
	return err
}
_, err = browser.Validation(ctx, "The Swag Labs login form is shown")
return err
```

Select an existing HTTPS web build for startup. Leave out `StopOnClose` only for a computer your program owns. `Navigate` can also reach a guest-local HTTP service, but only one already listening there, such as one an earlier step of a `revyl-macos` job started: Verify has no call that starts one, and a process started through `Exec` ends when the command returns. `Navigate(ctx, url)` is web-only and submits `open_url` once, without retries. HTTP and HTTPS URLs of up to 2048 characters are accepted, including localhost; credentials, whitespace, control characters, backslashes, and invalid ports are rejected. On a hosted child, localhost refers to its parent computer; on an ordinary cloud web session, it refers to that web runtime, not your computer or another Revyl computer. A cold development server may need a warm-up request before navigation succeeds. If navigation returns `ACTION_UNCERTAIN`, the request may still commit; re-navigating is the caller's choice. The runtime is responsible for enforcing its navigation network policy. It checks the success envelope and returns only an error, without logging the URL. Hosted sessions reuse `Instruction`, `Validation`, `Extract`, `Screenshot`, and `Close`.

Each hosted start gets a distinct preallocated session ID and is never replayed. Ambiguous startup failures attempt cleanup of that child ID; definite refusals do not. Child startup failure never stops the parent. Parent close prevents new child opens and cancels in-flight startup. It spends at most five seconds total waiting for startup cleanup and closing children, or half the caller's remaining deadline if shorter, then requests parent stop with the remaining budget. Prompt child cleanup finishes before parent stop; slow child cleanup cannot consume the whole stop budget. The server's parent stop also stops its children. Confirmed physical parent release completes cleanup even if a child stop failed; the optional log callback reports that failure without response content. Otherwise cleanup errors remain observable. Child readiness is bounded by both `StartTimeout` and the computer's remaining lifetime; older computer reports without an expiry cannot host sessions. Child worker operations also honor the parent's expiry and close cancellation; cleanup and reports remain available afterward. Explicitly closing a child does not close its parent.

`session.Report(ctx)` returns a JSON object as `map[string]any` for normal, hosted, and computer sessions, including after close. After `Close`, `Report` waits up to 5 seconds for a final `status` (`completed`, `failed`, `cancelled` or `timeout`) and then returns the status Revyl has. Web, iOS and Android sessions usually reach a final status within that wait: a web session usually settles in about 2 seconds, and its recording is saved a few seconds later. If a report still reads `running`, call `Report` again. It reads the device-session endpoint for app sessions and the computer report endpoint for computers; computer identity and state are validated. A session with no known ID returns `ErrNotFound` locally without a request. Reports may contain private session data: do not log or publish them indiscriminately.

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

`Exec` sends an argv array, not a shell string. `ExecOptions.Stdin` is binary input. Nonzero exits return `ErrCommandFailed` with optional decoded `Error.ExecResult`; to inspect a nonzero result without that error, pass `ExecOptions{Check: &check}` where `check := false`. `ReadFile` and `WriteFile` use byte slices. `Stat` returns `FileStat{Kind, Size}`; `Processes` returns session-owned `ComputerProcess{ID, State, ExitCode}` handles, and `Terminate` accepts one of those IDs, not an OS PID. Computer lifetime runs from create: 2 hours by default, or up to 24 hours with `Target{Platform: verify.Mac, Timeout: 8 * time.Hour}` (whole seconds, 1 minute to 24 hours). `s.Extend(ctx, timeout)` keeps a running computer going at least `timeout` from now, up to 24 hours after create; it never shortens the lifetime, so retrying is safe, and hosted sessions see the new deadline. Lifetimes over 2 hours can be refused with `ErrComputerLimit` (`computer_long_limit`, at most 2 such computers per organization at once) or `ErrNotAvailableOnPlatform` (no host can run that long, or the host can't extend). Operation timeouts don't change the lifetime. `ExpiresAt()` exposes the server's deadline (zero for devices or older reports without one); expired computers reject new operations, but cleanup and recording retrieval remain available.

Computer paths must be workspace-relative with no empty, dot, parent, backslash, colon, or control-character components. Limits are 64 argv entries and 16 KiB for argv plus stdin, 64 KiB per file write, and 1 MiB per file read or combined stdout/stderr. `OperationOptions.Timeout` and `ExecOptions.Timeout` are whole-millisecond durations from 1 ms to 5 minutes, defaulting to 30 seconds. Request observation is separately bounded to 310 seconds and honors context cancellation.

**Breaking wire change:** Go `v0.2.0` requires the encoded-only backend, which is already live on revyl.ai. Computer-operation arguments use `argv_b64` (one padded URL-safe base64 UTF-8 string per argument) and file paths use `path_b64`, with no raw `argv` or `path`. Public APIs and decoded limits are unchanged; `stdin` and file `data` retain their existing standard base64 encoding, and process commands are unchanged. Encoding is not encryption, and Verify does not fall back to plaintext or replay the request.

Computer `Screenshot` retries exact structured `screen_unavailable` (HTTP 409/503) and `screen_starting` (HTTP 409) during the fixed 30-second window after active readiness, with 500 ms backoff doubling up to 2 seconds. Context cancellation, close, expiry, and observation limits still apply. The window never resets on another call; exhaustion returns `ErrSessionBusy` with a desktop-not-ready message. Unrelated errors, authentication failures, malformed responses, and transport failures are not retried. Callers do not need a startup sleep, and mutations are never replayed by this behavior.

Operations submit once, then poll the deterministic operation ID after an asynchronous acceptance. Unconfirmed outcomes return `ErrActionUncertain`, never an automatic mutation replay. Closing a computer cancels observation of in-flight operations and submits stop once; it succeeds only when the server confirms physical release in a terminal state. An uncertain release is an error, and repeated `Close` calls return the cached result rather than resubmitting stop. Use a fresh cleanup context with up to 310 seconds, as above; canceled work must not cancel cleanup.

An unclaimed start may fail with `no_host` after 120 seconds from creation. Verify stops readiness polling and attempts bounded cleanup; this does not shorten the default 10-minute startup timeout for already-claimed guests or prove that physical release succeeded.

To get the screen recording, call `Recording(ctx)` after `Close`, on the same session and before your program exits:

```go
if err := s.Close(ctx); err != nil {
	return err
}
recording, err := s.Recording(ctx) // waits until Revyl has saved the video
if err != nil {
	return err
}
```

Revyl saves the video a few seconds after release, so `Recording` asks every 5 seconds until it is saved and returns `*ComputerRecording{URL, Duration, StartedAt}` without downloading the video; `Duration` and `StartedAt` are nullable pointers. It returns `(nil, nil)` only when none was saved within 15 minutes or before `ctx`'s deadline, and `ctx.Err()` when `ctx` is canceled. A check already under way when the 15 minutes run out can take up to 30 seconds more. Since `v0.6.1`; earlier versions returned `(nil, nil)` at once while the video was still uploading. On a computer that is still running it returns `ErrSessionBusy` saying to call `Close` first. `Attach` can't reopen a closed computer, so a later process can't fetch it. Signed recording URLs last up to one hour, are private, and are never logged; call `Recording` again to refresh metadata rather than retaining an expired URL.

## Mac screen

Since `v0.5.0`, a program can click, type and press keys on the computer's screen at points it reads off `Screenshot`. Inside a function returning `error`, with `s` an open Mac computer:

```go
if err := s.WriteFile(ctx, "notes.txt", []byte("Notes\n")); err != nil {
	return err
}
if _, err := s.Exec(ctx, []string{"open", "-a", "TextEdit", "notes.txt"}); err != nil { // Exec runs in the workspace
	return err
}
time.Sleep(3 * time.Second) // let the window open
if _, err := s.Screenshot(ctx, ".verify/mac.png"); err != nil { // open it and find the text
	return err
}
if _, err := s.Type(ctx, verify.Element("the white text area of the TextEdit window"), "First line\nSecond line"); err != nil { // clicks, selects all, types
	return err
}
keep := false
if err := s.TypeFocused(ctx, "\nThird line", verify.TypeOptions{Clear: &keep}); err != nil { // types where the cursor already is
	return err
}
if _, err := s.Tap(ctx, verify.Point{X: 400, Y: 300}); err != nil { // or click a point as you read it
	return err
}
```

On a computer, as everywhere, type with `Type(ctx, verify.Element("description"), text)`: it clicks the field, selects its text with Command+A unless `Clear` points to `false`, and types. `TypeFocused` needs `Clear` pointing to `false`: it types where the cursor is and clears nothing, so to replace text, select it first. `ModifierMeta` is Command and `ModifierAlt` is Option. `ScreenSize` works too. `Tap(ctx, verify.Element("the Help menu in the menu bar"))` clicks a description and returns the `Point` it clicked. It takes several seconds and can click a look-alike, or something else when the target isn't on the screen, so check the point or take a screenshot afterwards, and use a `verify.Point` from a screenshot for anything that's hard to undo. `Locate` and the exact actions other than `Tap`, `Type`, `TypeFocused`, `PressKey` and `ScreenSize` aren't available on computers and return `ErrNotAvailableOnPlatform` before anything is sent. When Revyl answers `screen_starting`, nothing happened, so Verify waits and tries again for up to 30 seconds. A program keeps control of the screen for 120 seconds after its last action, so a teammate can't take control in the Revyl viewer until then; while someone does control it there, actions return `ErrSessionBusy` and nothing happens. A 403 returns `ErrAuthRejected`: the key's owner needs the Member role or above, and CI runner keys can't control the screen yet. Revyl's `screen_input_uncertain` returns `ErrActionUncertain`, so take a screenshot before you act again. [computers.md](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#screen) lists every screen error.

## Validation and Extract on a Mac

Since `v0.7.0`. On a Mac computer opened with `Inference: new(true)`, `Validation` and `Extract` run on the Mac's own vision model, next to the computer. A typical answer takes 1.3 to 3 seconds. Local inference comes with paid Revyl plans. Inside a function returning `error`, with `verify`, `context`, `log` and `time` imported:

```go
mac, err := verify.Open(ctx, verify.Target{Platform: verify.Mac, Inference: new(true)})
if err != nil {
	return err
}
defer func() {
	cleanup, cancel := context.WithTimeout(context.Background(), 310*time.Second)
	defer cancel()
	_ = mac.Close(cleanup)
}()
log.Println("Model:", mac.Inference()) // verify.InferenceReady, InferenceUnavailable or InferenceUnknown
if _, err := mac.Validation(ctx, "The Dock is visible at the bottom of the screen"); err != nil {
	return err
}
date, err := mac.Extract(ctx, "the date at the right end of the menu bar")
if err != nil {
	return err
}
log.Println(date.Value, date.Engine) // Engine is "local": the Mac's model answered
```

- `Validation` returns a `StepResult` with `Passed` and `Engine` `"local"`. A false statement returns `ErrValidationFailed`, unless you pass `ValidationOptions{Soft: true}`, which returns `Passed` false without an error.
- `Extract` returns the string it read in `StepResult.Value`. Describe one value that is visible now, such as `"the date at the right end of the menu bar"`.
- An answer the model can't confirm is never a pass: it returns `ErrStepFailed`. So does an `Extract` that finds nothing, with the model's reason in the message, such as `local_model_found_no_value`. Describe one thing that is visible on the screen now.
- `Instruction` is still not available on computers. It returns `ErrNotAvailableOnPlatform`, and the message points to `Tap(ctx, verify.Element("the Save button"))` and `Type(ctx, verify.Element("the search field"), text)`.
- Run one step at a time per computer: the Mac's model is shared with the app sessions inside it.
- `mac.Inference()` says whether the Mac's model answers: `verify.InferenceReady`, `verify.InferenceUnavailable`, or `verify.InferenceUnknown` when it can't be told yet. Verify refreshes it whenever it reads the computer's report: at `Open`, `Attach` and `OpenPersistent`, and on each `Report(ctx)`. It is `""` on every other session.

| Error | When | What to do |
| --- | --- | --- |
| `ErrNotAvailableOnPlatform`, `Reason` `ReasonInferenceNotEnabled` | `Open` with `Inference: new(true)`, and the organization isn't on a paid Revyl plan (HTTP 403) | Upgrade the organization's plan, or open the Mac without `Inference` |
| `ErrNotAvailableOnPlatform`, `Reason` `ReasonInferenceUnavailable` | No Mac with a model is up right now (HTTP 409). Nothing was started | Try again later, or open the Mac without `Inference` |
| `ErrNotAvailableOnPlatform`, `Reason` `ReasonStepEngineUnavailable` | A step on a Mac opened without inference, or on a Linux computer (returned before anything is sent), or the Mac's model isn't answering | Open a Mac with `Inference: new(true)` (a persistent computer gets it only when it is created; see [Persistent computers and snapshots](#persistent-computers-and-snapshots)). If it was opened with inference, check `Inference()` and try again shortly |
| `ErrInvalidArgument` | `Inference: new(true)` on a Linux target | Open a Mac instead |
| `ErrSessionBusy` (`step_engine_busy`) | The Mac's model was busy with another step for too long | Run one step at a time per computer, and try again in a few seconds |
| `ErrSessionBusy` (`screen_control_held`) | Someone controls the screen in the Revyl viewer | Try again after they release it; control frees itself after 2 minutes without input |
| `ErrStepFailed` | The model wasn't sure, or `Extract` read nothing | Describe one thing that is visible on the screen now |

[examples/macinference](examples/macinference/main.go) runs all of this, and the iOS session below: `cd go && go run ./examples/macinference`, with `IOS_APP_ID` and `IOS_BUILD_ID` set to also open your iOS app inside the Mac. It starts a real, billable Mac computer. The [Mac model checks guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/mac-model-checks.md) has more examples.

### iOS and Web sessions inside an inference Mac

`mac.Open(ctx, target)` with an iOS or Web target, inside a Mac opened with inference, runs that session's steps on the Mac's model first, with Revyl's hosted model as the fallback. This is the default for every iOS and Web session opened inside an inference Mac. To run a session's steps only on the hosted model, pass `Inference: new(false)` in its `Target`. Macs host iOS and Web sessions only, so `Inference: new(true)` on an Android target returns `ErrInvalidArgument`, as does `Inference` on a target passed to `verify.Open` for a browser or device.

```go
app, err := mac.Open(ctx, verify.Target{Platform: verify.IOS, AppID: appID, BuildID: buildID}) // local inference by default
if err != nil {
	return err
}
step, err := app.Validation(ctx, "The app's first screen is showing", verify.ValidationOptions{Soft: true})
if err != nil {
	return err
}
log.Println(step.Passed, step.Engine) // "local" when the Mac's model answered, "hosted" when Revyl's did
```

- **Runs on the Mac's model:** validations, and instructions that are a single plain tap on one thing.
- **Goes to the hosted model:** `Extract`, typing, multi-step instructions such as "scroll down and then tap back", and any local answer that is uncertain or slower than 25 seconds.
- `StepResult.Engine` says who answered each step: `"local"` or `"hosted"`.
- Local verdicts are final: a validation the Mac's model answers is not checked again by the hosted model.
- If the Mac's model isn't answering when the session starts, the start is refused with `ErrNotAvailableOnPlatform` and `Reason` `ReasonComputerLocalInferenceUnavailable`. Try again shortly, or pass `Inference: new(false)` to run the session on the hosted model.

The [apps inside an inference Mac guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/apps-inside-an-inference-mac.md) covers this in more depth.

### Billing

- Steps on a computer have no per-step fee. `Validation` and `Extract` on a Mac computer run only on the Mac's own model, so they carry no inference charge; you pay the Mac's minutes, as for any computer.
- App sessions inside a computer add no device minutes of their own.
- Inside an inference Mac, steps the Mac's model answers carry no inference charge; steps that fall back to Revyl's hosted model are billed as usual.
- Local inference comes with paid Revyl plans.

## Persistent computers and snapshots

Since `v0.6.0`. A persistent computer is a Mac whose disk outlives every stop, so tools you install and files you write are there the next time you open it. macOS only. Persistent computers come with paid Revyl plans: without one, `OpenPersistent` and `SaveSnapshot` return `ErrNotAvailableOnPlatform` with `Reason` `ReasonPersistentComputersNotEnabled`; upgrade the organization's plan to use them. The [persistent computers guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/persistent-computers.md) walks through a full workflow.

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	verify "github.com/RevylAI/verify/go"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() (err error) {
	ctx := context.Background()
	mac, err := verify.OpenPersistent(ctx, "build-cache")
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		err = errors.Join(err, mac.Close(cleanup)) // stops it and keeps the disk
	}()
	if mac.Created {
		if err := mac.WriteFile(ctx, "created-at.txt", []byte(time.Now().Format(time.RFC3339))); err != nil {
			return err
		}
	}
	data, err := mac.ReadFile(ctx, "created-at.txt") // still there on every later run
	if err != nil {
		return err
	}
	fmt.Printf("created by this run: %v, created at: %s\n", mac.Created, data)
	return nil
}
```

- **Open, close, reopen.** `OpenPersistent(ctx, name)` opens the Mac with that name, creating it if needed; `Created` says whether this call created it. A stopped one boots from its disk, and a running one is connected to. It has every method of a Mac from `Open`. Names are 1-64 letters, digits, `.`, `_` or `-`, starting with a letter or digit, and not a UUID; the same name opens the same computer from Go, TypeScript and Python. An ID from `ListPersistent` works too. `Close` stops it and keeps the whole disk; it returns once the disk is saved on its Mac, which can take a few minutes. Go doesn't stop it when your program exits, so always `Close` it.
- **What's kept.** Everything on the disk: files, installed tools, repositories, build products, simulators, app data, system settings, the login keychain and browser profiles. Memory and running processes are not kept: the next open is a cold boot, so start your servers again.
- **Runs.** Each open is a new run with the usual computer lifetime: 2 hours by default, up to 24 hours with `OpenPersistentOptions{Timeout: 8 * time.Hour}`. A run starts saving its disk 3 minutes before it ends, and reaching the end keeps the disk. A running persistent computer bills like any computer. `OpenPersistent` waits up to `StartTimeout` (15 minutes by default) for it to be ready.
- **Snapshots.** `SaveSnapshot(ctx, computer, name)` saves a stopped computer's disk under a name that is unique in your organization. The computer must be stopped: `Close` it first, or `SaveSnapshot` returns `ErrSessionBusy`. It waits until the save is copied off its Mac, about 5 minutes after `Close`, for up to `SaveSnapshotOptions{WaitTimeout}` (15 minutes by default), then returns `ErrTimeout`.
- **Copies.** `OpenPersistent(ctx, newName, verify.OpenPersistentOptions{FromSnapshot: name})` creates a new persistent computer whose disk starts as the snapshot's. `FromSnapshot` is used only when the call creates the computer. A copy gets the same disk, but things tied to the original Mac's hardware identity (Apple Account, iCloud, Safari's saved passwords) don't carry over, and websites may open signed out. Starting on a different Mac than the one holding the save, as most copies do, restores the disk first and can take several minutes.
- **Inference.** `OpenPersistentOptions{Inference: true}` is used only when the call creates the computer, which keeps it for every later start. A copy made with `FromSnapshot` doesn't inherit it, so pass `Inference: true` there too. `WithoutInference: true` is used only when starting a stopped computer created with inference: it starts that one run without the model, for when no Mac with one is up. A Revyl backend that doesn't offer it returns `ErrInvalidArgument` saying so.
- **Saved-disk expiry.** Saves are kept until you delete the computer or snapshot. Some saves have an end: `PersistentComputer.SavedDiskExpiresAt` and `ComputerSnapshot.SavedDiskExpiresAt` show it when Revyl reports one, and are zero otherwise. From then on it can't start, and `OpenPersistent` returns `ErrSessionStartFailed` (`saved_disk_expired` or `snapshot_expired`).
- **Limits.** 10 persistent computers and 100 snapshots per organization, unless Revyl raised them. Past that, `ErrComputerLimit` (`persistent_computer_limit` or `snapshot_limit`): delete one you no longer need, then try again.
- **Cleanup.** `DeletePersistent(ctx, nameOrID)` deletes the computer and its disk for good; a running one stops first, without saving, and its snapshots stay. `DeleteSnapshot(ctx, nameOrID)` deletes a snapshot; computers made from it keep their disks.
- **Lists.** `ListPersistent(ctx)` lists your organization's persistent computers by ID, because Revyl stores no names: compare with the `ID()` of a session `OpenPersistent` returned. `ListSnapshots(ctx)` lists snapshots.
- **Busy or unavailable.** `ErrSessionBusy` (`run_conflict`) means the last run hasn't finished stopping: its disk is kept, so try again in a few minutes. `ErrSessionStartFailed` (`saved_disk_unavailable`) means the Mac holding the save is offline or no Mac can start it right now: the disk is kept, so try again later.

After the program above has closed `build-cache`, inside a function returning `error`:

```go
if _, err := verify.SaveSnapshot(ctx, "build-cache", "build-cache-v1"); err != nil { // waits about 5 minutes after Close
	return err
}
clone, err := verify.OpenPersistent(ctx, "build-cache-copy", verify.OpenPersistentOptions{FromSnapshot: "build-cache-v1"})
if err != nil {
	return err
}
if err := clone.Close(ctx); err != nil { // stops it and keeps its disk
	return err
}
computers, err := verify.ListPersistent(ctx) // IDs, stopped computers included
if err != nil {
	return err
}
log.Println(len(computers), "persistent computers")
if err := verify.DeletePersistent(ctx, "build-cache-copy"); err != nil { // the computer and its disk, for good
	return err
}
return verify.DeleteSnapshot(ctx, "build-cache-v1")
```

## Results and errors

`Instruction`, `Validation` and `Extract` return `StepResult{Type, Text, Passed, Value, Reason, Duration, Engine, Model}`. `Value` is what `Extract` read, on `Extract` steps only. `Engine` is who answered, only when Revyl says: `"local"` for the Mac's own model, `"hosted"` for Revyl's hosted model, and empty on ordinary sessions. `Model` is set only when the step ran on your own model. Failed instructions return `ErrInstructionFailed`; failed validation verdicts return `ErrValidationFailed`; an `Extract` that reads nothing returns `ErrStepFailed`. `Soft: true` returns a false verdict without an error, but a missing verdict, failed execution, or cancellation still returns an error such as `ErrStepFailed`. `Screenshot` returns PNG bytes and optionally writes a path, creating parent directories.

Errors support `errors.Is(err, verify.ErrTimeout)` and `errors.As(err, &sdkError)` where `var sdkError *verify.Error`. Stable codes distinguish invalid arguments/configuration, missing/rejected credentials, startup failure, ended/busy sessions, unavailable operations, action failure/uncertainty, step failure, model failure (`ErrModelError`) and a missing model key (`ErrModelKeyMissing`), and timeout. `Error.Cause` is available through `errors.Unwrap` when present. Do not replay mutations after `ErrActionUncertain`: the action may already have happened. Inspect the session in Revyl instead.

`ErrEdgeBlocked` (`EDGE_BLOCKED`) identifies HTTP 403 with a `text/html` content type and nonempty `cf-ray`, unless the body is syntactically valid JSON. HTML branding is not required; `cf-ray` alone is not enough. Other responses retain their existing mapping, including JSON 401/403 authentication errors. Edge-block errors expose `HTTPStatus` but no body or ray ID. Check network access or contact support; Verify does not retry blocked requests.

`Error.HTTPStatus` exposes the HTTP status when a server response caused the error (zero for local failures), and `Error.Reason` is an optional `RefusalReason` drawn only from known service refusal codes. Constants such as `ReasonComputerAtCapacity`, `ReasonComputerCannotHostPlatform`, `ReasonWebRuntimeUnavailable`, and `ReasonUpgradeRequired` (a Mac computer refused until the organization upgrades to Pro) let callers distinguish capacity, compatibility, and runtime refusals without parsing messages. Unknown server content is never copied into `Reason`. Existing non-hosted codes remain unchanged, including `ErrAPI` for a web 409, `ErrComputerLimit` for computer admission limits, and `ErrNotAvailableOnPlatform` for computer runtime unavailability.

Credentials resolve from `REVYL_API_KEY`, then `~/.revyl/credentials.json`. A usable CLI login marked `local_auth_override` takes precedence over the environment key, matching the TypeScript SDK and Revyl CLI. Expired access tokens fall back to a stored API key. Never put keys, tokens, or private session content in source, fixtures, or logs.

Instruction, validation and extract text is sent to Revyl for processing, on Revyl's hosted model or a Revyl Mac's own model, unless the step runs on your own model. The Go SDK does not log that text locally; do not include credentials or sensitive content in step descriptions.

## Develop

From `go/`:

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test -race ./...
```

The repository's tests use loopback fake servers and shared `testdata/device-contract.json` and `testdata/computer-contract.json` fixtures. They isolate home directories and credentials and never create live sessions. Fake-server coverage verifies the client contract, not production device or computer behavior.
