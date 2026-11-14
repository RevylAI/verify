# Changelog

## 0.6.2 (unreleased)

- A Mac or Linux computer that starts prints only its start line with the session link, as Web, iOS and Android do: `[verify] mac: starting computer https://app.revyl.ai/sessions/…?kind=computer`. It no longer adds "Mac computers need a current paid Revyl plan, and Linux computers are not generally available. Ask support@revyl.ai about access." That guidance stays on the errors for a computer that doesn't start: a start Revyl refuses (`computer_not_enabled`, or `runtime_unavailable` for Linux), a start that times out, and a release Verify can't confirm.
- `verify init --platform mac` no longer prints the availability note under "Next:" or writes it at the top of `verify/example.mts`.
- Every call sends the same requests as 0.6.1.

## Go 0.5.2 (unreleased)

Published as the `go/v0.5.2` tag.

- A computer that starts sends only its start line with the session link to `OpenOptions.Log`, as in TypeScript 0.6.2: `mac: starting mac computer https://app.revyl.ai/sessions/…?kind=computer`. Refusals, timeouts and an unconfirmed release keep the availability guidance in their errors.
- `verify.Version` and the `User-Agent` report 0.5.2. Every call sends the same requests as v0.5.1.

## Python 0.4.2 (unreleased)

- A computer that starts prints only its start line with the session link, as in TypeScript 0.6.2: `[verify] mac: starting computer https://app.revyl.ai/sessions/…?kind=computer`. Refusals, timeouts and an unconfirmed release keep the availability guidance in their errors.
- Every call sends the same requests as 0.4.1.

## 0.6.1 (2026-11-13)

- An iOS or Android `open()` that Revyl refuses as invalid (HTTP 400 or 422) throws `INVALID_ARGUMENT` with Revyl's explanation instead of a bare `API_ERROR … failed with HTTP 422`. For a device model or OS version Revyl doesn't offer, the message lists the values it accepts, as in `Revyl refused to start the session (HTTP 422): Unsupported ios runtime '18.5'. Available: ['iOS 27.1', …, 'iOS 18.5']. Change the target to a value Revyl accepts and run again.` No session was started. Web and hosted starts keep their safe diagnostic codes and copy no server text.
- `device.osVersion` is the name Revyl uses, such as `'iOS 18.5'` or `'Android 14'`, as before; Verify sends it unchanged. The docs now show it that way, with models Revyl offers (`iPhone 16`, `iPhone Air`, `Pixel 7`).
- `verify init --platform web --url <url>` with a URL other than `https://example.com` writes an example with one validation that passes on any page that loads, instead of example.com's steps.
- Mac computer messages say what Revyl checks: a current paid plan. `init --platform mac` prints that instead of "early access", and computer errors say `Mac computers need a current paid Revyl plan, and Linux computers are not generally available.`
- Every other call sends the same requests as 0.6.0.
- Docs: device selectors Revyl accepts, a mobile exact-actions script that searches Settings for Accessibility, a web exact-actions script that scrolls back up before it locates the cart, `node verify/checkout.mts` in CI, non-owning attach examples that navigate to a public page, Mac availability on paid plans, `init --platform` in the README, your own model's Claude results, and `end-to-end.md` marked as a record of the 0.1.0 and 0.2.0 runs.

## Go 0.5.1 (2026-11-13)

Published as the `go/v0.5.1` tag.

- `ErrValidationFailed` names the step and the reason, as TypeScript does: `Validation failed: "<text>". <reason> See <link>`.
- An iOS or Android `Open` that Revyl refuses as invalid (HTTP 400 or 422) returns `ErrInvalidArgument` with Revyl's explanation, as in TypeScript 0.6.1, including the device models or OS versions it accepts. No session was started.
- The computer availability message says Mac computers need a current paid Revyl plan. Every other call sends the same requests as v0.5.0.

## Python 0.4.1 (2026-11-13)

- `VALIDATION_FAILED` names the step and the reason, as TypeScript does: `Validation failed: "<text>". <reason> See <link>`. `AsyncSession` gets the same message.
- An iOS or Android `open()` that Revyl refuses as invalid (HTTP 400 or 422) raises `INVALID_ARGUMENT` with Revyl's explanation, as in TypeScript 0.6.1, including the device models or OS versions it accepts. No session was started.
- The computer availability message says Mac computers need a current paid Revyl plan. Every other call sends the same requests as 0.4.0.
- Docs: device selectors Revyl accepts, `open_url("https://example.com")` in the exact-actions example, and a non-owning attach example.

## 0.6.0 (2026-11-12)

- Early access: a Mac computer's screen. `tap({ x, y })` clicks a point in screenshot pixels and resolves with it, `screenSize()` returns the screenshot's size, `typeFocused(text, { clear: false })` types where the cursor is, and `pressKey(key, { modifiers })` takes the Web keys and modifiers, where `'meta'` is Command and `'alt'` is Option, as in `pressKey('a', { modifiers: ['meta'] })` to select all.
- `typeFocused` on a computer requires `{ clear: false }` and throws `INVALID_ARGUMENT` without it, naming the fix. It takes up to 16,384 characters, with line breaks and tabs; other control characters are refused before anything is sent. Text over 500 characters goes in pieces, in order, and a failure part way says how many characters were certainly typed and whether the failed piece may have been.
- A point past the screen's edge throws `INVALID_ARGUMENT` naming the valid range, and nothing is clicked; negative and fractional points are refused before anything is sent. There is no extra request per click.
- Screen errors: someone controlling the screen in the Revyl viewer (`screen_control_held`) throws `SESSION_BUSY` and nothing happened; an action Revyl can't confirm (`screen_input_uncertain`, `screen_unavailable`, `screen_input_unavailable`) throws `ACTION_UNCERTAIN`; a 403 throws `AUTH_REJECTED` saying the key's owner needs the Member role or above and CI runner keys can't control the screen yet; a 503 `authentication_unavailable` throws `API_ERROR` and is safe to retry. These are read from the answer's `detail`, so `screen_unavailable` is uncertain as a 409 or a 503. Verify never repeats a screen action, except `screen_starting` (409, nothing happened): it waits as `Retry-After` asks and tries again for up to 30 seconds, then throws `SESSION_BUSY` naming when to try again.
- `tap({ target })` on a Mac computer: Revyl finds the described element on a fresh screenshot, clicks it, and `tap` resolves with the point it clicked. It takes several seconds and can click a look-alike, or something else when the target isn't on the screen, so the docs say to check the point or a screenshot afterwards. `screen_target_not_found` throws `ACTION_FAILED` and `screen_target_unavailable` throws `API_ERROR`, both with nothing clicked; a backend without described clicks (422 `invalid_request`) throws `NOT_AVAILABLE_ON_PLATFORM` saying to pass a point.
- `locate()` and the other exact actions aren't available on computers. They throw `NOT_AVAILABLE_ON_PLATFORM` before anything is sent, naming `tap({ x, y })`, `tap({ target })`, `typeFocused`, `pressKey` and `exec()`.
- Every other call sends the same requests as 0.5.0.
- Error messages on a computer say what happened and what to do next. `screen_control_lost` on a screen action throws `SESSION_BUSY` saying nothing was sent and to try again. `owner_unavailable`, a 5xx or no answer on a screen action throws `ACTION_UNCERTAIN` saying to take a screenshot before repeating it. `invalid_request` on `tap({ x, y })` says nothing was clicked and to pick the point from a new screenshot, and `screen_key_unsupported` says nothing was pressed. Partial typing counts characters as Unicode code points, the same in TypeScript, Python and Go, and a failure in the first piece says nothing was certainly typed. Every other computer refusal adds a next step, and the `screen_starting` message says "1 second" rather than "1 seconds".
- Docs: a Screen section in `computers.md`, the platform table, `api.md`, `errors.md`, `agents.md` and `llms.txt`. The Web docs say `'meta'` is not the shortcut key there; use `'ctrl'`.

## Go 0.5.0 (2026-11-12)

Published as the `go/v0.5.0` tag.

- Early access: a Mac computer's screen, as in TypeScript 0.6.0. `Tap(ctx, verify.Point{X, Y})`, `Tap(ctx, verify.Element("description"))` returning the point it clicked, `ScreenSize(ctx)`, `TypeFocused(ctx, text, TypeOptions{Clear})` with `Clear` pointing to `false`, and `PressKey(ctx, key, KeyOptions{Modifiers})`, where `ModifierMeta` is Command. Leaving `Clear` unset returns `ErrInvalidArgument` naming the fix.
- The same limits, errors and refusals as TypeScript 0.6.0: `ErrSessionBusy` for `screen_control_held`, `ErrActionUncertain` for an action Revyl can't confirm, `ErrAuthRejected` for a 403, `ErrActionFailed` for `screen_target_not_found`, a wait of up to 30 seconds on `screen_starting`, and `ErrNotAvailableOnPlatform` before any request for `Locate` and the other exact actions. Every other call sends the same requests as v0.4.0.
- The same error messages as TypeScript 0.6.0, each with a next step, with partial typing counted in Unicode code points.

## Python 0.4.0 (2026-11-12)

- Early access: a Mac computer's screen, as in TypeScript 0.6.0. `tap(Point(x, y))`, `tap("description")` returning the point it clicked, `screen_size()`, `type_focused(text, clear=False)` and `press_key(key, modifiers=[...])`, where `"meta"` is Command. Leaving `clear` out raises `INVALID_ARGUMENT` naming the fix. `AsyncSession` has the same methods.
- The same limits, errors and refusals as TypeScript 0.6.0, and every other call sends the same requests as 0.3.0.
- The same error messages as TypeScript 0.6.0, each with a next step, with partial typing counted in Unicode code points.

## 0.5.0 (2026-11-12)

- Early access: more exact actions on Web, iOS and Android. `doubleTap(at)` double-taps (double-clicks on Web), `longPress(at, { duration })` presses and holds for `duration` milliseconds (1 to 5000, 1500 by default), and `drag(from, to)` presses at one location, moves to the other and releases. They take a description or screenshot pixels like `tap`, and `doubleTap` and `longPress` resolve with the point.
- Web: `typeFocused(text, { clear })` types into the field that already has focus, without clicking, and replaces its text unless `clear` is `false`, the same default as `type()`. `pressKey` also takes `'tab'`, `'escape'`, `'delete'`, `'space'`, `'arrowup'`, `'arrowdown'`, `'arrowleft'`, `'arrowright'`, `'home'`, `'end'`, `'pageup'` and `'pagedown'`, and `{ modifiers }`: up to four of `'ctrl'`, `'shift'`, `'alt'` and `'meta'`, with which a lowercase letter or digit works too, as in `pressKey('a', { modifiers: ['ctrl'] })`. The `Key` and `KeyModifier` types are exported.
- iOS and Android: `goHome()` goes to the home screen.
- A call the platform lacks throws `NOT_AVAILABLE_ON_PLATFORM` before anything is sent, and the message names what to use: `typeFocused` on iOS and Android (use `type(location, text)`), keys other than `'enter'` and `'backspace'` or any modifiers on iOS and Android, and `goHome` on Web. Computers refuse all of them, like the other exact actions.
- Your own model can choose `double_tap`, `long_press` and `drag` on every platform, `type_focused` and the wider `press_key` on Web, and `go_home` on iOS and Android, with both groundings. The model sees these extra tools in its tool list; the tools it had before send the same requests as 0.4.1.
- Every existing call sends the same requests as 0.4.1. Your own model choosing `open_url` with a deep link on Web gets the `openUrl()` wording.
- Docs: the platform table, `api.md`, the web and mobile guides with a script for the new calls, `agents.md` and `llms.txt`.

## Go 0.4.0 (2026-11-12)

Published as the `go/v0.4.0` tag.

- Early access: more exact actions on Web, iOS and Android, as in TypeScript 0.5.0. `DoubleTap(ctx, at)` and `LongPress(ctx, at, LongPressOptions{Duration})` return the point; `Duration` is whole milliseconds from 1 millisecond to 5 seconds, and zero leaves Revyl's 1.5 seconds. `Drag(ctx, from, to)` presses, moves and releases.
- Web: `TypeFocused(ctx, text, TypeOptions{Clear})` types into the field that already has focus and replaces its text unless `Clear` points to `false`. `PressKey(ctx, key, KeyOptions{Modifiers})` adds `KeyTab`, `KeyEscape`, `KeyDelete`, `KeySpace`, `KeyArrowUp`, `KeyArrowDown`, `KeyArrowLeft`, `KeyArrowRight`, `KeyHome`, `KeyEnd`, `KeyPageUp` and `KeyPageDown`, and modifiers (`ModifierCtrl`, `ModifierShift`, `ModifierAlt`, `ModifierMeta`), with which `Key("a")` and other lowercase letters and digits work too. Existing `PressKey(ctx, key)` calls compile unchanged.
- iOS and Android: `GoHome(ctx)`.
- A call the platform lacks returns `ErrNotAvailableOnPlatform` before anything is sent, naming the alternative. Your own model can choose the new actions with both groundings, so it sees more tools; the tools it had send the same requests as v0.3.1, as does every existing call.
- `ErrInstructionFailed` names the step and the reason, as TypeScript does: `Instruction failed: "<text>". <reason> See <link>`. The uncertain-action message says "The step deadline passed". Your own model choosing `open_url` with a deep link on Web gets the `OpenURL` wording.

## Python 0.3.0 (2026-11-12)

- Early access: more exact actions on Web, iOS and Android, as in TypeScript 0.5.0. `double_tap(at)` and `long_press(at, duration=None)` return the point; `duration` is seconds, 0.001 to 5 in whole milliseconds, 1.5 by default. `drag(start, end)` presses, moves and releases.
- Web: `type_focused(text, clear=True)` types into the field that already has focus and replaces its text unless `clear` is `False`. `press_key(key, modifiers=())` adds `"tab"`, `"escape"`, `"delete"`, `"space"`, the arrows, `"home"`, `"end"`, `"pageup"` and `"pagedown"`, and modifiers (`"ctrl"`, `"shift"`, `"alt"`, `"meta"`), with which a lowercase letter or digit works too. `Key` and `KeyModifier` are exported.
- iOS and Android: `go_home()`. `AsyncSession` has every new method.
- A call the platform lacks raises `NOT_AVAILABLE_ON_PLATFORM` before anything is sent, naming the alternative. Your own model can choose the new actions with both groundings, so it sees more tools; the tools it had send the same requests as 0.2.1, as does every existing call.
- `INSTRUCTION_FAILED` names the step and the reason, as TypeScript does: `Instruction failed: "<text>". <reason> See <link>`, and the progress line for a failed step on your own model ends with the reason. Your own model choosing `open_url` with a deep link on Web gets the `open_url()` wording.

## 0.4.1 (2026-11-12)

- **Breaking for iOS exact actions (early access):** coordinates are now screenshot pixels on every platform. On iOS, `tap`, `type`, `swipe`'s `from`, `locate`, `screenSize` and the points `tap` and `type` return used the screen's points (440 × 956 on an iPhone whose screenshots are 1320 × 2868); they now use the screenshot's pixels, and Verify converts them to points for you. A script that passed iOS points must pass screenshot pixels instead: multiply by the screenshot's width over 0.4.0's `screenSize()` width (3 on that iPhone). Android and Web coordinates are unchanged, because their screenshots already match the screen.
- A point outside the screenshot is refused with `INVALID_ARGUMENT` before any action is sent, and the message names the valid range. The first call in a session that takes or returns a point reads the screen size once (on iOS, plus one screenshot), and later calls reuse it. Before refusing a point, Verify reads the size again, so a rotated device or a resized Web viewport doesn't get a valid point refused. On Android and Web, if the size can't be read, the action is sent as in 0.4.0; on iOS the call fails, because the scale is needed. Calls by description send the same requests as 0.4.0 on Android and Web.
- `locate()` keeps an off-screen match outside `screenSize()` instead of moving it to the edge, so you can tell it is off screen, and an action at it is refused.
- `instruction()` and `validation()` on your own model are unchanged: the model still sees screenshots, and Verify still maps its answers to the device.
- Docs: one coordinate rule in the same words for TypeScript, Python and Go, in the README, `api.md`, the web and mobile guides, `agents.md` and `llms.txt`. Web coordinates are screenshot pixels, which are CSS pixels at the default device scale factor of 1.

## Go 0.3.1 (2026-11-12)

Published as the `go/v0.3.1` tag.

- **Breaking for iOS exact actions (early access):** coordinates are now screenshot pixels on every platform, as in TypeScript 0.4.1. On iOS, `Tap`, `Type`, `Swipe`'s `From`, `Locate`, `ScreenSize` and the points `Tap` and `Type` return used the screen's points; they now use the screenshot's pixels, and Verify converts them to points for you. Android and Web coordinates are unchanged.
- A point outside the screenshot returns `ErrInvalidArgument` before any action is sent, naming the valid range, after Verify reads the size again in case the screen rotated. The screen size is read once per session. On Android and Web a failed size read skips the check and sends the action as before; on iOS it returns the error.
- README: the same coordinate rule as TypeScript and Python.

## Python 0.2.1 (2026-11-12)

- **Breaking for iOS exact actions (early access):** coordinates are now screenshot pixels on every platform, as in TypeScript 0.4.1. On iOS, `tap`, `type`, `swipe`'s `from_`, `locate`, `screen_size` and the points `tap` and `type` return used the screen's points; they now use the screenshot's pixels, and Verify converts them to points for you. Android and Web coordinates are unchanged. `AsyncSession` behaves the same.
- A point outside the screenshot raises `INVALID_ARGUMENT` before any action is sent, naming the valid range, after Verify reads the size again in case the screen rotated. The screen size is read once per session. On Android and Web a failed size read skips the check and sends the action as before; on iOS it raises.
- README: the same coordinate rule as TypeScript and Go.

## 0.4.0 (2026-11-11)

- Early access: run `instruction()` and `validation()` on your own model. `open('ios', { model: 'anthropic/claude-sonnet-5-5' })` runs every step on Claude with the key from `ANTHROPIC_API_KEY`; a step's `{ model }` overrides it. Built-in providers: Anthropic, OpenAI, Google, OpenRouter, Groq, Cerebras, xAI and Ollama, each reading its usual key variable; `anthropic/` and `openai/` also honour `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` for proxies and gateways. `{ id, baseURL, apiKey, headers }` reaches any OpenAI-compatible endpoint, with the key taken only from `apiKey`. Your model names elements and Revyl's grounding model finds them. `StepResult.model` reports turns and tokens. Revyl's agent remains the default.
- Custom agents: `localAgent({ model, grounding, maxTurns, modelTimeout })` with the exported `anthropic()` and `openaiCompatible()` adapters, or your own `ModelAdapter`, passed as `{ agent }`.
- New errors `MODEL_KEY_MISSING` (thrown before any session starts) and `MODEL_ERROR`, whose messages name the next step for a rejected key, an unknown model, a rate limit, or a model without image input or tool calls.
- Early access: exact device actions on Web, iOS and Android: `tap`, `type`, `swipe`, `pressKey`, `back` (Web and Android), `openUrl`, `launchApp` (iOS and Android), `locate` and `screenSize`, by device coordinates or a described target. A call a platform doesn't support throws `NOT_AVAILABLE_ON_PLATFORM` naming the alternative. `swipe` directions are finger motion on every platform, so `'up'` scrolls content down; on Web, Verify sends Revyl the matching page direction.
- Fix healthy sessions failing with `SESSION_ENDED` right after a step was accepted. Revyl can answer the first `step_status` polls with 404 "Live step not found" while it is still listing the step's run; Verify now keeps polling for about 10 seconds. If the step still can't be found, it raises `STEP_FAILED` naming the step and leaves the session open, because the step may still be running. Other 404s still raise `SESSION_ENDED`.
- `npx @revyl/verify init` writes an example that runs on a brand-new account. When you leave the app id empty for iOS or Android, the config targets the device's built-in Settings app by bundle id (`com.apple.Preferences` or `com.android.settings`), and the example opens About and checks the operating system version. It no longer writes a placeholder app id that failed with `CONFIG_INVALID`, and the generated config no longer reads `REVYL_APP_ID`.
- `init` asks iOS first and defaults to it instead of web.
- A Web target needs a Web app id: `init` with web and no `--app-id` writes no files, explains how to create the Web app in the dashboard or with `revyl app create --platform web`, and prints the `init` command to run next.
- `init`'s "Next" list names only commands that can pass: `node verify/example.mts`, and for Mac only once your organization has access.
- `init` writes the example as `verify/example.mts`, so `node verify/example.mts` runs as an ES module whether `package.json` says `"type": "commonjs"` (what `npm init -y` writes on npm 11), `"type": "module"`, or nothing. As `verify/example.ts` it failed with `Cannot use import statement outside a module` in a CommonJS project.
- `init --help` prints init's options instead of `Unknown option '--help'`.
- Add `verify login`, which signs in through the browser, and `verify logout`, which removes `~/.revyl/credentials.json`, so you don't need the Revyl CLI for either. `verify --help` explains that `init`, `login` and the first `open()` sign you in through the browser.
- Sign-in and missing-credential errors point to `npx @revyl/verify login` instead of the separately installed Revyl CLI.
- Classify the hosted refusal `computer_platform_at_capacity` (the computer already runs as many children of that platform as it can, such as a second Web child on a Mac) as `COMPUTER_LIMIT` with that `reason`. Earlier versions report it as `SESSION_BUSY`.
- Map Web runtime target errors on HTTP 409 (`target_not_found`, `stale_target` and similar) to `ACTION_FAILED` instead of `SESSION_BUSY`.
- Docs: a new "Use your own model" guide (`docs/own-model.md` in the package), exact-action sections with runnable scripts in the web and mobile guides, and the `examples/byo-model` project.
- Docs: a computer's lifetime is two hours from create, not 60 minutes; `expiresAt` / `expires_at` is the authoritative deadline.
- Docs: the Web page explains how to create the Web app, starting with the dashboard, and drops the note about Revyl turning Web off. Getting started describes the new `init` and how the Python and Go SDKs sign in. The Go README has a runnable iOS Settings example.
- Docs: Linux computers are no longer offered in the README, the package docs or the examples, and the README drops its Security and Telemetry sections (SECURITY.md is unchanged). `platform: 'linux'` still works; nothing is deprecated.

## Go 0.3.0 (2026-11-11)

Published as the `go/v0.3.0` tag.

- Early access: run `Instruction` and `Validation` on your own model, as in TypeScript 0.4.0. `verify.WithModel("anthropic/claude-sonnet-5-5")` on `Open` or on one step reads the provider's usual key variable. The eight providers, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` with or without `/v1`, and `verify.WithCustomModel(verify.CustomModel{...})` for any OpenAI-compatible endpoint. `StepResult.Model` reports turns and tokens, cached input included.
- Custom agents: `verify.WithAgent(verify.LocalAgent{...})` with `verify.Anthropic` and `verify.OpenAICompatible`, or your own `ModelAdapter`.
- New errors `ErrModelKeyMissing` (returned before any Revyl request) and `ErrModelError`, with the same next-step hints as TypeScript.
- Early access: exact device actions on Web, iOS and Android: `Tap`, `Type`, `Swipe`, `PressKey`, `Back` (Web and Android), `OpenURL`, `LaunchApp` (iOS and Android), `Locate` and `ScreenSize`, by `verify.Point` or `verify.Element("...")`. They take a `context.Context`, and one cut off by its deadline returns `ErrActionUncertain`. `Swipe` directions are finger motion on every platform, so `SwipeUp` scrolls content down; on Web, Verify sends Revyl the matching page direction.
- `Open`, `Instruction` and `Validation` now take option values (`OpenOption`, `StepOption`, `ValidationOption`). Existing `OpenOptions{...}`, `StepOptions{...}` and `ValidationOptions{...}` literals still compile; a call that spread a `[]OpenOptions`, `[]StepOptions` or `[]ValidationOptions` slice with `...` must pass the options one by one.
- Map Web runtime target errors on HTTP 409 (`target_not_found`, `stale_target` and similar) to `ErrActionFailed` instead of `ErrSessionBusy`.
- Same fix as 0.4.0: a `step_status` 404 "Live step not found" right after a step was accepted is retried for about 10 seconds and then returns `ErrStepFailed`, instead of `ErrSessionEnded`. The session stays open.
- Classify the hosted refusal `computer_platform_at_capacity` as `ErrComputerLimit` with that reason, like 0.4.0.
- Computer refusals name the Go methods and point to `Exec` instead of `exec()`, and `Navigate` on a computer is refused that way instead of suggesting `OpenURL`.
- README: a runnable iOS Settings quick start, how the Go SDK uses a login saved by the other SDKs, a computer's two-hour lifetime, and Linux computers are no longer offered (`verify.Linux` still works).

## Python 0.2.0 (2026-11-11)

- Early access: run `instruction()` and `validation()` on your own model, as in TypeScript 0.4.0. `open(target, model="anthropic/claude-sonnet-5-5")` runs every step on it with the key from the provider's usual variable, and a step's `model=` overrides it. The eight providers, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` with or without `/v1`, and `CustomModel(id, base_url, api_key, headers, provider, grounding)` for any OpenAI-compatible endpoint. Works on the sync and asyncio APIs. `StepResult.model` reports turns and tokens, cached input included.
- Custom agents: `local_agent(model, grounding=, max_turns=, model_timeout=, max_image_side=)` with `anthropic()` and `openai_compatible()`, or your own `ModelAdapter`, passed as `agent=`.
- New error codes `MODEL_KEY_MISSING` (raised before any Revyl request) and `MODEL_ERROR`, with the same next-step hints as TypeScript.
- Early access: exact device actions on Web, iOS and Android, on `Session` and `AsyncSession`: `tap`, `type`, `swipe`, `press_key`, `back` (Web and Android), `open_url`, `launch_app` (iOS and Android), `locate` and `screen_size`, by `Point(x, y)` or a described target. `swipe` directions are finger motion on every platform, so `"up"` scrolls content down; on Web, Verify sends Revyl the matching page direction.
- Map Web runtime target errors on HTTP 409 (`target_not_found`, `stale_target` and similar) to `ACTION_FAILED` instead of `SESSION_BUSY`.
- Same fix as 0.4.0: a `step_status` 404 "Live step not found" right after a step was accepted is retried for about 10 seconds and then raises `STEP_FAILED`, instead of `SESSION_ENDED`. The session stays open.
- Classify the hosted refusal `computer_platform_at_capacity` as `COMPUTER_LIMIT` with that `reason`, like 0.4.0.
- `navigate()` on a computer raises `NOT_AVAILABLE_ON_PLATFORM` pointing to `exec()` and file operations, like the other device calls, instead of suggesting `open_url()`.
- Print progress to stderr by default, like TypeScript: `[verify] <platform>: …` lines with the session link as soon as it is known, `ready`, and each instruction or validation's outcome and duration. Step text is not printed. Pass `log=False` to turn the lines off, or `log=callback` to receive them. An explicit `log=None` now means the default.
- README: a computer's two-hour lifetime, and Linux computers are no longer offered (`Target(platform="linux")` still works).

## 0.3.2 (2026-11-11)

- Fix `npx @revyl/verify init` in pnpm projects: it now runs `pnpm add -D`. pnpm 9 and 10 rejected `--dev`, and pnpm 12 read it as "install only devDependencies", saved Verify under `dependencies` without installing it, and removed the project's other dependencies from `node_modules`.
- Fix `init` in Yarn projects: Yarn 3 and 4 get `--mode=skip-build` (the old `skip-builds` was rejected), Yarn 1 gets `--ignore-scripts`, and Yarn 2 gets a plain `add --dev`.
- `init` passes your environment to the package manager, so Corepack, proxy, registry and npm configuration variables reach the install.
- Add a `default` condition to the package exports of `@revyl/verify` and `revyl-verify`, so `verify.config.ts` loads in Yarn Plug'n'Play projects and CommonJS `require('@revyl/verify')` resolves through Node.js require(esm) on Node.js 22.12 and later.
- The `verify` CLI exits with `Verify needs Node.js 22.18 or later` on older Node.js instead of running `init` and writing a script that Node cannot load.

## Python 0.1.0 (2026-11-06)

First PyPI release of `revyl-verify` (import `revyl_verify`, Python ≥3.10), published from the `py/v0.1.0` tag with PyPI trusted publishing and attestations.

- Includes the Python surface described under 0.3.0 below: typed sync and asyncio sessions, `bundle_id` mobile targets, web and mobile instructions and validations, screenshots, encoded (`argv_b64`/`path_b64`) computer operations, hosted child sessions, `attach()` and `current_computer()`.
- Sign in automatically on the first interactive `open()`, `attach()` or `current_computer()` call through the Revyl browser approval flow, saving the login to `~/.revyl/credentials.json` for the Revyl CLI and other SDKs. Non-interactive runs and `CI` stay key-only and never open a browser.
- Verified live on production: the iOS Settings quickstart (`bundle_id="com.apple.Preferences"`) through a first-run browser sign-in, and a Mac `exec`/file round trip, from the built wheel in a clean virtual environment.

## 0.3.1 (2026-11-03)

- Docs: runnable `.mts` quickstart uses the built-in iOS Settings app, explains how to target an uploaded app with `appId`, clarifies that the Python SDK is not published to PyPI yet, and documents Web availability requirements.

## 0.3.0 (2026-10-31)

- Sign in automatically on the first interactive `open()`, `attach()`, or `currentComputer()` call using the Revyl CLI browser-approval flow; CI remains key-only and browser-free.
- Make `npx @revyl/verify init` install Verify, scaffold a project, sign in through the Revyl CLI browser approval flow when needed, and print the example command. Non-interactive runs use `REVYL_API_KEY` without prompting or opening a browser.
- Add `currentComputer()`, Python `current_computer()` / `async_current_computer()`, and Go `CurrentComputer` to attach non-owning to `REVYL_COMPUTER_ID`, with explicit ownership opt-in and a typed error when no current computer is configured.
- Add explicit non-owning computer attachment with `stopOnClose: false`, Python `stop_on_close=False`, and Go `OpenOptions.StopOnClose`. Closing these attachments still cleans up hosted children but leaves the computer running for its owner to release; the default remains owning.

- Removed environment overrides.

- **Breaking wire change:** encode computer-operation arguments as `argv_b64` and file paths as `path_b64` using padded URL-safe base64 of UTF-8, without changing public APIs, argument boundaries, or existing stdin/data fields. Verify 0.3.0 requires the encoded-only backend, which is already live on revyl.ai; no plaintext fallback or automatic replay is provided.

- Classify HTTP 403 responses with a `text/html` content type and nonempty `cf-ray` as `EDGE_BLOCKED` across TypeScript, Go and Python, unless the body is syntactically valid JSON. Preserve origin authentication errors, omit response content from edge-block messages, and do not retry blocked requests.

- Map hosted Web navigation `request_timeout` and `protocol_error` responses to `ACTION_UNCERTAIN` with safe reasons and HTTP status. Timeout messages explain that navigation may still commit and the session remains open; Verify never replays it.

- Treat ordinary Web `409 web_runtime_unavailable` admission refusals as definite pre-dispatch failures: preserve `API_ERROR` plus safe reason/status details and do not send a stop request. Allocated or otherwise uncertain Web failures retain cleanup.

- Bound parent computer cleanup's child phase to five seconds so slow child stops cannot prevent requesting parent release. Recognize `web_runtime_not_configured` as a definite hosted refusal, reject reports without a known session ID locally, preserve safe TypeScript startup diagnostics, and keep the original TypeScript `Session` interface compatible through the extended `OpenedSession` interface.

- Add public computer attachment, computer-hosted child sessions and deterministic Web navigation in TypeScript, Go and Python. Child sessions reuse the parent's authenticated client and expire with it; parent close attempts bounded child cleanup before requesting computer release. Initial hosted Web builds remain HTTPS; localhost is reached by navigation after start, subject to runtime availability.
- Preserve typed server refusal reasons and HTTP status alongside existing error codes, including Web `web_runtime_unavailable`, computer `computer_limit` and `runtime_unavailable`, without replaying starts or navigation.

- Preserve Python startup session identity, viewer links and separate cleanup outcomes on typed errors; add optional lifecycle logging to sync/async opening. Clean up identifiable malformed or uncertain starts, interrupt cancelled async startup, validate device stop acknowledgments, and preserve original failures when cleanup also fails.

- Prepare Python SDK 0.1.0 (`revyl-verify`, import `revyl_verify`) for Python ≥3.10, with typed sync and thread-adapted async sessions, seconds-based timeouts, web/mobile steps and early-access computer operations. Include fake-server coverage, wheel/sdist checks and an isolated installed-wheel smoke; Python has not been published or verified live. Its independent `py/v*` release workflow validates without publishing on dispatch, skips exact published versions, and requires administrator-enabled, protected-environment PyPI trusted publishing for new tag releases.

- Add the source-free `revyl-verify` npm alias with matching API, TypeScript types and CLI, pinned to the exact `@revyl/verify` version. Validate and pack both packages; optional CI publication checks each version independently and publishes the scoped package before the alias.
- Add a standard-library-only Go SDK for web, iOS, Android, and early-access Mac and Linux computers. Computer commands, binary files, process handles, screenshots, recording metadata, and confirmed-release cleanup require computer access through support@revyl.ai. Capacity refusals have a distinct `COMPUTER_LIMIT` code; no start or operation is automatically replayed.

## 0.2.0 (2026-10-27)

Prepared for release; see npm for publication status.

- Enable Linux named and inline computer targets with the shared Mac command, file, process, screenshot, and confirmed-release cleanup surface. Both operating systems remain early access; contact support@revyl.ai for access.
- Add `COMPUTER_LIMIT` for queued work (including iOS) or concurrency admission refusals, without retrying or stopping a definitely refused start. Preserve `SESSION_BUSY` for operation limits.
- Explain the 120-second unclaimed-start failure without shortening the default 10-minute start timeout.
- Expose optional `expiresAt` and bound operation/screenshot observation by the hard 60-minute lifetime from create, while keeping explicit close possible.
- Add computer `recording()` metadata retrieval after terminal state and confirmed release, including after close. Missing recordings return null; signed URLs remain private, with no automatic waiting or download.
- Keep Linux CLI init intentionally unavailable; use inline targets or config entries. Computer instruction/validation remain locally unavailable.
- Observe mobile first-screen content best-effort for up to 10 seconds after connection/launch, without pretending the runtime provides rendered-readiness guarantees. Generated mobile examples begin with an instruction to wait for the first screen before validation.
- Retry structured computer screen-not-ready responses with bounded backoff during the fixed startup window; do not replay mutations or unrelated failures.
- Skip CI publication when the exact version is already on npm, require explicit administrator opt-in for new CI publications, fail closed on registry lookup errors, and document manual Mac publication, optional trusted publishing, and independent Go module tags.

Regression validation uses fake API responses. The [end-to-end record](https://github.com/RevylAI/verify/blob/v0.2.0/packages/verify/docs/end-to-end.md) distinguishes baseline live runs from startup fixes still awaiting live re-verification.

## 0.1.0 (2026-10-26)

Published manually from a maintainer's Mac without provenance.

- Open Revyl cloud web browsers, iOS simulators, and Android emulators from TypeScript.
- Run natural-language instruction and validation steps, with typed failures and optional soft validation results.
- Save screenshots, share session links, and close sessions explicitly or during best-effort process cleanup.
- Configure named targets and initialize a script with the `verify` or `revyl-verify` command.
- Use environment credentials or an existing Revyl CLI login, with documentation included in the package.
- Include **early-access Mac computers** for commands, binary files, process handles, screenshots, and confirmed-release cleanup. Ask support@revyl.ai about access.
- Reserve Linux target types and document the future contract; opening Linux is not available in this release.

Requires Node.js 22.18 or later and a Revyl account. There is no bundled test runner or step replay. Mac operations remain covered by source-aligned fake-API tests; the attempted live start never reached active, so it did not prove any operation or confirmed cleanup.
