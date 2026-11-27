# Test an iOS or Web app inside an inference Mac

**New in TypeScript 0.8.0, Python 0.6.0 and Go v0.7.0.** A Mac computer can host iOS and Web app sessions with `computer.open(target)`. When the Mac was opened with `inference`, those sessions run their steps on the Mac's own vision model first, with Revyl's hosted model as the fallback. That is the default; you don't pass anything for it.

Local inference comes with paid Revyl plans. Without one, opening the Mac with `inference` throws `NOT_AVAILABLE_ON_PLATFORM` with reason `inference_not_enabled`; upgrade the organization's plan to use it.

## What it costs

App sessions inside a computer add no device minutes of their own: you pay the Mac's minutes. Steps the Mac's model answers carry no inference charge. Steps that go to Revyl's hosted model, listed below, are billed as they are on any session.

## Open the app inside the Mac

You need an app and build in Revyl, as for any hosted session: its `appId` and `buildId`.

TypeScript:

```ts
import { open } from '@revyl/verify';

const mac = await open({ platform: 'mac', inference: true });
try {
  const app = await mac.open({ platform: 'ios', app: { appId: process.env.IOS_APP_ID!, buildId: process.env.IOS_BUILD_ID! } });
  try {
    const check = await app.validation('The sign-in screen is showing');
    console.log(check.passed, check.engine);                              // true 'local'
    await app.instruction('Tap the Sign in button');                        // one tap: the Mac's model first
    await app.type({ target: 'the email field' }, 'user@example.com');      // exact actions work as usual
    const greeting = await app.extract('the greeting at the top');          // extract: Revyl's hosted model
    console.log(greeting.value, greeting.engine);                           // ... 'hosted'
  } finally {
    await app.close();
  }
} finally {
  await mac.close();
}
```

Python:

```python
import os

from revyl_verify import Target, open

with open(Target(platform="mac", inference=True)) as mac:
    app = mac.open(Target(platform="ios", app_id=os.environ["IOS_APP_ID"], build_id=os.environ["IOS_BUILD_ID"]))
    try:
        check = app.validation("The sign-in screen is showing")
        print(check.passed, check.engine)  # True local
        app.instruction("Tap the Sign in button")
        greeting = app.extract("the greeting at the top")
        print(greeting.value, greeting.engine)  # ... hosted
    finally:
        app.close()
```

Go:

```go
mac, err := verify.Open(ctx, verify.Target{Platform: verify.Mac, Inference: new(true)})
if err != nil {
	return err
}
defer mac.Close(context.Background())
app, err := mac.Open(ctx, verify.Target{Platform: verify.IOS, AppID: os.Getenv("IOS_APP_ID"), BuildID: os.Getenv("IOS_BUILD_ID")})
if err != nil {
	return err
}
defer app.Close(context.Background())
check, err := app.Validation(ctx, "The sign-in screen is showing")
if err != nil {
	return err
}
fmt.Println(check.Passed, check.Engine) // true local
```

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
