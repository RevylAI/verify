# iOS and Android

An `ios` or `android` target opens your app on a Revyl cloud simulator or emulator.

```ts
{ platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: 'iOS 18.5' } }
{ platform: 'android', app: { buildId: '…' }, device: { model: 'Pixel 7', osVersion: 'Android 14' } }
{ platform: 'android', app: { artifactUrl: 'https://ci.example.com/app-release.apk' } }
{ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }   // an app already on the device
```

## Choosing the app

- `app.appId` installs the app's newest build in Revyl. Upload builds with the Revyl CLI (`revyl build upload`) or from your CI.
- `app.buildId` pins one build, so every session runs the same binary.
- `app.artifactUrl` installs from an HTTPS URL.
- `app.bundleId` launches an app that is already on the device, such as Settings, instead of installing one.

## Devices

`device.model` and `device.osVersion` pick the simulator or emulator. Write them as Revyl names them: `'iOS 18.5'` and `'Android 14'`, not `'18.5'` or `'14'`. Without them, Revyl picks its default for the platform, and with only a model, its default OS version, which that model must support. A value Revyl doesn't offer throws `INVALID_ARGUMENT` before any session starts, and the message lists the models or versions it accepts. To run the same script on several devices, give each its own target and open them one after another or in parallel:

```ts
targets: {
  'iphone-air': { platform: 'ios', app: { appId }, device: { model: 'iPhone Air' } },
  'iphone-16': { platform: 'ios', app: { appId }, device: { model: 'iPhone 16', osVersion: 'iOS 18.5' } },
},
```

```ts
for (const name of ['iphone-air', 'iphone-16']) {
  const session = await open(name);
  try {
    await session.validation('The onboarding screen fits without overlapping text');
  } finally {
    await session.close();
  }
}
```

## Steps

`instruction` and `validation` run as live steps on the device. Verify polls each step until Revyl reports it done, and cancels it on Revyl if it runs past its timeout.

After connection and any explicit bundle launch, `open()` makes a best-effort first-screen observation for up to 10 seconds, bounded by `startTimeout`. It looks for different RGB pixels in the central 80% of a PNG, excluding status and navigation bars. This is a blank-frame heuristic, not proof that the requested app is foreground or finished rendering: the runtime exposes no rendered-readiness signal. A timeout, unavailable screenshot, or undecodable image does not fail `open()`; it emits a `debug:` progress note through the configured logger and continues. `log: false` suppresses that note.

The generated mobile example starts with an instruction to wait for the first screen before validating it. For your own scripts, make the first instruction describe the screen or action you actually need; a screenshot with content can still show a loading screen or another app.

For Android Settings (`bundleId: 'com.android.settings'`), instruct the agent to scroll or navigate until the OS version is visible before validating it, as in `instruction('Open About phone, then scroll or navigate until the Android version is visible')`. Opening About alone can leave the version offscreen.

## Exact actions

**Early access.** Since TypeScript (`@revyl/verify`) 0.4.0, Python (`revyl-verify`) 0.2.0 and Go v0.3.0. `doubleTap`, `longPress`, `drag`, `typeFocused`, `goHome`, and Web keys and modifiers in `pressKey`, are new in TypeScript 0.5.0, Python 0.3.0 and Go v0.4.0. The [Python](https://github.com/RevylAI/verify/blob/v0.6.2/python/README.md#exact-actions) and [Go](https://github.com/RevylAI/verify/blob/v0.6.2/go/README.md#exact-actions) READMEs show them with each language's names. When you know exactly what to press, skip the agent. Exact actions run on the device as given, with no model, and mix freely with `instruction()` and `validation()` in one script:

```ts
import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
try {
  await session.tap({ target: 'General row' });                  // Revyl finds the element you describe
  await session.tap({ target: 'About row' });
  await session.validation('The screen shows the operating system version');
  await session.tap({ target: 'Back button' });                  // iOS has no back(), so tap the button
  await session.tap({ target: 'Back button' });

  await session.swipe('down');                                   // the finger moves down, so the list scrolls to the top
  const search = await session.locate('Search field');           // a point in screenshot pixels
  await session.tap(search);                                     // a tap by coordinates
  await session.type(search, 'Accessibility');
  await session.pressKey('enter');
  await session.instruction('Open the Accessibility result');    // hand the fuzzy part to the agent
  await session.validation('The Accessibility settings are shown');
} finally {
  await session.close();
}
```

A location is `{ target: 'a description' }`, which Revyl's grounding model finds on the current screen, or `{ x, y }` in screenshot pixels from the top-left corner; `screenSize()` gives the bounds. `type()` taps the field and clears it first unless you pass `{ clear: false }`. `pressKey()` takes `'enter'` or `'backspace'`; for other keys, tap the on-screen control.

More actions, new in 0.5.0, on the same Settings app:

```ts
import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
try {
  await session.goHome();                                        // the home screen
  await session.longPress({ target: 'Settings app icon' });      // press and hold, 1.5 s by default
  await session.validation('A menu for the Settings app is shown');
  await session.goHome();                                        // closes the menu
  await session.launchApp('com.apple.Preferences');
  await session.drag({ target: 'General row' }, { target: 'Search field' });  // the list follows the finger
  await session.doubleTap({ target: 'Settings title' });
  await session.longPress({ x: 660, y: 1500 }, { duration: 800 });  // a point in screenshot pixels, held for 800 ms
} finally {
  await session.close();
}
```

`goHome()` goes to the home screen on iOS and Android. `longPress()` holds for 1500 ms unless you pass `duration`, from 1 to 5000. `drag(from, to)` presses at one location, moves to the other and releases. On iOS and Android, type into a field with `type(location, text)`, which taps it first; `typeFocused()` is Web only and throws `NOT_AVAILABLE_ON_PLATFORM` here.

On Android, `back()` presses the system back button. On both platforms, `goHome()` goes to the home screen, `launchApp(bundleId)` brings an installed app to the front and `openUrl('myapp://orders/42')` opens a deep link. A failed action throws `ACTION_FAILED`. One whose outcome Revyl can't confirm throws `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. If Verify can't reach Revyl, the action fails with `API_ERROR` and isn't resent either, so check the session before trying it again. [api.md](api.md#exact-actions) lists every call.

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
