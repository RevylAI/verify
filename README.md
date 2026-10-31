# Verify

The runtime is what matters. Verify runs end-to-end checks against a real Revyl browser, iOS simulator, Android emulator, or computer. You describe what the agent should do and what must be true afterward, instead of maintaining selectors and coordinates that break when a screen changes.

Every run gives you a link to watch the target. The session keeps its report and available recording, and the SDK keeps instruction and validation results in order. A failed check leaves evidence you can inspect.

## A small check

```ts
import { open } from '@revyl/verify';

const session = await open('ios');
try {
  await session.instruction('Open General, then About');
  await session.validation('The screen shows the operating system version');
  await session.screenshot({ path: '.verify/about.png' });
} finally {
  await session.close();
}
```

When it runs, Verify prints a live session URL and progress like this:

```text
[verify] starting ios session https://app.revyl.ai/sessions/…
[verify] ready
[verify] ✓ instruction "Open General, then About" (12.0s)
[verify] ✓ validation "The screen shows the operating system version" (9.8s)
[verify] closed
```

The URL is live during the run and keeps the report and available recording after it closes. A failed instruction or validation throws a typed error and includes the same URL.

## Setup

Run this from your project directory:

```bash
npx @revyl/verify init
```

`init` detects your package manager, asks before adding `@revyl/verify` as a dev dependency, creates `verify.config.ts` and `verify/example.ts`, signs in through the same browser approval flow as the Revyl CLI when needed, and prints the command that runs the example. Use `--yes` to accept installation without a prompt, or `--no-install` when Verify is already installed. In CI, it never prompts or opens a browser; provide `REVYL_API_KEY` as a secret instead.

The generated project starts with a named target. Use `--platform web`, `--platform ios`, `--platform android`, or `--platform mac` when you want to skip the platform question. Web and mobile targets need a Revyl app id; a Mac target does not. The generated config is ordinary TypeScript, so edit it when the example needs a pinned build, a public Web URL, or a different target.

See the [TypeScript getting-started guide](packages/verify/docs/getting-started.md), the [Python SDK guide](python/README.md), and the [Go SDK guide](go/README.md).

## CI

For a normal GitHub Actions job, install from the lockfile with `npm ci` and pass `REVYL_API_KEY` from repository secrets to the script that runs Verify:

```yaml
- uses: actions/checkout@v5
- uses: actions/setup-node@v5
  with:
    node-version: 24
    cache: npm
- run: npm ci
- run: node verify/example.ts
  env:
    REVYL_API_KEY: ${{ secrets.REVYL_API_KEY }}
```

On a `revyl-macos` job, `currentComputer()` attaches to the runner's existing computer without taking ownership. The runner releases the computer; closing the Verify attachment still cleans up hosted children. See the [CI guide](packages/verify/docs/ci.md) and [computer API](packages/verify/docs/api.md#inside-a-revyl-macos-github-actions-job).

## Manual setup

Use manual setup when you need to control the package manager or keep the generated files out of the project:

```bash
npm install --save-dev @revyl/verify
revyl auth login
npx @revyl/verify whoami
```

The SDK resolves credentials in this order: a usable stored CLI login marked `local_auth_override`, `REVYL_API_KEY`, then another usable stored CLI login. In CI, use a secret manager rather than putting a key in source, command arguments, or logs. `whoami` checks the credentials without starting a session.

## TypeScript

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

For Web, use a public HTTPS URL in the target config. For iOS and Android, point the target at an app or build in Revyl. The [API guide](packages/verify/docs/api.md) covers target options, step results, screenshots, reports, and cleanup.

## Go

Inside a function returning `error`, with a bounded `ctx`:

```go
session, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"})
if err != nil {
    return err
}
defer func() { _ = session.Close(ctx) }()
if _, err := session.Instruction(ctx, "Open General, then About"); err != nil {
    return err
}
_, err = session.Validation(ctx, "The screen shows the operating system version")
return err
```

Go calls return errors instead of throwing. The [Go reference](go/README.md) covers context deadlines, screenshots, computer operations, and hosted sessions.

## Python

```python
from revyl_verify import Target, open

with open(Target(platform="ios", bundle_id="com.apple.Preferences")) as session:
    session.instruction("Open General, then About")
    session.validation("The screen shows the operating system version")
```

Python supports synchronous and asyncio APIs, but it has no bundled CLI. The [Python reference](python/README.md) covers both APIs and computer operations.

## Platforms

| Platform | Instructions / validations | Commands / files / processes | PNG screenshot |
| --- | :---: | :---: | :---: |
| Web | Yes | — | Yes |
| iOS simulator | Yes | — | Yes |
| Android emulator | Yes | — | Yes |
| Mac computer | — | Yes | Yes |
| Linux computer | — | Yes | Yes |

Computer targets are early access and use commands, files, processes, and screenshots rather than natural-language agent steps. They have a server-bounded lifetime. See [computer setup](packages/verify/docs/computers.md).

## Documentation

- [Documentation index](packages/verify/docs/) · [API](packages/verify/docs/api.md) · [CI](packages/verify/docs/ci.md) · [Coding agents](packages/verify/docs/agents.md)
- [End-to-end results and limitations](packages/verify/docs/end-to-end.md)
- [Examples](examples/): [Web store](examples/web-store/) · [Mobile Settings](examples/mobile-settings/) · [Mac workspace](examples/mac-workspace/)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releasing](RELEASING.md)

## Troubleshooting

- **`NOT_AVAILABLE_ON_PLATFORM`:** the requested method is not available for that target. Computer targets do not run instruction or validation steps; Web and mobile targets do not expose computer commands or files.
- **`COMPUTER_LIMIT`:** computer admission was refused because of queued work or a concurrency limit. Verify does not retry creation or stop a definitely refused start.
- **Blank first screen:** mobile startup uses a bounded, best-effort blank-frame observation, not a rendered-readiness guarantee. Begin with an instruction that reaches the screen your workflow needs.
- **A validation report looks successful but the assertion failed:** inspect each step's `effective_status` and `validation_result`, and compare `validations_passed` with `total_validations` rather than transport counters.

## License

[Apache 2.0](LICENSE).
