# Configuration

`open('name')` reads targets from `verify.config.ts` (or `.mts`, `.js`, `.mjs`), looking in the current folder and then each folder above it. You can skip the config and pass a target object to `open()` instead.

```ts
import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
    web: { platform: 'web', app: { appId: '…', url: 'https://example.com' }, viewport: { width: 1280, height: 800 } },
    ios: { platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: '18.5' } },
    pixel: { platform: 'android', app: { buildId: '…' }, device: { model: 'Pixel 8' } },
    mac: { platform: 'mac' },
  },
  stepTimeout: 240_000,
});
```

Unknown keys are rejected, so a typo fails loudly instead of being ignored.

## Top-level options

Mac and Linux targets are early access. Ask support@revyl.ai about access. See [computer availability](computers.md#availability-and-errors).

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
| `platform: 'linux'` | A cloud Linux computer with the same SDK methods as Mac, without `app` or `device` configuration |
| `startTimeout` | Milliseconds to wait for the computer to become active; default 600000, range 10000..1800000 |

Computers do not accept `idleTimeoutSeconds`, image, provider, cwd, or lifetime selectors. The server bounds a run to one hour; per-operation timeout defaults to 30000 ms and accepts 1..300000 ms. See [computers.md](computers.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `REVYL_API_KEY` | API key. Wins over a stored CLI login unless that login is usable and marked `local_auth_override`. Without an environment key, a usable stored login is used; expired access tokens fall back to a stored API key. |

## Command line

Hosted children use `computer.open(target)` rather than named config targets. Unlike ordinary mobile targets, they require an existing app/build pair and use the computer's fixed device profile. See [the hosted API](api.md#computeropentarget).

Use the explicitly scoped package command below. Installing `@revyl/verify` provides the `verify` and `revyl-verify` bins. The separate `revyl-verify` npm alias also provides `npx revyl-verify` with the same behavior; bare `npx verify` can fetch an unrelated package. Scripts run with `node`, not through the CLI.

```text
npx @revyl/verify init [--platform web|ios|android|mac] [--app-id <id>] [--url <https-url>] [--force]
npx @revyl/verify whoami
npx @revyl/verify --help
npx @revyl/verify --version
```

- `init` writes `verify.config.ts` and `verify/example.ts`, and adds `.verify/` to `.gitignore`. Without `--platform` it asks its questions interactively. It never overwrites files unless you pass `--force`.
- `npx @revyl/verify init --platform mac` needs no app id and generates a command/file script. `--app-id` is rejected for Mac, `--url` applies only to web, and Linux init is intentionally unavailable. Use `open({ platform: 'linux' })` or a Linux config target instead.
- `whoami` prints the Revyl account and organization your credentials belong to.

Exit codes: `0` success, `1` a Revyl or file error, `2` a usage or authentication problem.
