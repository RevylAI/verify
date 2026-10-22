# API

```ts
import { open, defineConfig, VerifyError, isVerifyError } from '@revyl/verify';
```

## open(target, options?)

Starts a Revyl cloud browser, device, or Mac computer and resolves with a `Session` once it is ready. Starting usually takes from a few seconds to a couple of minutes. Linux targets are accepted in config/types but opening them throws `NOT_AVAILABLE_ON_PLATFORM` before credentials or network access.

```ts
const web = await open('web');                                       // a target named in verify.config.ts
const ios = await open({ platform: 'ios', app: { appId: '…' } });    // or a target object, no config needed
const mac = await open({ platform: 'mac' });                        // computer, no app needed
```

- `target`: a target name from `verify.config.ts`, or a target object with the same shape as a config entry (see [configuration.md](configuration.md)). Verify reads the nearest `verify.config.ts` at or above the current folder.
- `options.config`: the path of a config file to read instead.
- `options.log`: where progress lines go. By default Verify writes the session link and each step's outcome to stderr, prefixed with `[verify]`. Pass a function to receive the lines yourself, or `false` to turn them off.

`open` needs credentials: `REVYL_API_KEY` or a Revyl CLI login. It throws `AUTH_MISSING` without them, `CONFIG_NOT_FOUND` or `CONFIG_INVALID` for config problems, and `SESSION_START_FAILED` or `TIMEOUT` when the browser or device does not start.

## session.instruction(text, options?)

Available on web/iOS/Android only. Computers throw `NOT_AVAILABLE_ON_PLATFORM` without sending an agent request.

Asks Revyl's agent to do something in the app, described the way you would tell a person: `'Sign in as the demo user and open Settings'`. The agent looks at the screen and acts until it is done or decides it cannot.

- Resolves with a `StepResult` when the agent finishes.
- Throws `INSTRUCTION_FAILED`, with Revyl's reason and the session link, when it cannot, and `STEP_FAILED` when the step is cancelled on Revyl.
- `options.timeout`: milliseconds before the step is cancelled on Revyl (`TIMEOUT`). Defaults to `stepTimeout` in the config, or 180000.

## session.validation(text, options?)

Available on web/iOS/Android only, not computers.

Asks Revyl's agent whether something holds on screen right now: `'The cart shows 2 items and a total of $40'`.

- Resolves with a `StepResult` whose `passed` is `true` when it holds.
- Throws `VALIDATION_FAILED`, with Revyl's reason and the session link, when it does not. This is what makes a plain script exit non-zero.
- Throws `STEP_FAILED` when Revyl cannot reach a verdict, for example because the step errored or was cancelled on Revyl.
- `options.soft: true` returns a failed result instead of throwing `VALIDATION_FAILED`, for scripts that want to collect several outcomes. It does not turn `STEP_FAILED` into a result.
- `options.timeout`: as for `instruction`.

## StepResult

```ts
interface StepResult {
  type: 'instruction' | 'validation';
  text: string;          // the step as sent, trimmed
  passed: boolean;
  reason?: string;       // Revyl's explanation, when it gave one
  durationMs: number;
}
```

`session.steps` lists every step run on the session, in order.

## session.screenshot(options?)

Resolves with a PNG of the screen as a `Uint8Array`. With `options.path`, also writes it there, creating folders as needed.

## session.close()

Stops the session on Revyl. It is safe to call more than once, and steps after it throw `SESSION_ENDED`. A `Session` also works with `await using`, which closes it at the end of the block.

For computers, cleanup must be confirmed; a terminal state alone does not prove physical release. Uncertain release throws `ACTION_UNCERTAIN`.

## Computer commands, files, and processes

Mac sessions provide `exec(argv: string[], options?)`, `readFile(path, options?)` returning `Buffer`, `writeFile(path, string | Uint8Array, options?)`, `stat(path, options?)` returning `{ kind, size }`, `processes(options?)` returning `{ id, state, exitCode? }[]`, and `terminate(id, options?)`. They throw `NOT_AVAILABLE_ON_PLATFORM` on web/iOS/Android. See [computers.md](computers.md) for complete signatures, limits, timeouts, and examples. Mac also supports `screenshot()`; instruction/validation do not run on computers.

## Other session properties

| Property | Meaning |
| --- | --- |
| `viewerUrl` | The session in Revyl: a live view while it runs, its recording/report after. Use `revyl device report --session-id <id>` for web/mobile, or `revyl computer report <id>` for computers. |
| `id` | Revyl's session id |
| `platform` | `'web'`, `'ios'`, `'android'`, `'mac'`, or the reserved `'linux'` type (opening Linux is unavailable) |
| `target` | The target name, or the platform for a target object |
| `closed` | Whether `close()` was called |

## Rules worth knowing

- **One step at a time.** Await each step before starting the next on the same session; a second concurrent step throws `INVALID_ARGUMENT`. Separate sessions can run in parallel.
- **No hidden retries.** Verify never repeats a step or a device action. A step whose outcome is unknown because the connection failed mid-request throws `ACTION_UNCERTAIN`.
- **No memory between steps.** Each step is independent: Revyl does not carry values from one step to the next. Put everything a step needs into its text.
- **No replay or cache.** Every step runs Revyl's agent again, every time.

## Cleanup

While a session is open, Verify closes it before the process ends:

- on Ctrl+C or SIGTERM: it closes open sessions, then exits with 130 or 143 (a second Ctrl+C exits at once);
- on an uncaught error, such as a failed validation that nothing catches: it prints the error, closes open sessions, then exits with 1;
- when the script finishes without calling `close()`: it closes the sessions and prints a reminder.

Verify only takes over a signal or error event that nothing else in the process listens to, so test runners and apps that manage their own shutdown keep control of it; there, close sessions in `finally` or an `after` hook. A process that is killed outright, or calls `process.exit()` with sessions open, leaves browser/mobile sessions running until their idle timeout (10 minutes by default). Computers have a server-bounded one-hour lifetime instead; no idle timeout is configurable.

## defineConfig(config)

Returns the config unchanged; it exists for type checking in `verify.config.ts`. See [configuration.md](configuration.md).

## Errors

Everything Verify throws on purpose is a `VerifyError` with a stable `code`; `isVerifyError(error)` narrows to it. See [errors.md](errors.md).
