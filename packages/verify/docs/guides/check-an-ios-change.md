# Check an iOS change from your coding agent

After a coding agent changes your iOS app, it can check the change itself: open the app on a Revyl cloud iOS simulator, tell Revyl's agent what to do in plain language, check what the screen shows, and hand you a link to watch the run. This guide builds that script in TypeScript, with the same calls in Python and Go.

## What you'll build

A script that:

1. Opens an iOS simulator with your app (or the Settings app, to try it before you upload anything).
2. Runs one `instruction()`, which Revyl's agent carries out on the screen.
3. Runs one `validation()`, which passes or throws.
4. Prints the session's live link, saves a screenshot and closes the session.

## Before you start

- A Revyl account. Sign in once with `npx @revyl/verify login`, or set `REVYL_API_KEY` in the environment (CI, agents without a browser).
- Node.js 22.18 or later, which runs TypeScript files directly, and `npm install @revyl/verify` in your project.

## The script

Save this as `check-ios.mts`:

```ts
import { open } from '@revyl/verify';

const session = await open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });
console.log(`Live view: ${session.viewerUrl}`);
try {
  await session.instruction('Open General, then About.');
  const check = await session.validation('The screen shows the iOS version.');
  console.log(`Validation passed: ${check.passed}. ${check.reason ?? ''}`);
  await session.screenshot({ path: 'about.png' });
  console.log('Saved about.png');
} finally {
  await session.close();
}
```

Run it with `node check-ios.mts`. The `.mts` extension makes Node run it as an ES module in any project.

## What you'll see

The session link appears while the simulator is still starting, so you can open it and watch. A run takes about 2 minutes: 20 to 40 seconds to start, 30 to 60 seconds for the instruction and about 10 seconds for the validation.

```text
[verify] ios: starting ios session https://app.revyl.ai/sessions/<session id>
[verify] ios: ready
Live view: https://app.revyl.ai/sessions/<session id>
[verify] ios: ✓ instruction "Open General, then About." (1m 1s)
[verify] ios: ✓ validation "The screen shows the iOS version." (9.5s)
Validation passed: true. The screen shows the About section of Settings, where 'iOS Version' is listed …
Saved about.png
[verify] ios: closed
```

The script exits 0 when the validation passes. When it doesn't, `validation()` throws `VALIDATION_FAILED` with Revyl's reason, and the script exits non-zero, which is what an agent or CI job needs to notice. The link keeps the session's recording and steps after it closes.

## Check your own app

Replace the target's `app` with your app in Revyl, and the steps with the change you made:

```ts
const session = await open({ platform: 'ios', app: { appId: '<your app id>' } });   // installs the app's newest build
// or pin one binary: app: { buildId: '<build id>' }

await session.instruction('Add the first product to the cart.');
await session.validation('The cart badge shows 1.');
```

Upload builds with the Revyl CLI (`revyl build upload`) or from your CI; see [mobile.md](../mobile.md). Write one instruction per goal and one statement per validation. To read a verdict without throwing, pass `{ soft: true }` and check `passed`.

## Hand it to your agent

Tell your coding agent, in its instructions file or the prompt: "After you change the iOS app, run `node check-ios.mts` with the steps that prove your change, and include the live view link in your reply." The agent reads the docs that ship in `node_modules/@revyl/verify/docs/`, so it can adjust the steps itself.

## Python

```python
from revyl_verify import Target, open

with open(Target(platform="ios", bundle_id="com.apple.Preferences")) as session:
    print("Live view:", session.viewer_url)
    session.instruction("Open General, then About.")
    check = session.validation("The screen shows the iOS version.")
    print("Validation passed:", check.passed, check.reason)
    session.screenshot(path="about.png")
```

Install with `pip install revyl-verify`. Leaving the `with` block closes the session. Your app: `Target(platform="ios", app_id="<your app id>")` or `build_id="<build id>"`.

## Go

```go
s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"})
if err != nil {
	return err
}
defer s.Close(context.Background())
fmt.Println("Live view:", s.ViewerURL())
if _, err := s.Instruction(ctx, "Open General, then About."); err != nil {
	return err
}
check, err := s.Validation(ctx, "The screen shows the iOS version.")
if err != nil {
	return err // verify.ErrValidationFailed when it doesn't hold
}
fmt.Println("Validation passed:", check.Passed, check.Reason)
_, err = s.Screenshot(ctx, "about.png")
return err
```

Install with `go get github.com/RevylAI/verify/go@v0.7.2`; the [Go README](https://github.com/RevylAI/verify/blob/go/v0.7.2/go/README.md#quick-start-ios-settings) has the whole program. Your app: `AppID: "<your app id>"` or `BuildID: "<build id>"`.

## Limits and errors

| What happened | Error | What to do |
| --- | --- | --- |
| No saved login and no `REVYL_API_KEY` | `AUTH_MISSING` | Run `npx @revyl/verify login`, or set `REVYL_API_KEY` |
| The statement didn't hold | `VALIDATION_FAILED` | Read the reason, and watch the run at the session link |
| Revyl's agent couldn't do the instruction | `INSTRUCTION_FAILED` | Split it into smaller instructions, or name what's on the screen |
| The simulator or the app didn't start | `SESSION_START_FAILED` | Check the app id or build, then open the session link |
| A step ran past its limit (180 s by default) | `TIMEOUT` | Pass `{ timeout }` to the step, or split it |

[errors.md](../errors.md) lists every code.

## Clean up

`close()` in `finally` ends the session even when a step throws. Verify also tries to close open sessions on Ctrl+C, SIGTERM or an uncaught error. A process killed outright leaves the session running until its idle timeout, 10 minutes by default.

## Next

- [One script, every platform](every-platform.md): the same checks on iOS, Android and the web at once.
- [api.md](../api.md#sessioninstructiontext-options) for every option of `instruction()` and `validation()`.
