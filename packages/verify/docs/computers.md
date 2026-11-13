# Mac computers

Verify opens a Revyl cloud macOS computer for commands, files, processes, screenshots, and clicks and keys on its screen. It does not open an assigned physical computer. Mac computers are available to organizations on a current paid Revyl plan. If yours can't start one, ask [support@revyl.ai](mailto:support@revyl.ai).

```bash
export REVYL_API_KEY=...
npx @revyl/verify init --platform mac
node verify/example.mts
```

`init` installs the package and checks credentials. Running the script starts a paid computer. No app id, build, device selector, image selector, or local Mac is needed. The generated script checks commands and a file round trip without agent steps.

Installed tools, paths, resources, and desktop dimensions are not fixed SDK guarantees.

## Commands and files

```ts
import { open } from '@revyl/verify';

const computer = await open({ platform: 'mac', startTimeout: 600_000 });
try {
  const result = await computer.exec(['uname', '-s']);
  console.log(result.stdout);
  await computer.writeFile('hello.txt', 'Hello!\n');
  const bytes = await computer.readFile('hello.txt');
  console.log(bytes.toString('utf8'));
  console.log(await computer.stat('hello.txt'));
  await computer.screenshot({ path: '.verify/mac.png' });
} finally {
  await computer.close();
}
```

| Call | Result |
| --- | --- |
| `exec(argv: string[], { timeout?, stdin?, check? }?)` | `{ exitCode: number, stdout: string, stderr: string }`. Output strings are UTF-8 decoded. Nonzero exit throws `COMMAND_FAILED` unless `check: false`. |
| `readFile(path, { timeout? }?)` | A `Buffer`, up to the first 1 MiB. Use this for exact binary bytes. |
| `writeFile(path, data: string \| Uint8Array, { timeout? }?)` | `void`. Strings are UTF-8 encoded. Writes up to 64 KiB. |
| `stat(path, { timeout? }?)` | `{ kind: 'file' \| 'directory', size: number }`, with size in bytes. |
| `processes({ timeout? }?)` | Up to 64 `{ id: string, state: 'running' \| 'exited', exitCode?: number }` entries from commands on this computer. |
| `terminate(id, { timeout? }?)` | `void` after confirmed termination. Use an id from `processes()`, not an operating-system PID. |
| `screenshot({ path? }?)` | PNG `Uint8Array`; optionally saves it locally. |

`exec` takes structured argv, not a shell line. For shell syntax, explicitly invoke a shell, such as `['/bin/sh', '-c', 'printf hello']`. Never interpolate untrusted input into shell text. `stdin` accepts a string or `Uint8Array`. At most 64 arguments and 16,384 UTF-8 argv plus stdin bytes are allowed. Revyl keeps only the first 1 MiB of combined stdout/stderr; the command still runs to completion. Commands are synchronous at the library boundary; there is no interactive terminal or background-process creation API.

Paths are relative to the computer's workspace: no leading slash, empty components, `.` or `..`, backslashes, colons, or control characters. A path is at most 1,024 UTF-8 bytes. To make a directory, run a command such as `['mkdir', '-p', 'output']` before writing into it. There is no recursive sync or snapshot API.

Operation `timeout` is milliseconds, defaults to 30,000, and must be an integer from 1 to 300,000. It is also bounded by the run's remaining lifetime. A computer has a hard lifetime **from create** (two hours today; `expiresAt` is authoritative), not from readiness or last activity; `idleTimeoutSeconds` and the agent `stepTimeout` do not configure computer lifetime or commands. `expiresAt` is a `Date` when the API returns `expires_at`, and otherwise undefined (including on devices and older APIs). Verify refuses new operations after that deadline and bounds operation/screenshot observation by it; expiry does not prevent explicit close or recording retrieval. Revyl allows at most 256 operations per run.

## Screen

**Early access**, since TypeScript 0.6.0, Python 0.4.0 and Go v0.5.0. A script can click, type and press keys on the computer's screen, at points it reads off `screenshot()` or at elements it describes:

```ts
import { open } from '@revyl/verify';

const computer = await open({ platform: 'mac', startTimeout: 600_000 });
try {
  await computer.writeFile('notes.txt', 'Notes\n');
  await computer.exec(['open', '-a', 'TextEdit', 'notes.txt']);   // exec runs in the workspace
  await new Promise((resolve) => setTimeout(resolve, 3_000));      // let the window open
  await computer.screenshot({ path: '.verify/mac.png' });           // open it and find the text
  await computer.tap({ x: 400, y: 300 });                           // the point as you read it
  await computer.typeFocused('First line\nSecond line', { clear: false });
  await computer.pressKey('a', { modifiers: ['meta'] });            // Command+A selects all
  await computer.typeFocused('Replacement', { clear: false });      // typing replaces the selection
  await computer.screenshot({ path: '.verify/mac-after.png' });
} finally {
  await computer.close();
}
```

| Call | What it does |
| --- | --- |
| `screenshot({ path? })` | A PNG of the whole screen. Its pixels are the coordinates the other calls take |
| `screenSize()` | The screenshot's `{ width, height }`: x is 0 to width - 1, y is 0 to height - 1 |
| `tap({ x, y })` | Clicks the point with the left button and resolves with it. Whole numbers from the top-left corner of the screenshot |
| `tap({ target })` | Revyl finds the described element on a fresh screenshot, clicks it, and resolves with the point it clicked, in screenshot pixels. The description is 1 to 500 characters. Takes several seconds |
| `typeFocused(text, { clear: false })` | Types the text where the cursor is, in the app that has focus. `{ clear: false }` is required, because Verify doesn't clear anything first: to replace text, select it with `pressKey('a', { modifiers: ['meta'] })` and type over it. Up to 16,384 characters, including line breaks (`\n`) and tabs (`\t`); other control characters are refused before anything is typed. Long text goes in pieces of up to 500 characters, in order |
| `pressKey(key, { modifiers })` | Presses a key: `'enter'`, `'backspace'`, `'tab'`, `'escape'`, `'delete'`, `'space'`, `'arrowup'`, `'arrowdown'`, `'arrowleft'`, `'arrowright'`, `'home'`, `'end'`, `'pageup'` or `'pagedown'`, with up to four `modifiers`: `'meta'` (Command), `'ctrl'`, `'alt'` (Option) and `'shift'`. With modifiers a lowercase letter or digit works too, so Command+A is `pressKey('a', { modifiers: ['meta'] })`. On Web the shortcut key is `'ctrl'` instead |

`locate()` isn't available on computers, because Revyl can't find a point there without clicking it; `tap({ target })` returns the point it clicked instead. `doubleTap`, `longPress`, `type(location, text)`, `swipe`, `drag`, `back`, `goHome`, `openUrl` and `launchApp` aren't available on computers either, and a description works only in `tap`. They throw `NOT_AVAILABLE_ON_PLATFORM` before anything is sent; open apps and files with `exec()`, such as `exec(['open', '-a', 'TextEdit', 'notes.txt'])`. For TextEdit, open a file rather than the bare app: opened without a file, it may show a file picker instead of a document.

### Described clicks

```ts
const point = await computer.tap({ target: 'the Help menu in the menu bar' });   // several seconds
await computer.screenshot({ path: '.verify/help.png' });                       // check what it clicked
```

A described click takes several seconds, because Revyl takes a screenshot and finds the element first. It can pick a look-alike, and when the target isn't on the screen it can still click something else instead of failing. So check the point it returns or take a screenshot afterwards, and for anything that's hard to undo, read the point off `screenshot()` and use `tap({ x, y })`.

### Behaviour and errors

Each call returns when Revyl has accepted the action, not when the app has finished reacting, so take a screenshot before you rely on what changed. Verify never repeats a screen action, with one exception: when Revyl answers `screen_starting`, nothing happened, so Verify waits as long as Revyl asks and tries again, for up to 30 seconds. Window positions and the desktop size aren't fixed, so for a script that runs unattended, run it once up to the screenshot, read the points off that image, and then write them into the script.

A script that controls the screen keeps control for 120 seconds after its last action. During that time a teammate can't take control of the screen in the Revyl viewer. The other way round, while someone controls the screen in the viewer, the script's actions throw `SESSION_BUSY`.

| What happened | Error | What to do |
| --- | --- | --- |
| A point past the screen's edge (`screen_point_outside`), or a negative or fractional one | `INVALID_ARGUMENT`, and nothing was clicked | The message names the valid range |
| `typeFocused` without `{ clear: false }`, with control characters other than `\n` and `\t`, or with more than 16,384 characters | `INVALID_ARGUMENT` before anything is sent | The message says how to fix the call |
| The computer can't type some of the characters (`screen_text_unsupported`) | `INVALID_ARGUMENT`, and nothing was typed | Type those characters another way, such as writing a file with `writeFile` |
| Someone controls the screen in the viewer (`screen_control_held`) | `SESSION_BUSY`, and nothing happened | Try again after they release it; control frees itself after 2 minutes without input |
| Control of the screen changed hands before the action was sent (`screen_control_lost`) | `SESSION_BUSY`, and nothing happened | Try again; if someone controls the screen in the viewer, wait until they release it |
| The computer refused a click at a point (`invalid_request` on `tap({ x, y })`), as when the point is no longer on its screen after its display size changed | `INVALID_ARGUMENT`, and nothing was clicked | Take a new screenshot and pick the point from it |
| The computer refused typing or a key (`invalid_request`) | `INVALID_ARGUMENT`; part of it may have run | Take a `screenshot()` before you try again |
| The computer can't press that key (`screen_key_unsupported`) | `INVALID_ARGUMENT`, and nothing was pressed | Use a key `pressKey` lists, or `typeFocused` for a printable character |
| The screen is still starting (`screen_starting`) for more than 30 seconds | `SESSION_BUSY`, and nothing happened | Try again after the number of seconds the message names |
| Revyl didn't find the described target (`screen_target_not_found`) | `ACTION_FAILED`, and nothing was clicked | Take a screenshot and pass a point to `tap({ x, y })`, or describe the element differently |
| Revyl couldn't look the target up just then (`screen_target_unavailable`) | `API_ERROR`, and nothing was clicked | It is safe to try again |
| The backend doesn't have described clicks yet (`invalid_request` on a described tap) | `NOT_AVAILABLE_ON_PLATFORM`, and nothing was clicked | Pass a point to `tap({ x, y })` |
| Revyl can't confirm the action (`screen_input_uncertain`, `screen_unavailable`, `screen_input_unavailable` or `owner_unavailable`, any other HTTP 5xx, or no answer at all) | `ACTION_UNCERTAIN` | It may have happened. Take a `screenshot()` before you do it again |
| The API key may not control the screen (HTTP 403) | `AUTH_REJECTED` | The key's owner needs the Member role or above. CI runner keys can't control the screen yet |
| Revyl couldn't check the key (HTTP 503 `authentication_unavailable`) | `API_ERROR`, and nothing happened | It is safe to try again |

When long text fails part way, the error says how many characters were certainly typed and whether the piece that failed may have been typed, counting characters as Unicode code points, so an emoji is one. Every other refusal names its reason and what to do next, such as starting a new computer after `run_closed`.

## Recording metadata

After terminal state **and** confirmed release, `await computer.recording()` returns `{ url, durationSeconds?, startedAt? }` or `null` if the recording is unavailable or still processing. `durationSeconds` is a finite nonnegative number; `startedAt` is a `Date`. Missing or nullable optional fields are omitted. Calling before terminal state and confirmed release throws `SESSION_BUSY`; Verify does not wait for the recording or download it. The method works after `close()` and checks the report before requesting the recording.

The HTTPS URL is signed and short-lived. Keep it private, including its query string; do not log or publish it. Call `recording()` again when a fresh URL is needed. The report carries no recording URL; `viewerUrl` remains a Revyl UI link, not a download URL. Web/mobile sessions reject `recording()` locally with `NOT_AVAILABLE_ON_PLATFORM`.

## Availability and errors

Mac computers are available to organizations on a current paid Revyl plan. A `503 runtime_unavailable` or typed `computer_not_enabled` becomes `NOT_AVAILABLE_ON_PLATFORM` with this availability guidance. A `429 computer_limit` becomes `COMPUTER_LIMIT`: queued work (including iOS) or the concurrency limit can cause it, and the response does not identify which. Verify does not retry the create or send a stop after these definite admission refusals. `operation_limit` remains `SESSION_BUSY`. Availability is determined by the server.

The default `startTimeout` remains 600000 ms; override it explicitly if needed. An unclaimed start can transition to `failed` with `failure_reason: 'no_host'` after 120 seconds from create. Verify stops readiness polling and throws `SESSION_START_FAILED` with that context, then attempts bounded cleanup. This is not a 120-second timeout for every start: claimed guests may take longer. `device_limit` also yields `SESSION_START_FAILED`, with queued-work/concurrency context. A start timeout or unconfirmed close does not prove resources were released. Inspect the session and contact support rather than blindly repeating a start or stop.

`instruction()` and `validation()` throw `NOT_AVAILABLE_ON_PLATFORM` on computers without sending agent requests. Screenshots are supported, but screenshot readiness is separate from command readiness. For the screen, use the calls in [Screen](#screen). On web, iOS, and Android, shell/file/process methods throw `NOT_AVAILABLE_ON_PLATFORM`.

For the first 30 seconds after a computer becomes active, `screenshot()` retries exact structured `screen_unavailable` responses (HTTP 409 or 503) and `screen_starting` (HTTP 409). Backoff starts at 500 ms and doubles up to 2 seconds; the fixed window does not restart on each call. Cancellation, close, expiry, and the observation deadline still bound the wait. Exhausting that window yields `SESSION_BUSY` with a desktop-not-ready message, rather than requiring a caller sleep. Authentication failures, unrelated errors, malformed responses, and transport failures are not replayed. Commands and other mutations are never retried by this screenshot behavior.

Missing files and access denials throw `NOT_FOUND` and `ACCESS_DENIED`. An operation timeout with confirmed termination throws `TIMEOUT`; unconfirmed termination or execution throws `ACTION_UNCERTAIN`. Neither implies rollback. Execution outcome, evidence recording, and physical release are independent: an observed successful command can return its result while logging pending/failed report evidence. Do not repeat a mutation merely because its response was lost. Check the computer in Revyl before deciding what to do next. See [errors.md](errors.md).

## Lifecycle and transport

Use `attach(computerId)` to take cleanup ownership of an existing active computer without creating one. `computer.open(target)` starts Web and iOS children on a Mac. A child requires an existing app/build pair and inherits the parent's client and expiry. Parent close attempts child cleanup for at most five seconds before requesting computer release; the server also stops remaining children. See [the hosted API](api.md#computeropentarget) for arguments, localhost navigation, and cleanup semantics. These are app sessions, not natural-language control of the computer desktop itself.

For a computer owned by another caller, such as a CI runner, use `attach(computerId, { stopOnClose: false })`. It is not registered for automatic cleanup. Explicit close still cancels pending child starts and closes hosted children within the five-second cleanup phase, but never sends a stop for the computer. The computer's owner is responsible for releasing it; a child-cleanup failure does not authorize stopping the parent.

Verify mints a session UUID, creates `/api/v1/computer-runs` with `os: 'macos'` for `platform: 'mac'`, then polls `GET /computer-runs/{id}/report` until `state: 'active'`, which means it is ready. `starting` alone is not readiness. The public Mac target spelling is `mac`, not `macos`.

Each command is submitted once to `/computer-runs/{id}/operations` with its own UUID `request_id` and `Prefer: respond-async`. The operation id is UUIDv5 with the computer UUID as namespace and the request UUID string as name. A `202` response has JSON `null`; Verify reads the operation by id until it settles instead of submitting it again.

**Breaking wire change:** Verify 0.3.0 requires the encoded-only backend, which is already live on revyl.ai. Computer arguments use `argv_b64`, one padded URL-safe base64 string per UTF-8 argument, and file paths use `path_b64`; the request omits raw `argv` and `path`. Public APIs and decoded input limits are unchanged. Existing `stdin` and file `data` fields remain standard base64, and process commands are unchanged. This encoding is not encryption. Screenshot uses standard base64 PNG.

Verify bounds operation observation to the earlier of 310 seconds or the returned expiry, and explicit stop requests to 310 seconds independently of expiry. This is separate from the command's `timeout`: the backend may hold the async submission for 60 seconds before returning `202`. Automatic process-exit cleanup has a shorter 15-second budget and is best effort; use explicit `await close()` in `finally` to observe confirmed release.

For an owning attachment, `close()` posts `/computer-runs/{id}/stop`, and the same automatic process cleanup as other sessions applies. A non-owning attachment never sends that stop. Always close in `finally` or use `await using` so hosted children are cleaned up. A terminal state alone is not confirmed physical release. Keep computer output and screenshots private: they can contain application data and credentials. Verify does not log file contents, argv, stdin, or command output automatically.
