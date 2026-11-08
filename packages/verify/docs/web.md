# Web

A web target opens your app in a Revyl cloud browser.

Web is available to every organization, including the Free plan.

```ts
{
  platform: 'web',
  app: { appId: '…', url: 'https://pr-123.preview.example.com' },
  viewport: { width: 1440, height: 900 },
}
```

## Create the Web app

A web target opens a Web app in Revyl, so create one first and copy its id:

1. **In the dashboard:** open [app.revyl.ai](https://app.revyl.ai), click **Create app**, keep **Web** selected, and enter your site's public HTTPS URL. Copy the app id from the app's page.
2. **Or with the [Revyl CLI](https://github.com/RevylAI/revyl-cli#install):** `revyl app create --name "My Web App" --platform web` prints the app id.

Then scaffold a config with it, or put it in `app.appId` yourself:

```bash
npx @revyl/verify init --platform web --app-id <app-id> --url https://example.com
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

The default Revyl service is used for normal setup. Authenticate with a matching API key or CLI login.

A Revyl backend that does not run steps on web yet answers with `step_output_not_available`, which Verify reports as `NOT_AVAILABLE_ON_PLATFORM`. The same script works there with no change once it does. `open`, `screenshot`, `viewerUrl`, and `close` work on web everywhere.

Revyl runs one step at a time on a session. A step sent while another is still running, for example one that just timed out and is still being cancelled, fails with `SESSION_BUSY`.

## Exact actions

**Since 0.4.0. Early access.** In the TypeScript SDK (`@revyl/verify`) since 0.4.0; not yet in Python or Go. When you know exactly what to click, skip the agent. Exact actions run in the browser as given, with no model, and mix freely with `instruction()` and `validation()`:

```ts
import { open } from '@revyl/verify';

const session = await open('web');                               // https://www.saucedemo.com in examples/web-store
try {
  await session.type({ target: 'Username field' }, 'standard_user');   // Revyl finds the element you describe
  await session.type({ target: 'Password field' }, 'secret_sauce');
  await session.pressKey('enter');
  await session.validation('A list of products is shown');
  await session.swipe('up');                                     // the finger moves up, so the page scrolls down
  await session.instruction('Add the Sauce Labs Onesie to the cart');  // hand the fuzzy part to the agent
  const cart = await session.locate('Shopping cart icon');      // where Revyl finds it, in CSS pixels
  await session.tap(cart);                                       // a tap by coordinates
  await session.validation('The cart lists the Sauce Labs Onesie');
  await session.back();                                          // browser history
  await session.validation('A list of products is shown');
} finally {
  await session.close();
}
```

A location is `{ target: 'a description' }`, which Revyl's grounding model finds on the current page, or `{ x, y }` from the top-left corner of the viewport; `screenSize()` gives the bounds and `locate(target)` gives an element's point without acting. `type()` clicks the field and clears it first unless you pass `{ clear: false }`. `pressKey()` takes `'enter'` or `'backspace'`, and `openUrl(url)` loads a page like `navigate(url)`. A failed action throws `ACTION_FAILED`. One whose outcome Revyl can't confirm throws `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. [api.md](api.md#exact-actions) lists every call.

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `tap`, `type`, `swipe`, `pressKey`, `locate`, `screenSize` | Yes | Yes | Yes | No, use `exec()` and files |
| `back()` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `openUrl(url)` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `launchApp(bundleId)` | No, use `openUrl` or `navigate` | Yes | Yes | No |
| `navigate(url)` | Yes | No, use `openUrl` | No, use `openUrl` | No |
| `instruction`, `validation`, your own model | Yes | Yes | Yes | No, use `exec()` |
| `screenshot()` | Yes | Yes | Yes | Yes |
| `exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

Coordinates are in iOS points, Android pixels and Web CSS pixels, from the top-left corner. A call a platform doesn't support throws `NOT_AVAILABLE_ON_PLATFORM`, and its message names the alternative.

When you pass a [`model`](own-model.md), your model uses `tap`, `type`, `swipe`, `pressKey`, `openUrl` and, where the platform has it, `back` inside `instruction()`.
