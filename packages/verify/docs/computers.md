# Mac and Linux computers (early access)

Verify opens a Revyl cloud macOS or Linux computer for commands, files, processes, and screenshots. It does not open an assigned physical computer. Both operating systems are **early access**. Ask [support@revyl.ai](mailto:support@revyl.ai) about access.

```bash
export REVYL_API_KEY=...
npx @revyl/verify init --platform mac
npm install --save-dev @revyl/verify
node verify/example.ts
```

`init` only writes local files; running the script starts a paid computer. No app id, build, device selector, image selector, or local Mac is needed. The generated script checks commands and a file round trip without agent steps.

`init` intentionally generates only Mac computer projects. For Linux, install the package and use `open({ platform: 'linux' })` inline, or add `linux: { platform: 'linux' }` to the `targets` in `verify.config.ts`. The methods below are shared by both operating systems; installed tools, paths, resources, and desktop dimensions are not fixed SDK guarantees.

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

Operation `timeout` is milliseconds, defaults to 30,000, and must be an integer from 1 to 300,000. It is also bounded by the run's remaining lifetime. A computer has a hard 60-minute lifetime **from create**, not from readiness or last activity; `idleTimeoutSeconds` and the agent `stepTimeout` do not configure computer lifetime or commands. `expiresAt` is a `Date` when the API returns `expires_at`, and otherwise undefined (including on devices and older APIs). Verify refuses new operations after that deadline and bounds operation/screenshot observation by it; expiry does not prevent explicit close or recording retrieval. Revyl allows at most 256 operations per run.

## Recording metadata

After terminal state **and** confirmed release, `await computer.recording()` returns `{ url, durationSeconds?, startedAt? }` or `null` if the recording is unavailable or still processing. `durationSeconds` is a finite nonnegative number; `startedAt` is a `Date`. Missing or nullable optional fields are omitted. Calling before terminal state and confirmed release throws `SESSION_BUSY`; Verify does not wait for the recording or download it. The method works after `close()` and checks the report before requesting the recording.

The HTTPS URL is signed and short-lived. Keep it private, including its query string; do not log or publish it. Call `recording()` again when a fresh URL is needed. The report carries no recording URL; `viewerUrl` remains a Revyl UI link, not a download URL. Web/mobile sessions reject `recording()` locally with `NOT_AVAILABLE_ON_PLATFORM`.

## Availability and errors

Mac and Linux computers are early access. A `503 runtime_unavailable` or typed `computer_not_enabled` becomes `NOT_AVAILABLE_ON_PLATFORM` with this availability guidance. A `429 computer_limit` becomes `COMPUTER_LIMIT`: queued work (including iOS) or the concurrency limit can cause it, and the response does not identify which. Verify does not retry the create or send a stop after these definite admission refusals. `operation_limit` remains `SESSION_BUSY`. Availability is determined by the server.

The default `startTimeout` remains 600000 ms; override it explicitly if needed. An unclaimed start can transition to `failed` with `failure_reason: 'no_host'` after 120 seconds from create. Verify stops readiness polling and throws `SESSION_START_FAILED` with that context, then attempts bounded cleanup. This is not a 120-second timeout for every start: claimed guests may take longer. `device_limit` also yields `SESSION_START_FAILED`, with queued-work/concurrency context. A start timeout or unconfirmed close does not prove resources were released. Inspect the session and contact support rather than blindly repeating a start or stop.

`instruction()` and `validation()` throw `NOT_AVAILABLE_ON_PLATFORM` on both computer operating systems without sending agent requests. Screenshots are supported, but screenshot readiness is separate from command readiness. Agent control of the screen is not part of this release. On web, iOS, and Android, shell/file/process methods throw `NOT_AVAILABLE_ON_PLATFORM`.

For the first 30 seconds after a computer becomes active, `screenshot()` retries exact structured `screen_unavailable` responses (HTTP 409 or 503) and `screen_starting` (HTTP 409). Backoff starts at 500 ms and doubles up to 2 seconds; the fixed window does not restart on each call. Cancellation, close, expiry, and the observation deadline still bound the wait. Exhausting that window yields `SESSION_BUSY` with a desktop-not-ready message, rather than requiring a caller sleep. Authentication failures, unrelated errors, malformed responses, and transport failures are not replayed. Commands and other mutations are never retried by this screenshot behavior.

Linux named and inline targets use the same computer surface as Mac. `init --platform linux` is intentionally unavailable; use an inline target or write its config entry.

Missing files and access denials throw `NOT_FOUND` and `ACCESS_DENIED`. An operation timeout with confirmed termination throws `TIMEOUT`; unconfirmed termination or execution throws `ACTION_UNCERTAIN`. Neither implies rollback. Execution outcome, evidence recording, and physical release are independent: an observed successful command can return its result while logging pending/failed report evidence. Do not repeat a mutation merely because its response was lost. Check the computer in Revyl before deciding what to do next. See [errors.md](errors.md).

## Lifecycle and transport

Use `attach(computerId)` to take cleanup ownership of an existing active computer without creating one. `computer.open(target)` starts Web/iOS children on Mac and Android on Linux; Web on Linux depends on runtime availability and currently has a runtime limitation. A child requires an existing app/build pair and inherits the parent's client and expiry. Parent close attempts child cleanup for at most five seconds before requesting computer release; the server also stops remaining children. See [the hosted API](api.md#computeropentarget) for arguments, localhost navigation, and cleanup semantics. These are app sessions, not natural-language control of the computer desktop itself.

For a computer owned by another caller, such as a CI runner, use `attach(computerId, { stopOnClose: false })`. It is not registered for automatic cleanup. Explicit close still cancels pending child starts and closes hosted children within the five-second cleanup phase, but never sends a stop for the computer. The computer's owner is responsible for releasing it; a child-cleanup failure does not authorize stopping the parent.

Verify mints a session UUID, creates `/api/v1/computer-runs` with `os: 'macos'` for `platform: 'mac'` or `os: 'linux'` for `platform: 'linux'`, then polls `GET /computer-runs/{id}/report` until `state: 'active'`, which means it is ready. `starting` alone is not readiness. The public Mac target spelling is `mac`, not `macos`.

Each command is submitted once to `/computer-runs/{id}/operations` with its own UUID `request_id` and `Prefer: respond-async`. The operation id is UUIDv5 with the computer UUID as namespace and the request UUID string as name. A `202` response has JSON `null`; Verify reads the operation by id until it settles instead of submitting it again.

**Breaking wire change:** computer arguments use `argv_b64`, one padded URL-safe base64 string per UTF-8 argument, and file paths use `path_b64`; the request omits raw `argv` and `path`. This SDK is incompatible with the previous backend contract. Deploy the encoded-only backend before publishing or upgrading to this SDK. Public APIs and decoded input limits are unchanged. Existing `stdin` and file `data` fields remain standard base64, and process commands are unchanged. This encoding is not encryption. Screenshot uses standard base64 PNG.

Verify bounds operation observation to the earlier of 310 seconds or the returned expiry, and explicit stop requests to 310 seconds independently of expiry. This is separate from the command's `timeout`: the backend may hold the async submission for 60 seconds before returning `202`. Automatic process-exit cleanup has a shorter 15-second budget and is best effort; use explicit `await close()` in `finally` to observe confirmed release.

For an owning attachment, `close()` posts `/computer-runs/{id}/stop`, and the same automatic process cleanup as other sessions applies. A non-owning attachment never sends that stop. Always close in `finally` or use `await using` so hosted children are cleaned up. A terminal state alone is not confirmed physical release. Keep computer output and screenshots private: they can contain application data and credentials. Verify does not log file contents, argv, stdin, or command output automatically.
