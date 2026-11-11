# API

```ts
import { attach, open, defineConfig, VerifyError, isVerifyError } from '@revyl/verify';
```

## open(target, options?)

Starts a Revyl cloud browser, device, or Mac computer. Mobile first-screen readiness is [best-effort](mobile.md#steps), not a foreground/rendered-readiness guarantee. Computer starts retain a 10-minute default timeout; an unclaimed start may fail after 120 seconds with no-host context.

Mac computers are early access. Ask support@revyl.ai about access.

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

`open` needs credentials: `REVYL_API_KEY` or a Revyl CLI login. It throws `AUTH_MISSING` without them, `CONFIG_NOT_FOUND` or `CONFIG_INVALID` for config problems, and `SESSION_START_FAILED` or `TIMEOUT` when the browser or device does not start.

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

Attaches to an active Mac computer in your organization without creating a new one. `options.log` controls progress. The returned computer owns cleanup by default: `close()` stops it, and automatic cleanup also applies. Attaching requires a valid expiry and does not extend the lifetime. Invalid, inaccessible, inactive or expired computers fail without sending a stop request.

When attaching to a computer you do not own, such as a CI runner, pass `attach(computerId, { stopOnClose: false })`. The attachment is not registered for automatic cleanup. Its `close()` still cancels pending child starts and gives hosted children the same five-second cleanup phase, but never stops the computer; its owner must release it. Child cleanup failures remain observable. This option is explicit and is never inferred from the environment.

## computer.open(target)

Starts a child app session inside this computer, returning the normal session API. It inherits the parent's authenticated client, logging and step timeout; callers cannot route a child to another backend. Both `target.app.appId` and `target.app.buildId` are required. Web accepts an existing external HTTPS build, plus optional viewport/sign-in settings; native builds use the computer's fixed device profile and accept no bundle, artifact or device override. Named targets and initial URL overrides are not supported here.

Mac supports Web and iOS children. The server remains authoritative for access, capability and capacity. Children require and share the parent's known deadline. Closing a child leaves the parent running; closing the parent cancels pending starts and gives child cleanup at most five seconds total before requesting confirmed computer release. The parent stop also stops any remaining children, so a slow child cannot prevent that request. A failed child start never closes the parent.

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

## Exact actions

**Since 0.4.0. Early access.** In TypeScript (`@revyl/verify` 0.4.0), Python (`revyl-verify` 0.2.0) and Go (v0.3.0); the [Python](https://github.com/RevylAI/verify/blob/v0.4.0/python/README.md#exact-actions) and [Go](https://github.com/RevylAI/verify/blob/v0.4.0/go/README.md#exact-actions) READMEs show them with each language's names. Web, iOS and Android sessions take device actions that need no agent.

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `tap`, `type`, `swipe`, `pressKey`, `locate`, `screenSize` | Yes | Yes | Yes | No, use `exec()` and files |
| `back()` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `openUrl(url)` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `launchApp(bundleId)` | No, use `openUrl` or `navigate` | Yes | Yes | No |
| `navigate(url)` | Yes | No, use `openUrl` | No, use `openUrl` | No |
| `instruction`, `validation`, your own model | Yes | Yes | Yes | No, use `exec()` |
| `screenshot()` | Yes | Yes | Yes | Yes |
| `exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

Coordinates are in iOS points, Android pixels and Web CSS pixels, from the top-left corner. A call a platform doesn't support throws `NOT_AVAILABLE_ON_PLATFORM`, and its message names the alternative.

A location is `{ x, y }` in device units (iOS points, Android and Web pixels, from the top-left corner; `screenSize()` gives the bounds) or `{ target: 'Login button' }`, which Revyl's grounding model finds on the current screen.

| Call | What it does |
| --- | --- |
| `tap(at)` | Taps and resolves with the point tapped |
| `type(at, text, { clear })` | Taps a text field and types into it, clearing it first unless `clear` is `false` |
| `swipe(direction, { from })` | Swipes from a location or the screen's center; `'up'` moves the finger up, which scrolls content down |
| `pressKey('enter' \| 'backspace')` | Presses a key on the focused field |
| `back()` | Browser history on Web, the back button on Android; iOS throws `NOT_AVAILABLE_ON_PLATFORM` |
| `openUrl(url)` | Opens a URL or deep link on a device, or loads a URL in a browser |
| `launchApp(bundleId)` | Launches an installed app on a device |
| `locate(target)` | Resolves with Revyl's best match on the current screen, without acting |
| `screenSize()` | Resolves with `{ width, height }` in device units |

A failed action throws `ACTION_FAILED`, including when Revyl cannot find a target or nothing at a point can take the action. One whose outcome Revyl can't confirm throws `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. If Verify can't reach Revyl, the action fails with `API_ERROR` and isn't resent either, so check the session before trying it again.

Exact actions return when Revyl has accepted them, not when the screen has finished changing. After `swipe`, `openUrl` or `launchApp`, let the screen settle or check it before you `locate` or tap coordinates. `locate` returns Revyl's best match on the current screen and can return a point for an element that is off screen, so bring the element on screen first and check the point before you use it.

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
  reason?: string;       // Revyl's explanation, or your model's on a local agent
  durationMs: number;
  model?: ModelRun;      // set when the step ran on your model
}
```

`session.steps` lists every step run on the session, in order.

When inspecting `revyl device report --session-id <id>`, read validation verdicts from the step's `effective_status` and `validation_result`, with `validations_passed` / `total_validations` for the validation summary. `passed_steps` / `failed_steps` and transport `status` are not enough: a successfully executed validation can have a false verdict. The SDK's `StepResult.passed` reflects that verdict, not just transport success.

## Your own model

**Since 0.4.0. Early access.** In TypeScript (`@revyl/verify` 0.4.0), Python (`revyl-verify` 0.2.0) and Go (v0.3.0); the [Python](https://github.com/RevylAI/verify/blob/v0.4.0/python/README.md#your-own-model) and [Go](https://github.com/RevylAI/verify/blob/v0.4.0/go/README.md#your-own-model) READMEs show them with each language's names. Runs instructions and validations on a model you choose, in your process, instead of Revyl's agent. Revyl still provides the browser or device. Leave `model` out and Revyl's agent runs the step, as before.

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
- `grounding`: `'revyl'` (default) as above. `'model'` has the model give screenshot coordinates instead, so Revyl receives only taps, typing and swipes, never element descriptions; it needs a model that points accurately.
- `maxTurns` (default 20, up to 100), `modelTimeout` per model call (default 60000), `maxImageSide` for screenshots sent to the model (default 1280).

## session.screenshot(options?)

Resolves with a PNG of the screen as a `Uint8Array`. With `options.path`, also writes it there, creating folders as needed.

## session.close()

Requests that Revyl stop the session. For web/mobile, success acknowledges the stop request rather than proving physical release. It is safe to call more than once, and steps after it throw `SESSION_ENDED`. A `Session` also works with `await using`, which closes it at the end of the block.

For owning computers, cleanup must be confirmed; a terminal state alone does not prove physical release. Uncertain release throws `ACTION_UNCERTAIN`. A non-owning attachment closes its children and local handle without requesting computer release.

## Computer commands, files, and processes

Mac sessions provide `exec(argv: string[], options?)`, `readFile(path, options?)` returning `Buffer`, `writeFile(path, string | Uint8Array, options?)`, `stat(path, options?)` returning `{ kind, size }`, `processes(options?)` returning `{ id, state, exitCode? }[]`, and `terminate(id, options?)`. They throw `NOT_AVAILABLE_ON_PLATFORM` on web/iOS/Android. See [computers.md](computers.md) for complete signatures, limits, timeouts, and examples. Both support `screenshot()`; instruction/validation do not run on computers.

### `session.recording(): Promise<ComputerRecording | null>`

**Since 0.2.0.** This method is not available in 0.1.0.

Computers only. First reads the report and requires terminal state plus confirmed release, otherwise throws `SESSION_BUSY`. Returns `{ url: string, durationSeconds?: number, startedAt?: Date }` or null for an unavailable recording. Nullable optional wire fields are omitted. This method works after `close()`, does not wait for upload, and does not download or fetch the URL. Keep the signed HTTPS URL and its query private. Request fresh metadata when the URL expires. The normal report has no recording URL. Devices reject this call locally with `NOT_AVAILABLE_ON_PLATFORM`.

## Other session properties

| Property | Meaning |
| --- | --- |
| `viewerUrl` | The session in Revyl: a live view while it runs, its recording/report after. Use `revyl device report --session-id <id>` for web/mobile, or `revyl computer report <id>` for computers. |
| `id` | Revyl's session id |
| `platform` | `'web'`, `'ios'`, `'android'`, or `'mac'` |
| `expiresAt` | **Since 0.2.0.** Validated API expiry as a `Date`, or undefined for devices and older APIs. Computers have a hard lifetime from create (two hours today); this value is the authoritative deadline. Operations/screenshot observation are bounded by expiry; close and recording remain possible. |
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

Verify skips installing a signal or error handler when that event already has listeners, so test runners and apps that manage their own shutdown keep control of it. Always close in `try/finally` or an `after` hook; automatic cleanup cannot guarantee success. A process that is killed outright, or calls `process.exit()` with sessions open, leaves browser/mobile sessions running until their idle timeout (10 minutes by default). Computers have a server-bounded one-hour lifetime instead; no idle timeout is configurable.

## defineConfig(config)

Returns the config unchanged; it exists for type checking in `verify.config.ts`. See [configuration.md](configuration.md).

## Errors

Everything Verify throws on purpose is a `VerifyError` with a stable `code`; `isVerifyError(error)` narrows to it. See [errors.md](errors.md).
