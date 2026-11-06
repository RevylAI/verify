# Verify

![Terminal output from one Verify script beside a Mac computer's Terminal window showing the macOS version, and the screens the script reached in a cloud browser, an Android emulator, and an iOS simulator](docs/images/verify-hero.webp)

Verify runs end-to-end checks in a cloud browser, iOS simulator, or Android emulator on Revyl. You write what the agent should do and what must be true afterward, in plain sentences, and call it from a script, a coding agent, CI, or the test runner you already use. Verify also opens Mac and Linux computers for commands, files, and screenshots.

```ts
import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
try {
  await session.instruction('Open General, then About');
  await session.validation('The screen shows the operating system version');
  await session.screenshot({ path: '.verify/about.png' });
} finally {
  await session.close();
}
```

You maintain sentences instead of selectors and coordinates that break when a screen changes, and every run prints a session link that keeps the report and available recording after the session closes.

## Quick start

```bash
npx @revyl/verify init
```

`init` adds Verify to your project, asks what to open, writes `verify.config.ts` and an example script, signs you in through the browser on the first interactive run, and prints the command that runs the example. To skip the config, run `npm install @revyl/verify` and save the example above as `verify/check.mts`, then run `node verify/check.mts`. [Getting started](packages/verify/docs/getting-started.md) covers sign-in, your own app, and [CI](packages/verify/docs/ci.md).

For finished projects, see [`examples/`](examples/): a [web store](examples/web-store/), [mobile Settings](examples/mobile-settings/), a [Mac workspace](examples/mac-workspace/), and a small [agent platform](examples/agent-platform/) that runs web and iOS side by side.

## Packages

| Package | Install | Status |
| --- | --- | --- |
| [`@revyl/verify`](https://www.npmjs.com/package/@revyl/verify) | `npm install @revyl/verify` | TypeScript SDK and the `verify` CLI (`init`, `whoami`). Published on npm, Node.js 22.18 or later. |
| [`revyl-verify`](https://www.npmjs.com/package/revyl-verify) (npm) | `npm install revyl-verify` | Alias of `@revyl/verify` at the same version. |
| [Go module](https://github.com/RevylAI/verify/tree/go/v0.2.0/go) | `go get github.com/RevylAI/verify/go@v0.2.0` | Published as the `go/v0.2.0` tag, Go 1.26.9 or later. Calls return errors instead of throwing. |
| [Python SDK](python/README.md) | Install from source; see the [Python guide](python/README.md) | Not published to PyPI yet. Python 3.10 or later, sync and asyncio APIs, no CLI. |

## Platforms

| Platform | Instructions / validations | Commands / files / processes | PNG screenshot |
| --- | :---: | :---: | :---: |
| Web | Yes | — | Yes |
| iOS simulator | Yes | — | Yes |
| Android emulator | Yes | — | Yes |
| Mac computer | — | Yes | Yes |
| Linux computer | — | Yes | Yes |

Web is available to every organization. Mac and Linux computers are early access and have a server-bounded lifetime; see [computers](packages/verify/docs/computers.md).

## Documentation

The [documentation](packages/verify/docs/) covers the [API](packages/verify/docs/api.md), [configuration](packages/verify/docs/configuration.md), [web](packages/verify/docs/web.md), [mobile](packages/verify/docs/mobile.md), [computers](packages/verify/docs/computers.md), [CI](packages/verify/docs/ci.md), [per-PR environments](packages/verify/docs/environments.md), [errors and troubleshooting](packages/verify/docs/errors.md), [coding agents](packages/verify/docs/agents.md), and [live end-to-end results](packages/verify/docs/end-to-end.md). The npm package ships these pages in `node_modules/@revyl/verify/docs/`, with an [llms.txt](packages/verify/docs/llms.txt) index, so a coding agent can read the docs for the version you installed. The Revyl docs site has an overview at [docs.revyl.com/verify](https://docs.revyl.com/verify).

## Security

Don't open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) and email support@revyl.ai. Each session is a paid remote session that acts on your app, and step text is sent to Revyl and printed to stderr, so use test accounts and keep credentials and customer data out of steps.

## Telemetry

Verify sends no usage telemetry of its own. Its requests to the Revyl API carry a `User-Agent` with the Verify and runtime versions and an `X-Revyl-Client: verify` header.

## Status

Verify is at 0.x, so APIs can still change between minor releases; the [changelog](CHANGELOG.md) records each release. Mac and Linux computers are early access. See [Contributing](CONTRIBUTING.md) and [Releasing](RELEASING.md) to work on Verify.

## License

[Apache 2.0](LICENSE).
