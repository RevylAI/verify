# API

```ts
import { attach, open, defineConfig, VerifyError, isVerifyError } from '@revyl/verify';
```

## open(target, options?)

Starts a Revyl cloud browser, device, or Mac computer. Mobile first-screen readiness is [best-effort](mobile.md#steps), not a foreground/rendered-readiness guarantee. Computer starts retain a 10-minute default timeout; an unclaimed start may fail after 120 seconds with no-host context.

Mac computers are available to organizations on a current paid Revyl plan.

```ts
const web = await open('web');                                       // a target named in verify.config.ts
const ios = await open({ platform: 'ios', app: { appId: '…' } });    // or a target object, no config needed
const mac = await open({ platform: 'mac' });                        // computer, no app needed
```

- `target`: a target name from `verify.config.ts`, or a target object with the same shape as a config entry (see [configuration.md](configuration.md)). Verify reads the nearest `verify.config.ts` at or above the current folder.
- `options.config`: the path of a config file to read instead.
- `options.log`: where progress lines go. By default Verify writes the session link and each step's outcome to stderr, prefixed with `[verify]`. Pass a function to receive the lines yourself, or `false` to turn them off.
- `options.model`: runs every instruction and validation on your own model instead of Revyl's agent; see [Your own model](#your-own-model). Browsers and devices only; computers throw `NOT_AVAILABLE_ON_PLATFORM`.
- `options.agent`: the same with a custom agent; see [Custom agents](#custom-agents). Pass `model` or `agent`, not both.
- `options.profile`: a session profile from your project's `.revyl/config.yaml`, such as `'signed-in'`, that Revyl runs before `open()` returns, or `'none'` for no profile. Left out, the project's `session.default_profile` runs when it sets one. Web, iOS, Android and Mac computers. See [Session profiles](#session-profiles).

`open` needs credentials: `REVYL_API_KEY` or a Revyl CLI login. It throws `AUTH_MISSING` without them, `CONFIG_NOT_FOUND` or `CONFIG_INVALID` for config problems, and `SESSION_START_FAILED` or `TIMEOUT` when the browser or device does not start.

## Session profiles

A session profile is a script from your Revyl project that prepares a session before your first step: it signs a user in, seeds data, or sets launch values. Revyl runs the script, never Verify: on Revyl's hosted runner for a browser or an iOS or Android device, and on the Mac itself for a Mac computer. `open()` returns once Revyl reports that the profile succeeded.

```ts
// Run the 'signed-in' profile from session.profiles in .revyl/config.yaml
const session = await open('web', { profile: 'signed-in' });

// Start without any profile, not even the project's default
const bare = await open('web', { profile: 'none' });
```

| `profile` | What Verify sends |
| --- | --- |
| `'signed-in'` | That profile, with the project and the script from this checkout. |
| left out | The project's `session.default_profile`, the same way, when `.revyl/config.yaml` sets one. Otherwise nothing, so the start request is the same as before profiles existed. |
| `'none'` | No profile, not even the default: Verify sends no profile fields, so the start request is the same as before profiles existed. Needs no `.revyl/config.yaml`. |

Profiles work on web, iOS, Android and Mac computers. On a Linux computer, a profile name throws `NOT_AVAILABLE_ON_PLATFORM` before anything is sent, and no default runs; `'none'` is accepted. Hosted sessions (`computer.open()`), `attach()` and `currentComputer()` never run a profile: their options have no `profile`, so TypeScript rejects one.

### Where Verify reads the profile

Verify reads `.revyl/config.yaml` in the current folder (`process.cwd()`) or the nearest folder above it that has one: the file `revyl init` writes in your app's checkout. It needs `project.id` and the profile under `session.profiles`, and reads nothing else from the file:

```yaml
project:
  id: 0b9e6f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b    # your Revyl project's id
session:
  default_profile: signed-in                  # optional: runs when you leave profile out
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

`open()` returns when the session is ready and Revyl reports the profile's status as `succeeded`, within the target's `startTimeout` (10 minutes by default). While it waits, it logs `<platform>: waiting for session profile <name>`. Verify never shows the script's output: Revyl doesn't send it, because setup scripts often print secrets. On a Mac computer, Revyl refuses commands and screen actions with HTTP 409 `session_profile_running` while the profile runs, without running them. If a call on a computer, such as one you `attach()` to, still gets that refusal, Verify waits and sends the same call again, for up to the start timeout (10 minutes for `attach()`), then throws `TIMEOUT` naming the profile. It repeats only calls Revyl refused that way.

### Session profile errors

Neither errors nor logs contain the script's content or output. A refusal keeps Revyl's code in `error.reason`, such as `project_not_found`, and Revyl's sentence in the message.

| Error | When | What to do |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `profile` isn't a profile name (1-64 lowercase letters, digits or hyphens) or `'none'` | Pass a name from `session.profiles`, or `'none'` |
| `NOT_AVAILABLE_ON_PLATFORM` | A Linux computer, or a session started without reporting its profile, which Verify then stops | Leave out `profile`, or pass `profile: 'none'` |
| `CONFIG_NOT_FOUND` | `profile` names a profile, but no `.revyl/config.yaml` is in the current folder or above it | Run from your app's checkout, or pass `profile: 'none'` |
| `CONFIG_INVALID` | `.revyl/config.yaml` isn't valid YAML, `project.id` isn't a UUID, or `session.profiles` doesn't define the name (the message lists the ones it does); or Revyl refused with `session_profile_undefined`, `project_not_found` (`project.id` isn't in this API key's organization) or `repository_connection_missing` (connect the repository's GitHub or GitLab app to the project in Revyl) | The message names the file and the fix |
| `SESSION_PROFILE_FAILED` | Verify couldn't send the script (missing, outside the repository, not executable, over 64 KiB or not UTF-8); Revyl couldn't find it (`session_profile_script_unavailable`); or the profile ran and failed. `error.outcome` says how and `error.failureReason` says why | Follow the message, as the next table says. Revyl stops a session whose profile failed, so Verify doesn't |
| `API_ERROR` | Revyl couldn't read the repository in 3 attempts (`repository_unavailable`). Verify repeats the same start twice before it gives up | Try again in a few minutes |

| `error.outcome` | Meaning | Fix |
| --- | --- | --- |
| `script_failed` | The script exited with an error | Run the script yourself from the project folder to see its output |
| `script_timed_out` | The script ran past Revyl's 300-second limit | Make it finish sooner |
| `script_unavailable` | The script isn't in this checkout or in Git, or the Library Script is missing | Commit the script or add it to `.revyl/scripts`, or create the Library Script |
| `output_invalid` | A file the script wrote broke a rule; `failureReason` names the file and the line | Fix what the script writes there |
| `runner_failed` | Something failed on Revyl's side | Open the session again |

## Inside a revyl-macos GitHub Actions job

`currentComputer(options?)` attaches to `REVYL_COMPUTER_ID` using normal credential resolution. It is non-owning by default: close cleans up hosted children, while the job's owner releases the computer. It never creates a computer and throws `COMPUTER_ID_MISSING` when the ID is unset or blank. Invalid IDs fail with `INVALID_ARGUMENT`.

This helper is included in the TypeScript 0.3.1 release and requires a runner configured to inject `REVYL_COMPUTER_ID` and a short-lived `REVYL_API_KEY`. A workflow can supply its own `REVYL_API_KEY` instead. After installing the project dependencies and selecting Node.js ≥22.18, add this step to a job with `runs-on: revyl-macos`:

```yaml
- name: Run Verify
  run: |
    node --input-type=module <<'JS'
    import { currentComputer } from '@revyl/verify';
    const computer = await currentComputer();
    try {
      await computer.screenshot({ path: 'computer.png' });
    } finally {
      await computer.close();
    }
    JS
```

The helper accepts the same options as `attach`, including explicit `backendUrl` and `appUrl`; it does not read URL environment variables. `stopOnClose: true` explicitly takes ownership and can end the job's computer when closed. Use `computer.open(target)` with an exact app/build pair for hosted app sessions.

## attach(computerId, options?)

The attachment, hosted-child and navigation APIs below are included in the TypeScript 0.3.1 release.

`open()` and `computer.open()` return the extended `OpenedSession` interface. The original `Session` interface keeps its existing required members, so applications implementing or mocking it do not need to add the new methods. Use `OpenedSession` when explicitly annotating a value that calls `report`, `navigate` or `open`.

Attaches to an active Mac computer in your organization without creating a new one. `options.log` controls progress. The returned computer owns cleanup by default: `close()` stops it, and automatic cleanup also applies. Attaching requires a valid expiry and does not change the lifetime; call `extend()` for that. Invalid, inaccessible, inactive or expired computers fail without sending a stop request.

When attaching to a computer you do not own, such as a CI runner, pass `attach(computerId, { stopOnClose: false })`. The attachment is not registered for automatic cleanup. Its `close()` still cancels pending child starts and gives hosted children the same five-second cleanup phase, but never stops the computer; its owner must release it. Child cleanup failures remain observable. This option is explicit and is never inferred from the environment.

## computer.open(target)

Starts a child app session inside this computer, returning the normal session API. It inherits the parent's authenticated client, logging and step timeout; callers cannot route a child to another backend. Both `target.app.appId` and `target.app.buildId` are required. Web accepts an existing external HTTPS build, plus optional viewport/sign-in settings; native builds use the computer's fixed device profile and accept no bundle, artifact or device override. Named targets and initial URL overrides are not supported here.

Mac supports Web and iOS children. The server remains authoritative for access, capability and capacity. Children require and share the parent's known deadline. Closing a child leaves the parent running; closing the parent cancels pending starts and gives child cleanup at most five seconds total before requesting confirmed computer release. The parent stop also stops any remaining children, so a slow child cannot prevent that request. A failed child start never closes the parent.

```ts
const computer = await attach(existingComputerId, { stopOnClose: false, log: false });   // not yours, so close() leaves it running
try {
  const web = await computer.open({
    platform: 'web',
    app: { appId: webAppId, buildId: externalBuildId },
  });
  await web.navigate('https://www.saucedemo.com');
  await web.validation('The Swag Labs login form is shown');
} finally {
  await computer.close();
}
```

The initial Web build uses HTTPS. After start, `navigate()` can also reach `http://localhost:<port>` on the computer, but only when a service is already listening there, such as one an earlier step of a `revyl-macos` job started. Verify has no call that starts one, and a process started through `exec()` ends when the command returns. Leave out `stopOnClose: false` only for a computer your script owns: then `close()` stops it.

## session.navigate(url)

Web only, hosted or normal. Sends one deterministic `open_url` action and checks the returned navigation outcome. Accepts an HTTP(S) URL without credentials, whitespace, control characters or backslashes. Loopback addresses are accepted on every Web session: a hosted browser can reach its parent computer's loopback address; a normal cloud browser's localhost is its own runtime, not your machine. A cold development server may need a warm-up request before navigation succeeds; after an uncertain timeout, re-navigating is the caller's choice because the original request may still commit. The runtime is responsible for enforcing its navigation network policy. Navigation is not replayed by Verify and does not run an agent step. It resolves with no value, or throws a typed error. Computer and native sessions reject it locally.

## CDP (Playwright, Puppeteer)

Web only. `session.cdp()` returns a Chrome DevTools Protocol (CDP) endpoint for the session's cloud browser, so a script can attach Playwright, Puppeteer or another CDP client next to Verify's steps. `instruction()`, `validation()`, `screenshot()` and the exact actions keep working while the script is attached.

```ts
import { open } from '@revyl/verify';
import { chromium } from 'playwright-core';             // npm install playwright-core; it downloads no browser

const session = await open('web');
try {
  const { url } = await session.cdp();                  // connect once, within 60 seconds
  const browser = await chromium.connectOverCDP(url);
  const page = browser.contexts()[0]!.pages()[0]!;       // the session's own tab
  await page.locator('#user-name').fill('standard_user');
  await session.validation('The username field shows standard_user');
  await browser.close();                                  // only disconnects Playwright
} finally {
  await session.close();                                  // ends the session
}
```

It resolves with a `CDPEndpoint`, `{ url: string; expiresAt: Date }`. In Puppeteer, connect with `puppeteer.connect({ browserWSEndpoint: url, defaultViewport: null })` and use `(await browser.pages())[0]`, which is the session's tab while it is the only one. [examples/web-cdp](https://github.com/RevylAI/verify/tree/main/examples/web-cdp) runs a full Playwright script: DOM, locators, a console message, network requests and a Verify validation while attached.

- **The url is a single-use credential.** It accepts one connection and expires at `expiresAt`, 60 seconds after `cdp()` returns it. Call `cdp()` again for each new connection. Don't log it, store it or pass it on; `console.log` of the endpoint shows the url as `[redacted]`, but Playwright's and Puppeteer's connection errors can include it, so remove it before you log one. Any connection attempt uses the url up, even one that fails, so call `cdp()` again before you retry.
- **One connection at a time.** A second connection to the same session is refused until the first disconnects. Once `browser.close()`, or Puppeteer's `browser.disconnect()`, has resolved, the next url from `cdp()` connects.
- **The connection ends with the session.** `close()`, the session's timeout or a failure closes it. After `close()`, `cdp()` throws `SESSION_ENDED` without a request, and an earlier url no longer works.
- **Use the session's page.** In Playwright that is `browser.contexts()[0].pages()[0]`. `browser.newContext()` is refused, because a session has one browser context. A tab you open with `context.newPage()` becomes the session's active tab: Verify steps, screenshots and the recording follow it until you close it, and then return to the session's tab. While another tab is open, `pages()[0]` may not be the session's tab, so find it by URL.
- **`browser.close()` only disconnects.** In Playwright and Puppeteer it disconnects the script, and the session keeps running; call `session.close()` to end it. In Puppeteer, `browser.disconnect()` is the explicit form.
- **Navigation is http(s) and `about:blank` only.** `file://`, `chrome://`, `data:`, `javascript:` and other schemes are refused with a CDP error.
- **Downloads are off.** Download-behavior commands are accepted, but nothing is downloaded and no download path can be set.
- **The window size is fixed.** Viewport and window-size emulation (`page.setViewportSize()`, Puppeteer's `setViewport()`) and `Browser.close` are refused; the browser keeps the size the session opened with. Set the target's `viewport` to choose it.
- **Refusals are CDP errors that start with `Revyl:`**, so the script sees why.
- **A reply over 24 MB is dropped** with the CDP error `Revyl: the reply was larger than 24 MB and was dropped` (Playwright reports it from `page.evaluate` as "Execution context was destroyed"); the connection and the session keep working.
- **Files come from your machine.** Playwright's `setInputFiles()` with files from the script's machine works; file paths on the browser's host are refused.
- Everything else works as with a local Chrome: locators, DOM, `evaluate`, console and network events, request interception and screenshots.

On iOS, Android and Mac computers `cdp()` throws `NOT_AVAILABLE_ON_PLATFORM` before any request; use `instruction()`, `validation()`, `screenshot()` and the exact actions there, or `exec()` and `screenshot()` on a computer. A session that is no longer running throws `SESSION_ENDED`, a view-only session `AUTH_REJECTED`, and a Revyl backend without CDP `NOT_AVAILABLE_ON_PLATFORM` saying so. HTTP 503 throws `API_ERROR`, and calling `cdp()` again is safe.

## Exact actions

**Early access.** Since TypeScript (`@revyl/verify`) 0.4.0, Python (`revyl-verify`) 0.2.0 and Go v0.3.0. `doubleTap`, `longPress`, `drag`, `typeFocused`, `goHome`, and Web keys and modifiers in `pressKey`, are new in TypeScript 0.5.0, Python 0.3.0 and Go v0.4.0. On a Mac computer's screen, `tap` (by point or by description), `screenSize`, `typeFocused` and `pressKey` are new in TypeScript 0.6.0, Python 0.4.0 and Go v0.5.0. The [Python](https://github.com/RevylAI/verify/blob/v0.7.0/python/README.md#exact-actions) and [Go](https://github.com/RevylAI/verify/blob/v0.7.0/go/README.md#exact-actions) READMEs show them with each language's names. Web, iOS and Android sessions, and a Mac computer's screen, take device actions that need no agent.

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `tap({ x, y })`, `tap({ target })`, `screenSize` | Yes | Yes | Yes | Yes |
| `locate` | Yes | Yes | Yes | No, use `tap({ target })`, which returns the point it clicked, or read the point off `screenshot()` |
| `doubleTap`, `longPress`, `type`, `swipe`, `drag` | Yes | Yes | Yes | No |
| `pressKey(key, { modifiers })` | Yes: `'enter'`, `'backspace'`, `'tab'`, `'escape'`, arrows and more, with modifiers | `'enter'` and `'backspace'` only | `'enter'` and `'backspace'` only | Yes: the Web keys and modifiers, where `'meta'` is Command |
| `typeFocused(text, { clear })` | Yes, types into the focused field | No, use `type(location, text)` | No, use `type(location, text)` | Yes, with `{ clear: false }` |
| `back()` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `goHome()` | No, use `openUrl` or `navigate` | Yes, the home screen | Yes, the home screen | No |
| `openUrl(url)` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `launchApp(bundleId)` | No, use `openUrl` or `navigate` | Yes | Yes | No |
| `navigate(url)` | Yes | No, use `openUrl` | No, use `openUrl` | No |
| `cdp()`, for Playwright and Puppeteer | Yes, see [CDP](#cdp-playwright-puppeteer) | No | No | No |
| `instruction`, `validation`, your own model | Yes | Yes | Yes | No, use `exec()` and the screen calls above |
| `screenshot()` | Yes | Yes | Yes | Yes |
| `exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

A call a platform doesn't support throws `NOT_AVAILABLE_ON_PLATFORM`, and its message names the alternative.

A location is `{ x, y }` in screenshot pixels (see [Coordinates](#coordinates)) or `{ target: 'Login button' }`, which Revyl's grounding model finds on the current screen.

| Call | What it does |
| --- | --- |
| `tap(at)` | Taps (clicks on Web and Mac computers) and resolves with the point tapped. On a Mac computer a described tap takes several seconds, can click a look-alike, and can click something else when the target isn't on the screen, so check the point or a screenshot afterwards; see [computers.md](computers.md#screen) |
| `doubleTap(at)` | Double-taps (double-clicks on Web) and resolves with the point |
| `longPress(at, { duration })` | Presses and holds for `duration` milliseconds, 1 to 5000 (default 1500), and resolves with the point |
| `type(at, text, { clear })` | Taps a text field and types into it, clearing it first unless `clear` is `false` |
| `typeFocused(text, { clear })` | Web and Mac computers: types into the field that already has focus, without clicking. Focus the field first, for example with `tap` or `pressKey('tab')`. With no field focused nothing is typed and no error is thrown, so check the result. On Web it replaces the field's text unless `clear` is `false`. On a Mac computer pass `{ clear: false }`: it types where the cursor is, and leaving `clear` out throws `INVALID_ARGUMENT`. To replace text there, select it first with `pressKey('a', { modifiers: ['meta'] })`. On iOS and Android it throws `NOT_AVAILABLE_ON_PLATFORM`; use `type(location, text)` |
| `swipe(direction, { from })` | Swipes from a location or the screen's center; `'up'` moves the finger up, which scrolls content down |
| `drag(from, to)` | Presses at one location, moves to the other and releases, for example to reorder a list, move a slider or select text |
| `pressKey(key, { modifiers })` | Presses a key on the focused element. Every platform takes `'enter'` and `'backspace'`. Web and Mac computers also take `'tab'`, `'escape'`, `'delete'`, `'space'`, `'arrowup'`, `'arrowdown'`, `'arrowleft'`, `'arrowright'`, `'home'`, `'end'`, `'pageup'` and `'pagedown'`, and `modifiers`: up to four of `'ctrl'`, `'shift'`, `'alt'` and `'meta'`, held while the key is pressed. With modifiers a lowercase letter or digit works too. The shortcut key differs: select all with `pressKey('a', { modifiers: ['meta'] })` on a Mac computer, where `'meta'` is Command and `'alt'` is Option, and with `pressKey('a', { modifiers: ['ctrl'] })` on Web, where `'meta'` is not the shortcut key. Other keys and any modifiers throw `NOT_AVAILABLE_ON_PLATFORM` on iOS and Android |
| `back()` | Browser history on Web, the back button on Android; iOS throws `NOT_AVAILABLE_ON_PLATFORM` |
| `goHome()` | Goes to the home screen on iOS and Android; Web throws `NOT_AVAILABLE_ON_PLATFORM` |
| `openUrl(url)` | Opens a URL or deep link on a device, or loads a URL in a browser |
| `launchApp(bundleId)` | Launches an installed app on a device |
| `locate(target)` | Resolves with Revyl's best match on the current screen, without acting |
| `screenSize()` | Resolves with the screenshot's `{ width, height }` in pixels |

A failed action throws `ACTION_FAILED`, including when Revyl cannot find a target or nothing at a point can take the action. One whose outcome Revyl can't confirm throws `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. If Verify can't reach Revyl, the action fails with `API_ERROR` and isn't resent either, so check the session before trying it again. A Mac computer's screen has a few errors of its own, listed in [computers.md](computers.md#screen).

Exact actions return when Revyl has accepted them, not when the screen has finished changing. After `swipe`, `drag`, `goHome`, `openUrl` or `launchApp`, let the screen settle or check it before you `locate` or tap coordinates. `locate` returns Revyl's best match on the current screen and can return a point for an element that is off screen, so bring the element on screen first. A point outside `screenSize()` is off screen, and an action at it is refused.

**Fast input: `settle: false`.** On Web, the browser runtime waits after every `tap`, `doubleTap`, `longPress`, `type`, `typeFocused`, `swipe`, `drag` and `pressKey` until the page stops changing, for up to about 6 seconds. A running game or animation never stops changing, so each call takes the whole wait and the next one queues behind it. Pass `{ settle: false }` to any of those calls for games, animations and rapid input, such as pressing an arrow key every few hundred milliseconds: the call returns as soon as the input is sent, usually within a second. The catch is that it returns before the screen may have changed, so when you need to see the result, take a `screenshot()` or run a `validation()`, and don't rely on the next screenshot showing it. A description such as `{ target: 'Play button' }` is still found before the input; `settle: false` skips only the wait after it. iOS, Android and Mac computers don't wait for the screen after these calls, so `settle: false` is accepted there and changes nothing. `settle` takes `true` (the default) or `false`; anything else throws `INVALID_ARGUMENT`.

```ts
for (let i = 0; i < 10; i++) {
  await session.pressKey('arrowleft', { settle: false }); // returns without waiting for the page to settle
  await new Promise((resolve) => setTimeout(resolve, 300));
}
await session.validation('The player is at the left edge'); // check the result when you need it
```

### Coordinates

Prefer a description, such as `tap({ target: 'Sign in button' })`: Revyl finds the element on the current screen, and you never handle coordinates. Otherwise a point is `{ x, y }` in screenshot pixels on every platform: whole numbers from the top-left corner of the image `screenshot()` returns. So a position you read off a screenshot goes to `tap()`, `type()`, `swipe()` and every other exact action unchanged. `screenSize()` returns the screenshot's width and height, and `locate()` and the points `tap()`, `doubleTap()`, `longPress()` and `type()` return use the same pixels. A point outside the screenshot is refused with `INVALID_ARGUMENT` before any action is sent, and the message names the valid range. On iOS, Verify converts the pixels to the screen's points for you. On Web they equal CSS pixels at the default device scale factor of 1, and you still pass screenshot pixels at any other. This holds from TypeScript 0.4.1, Python 0.2.1 and Go v0.3.1; earlier versions took iOS points. On a Mac computer a point is in screenshot pixels too, and `tap({ target })` returns the point it clicked in the same pixels. Verify refuses a negative or fractional point before sending it, and Revyl refuses one past the screen's edge without clicking; both throw `INVALID_ARGUMENT` naming the valid range.

```ts
await session.screenshot({ path: '.verify/screen.png' });  // open it and find the element
await session.tap({ x: 660, y: 1500 });                    // the position as you read it, on every platform
const { width, height } = await session.screenSize();      // the screenshot's size: x is 0 to width - 1
```

## session.report()

Returns authenticated JSON metadata: `/execution/device-sessions/{id}` for normal and hosted app sessions, or the computer report for computers. It works after close, but fails locally with `NOT_FOUND` when no session ID is known. After `close()`, `report()` waits up to 5 seconds for a final `status` (`completed`, `failed`, `cancelled` or `timeout`) and then returns the status Revyl has. Web, iOS and Android sessions usually reach a final status within that wait: a web session usually settles in about 2 seconds, and its recording is saved a few seconds later. If a report still reads `running`, call `report()` again. It does not download recordings or turn a device stop acknowledgment into proof of physical release. Treat returned metadata as private.

## session.instruction(text, options?)

Available on web/iOS/Android only. Computers throw `NOT_AVAILABLE_ON_PLATFORM` without sending an agent request.

Asks Revyl's agent to do something in the app, described the way you would tell a person: `'Sign in as the demo user and open Settings'`. The agent looks at the screen and acts until it is done or decides it cannot.

- Resolves with a `StepResult` when the agent finishes.
- Throws `INSTRUCTION_FAILED`, with Revyl's reason and the session link, when it cannot, and `STEP_FAILED` when the step is cancelled on Revyl. The error's `result` is the failed `StepResult`, so `error.result.model` has the turns and tokens of a step that ran on your model.
- `options.timeout`: milliseconds before the step is cancelled on Revyl (`TIMEOUT`). Defaults to `stepTimeout` in the config, or 180000.

## session.validation(text, options?)

Available on web/iOS/Android only, not computers.

Asks Revyl's agent whether something holds on screen right now: `'The cart shows 2 items and a total of $40'`.

- Resolves with a `StepResult` whose `passed` is `true` when it holds.
- Throws `VALIDATION_FAILED`, with Revyl's reason and the session link, when it does not. This is what makes a plain script exit non-zero. The error's `result` is the failed `StepResult`, as for `instruction`.
- Throws `STEP_FAILED` when Revyl cannot reach a verdict, for example because the step errored or was cancelled on Revyl.
- `options.soft: true` returns a failed result instead of throwing `VALIDATION_FAILED`, for scripts that want to collect several outcomes. It does not turn `STEP_FAILED` into a result.
- `options.timeout`: as for `instruction`.

## StepResult

```ts
interface StepResult {
  type: 'instruction' | 'validation';
  text: string;          // the step as sent, trimmed
  passed: boolean;
  reason?: string;       // Revyl's explanation, or your model's on a local agent
  durationMs: number;
  model?: ModelRun;      // set when the step ran on your model
}
```

`session.steps` lists every step run on the session, in order.

When inspecting `revyl device report --session-id <id>`, read validation verdicts from the step's `effective_status` and `validation_result`, with `validations_passed` / `total_validations` for the validation summary. `passed_steps` / `failed_steps` and transport `status` are not enough: a successfully executed validation can have a false verdict. The SDK's `StepResult.passed` reflects that verdict, not just transport success.

## Your own model

**Early access.** Since TypeScript (`@revyl/verify`) 0.4.0, Python (`revyl-verify`) 0.2.0 and Go v0.3.0; the [Python](https://github.com/RevylAI/verify/blob/v0.7.0/python/README.md#your-own-model) and [Go](https://github.com/RevylAI/verify/blob/v0.7.0/go/README.md#your-own-model) READMEs show them with each language's names. Runs instructions and validations on a model you choose, in your process, instead of Revyl's agent. Revyl still provides the browser or device. Leave `model` out and Revyl's agent runs the step, as before.

```ts
const session = await open('ios', { model: 'anthropic/claude-sonnet-5-5' });  // every step on your model
await session.instruction('Open General, then About');
await session.validation('The screen shows the iOS version');
await session.instruction('Open Privacy', { model: 'openai/gpt-5.5' });       // or one step

// Your own OpenAI-compatible endpoint: vLLM, LiteLLM, a gateway
const custom = await open('ios', {
  model: { id: 'qwen-3.8-27b', baseURL: 'https://api.cerebras.ai/v1', apiKey: process.env.CEREBRAS_API_KEY },
});
```

`options.model` is a `'provider/model'` string, with the key read from the provider's usual environment variable (and `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` for a proxy), or `{ id, baseURL, apiKey?, headers?, provider?, grounding? }` for any OpenAI-compatible endpoint. [Use your own model](own-model.md) has the provider table, which providers are verified live, how to pick a model, what Revyl still sees, the limits and troubleshooting. A missing key throws `MODEL_KEY_MISSING` before any session starts; an unknown prefix throws `INVALID_ARGUMENT`. The model must accept images and tool calls.

The object form's key comes only from `apiKey`, never from the environment.

`StepResult.model` reports `{ id, grounding, turns, inputTokens, outputTokens }`, with each turn's action, model and action time, and token counts. Provider failures throw `MODEL_ERROR` with the key redacted; model calls are retried up to twice on rate limits and server errors. An instruction stops after 20 turns, and the step's `timeout` bounds the whole step.

## Custom agents

For more control, build the agent yourself with `localAgent()` and pass it as `agent` on `open()` or a step:

```ts
import { localAgent, anthropic, openaiCompatible } from '@revyl/verify';

const agent = localAgent({
  model: openaiCompatible({ baseURL: 'http://localhost:11434/v1', model: 'qwen3-vl:8b' }),
  grounding: 'model',
  maxTurns: 10,
});
const session = await open('ios', { agent });
```

- `model`: a `ModelAdapter`. `anthropic({ model, apiKey, baseURL, maxTokens, maxRetries })` uses `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` for what you leave out. `openaiCompatible({ model, baseURL, apiKey, headers, provider, maxTokens, maxRetries })` uses `OPENAI_BASE_URL` and `OPENAI_API_KEY` only when `baseURL` is left out, so a key never reaches another provider; it then sends OpenAI's `max_completion_tokens`. To wrap another SDK or runtime, implement `{ name, complete(request, signal) }`: it gets the system prompt, text, screenshot and tools, and returns the chosen tool call and token usage.
- `grounding`: `'revyl'` (default) as above. `'model'` has the model give screenshot coordinates instead, so Revyl receives only device actions such as taps, typing and swipes, never element descriptions; it needs a model that points accurately.
- `maxTurns` (default 20, up to 100), `modelTimeout` per model call (default 60000), `maxImageSide` for screenshots sent to the model (default 1280).

## session.screenshot(options?)

Resolves with a PNG of the screen as a `Uint8Array`. With `options.path`, also writes it there, creating folders as needed.

## session.close()

Requests that Revyl stop the session. For web/mobile, success acknowledges the stop request rather than proving physical release. It is safe to call more than once, and steps after it throw `SESSION_ENDED`. A `Session` also works with `await using`, which closes it at the end of the block.

For owning computers, cleanup must be confirmed; a terminal state alone does not prove physical release. Uncertain release throws `ACTION_UNCERTAIN`. A non-owning attachment closes its children and local handle without requesting computer release.

## Computer commands, files, and processes

Mac sessions provide `exec(argv: string[], options?)`, `readFile(path, options?)` returning `Buffer`, `writeFile(path, string | Uint8Array, options?)`, `stat(path, options?)` returning `{ kind, size }`, `processes(options?)` returning `{ id, state, exitCode? }[]`, and `terminate(id, options?)`. They throw `NOT_AVAILABLE_ON_PLATFORM` on web/iOS/Android. See [computers.md](computers.md) for complete signatures, limits, timeouts, and examples. Both support `screenshot()`, and computers take `tap({ x, y })`, `screenSize()`, `typeFocused(text, { clear: false })` and `pressKey` on the screen (see [computers.md](computers.md#screen)); instruction/validation do not run on computers.

### `session.extend(timeoutMs: number): Promise<void>`

Computers only. Keeps a running computer going at least `timeoutMs` (whole seconds in milliseconds, from 60000 to 86400000) from now, up to 24 hours after it was created, and updates `expiresAt`. It never shortens the lifetime, so retrying is safe. Throws `COMPUTER_LIMIT` with reason `computer_long_limit` when the organization already has 2 computers running longer than 2 hours and `NOT_AVAILABLE_ON_PLATFORM` when the computer's host can't extend. Devices reject this call locally with `NOT_AVAILABLE_ON_PLATFORM`.

### `session.recording(): Promise<ComputerRecording | null>`

**Since 0.2.0.** This method is not available in 0.1.0.

Computers only. First reads the report and requires terminal state plus confirmed release, otherwise throws `SESSION_BUSY`. Returns `{ url: string, durationSeconds?: number, startedAt?: Date }` or null for an unavailable recording. Nullable optional wire fields are omitted. This method works after `close()`, does not wait for upload, and does not download or fetch the URL. Keep the signed HTTPS URL and its query private. Request fresh metadata when the URL expires. The normal report has no recording URL. Devices reject this call locally with `NOT_AVAILABLE_ON_PLATFORM`.

## Other session properties

| Property | Meaning |
| --- | --- |
| `viewerUrl` | The session in Revyl: a live view while it runs, its recording/report after. Use `revyl device report --session-id <id>` for web/mobile, or `revyl computer report <id>` for computers. |
| `id` | Revyl's session id |
| `platform` | `'web'`, `'ios'`, `'android'`, or `'mac'` |
| `expiresAt` | **Since 0.2.0.** Validated API expiry as a `Date`, or undefined for devices and older APIs. Computers have a hard lifetime from create (2 hours by default, up to 24 hours with `timeoutMs`); this value is the authoritative deadline, and `extend()` updates it. Operations/screenshot observation are bounded by expiry; close and recording remain possible. |
| `target` | The target name, or the platform for a target object |
| `closed` | Whether `close()` was called |

## Rules worth knowing

- **One step at a time.** Await each step before starting the next on the same session; a second concurrent step throws `INVALID_ARGUMENT`. Separate sessions can run in parallel.
- **No hidden retries.** Verify never repeats a step or a device action. A local agent retries only its own model calls. A step whose outcome is unknown because the connection failed mid-request throws `ACTION_UNCERTAIN`.
- **No memory between steps.** Each step is independent: Revyl does not carry values from one step to the next. Put everything a step needs into its text.
- **No replay or cache.** Every step runs its agent again, every time.

## Cleanup

While a session is open, Verify attempts best-effort cleanup with a 15-second budget:

- on Ctrl+C or SIGTERM: it attempts to close open sessions, then exits with 130 or 143 (a second Ctrl+C exits at once);
- on an uncaught error, such as a failed validation that nothing catches: it prints the error, attempts cleanup, then exits with 1;
- when the script finishes without calling `close()`: it attempts cleanup and prints a reminder.

Verify skips installing a signal or error handler when that event already has listeners, so test runners and apps that manage their own shutdown keep control of it. Always close in `try/finally` or an `after` hook; automatic cleanup cannot guarantee success. A process that is killed outright, or calls `process.exit()` with sessions open, leaves browser/mobile sessions running until their idle timeout (10 minutes by default). Computers have a hard lifetime from create instead (2 hours by default, up to 24 hours with `timeoutMs` or `extend()`; `expiresAt` is authoritative); no idle timeout is configurable.

## defineConfig(config)

Returns the config unchanged; it exists for type checking in `verify.config.ts`. See [configuration.md](configuration.md).

## Errors

Everything Verify throws on purpose is a `VerifyError` with a stable `code`; `isVerifyError(error)` narrows to it. See [errors.md](errors.md).
