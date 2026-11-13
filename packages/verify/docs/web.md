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

**Early access.** Since TypeScript (`@revyl/verify`) 0.4.0, Python (`revyl-verify`) 0.2.0 and Go v0.3.0. `doubleTap`, `longPress`, `drag`, `typeFocused`, `goHome`, and Web keys and modifiers in `pressKey`, are new in TypeScript 0.5.0, Python 0.3.0 and Go v0.4.0. The [Python](https://github.com/RevylAI/verify/blob/v0.6.1/python/README.md#exact-actions) and [Go](https://github.com/RevylAI/verify/blob/v0.6.1/go/README.md#exact-actions) READMEs show them with each language's names. When you know exactly what to click, skip the agent. Exact actions run in the browser as given, with no model, and mix freely with `instruction()` and `validation()`:

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
  await session.swipe('down');                                   // back to the top, so the cart icon is on screen
  const cart = await session.locate('Shopping cart icon');      // a point in screenshot pixels
  await session.tap(cart);                                       // a tap by coordinates
  await session.validation('The cart lists the Sauce Labs Onesie');
  await session.back();                                          // browser history
  await session.validation('A list of products is shown');
} finally {
  await session.close();
}
```

A location is `{ target: 'a description' }`, which Revyl's grounding model finds on the current page, or `{ x, y }` in screenshot pixels from the top-left corner; `screenSize()` gives the bounds and `locate(target)` gives an element's point without acting. `type()` clicks the field and clears it first unless you pass `{ clear: false }`. `openUrl(url)` loads a page like `navigate(url)`.

More actions, new in 0.5.0, on the same store:

```ts
import { open } from '@revyl/verify';

const session = await open('web');                               // https://www.saucedemo.com in examples/web-store
try {
  await session.tap({ target: 'Username field' });
  await session.typeFocused('standard_user');                    // types into the field that has focus, replacing its text
  await session.pressKey('tab');                                 // focus moves to the password field
  await session.typeFocused('secret_sauce');
  await session.pressKey('enter');
  await session.validation('A list of products is shown');
  await session.tap({ target: 'Open Menu button' });
  await session.pressKey('escape');                              // closes the menu
  await session.validation('The side menu is closed');
  await session.doubleTap({ target: 'Products heading' });       // a double-click
  await session.pressKey('a', { modifiers: ['ctrl'] });          // a chord: a lowercase letter or digit with modifiers
  await session.longPress({ target: 'Products heading' }, { duration: 800 });  // press and hold for 800 ms
  await session.drag({ target: 'Sauce Labs Backpack description' }, { target: 'Sauce Labs Bike Light description' });  // selects the text between
} finally {
  await session.close();
}
```

`typeFocused(text)` types where the focus already is, without clicking, and replaces the field's text unless you pass `{ clear: false }`. Focus the field first, with `tap()` or `pressKey('tab')`: with no field focused, nothing is typed and no error is thrown. `pressKey()` takes `'enter'`, `'backspace'`, `'tab'`, `'escape'`, `'delete'`, `'space'`, `'arrowup'`, `'arrowdown'`, `'arrowleft'`, `'arrowright'`, `'home'`, `'end'`, `'pageup'` and `'pagedown'`, with up to four `modifiers` held (`'ctrl'`, `'shift'`, `'alt'`, `'meta'`); with modifiers a lowercase letter or digit works too. The shortcut key on Web is `'ctrl'`, so select all with `pressKey('a', { modifiers: ['ctrl'] })`: `'meta'` is not the shortcut key here, though it is Command on a [Mac computer](computers.md#screen). `longPress()` holds for 1500 ms unless you pass `duration`, from 1 to 5000. `drag(from, to)` presses at one location, moves to the other and releases. A failed action throws `ACTION_FAILED`. One whose outcome Revyl can't confirm throws `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. If Verify can't reach Revyl, the action fails with `API_ERROR` and isn't resent either, so check the session before trying it again. [api.md](api.md#exact-actions) lists every call.

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `tap({ x, y })`, `tap({ target })`, `screenSize` | Yes | Yes | Yes | Yes |
| `locate` | Yes | Yes | Yes | No, use `tap({ target })`, which returns the point it clicked, or read the point off `screenshot()` |
| `doubleTap`, `longPress`, `type`, `swipe`, `drag` | Yes | Yes | Yes | No |
| `pressKey(key, { modifiers })` | Yes: `'enter'`, `'backspace'`, `'tab'`, `'escape'`, arrows and more, with modifiers | `'enter'` and `'backspace'` only | `'enter'` and `'backspace'` only | Yes: the Web keys and modifiers, where `'meta'` is Command |
| `typeFocused(text, { clear })` | Yes, types into the focused field | No, use `type(location, text)` | No, use `type(location, text)` | Yes, with `{ clear: false }` |
| `back()` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `goHome()` | No, use `openUrl` or `navigate` | Yes, the home screen | Yes, the home screen | No |
| `openUrl(url)` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `launchApp(bundleId)` | No, use `openUrl` or `navigate` | Yes | Yes | No |
| `navigate(url)` | Yes | No, use `openUrl` | No, use `openUrl` | No |
| `instruction`, `validation`, your own model | Yes | Yes | Yes | No, use `exec()` and the screen calls above |
| `screenshot()` | Yes | Yes | Yes | Yes |
| `exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

**Coordinates.** Prefer a description, such as `tap({ target: 'Sign in button' })`: Revyl finds the element on the current screen, and you never handle coordinates. Otherwise a point is `{ x, y }` in screenshot pixels on every platform: whole numbers from the top-left corner of the image `screenshot()` returns. So a position you read off a screenshot goes to `tap()`, `type()`, `swipe()` and every other exact action unchanged. `screenSize()` returns the screenshot's width and height, and `locate()` and the points `tap()`, `doubleTap()`, `longPress()` and `type()` return use the same pixels. A point outside the screenshot is refused with `INVALID_ARGUMENT` before any action is sent, and the message names the valid range. On iOS, Verify converts the pixels to the screen's points for you. On Web they equal CSS pixels at the default device scale factor of 1, and you still pass screenshot pixels at any other. This holds from TypeScript 0.4.1, Python 0.2.1 and Go v0.3.1; earlier versions took iOS points. On a Mac computer a point is in screenshot pixels too, and `tap({ target })` returns the point it clicked in the same pixels. Verify refuses a negative or fractional point before sending it, and Revyl refuses one past the screen's edge without clicking; both throw `INVALID_ARGUMENT` naming the valid range.

A call a platform doesn't support throws `NOT_AVAILABLE_ON_PLATFORM`, and its message names the alternative.

When you pass a [`model`](own-model.md), your model uses `tap`, `doubleTap`, `longPress`, `type`, `swipe`, `drag`, `pressKey`, `openUrl` and, where the platform has them, `typeFocused`, `back` and `goHome` inside `instruction()`.
