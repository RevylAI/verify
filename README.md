<h1 align="center">Verify</h1>

<p align="center">
  <em>Cloud browsers, mobile devices and computers from TypeScript and Go.</em>
</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-9D61FF" alt="Source version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://www.npmjs.com/package/@revyl/verify"><img src="https://img.shields.io/npm/v/@revyl/verify?color=9D61FF" alt="npm" /></a>
  <a href="https://pkg.go.dev/github.com/RevylAI/verify/go"><img src="https://img.shields.io/badge/Go-reference-00ADD8?logo=go&logoColor=white" alt="Go reference" /></a>
  <a href="https://github.com/RevylAI/verify/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/RevylAI/verify/ci.yml?branch=main&label=CI" alt="CI" /></a>
</p>

---

Verify is a TypeScript and Go library for [Revyl](https://revyl.com). Open a cloud browser, iOS simulator or Android emulator for natural-language instructions and validations, or an early-access Mac/Linux computer for commands, files, processes and screenshots. Call it from a script, coding agent or your existing test runner.

## For coding agents

Run these from the project's directory with Node.js ≥22.18. The authentication command requires the [Revyl CLI](https://github.com/RevylAI/revyl-cli#install); if `REVYL_API_KEY` is already supplied securely, skip login.

```bash
npm install --save-dev @revyl/verify
npx @revyl/verify init --platform ios
revyl auth login
npx @revyl/verify whoami
```

If login prints an approval URL, share it privately with the user so they can approve it in their browser. For unattended runs, supply `REVYL_API_KEY` through a secret manager; never put credentials in argv, source or logs. Configure the generated `verify.config.ts` before running `node verify/example.ts`. Starting a cloud session requires an authorized account and workload.

## Install

### npm

Use Node.js ≥22.18:

```bash
npm install --save-dev @revyl/verify
```

### Go

Use Go ≥1.26.9 in an existing Go module:

```bash
go get github.com/RevylAI/verify/go@main
```

There is no Go release tag yet. `@main` resolves to a pseudo-version; keep the generated `go.mod` and `go.sum` to pin it. Go tags are independent of npm versions. The SDK uses only the standard library.

## Authenticate

Both SDKs use this credential order:

1. A usable stored CLI login marked `local_auth_override`.
2. `REVYL_API_KEY` from the environment.
3. Another usable CLI login stored by `revyl auth login`.

An expired access token can fall back to its stored API key. Set environment keys through a secret manager, or sign in interactively:

```bash
revyl auth login
```

See [configuration](packages/verify/docs/configuration.md) for credential and endpoint options.

## Quick Start

### TypeScript

Run `npx @revyl/verify init --platform ios`. For this Settings example, replace the generated `app` block with `app: { bundleId: 'com.apple.Preferences' }`. Save the following as `verify/example.ts` and run `node verify/example.ts`. For your own uploaded app, set `app.appId` and adapt the steps.

```ts
import { open } from '@revyl/verify';
const session = await open('ios');
try {
  await session.instruction('Open General, then About');
  await session.validation('The screen shows the operating system version');
} finally {
  await session.close();
}
```

For web, use `init --platform web` with a Revyl web app ID and public HTTPS URL. See [getting started](packages/verify/docs/getting-started.md).

### Go

Inside a function returning `error`, with a bounded `ctx` and imports for `context`, `time`, and `verify "github.com/RevylAI/verify/go"`:

```go
session, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"})
if err != nil {
    return err
}
defer func() {
    cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    _ = session.Close(cleanup)
}()
if _, err := session.Instruction(ctx, "Open General, then About"); err != nil {
    return err
}
_, err = session.Validation(ctx, "The screen shows the operating system version")
return err
```

This sketch ignores cleanup errors; the [complete Go examples](go/README.md) handle them. Go has no process-exit handlers. TypeScript's automatic cleanup is best effort, bounded to 15 seconds, and skips signal/error handlers that already have listeners. Always close explicitly: device close acknowledges a stop request; computer close requires terminal state and confirmed release.

### Platforms

| Platform | Instructions / validations | Commands / files / processes | PNG screenshot | Availability |
| --- | :---: | :---: | :---: | --- |
| Web | Yes | — | Yes | Production; selected backend must support web steps |
| iOS simulator | Yes | — | Yes | Production |
| Android emulator | Yes | — | Yes | Production |
| Mac computer | — | Yes | Yes | Staging-only early access; not in production |
| Linux computer | — | Yes | Yes | Staging-only early access; not in production |

Computers require enablement for your organization and requested OS, plus approved `REVYL_BACKEND_URL`, matching `REVYL_APP_URL` and credentials. They have a hard 60-minute lifetime from create. Mac supports `init --platform mac`; Linux init is unavailable, so use `open({ platform: 'linux' })` or a config target. See [computers](packages/verify/docs/computers.md).

## Documentation

- [Documentation index](packages/verify/docs/) · [API](packages/verify/docs/api.md) · [CI](packages/verify/docs/ci.md) · [Coding agents](packages/verify/docs/agents.md)
- [End-to-end results and limitations](packages/verify/docs/end-to-end.md)
- [Examples](examples/): [Web store](examples/web-store/) · [Mobile Settings](examples/mobile-settings/) · [Mac workspace](examples/mac-workspace/) · [Go](go/README.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releasing](RELEASING.md)

## Troubleshooting

- **`NOT_AVAILABLE_ON_PLATFORM`:** computer agent steps and device command/file methods are unavailable. Computers also need staging enablement; web steps need backend support. Check the [platform contract](packages/verify/docs/errors.md).
- **`COMPUTER_LIMIT`:** admission was refused because of queued work or a concurrency limit. Wait for capacity; Verify does not retry creation or stop a definitely refused start.
- **Blank first screen:** mobile startup makes a bounded, best-effort blank-frame observation, not a rendered/foreground-readiness guarantee. Begin with an instruction that reaches the screen you need. Computer capture retries structured startup screen-not-ready responses for a fixed 30-second window; Linux screenshot retry is tests-only, not proven live.
- **A report's counters look successful but validation failed:** inspect `effective_status`, `validation_result` and `validations_passed` against `total_validations`, not transport counts. Failed SDK validations throw by default. See [reading the verdict](packages/verify/docs/end-to-end.md#reading-the-verdict).

## License

[Apache 2.0](LICENSE).
