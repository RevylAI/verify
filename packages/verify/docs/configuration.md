# Configuration

Verify reads `verify.config.ts` (or `.mts`, `.js`, `.mjs`) from the folder you run it in. Paths in the config are relative to that file.

```ts
import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: [
    { platform: 'web', app: { appId: '…', url: 'https://staging.example.com' }, viewport: { width: 1280, height: 800 } },
    { platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: '18.5' } },
    { platform: 'android', name: 'pixel', app: { buildId: '…' } },
  ],
  tests: 'tests/**/*.verify.ts',
  workers: 2,
  retries: 1,
});
```

Unknown keys are rejected, so a typo fails loudly instead of being ignored.

## Top-level options

| Option | Default | Meaning |
| --- | --- | --- |
| `targets` | required | Where tests run. Each test runs once per target. |
| `tests` | `tests/**/*.verify.{ts,mts,js,mjs}` | Glob or list of globs for test files |
| `timeout` | `300000` | Milliseconds per test, hooks included |
| `actionTimeout` | `15000` | Milliseconds a locator action waits for its element |
| `assertionTimeout` | `10000` | Milliseconds an `expect(locator)` keeps retrying |
| `agentTimeout` | `180000` | Milliseconds per agent step |
| `retries` | `1` when `CI` is set, else `0` | Extra attempts for a failed test |
| `workers` | `1` | Sessions run in parallel per target |
| `reuseSessions` | `true` | Reuse one session per worker and target across tests |
| `outputDir` | `.verify` | Where `results.json` and `artifacts/` go |
| `reporters` | `['list', 'json']` | Terminal output and `results.json` |

## Web targets

| Option | Meaning |
| --- | --- |
| `platform: 'web'` | |
| `name` | Target name used in output and `--target`. Defaults to `web`. |
| `app.appId` | Required. The Revyl web app. |
| `app.url` | A public HTTPS URL to open, registered as a build on each run. |
| `app.buildId` | An exact Revyl web build to open instead of a URL. |
| `app.branch` | Branch to register the URL on, or to take the newest build from. |
| `viewport` | `{ width, height, deviceScaleFactor? }` in CSS pixels |
| `signIn` | `{ path, secret, persona? }`: a test-only sign-in route. See [web.md](web.md). |
| `startTimeout` | Milliseconds to wait for the browser. Default 600 000. |
| `idleTimeoutSeconds` | Revyl stops the session after this much inactivity. Default 600. |

## iOS and Android targets

| Option | Meaning |
| --- | --- |
| `platform: 'ios'` or `'android'` | |
| `name` | Target name. Defaults to the platform. |
| `app.appId` | A Revyl app; each run installs its newest build. |
| `app.buildId` | An exact Revyl build to install. |
| `app.artifactUrl` | An HTTPS URL of an `.apk`, `.app.zip`, or `.ipa` to install. |
| `app.bundleId` | The app to launch. Needed when nothing is installed, for example a system app. |
| `device` | `{ model?, osVersion? }`, for example `{ model: 'Pixel 8', osVersion: '15' }` |
| `startTimeout` | Milliseconds to wait for the device. Default 600 000. |
| `idleTimeoutSeconds` | Default 600. |

Give one of `appId`, `buildId`, or `artifactUrl`, or only `bundleId`.

Use separate targets to cover several devices:

```ts
targets: [
  { platform: 'ios', name: 'iphone-se', app: { appId }, device: { model: 'iPhone SE (3rd generation)' } },
  { platform: 'ios', name: 'iphone-16', app: { appId }, device: { model: 'iPhone 16' } },
],
```

## Environment variables

| Variable | Meaning |
| --- | --- |
| `REVYL_API_KEY` | API key. Takes precedence over a Revyl CLI login. |
| `REVYL_BACKEND_URL` | API origin. Defaults to `https://backend.revyl.ai`. |
| `REVYL_APP_URL` | Web app origin used in session links. Defaults to `https://app.revyl.ai`. |
| `CI` | When set: retries default to 1 and `test.only` fails the run. |
| `NO_COLOR` | Turns off colored output. |

## Command line

```text
verify init [--platform web|ios|android] [--app-id <id>] [--url <https-url>] [--force]
verify run [file filters...] [options]
verify whoami
verify --version
```

`verify run` options:

| Flag | Meaning |
| --- | --- |
| `[file filters...]` | Run only test files whose path contains one of these strings |
| `-c, --config <path>` | Config file to use |
| `-t, --target <name>` | Run only this target; repeat for several |
| `-g, --grep <regex>` | Run only tests whose file, title, or target name matches (case-insensitive) |
| `-j, --workers <n>` | Override `workers` |
| `--retries <n>` | Override `retries` |
| `--reporter list,json` | Override `reporters` |
| `--list` | Print the tests that would run without starting sessions or needing credentials |
| `--forbid-only` | Fail on `test.only`; on by default when `CI` is set |

Exit codes: `0` all tests passed (flaky passes included), `1` a test failed or a test file could not load, `2` a usage, config, or authentication problem, `130` interrupted.

Press Ctrl+C once to stop: Verify cancels running agent steps and stops every session it started. A second Ctrl+C exits at once and may leave sessions running until their idle timeout.
