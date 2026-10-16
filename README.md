# Verify

**End-to-end tests for web, iOS, and Android apps, written in TypeScript and run on real cloud browsers and devices.**

Write a test once and run it on Chrome, an iPhone simulator, and an Android emulator. Use exact locators where you can name the element, and plain-language agent steps where you can't.

```ts
import { expect, test } from '@revyl/verify';

test('a shopper can check out', async ({ screen, agent }) => {
  await screen.getByText('Running shoes').tap();
  await screen.getByRole('button', { name: 'Add to cart' }).tap();
  await agent.act('Open the cart and check out with the saved card');
  await expect(screen.getByText('Order placed')).toBeVisible();
});
```

```bash
npx @revyl/verify init    # writes verify.config.ts and a first test
npx verify run            # runs it on Revyl and links to the live session
```

- **One API for web and mobile.** `screen`, `expect`, `agent`, and `app` work the same way on every target. Each test runs once per target in your config.
- **Exact when it can be, smart when it needs to be.** On iOS and Android, locators read the app's native UI tree, so `getByTestId('email')` hits exactly that field and an ambiguous match fails instead of guessing. `agent.act`, `agent.assert`, and `agent.extract` hand the hard parts to Revyl's agent.
- **Nothing to install on the machine.** Browsers, simulators, and emulators run in Revyl's cloud. CI needs Node and an API key.
- **Failures you can act on.** Every failure names a stable error code, the step that failed, a screenshot, and a link to the session recording. `.verify/results.json` has all of it for CI and for coding agents.
- **Built for coding agents.** The docs ship inside the package, `verify run --list` checks tests without starting sessions, and errors tell you the next move.

## Quick start

You need Node.js 22.12 or later and a [Revyl](https://revyl.com) account.

```bash
npx @revyl/verify init
npm install --save-dev @revyl/verify
export REVYL_API_KEY=...          # or sign in with the Revyl CLI: revyl auth login
npx verify run
```

Full walkthrough: [getting started](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/getting-started.md).

## What runs where

| | Web | iOS | Android |
| --- | --- | --- | --- |
| Runs on | Revyl cloud browser | Revyl iOS simulator | Revyl Android emulator |
| `getByText`, `getByLabel`, `getByRole` | AI grounding | Native UI tree | Native UI tree |
| `getByTestId`, `toHaveText`, `toBeEnabled`, `toHaveCount` | Not available | Yes | Yes |
| `screen.locate('…')` | AI grounding | AI grounding | AI grounding |
| `agent.act`, `agent.assert`, `agent.extract` | When Revyl enables live web steps | Yes | Yes |
| `app.openUrl` | Navigation | Deep links | Deep links |

Revyl web sessions expose screenshots, not a DOM, so web locators are resolved by Revyl's grounding model from a description. Agent steps on web already go through the same API as mobile; Revyl answers them with `NOT_AVAILABLE_ON_PLATFORM` today, and they will start working without changes once Revyl turns them on.

Agent steps call the model on every run. Verify does not cache or replay agent decisions, so lean on locators for anything you can name exactly.

## Docs

- [Getting started](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/getting-started.md)
- [Writing tests](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/writing-tests.md)
- [Configuration and CLI](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/configuration.md)
- [Web](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/web.md) and [iOS and Android](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/mobile.md)
- [CI](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/ci.md) and [error codes](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/errors.md)
- [For coding agents](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/agents.md)

Examples: [web store](https://github.com/RevylAI/verify/tree/main/examples/web-store) and [mobile settings](https://github.com/RevylAI/verify/tree/main/examples/mobile-settings).

## How it works

Verify is a test runner and a client for [Revyl's public API](https://docs.revyl.com). For each target it starts a Revyl session, drives it with device actions (tap, type, swipe, open URL), reads the UI tree or asks Revyl's grounding model where an element is, and runs agent steps as live steps on the session. It stops every session it started when the run ends. Requests identify themselves with `X-Revyl-Client: verify` and a `revyl-verify/<version>` user agent.

## Develop

```bash
npm install
npm run build
npm test          # unit tests against a mocked Revyl API; no account needed
npm run typecheck
```

The package lives in [`packages/verify`](packages/verify) and the examples in [`examples/`](examples).

## License

[Apache 2.0](LICENSE)
