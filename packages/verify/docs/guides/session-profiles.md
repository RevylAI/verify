# Signed in from the first step: session profiles

A session profile is a script in your project that Revyl runs as a session starts, before your first step. It can sign a test user in and hand the browser its cookies and a first page, so every session starts signed in and your steps test the app instead of the login form. This guide adds a profile to a project and opens a web session with it.

Works with TypeScript `@revyl/verify` 0.7.1, Python `revyl-verify` 0.5.1 and Go `github.com/RevylAI/verify/go` v0.6.1. Profiles work on web, iOS, Android and Mac computers; this guide uses the web.

## What you'll build

1. A profile named `signed-in` in `.revyl/config.yaml`.
2. Its script, which signs in to a demo site over HTTP and writes the session cookie and a first page for the browser.
3. A Verify script that opens a cloud browser with `profile: 'signed-in'` and checks that the first screen is the signed-in page.

The demo site is [the-internet.herokuapp.com](https://the-internet.herokuapp.com/login), whose login page publishes its test account (`tomsmith` / `SuperSecretPassword!`). Use a test account of your own app the same way.

## Before you start

- A Revyl account and project. `revyl init` in your app's checkout writes `.revyl/config.yaml` with `project.id`; Verify reads that file from the current folder or the nearest one above it.
- A Revyl web app id in `WEB_APP_ID` (see [every platform](every-platform.md#before-you-start)).
- Node.js 22.18 or later and `npm install @revyl/verify` in an ESM project.

## 1. Name the profile

Add the profile to `.revyl/config.yaml`:

```yaml
project:
  id: <your Revyl project id>
session:
  profiles:
    signed-in:
      script: demo-sign-in
```

A `script` without a `/` is a script name: Revyl runs `.revyl/scripts/demo-sign-in.sh` with bash. Add `default_profile: signed-in` under `session` to run it on every start that doesn't pick another.

## 2. Write the script

Save this as `.revyl/scripts/demo-sign-in.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

curl -fsS -c jar.txt -o /dev/null \
  -d 'username=tomsmith&password=SuperSecretPassword!' \
  https://the-internet.herokuapp.com/authenticate

cookie=$(awk -F'\t' '$6 == "rack.session" { print $7 }' jar.txt)
test -n "$cookie"

jq -n --arg value "$cookie" '{
  cookies: [{ name: "rack.session", value: $value, domain: "the-internet.herokuapp.com", path: "/", httpOnly: true, secure: true }],
  origins: []
}' > "$REVYL_BROWSER_STORAGE_STATE_FILE"

printf '/secure' > "$REVYL_DEEP_LINK_FILE"
```

The script runs on Revyl's hosted runner, not on your machine, in an empty folder with `bash`, `curl`, `jq`, Python and Node.js. It writes two of the files Revyl gives it:

- `$REVYL_BROWSER_STORAGE_STATE_FILE`: the browser's cookies, in Playwright's storage-state format. The browser holds them before its first page.
- `$REVYL_DEEP_LINK_FILE`: the first page to open, as a path on the app's site. It must answer 200; a page that answers 404 fails the start.

Test it on your machine first: `REVYL_BROWSER_STORAGE_STATE_FILE=state.json REVYL_DEEP_LINK_FILE=link bash .revyl/scripts/demo-sign-in.sh`.

## 3. Open a session with it

Save this as `signed-in.ts` in the same project:

```ts
import { open } from '@revyl/verify';

const target = { platform: 'web', app: { appId: process.env.WEB_APP_ID ?? '', url: 'https://the-internet.herokuapp.com' } } as const;

const session = await open(target, { profile: 'signed-in' });
console.log(`Live view: ${session.viewerUrl}`);
try {
  const check = await session.validation('The Secure Area page is shown with a Logout button.');
  console.log(`Validation passed: ${check.passed}. ${check.reason ?? ''}`);
  await session.screenshot({ path: 'secure-area.png' });
} finally {
  await session.close();
}
```

Run it with `WEB_APP_ID=<your web app id> node signed-in.ts`:

```text
[verify] web: starting web session https://app.revyl.ai/sessions/<id>
[verify] web: waiting for session profile signed-in
[verify] web: ready
Live view: https://app.revyl.ai/sessions/<id>
[verify] web: ✓ validation "The Secure Area page is shown with a Logout button." (15.0s)
Validation passed: true. The screenshot shows the 'Secure Area' page …
[verify] web: closed
```

`open()` returns only after Revyl reports that the profile succeeded, so the first step already sees the signed-in page. Pass `profile: 'none'` to start without any profile, for example to test the login form itself.

## Python and Go

```python
import os

from revyl_verify import Target, open

web = Target(platform="web", app_id=os.environ["WEB_APP_ID"], url="https://the-internet.herokuapp.com")
with open(web, profile="signed-in") as session:
    session.validation("The Secure Area page is shown with a Logout button.")
```

```go
s, err := verify.Open(ctx, verify.Target{Platform: verify.Web, AppID: os.Getenv("WEB_APP_ID"), URL: "https://the-internet.herokuapp.com"}, verify.OpenOptions{Profile: "signed-in"})
if err != nil {
	return err
}
defer s.Close(context.Background())
if _, err := s.Validation(ctx, "The Secure Area page is shown with a Logout button."); err != nil {
	return err
}
```

Both read the same `.revyl/config.yaml` and send the same script.

## What Verify sends, and what stays private

Verify sends the profile's definition, its script as it is on disk (uncommitted changes included, up to 64 KiB) and your project id, plus your Git branch when it finds one. The script's output never comes back to Verify, because setup scripts often handle secrets. Don't commit real passwords in a script: keep them in Revyl and read them from the script, as [Session profiles](https://docs.revyl.com/devices/session-profiles) in the Revyl docs describes.

## Limits and errors

| What happened | Error | What to do |
| --- | --- | --- |
| No `.revyl/config.yaml` here or above | `CONFIG_NOT_FOUND` | Run from your app's checkout, or pass `profile: 'none'` |
| No `project.id`, an unknown profile name, or a project outside your organization | `CONFIG_INVALID` | The message names the file and the fix |
| The script exited with an error, ran past 300 seconds, or wrote a bad file | `SESSION_PROFILE_FAILED`, with `error.outcome` | Run the script yourself; `outcome` and `failureReason` say what broke. Revyl stops the session |
| The first page didn't load | `SESSION_START_FAILED` | Write a path that answers 200 to `$REVYL_DEEP_LINK_FILE` |
| A Linux computer | `NOT_AVAILABLE_ON_PLATFORM` | Profiles run on web, iOS, Android and Mac computers |

[api.md](../api.md#session-profile-errors) has the full tables. Sites end sign-ins on their own schedule; a profile signs in fresh on every start.

## Clean up

Nothing to remove: the profile's session closes with `close()` like any other, and the hosted runner's folder is discarded after the run.

## Next

- [Playwright for the clicks, Revyl for the judgment](playwright-cdp.md).
- [Session profiles](https://docs.revyl.com/devices/session-profiles) in the Revyl docs: every output file, iOS and Android launch values, and Mac computers.
