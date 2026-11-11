# iOS and Android

An `ios` or `android` target opens your app on a Revyl cloud simulator or emulator.

```ts
{ platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: '18.5' } }
{ platform: 'android', app: { buildId: '…' }, device: { model: 'Pixel 8' } }
{ platform: 'android', app: { artifactUrl: 'https://ci.example.com/app-release.apk' } }
{ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }   // an app already on the device
```

## Choosing the app

- `app.appId` installs the app's newest build in Revyl. Upload builds with the Revyl CLI (`revyl build upload`) or from your CI.
- `app.buildId` pins one build, so every session runs the same binary.
- `app.artifactUrl` installs from an HTTPS URL.
- `app.bundleId` launches an app that is already on the device, such as Settings, instead of installing one.

## Devices

`device.model` and `device.osVersion` pick the simulator or emulator. Without them, Revyl picks its default for the platform. To run the same script on several devices, give each its own target and open them one after another or in parallel:

```ts
targets: {
  'iphone-se': { platform: 'ios', app: { appId }, device: { model: 'iPhone SE (3rd generation)' } },
  'iphone-16': { platform: 'ios', app: { appId }, device: { model: 'iPhone 16' } },
},
```

```ts
for (const name of ['iphone-se', 'iphone-16']) {
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

For Android Settings, instruct the agent to scroll or navigate until the OS version is visible before validating it. Opening About alone can leave the version offscreen.

## Exact actions

**Since 0.4.0. Early access.** In TypeScript (`@revyl/verify` 0.4.0), Python (`revyl-verify` 0.2.0) and Go (v0.3.0); the [Python](https://github.com/RevylAI/verify/blob/v0.4.0/python/README.md#exact-actions) and [Go](https://github.com/RevylAI/verify/blob/v0.4.0/go/README.md#exact-actions) READMEs show them with each language's names. When you know exactly what to press, skip the agent. Exact actions run on the device as given, with no model, and mix freely with `instruction()` and `validation()` in one script:

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
  const search = await session.locate('Search field');           // where Revyl finds it, in iOS points
  await session.tap(search);                                     // a tap by coordinates
  await session.type(search, 'Wallpaper');
  await session.pressKey('enter');
  await session.instruction('Open the Wallpaper result');        // hand the fuzzy part to the agent
  await session.validation('The Wallpaper settings are shown');
} finally {
  await session.close();
}
```

A location is `{ target: 'a description' }`, which Revyl's grounding model finds on the current screen, or `{ x, y }` from the top-left corner in iOS points or Android pixels; `screenSize()` gives the bounds. `type()` taps the field and clears it first unless you pass `{ clear: false }`. `pressKey()` takes `'enter'` or `'backspace'`.

On Android, `back()` presses the system back button. On both platforms, `launchApp(bundleId)` brings an installed app to the front and `openUrl('myapp://orders/42')` opens a deep link. A failed action throws `ACTION_FAILED`. One whose outcome Revyl can't confirm throws `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. If Verify can't reach Revyl, the action fails with `API_ERROR` and isn't resent either, so check the session before trying it again. [api.md](api.md#exact-actions) lists every call.

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
