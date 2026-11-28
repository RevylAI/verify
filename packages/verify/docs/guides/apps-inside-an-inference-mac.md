# Test an iOS or Web app inside an inference Mac

**New in TypeScript 0.8.0, Python 0.6.0 and Go v0.7.0.** A Mac computer can host iOS and Web app sessions with `computer.open(target)`. When the Mac was opened with `inference`, those sessions run their steps on the Mac's own vision model first, with Revyl's hosted model as the fallback. That is the default; you don't pass anything for it.

Local inference comes with paid Revyl plans. Without one, opening the Mac with `inference` throws `NOT_AVAILABLE_ON_PLATFORM` with reason `inference_not_enabled`; upgrade the organization's plan to use it.

## What it costs

App sessions inside a computer add no device minutes of their own: you pay the Mac's minutes. Steps the Mac's model answers carry no inference charge. Steps that go to Revyl's hosted model, listed below, are billed as they are on any session.

## Open an app inside the Mac

The built-in Settings app is on every simulator and needs nothing uploaded to Revyl, so this runs as written for any organization with Mac computers and local inference.

TypeScript:

```ts
import { open } from '@revyl/verify';

const mac = await open({ platform: 'mac', inference: true });
try {
  const settings = await mac.open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
  try {
    const check = await settings.validation('The Settings app is showing its list of settings');
    console.log(check.passed, check.engine);                       // true 'local'
    await settings.instruction('Tap General');                      // one tap: the Mac's model first
    await settings.instruction('Tap About');
    const version = await settings.extract('the iOS version');      // extract: Revyl's hosted model
    console.log(version.value, version.engine);                     // e.g. '18.5' 'hosted'
    await settings.launchApp('com.apple.mobilesafari');             // open another installed app
  } finally {
    await settings.close();
  }
} finally {
  await mac.close();
}
```

Python:

```python
from revyl_verify import Target, open

with open(Target(platform="mac", inference=True)) as mac:
    settings = mac.open(Target(platform="ios", bundle_id="com.apple.Preferences"))
    try:
        check = settings.validation("The Settings app is showing its list of settings")
        print(check.passed, check.engine)  # True local
        settings.instruction("Tap General")
        settings.instruction("Tap About")
        version = settings.extract("the iOS version")
        print(version.value, version.engine)  # e.g. 18.5 hosted
        settings.launch_app("com.apple.mobilesafari")
    finally:
        settings.close()
```

Go:

```go
mac, err := verify.Open(ctx, verify.Target{Platform: verify.Mac, Inference: new(true)})
if err != nil {
	return err
}
defer mac.Close(context.Background())
settings, err := mac.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"})
if err != nil {
	return err
}
defer settings.Close(context.Background())
check, err := settings.Validation(ctx, "The Settings app is showing its list of settings")
if err != nil {
	return err
}
fmt.Println(check.Passed, check.Engine) // true local
if err := settings.LaunchApp(ctx, "com.apple.mobilesafari"); err != nil {
	return err
}
```

**Your own app.** Pass its Revyl app and an exact build instead of the bundle id: `app: { appId, buildId }` (Python `app_id=..., build_id=...`, Go `AppID`, `BuildID`). A Web session inside a Mac always takes that pair. Any other app already on the simulator opens by its bundle id, and a bundle id that can't be launched throws `SESSION_START_FAILED` with a message listing the installed apps.

**The simulator.** `device: { model: 'iPhone 16', osVersion: 'iOS 18.5' }` (Python `device_model`, `os_version`; Go `DeviceModel`, `OSVersion`) picks it, written as Revyl names them. A pair the Mac can't run throws `NOT_AVAILABLE_ON_PLATFORM`, and Revyl's message says what to pick instead. Leave both out for the Mac's default.

**Not inside a Mac:** `url`, `branch` and `artifactUrl`, Android sessions, session profiles and your own model; `computer.open()` takes only a target. Since TypeScript 0.8.2, Python 0.6.2 and Go v0.7.2, `bundleId` and `device` work for iOS inside a Mac; earlier versions needed an app and build.

Close the app session before the Mac, or just close the Mac: closing it closes the sessions inside it.

## Which steps run on the Mac's model

| Step | Who answers |
| --- | --- |
| `validation()` | The Mac's model first |
| `instruction()` that is a single tap on one thing, such as `'Tap the Sign in button'` | The Mac's model first |
| `instruction()` that does more, such as typing or `'Scroll down and then tap Back'` | Revyl's hosted model |
| `extract()` | Revyl's hosted model, so it is billed as usual. `extract()` on the Mac itself reads the Mac's own screen, not the app's |
| A step the Mac's model can't answer with confidence, or doesn't answer within 25 seconds | Falls back to Revyl's hosted model |
| Exact actions (`tap`, `type`, `swipe` and the rest) | No model; they run as on any session |

Every `StepResult` has `engine`: `'local'` when the Mac's model answered and `'hosted'` when Revyl's hosted model did. A session not opened inside an inference Mac leaves it out (Python `None`, Go `""`). Within a session inside an inference Mac, a local answer the Mac's model isn't sure of goes to the hosted model, so a soft validation still comes back passed or failed.

A verdict the Mac's model gives is final: a validation it passes or fails isn't checked again by the hosted model. If a check matters more than its speed, run that session with the hosted model, as below.

## Turn it off for one session

Pass `inference: false` to `computer.open()` (Python `Target(..., inference=False)`, Go `Inference: new(false)`), and that session's steps run on Revyl's hosted model as they do outside a computer:

```ts
const app = await mac.open({ platform: 'ios', inference: false, app: { appId, buildId } });
```

Sessions inside a Mac opened without `inference` always use the hosted model. Macs host iOS and Web sessions; Android sessions don't run inside a Mac.

## When the Mac's model is down

If the Mac's model isn't answering when the app session starts, Revyl refuses the start instead of quietly using the hosted model: `computer.open()` throws `NOT_AVAILABLE_ON_PLATFORM` with reason `computer_local_inference_unavailable`, and nothing was started. Check `mac.inference` (Python `mac.inference`, Go `mac.Inference()`), try again shortly, or open the session with `inference: false` to run it on the hosted model.

The Mac's model answers one step at a time, shared by the Mac and every session inside it. Run one step at a time per computer.

See [computers.md](../computers.md#lifecycle-and-transport) for how hosted sessions start and stop, and [checks on the Mac's own screen](mac-model-checks.md) to use the same model on the Mac itself.
