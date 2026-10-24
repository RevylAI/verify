# Configuration

`open('name')` reads targets from `verify.config.ts` (or `.mts`, `.js`, `.mjs`), looking in the current folder and then each folder above it. You can skip the config and pass a target object to `open()` instead.

```ts
import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
    web: { platform: 'web', app: { appId: '…', url: 'https://staging.example.com' }, viewport: { width: 1280, height: 800 } },
    ios: { platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: '18.5' } },
    pixel: { platform: 'android', app: { buildId: '…' }, device: { model: 'Pixel 8' } },
    mac: { platform: 'mac' },
  },
  stepTimeout: 240_000,
});
```

Unknown keys are rejected, so a typo fails loudly instead of being ignored.

## Top-level options

Mac targets currently require staging early access for an enabled organization through the optional `REVYL_BACKEND_URL` override and matching credentials; they are not yet available in Revyl production. See [computer availability](computers.md#availability-and-errors).

| Option | Default | Meaning |
| --- | --- | --- |
| `targets` | required | Named targets. The key is the name you pass to `open()`: letters, digits, dots, dashes, and underscores. |
| `stepTimeout` | `180000` | Milliseconds one instruction or validation may run before it is cancelled |

## Web targets

| Option | Meaning |
| --- | --- |
| `platform: 'web'` | |
| `app.appId` | Required. The Revyl web app. |
| `app.url` | A public HTTPS URL to open, registered as a build each time a session opens. |
| `app.buildId` | An exact Revyl web build to open instead of a URL. |
| `app.branch` | Branch to register the URL on, or to take the newest build from. |
| `viewport` | `{ width, height, deviceScaleFactor? }` in CSS pixels |
| `signIn` | `{ path, secret, persona? }`: a test-only sign-in route. See [web.md](web.md). |
| `startTimeout` | Milliseconds to wait for the browser. Default 600000. |
| `idleTimeoutSeconds` | Revyl stops the session after this much inactivity. Default 600. |

## iOS and Android targets

| Option | Meaning |
| --- | --- |
| `platform: 'ios'` or `'android'` | |
| `app.appId` | A Revyl app; each session installs its newest build. |
| `app.buildId` | An exact Revyl build to install. |
| `app.artifactUrl` | An HTTPS URL of an `.apk`, `.app.zip`, or `.ipa` to install. |
| `app.bundleId` | An app already on the device to launch instead, such as a system app. |
| `device` | `{ model?, osVersion? }`, for example `{ model: 'Pixel 8', osVersion: '15' }` |
| `startTimeout` | Milliseconds to wait for the device. Default 600000. |
| `idleTimeoutSeconds` | Default 600. |

Give exactly one of `appId`, `buildId`, `artifactUrl`, or `bundleId`.

## Computer targets

| Option | Meaning |
| --- | --- |
| `platform: 'mac'` | A cloud macOS computer, without `app` or `device` configuration |
| `platform: 'linux'` | Accepted contract value only; `open()` throws `NOT_AVAILABLE_ON_PLATFORM` before credentials/network |
| `startTimeout` | Milliseconds to wait for an active owner route; default 600000, range 10000..1800000 |

Computers do not accept `idleTimeoutSeconds`, image, provider, cwd, or lifetime selectors. The server bounds a run to one hour; per-operation timeout defaults to 30000 ms and accepts 1..300000 ms. See [computers.md](computers.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `REVYL_API_KEY` | API key. Takes precedence over a Revyl CLI login. |
| `REVYL_BACKEND_URL` | Optional API origin override. Defaults to production `https://backend.revyl.ai`. Optional staging access uses `https://backend-staging.revyl.ai` with staging credentials. |
| `REVYL_APP_URL` | Optional session-link origin override. Defaults to production `https://app.revyl.ai`. Optional staging access uses `https://staging.revyl.ai`. |

## Command line

The `verify` command (also installed as `revyl-verify`) has two commands. Scripts run with `node`, not through the CLI.

```text
verify init [--platform web|ios|android|mac] [--app-id <id>] [--url <https-url>] [--force]
verify whoami
verify --help | --version
```

- `init` writes `verify.config.ts` and `verify/example.ts`, and adds `.verify/` to `.gitignore`. Without `--platform` it asks its questions interactively. It never overwrites files unless you pass `--force`.
- `init --platform mac` needs no app id and generates a command/file script. `--app-id` is rejected for Mac, `--url` applies only to web, and Linux init is unavailable.
- `whoami` prints the Revyl account and organization your credentials belong to.

Exit codes: `0` success, `1` a Revyl or file error, `2` a usage or authentication problem.
