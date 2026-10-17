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

`instruction` and `validation` use the same Revyl endpoint on web as on iOS and Android. Revyl's live web sessions do not run these steps yet. They answer with `step_output_not_available`, which Verify reports as `NOT_AVAILABLE_ON_PLATFORM`. When Revyl enables steps on web, the same code starts working with no change to Verify or to your scripts.

`open`, `screenshot`, `viewerUrl`, and `close` work on web today.
