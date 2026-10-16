# Getting started

Verify needs Node.js 22.12 or later and a Revyl account.

## 1. Create a config and an example test

```bash
npx @revyl/verify init
```

`init` asks what you want to test (web, iOS, or Android), your Revyl app id, and for web, the URL to open. It writes two files and adds `.verify/` to `.gitignore`:

- `verify.config.ts`: the targets to run on
- `tests/example.verify.ts`: a first test

In scripts and CI, pass the answers as flags instead:

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

- **Web:** set `app.url` to a public HTTPS URL such as a staging or preview deployment. Revyl's cloud browser cannot reach `localhost`. Without a URL, Verify opens the app's newest web build in Revyl. See [web.md](web.md).
- **iOS and Android:** upload a build to the app in Revyl (for example with `revyl build upload`); each run installs the newest one. See [mobile.md](mobile.md).

## 5. Run

```bash
npx verify run
```

Verify starts one cloud browser or device per target, prints a link to watch each session live, runs the tests, and stops the sessions when it finishes. Results go to the terminal and to `.verify/results.json`; failure screenshots go to `.verify/artifacts/`.

```text
Running 1 test on web with 1 worker

  web: web session https://app.revyl.ai/sessions/…
  ✓ [web] tests/example.verify.ts › the home page loads (21.4s)

  1 passed (48.2s)
```

Next, read [writing-tests.md](writing-tests.md).
