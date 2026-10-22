# Mac computers

Verify opens a Revyl cloud macOS computer for commands, files, processes, and screenshots. It does not open an assigned physical Mac. Computers must be enabled for your organization, with compute credits and a free computer slot. The computer API is on Revyl staging; production availability depends on its promotion.

```bash
export REVYL_BACKEND_URL=https://backend-staging.revyl.ai
export REVYL_APP_URL=https://staging.revyl.ai
export REVYL_API_KEY=...    # credentials for your staging organization
npx @revyl/verify init --platform mac
npm install --save-dev @revyl/verify
node verify/example.ts
```

`init` only writes local files; running the script starts a paid computer. No app id, build, device selector, image selector, or local Mac is needed. The generated script checks commands and a file round trip without agent steps.

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

Operation `timeout` is milliseconds, defaults to 30,000, and must be an integer from 1 to 300,000. It is also bounded by the run's remaining lifetime. A computer runs for at most one hour; `idleTimeoutSeconds` and the agent `stepTimeout` do not configure computer lifetime or commands. Revyl allows at most 256 operations per run.

## Availability and errors

`instruction()` and `validation()` throw `NOT_AVAILABLE_ON_PLATFORM` on computers without sending agent requests. Screenshot is supported on Mac; agent control of the screen is not part of this release. On web, iOS, and Android, shell/file/process methods throw `NOT_AVAILABLE_ON_PLATFORM`.

Linux is accepted in target types and config, but `open({ platform: 'linux' })` rejects with `NOT_AVAILABLE_ON_PLATFORM` before credentials or network access. A named target with `platform: 'linux'` behaves the same. `init --platform linux` is intentionally unavailable. See [linux-computers-contract.md](linux-computers-contract.md) for the future implementation contract and unconfirmed Linux assumptions.

Missing files and access denials throw `NOT_FOUND` and `ACCESS_DENIED`. An operation timeout with confirmed termination throws `TIMEOUT`; unconfirmed termination or execution throws `ACTION_UNCERTAIN`. Neither implies rollback. Execution outcome, evidence recording, and physical release are independent: an observed successful command can return its result while logging pending/failed report evidence. Do not repeat a mutation merely because its response was lost. Check the computer in Revyl before deciding what to do next. See [errors.md](errors.md).

## Lifecycle and transport

Verify mints a session UUID, creates `/api/v1/computer-runs` with `os: 'macos'`, then polls `GET /computer-runs/{id}/report` until `state: 'active'`, which means the owner route is ready. `starting` alone is not readiness. The public target spelling is `mac`, not `macos`.

Each command is submitted once to `/computer-runs/{id}/operations` with its own UUID `request_id` and `Prefer: respond-async`. The operation id is UUIDv5 with the computer UUID as namespace and the request UUID string as name. A `202` response has JSON `null`; Verify reads the operation by id until it settles instead of submitting it again. Binary operation fields use padded URL-safe base64 on the wire, with standard base64 accepted as input. Screenshot uses standard base64 PNG instead.

Verify bounds operation observation and explicit stop requests to 310 seconds. This is separate from the command's `timeout`: the backend may hold the async submission for 60 seconds before returning `202`. Automatic process-exit cleanup has a shorter 15-second budget and is best effort; use explicit `await close()` in `finally` to observe confirmed release.

`close()` posts `/computer-runs/{id}/stop`. Always close in `finally` or use `await using`; the same automatic process cleanup as other sessions applies. A terminal state alone is not confirmed physical release. Keep computer output and screenshots private: they can contain application data and credentials. Verify does not log file contents, argv, stdin, or command output automatically.
