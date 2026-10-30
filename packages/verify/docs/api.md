# API

```ts
import { attach, open, defineConfig, VerifyError, isVerifyError } from '@revyl/verify';
```

## open(target, options?)

Linux targets are supported **since 0.2.0**; 0.1.0 includes the target type but rejects Linux locally.

Starts a Revyl cloud browser, device, or Mac or Linux computer. Mobile first-screen readiness is [best-effort](mobile.md#steps), not a foreground/rendered-readiness guarantee. Computer starts retain a 10-minute default timeout; an unclaimed start may fail after 120 seconds with no-host context.

Both computer operating systems are early access. Ask support@revyl.ai about access.

```ts
const web = await open('web');                                       // a target named in verify.config.ts
const ios = await open({ platform: 'ios', app: { appId: '…' } });    // or a target object, no config needed
const mac = await open({ platform: 'mac' });                        // computer, no app needed
const linux = await open({ platform: 'linux' });                    // same computer surface
```

- `target`: a target name from `verify.config.ts`, or a target object with the same shape as a config entry (see [configuration.md](configuration.md)). Verify reads the nearest `verify.config.ts` at or above the current folder.
- `options.config`: the path of a config file to read instead.
- `options.log`: where progress lines go. By default Verify writes the session link and each step's outcome to stderr, prefixed with `[verify]`. Pass a function to receive the lines yourself, or `false` to turn them off.

`open` needs credentials: `REVYL_API_KEY` or a Revyl CLI login. It throws `AUTH_MISSING` without them, `CONFIG_NOT_FOUND` or `CONFIG_INVALID` for config problems, and `SESSION_START_FAILED` or `TIMEOUT` when the browser or device does not start.

## Inside a revyl-macos GitHub Actions job

`currentComputer(options?)` attaches to `REVYL_COMPUTER_ID` using normal credential resolution. It is non-owning by default: close cleans up hosted children, while the job's owner releases the computer. It never creates a computer and throws `COMPUTER_ID_MISSING` when the ID is unset or blank. Invalid IDs fail with `INVALID_ARGUMENT`.

This helper requires a release containing it and a runner configured to inject `REVYL_COMPUTER_ID` and a short-lived `REVYL_API_KEY`. It is not in the published TypeScript 0.2.0 package. A workflow can supply its own `REVYL_API_KEY` instead. After installing the project dependencies and selecting Node.js ≥22.18, add this step to a job with `runs-on: revyl-macos`:

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

The attachment, hosted-child and navigation APIs below are new in the unreleased source; they are not in the published TypeScript 0.2.0 package.

`open()` and `computer.open()` return the extended `OpenedSession` interface. The original `Session` interface keeps its existing required members, so applications implementing or mocking it do not need to add the new methods. Use `OpenedSession` when explicitly annotating a value that calls `report`, `navigate` or `open`.

Attaches to an active Mac or Linux computer in your organization without creating a new one. `options.log` controls progress. The returned computer owns cleanup by default: `close()` stops it, and automatic cleanup also applies. Attaching requires a valid expiry and does not extend the lifetime. Invalid, inaccessible, inactive or expired computers fail without sending a stop request.

When attaching to a computer you do not own, such as a CI runner, pass `attach(computerId, { stopOnClose: false })`. The attachment is not registered for automatic cleanup. Its `close()` still cancels pending child starts and gives hosted children the same five-second cleanup phase, but never stops the computer; its owner must release it. Child cleanup failures remain observable. This option is explicit and is never inferred from the environment.

## computer.open(target)

Starts a child app session inside this computer, returning the normal session API. It inherits the parent's authenticated client, logging and step timeout; callers cannot route a child to another backend. Both `target.app.appId` and `target.app.buildId` are required. Web accepts an existing external HTTPS build, plus optional viewport/sign-in settings; native builds use the computer's fixed device profile and accept no bundle, artifact or device override. Named targets and initial URL overrides are not supported here.

Mac supports Web and iOS children. Linux supports Android and may support Web when its runtime advertises that capability; Linux Web currently has a runtime limitation, so do not rely on it without confirming availability. The server remains authoritative for access, capability and capacity. Children require and share the parent's known deadline. Closing a child leaves the parent running; closing the parent cancels pending starts and gives child cleanup at most five seconds total before requesting confirmed computer release. The parent stop also stops any remaining children, so a slow child cannot prevent that request. A failed child start never closes the parent.

```ts
const computer = await attach(existingComputerId, { log: false });
try {
  const web = await computer.open({
    platform: 'web',
    app: { appId: webAppId, buildId: externalBuildId },
  });
  await web.navigate('http://localhost:3000');
  await web.validation('The home page is visible');
} finally {
  await computer.close();
}
```

This requires an already-running service on the computer. The initial Web build still uses HTTPS; navigation after start can reach the computer's localhost. No localhost-start option is implied.

## session.navigate(url)

Web only, hosted or normal. Sends one deterministic `open_url` action and checks the returned navigation outcome. Accepts an HTTP(S) URL without credentials, whitespace, control characters or backslashes. Loopback addresses are accepted on every Web session: a hosted browser can reach its parent computer's loopback address; a normal cloud browser's localhost is its own runtime, not your machine. A cold development server may need a warm-up request before navigation succeeds; after an uncertain timeout, re-navigating is the caller's choice because the original request may still commit. The runtime is responsible for enforcing its navigation network policy. Navigation is not replayed by Verify and does not run an agent step. It resolves with no value, or throws a typed error. Computer and native sessions reject it locally.

## session.report()

Returns authenticated JSON metadata: `/execution/device-sessions/{id}` for normal and hosted app sessions, or the computer report for computers. It works after close, but fails locally with `NOT_FOUND` when no session ID is known. It does not download recordings or turn a device stop acknowledgment into proof of physical release. Treat returned metadata as private.

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

When inspecting `revyl device report --session-id <id>`, read validation verdicts from the step's `effective_status` and `validation_result`, with `validations_passed` / `total_validations` for the validation summary. `passed_steps` / `failed_steps` and transport `status` are not enough: a successfully executed validation can have a false verdict. The SDK's `StepResult.passed` reflects that verdict, not just transport success.

## session.screenshot(options?)

Resolves with a PNG of the screen as a `Uint8Array`. With `options.path`, also writes it there, creating folders as needed.

## session.close()

Requests that Revyl stop the session. For web/mobile, success acknowledges the stop request rather than proving physical release. It is safe to call more than once, and steps after it throw `SESSION_ENDED`. A `Session` also works with `await using`, which closes it at the end of the block.

For owning computers, cleanup must be confirmed; a terminal state alone does not prove physical release. Uncertain release throws `ACTION_UNCERTAIN`. A non-owning attachment closes its children and local handle without requesting computer release.

## Computer commands, files, and processes

Mac and Linux sessions provide `exec(argv: string[], options?)`, `readFile(path, options?)` returning `Buffer`, `writeFile(path, string | Uint8Array, options?)`, `stat(path, options?)` returning `{ kind, size }`, `processes(options?)` returning `{ id, state, exitCode? }[]`, and `terminate(id, options?)`. They throw `NOT_AVAILABLE_ON_PLATFORM` on web/iOS/Android. See [computers.md](computers.md) for complete signatures, limits, timeouts, and examples. Both support `screenshot()`; instruction/validation do not run on computers.

### `session.recording(): Promise<ComputerRecording | null>`

**Since 0.2.0.** This method is not available in 0.1.0.

Computers only. First reads the report and requires terminal state plus confirmed release, otherwise throws `SESSION_BUSY`. Returns `{ url: string, durationSeconds?: number, startedAt?: Date }` or null for an unavailable recording. Nullable optional wire fields are omitted. This method works after `close()`, does not wait for upload, and does not download or fetch the URL. Keep the signed HTTPS URL and its query private. Request fresh metadata when the URL expires. The normal report has no recording URL. Devices reject this call locally with `NOT_AVAILABLE_ON_PLATFORM`.

## Other session properties

| Property | Meaning |
| --- | --- |
| `viewerUrl` | The session in Revyl: a live view while it runs, its recording/report after. Use `revyl device report --session-id <id>` for web/mobile, or `revyl computer report <id>` for computers. |
| `id` | Revyl's session id |
| `platform` | `'web'`, `'ios'`, `'android'`, `'mac'`, or `'linux'` |
| `expiresAt` | **Since 0.2.0.** Validated API expiry as a `Date`, or undefined for devices and older APIs. Computers have a hard 60-minute lifetime from create. Operations/screenshot observation are bounded by expiry; close and recording remain possible. |
| `target` | The target name, or the platform for a target object |
| `closed` | Whether `close()` was called |

## Rules worth knowing

- **One step at a time.** Await each step before starting the next on the same session; a second concurrent step throws `INVALID_ARGUMENT`. Separate sessions can run in parallel.
- **No hidden retries.** Verify never repeats a step or a device action. A step whose outcome is unknown because the connection failed mid-request throws `ACTION_UNCERTAIN`.
- **No memory between steps.** Each step is independent: Revyl does not carry values from one step to the next. Put everything a step needs into its text.
- **No replay or cache.** Every step runs Revyl's agent again, every time.

## Cleanup

While a session is open, Verify attempts best-effort cleanup with a 15-second budget:

- on Ctrl+C or SIGTERM: it attempts to close open sessions, then exits with 130 or 143 (a second Ctrl+C exits at once);
- on an uncaught error, such as a failed validation that nothing catches: it prints the error, attempts cleanup, then exits with 1;
- when the script finishes without calling `close()`: it attempts cleanup and prints a reminder.

Verify skips installing a signal or error handler when that event already has listeners, so test runners and apps that manage their own shutdown keep control of it. Always close in `try/finally` or an `after` hook; automatic cleanup cannot guarantee success. A process that is killed outright, or calls `process.exit()` with sessions open, leaves browser/mobile sessions running until their idle timeout (10 minutes by default). Computers have a server-bounded one-hour lifetime instead; no idle timeout is configurable.

## defineConfig(config)

Returns the config unchanged; it exists for type checking in `verify.config.ts`. See [configuration.md](configuration.md).

## Errors

Everything Verify throws on purpose is a `VerifyError` with a stable `code`; `isVerifyError(error)` narrows to it. See [errors.md](errors.md).
