# Verify

**Open cloud browsers and mobile devices for Revyl's agent, or a Mac computer for commands and files, from TypeScript.**

```ts
import { open } from '@revyl/verify';

const session = await open('ios');
await session.instruction('Add the first product to the cart and open the cart');
await session.validation('The cart lists one item with a price');
await session.close();
```

```bash
npx @revyl/verify init       # writes verify.config.ts and verify/example.ts
node verify/example.ts       # opens the session, prints a link to watch it live, runs the steps
```

Verify is a small TypeScript library on top of [Revyl](https://revyl.com). Open a browser or mobile device for **instruction** and **validation** steps, or a Mac computer for commands, files, processes, and screenshots. It has no test framework of its own, so you call it from wherever you already write code:

- **A plain script.** A failed validation throws, the script exits non-zero, and Verify closes the session on the way out.
- **A coding agent.** An agent can check its own change on a real device in five lines, then read a one-line outcome per step and a link to the recording.
- **CI.** Run the script in a job. The browsers and devices run in Revyl's cloud, so the runner needs nothing but Node and an API key.
- **Your test runner.** Call it inside node:test, Vitest, Jest, or Playwright Test, next to the tests you already have.

Using Go? The [Go SDK](https://github.com/RevylAI/verify/tree/main/go) supports web, iOS, and Android with contexts, typed errors, and no external dependencies.

## Quick start

You need Node.js 22.18 or later and a Revyl account.

```bash
npx @revyl/verify init
npm install --save-dev @revyl/verify
export REVYL_API_KEY=...          # or sign in with the Revyl CLI: revyl auth login
node verify/example.ts
```

Full walkthrough: [getting started](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/getting-started.md).

## The API

| Call | What it does |
| --- | --- |
| `open(target)` | Starts a Revyl cloud browser, device, or Mac computer, from a target name in `verify.config.ts` or a target object, and waits until it is ready |
| `session.exec(argv, options?)` | Runs structured argv on a Mac computer; returns `{ exitCode, stdout, stderr }` |
| `session.readFile(path)`, `writeFile(path, data)`, `stat(path)` | Reads a `Buffer`, writes a string or bytes, or returns `{ kind, size }` on a computer |
| `session.processes()`, `terminate(id)` | Lists run-owned process handles or terminates one on a computer |
| `session.instruction(text)` | Revyl's agent does what the text says. Throws `INSTRUCTION_FAILED` if it cannot. |
| `session.validation(text)` | Revyl's agent checks that the text holds on screen. Throws `VALIDATION_FAILED` if it does not, or returns the result with `{ soft: true }`. |
| `session.screenshot({ path })` | A PNG of the screen |
| `session.viewerUrl` | The session in Revyl: live while it runs, its recording after |
| `session.close()` | Stops the session. Verify also closes open sessions on Ctrl+C, on an uncaught error, and when a script ends without closing. |

Revyl failures are `VerifyError`s with a stable code, a safe reason, and the session link when one exists.

## Platforms

| | Web | iOS | Android | Mac | Linux |
| --- | --- | --- | --- | --- | --- |
| Runs on | Revyl cloud browser | Revyl iOS simulator | Revyl Android emulator | Revyl macOS computer | Contract only; open unavailable |
| Opens | A public URL, or a web build in Revyl | A build in Revyl, a build URL, or an installed app | A build in Revyl, a build URL, or an installed app | A workspace, no app id | Nothing in this release |
| `instruction`, `validation` | Yes | Yes | Yes | Unavailable | Unavailable |
| Commands, files, processes | Unavailable | Unavailable | Unavailable | Early access on staging only for enabled organizations; not yet available in Revyl production | Contract only |
| `screenshot`, `viewerUrl` | Yes | Yes | Yes | Yes | Unconfirmed |

Steps on web go through the same Revyl API as on mobile. Production is the default; optional environment overrides are documented in [web.md](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/web.md). A backend without web-step support returns `NOT_AVAILABLE_ON_PLATFORM`.

Each step runs Revyl's agent on the live session every time. Verify does not cache or replay steps, and Revyl does not carry values from one step to the next.

For a Mac workspace, run `npx @revyl/verify init --platform mac`; it generates a command and file-round-trip script with no app id or agent steps. Mac computers are early access and not yet available in Revyl production. They work only on Revyl staging for enabled organizations using the optional `REVYL_BACKEND_URL` override and matching credentials. Linux targets are typed but `open()` rejects them with `NOT_AVAILABLE_ON_PLATFORM` before credentials or network access. See [computers](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors) and the [Linux contract](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/linux-computers-contract.md).

## Docs

- [Getting started](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/getting-started.md) and [API](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/api.md)
- [Configuration and CLI](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/configuration.md)
- [Web](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/web.md) and [iOS and Android](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/mobile.md)
- [Mac computers](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md) and the [deferred Linux contract](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/linux-computers-contract.md)
- [CI and test runners](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/ci.md) and [error codes](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/errors.md)
- [For coding agents](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/agents.md)

Examples: [web store](https://github.com/RevylAI/verify/tree/main/examples/web-store), [mobile settings](https://github.com/RevylAI/verify/tree/main/examples/mobile-settings), and [Mac workspace](https://github.com/RevylAI/verify/tree/main/examples/mac-workspace).

## How it works

Verify is a client for [Revyl's public API](https://docs.revyl.com). `open()` starts a device session (registering a web URL as a build first when needed) and waits until it is ready. Each instruction or validation runs as a live step on the session: Verify submits it, polls its status until Revyl reports a result, and cancels it on Revyl if it runs past its timeout. `close()` stops the session. Requests identify themselves with `X-Revyl-Client: verify` and a `revyl-verify/<version>` user agent.

For computers, `open()` creates a computer run and waits for its report to become active. Commands use request UUIDs and async operation polling without resubmitting mutations; `close()` stops the run. See [the computer transport](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#lifecycle-and-transport).

## Develop

```bash
npm install
npm run build
npm test          # unit tests against a mocked Revyl API; no account needed
npm run typecheck
```

The library lives in [`packages/verify`](https://github.com/RevylAI/verify/tree/main/packages/verify) and the examples in [`examples/`](https://github.com/RevylAI/verify/tree/main/examples). Read [Contributing](https://github.com/RevylAI/verify/blob/main/CONTRIBUTING.md), [Security](https://github.com/RevylAI/verify/blob/main/SECURITY.md), and [Releasing](https://github.com/RevylAI/verify/blob/main/RELEASING.md) before changing or publishing the package.

## License

[Apache 2.0](https://github.com/RevylAI/verify/blob/main/LICENSE)
