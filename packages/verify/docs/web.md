# Web

A web target opens your app in a Revyl cloud browser.

```ts
{
  platform: 'web',
  app: { appId: '…', url: 'https://pr-123.preview.example.com' },
  viewport: { width: 1440, height: 900 },
}
```

## What it opens

- With `app.url`, each `open()` registers the URL as a build of the Revyl app (on `app.branch` when set) and opens it. The URL must be public HTTPS; Revyl's browser cannot reach `localhost` or a private network.
- With `app.buildId`, it opens that exact build.
- With neither, it opens the newest web build of the app, on `app.branch` when set and otherwise on the app's default branch.

## Signing in

Most apps need a signed-in user. Revyl can open a test-only sign-in route before the session starts, so the session begins signed in:

```ts
signIn: { path: '/__test/sign-in', secret: 'E2E_SIGN_IN_TOKEN', persona: 'admin' }
```

`secret` is the **name** of an organization secret in Revyl, never its value. Revyl sends the secret's value to `path` on your app, which should sign in a test user and redirect. Keep that route disabled in production.

## Steps on web

`instruction` and `validation` use the same Revyl endpoints on web as on iOS and Android, and each step shows up in the session's report.

Steps on web run on Revyl staging now, and reach Revyl production when Revyl promotes staging to main. To run them on staging, point Verify at it and use an API key from your Revyl staging organization:

```bash
export REVYL_BACKEND_URL=https://backend-staging.revyl.ai
export REVYL_APP_URL=https://staging.revyl.ai
export REVYL_API_KEY=...   # a key from your Revyl staging organization
```

A Revyl backend that does not run steps on web yet answers with `step_output_not_available`, which Verify reports as `NOT_AVAILABLE_ON_PLATFORM`. The same script works there with no change once it does. `open`, `screenshot`, `viewerUrl`, and `close` work on web everywhere.

Revyl runs one step at a time on a session. A step sent while another is still running, for example one that just timed out and is still being cancelled, fails with `SESSION_BUSY`.
