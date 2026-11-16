# Changelog

## 0.6.4 (unreleased)

- Your own model: when the model says an instruction is done, Verify checks before passing it. It takes a new screenshot and asks the same model whether the screen shows the task's result. If the check disagrees, the model is told what is missing and keeps working; a second disagreement fails the instruction with `INSTRUCTION_FAILED`: `<model> said the task was done, but a check of the screen disagreed: <reason>`. Before, a model that stopped early (for example after opening an edit field without saving) passed the step. The check is one extra model call per finished instruction and shows in `step.model.turns` as `check true` or `check false`.
- Your own model on Web: typing that Revyl refuses because no text field has focus (`no_focused_input`) throws `ACTION_FAILED` (`Nothing was typed: no text field has focus on the web session (no_focused_input). Tap the text field first, or call type() with the field's target or point, which taps it before typing. See <link>`) instead of `SESSION_BUSY`, and a point that isn't on a text field says `Nothing was typed: the tap did not land on a text field (target_not_found)…`. In a step on your model, both go back to the model, which tries again, instead of ending the step. The model's prompt says that `type` clicks the field before typing.
- Your own model with Revyl grounding: a target that is only coordinates, such as `[208, 761]`, is refused and sent back to the model to describe the element in words, instead of being sent to Revyl's grounding model.
- Your own model: running out of turns says `<model> did not finish within 20 turns (maxTurns 20). Raise localAgent() maxTurns or split the instruction into smaller steps.`, and a model call that runs past `modelTimeout` names the value: `<model> did not answer within modelTimeout (60000 ms). Raise localAgent() modelTimeout for slow or local models.`
- A web `open()` whose app or build Revyl can't find throws `INVALID_ARGUMENT` (`Revyl app <id> was not found (HTTP 404). Check app.appId: copy it from the app's page in Revyl, and use an API key from the same organization. No session was started.`) instead of `API_ERROR … failed with HTTP 404`.
- An iOS or Android `open()` that Revyl refuses with "Build platform does not match the session" says which platform the target asked for and what the app or build is: `This target's platform is 'ios', but app <id> is a web app. Pass the id of an iOS app as app.appId, or set platform to 'web'.` (for a build id: `…but build <id> is not an iOS build…`).
- An iOS or Android session that ends before it is ready, such as one whose `artifactUrl` Revyl can't download, throws `SESSION_START_FAILED` with Revyl's reason and the session link instead of `SESSION_ENDED`, and with an `artifactUrl` adds that it must be a public HTTPS download Revyl can reach (the URL is shown without its query string).
- `open('android')` with no such target in `verify.config.ts` shows the shape to add: `… Add it under targets in that file, such as android: { platform: 'android', app: { appId: '<app id>' } }, with exactly one of appId, buildId, artifactUrl or bundleId in app.` A target's `app` with more than one of those names the ones it has and, for `appId` and `buildId`, which to keep.
- A misspelled target option in `verify.config.ts` is named with a suggestion, such as `targets.web.plaform is not a known option. Did you mean platform?`, instead of `targets.web.platform must be 'web', 'ios', …`.
- A call after `close()` says `The android session was closed before this call. Await every step before calling close(), or open a new session with open(). See <link>`. `back()` on iOS, `model` on a computer, two steps at once and a step timeout now say how to fix the call: tap the on-screen back control (with the session link); remove `model` and use `exec()`, the file calls and the screen actions; await each step (`Promise.all` starts them together); raise the step timeout or split the step.
- Docs: errors.md and own-model.md describe the changes above.

## Go 0.5.4 (unreleased)

- Your own model: a `done` with success is checked against a new screenshot by the same model before the step passes; a second disagreement fails the instruction (`ErrInstructionFailed`): `<model> said the task was done, but a check of the screen disagreed: <reason>`. The check shows in `step.Model.Turns` as `check true` or `check false`.
- Web typing refused for no focused field (`no_focused_input`) returns `ErrActionFailed` (`Nothing was typed: no text field has focus … Tap the text field first, or call Type with the field's target or point …`) instead of `ErrSessionBusy`, and on your model goes back to the model instead of ending the step. A point that isn't on a text field says so (`target_not_found`). With Revyl grounding, a target that is only coordinates is sent back to the model.
- Your own model: running out of turns names `MaxTurns` and how to raise it; a model call past `ModelTimeout` names the value. A custom adapter's own `ErrTimeout` gets the same message.
- A Revyl-agent step whose `StepOptions` or `ValidationOptions` `Timeout` runs out returns `ErrTimeout` naming the timeout, the step, and how to fix it (`Raise the step timeout … or split the instruction into smaller steps. See <link>`), instead of `Revyl operation exceeded its deadline or was cancelled.` A caller's own cancellation still returns the generic `ErrTimeout`.
- A web `Open` whose app or build Revyl can't find returns `ErrInvalidArgument` (`Revyl app <id> was not found (HTTP 404). Check AppID: …`) instead of `ErrAPI`. "Build platform does not match the session" adds which platform the target asked for and what the app or build is, and what to change.
- An iOS or Android session that ends before it is ready returns `ErrSessionStartFailed` with Revyl's reason and the session link; with an `ArtifactURL` it adds that the download must be public HTTPS (the URL without its query).
- A call after `Close`, a step interrupted by `Close`, `Back` on iOS (now with the session link), two steps at once, `WithModel` on a computer, and a target with both `AppID` and `BuildID` say how to fix the call.

## Python 0.4.4 (unreleased)

- Your own model: a `done` with success is checked against a new screenshot by the same model before the step passes; a second disagreement raises `INSTRUCTION_FAILED`: `<model> said the task was done, but a check of the screen disagreed: <reason>`. The check shows in `step.model.turns` as `check true` or `check false`.
- Web typing refused for no focused field (`no_focused_input`) raises `ACTION_FAILED` (`Nothing was typed: no text field has focus … call type() with the field's target or point …`) instead of `SESSION_BUSY`, and on your model goes back to the model instead of ending the step. A point that isn't on a text field says so (`target_not_found`). With Revyl grounding, a target that is only coordinates is sent back to the model.
- Your own model: running out of turns names `max_turns` and how to raise it; a model call past `model_timeout` names the value in seconds.
- A step timeout says how to fix it: raise the `timeout` argument or `step_timeout`, or split the step.
- A web `open()` whose app or build Revyl can't find raises `INVALID_ARGUMENT` (`Revyl app <id> was not found (HTTP 404). Check app_id: …`) instead of `API_ERROR`. "Build platform does not match the session" adds which platform the target asked for and what the app or build is, and what to change.
- An iOS or Android session that ends before it is ready, such as an `artifact_url` Revyl can't download, raises `SESSION_START_FAILED` with Revyl's reason and the session link instead of `SESSION_ENDED: Revyl session request failed (HTTP 404)`; with an `artifact_url` it adds that the download must be public HTTPS (the URL without its query).
- A step still running when `close()` (or the end of a `with` block) ends the session raises `SESSION_ENDED` saying so, instead of `TIMEOUT`. Two steps at once (`asyncio.gather()`) say to await each one. A call after `close()`, `back()` on iOS (now with the session link), `model` on a computer, and a target with both `app_id` and `build_id` say how to fix the call.

## 0.6.3 (2026-11-16)

- An iOS or Android `open()` whose app or build Revyl can't find (HTTP 404) throws `INVALID_ARGUMENT` saying what wasn't found and how to fix it, instead of a bare `API_ERROR … failed with HTTP 404`: `Revyl refused to start the session (HTTP 404): App not found: <id>. Check app.appId and app.buildId: copy them from the app's page in Revyl, use an API key from the same organization, and upload a build if the app has none. No session was started.` Web and hosted starts still copy no server text.
- A bundle id that can't be launched throws `SESSION_START_FAILED` with the session link: `Could not launch <bundle id> on the ios device: <reason> Check that the bundle id names an app installed on the device. See <link>`.
- `report()` right after `close()` waits up to 5 seconds for a final status (`completed`, `failed`, `cancelled` or `timeout`), so an iOS or Android session no longer reports `running`. If Revyl is slower, it returns the status Revyl has. A slow or failing read during the wait never stretches it past 5 seconds or turns it into an error: `report()` returns the last report it got. A web session stays `running` until Revyl has saved its recording, which can take longer than 5 seconds; call `report()` again later for its final status.
- Your own model: a custom `ModelAdapter` that stops when `modelTimeout` aborts its signal throws `TIMEOUT` with the built-in adapters' message, `<name> did not answer in time. Raise localAgent() modelTimeout for slow or local models.`, instead of the adapter's raw `TimeoutError`.
- `INSTRUCTION_FAILED` and `VALIDATION_FAILED` carry the failed step as `error.result`, so a step that ran on your model reports its turns and tokens on `error.result.model`, as in Python and Go.
- `verify init` that wrote its files but can't confirm a sign-in (no key, a rejected key, or Revyl unreachable) prints `Could not confirm a Revyl sign-in:` with the reason, makes signing in step 1 under "Next:", and exits 0 instead of 1 or 2, because the files are written and need no change.
- Every other call sends the same requests as 0.6.2. Docs: the npm page shows the new README hero, which landed after 0.6.2 was tagged, and the API, errors, configuration, getting-started, agents and own-model pages describe the changes above.

## Go 0.5.3 (2026-11-16)

Published as the `go/v0.5.3` tag.

- `OpenOptions.Log` gets `<platform>: starting <platform> session <link>` as soon as the session ID exists, before the browser or device is ready, then `ready`, on web, iOS, Android and hosted sessions, as in TypeScript. Before, nothing was logged until `Open` returned. The README's quick start passes a `Log` callback.
- An iOS or Android `Open` whose `AppID` or `BuildID` Revyl can't find (HTTP 404) returns `ErrInvalidArgument` saying what wasn't found and how to fix it, instead of `ErrAPI` with a bare HTTP 404. No session was started.
- `ErrSessionStartFailed` for a `BundleID` that can't be launched names the bundle ID and Revyl's reason, with the session link, instead of `Could not launch the installed app.`
- `Report` right after `Close` waits up to 5 seconds for a final status, as in TypeScript 0.6.3. A web session can still report `running` after that wait.
- A custom `ModelAdapter` that stops when `ModelTimeout` ends its context returns `ErrTimeout` with the built-in adapters' message, instead of a bare `context deadline exceeded`.
- `verify.Version` and the `User-Agent` report 0.5.3. Every other call sends the same requests as v0.5.2.

## Python 0.4.3 (2026-11-16)

- iOS and Android print `[verify] ios: starting ios session <link>` as soon as the session ID exists, as Web and TypeScript do, instead of `starting session` without a link followed by `assigned session <link>`.
- An iOS or Android `open()` whose `app_id` or `build_id` Revyl can't find (HTTP 404) raises `INVALID_ARGUMENT` saying what wasn't found and how to fix it, instead of `API_ERROR` with a bare HTTP 404. No session was started.
- `SESSION_START_FAILED` for a `bundle_id` that can't be launched names the bundle id and Revyl's reason, with the session link, instead of `Could not launch the installed app.`
- `report()` right after `close()` waits up to 5 seconds for a final status, as in TypeScript 0.6.3. `AsyncSession` does the same. A web session can still report `running` after that wait.
- The `User-Agent` reports 0.4.3. Every other call sends the same requests as 0.4.2.

## 0.6.2 (2026-11-14)

- A Mac or Linux computer that starts prints only its start line with the session link, as Web, iOS and Android do: `[verify] mac: starting computer https://app.revyl.ai/sessions/…?kind=computer`. It no longer adds "Mac computers need a current paid Revyl plan, and Linux computers are not generally available. Ask support@revyl.ai about access." That guidance stays on the errors for a computer that doesn't start: a start Revyl refuses (`computer_not_enabled`, or `runtime_unavailable` for Linux), a start that times out, and a release Verify can't confirm.
- `verify init --platform mac` no longer prints the availability note under "Next:" or writes it at the top of `verify/example.mts`.
- Every call sends the same requests as 0.6.1.

## Go 0.5.2 (2026-11-14)

Published as the `go/v0.5.2` tag.

- A computer that starts sends only its start line with the session link to `OpenOptions.Log`, as in TypeScript 0.6.2: `mac: starting mac computer https://app.revyl.ai/sessions/…?kind=computer`. Refusals, timeouts and an unconfirmed release keep the availability guidance in their errors.
- `verify.Version` and the `User-Agent` report 0.5.2. Every call sends the same requests as v0.5.1.

## Python 0.4.2 (2026-11-14)

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