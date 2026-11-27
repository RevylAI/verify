# Configuration

`open('name')` reads targets from `verify.config.ts` (or `.mts`, `.js`, `.mjs`), looking in the current folder and then each folder above it. You can skip the config and pass a target object to `open()` instead.

```ts
import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
    web: { platform: 'web', app: { appId: '…', url: 'https://example.com' }, viewport: { width: 1280, height: 800 } },
    ios: { platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: 'iOS 18.5' } },
    pixel: { platform: 'android', app: { buildId: '…' }, device: { model: 'Pixel 7', osVersion: 'Android 14' } },
    mac: { platform: 'mac' },
  },
  stepTimeout: 240_000,
});
```

Unknown keys are rejected, so a typo fails loudly instead of being ignored.

## Top-level options

Mac computers are available to organizations on a current paid Revyl plan. See [computer availability](computers.md#availability-and-errors).

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
| `viewport` | `{ width, height, deviceScaleFactor? }` in CSS pixels. Screenshots, and so exact-action coordinates, are `deviceScaleFactor` times the CSS size |
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
| `device` | `{ model?, osVersion? }`, written as Revyl names them, for example `{ model: 'iPhone 16', osVersion: 'iOS 18.5' }` or `{ model: 'Pixel 7', osVersion: 'Android 14' }`. Revyl picks its default for a value you leave out. A model or OS version Revyl doesn't offer, or a pair that doesn't go together, throws `INVALID_ARGUMENT` listing the values it accepts, and no session starts |
| `startTimeout` | Milliseconds to wait for the device. Default 600000. |
| `idleTimeoutSeconds` | Default 600. |

Give exactly one of `appId`, `buildId`, `artifactUrl`, or `bundleId`.

## Computer targets

| Option | Meaning |
| --- | --- |
| `platform: 'mac'` | A cloud macOS computer, without `app` or `device` configuration |
| `startTimeout` | Milliseconds to wait for the computer to become active; default 600000, range 10000..1800000 |
| `timeoutMs` | Milliseconds the computer runs from create, in whole seconds; range 60000..86400000. Omit it for the server's 2 hours |

Computers do not accept `idleTimeoutSeconds`, image, provider, or cwd. The server bounds a run to its lifetime from create (2 hours by default, up to 24 hours with `timeoutMs`, and `extend()` lengthens a running computer up to 24 hours from create); per-operation timeout defaults to 30000 ms and accepts 1..300000 ms. See [computers.md](computers.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `REVYL_API_KEY` | API key. Wins over a stored CLI login unless that login is usable and marked `local_auth_override`. Without an environment key, a usable stored login is used; expired access tokens fall back to a stored API key. |

## Command line

Hosted children use `computer.open(target)` rather than named config targets. An iOS child takes `app: { bundleId }`, such as `'com.apple.Preferences'`, or an existing `app: { appId, buildId }` pair, plus an optional `device: { model, osVersion }`; a Web child takes an existing app/build pair. `url`, `branch` and `artifactUrl` aren't accepted there. See [the hosted API](api.md#computeropentarget).

Use the explicitly scoped package command below. Installing `@revyl/verify` provides the `verify` and `revyl-verify` bins. The separate `revyl-verify` npm alias also provides `npx revyl-verify` with the same behavior; bare `npx verify` can fetch an unrelated package. Scripts run with `node`, not through the CLI.

```text
npx @revyl/verify init [--platform ios|android|web|mac] [--app-id <id>] [--url <https-url>] [--force] [--yes] [--no-install] [--no-config] [--no-agents-md] [--no-skill]
npx @revyl/verify login
npx @revyl/verify logout
npx @revyl/verify whoami
npx @revyl/verify report <session-id> [--json]
npx @revyl/verify --help
npx @revyl/verify --version
```

- `init` writes `verify.config.ts` and `verify/example.mts`, and adds `.verify/` and `node_modules/` to `.gitignore` when they aren't there yet, printing what it added. The example runs its steps in `try { … } finally { await session.close(); }`, so the session closes even when a step fails. Without `--platform` it asks its questions interactively, defaulting to iOS. When either file already exists, it keeps both and needs no `--platform`; `--force` overwrites them. `--no-config` skips them. `init --help` lists its options.
- `init` sets up your coding agent at the repository root, the nearest folder above with a `.git`. It writes the `revyl-verify` skill to `.agents/skills/revyl-verify/SKILL.md` and `.claude/skills/revyl-verify/SKILL.md`: Cursor, Codex and Capy read `.agents/skills/`, and Claude Code reads `.claude/skills/`. It adds a Verify section between `<!-- verify:start` and `<!-- verify:end -->` to `AGENTS.md`, creating the file when it's missing. A repository with a `CLAUDE.md` (or `.claude/CLAUDE.md`) and no `AGENTS.md` gets the section in `CLAUDE.md` instead, because Claude Code reads only `CLAUDE.md` when one exists. Running `init` again replaces only that section and the skill, so it changes nothing until a new Verify version changes them. `--no-agents-md` skips the section and `--no-skill` skips the skill. `init` writes no MCP configuration: Verify runs in your scripts, so it needs no MCP server.
- iOS and Android without `--app-id` target the device's built-in Settings app by bundle id (`com.apple.Preferences`, `com.android.settings`), so the example runs before you upload a build. Web requires `--app-id`; without it, `init` writes no files and explains how to create the Web app ([web.md](web.md#create-the-web-app)).
- `npx @revyl/verify init --platform mac` needs no app id and generates a command/file script. `--app-id` is rejected for Mac, and `--url` applies only to web.
- `init` installs Verify from the project's lockfile when needed and signs in through Revyl's browser approval flow when no credentials are available. Use `--yes` or `--no-install` to control installation. Non-interactive runs do not prompt or open a browser and require `REVYL_API_KEY`.
- `init` checks the sign-in after it writes the files. If it can't confirm one (no key, a rejected key, or Revyl unreachable), it prints `Could not confirm a Revyl sign-in:` with the reason, makes signing in step 1 under `Next:`, and exits 0: the files are written and need no change, so don't run `init` again. Sign in with `npx @revyl/verify login` or `REVYL_API_KEY`, check it with `whoami`, then run the example.
- `login` signs in through Revyl's browser approval flow and saves the login to `~/.revyl/credentials.json`, which the Revyl CLI shares. It needs a terminal; in CI, set `REVYL_API_KEY`.
- `logout` deletes `~/.revyl/credentials.json`. The API key it held keeps working until you delete it in Revyl under Settings → API keys, and a `REVYL_API_KEY` in the environment still applies.
- `whoami` prints the Revyl account and organization your credentials belong to.
- `report <session-id>` reads a finished session from Revyl, including after the script that ran it exited: its status, link and each step's verdict, with the first line of the reasoning or error. `--json` prints the [`SessionReport`](api.md#reportsessionid-options) as JSON. It exits 0 whenever it read the report, whatever the session's outcome, so check the status or the steps' verdicts:

  ```text
  Session <id> (web): completed
  Link: https://app.revyl.ai/sessions/<id>
  1. passed  validation  The Revyl pricing page has loaded …
     <first line of the reasoning or error>
  ```

  A session with no steps in Revyl's report, such as a computer, prints `No steps in Revyl's report for this session.`

Running `init` again changes nothing: it keeps the config and example, finds Verify already installed, and finds the agent setup up to date. It still checks the sign-in.

Exit codes: `0` success, including an `init` that wrote its files but couldn't confirm a sign-in and a `report` of a failed session; `1` a Revyl or file error, including `report` of a session Revyl doesn't have (`NOT_FOUND`); `2` a usage or authentication problem.
