# iOS and Android

An `ios` or `android` target runs your app on a Revyl cloud simulator or emulator.

```ts
{ platform: 'ios', app: { appId: '…' }, device: { model: 'iPhone 16', osVersion: '18.5' } }
{ platform: 'android', app: { buildId: '…' }, device: { model: 'Pixel 8' } }
{ platform: 'android', app: { artifactUrl: 'https://ci.example.com/app-release.apk' } }
{ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }   // a preinstalled system app
```

## Installing the app

- `app.appId` installs the app's newest build in Revyl. Upload builds with the Revyl CLI (`revyl build upload`) or from your CI.
- `app.buildId` pins one build, which makes a run reproducible.
- `app.artifactUrl` installs from an HTTPS URL.
- `app.bundleId` alone launches an app that is already on the device.

## How elements are found

Mobile locators read the app's native UI tree from the device (UIAutomator on Android, the accessibility tree on iOS) and tap the center of the element. That makes them exact:

- `getByText` matches visible text and accessibility labels.
- `getByLabel` matches `content-desc` on Android and `accessibilityLabel` on iOS.
- `getByTestId` matches `resource-id` on Android (`com.shop:id/email` or just `email`) and `accessibilityIdentifier` on iOS. In React Native, `testID` maps to both.
- `getByRole` maps native classes: for example `android.widget.Button` and iOS `Button` are `button`, `EditText` and `TextField` are `textbox`.
- Only elements whose center is on screen count. Scroll first (`app.scroll('down')`) to reach elements below the fold.
- When several elements match, actions fail with `LOCATOR_AMBIGUOUS` and list the candidates; narrow the locator or pick one with `first()`, `last()`, or `nth(i)`.
- When nothing matches, the error lists the text that is on screen, which is usually enough to fix the locator.

`screen.locate('…')` uses Revyl's AI grounding model instead, for elements without text or ids, such as icons.

## Agent steps

`agent.act`, `agent.assert`, and `agent.extract` run on iOS and Android sessions. Each runs as a live step on Revyl; Verify polls it until it finishes and cancels it if it passes its timeout.

## Device controls

| Call | Notes |
| --- | --- |
| `app.launch()`, `app.close()`, `app.restart()` | Relaunch the installed app, or `bundleId` when set |
| `app.openUrl('myapp://…')` | Opens a deep link |
| `app.back()` | Android system back. iOS has none: tap the app's back button, for example `screen.getByLabel('Back').tap()` |
| `app.pressKey('Enter' \| 'Backspace')` | Other keys are web-only |
| `app.swipe(direction, { from?, durationMs? })` | From the screen center unless `from` is given, in device coordinates |
| `app.scroll(direction)` | One swipe in the opposite direction, so `scroll('down')` reveals content below |
| `app.screenshot(name)` | Saves a PNG to `.verify/artifacts` |

## Between tests

When sessions are reused (the default), Verify closes and relaunches the app before each test. App data persists; reinstalling for every test needs `reuseSessions: false`, which starts a new device per test.
