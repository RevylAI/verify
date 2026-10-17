# Getting started

Verify needs Node.js 22.18 or later, which runs TypeScript files directly, and a Revyl account.

## 1. Create a config and an example script

```bash
npx @revyl/verify init
```

`init` asks what you want to open (web, iOS, or Android), your Revyl app id, and for web, the URL to open. It writes two files and adds `.verify/` to `.gitignore`:

- `verify.config.ts`: the targets `open()` can start, by name
- `verify/example.ts`: a script that opens the target, runs a step or two, takes a screenshot, and closes

In scripts and CI, pass the answers as flags:

```bash
npx @revyl/verify init --platform web --app-id <revyl-app-id> --url https://staging.example.com
npx @revyl/verify init --platform ios --app-id <revyl-app-id>
```

## 2. Install Verify

```bash
npm install --save-dev @revyl/verify
```

## 3. Authenticate

Verify uses the same credentials as the Revyl CLI, in the same order:

1. `REVYL_API_KEY`, an API key you create in Revyl's settings.
2. A login stored by the Revyl CLI in `~/.revyl/credentials.json` (`revyl auth login`).

```bash
export REVYL_API_KEY=...        # or: revyl auth login
npx verify whoami               # checks the credentials without starting a session
```

## 4. Point the config at your app

Every target needs a Revyl app. Open the app in Revyl and copy its id into `app.appId`, or set `REVYL_APP_ID`, which the generated config reads.

- **Web:** set `app.url` to a public HTTPS URL, such as a staging or preview deployment. Revyl's cloud browser cannot reach `localhost`. See [web.md](web.md).
- **iOS and Android:** upload a build to the app in Revyl, for example with `revyl build upload`; each session installs the newest one. See [mobile.md](mobile.md).

## 5. Run the script

```bash
node verify/example.ts
```

If Node warns that the module type is not specified, add `"type": "module"` to your `package.json` or rename the script to `example.mts`.

```text
[verify] ios: starting ios session https://app.revyl.ai/sessions/…
[verify] ios: ready
[verify] ios: ✓ validation "The app has opened and shows its first screen without an error" (9.8s)
[verify] ios: closed
```

Open the link to watch the session live. After the session ends, the link keeps its recording, and the Revyl CLI prints its stored report: `revyl device report --session-id <id>`.

## The whole API

```ts
import { open } from '@revyl/verify';

const session = await open('ios');                                   // a target from verify.config.ts
await session.instruction('Add the first product to the cart');      // Revyl's agent does it
await session.validation('The cart badge shows 1');                  // throws if it does not hold
await session.screenshot({ path: '.verify/cart.png' });
await session.close();
```

A failed instruction or validation throws a `VerifyError`. In a plain script, that ends the script with exit code 1, and Verify closes the session before the process exits. See [api.md](api.md) for every option, and [ci.md](ci.md) for calling Verify from a test runner.
