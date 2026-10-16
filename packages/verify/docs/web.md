# Web

A web target runs your app in a Revyl cloud browser. Verify drives it through Revyl's public device API, the same way the Revyl CLI does.

```ts
{
  platform: 'web',
  app: { appId: '…', url: 'https://pr-123.preview.example.com' },
  viewport: { width: 1440, height: 900 },
}
```

## What it opens

- With `app.url`, each run registers the URL as a build of the Revyl app (on `app.branch` when set) and opens it. The URL must be public HTTPS; Revyl's browser cannot reach `localhost` or a private network.
- With `app.buildId`, it opens that exact build.
- With neither, it opens the newest web build of the app (on `app.branch` when set, otherwise the app's default branch).

## Signing in

Most apps need a signed-in user. Revyl can open a test-only sign-in route before the session starts, so tests begin signed in:

```ts
signIn: { path: '/__test/sign-in', secret: 'E2E_SIGN_IN_TOKEN', persona: 'admin' }
```

`secret` is the **name** of an organization secret in Revyl, never its value. Revyl sends the secret's value to `path` on your app, which should sign in a test user and redirect. Keep that route disabled in production.

## How elements are found

Revyl web sessions expose screenshots and input, not a DOM, so web locators use Revyl's AI grounding model:

- `getByText`, `getByLabel`, and `getByRole` turn into descriptions, for example `getByRole('button', { name: 'Add to cart' })` becomes "the "Add to cart" button".
- `screen.locate('…')` passes your description straight through. Be specific: "the Delete button in the second row", not "Delete".
- `getByTestId`, `nth()`, regular expressions, `textContent()`, `isEnabled()`, `count()`, `toHaveText`, `toBeEnabled`, and `toHaveCount` need element state that a screenshot cannot provide, and fail with `NOT_AVAILABLE_ON_PLATFORM`. Use `agent.assert` or `agent.extract` for those checks.

## Agent steps on web

`agent.act`, `agent.assert`, and `agent.extract` use the same Revyl endpoint on web as on mobile. Revyl's live web sessions do not run agent steps yet and answer with `step_output_not_available`, which Verify reports as `NOT_AVAILABLE_ON_PLATFORM`. When Revyl enables them, the same tests start working with no change to Verify or to your tests. Until then, drive web tests with locators, `expect`, and `app`.

## Browser controls

`app.openUrl(url)`, `app.back()`, `app.reload()`, `app.scroll(direction, { amount })`, `app.pressKey(key)` (Enter, Backspace, Tab, Escape, Delete, Space, arrows, Home, End, PageUp, PageDown), and `app.screenshot()` work on web. `app.launch()` and `app.close()` are for iOS and Android only.

## Between tests

When sessions are reused (the default), Verify reopens the start URL before each test. Cookies and storage persist, so a signed-in user stays signed in. Set `reuseSessions: false` for a fresh browser per test.
