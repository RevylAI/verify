# Running in CI

Verify needs nothing on the CI machine but Node.js and an API key: the browsers and devices run in Revyl's cloud.

## GitHub Actions

Add `REVYL_API_KEY` as a repository secret, then:

```yaml
name: E2E
on:
  pull_request:

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx verify run
        env:
          REVYL_API_KEY: ${{ secrets.REVYL_API_KEY }}
      - if: ${{ !cancelled() }}
        uses: actions/upload-artifact@v4
        with:
          name: verify-results
          path: .verify/
```

To test each pull request's preview deployment on web, read the URL from the environment in `verify.config.ts`:

```ts
{ platform: 'web', app: { appId: process.env.REVYL_APP_ID!, url: process.env.PREVIEW_URL!, branch: process.env.GITHUB_HEAD_REF } }
```

## What CI changes

When `CI` is set, failed tests are retried once by default and `test.only` fails the run. Set `retries` in the config or pass `--retries` to change the retry count.

## Results

- The exit code is `0` when every test passed (including flaky passes), `1` when a test failed or a test file did not load, `2` for usage, config, and authentication problems, and `130` when interrupted.
- `.verify/results.json` has every test, attempt, step, error code, session link, and screenshot path. `schemaVersion` is `1`.
- `.verify/artifacts/` holds failure screenshots and any `app.screenshot()` files.
- Each failure in the terminal output links to the Revyl session, where the recording of the run stays available.

## Cost and parallelism

Each worker holds one Revyl session per target while it has tests for that target, and releases it as soon as the target's tests are done. `workers: 2` with two targets can hold up to four sessions at once. Verify stops every session it started when the run ends, fails, or is cancelled; a session that loses its runner stops itself after `idleTimeoutSeconds`.
