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
