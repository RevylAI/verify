# Getting started

Verify needs Node.js 22.18 or later, which runs TypeScript files directly, and a Revyl account.

## 1. Create a config and an example script

```bash
npx @revyl/verify init
```

`init` asks what you want to open (web, iOS, Android, or Mac), your Revyl app id for web/mobile, and for web, the URL to open. It writes two files and adds `.verify/` to `.gitignore`:

- `verify.config.ts`: the targets `open()` can start, by name
- `verify/example.ts`: a script that opens the target, runs steps and takes a screenshot (web/mobile) or checks commands and files (Mac), and closes

In scripts and CI, pass the answers as flags:

```bash
npx @revyl/verify init --platform web --app-id <revyl-app-id> --url https://example.com
npx @revyl/verify init --platform ios --app-id <revyl-app-id>
npx @revyl/verify init --platform mac
```

## 2. Install Verify

```bash
npm install --save-dev @revyl/verify
```

## 3. Authenticate

Verify uses the same credential precedence as the Revyl CLI:

1. A usable login in `~/.revyl/credentials.json` marked `local_auth_override` takes precedence, even when `REVYL_API_KEY` is set.
2. Otherwise, `REVYL_API_KEY`, an API key you create in Revyl's settings.
3. Otherwise, a usable login stored by the Revyl CLI (`revyl auth login`). Expired access tokens fall back to a stored API key when present.

```bash
export REVYL_API_KEY=...        # or: revyl auth login
npx @revyl/verify whoami         # checks the credentials without starting a session
```

## 4. Point the config at your app

Web and mobile targets need an app. Open the app in Revyl and copy its id into `app.appId`, or set `REVYL_APP_ID`, which the generated config reads. Mac and Linux targets need no app id. Linux init is intentionally unavailable; use `open({ platform: 'linux' })` or add a Linux config target.

- **Web:** set `app.url` to a public HTTPS URL. Revyl's cloud browser cannot reach `localhost`. See [web.md](web.md).
- **iOS and Android:** upload a build to the app in Revyl, for example with `revyl build upload`; each session installs the newest one. See [mobile.md](mobile.md).
- **Mac and Linux:** computers are early access; ask support@revyl.ai about access. Agent instruction/validation are unavailable. See [computers.md](computers.md#availability-and-errors).

## 5. Run the script

```bash
node verify/example.ts
```

If Node warns that the module type is not specified, add `"type": "module"` to your `package.json` or rename the script to `example.mts`.

Illustrative output (durations vary):

```text
[verify] ios: starting ios session https://app.revyl.ai/sessions/…
[verify] ios: ready
[verify] ios: ✓ instruction "Wait for the app to finish opening and show its first screen" (12.0s)
[verify] ios: ✓ validation "The app has opened and shows its first screen without an error" (9.8s)
[verify] ios: closed
```

Open the link to watch the session live. After the session ends, the link keeps its report and any available recording. The Revyl CLI prints the stored report with `revyl device report --session-id <id>` for web/mobile, or `revyl computer report <id>` for computers. Computer recordings can be absent or still processing after release; `recording()` retrieves optional private metadata without waiting or downloading.

For validation verdicts in device reports, inspect each step's `effective_status` and `validation_result`, and compare `validations_passed` with `total_validations`. `passed_steps`, `failed_steps`, and transport `status: success` can describe successful execution of a validation whose verdict is false. See the [live example](end-to-end.md#reading-the-verdict).

## The whole API

```ts
import { open } from '@revyl/verify';

const session = await open('ios');                                   // a target from verify.config.ts
try {
  await session.instruction('Add the first product to the cart');    // Revyl's agent does it
  await session.validation('The cart badge shows 1');                // throws if it does not hold
  await session.screenshot({ path: '.verify/cart.png' });
} finally {
  await session.close();
}
```

A failed instruction or validation throws a `VerifyError`. An uncaught error in a plain script exits non-zero. Automatic cleanup is best effort, bounded to 15 seconds, and skips signal/error handlers that already have listeners. Always close in `try/finally`; a successful web/mobile close acknowledges the stop request, not confirmed physical release. Computer close requires confirmed terminal release. See [api.md](api.md) for cleanup details and every option, and [ci.md](ci.md) for calling Verify from a test runner.
