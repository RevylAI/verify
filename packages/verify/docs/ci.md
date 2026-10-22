# CI and test runners

Verify is a library, so it runs wherever your code runs. Browsers, devices, and computers run in Revyl's cloud, so the runner needs nothing but Node.js and an API key. A Mac target works from a Linux runner; no local macOS host is needed. Use the same staging URL overrides and organization enablement as [computers.md](computers.md).

## A script in GitHub Actions

Add `REVYL_API_KEY` as a repository secret, then run your script with `node`. A failed instruction or validation makes the script exit non-zero, which fails the job.

```yaml
name: Verify
on:
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: node verify/checkout.ts
        env:
          REVYL_API_KEY: ${{ secrets.REVYL_API_KEY }}
      - if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: verify-screenshots
          path: .verify/
```

To open each pull request's preview deployment on web, read the URL from the environment in `verify.config.ts`:

```ts
web: { platform: 'web', app: { appId: process.env.REVYL_APP_ID!, url: process.env.PREVIEW_URL!, branch: process.env.GITHUB_HEAD_REF } }
```

## Inside a test runner

Verify has no test runner of its own. Call it from the one you already use, and close the session in `finally` or an `after` hook: test runners handle errors and shutdown themselves, so Verify's automatic cleanup steps aside for them.

### node:test

```ts
import { test } from 'node:test';
import { open } from '@revyl/verify';

test('a shopper can check out', async () => {
  const session = await open('ios');
  try {
    await session.instruction('Add the first product to the cart and check out with the saved card');
    await session.validation('An order confirmation with an order number is shown');
  } finally {
    await session.close();
  }
});
```

### Vitest, Jest, or Playwright Test

The same code works with `import { test } from 'vitest'`, Jest's global `test`, or `import { test } from '@playwright/test'`. Give the test a timeout long enough for a session to start and the steps to run, for example `test('…', async () => { … }, 600_000)` in Vitest and Jest, or `test.setTimeout(600_000)` in Playwright Test.

A thrown `VerifyError` fails the test with its code, Revyl's reason, and the session link.

## Cost and parallelism

Each `open()` holds one Revyl session until `close()`. Sessions run in parallel when you open several at once, so close each one as soon as you are done with it. A browser/mobile session that loses its process stops itself after `idleTimeoutSeconds` (10 minutes by default). Computers instead have a server-bounded one-hour lifetime and no configurable idle timeout; close in `finally` and do not treat a timed-out CI job as proof of physical release.
