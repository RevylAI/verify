<h1 align="center">Verify for Python</h1>

<p align="center"><em>Cloud browsers, mobile devices and computers from Python.</em></p>

Verify is a thin [Revyl](https://revyl.com) SDK, not a test runner. Open a web browser, iOS simulator or Android emulator for natural-language instructions and validations, or an early-access Mac computer for commands, files, processes, screenshots and, on a Mac opened with inference, validations and extracts.

## For coding agents

Use Python ≥3.10 and the `revyl_verify` import. The distribution is named `revyl-verify`; it is separate from the `revyl` CLI. Install it from PyPI with `pip install revyl-verify` or `uv add revyl-verify`.

Run only explicitly authorized cloud workloads. Keep API keys, signed recording URLs and session links private. Use context managers so errors still trigger cleanup; there is no runner, automatic step replay or creation retry.

## Set up your coding agent

The `revyl-verify` skill teaches a coding agent (Claude Code, Cursor, Codex, Capy and others) when and how to check a web page, an app or a Mac with Verify, in Python as well as TypeScript. With Node.js 22.18 or later, run this at the repository root. It writes the skill to `.agents/skills/` and `.claude/skills/`, adds a short Verify section to `AGENTS.md` (or to `CLAUDE.md` when the repository has that and no `AGENTS.md`), and changes nothing when run again:

```sh
npx @revyl/verify init --no-config --no-install
```

Without Node.js, copy the skill into the two folders agents read:

```sh
for dir in .agents/skills .claude/skills; do
  mkdir -p "$dir/revyl-verify"
  curl -fsSL https://raw.githubusercontent.com/RevylAI/verify/main/skills/revyl-verify/SKILL.md -o "$dir/revyl-verify/SKILL.md"
done
```

Or install the Verify plugin in your agent; see [Set up your coding agent](https://github.com/RevylAI/verify#set-up-your-coding-agent).

## Install

```bash
pip install revyl-verify
# Or, in a uv project:
uv add revyl-verify
```

Pillow and PyYAML are the only runtime dependencies: Pillow for PNG blank-frame inspection and for downscaling screenshots sent to your own model, PyYAML for reading `.revyl/config.yaml` for [session profiles](#session-profiles). HTTP, model calls included, uses the standard library.

## Authenticate

On the first interactive `open()`, `attach()` or `current_computer()` call without credentials, Verify prints a Revyl approval URL and code, opens your browser, and waits for you to approve. It saves the login to `~/.revyl/credentials.json`, which the Revyl CLI and the other Verify SDKs share, so later runs start without a prompt. You can also sign in ahead of time with the separately installed [Revyl CLI](https://github.com/RevylAI/revyl-cli#install):

```bash
revyl auth login
```

Verify never opens a browser when stdin or stderr is not a terminal or `CI` is set. Supply `REVYL_API_KEY` through the process's secret store there; without credentials the call raises `AUTH_MISSING`.

Credential precedence matches the other SDKs: a usable stored CLI login marked `local_auth_override`, then `REVYL_API_KEY`, then another usable CLI login. An expired access token can fall back to its stored API key. Never pass keys in argv, source, screenshots or logs.

## Inside a revyl-macos GitHub Actions job

`current_computer()` and `async_current_computer()` attach to `REVYL_COMPUTER_ID` with normal credential resolution, non-owning by default. They never create a computer, raise `COMPUTER_ID_MISSING` when the ID is unset or blank, and reject invalid IDs with `INVALID_ARGUMENT`. The job's owner releases the computer; closing the attachment only cleans up hosted children.

Use a release containing these helpers and a runner configured to inject `REVYL_COMPUTER_ID` and a short-lived `REVYL_API_KEY`. A workflow can supply its own key instead. With Python ≥3.10 and the project dependencies installed, add this step to a job with `runs-on: revyl-macos`:

```yaml
- name: Run Verify
  run: |
    python - <<'PY'
    from revyl_verify import current_computer
    with current_computer() as computer:
        computer.screenshot(path="computer.png")
    PY
```

Use `async with await async_current_computer() as computer` in asyncio jobs. Both helpers accept explicit `backend_url`, `app_url`, `step_timeout`, and `log` options; neither reads URL environment variables. `stop_on_close=True` explicitly takes ownership and can end the job's computer when closed. Use `computer.open(target)` with an exact app/build pair for hosted app sessions.

## Quick Start

### Synchronous iOS Settings

```python
from revyl_verify import Target, open

with open(Target(platform="ios", bundle_id="com.apple.Preferences", start_timeout=600)) as session:
    session.instruction("Open General, then About", timeout=120)
    session.validation("The screen shows the operating system version", timeout=120)
    session.screenshot(path="settings.png")
    report = session.report()
```

`open` returns a `Session`, which is also a context manager. `instruction` and `validation` wait for completion; a failed validation raises by default even if HTTP succeeded. Pass `soft=True` to `validation` to inspect a failed verdict without raising. Screenshots return PNG `bytes` and optionally save them to `path`, creating its folder. `report()` returns a JSON dictionary: for devices it is the session-details/report metadata from `/execution/device-sessions/{id}`, not a fabricated report endpoint. After `close()`, `report()` waits up to 5 seconds for a final `status` (`completed`, `failed`, `cancelled` or `timeout`) and then returns the status Revyl has. Web, iOS and Android sessions usually reach a final status within that wait: a web session usually settles in about 2 seconds, and its recording is saved a few seconds later. If a report still reads `running`, call `report()` again.

All timeout values are **seconds**, including `start_timeout` (default 600), step timeouts and computer command timeouts. Mobile startup includes a bounded best-effort blank-frame observation, not a guarantee that the app has rendered. Begin with an instruction that reaches the screen you need.

### Asyncio

```python
import asyncio

from revyl_verify import Target, async_open


async def main() -> None:
    async with await async_open(
        Target(platform="ios", bundle_id="com.apple.Preferences", start_timeout=600)
    ) as session:
        await session.instruction("Open General, then About", timeout=120)
        await session.validation("The screen shows the operating system version", timeout=120)
        await session.screenshot(path="settings.png")


asyncio.run(main())
```

`async_open` returns an `AsyncSession`. Its async methods adapt the synchronous implementation through worker threads, rather than introducing another HTTP stack. Cancelling a method schedules best-effort session close; cancelling open interrupts startup and attempts cleanup as soon as an identity is known. Cancellation does not forcibly terminate an in-flight thread or undo a remote operation; do not replay an uncertain mutation. Always close explicitly or use `async with await async_open(...)`.

### Read a value with extract()

**Since 0.6.0.** `extract(text)` reads one value off the screen and returns a `StepResult` whose `value` is the string it read:

```python
from revyl_verify import Target, open

with open(Target(platform="ios", bundle_id="com.apple.Preferences")) as session:
    session.instruction("Open General, then About")
    version = session.extract("the iOS version number")
    print(version.value)
```

Describe one value that is on the screen now, such as `"the order number on the confirmation"`. When nothing can be read, it raises `STEP_FAILED` with the reason and a hint on how to describe the value. It works on every session: on Web, iOS and Android it runs on Revyl's agent like `instruction()` and `validation()`, and on a Mac computer opened with `inference=True` it reads the Mac's own screen with the Mac's own model (see [validation() and extract() on a Mac](#validation-and-extract-on-a-mac)). A session opened with `model` or `agent` raises `INVALID_ARGUMENT`: read the value from `screenshot()` with your model instead. `AsyncSession.extract()` is the same, awaited.

Every `StepResult` also has `engine`: `"local"` when the vision model of the Mac the step ran on or inside answered, `"hosted"` when Revyl's hosted model did, and `None` when Revyl doesn't say, as on ordinary Web, iOS and Android sessions. `value` is set on extract steps only.

### Mac computer

Mac computers are available to organizations on a current paid Revyl plan. If yours can't start one, ask support@revyl.ai:

```python
from revyl_verify import Target, open

with open(Target(platform="mac", start_timeout=600)) as session:
    result = session.exec(["uname", "-a"], timeout=30, check=True)
    session.write_file("message.txt", b"Hello from Verify\n")
    contents = session.read_file("message.txt")
    processes = session.processes()
    session.screenshot(path="mac.png")

recording = session.recording()  # after close; waits until the video is saved
```

`exec(argv, stdin=bytes_or_string, timeout=30, check=True)` preserves argument boundaries and raises on command failure by default. File and process operations are computer-only. File paths are workspace-relative, not arbitrary absolute guest paths. To get the screen recording, call `recording()` after the computer is closed (after its `with` block or `close()`), on the same object and before your script exits: Revyl saves the video a few seconds after release, so it asks every 5 seconds until it is saved and returns `ComputerRecording(url, duration_seconds, started_at)`, or `None` if none was saved within `timeout` seconds (`recording(timeout=900)`, 15 minutes by default; 0 asks once). A check already under way when `timeout` runs out can take up to 30 seconds more. Called on a computer that is still running it raises `SESSION_BUSY` saying to close it first. `attach()` can't reopen a closed computer, so a later process can't fetch it. Since 0.5.1; earlier versions returned `None` at once while the video was still uploading. It doesn't download the video. Signed URLs in that metadata are credentials. Recording is locally unavailable on devices.

Since 0.4.0, a script can click, type and press keys on the computer's screen at points it reads off `screenshot()`:

```python
import time

from revyl_verify import Point, Target, open

with open(Target(platform="mac", start_timeout=600)) as computer:
    computer.write_file("notes.txt", "Notes\n")
    computer.exec(["open", "-a", "TextEdit", "notes.txt"])  # exec runs in the workspace
    time.sleep(3)  # let the window open
    computer.screenshot(path=".verify/mac.png")  # open it and find the text
    document = "the white text area of the TextEdit window"
    computer.type(document, "First line\nSecond line")  # clicks, selects all, types
    computer.type_focused("\nThird line", clear=False)  # types where the cursor already is
    computer.tap(Point(400, 300))  # or click a point as you read it
```

On a computer, as everywhere, type with `type("description", text)`: it clicks the field, selects its text with Command+A unless `clear=False`, and types. `type_focused` needs `clear=False`: it types where the cursor is and clears nothing, so to replace text, select it first. `"meta"` is Command and `"alt"` is Option. `screen_size()` works too. `tap("the Help menu in the menu bar")` clicks a description and returns the `Point` it clicked. It takes several seconds and can click a look-alike, or something else when the target isn't on the screen, so check the point or take a screenshot afterwards, and use `tap(Point(x, y))` from a screenshot for anything that's hard to undo. `locate()` and the exact actions other than `tap`, `type`, `type_focused`, `press_key` and `screen_size` aren't available on computers and raise `NOT_AVAILABLE_ON_PLATFORM` before anything is sent. When Revyl answers `screen_starting`, nothing happened, so Verify waits and tries again for up to 30 seconds. A script keeps control of the screen for 120 seconds after its last action, so a teammate can't take control in the Revyl viewer until then; while someone does control it there, actions raise `SESSION_BUSY` and nothing happens. A 403 raises `AUTH_REJECTED`: the key's owner needs the Member role or above, and CI runner keys can't control the screen yet. [computers.md](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#screen) lists every screen error.

**Breaking wire change:** computer-operation arguments use `argv_b64` (one padded URL-safe base64 UTF-8 string per argument) and file paths use `path_b64`, with no raw `argv` or `path`. This SDK is incompatible with the previous backend contract. Deploy the encoded-only backend before publishing or upgrading to this SDK. Public APIs and decoded limits are unchanged; `stdin` and file `data` retain their existing standard base64 encoding, and process commands are unchanged. Encoding is not encryption, and Verify does not fall back to plaintext or replay the request.

### validation() and extract() on a Mac

**Since 0.6.0.** On a Mac opened with `inference=True`, `validation()` and `extract()` run on the Mac's own vision model, next to the computer, and their `StepResult` has `engine="local"`. A typical answer takes 1 to 3 seconds. Local inference comes with paid Revyl plans.

```python
from revyl_verify import Target, open

with open(Target(platform="mac", inference=True)) as mac:
    print(mac.inference)  # "ready", "unavailable" or "unknown"
    mac.validation("The Dock is visible at the bottom of the screen")
    date = mac.extract("the date at the right end of the menu bar")
    print(date.value, date.engine)  # the date as shown, then "local"
```

- `validation(text, soft=False)` returns a `StepResult` with `passed`. A false statement raises `VALIDATION_FAILED`, unless you pass `soft=True`, which returns `passed=False`.
- `extract(text)` returns a `StepResult` whose `value` is the string read off the screen. Describe one value that is visible now. When the model finds nothing, it raises `STEP_FAILED` with the model's reason, such as `local_model_found_no_value`.
- An answer the model can't confirm is never a pass: it raises `STEP_FAILED`. Describe one thing that is visible on the screen now.
- Run one step at a time on a computer. The Mac's model also answers for the app sessions inside it, so a step that waits too long for it raises `SESSION_BUSY`, with `step_engine_busy` in the message; try again in a few seconds. While someone controls the screen in the viewer, a step raises `SESSION_BUSY` (`screen_control_held`); try again after they release it.
- `instruction()` stays unavailable on computers. It raises `NOT_AVAILABLE_ON_PLATFORM` and names the calls to use instead: `tap("the Save button")` to click one thing, and `type("the search field", text)` to type into a field.
- Your own `model` or `agent` doesn't run steps on computers; passing one raises `NOT_AVAILABLE_ON_PLATFORM`.

`mac.inference` says whether the Mac's model answered: `"ready"`, `"unavailable"`, or `"unknown"` when Verify can't tell yet. Verify refreshes it whenever it reads the computer's report: at `open()`, `attach()` and `open_persistent()`, and on each `report()`. It is `None` on every other session, including a Mac opened without inference.

| Error | When | What to do |
| --- | --- | --- |
| `NOT_AVAILABLE_ON_PLATFORM`, `reason="inference_not_enabled"` | `open()` with `inference=True`, and your organization isn't on a paid Revyl plan | Upgrade the organization's plan, or open the Mac without `inference` |
| `NOT_AVAILABLE_ON_PLATFORM`, `reason="inference_unavailable"` | No Mac with a model is up right now; nothing was started | Try again later, or open the Mac without `inference` |
| `NOT_AVAILABLE_ON_PLATFORM`, `reason="step_engine_unavailable"` | `validation()` or `extract()` on a Mac opened without inference; on a Linux computer, before anything is sent; or on a Mac opened with inference whose model isn't answering | Open the Mac with `Target(platform="mac", inference=True)`. If it already was, check `mac.inference` and try again shortly |
| `INVALID_ARGUMENT` | `inference=True` on a Linux target | Use `Target(platform="mac", inference=True)` |

[`examples/mac_inference.py`](https://github.com/RevylAI/verify/blob/main/python/examples/mac_inference.py) runs these steps, and with `IOS_APP_ID` and `IOS_BUILD_ID` set also an iOS app inside the Mac (`cd python && uv run python examples/mac_inference.py`). It starts a billable Mac computer. The [Mac model checks guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/mac-model-checks.md) has more.

### Attach and open a hosted browser

Attach to an existing active computer with `attach(computer_id)`, or create one with `open(Target(platform="mac"))`. Attaching checks its identity, operating system and unexpired active report without creating or stopping anything on failure. A successful attach takes close ownership by default: exiting its context stops that computer, not merely the local handle.

```python
from revyl_verify import Target, attach

with attach("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", stop_on_close=False) as computer:
    with computer.open(
        Target(
            platform="web",
            app_id="11111111-2222-4333-8444-555555555555",
            build_id="66666666-7777-4888-8999-aaaaaaaaaaaa",
        )
    ) as browser:
        browser.navigate("https://www.saucedemo.com")
        browser.validation("The Swag Labs login form is shown")
```

Use real IDs from the same authorized environment; these are placeholders. `stop_on_close=False` leaves a computer you don't own running when the context exits; leave it out only for a computer your script owns. To reach `http://localhost:<port>` on the computer, a service must already be listening there, such as one an earlier step of a `revyl-macos` job started: Verify has no call that starts one, and a process started through `exec()` ends when the command returns. The existing Web build must point to a supported HTTPS source. After startup, `navigate(url)` sends a single deterministic navigation request and accepts HTTP or HTTPS, including localhost, on every Web session. A cold development server may need a warm-up request before navigation succeeds. For hosted browsers localhost means the hosting computer; for ordinary cloud browsers it means that browser's runtime, not your own computer. If navigation times out uncertainly, it may still commit and the session remains usable; re-navigating is your choice. The server runtime owns navigation network policy. The SDK rejects credentials, control characters and backslashes; it never logs the URL. Navigation is unavailable on mobile and computer sessions and returns `None` after a confirmed response.

`computer.open(target)` requires **both** `app_id` and `build_id` UUIDs. Hosted Web accepts `viewport`, `sign_in`, `idle_timeout_seconds` and `start_timeout`, but no `url` or `branch`; the server currently accepts external Web builds, not bundled Web artifacts. Hosted iOS/Android use the selected build and fixed simulator/emulator configuration, so `bundle_id`, `artifact_url`, `device_model`, `os_version`, `url`, `branch`, `viewport` and `sign_in` are unavailable. Mac hosts Web/iOS. Hosted iOS and Web also accept `inference`; see [Local inference for iOS and Web inside a Mac](#local-inference-for-ios-and-web-inside-a-mac). All hosting depends on server capability and capacity.

Children reuse their parent's credentials, API/viewer origins, step timeout and log callback. They return normal sessions with instruction, validation, extract, screenshot, report and close methods. The parent's remaining lifetime bounds child startup and worker requests; report and close remain available after expiry. Closing a parent prevents new children, cancels in-flight starts, and gives pending starts and child closes one shared five-second cleanup budget before attempting the computer stop. Child startup failure never closes the parent. Confirmed physical parent release supersedes an earlier child-close uncertainty, which is logged safely. An ambiguous child start is cleaned up using its preallocated ID, without replaying creation. A definitive refusal does not issue a child stop.

When the computer belongs to another caller, such as a CI runner, use `attach(computer_id, stop_on_close=False)` or `await async_attach(computer_id, stop_on_close=False)`. These attachments are not registered for automatic cleanup. Explicit close or context-manager exit still cancels pending child starts and closes hosted children within the five-second cleanup phase, but never stops the computer; its owner must release it. Child-cleanup failures remain observable. The default is `True`, and ownership is never inferred from the environment.

For async code use `async with await async_attach(computer_id) as computer`, then `async with await computer.open(target) as browser` and `await browser.navigate(url)`. Cancelling a child open cleans up only that child and leaves the parent open; cancelling attach before it succeeds does not stop the existing computer.

### Local inference for iOS and Web inside a Mac

**Since 0.6.0.** An iOS or Web session you open with `computer.open()` inside a Mac opened with `inference=True` runs its steps on the Mac's own vision model first, with Revyl's hosted model as the fallback. This is the default. To run one session's steps on the hosted model only, pass `inference=False` on its `Target`. Macs host iOS and Web sessions only, so leave `inference` out for Android.

```python
import os

from revyl_verify import Target, open

app = Target(platform="ios", app_id=os.environ["IOS_APP_ID"], build_id=os.environ["IOS_BUILD_ID"])

with open(Target(platform="mac", inference=True)) as mac:
    with mac.open(app) as session:  # local inference by default
        step = session.validation("The app's first screen is showing")
        print(step.engine)  # "local" or "hosted"
```

- **Runs on the Mac's model:** validations, and instructions that are a single plain tap on one thing.
- **Goes to the hosted model:** `extract()`, typing, multi-step instructions such as "scroll down and then tap back", and any local answer that is uncertain or takes longer than 25 seconds.
- `engine` on each `StepResult` says which model answered.
- **Local verdicts are final.** A validation the Mac's model answers is not checked again by the hosted model.
- If the Mac's model isn't answering when the session starts, `computer.open()` raises `NOT_AVAILABLE_ON_PLATFORM` with `reason="computer_local_inference_unavailable"`. The message says to try again shortly, or to pass `inference=False` to run on the hosted model.
- `inference` on a `Target` you pass to `open()` rather than `computer.open()` raises `INVALID_ARGUMENT`, except on a Mac target. `inference=True` on Android raises `INVALID_ARGUMENT`.

In a small live comparison on one iOS app, 20 validations (10 true, 10 false), the Mac's model and the hosted model each answered all 20 correctly and never disagreed. Local answers typically took about 2.7 seconds (one took 20) and hosted ones about 10 seconds. The [apps inside an inference Mac guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/apps-inside-an-inference-mac.md) has more.

### What inference costs

- Steps on a computer have no per-step fee. `validation()` and `extract()` on a Mac computer run only on the Mac's own model, so they carry no inference charge; you pay the Mac's minutes, as for any computer.
- App sessions inside a computer add no device minutes of their own.
- Inside an inference Mac, steps the Mac's model answers carry no inference charge; steps that fall back to Revyl's hosted model are billed as usual.
- Local inference comes with paid Revyl plans.

### open() options

`open(target, ...)` and `async_open(target, ...)` take these keyword options:

- `backend_url`: the Revyl API origin. Defaults to `https://backend.revyl.ai`.
- `app_url`: the Revyl app origin for session links. Defaults to `https://app.revyl.ai`.
- `step_timeout`: the default timeout of each step, in seconds (1 to 3600, default 180).
- `log`: where progress lines go. Leave it out for stderr, pass a callable to receive each line, or `False` to turn them off.
- `model`: runs every instruction and validation on your own model instead of Revyl's agent; see [Your own model](#your-own-model). Browsers and devices only; computers raise `NOT_AVAILABLE_ON_PLATFORM`.
- `agent`: the same with a custom agent from `local_agent()`. Pass `model` or `agent`, not both.
- `profile`: a session profile from your project's `.revyl/config.yaml`, such as `"signed-in"`, that Revyl runs before `open()` returns, or `"none"` for no profile. Left out, the project's `session.default_profile` runs when it sets one. Web, iOS, Android and Mac computers. See [Session profiles](#session-profiles).
- `session_profile_project_id`: a Revyl project UUID to read the named session profile from Git instead of your checkout. Requires `profile` to name a session profile, not `"none"`. Verify reads no local `.revyl/config.yaml` and sends no local script or Git branch.

## Persistent computers and snapshots

**Since 0.5.0, with paid Revyl plans.** A persistent computer is a Mac whose disk outlives every stop: open it by name, close it, and the next open boots from the same disk. Without a paid plan, `open_persistent()` and `save_snapshot()` raise `NOT_AVAILABLE_ON_PLATFORM` with `reason="persistent_computers_not_enabled"`; upgrade the organization's plan to use them. macOS only.

```python
from revyl_verify import delete_persistent, delete_snapshot, open_persistent, save_snapshot

with open_persistent("notes-mac") as mac:  # creates it the first time
    if mac.created:
        mac.exec(["sh", "-c", 'echo "kept across stops" > "$HOME/notes.txt"'])
# leaving the with block stops it and keeps its disk

with open_persistent("notes-mac") as mac:  # boots from the same disk
    print(mac.created, mac.exec(["sh", "-c", 'cat "$HOME/notes.txt"']).stdout)

save_snapshot("notes-mac", "notes-base")  # waits until the save is copied off its Mac
with open_persistent("notes-copy", from_snapshot="notes-base") as copy:
    print(copy.exec(["sh", "-c", 'cat "$HOME/notes.txt"']).stdout)

delete_persistent("notes-copy")
delete_persistent("notes-mac")
delete_snapshot("notes-base")
```

The example starts billable Mac computers and takes several minutes: `save_snapshot()` waits about 5 minutes after the close.

- **Open.** `open_persistent(name)` opens the Mac with that name, creating it if needed; `mac.created` says which. A stopped one boots from its disk, and a running one is connected to. Names are 1 to 64 letters, digits, `.`, `_` or `-`, start with a letter or digit, and aren't a UUID. The same name opens the same computer from Python, TypeScript and Go. An ID from `list_persistent()` works too.
- **Close.** `close()`, or leaving the `with` block, stops it and keeps the whole disk. The next open is a cold boot: memory and running processes don't survive, so start your servers again.
- **What's kept.** Everything on the disk: files, installed tools, repositories, build products, simulators, app data, system settings, the login keychain and browser profiles. A computer created from a snapshot gets the same disk, but things tied to the original Mac's hardware identity (Apple Account, iCloud, Safari's saved passwords) don't carry over, and websites may open signed out.
- **Each open is a new run** with the usual computer lifetime: 2 hours by default, up to 24 hours with `timeout` (whole seconds). A run starts saving its disk 3 minutes before it ends, so reaching the end keeps the disk. A running persistent computer bills like any computer.
- **Snapshots.** `save_snapshot(computer, name)` saves a stopped computer's disk; close it first, or it raises `SESSION_BUSY`. It waits until the save is copied off its Mac, about 5 minutes after the close, for up to `wait_timeout` seconds (900 by default), then raises `TIMEOUT`; call it again to keep waiting. Snapshot names follow the computer-name rule and are unique in your organization.
- **Copies.** `open_persistent(new_name, from_snapshot="name")` creates a new persistent computer whose disk starts as the snapshot's. `from_snapshot` is used only when the call creates the computer; if one with that name exists, it opens as it is, so check `created`. Starting on a different Mac than the one holding the save, as most snapshot copies do, restores the disk first and can take several minutes. `open_persistent()` waits up to `start_timeout` seconds (900 by default).
- **Inference.** `open_persistent(name, inference=True)` is used only when the call creates the computer, and the computer keeps it for every later start. A copy doesn't inherit it: pass `inference=True` with `from_snapshot` too. `without_inference=True` applies only when starting a stopped computer created with inference: it starts this one run without the model, for when no Mac with one is up (`inference_unavailable`). It needs a Revyl backend that offers it; otherwise it raises `INVALID_ARGUMENT` saying so.
- **How long saves last.** Until you delete the computer or the snapshot. Some saves have an end: `saved_disk_expires_at` on `PersistentComputer` and `ComputerSnapshot` is a `datetime` when Revyl reports one, else `None`. From then on, that save can't start.
- **Limits.** 10 persistent computers and 100 snapshots per organization, unless Revyl raised them.
- **Cleanup.** `delete_persistent(name_or_id)` deletes the computer and its disk for good; a running one stops first, without saving. Its snapshots stay. `delete_snapshot(name_or_id)` deletes a snapshot; computers made from it keep their disks. Both raise `NOT_FOUND` when nothing has that name or ID.
- **Lists.** `list_persistent()` returns a `PersistentComputer` for each of your organization's persistent computers, with `id`, `state`, `saved_at`, `saved_off_host`, `created_at` and `saved_disk_expires_at`. Revyl stores no names, so compare `id` with `mac.id`. `list_snapshots()` returns a `ComputerSnapshot` for each snapshot, with `id`, `name`, `computer_id`, `saved_at` and `saved_disk_expires_at`.

Where the table shows no `reason`, the message names Revyl's code, shown here in parentheses.

| Error | When | What to do |
| --- | --- | --- |
| `NOT_AVAILABLE_ON_PLATFORM`, `reason="persistent_computers_not_enabled"` | Your organization isn't on a paid Revyl plan | Upgrade the organization's plan |
| `NOT_AVAILABLE_ON_PLATFORM`, `reason="inference_not_enabled"` | `inference=True`, and your organization isn't on a paid Revyl plan | Upgrade the organization's plan, or leave out `inference` |
| `NOT_AVAILABLE_ON_PLATFORM`, `reason="inference_unavailable"` | No Mac with a model is up right now; nothing was started | Try again later, or pass `without_inference=True` to start an existing computer without the model this once |
| `SESSION_BUSY` (`run_conflict`) | The computer's last run is still stopping | Try again in a few minutes; the disk is kept |
| `SESSION_START_FAILED` (`saved_disk_unavailable`) | The Mac holding the save is offline and the save isn't copied off it yet, or no Mac can start it now | Try again later; the disk is kept |
| `SESSION_START_FAILED` (`saved_disk_expired`) | The computer's save has reached `saved_disk_expires_at` | `delete_persistent()` it; `open_persistent()` with its name then creates a new one |
| `SESSION_START_FAILED` (`snapshot_expired`) | The snapshot has reached `saved_disk_expires_at` | Save a new snapshot of a recently stopped computer |
| `COMPUTER_LIMIT` (`persistent_computer_limit` or `snapshot_limit`) | Your organization keeps as many computers or snapshots as it may | Delete one you no longer need with `delete_persistent()` or `delete_snapshot()`, then try again |

The [persistent computers guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/persistent-computers.md) has more.

## Session profiles

A session profile is a script from your Revyl project that prepares a session before your first step: it signs a user in, seeds data, or sets launch values. Revyl runs the script, never Verify: on Revyl's hosted runner for a browser or an iOS or Android device, and on the Mac itself for a Mac computer. `open()` returns once Revyl reports that the profile succeeded.

```python
from revyl_verify import Target, open

web = Target(
    platform="web", app_id="11111111-2222-4333-8444-555555555555", url="https://example.com"
)

# Run the "signed-in" profile from session.profiles in .revyl/config.yaml
with open(web, profile="signed-in") as session:
    session.validation("The account page shows the signed-in user")

# Start without any profile, not even the project's default
with open(web, profile="none") as session:
    session.validation("The sign-in form is shown")
```

| `profile` | What Verify sends |
| --- | --- |
| `"signed-in"` | That profile, with the project and the script from this checkout. |
| left out | The checkout's `session.default_profile` when set. On web, iOS and Android, a capable backend skips it if the project doesn't target the launched app. Otherwise nothing is sent. |
| `"none"` | No profile, not even the default: Verify sends no profile fields, so the start request is the same as before profiles existed. Needs no `.revyl/config.yaml`. |

Profiles work on web, iOS, Android and Mac computers. On a Linux computer, a profile name raises `NOT_AVAILABLE_ON_PLATFORM` before anything is sent, and no default runs; `"none"` is accepted without a project option. Hosted sessions (`computer.open()`), `attach()` and `current_computer()` never run a profile: they take no `profile` or `session_profile_project_id` argument, so passing either raises `TypeError`. `async_open()` takes both options the same way as `open()`.

For an implicit checkout default on web, iOS or Android, Verify reads `GET /api/v1/backend-capabilities?contract=session_profile_starts`. If `capabilities` includes `device_session_session_profile_picks`, it sends `instruction="default"` with the default's name and the same checkout files and source. Revyl runs it when the project targets the launched app, or when no registered app launches; otherwise the session starts without a profile. A missing capability or a failed read keeps today's `instruction="named"` request. Explicit profiles and Mac computer defaults always use `named` and make no capability request.

### Without a checkout

Pass `session_profile_project_id` with a named `profile` to use the project's session profile from Git, without any local `.revyl/config.yaml`:

```python
with open(
    Target(platform="mac"),
    profile="signed-in",
    session_profile_project_id="0b9e6f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
) as session:
    session.exec("pwd")
```

Verify sends `session_profile` with `instruction="named"` and the profile name, and `session_profile_source` with only `project_id`. It sends no `session_profile_files` or `git_branch_name`; Revyl reads the project's default branch in Git. A local config, even if present, is ignored. An invalid project UUID or a missing, empty or `"none"` profile raises `INVALID_ARGUMENT` before any request. Refusals, repository retries and waiting for the profile follow the same rules as checkout starts; an explicit profile is never silently skipped on an older backend.

### Where Verify reads the profile

Without `session_profile_project_id`, Verify reads `.revyl/config.yaml` in the current folder (`os.getcwd()`) or the nearest folder above it that has one: the file `revyl init` writes in your app's checkout. It needs `project.id` and the profile under `session.profiles`, and reads nothing else from the file:

```yaml
project:
  id: 0b9e6f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b    # your Revyl project's id
session:
  default_profile: signed-in                  # optional: runs when you leave profile out
  profiles:
    signed-in:
      script: scripts/sign-in.sh              # has a "/": a file path from the project folder, the one holding .revyl/
      requires_repository_checkout: true      # optional: Revyl clones the repository before the script runs
    seeded-cart:
      script: seed-cart                       # no "/": .revyl/scripts/seed-cart.js, .py, .sh or .ts, else the Library Script named seed-cart
```

With the profile's name, Verify sends:

- **The project:** `project.id`, and the checkout's Git branch, found the way the Revyl CLI finds it: the branch checked out in the project folder; on GitHub Actions or Buildkite, the branch CI built, including a pull request's own branch (`owner:branch` for a fork) when the checkout is that pull request's code, even on a detached HEAD. Verify leaves the branch out when it finds none or Git fails. Revyl reads the files it needs from Git at the head of that branch. When Git doesn't have the branch, Revyl reads the default branch, and Verify logs `Git has no branch "<branch>", so session profile <name> reads the repository's default branch instead`.
- **The script from this checkout:** the profile's definition and its script file as they are on disk, uncommitted changes included, so you can edit a script and run it without committing. A path script must stay inside the repository (under the nearest folder that holds `.git`, or the project folder outside Git) and be executable (`chmod +x`, with a `#!` line). A script file must be UTF-8 text of at most 64 KiB. A script name with no file in `.revyl/scripts` is a Library Script, which Revyl reads from your organization.

On a browser or device, the script runs on Revyl's hosted runner, not on your machine: it doesn't see your localhost, your files or your Revyl login. On a Mac computer, it runs on that Mac. The script's environment variables and the output files it writes are Revyl's contract: see [Session profiles](https://docs.revyl.com/devices/session-profiles) in the Revyl docs.

### Waiting

`open()` returns when the session is ready and Revyl reports the profile's status as `succeeded`, within the target's `start_timeout` (600 seconds by default). While it waits, it logs `<platform>: waiting for session profile <name>`. Verify never shows the script's output: Revyl doesn't send it, because setup scripts often print secrets. On a Mac computer, Revyl refuses commands and screen actions with HTTP 409 `session_profile_running` while the profile runs, without running them. If a call on a computer, such as one you `attach()` to, still gets that refusal, Verify waits and sends the same call again, for up to the start timeout (600 seconds for `attach()` and `current_computer()`), then raises `TIMEOUT` naming the profile. It repeats only calls Revyl refused that way.

### Session profile errors

Neither errors nor logs contain the script's content or output. A refusal keeps Revyl's code in `error.reason`, such as `project_not_found`, and Revyl's sentence in the message.

| Error | When | What to do |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `profile` isn't a profile name (1-64 lowercase letters, digits or hyphens) or `"none"` | Pass a name from `session.profiles`, or `"none"` |
| `NOT_AVAILABLE_ON_PLATFORM` | A Linux computer, or a session started without reporting its profile, which Verify then stops | Leave out `profile`, or pass `profile="none"` |
| `CONFIG_NOT_FOUND` | `profile` names a profile, but no `.revyl/config.yaml` is in the current folder or above it | Run from your app's checkout, or pass `profile="none"` |
| `CONFIG_INVALID` | `.revyl/config.yaml` isn't valid YAML, `project.id` isn't a UUID, or `session.profiles` doesn't define the name (the message lists the ones it does); or Revyl refused with `session_profile_undefined`, `project_not_found` (`project.id` isn't in this API key's organization) or `repository_connection_missing` (connect the repository's GitHub or GitLab app to the project in Revyl) | The message names the file and the fix |
| `SESSION_PROFILE_FAILED` | Verify couldn't send the script (missing, outside the repository, not executable, over 64 KiB or not UTF-8); Revyl couldn't find it (`session_profile_script_unavailable`); or the profile ran and failed. `error.outcome` says how and `error.failure_reason` says why | Follow the message, as the next table says. Revyl stops a session whose profile failed, so Verify doesn't, and `error.cleanup_status` is `not_required` |
| `API_ERROR` | Revyl couldn't read the repository in 3 attempts (`repository_unavailable`). Verify repeats the same start twice before it gives up | Try again in a few minutes |

| `error.outcome` | Meaning | Fix |
| --- | --- | --- |
| `script_failed` | The script exited with an error | Run the script yourself from the project folder to see its output |
| `script_timed_out` | The script ran past Revyl's 300-second limit | Make it finish sooner |
| `script_unavailable` | The script isn't in this checkout or in Git, or the Library Script is missing | Commit the script or add it to `.revyl/scripts`, or create the Library Script |
| `output_invalid` | A file the script wrote broke a rule; `failure_reason` names the file and the line | Fix what the script writes there |
| `runner_failed` | Something failed on Revyl's side | Open the session again |
| `script_execution_unknown` | The run ended after Revyl let the script start because its runner was lost or the session stopped, timed out, or was cancelled, so the script may have run | Check the session before retrying |
| `cancelled_before_script_execution` | The session stopped, timed out, or was cancelled before the script started | Retry the profile when the session can remain active long enough to run it |

## Exact actions

**Since 0.2.0. Early access.** Web, iOS and Android sessions take device actions that need no agent. They match the TypeScript SDK's exact actions in snake_case, and `AsyncSession` has the same methods to await. `double_tap`, `long_press`, `drag`, `type_focused`, `go_home`, and Web keys and modifiers in `press_key`, are new in 0.3.0. `tap` (by point or description), `screen_size`, `type_focused` and `press_key` on a Mac computer's screen are new in 0.4.0, and `type` there in 0.5.1; see [Mac computer](#mac-computer).

**Typing: one rule on every platform.** To type, call `type("Email field", text)`: it taps the field you describe and types into it, replacing its text unless you pass `clear=False`. It works the same on Web, iOS, Android and a Mac computer. `type_focused(text)` types wherever focus already is, without tapping, and only on Web and computers; on Web, when no field has focus it raises `ACTION_FAILED` with `reason="no_focused_input"` and types nothing.

```python
from revyl_verify import Point, Target, open

with open(Target(platform="ios", bundle_id="com.apple.Preferences")) as session:
    session.tap("General")  # Revyl's grounding model finds the element
    session.tap(Point(220, 480))  # or a point in screenshot pixels
    session.type("Search", "Accessibility")  # clears the field first unless clear=False
    session.swipe("up")  # from the screen's center, or from_=location
    session.press_key("enter")
    session.open_url("https://example.com")  # a URL or an app's deep link on devices
    session.launch_app("com.apple.Preferences")
    where = session.locate("About")  # a Point, without acting
    size = session.screen_size()  # the screenshot's ScreenSize(width, height)
    session.long_press("General", duration=0.8)  # press and hold, in seconds; 1.5 by default
    session.double_tap("Settings title")
    session.drag("General", "Search")  # press, move, release: the list follows the finger
    session.go_home()  # the home screen, on iOS and Android
```

On Web, type into a field, then where the focus moves, and press more keys:

```python
import os

from revyl_verify import Target, open

web = Target(platform="web", app_id=os.environ["REVYL_WEB_APP_ID"], url="https://www.saucedemo.com")
with open(web) as session:
    session.type("Username field", "standard_user")  # taps the field, then types
    session.press_key("tab")  # focus moves to the password field
    session.type_focused("secret_sauce")  # replaces the focused field's text unless clear=False
    session.press_key("enter")
    session.tap("Open Menu button")
    session.press_key("escape")  # closes the menu
    session.press_key("a", modifiers=["ctrl"])  # a chord: a letter or digit with modifiers
```

A location is a `Point(x, y)` in whole, non-negative screenshot pixels from the top-left corner, or a string describing the element, such as `"Login button"`, which Revyl's grounding model finds on the current screen.

| Call | What it does |
| --- | --- |
| `tap(at)` | Taps (clicks on Web and Mac computers) and returns the `Point` tapped. On a Mac computer a described tap takes several seconds and can click a look-alike, so check the point |
| `double_tap(at)` | Double-taps (double-clicks on Web) and returns the `Point` |
| `long_press(at, duration=None)` | Presses and holds for `duration` seconds, 0.001 to 5 in whole milliseconds (1.5 by default), and returns the `Point` |
| `type(at, text, clear=True)` | The way to type, on every platform. Taps a text field and types into it, clearing it first unless `clear` is `False`; returns the `Point` tapped. On a Mac computer it clicks the field, selects its text with Command+A unless `clear` is `False`, and types |
| `type_focused(text, clear=True)` | Web and Mac computers: types into the field that already has focus, without clicking. Prefer `type("description", text)`. On Web, with no field focused nothing is typed and it raises `ACTION_FAILED` with `reason="no_focused_input"`; on a Mac computer the keys go to whatever has focus, so check the result. On Web it replaces the field's text unless `clear` is `False`. On a Mac computer pass `clear=False`: it types where the cursor is, and leaving `clear` out raises `INVALID_ARGUMENT`. To replace text there, select it first with `press_key("a", modifiers=["meta"])`. On iOS and Android it raises `NOT_AVAILABLE_ON_PLATFORM` before anything is sent; use `type("description", text)` |
| `swipe(direction, from_=None)` | Swipes from a location or the screen's center; `"up"` moves the finger up, which scrolls content down |
| `drag(start, end)` | Presses at one location, moves to the other and releases, for example to reorder a list, move a slider or select text |
| `press_key(key, modifiers=())` | Presses a key on the focused element. Every platform takes `"enter"` and `"backspace"`. Web and Mac computers also take `"tab"`, `"escape"`, `"delete"`, `"space"`, `"arrowup"`, `"arrowdown"`, `"arrowleft"`, `"arrowright"`, `"home"`, `"end"`, `"pageup"` and `"pagedown"`, and `modifiers`: up to four of `"ctrl"`, `"shift"`, `"alt"` and `"meta"`, held while the key is pressed. With modifiers a lowercase letter or digit works too. The shortcut key differs: select all with `press_key("a", modifiers=["meta"])` on a Mac computer, where `"meta"` is Command and `"alt"` is Option, and with `press_key("a", modifiers=["ctrl"])` on Web, where `"meta"` is not the shortcut key. Other keys and any modifiers raise `NOT_AVAILABLE_ON_PLATFORM` on iOS and Android |
| `back()` | Browser history on Web, the back button on Android; iOS raises `NOT_AVAILABLE_ON_PLATFORM` |
| `go_home()` | Goes to the home screen on iOS and Android; Web raises `NOT_AVAILABLE_ON_PLATFORM` |
| `open_url(url)` | Opens a URL or deep link on a device, or loads an http(s) URL in a browser |
| `launch_app(bundle_id)` | Launches an installed app on a device |
| `locate(target)` | Returns Revyl's best match on the current screen, without acting |
| `screen_size()` | Returns the screenshot's `ScreenSize(width, height)` in pixels |

A failed action raises `ACTION_FAILED`, including when Revyl cannot find a target or nothing at a point can take the action. One whose outcome Revyl can't confirm raises `ACTION_UNCERTAIN` or `TIMEOUT`, so check the session before acting again. Actions are never repeated. If Verify can't reach Revyl, the action fails with `API_ERROR` and isn't resent either, so check the session before trying it again.

Exact actions return when Revyl has accepted them, not when the screen has finished changing. After `swipe`, `drag`, `go_home`, `open_url` or `launch_app`, let the screen settle or check it before you `locate` or tap coordinates. `locate` returns Revyl's best match on the current screen and can return a point for an element that is off screen, so bring the element on screen first. A point outside `screen_size()` is off screen, and an action at it is refused.

**Fast input: `settle=False`.** On Web, the browser runtime waits after every `tap`, `double_tap`, `long_press`, `type`, `type_focused`, `swipe`, `drag` and `press_key` until the page stops changing, for up to about 6 seconds. A running game or animation never stops changing, so each call takes the whole wait and the next one queues behind it. Pass `settle=False` to any of those calls for games, animations and rapid input, such as pressing an arrow key every few hundred milliseconds: the call returns as soon as the input is sent, usually within a second. The catch is that it returns before the screen may have changed, so when you need to see the result, take a `screenshot()` or run a `validation()`, and don't rely on the next screenshot showing it. A described location such as `"Play button"` is still found before the input; `settle=False` skips only the wait after it. iOS, Android and Mac computers don't wait for the screen after these calls, so `settle=False` is accepted there and changes nothing. `settle` takes `True` (the default) or `False`; anything else raises `INVALID_ARGUMENT`. `AsyncSession` takes it too.

```python
import time

for _ in range(10):
    session.press_key("arrowleft", settle=False)  # returns without waiting for the page to settle
    time.sleep(0.3)
session.validation("The player is at the left edge")  # check the result when you need it
```

**Coordinates.** Prefer a description, such as `tap("Sign in button")`: Revyl finds the element on the current screen, and you never handle coordinates. Otherwise a point is `Point(x, y)` in screenshot pixels on every platform: whole numbers from the top-left corner of the image `screenshot()` returns. So a position you read off a screenshot goes to `tap()`, `type()`, `swipe()` and every other exact action unchanged. `screen_size()` returns the screenshot's width and height, and `locate()` and the points `tap()`, `double_tap()`, `long_press()` and `type()` return use the same pixels. A point outside the screenshot is refused with `INVALID_ARGUMENT` before any action is sent, and the message names the valid range. On iOS, Verify converts the pixels to the screen's points for you. On Web they equal CSS pixels at the default device scale factor of 1, and you still pass screenshot pixels at any other. This holds from TypeScript 0.4.1, Python 0.2.1 and Go v0.3.1; earlier versions took iOS points. On a Mac computer a point is in screenshot pixels too, and `tap("description")` returns the point it clicked in the same pixels. Verify refuses a negative or fractional point before sending it, and Revyl refuses one past the screen's edge without clicking; both raise `INVALID_ARGUMENT` naming the valid range.

```python
session.screenshot(path=".verify/screen.png")  # open it and find the element
session.tap(Point(660, 1500))  # the position as you read it, on every platform
size = session.screen_size()  # the screenshot's size: x is 0 to size.width - 1
```

### Which call works where

| Call | Web | iOS | Android | Mac computer |
| --- | --- | --- | --- | --- |
| `tap(Point(x, y))`, `tap("description")`, `screen_size` | Yes | Yes | Yes | Yes |
| `locate` | Yes | Yes | Yes | No, use `tap("description")`, which returns the point it clicked, or read the point off `screenshot()` |
| `type("description", text)`, the way to type | Yes | Yes | Yes | Yes: clicks the field, selects its text unless `clear=False`, then types |
| `double_tap`, `long_press`, `swipe`, `drag` | Yes | Yes | Yes | No |
| `press_key(key, modifiers)` | Yes: `"enter"`, `"backspace"`, `"tab"`, `"escape"`, arrows and more, with modifiers | `"enter"` and `"backspace"` only | `"enter"` and `"backspace"` only | Yes: the Web keys and modifiers, where `"meta"` is Command |
| `type_focused(text, clear)` | Yes, types into the focused field; `ACTION_FAILED` (`no_focused_input`) when none has focus | No, use `type("description", text)` | No, use `type("description", text)` | Yes, with `clear=False` |
| `back()` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `go_home()` | No, use `open_url` or `navigate` | Yes, the home screen | Yes, the home screen | No |
| `open_url(url)` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `launch_app(bundle_id)` | No, use `open_url` or `navigate` | Yes | Yes | No |
| `navigate(url)` | Yes | No, use `open_url` | No, use `open_url` | No |
| `cdp()`, for Playwright and Puppeteer | Yes, see [CDP](#cdp-playwright-puppeteer) | No | No | No |
| `instruction` | Yes | Yes | Yes | No, use `tap("the Save button")` and `type("the search field", text)` |
| `validation`, `extract` | Yes | Yes | Yes | Yes, on a Mac opened with `inference=True`; see [validation() and extract() on a Mac](#validation-and-extract-on-a-mac) |
| your own model (`model`, `agent`) | Yes | Yes | Yes | No |
| `screenshot()` | Yes | Yes | Yes | Yes |
| `exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

Coordinates follow the rule in [Exact actions](#exact-actions). A call a platform doesn't support raises `NOT_AVAILABLE_ON_PLATFORM`, and its message names the alternative.

## CDP (Playwright, Puppeteer)

Web only. `session.cdp()` returns a Chrome DevTools Protocol (CDP) endpoint for the session's cloud browser, so a script can attach Playwright or another CDP client next to Verify's steps. `instruction()`, `validation()`, `screenshot()` and the exact actions keep working while the script is attached. `AsyncSession.cdp()` is the same, awaited.

```python
from playwright.sync_api import sync_playwright  # pip install playwright; no browser download

from revyl_verify import Target, open

with open(Target(platform="web", app_id="<web app id>")) as session:
    with sync_playwright() as playwright:
        endpoint = session.cdp()  # connect once, within 60 seconds
        browser = playwright.chromium.connect_over_cdp(endpoint.url)
        page = browser.contexts[0].pages[0]  # the session's own tab
        page.locator("#user-name").fill("standard_user")
        session.validation("The username field shows standard_user")
        browser.close()  # only disconnects Playwright; leaving the with block ends the session
```

It returns a `CDPEndpoint` with `url` (`str`) and `expires_at` (a timezone-aware `datetime`). [`examples/cdp_playwright.py`](examples/cdp_playwright.py) runs a full script: DOM, locators, a console message, network requests and a Verify validation while attached (`cd python && uv run python examples/cdp_playwright.py` with `REVYL_WEB_APP_ID` set).

- **The url is a single-use credential.** It accepts one connection and expires at `expires_at`, 60 seconds after `cdp()` returns it. Call `cdp()` again for each new connection. Don't log it, store it or pass it on; `repr()` of the endpoint leaves it out, but Playwright's connection errors can include it, so remove it before you log one. Any connection attempt uses the url up, even one that fails, so call `cdp()` again before you retry.
- **One connection at a time.** A second connection to the same session is refused until the first disconnects. Once `browser.close()` has returned, the next url from `cdp()` connects.
- **The connection ends with the session.** `close()`, the session's timeout or a failure closes it. After `close()`, `cdp()` raises `SESSION_ENDED` without a request, and an earlier url no longer works.
- **Use the session's page.** In Playwright that is `browser.contexts[0].pages[0]`. `browser.new_context()` is refused, because a session has one browser context. A tab you open with `context.new_page()` becomes the session's active tab: Verify steps, screenshots and the recording follow it until you close it, and then return to the session's tab. While another tab is open, `pages[0]` may not be the session's tab, so find it by URL. In Puppeteer, connect with `defaultViewport: null` and use `(await browser.pages())[0]` while the session has one tab.
- **`browser.close()` only disconnects.** In Playwright and Puppeteer it disconnects the script, and the session keeps running; call `session.close()` to end it. In Puppeteer, `browser.disconnect()` is the explicit form.
- **Navigation is http(s) and `about:blank` only.** `file://`, `chrome://`, `data:`, `javascript:` and other schemes are refused with a CDP error.
- **Downloads are off.** Download-behavior commands are accepted, but nothing is downloaded and no download path can be set.
- **The window size is fixed.** Viewport and window-size emulation (`page.set_viewport_size()`) and `Browser.close` are refused; the browser keeps the size the session opened with. Set the target's `viewport` to choose it.
- **Refusals are CDP errors that start with `Revyl:`**, so the script sees why.
- **A reply over 24 MB is dropped** with the CDP error `Revyl: the reply was larger than 24 MB and was dropped` (Playwright reports it from `page.evaluate` as "Execution context was destroyed"); the connection and the session keep working.
- **Files come from your machine.** Playwright's `set_input_files()` with files from the script's machine works; file paths on the browser's host are refused.
- Everything else works as with a local Chrome: locators, DOM, `evaluate`, console and network events, request interception and screenshots.

On iOS, Android and Mac computers `cdp()` raises `NOT_AVAILABLE_ON_PLATFORM` before any request; use `instruction()`, `validation()`, `screenshot()` and the exact actions there, or `exec()` and `screenshot()` on a computer. A session that is no longer running raises `SESSION_ENDED`, a view-only session `AUTH_REJECTED`, and a Revyl backend without CDP `NOT_AVAILABLE_ON_PLATFORM` saying so. HTTP 503 raises `API_ERROR`, and calling `cdp()` again is safe.

## Your own model

**Since 0.2.0. Early access.** Verify normally runs `instruction()` and `validation()` on Revyl's agent. Pass a `model` and the agent loop runs in your process instead, on a model you choose, with your own key. Revyl still provides the browser or device and, by default, finds the elements your model names on screen. Leave `model` out and nothing changes.

```python
from revyl_verify import Target, open

with open(
    Target(platform="ios", bundle_id="com.apple.Preferences"),
    model="anthropic/claude-sonnet-5-5",
) as session:
    step = session.instruction("Open General, then About")
    print(step.model)  # ModelRun(id, grounding, turns, input_tokens, output_tokens)
    session.validation("The screen shows the iOS version")
    session.instruction("Open Privacy", model="openai/gpt-5.5")  # one step on another model
```

The string is `"provider/model"`, and the key comes from the provider's usual environment variable. A missing key raises `MODEL_KEY_MISSING` before any Revyl request. Everything after the first slash is the provider's own model name, so `"openrouter/anthropic/claude-sonnet-5-5"` works.

| Prefix | Key variable | Endpoint |
| --- | --- | --- |
| `anthropic/` | `ANTHROPIC_API_KEY` | Anthropic Messages API |
| `openai/` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `google/` | `GOOGLE_API_KEY`, or `GEMINI_API_KEY` when it is unset | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| `openrouter/` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `groq/` | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| `cerebras/` | `CEREBRAS_API_KEY` | `https://api.cerebras.ai/v1` |
| `xai/` | `XAI_API_KEY` | `https://api.x.ai/v1` |
| `ollama/` | none | `http://localhost:11434/v1` |

Any server that speaks OpenAI's chat completions with tools and image input works through `CustomModel`. Its key comes only from `api_key`; Verify never reads an environment variable for it.

```python
from revyl_verify import CustomModel

model = CustomModel(
    id="qwen-3.8-27b",  # the model name the server expects
    base_url="https://my-gateway.example/v1",  # the root that serves /chat/completions
    api_key=os.environ["MY_GATEWAY_KEY"],  # optional, sent as a bearer token
    headers={"x-team": "mobile"},  # optional, extra headers
    provider="qwen",  # optional, reported as "qwen/qwen-3.8-27b"
    grounding="revyl",  # optional, "revyl" (default) or "model"
)
```

By default (`grounding="revyl"`) your model names the element it wants and Revyl's grounding model finds it, so a small, fast vision model is usually enough. With `grounding="model"` the model gives screenshot coordinates itself, which keeps element descriptions away from Revyl but needs a model that points accurately. The model must accept images and support tool calls.

**Custom agents.** For control beyond a model name, build the agent with `local_agent()` and pass it as `agent`, on `open()` or on one step. The `model` forms build exactly this agent. Passing both `model` and `agent` raises `INVALID_ARGUMENT`.

```python
from revyl_verify import local_agent, open, openai_compatible

agent = local_agent(
    openai_compatible("qwen3-vl:8b", base_url="http://localhost:11434/v1"),
    grounding="model",  # default "revyl"
    max_turns=10,  # default 20, at most 100
    model_timeout=120,  # seconds per model call, retries included; default 60
    max_image_side=1280,  # longest screenshot side sent to the model
)
session = open(target, agent=agent)  # or session.instruction(text, agent=agent)
```

- `anthropic(model, api_key=None, base_url=None, max_tokens=4096, max_retries=2)` and `openai_compatible(model, base_url=None, api_key=None, headers=None, provider=None, max_tokens=None, max_retries=2)` are the built-in adapters. When `base_url` is left out, `anthropic()` reads `ANTHROPIC_BASE_URL` and `openai_compatible()` reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`; with a `base_url`, `openai_compatible()` sends only the `api_key` you pass.
- To use another SDK or runtime, implement `ModelAdapter`: a `name` and `complete(request, timeout)`, which gets a `ModelRequest` (system prompt, text, screenshot and tools) and the seconds the call may take, and returns a `ModelReply` with the chosen `ModelToolCall`, any text, `ModelUsage` and whether the reply was cut off at its output cap.

**What goes where.** Your model sees the system prompt, the step text, a short log of the actions it took so far and whether they worked, and the current screenshot, downscaled so its longest side is at most `max_image_side`. Revyl receives each device action, the element descriptions your model writes (not with `grounding="model"`), and the model's name for the session report, never the step text, the prompts, the model's output or your key. Keys go only to the model's endpoint, are never logged, and are replaced with `[redacted]` in error messages, as are custom header values.

| Limit | Default | Change it with |
| --- | --- | --- |
| Turns per instruction | 20 (at most 100) | `local_agent(max_turns=...)` |
| Verdict attempts per validation | 3 | |
| Whole step | 180 s | the step's `timeout`, or `step_timeout` on `open()` |
| One model call, retries included | 60 s | `local_agent(model_timeout=...)` |
| Retries per model call | 2, on rate limits, 5xx and network errors; `Retry-After` is honored up to 10 s | the adapter's `max_retries` (0 to 5) |
| Output tokens per turn, thinking included | 4096 on Anthropic, OpenAI and Google, 2048 elsewhere; a reply cut off at the cap raises `MODEL_ERROR`, and a tool call in it is never run | the adapter's `max_tokens` |
| Turns in a row without a tool call | 3, then `MODEL_ERROR` | |

The step deadline covers every model call and device request. A device action still in flight when it passes raises `ACTION_UNCERTAIN` and is never repeated. `StepResult.model` is a `ModelRun` with each turn's action, whether it ran, model and action seconds, and token counts; input tokens include cached input. Progress lines name each turn's tool and timings and the step's turns and tokens, never typed text, element descriptions or URLs.

### Behind a proxy or gateway

Keep the string form and point the provider's base-URL variable at the proxy, the same variables Anthropic's and OpenAI's SDKs read:

```bash
export ANTHROPIC_BASE_URL=https://llm-proxy.example.com/anthropic   # with or without a trailing /v1
export ANTHROPIC_API_KEY=<the proxy's key>
# or OPENAI_BASE_URL=https://llm-proxy.example.com/openai/v1 with OPENAI_API_KEY
```

Or name the proxy in code when it speaks OpenAI's chat completions: `model=CustomModel(id="claude-sonnet-5-5", base_url="https://llm-proxy.example.com/v1", api_key=os.environ["PROXY_KEY"])`.

A base address works with or without a trailing `/v1`. For Anthropic, Verify calls `<base>/v1/messages`, or `<base>/messages` when the base already ends in a version such as `/v1`. For OpenAI-compatible addresses, Verify adds `/v1` only to a bare host, so `https://gw.example.com` and `https://gw.example.com/v1` both call `https://gw.example.com/v1/chat/completions`, and a path such as `/openai/v1` is used as given. Verify doesn't check a key's prefix or shape. If the proxy rejects the key, the error names the host and the variable the key and address came from, never the key; if it answers 404, the error names the path Verify added to the base address.

### Example

[`examples/byo_model.py`](examples/byo_model.py) runs the string form and exact actions on iOS Settings, and [`examples/custom_agent.py`](examples/custom_agent.py) a custom local agent. From a checkout, with a Revyl sign-in and `ANTHROPIC_API_KEY` set (or `MODEL` naming another provider, with its key):

```bash
cd python && uv run python examples/byo_model.py
```

## Platforms and cleanup

### Targets and methods

Construct a frozen `Target(platform=...)`:

- **Web:** `app_id` (Revyl UUID) is required. Supply `url` for a public HTTPS site, `build_id` for a specific build, or `branch` for the selected app's latest build. `build_id` cannot be combined with `url` or `branch`. Optional `Viewport(width, height, device_scale_factor=...)` and `SignIn(path, secret, persona=...)` configure the browser and saved sign-in secret reference, not a raw credential.
- **iOS / Android:** provide exactly one of `app_id`, `build_id`, HTTPS `artifact_url` or installed-app `bundle_id`. Optional `device_model` and `os_version` select the device, written as Revyl names them, such as `device_model="iPhone 16", os_version="iOS 18.5"` or `device_model="Pixel 7", os_version="Android 14"`. A value Revyl doesn't offer raises `INVALID_ARGUMENT` listing the values it accepts, and no session starts. An `app_id` or `build_id` Revyl can't find raises `INVALID_ARGUMENT` naming what wasn't found and how to fix it, and no session starts. A `bundle_id` that can't be launched raises `SESSION_START_FAILED` naming the bundle id, with the session link. Do not combine mobile app sources.
- **Mac:** only `platform`, `start_timeout`, `timeout` (the lifetime in seconds) and `inference` (run on a Mac with its own vision model; see [validation() and extract() on a Mac](#validation-and-extract-on-a-mac)) are accepted; app/browser/device fields are unavailable.

`start_timeout` defaults to 600 seconds (allowed range 10–1800). Web/mobile also accept `idle_timeout_seconds` (60–3600). `open`, `async_open`, `attach` and `async_attach` accept default `step_timeout` in seconds.

Verify prints sanitized progress to stderr as `[verify] <platform>: …` lines, like the TypeScript SDK: `starting <platform> session <link>` as soon as the session ID exists, on every platform and before the device is ready, then `ready`, and each step's outcome and duration. Pass `log=callback` to receive the lines yourself, or `log=False` to turn them off. Async callbacks run on a worker thread, so make them thread-safe; callback exceptions do not interrupt resource cleanup. Progress never includes app URLs, command or step content, credentials, recording URLs, or raw server errors. Viewer links and session IDs are still private operational context.

Startup `VerifyError` instances retain optional typed `platform`, `session_id`, `workflow_run_id`, and `viewer_url`, plus `cleanup_status` and `cleanup_error`. These fields remain available even though opening did not return a session:

```python
from revyl_verify import Target, VerifyError, open

try:
    session = open(Target(platform="mac"), log=lambda line: None)
except VerifyError as error:
    session_id = error.session_id
    viewer_url = error.viewer_url
    cleanup_status = error.cleanup_status
    cleanup_error = error.cleanup_error
else:
    session.close()
```

Cleanup status is `acknowledged` for a validated device stop response, `confirmed` for terminal computer state plus physical release, `unconfirmed` when cleanup failed or no usable mobile identity was returned, and `not_required` after a definite create refusal. `not_attempted` applies before startup ownership exists. An unknown mobile ID is `None`, never invented. Web/computer caller-generated IDs remain available after an uncertain create; a mismatched web acknowledgment never authorizes stopping the other ID. Startup cleanup uses a fresh bounded deadline, preserves the original failure, and attaches a separate cleanup error. Do not retry creation to recover an uncertain outcome; inspect the known session privately. A device stop acknowledgment does not prove physical release.

Session properties include `id`, `platform`, `viewer_url`, `expires_at` and `closed`. Steps return `StepResult` with `passed`, `reason`, `duration_seconds`, `value` (extract steps only), `engine` (`"local"` or `"hosted"` when Revyl says which model answered, else `None`) and, for a step run on your own model, `model`; commands return `ExecResult` with `exit_code`, `stdout` and `stderr`. Computer methods also include `stat(path)`, `processes()` and `terminate(handle_id)`, with bounded seconds-based timeouts. Errors raise `VerifyError` with a stable `code`. Async session methods have the same arguments/results and are awaited.

`EDGE_BLOCKED` identifies HTTP 403 with a `text/html` content type and nonempty `cf-ray`, unless the body is syntactically valid JSON. HTML branding is not required; `cf-ray` alone is not enough. Other responses retain their existing mapping, including JSON 401/403 authentication errors. Edge-block errors expose `http_status` but no body or ray ID. Check network access or contact support; Verify does not retry blocked requests.

`VerifyError.reason` is an optional exported `RefusalReason` literal containing only a known safe server code; `http_status` is the response status when available. Raw server messages and payloads are not exposed through these fields. Ordinary Web startup `409 web_runtime_unavailable` keeps `code="API_ERROR"`, computer admission keeps `COMPUTER_LIMIT` for `computer_limit` and `NOT_AVAILABLE_ON_PLATFORM` for `runtime_unavailable`; inspect `reason` to distinguish availability from other failures. Hosted errors use `NOT_AVAILABLE_ON_PLATFORM` for runtime/capability refusals, `COMPUTER_LIMIT` for capacity, `SESSION_ENDED` for `computer_not_running`, `NOT_FOUND` for `computer_not_found`, `INVALID_ARGUMENT` for build selection and `SESSION_BUSY` for child identity conflicts. Unknown reasons remain `None`; no refusal automatically retries creation.

| Platform | Instructions / validations / extract | Commands / files / processes | PNG screenshot |
| --- | :---: | :---: | :---: |
| Web | Yes, if the backend supports web steps | — | Yes |
| iOS simulator / Android emulator | Yes | — | Yes |
| Mac computer | Validations and extract, on a Mac opened with `inference=True` | Yes | Yes |

Mac computers are available to organizations on a current paid Revyl plan. When Revyl says Pro would unlock Macs for a Free-plan organization (`computer_not_enabled` with `unlocks_with_card: true`), `open()` and `open_persistent()` raise `NOT_AVAILABLE_ON_PLATFORM` with `reason="upgrade_required"`. The message starts `Mac computers come with Pro, so Revyl refused this computer (computer_not_enabled, upgrade_required).` and ends with Revyl's upgrade offer and its HTTPS billing link, or with `Add a card in Revyl's billing settings to unlock them.` when Revyl sends no offer. Any other `computer_not_enabled` keeps the support guidance and no reason. Computer admission may return `COMPUTER_LIMIT`; the SDK does not retry creation. Computer sessions have a hard lifetime from creation: 2 hours by default, or up to 24 hours with `Target(platform="mac", timeout=...)` (seconds, 60 to 86400). `session.extend(timeout)` keeps a running computer going at least that long from now, up to 24 hours after creation; it never shortens the lifetime, so retrying is safe, and it refreshes `expires_at`, the authoritative deadline. Lifetimes over 2 hours can be refused with `COMPUTER_LIMIT` (`computer_long_limit`, at most 2 such computers per organization at once) or `NOT_AVAILABLE_ON_PLATFORM` (no host can run that long, or the host can't extend). Screenshot observation retries structured startup screen-not-ready errors within a bounded window; other errors are not silently replayed.

Context-manager exit calls `close()`. Device close acknowledges a stop request; computer close requires terminal state **and confirmed resource release**. Close submits its stop mutation once; repeated calls share the first outcome, including an unconfirmed failure. Interpreter-exit cleanup is best effort and cannot replace explicit close, especially with asyncio. A failed close is not proof the resource was released; investigate it rather than starting replacement sessions blindly.

Async startup cancellation interrupts its bounded startup request and cleans up when an identity is known. Context managers preserve an existing body failure if cleanup also fails, chaining the cleanup exception. Main-thread `open`/`async_open` installs cleanup-compatible SIGTERM handling only when no custom SIGTERM handler exists; it exits with `128 + signal` after unwinding and best-effort cleanup. Abrupt termination, SIGKILL, and existing application signal handlers cannot guarantee cleanup.

## Development

From `python/`:

```bash
uv sync --frozen
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen mypy
uv run --frozen pytest
uv build
uv run --frozen python -m twine check --strict dist/*
uv run --frozen python scripts/check_package.py
```

Use an empty `dist/` before building; the package checker rejects stale or extra distributions. `uv build` builds the wheel through the sdist. Package checks validate public files, typing marker, metadata and license, then install the wheel into a fresh isolated venv and run a loopback fake-server smoke without pytest. They also extract the sdist, sync its locked dev environment and run its tests independently of the checkout; repository-only checks for workflow configuration and canonical Go fixture parity skip there. They make no live Revyl requests. CI covers Python 3.10 and the current stable 3.15 series. Use `uv lock` after deliberate dependency changes; do not hand-edit `uv.lock`.

## Documentation

- [TypeScript API and platform contracts](https://github.com/RevylAI/verify/tree/main/packages/verify/docs)
- [Use your own model](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/own-model.md): providers, live results and troubleshooting, which apply to Python too
- [Mac model checks](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/mac-model-checks.md): `validation()` and `extract()` on a Mac opened with inference
- [Apps inside an inference Mac](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/apps-inside-an-inference-mac.md): local inference for iOS and Web sessions
- [Persistent computers](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/guides/persistent-computers.md): persistent Macs and snapshots
- [Go SDK](https://github.com/RevylAI/verify/tree/main/go)
- [Live results from other SDKs and limitations](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/end-to-end.md)
- [Python release procedure](https://github.com/RevylAI/verify/blob/main/RELEASING.md#python)

## Troubleshooting

- **`NOT_AVAILABLE_ON_PLATFORM`:** computers do not support `instruction()` (use `tap("the Save button")` and `type("the search field", text)`), `validation()` or `extract()` except on a Mac opened with `inference=True`, your own model, or exact actions other than `tap`, `type`, `screen_size()`, `type_focused(text, clear=False)` and `press_key`; devices do not support commands, files, processes or recording metadata; iOS has no `back()`, Web has no `launch_app()` or `go_home()`, and iOS and Android have no `type_focused()` and no keys other than Enter and Backspace.
- **`STEP_FAILED` from `extract()` or a Mac validation:** nothing was read, or the model couldn't confirm an answer. Describe one value or one thing that is visible on the screen now, and check it with `screenshot()`.
- **`SESSION_PROFILE_FAILED`:** the session profile's script couldn't be sent, Revyl couldn't find it, or it ran and failed. `error.outcome` and `error.failure_reason` say which; see [Session profile errors](#session-profile-errors).
- **`MODEL_KEY_MISSING`:** the provider's key variable named in the message is not set. Set it, or pass `CustomModel(id, base_url, api_key=...)`.
- **`MODEL_ERROR`:** the model's endpoint refused the request or the model misbehaved. The message names the host, the HTTP status and the next step: a rejected key and the variable it came from, an unknown model, the path Verify added on a 404, a rate limit after retries, a text-only model, no tool support, a reply cut off at its output cap, or three turns without a tool call.
- **Blank initial screen:** first-frame observation is best effort. Start with an instruction; a transport-level connection does not prove rendered readiness.
- **Validation failed with successful HTTP:** use the validation verdict, not transport counters, to decide success. `soft=True` changes throwing behavior, not the verdict.
- **`ACTION_UNCERTAIN`:** an operation or cleanup outcome was not confirmed. Do not blindly retry mutations or assume a computer has been released.

## License

[Apache 2.0](https://github.com/RevylAI/verify/blob/main/LICENSE).
