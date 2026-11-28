# One script, every platform: iOS, Android and the web at once

The same Verify calls work on a cloud browser, an iOS simulator and an Android emulator. This guide runs one check on each, in parallel, from a single script, so one change is checked everywhere it ships in the time of the slowest platform.

## What you'll build

A script that opens three sessions at once, each with its own target and steps:

| Platform | Target | Steps |
| --- | --- | --- |
| Web | A cloud browser opening `https://www.saucedemo.com` | Validate the login form |
| iOS | The Settings app on an iOS simulator | Open General, then About; validate the iOS version |
| Android | The Settings app on an Android emulator | Open About phone; validate the Android version |

Each session prints its live link, runs its steps, saves a screenshot and closes. The script reports each platform's result and exits non-zero if any failed.

## Before you start

- A Revyl account, signed in with `npx @revyl/verify login` or with `REVYL_API_KEY` set.
- Node.js 22.18 or later and `npm install @revyl/verify` in an ESM project.

## The script

Save this as `every-platform.mts`:

```ts
import { open, type TargetConfig } from '@revyl/verify';

const checks: Record<string, { target: TargetConfig; instruction?: string; validation: string }> = {
  web: {
    target: { platform: 'web', app: { url: 'https://www.saucedemo.com' } },
    validation: 'The Swag Labs login form is shown.',
  },
  ios: {
    target: { platform: 'ios', app: { bundleId: 'com.apple.Preferences' } },
    instruction: 'Open General, then About.',
    validation: 'The screen shows the iOS version.',
  },
  android: {
    target: { platform: 'android', app: { bundleId: 'com.android.settings' } },
    instruction: 'Open About phone, then scroll or navigate until the Android version is visible.',
    validation: 'The screen shows the Android version.',
  },
};

const platforms = (process.env.PLATFORMS ?? 'web,ios,android').split(',');

const results = await Promise.allSettled(
  platforms.map(async (name) => {
    const { target, instruction, validation } = checks[name];
    const session = await open(target);
    console.log(`${name}: ${session.viewerUrl}`);
    try {
      if (instruction) await session.instruction(instruction);
      await session.validation(validation);
      await session.screenshot({ path: `${name}.png` });
    } finally {
      await session.close();
    }
  }),
);

results.forEach((result, i) => {
  const outcome = result.status === 'fulfilled' ? 'passed' : `failed: ${result.reason}`;
  console.log(`${platforms[i]} ${outcome}`);
});
if (results.some((result) => result.status === 'rejected')) process.exitCode = 1;
```

Run it with `node every-platform.mts`. `PLATFORMS=ios,android` runs a subset. The `.mts` extension makes Node run it as an ES module in any project.

## What you'll see

```text
[verify] android: starting android session https://app.revyl.ai/sessions/<id>
[verify] web: Revyl web app <app-id> for https://www.saucedemo.com (pin it with app: { appId: '<app-id>' })
[verify] web: starting web session https://app.revyl.ai/sessions/<id>
[verify] ios: starting ios session https://app.revyl.ai/sessions/<id>
…
[verify] web: ✓ validation "The Swag Labs login form is shown." (15.0s)
[verify] web: closed
[verify] ios: ✓ instruction "Open General, then About." (32.4s)
[verify] ios: ✓ validation "The screen shows the iOS version." (9.3s)
[verify] android: ✓ instruction "Open About phone, then scroll or navigate until the Android version is visible." (1m 9s)
[verify] android: ✓ validation "The screen shows the Android version." (9.5s)
web passed
ios passed
android passed
```

A web session belongs to a web app in Revyl: Verify finds or creates one for the URL's origin, named `Verify: www.saucedemo.com`, and prints its id (with `created;` the first time). Add `appId` to pin it. The web check usually finishes first, in under a minute. The whole run takes as long as the slowest platform, about 2 minutes.

## How it works

- **One `open()` per platform.** Only the target changes: `platform` and `app`. `instruction()`, `validation()`, `screenshot()` and `close()` are the same calls everywhere.
- **A failed step throws.** `validation()` throws `VALIDATION_FAILED` when the statement doesn't hold, and `instruction()` throws `INSTRUCTION_FAILED` when Revyl's agent can't do it, so that platform's promise rejects and the script reports it as failed. The steps after it, including the screenshot, don't run; the session link keeps the recording. Pass `{ soft: true }` to `validation()` to get `passed: false` back instead.
- **`Promise.allSettled`, not `Promise.all`.** `allSettled` waits for every session, so one failed platform doesn't leave the others running unchecked, and each `finally` closes its own session.
- **Your apps.** Use `{ appId: '<your app id>' }` for an iOS or Android app's newest build, or `{ buildId }` for an exact one, and `url` for a web page (with `appId` to pin a Revyl web app, which `buildId` needs). Keep the same steps when the app behaves the same on each platform, and give a platform its own steps when its screens differ.
- **Exact actions.** When you know the element, `tap({ target: 'Login button' })` and `type({ target: 'Username field' }, text)` skip the agent and work on all three platforms; see [api.md](../api.md#exact-actions).

## Python

```python
from concurrent.futures import ThreadPoolExecutor

from revyl_verify import Target, open

checks = {
    "web": (Target(platform="web", url="https://www.saucedemo.com"), None, "The Swag Labs login form is shown."),
    "ios": (Target(platform="ios", bundle_id="com.apple.Preferences"), "Open General, then About.", "The screen shows the iOS version."),
    "android": (Target(platform="android", bundle_id="com.android.settings"), "Open About phone, then scroll or navigate until the Android version is visible.", "The screen shows the Android version."),
}


def check(name: str) -> None:
    target, instruction, validation = checks[name]
    with open(target) as session:
        print(f"{name}: {session.viewer_url}")
        if instruction:
            session.instruction(instruction)
        session.validation(validation)  # raises VALIDATION_FAILED when it doesn't hold
        session.screenshot(path=f"{name}.png")


with ThreadPoolExecutor() as pool:
    futures = {name: pool.submit(check, name) for name in checks}
for name, future in futures.items():
    print(name, "passed" if future.exception() is None else f"failed: {future.exception()}")
if any(future.exception() for future in futures.values()):
    raise SystemExit(1)
```

Each thread opens and closes its own session. `async_open` with `asyncio.gather(..., return_exceptions=True)` works the same way.

## Go

```go
type check struct {
	target      verify.Target
	instruction string
	validation  string
}

checks := map[string]check{
	"web":     {verify.Target{Platform: verify.Web, URL: "https://www.saucedemo.com"}, "", "The Swag Labs login form is shown."},
	"ios":     {verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"}, "Open General, then About.", "The screen shows the iOS version."},
	"android": {verify.Target{Platform: verify.Android, BundleID: "com.android.settings"}, "Open About phone, then scroll or navigate until the Android version is visible.", "The screen shows the Android version."},
}

run := func(name string, c check) error {
	s, err := verify.Open(ctx, c.target)
	if err != nil {
		return err
	}
	defer s.Close(context.Background())
	fmt.Println(name+":", s.ViewerURL())
	if c.instruction != "" {
		if _, err := s.Instruction(ctx, c.instruction); err != nil {
			return err
		}
	}
	if _, err := s.Validation(ctx, c.validation); err != nil {
		return err
	}
	_, err = s.Screenshot(ctx, name+".png")
	return err
}

var wg sync.WaitGroup
errs := make(map[string]error, len(checks))
var mu sync.Mutex
for name, c := range checks {
	wg.Go(func() {
		err := run(name, c)
		mu.Lock()
		errs[name] = err
		mu.Unlock()
	})
}
wg.Wait()
var failed []error
for name, err := range errs {
	fmt.Println(name, err) // nil means passed
	if err != nil {
		failed = append(failed, fmt.Errorf("%s: %w", name, err))
	}
}
return errors.Join(failed...) // non-nil when any platform failed
```

## Limits and errors

| What happened | Error | What to do |
| --- | --- | --- |
| The API key's role can't create apps | `AUTH_REJECTED`, before a session starts | Add `appId` of an existing Web app in Revyl to the web target |
| The site at `url` didn't load (for example a 404) | `SESSION_START_FAILED` | Open a URL that answers 200 |
| A statement didn't hold | `VALIDATION_FAILED`, in that platform's result | Read the reason and watch that session's link |
| No cloud browser was free | `API_ERROR` (`web_runtime_unavailable`) | Try again shortly |

[errors.md](../errors.md) lists every code.

## Clean up

Each session closes in its own `finally` (Python: its `with` block; Go: its `defer`), whether its steps passed or not. Sessions left open by a killed process stop after their idle timeout, 10 minutes by default.

## Next

- [Check an iOS change from your coding agent](check-an-ios-change.md) for one platform in depth.
- [Signed in from the first step](session-profiles.md) to start every session signed in.
