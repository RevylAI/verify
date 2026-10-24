# Verify

**Open a real cloud browser, iPhone, or Android device from your code, tell Revyl's agent what to do, and check what it sees.**

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

Verify is a small TypeScript library on top of [Revyl](https://revyl.com). It does four things: open a session, run an **instruction**, run a **validation**, and close the session. It has no test framework of its own, so you call it from wherever you already write code:

- **A plain script.** A failed validation throws, the script exits non-zero, and Verify closes the session on the way out.
- **A coding agent.** An agent can check its own change on a real device in five lines, then read a one-line outcome per step and a link to the recording.
- **CI.** Run the script in a job. The browsers and devices run in Revyl's cloud, so the runner needs nothing but Node and an API key.
- **Your test runner.** Call it inside node:test, Vitest, Jest, or Playwright Test, next to the tests you already have.

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
| `open(target)` | Starts a Revyl cloud browser or device, from a target name in `verify.config.ts` or a target object, and waits until it is ready |
| `session.instruction(text)` | Revyl's agent does what the text says. Throws `INSTRUCTION_FAILED` if it cannot. |
| `session.validation(text)` | Revyl's agent checks that the text holds on screen. Throws `VALIDATION_FAILED` if it does not, or returns the result with `{ soft: true }`. |
| `session.screenshot({ path })` | A PNG of the screen |
| `session.viewerUrl` | The session in Revyl: live while it runs, its recording after |
| `session.close()` | Stops the session. Verify also closes open sessions on Ctrl+C, on an uncaught error, and when a script ends without closing. |

Every error is a `VerifyError` with a stable code, Revyl's reason, and the session link.

## Platforms

| | Web | iOS | Android |
| --- | --- | --- | --- |
| Runs on | Revyl cloud browser | Revyl iOS simulator | Revyl Android emulator |
| Opens | A public URL, or a web build in Revyl | A build in Revyl, a build URL, or an installed app | A build in Revyl, a build URL, or an installed app |
| `instruction`, `validation` | On Revyl staging; in production once Revyl promotes staging to main | Yes | Yes |
| `screenshot`, `viewerUrl` | Yes | Yes | Yes |

Steps on web go through the same Revyl API as on mobile. They run on Revyl staging now: set `REVYL_BACKEND_URL` and `REVYL_APP_URL` to point Verify at it, as [web.md](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/web.md) shows. A Revyl backend that does not run steps on web yet answers with `NOT_AVAILABLE_ON_PLATFORM`, and the same code works there once it does.

Each step runs Revyl's agent on the live session every time. Verify does not cache or replay steps, and Revyl does not carry values from one step to the next.

## Docs

- [Getting started](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/getting-started.md) and [API](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/api.md)
- [Configuration and CLI](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/configuration.md)
- [Web](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/web.md) and [iOS and Android](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/mobile.md)
- [CI and test runners](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/ci.md) and [error codes](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/errors.md)
- [For coding agents](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/agents.md)

Examples: [web store](https://github.com/RevylAI/verify/tree/main/examples/web-store) and [mobile settings](https://github.com/RevylAI/verify/tree/main/examples/mobile-settings).

## How it works

Verify is a client for [Revyl's public API](https://docs.revyl.com). `open()` starts a device session (registering a web URL as a build first when needed) and waits until it is ready. Each instruction or validation runs as a live step on the session: Verify submits it, polls its status until Revyl reports a result, and cancels it on Revyl if it runs past its timeout. `close()` stops the session. Requests identify themselves with `X-Revyl-Client: verify` and a `revyl-verify/<version>` user agent.

## Develop

```bash
npm install
npm run build
npm test          # unit tests against a mocked Revyl API; no account needed
npm run typecheck
```

The library lives in [`packages/verify`](packages/verify) and the examples in [`examples/`](examples).

## License

[Apache 2.0](LICENSE)
