---
name: revyl-verify
description: Use when you need to see that a web page, an iOS or Android app, or a Mac actually works, rather than only reading code or fetching HTML. For example, "check that this page loads and shows the pricing table", "make sure the sign-up flow works on iOS", "verify my change on Android", or "run this on a Mac". You write and run a short script with Verify (@revyl/verify for TypeScript, revyl-verify for Python, or the Go module). It opens a Revyl cloud browser, iOS simulator, Android emulator or Mac computer, does the steps you describe in plain sentences, checks what is on screen, and prints a link to watch the session.
---

# Verify

Verify opens a real cloud browser, iOS simulator, Android emulator or Mac computer on Revyl, and your script drives it with plain sentences: `instruction()` does something, `validation()` checks that something is true on screen. A failed validation throws, so the script exits non-zero. Every session prints a link where the user can watch it live and read the report afterwards.

Use it to check what a user would see: that a page renders, a flow works, or a change looks right on a device. Don't use it for logic a unit test covers.

## Before you start

1. **Find the setup.** If the project has a `verify.config.ts`, read it: it names the targets (`web`, `ios`, `android`, `mac`) and holds their Revyl app ids. If `@revyl/verify` isn't in `package.json`, install it with the project's package manager, for example `npm install -D @revyl/verify`. It needs Node.js 22.18 or later. For Python or Go projects, see [Python and Go](#python-and-go).
2. **Check the credentials** with `npx @revyl/verify whoami`. It starts nothing. If it fails, ask the user to run `npx @revyl/verify login` in a terminal, or to set `REVYL_API_KEY` to a key from Revyl (Settings → API keys). Never print, log or commit the key.
3. **Sessions are billed.** When the user asked you to check something, that is the go-ahead for the sessions the check needs. Otherwise ask first. Open one session at a time unless you need several, and always close what you open.

## Check a web page

A web session opens a Web app in Revyl, so it needs that app's id. Take `appId` from the `web` target in `verify.config.ts`. If there is none, ask the user to create a Web app at https://app.revyl.ai (Create app, keep Web selected) and give you its id. Revyl's browser runs in the cloud, so the URL must be public HTTPS, such as a preview deployment; it can't reach `localhost` on your machine.

Save this as `verify/check-pricing.mts` and run it with `node verify/check-pricing.mts`:

```ts
import { open } from '@revyl/verify';

const session = await open({
  platform: 'web',
  app: { appId: '<the web app id from verify.config.ts>', url: 'https://example.com/pricing' },
});
try {
  await session.validation('The page has loaded and shows a pricing table with at least two plans');
  await session.screenshot({ path: '.verify/pricing.png' });
} finally {
  await session.close();
}
```

Paste the id into the script as a string; don't import `verify.config.ts` from a script. Or open the configured target and go to the page, which needs no id in the script:

```ts
const session = await open('web'); // the web target in verify.config.ts
await session.navigate('https://example.com/pricing');
```

## Check an iOS or Android app

```ts
import { open } from '@revyl/verify';

const session = await open('ios'); // the ios target in verify.config.ts
try {
  await session.instruction('Open General, then About');
  await session.validation('The screen shows the operating system version');
} finally {
  await session.close();
}
```

Without a config, pass a target. `open({ platform: 'android', app: { appId: '<Revyl app id>' } })` installs the newest build of that Revyl app. `app: { bundleId: 'com.apple.Preferences' }` on iOS, or `'com.android.settings'` on Android, opens the built-in Settings app, which needs no upload. A new build of the user's app has to be uploaded to Revyl first, for example with `revyl build upload`; pass `buildId` to pin one build. `device: { model: 'iPhone 16', osVersion: 'iOS 18.5' }` picks the simulator.

## Use a Mac computer

```ts
import { open } from '@revyl/verify';

const mac = await open({ platform: 'mac' });
try {
  const result = await mac.exec(['sw_vers', '-productVersion']);
  console.log(result.stdout.trim());
  await mac.writeFile('notes.txt', 'hello\n');
  await mac.tap({ target: 'the Finder icon in the Dock' });
  await mac.screenshot({ path: '.verify/mac.png' });
} finally {
  await mac.close();
}
```

A Mac runs commands with `exec()`, which takes an argument array rather than a shell string. It reads and writes files, takes screenshots, and clicks and types with `tap({ target })` and `type({ target }, text)`. `instruction()` is not available on a Mac.

To check the screen in a sentence, open the Mac with `inference: true`. Its own vision model then answers `validation()` and `extract()`, with no per-check fee; on a Mac opened without `inference` they throw `NOT_AVAILABLE_ON_PLATFORM`.

```ts
const mac = await open({ platform: 'mac', inference: true });
try {
  await mac.writeFile('notes.txt', 'hello\n');
  await mac.exec(['open', '-a', 'TextEdit', 'notes.txt']);
  await mac.validation('A TextEdit window shows the text hello');
} finally {
  await mac.close();
}
```

A Mac can also host an iOS simulator or Web session with `mac.open(target)`. On a Mac opened with `inference: true`, that session's validations and single-tap instructions run on the Mac's model first:

```ts
const settings = await mac.open({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } });  // or app: { appId, buildId }
await settings.validation('The Settings app is showing');
await settings.launchApp('com.apple.Preferences');    // launchApp works inside a Mac too
```

To keep a Mac's disk between runs, open it with `openPersistent('<name>')` instead of `open()`: `close()` stops it and keeps the disk, and `deletePersistent('<name>')` stops it if it is running, which saves the disk, then removes the computer and its disk for good. `deletePersistent` and `deleteSnapshot` throw `NOT_FOUND` when nothing has that name or ID, so cleanup that may run twice catches it. Saved disks and snapshots bill at $0.04 per GB-month until deleted, so delete the ones you no longer need. A persistent computer gets the Mac's model only when it is created, so pass `openPersistent('<name>', { inference: true })` the first time if you will call `validation()` or `extract()` on it. File calls take paths relative to the Mac's workspace (`notes.txt`, not `~/notes.txt` or `/Users/...`); in `exec`, `$HOME` is that workspace.

Mac computers, local inference and persistent computers come with paid Revyl plans. If Revyl refuses one (`upgrade_required`, `inference_not_enabled` or `persistent_computers_not_enabled`), tell the user their organization's plan needs an upgrade instead of retrying.

## Which call works where

| | Web | iOS simulator, Android | Cloud Mac | Own model (`open(target, { model })`) | Inside a cloud Mac (`mac.open(target)`) |
| --- | --- | --- | --- | --- | --- |
| `instruction`, `validation` | Yes | Yes | `validation` with `inference: true`; no `instruction` | Yes, on your model | Yes; on an inference Mac, validations and single taps on its model first |
| `extract` | Yes | Yes | With `inference: true` | No: `INVALID_ARGUMENT`, read `screenshot()` with your model | Yes, on Revyl's hosted model |
| Exact actions (`tap`, `type`, `swipe`, `pressKey`) | Yes | Yes | `tap`, `type`, `pressKey` | As on the platform | As on iOS or Web |
| `launchApp`, `goHome` | No | Yes | No | As on the platform | iOS: yes |
| `app: { bundleId }`, `device` | No | Yes | No | As on the platform | iOS only; or `app: { appId, buildId }` |
| `exec`, files | No | No | Yes | No | No |
| `profile` | Yes | Yes | Yes | As on the platform | No |

A call a platform lacks throws `NOT_AVAILABLE_ON_PLATFORM` naming what to use instead.

## Start signed in: session profiles

`open(target, { profile: 'signed-in' })` runs a script from the project's `.revyl/config.yaml` (`session.profiles`) on Revyl before the first step, for example to sign a test user in. `profile: 'none'` runs none.

- `project.id` must name a project that already exists in Revyl, in the API key's organization. `revyl init` writes a new id Revyl doesn't know until the project is published: connect the repository (`revyl github connect`), then run `revyl config push` from the checkout. Or put an existing project's id in `project.id`. Otherwise the start fails with `CONFIG_INVALID`, reason `project_not_found`.
- On Web, the first page the script writes to `$REVYL_DEEP_LINK_FILE` must answer 200. A static host such as GitHub Pages answers 404 on a single-page app's routes, so write `/` (or `/?/route` on a Pages SPA shim) and navigate from there.
- A cookie the page's own JavaScript reads needs `httpOnly: false` in the storage state.

## Writing steps

- Write each step as you would brief a person, in one sentence: what to do, or what should be true. Name what is visible ("the blue Save button"), not selectors or code.
- Use `instruction()` to act and `validation()` to check. Don't ask an instruction to check something, or a validation to change anything.
- Use `extract()` to read one value off the screen, such as `extract('the order number')`; the value is in the result's `value`.
- Prefer several small steps to one long one. Each step stands alone, so put everything it needs into its own text.
- Await every step. A session runs one step at a time.
- When you know exactly what to press, act directly: `tap({ target: 'Sign in button' })`, `type({ target: 'Email field' }, 'demo@example.com')`, `pressKey('enter')`, `swipe('up')`. Type with `type({ target }, text)` on every platform.
- Never put passwords, keys or customer data in step text: it is sent to Revyl and printed.

## Run it and read the result

Name scripts `.mts` and run them with `node path/to/script.mts`: a `.mts` file runs as an ES module in any project. The first `[verify]` line has the session link; give it to the user. Each step prints `✓` or `✗`, and exit code 0 means every step passed.

When a script fails, its last line is `CODE: message`, and the message says what to do:

| Code | Meaning | Do this |
| --- | --- | --- |
| `VALIDATION_FAILED` | What you checked is not true on screen | Look at the screenshot and the link, then fix the app or the step |
| `INSTRUCTION_FAILED` | The agent could not do the step | Make the step more specific, or split it |
| `STEP_FAILED` | Revyl could not run the step to an outcome; this says nothing about the app | Watch the session at the link, then run the step again |
| `AUTH_MISSING`, `AUTH_REJECTED` | No usable credentials | Ask the user to run `npx @revyl/verify login` or set `REVYL_API_KEY` |
| `CONFIG_NOT_FOUND`, `CONFIG_INVALID` | No `verify.config.ts`, an option is wrong, or a profile's project isn't in Revyl | Pass a target object to `open()`, or fix what the message names |
| `NOT_AVAILABLE_ON_PLATFORM` | The call doesn't exist on this platform | Use the alternative the message names |

Don't catch errors to make a check pass, and don't rerun a whole script to probe one step: every step runs Revyl's agent again.

To read a finished session's result after the script exited, run `npx @revyl/verify report <session-id>` (`--json` for JSON), or call `report(sessionId)`. It prints the status, the link and each step's verdict and reasoning; the id is the end of the session link.

## Python and Go

Use the SDK in the project's language; the steps and rules above are the same. TypeScript 0.8.2, Python 0.6.2 and Go v0.7.2 are the same release with the same features.

```python
# pip install revyl-verify  (Python 3.10 or later)
from revyl_verify import Target, open

with open(Target(platform="web", app_id="<web app id>", url="https://example.com/pricing")) as session:
    session.validation("The page shows a pricing table with at least two plans")
```

```go
// go get github.com/RevylAI/verify/go@v0.7.2
session, err := verify.Open(ctx, verify.Target{Platform: verify.Web, AppID: "<web app id>", URL: "https://example.com/pricing"})
if err != nil {
	return err
}
defer session.Close(ctx)
if _, err := session.Validation(ctx, "The page shows a pricing table with at least two plans"); err != nil {
	return err
}
```

## More

- The docs for the installed version are in `node_modules/@revyl/verify/docs/`: `agents.md` for agents, `api.md` for every call, `errors.md` for every error.
- Online: https://docs.revyl.com/verify, with guides to [check an iOS change](https://docs.revyl.com/verify/guides/check-an-ios-change), [run one script on iOS, Android and the web](https://docs.revyl.com/verify/guides/every-platform), [start signed in](https://docs.revyl.com/verify/guides/session-profiles), [use Playwright over CDP](https://docs.revyl.com/verify/guides/playwright-cdp), [drive a cloud Mac](https://docs.revyl.com/verify/guides/mac-computer), [check a Mac's screen with its own model](https://docs.revyl.com/verify/guides/mac-model-checks), [check apps inside an inference Mac](https://docs.revyl.com/verify/guides/apps-inside-an-inference-mac) and [keep a Mac between runs](https://docs.revyl.com/verify/guides/persistent-computers).
- Python: https://github.com/RevylAI/verify/blob/py/v0.6.2/python/README.md. Go: https://github.com/RevylAI/verify/blob/go/v0.7.2/go/README.md. TypeScript docs for this version: https://github.com/RevylAI/verify/tree/v0.8.2/packages/verify/docs.
