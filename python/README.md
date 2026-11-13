<h1 align="center">Verify for Python</h1>

<p align="center"><em>Cloud browsers, mobile devices and computers from Python.</em></p>

Verify is a thin [Revyl](https://revyl.com) SDK, not a test runner. Open a web browser, iOS simulator or Android emulator for natural-language instructions and validations, or an early-access Mac computer for commands, files, processes and screenshots.

## For coding agents

Use Python ≥3.10 and the `revyl_verify` import. The distribution is named `revyl-verify`; it is separate from the `revyl` CLI. Install it from PyPI with `pip install revyl-verify` or `uv add revyl-verify`.

Run only explicitly authorized cloud workloads. Keep API keys, signed recording URLs and session links private. Use context managers so errors still trigger cleanup; there is no runner, automatic step replay or creation retry.

## Install

```bash
pip install revyl-verify
# Or, in a uv project:
uv add revyl-verify
```

Pillow is the only runtime dependency, for PNG blank-frame inspection and for downscaling screenshots sent to your own model; HTTP, model calls included, uses the standard library.

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

`open` returns a `Session`, which is also a context manager. `instruction` and `validation` wait for completion; a failed validation raises by default even if HTTP succeeded. Pass `soft=True` to `validation` to inspect a failed verdict without raising. Screenshots return PNG `bytes` and optionally save them to `path`, creating its folder. `report()` returns a JSON dictionary: for devices it is the session-details/report metadata from `/execution/device-sessions/{id}`, not a fabricated report endpoint.

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

recording = session.recording()
```

`exec(argv, stdin=bytes_or_string, timeout=30, check=True)` preserves argument boundaries and raises on command failure by default. File and process operations are computer-only. File paths are workspace-relative, not arbitrary absolute guest paths. `recording()` returns computer recording metadata or `None`, including after close; it does not wait for or download a recording. Signed URLs in that metadata are credentials. Recording is locally unavailable on devices.

Since 0.4.0, a script can click, type and press keys on the computer's screen at points it reads off `screenshot()`:

```python
import time

from revyl_verify import Point, Target, open

with open(Target(platform="mac", start_timeout=600)) as computer:
    computer.write_file("notes.txt", "Notes\n")
    computer.exec(["open", "-a", "TextEdit", "notes.txt"])  # exec runs in the workspace
    time.sleep(3)  # let the window open
    computer.screenshot(path=".verify/mac.png")  # open it and find the text
    computer.tap(Point(400, 300))  # the point as you read it
    computer.type_focused("First line\nSecond line", clear=False)
    computer.press_key("a", modifiers=["meta"])  # Command+A selects all
    computer.type_focused("Replacement", clear=False)  # typing replaces the selection
```

On a computer, `type_focused` needs `clear=False`: it types where the cursor is and clears nothing, so to replace text, select it first. `"meta"` is Command and `"alt"` is Option. `screen_size()` works too. `tap("the Help menu in the menu bar")` clicks a description and returns the `Point` it clicked. It takes several seconds and can click a look-alike, or something else when the target isn't on the screen, so check the point or take a screenshot afterwards, and use `tap(Point(x, y))` from a screenshot for anything that's hard to undo. `locate()` and the other exact actions aren't available on computers and raise `NOT_AVAILABLE_ON_PLATFORM` before anything is sent. When Revyl answers `screen_starting`, nothing happened, so Verify waits and tries again for up to 30 seconds. A script keeps control of the screen for 120 seconds after its last action, so a teammate can't take control in the Revyl viewer until then; while someone does control it there, actions raise `SESSION_BUSY` and nothing happens. A 403 raises `AUTH_REJECTED`: the key's owner needs the Member role or above, and CI runner keys can't control the screen yet. [computers.md](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#screen) lists every screen error.

**Breaking wire change:** computer-operation arguments use `argv_b64` (one padded URL-safe base64 UTF-8 string per argument) and file paths use `path_b64`, with no raw `argv` or `path`. This SDK is incompatible with the previous backend contract. Deploy the encoded-only backend before publishing or upgrading to this SDK. Public APIs and decoded limits are unchanged; `stdin` and file `data` retain their existing standard base64 encoding, and process commands are unchanged. Encoding is not encryption, and Verify does not fall back to plaintext or replay the request.

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

`computer.open(target)` requires **both** `app_id` and `build_id` UUIDs. Hosted Web accepts `viewport`, `sign_in`, `idle_timeout_seconds` and `start_timeout`, but no `url` or `branch`; the server currently accepts external Web builds, not bundled Web artifacts. Hosted iOS/Android use the selected build and fixed simulator/emulator configuration, so `bundle_id`, `artifact_url`, `device_model`, `os_version`, `url`, `branch`, `viewport` and `sign_in` are unavailable. Mac hosts Web/iOS. All hosting depends on server capability and capacity.

Children reuse their parent's credentials, API/viewer origins, step timeout and log callback. They return normal sessions with instruction, validation, screenshot, report and close methods. The parent's remaining lifetime bounds child startup and worker requests; report and close remain available after expiry. Closing a parent prevents new children, cancels in-flight starts, and gives pending starts and child closes one shared five-second cleanup budget before attempting the computer stop. Child startup failure never closes the parent. Confirmed physical parent release supersedes an earlier child-close uncertainty, which is logged safely. An ambiguous child start is cleaned up using its preallocated ID, without replaying creation. A definitive refusal does not issue a child stop.

When the computer belongs to another caller, such as a CI runner, use `attach(computer_id, stop_on_close=False)` or `await async_attach(computer_id, stop_on_close=False)`. These attachments are not registered for automatic cleanup. Explicit close or context-manager exit still cancels pending child starts and closes hosted children within the five-second cleanup phase, but never stops the computer; its owner must release it. Child-cleanup failures remain observable. The default is `True`, and ownership is never inferred from the environment.

For async code use `async with await async_attach(computer_id) as computer`, then `async with await computer.open(target) as browser` and `await browser.navigate(url)`. Cancelling a child open cleans up only that child and leaves the parent open; cancelling attach before it succeeds does not stop the existing computer.

## Exact actions

**Since 0.2.0. Early access.** Web, iOS and Android sessions take device actions that need no agent. They match the TypeScript SDK's exact actions in snake_case, and `AsyncSession` has the same methods to await. `double_tap`, `long_press`, `drag`, `type_focused`, `go_home`, and Web keys and modifiers in `press_key`, are new in 0.3.0. `tap` (by point or description), `screen_size`, `type_focused` and `press_key` on a Mac computer's screen are new in 0.4.0; see [Mac computer](#mac-computer).

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

On Web, type where the focus is and press more keys:

```python
import os

from revyl_verify import Target, open

web = Target(platform="web", app_id=os.environ["REVYL_WEB_APP_ID"], url="https://www.saucedemo.com")
with open(web) as session:
    session.tap("Username field")
    session.type_focused("standard_user")  # replaces the focused field's text unless clear=False
    session.press_key("tab")  # focus moves to the password field
    session.type_focused("secret_sauce")
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
| `type(at, text, clear=True)` | Taps a text field and types into it, clearing it first unless `clear` is `False`; returns the `Point` tapped |
| `type_focused(text, clear=True)` | Web and Mac computers: types into the field that already has focus, without clicking. Focus the field first, for example with `tap` or `press_key("tab")`. With no field focused nothing is typed and nothing is raised, so check the result. On Web it replaces the field's text unless `clear` is `False`. On a Mac computer pass `clear=False`: it types where the cursor is, and leaving `clear` out raises `INVALID_ARGUMENT`. To replace text there, select it first with `press_key("a", modifiers=["meta"])`. On iOS and Android it raises `NOT_AVAILABLE_ON_PLATFORM`; use `type(location, text)` |
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
| `double_tap`, `long_press`, `type`, `swipe`, `drag` | Yes | Yes | Yes | No |
| `press_key(key, modifiers)` | Yes: `"enter"`, `"backspace"`, `"tab"`, `"escape"`, arrows and more, with modifiers | `"enter"` and `"backspace"` only | `"enter"` and `"backspace"` only | Yes: the Web keys and modifiers, where `"meta"` is Command |
| `type_focused(text, clear)` | Yes, types into the focused field | No, use `type(location, text)` | No, use `type(location, text)` | Yes, with `clear=False` |
| `back()` | Yes, browser history | No, tap the on-screen back control | Yes, the system back button | No |
| `go_home()` | No, use `open_url` or `navigate` | Yes, the home screen | Yes, the home screen | No |
| `open_url(url)` | Yes, loads an http(s) URL in the tab | Yes, a URL or deep link | Yes, a URL or deep link | No |
| `launch_app(bundle_id)` | No, use `open_url` or `navigate` | Yes | Yes | No |
| `navigate(url)` | Yes | No, use `open_url` | No, use `open_url` | No |
| `instruction`, `validation`, your own model | Yes | Yes | Yes | No, use `exec()` and the screen calls above |
| `screenshot()` | Yes | Yes | Yes | Yes |
| `exec`, files, processes | No, open a Mac computer | No, open a Mac computer | No, open a Mac computer | Yes |

Coordinates follow the rule in [Exact actions](#exact-actions). A call a platform doesn't support raises `NOT_AVAILABLE_ON_PLATFORM`, and its message names the alternative.

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
- **iOS / Android:** provide exactly one of `app_id`, `build_id`, HTTPS `artifact_url` or installed-app `bundle_id`. Optional `device_model` and `os_version` select the device, written as Revyl names them, such as `device_model="iPhone 16", os_version="iOS 18.5"` or `device_model="Pixel 7", os_version="Android 14"`. A value Revyl doesn't offer raises `INVALID_ARGUMENT` listing the values it accepts, and no session starts. Do not combine mobile app sources.
- **Mac:** only `platform` and `start_timeout` are accepted; app/browser/device fields are unavailable.

`start_timeout` defaults to 600 seconds (allowed range 10–1800). Web/mobile also accept `idle_timeout_seconds` (60–3600). `open`, `async_open`, `attach` and `async_attach` accept default `step_timeout` in seconds.

Verify prints sanitized progress to stderr as `[verify] <platform>: …` lines, like the TypeScript SDK: the viewer link as soon as the session identity is known, `ready`, and each step's outcome and duration. Pass `log=callback` to receive the lines yourself, or `log=False` to turn them off. Async callbacks run on a worker thread, so make them thread-safe; callback exceptions do not interrupt resource cleanup. Progress never includes app URLs, command or step content, credentials, recording URLs, or raw server errors. Viewer links and session IDs are still private operational context.

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

Session properties include `id`, `platform`, `viewer_url`, `expires_at` and `closed`. Steps return `StepResult` with `passed`, `reason`, `duration_seconds` and, for a step run on your own model, `model`; commands return `ExecResult` with `exit_code`, `stdout` and `stderr`. Computer methods also include `stat(path)`, `processes()` and `terminate(handle_id)`, with bounded seconds-based timeouts. Errors raise `VerifyError` with a stable `code`. Async session methods have the same arguments/results and are awaited.

`EDGE_BLOCKED` identifies HTTP 403 with a `text/html` content type and nonempty `cf-ray`, unless the body is syntactically valid JSON. HTML branding is not required; `cf-ray` alone is not enough. Other responses retain their existing mapping, including JSON 401/403 authentication errors. Edge-block errors expose `http_status` but no body or ray ID. Check network access or contact support; Verify does not retry blocked requests.

`VerifyError.reason` is an optional exported `RefusalReason` literal containing only a known safe server code; `http_status` is the response status when available. Raw server messages and payloads are not exposed through these fields. Ordinary Web startup `409 web_runtime_unavailable` keeps `code="API_ERROR"`, computer admission keeps `COMPUTER_LIMIT` for `computer_limit` and `NOT_AVAILABLE_ON_PLATFORM` for `runtime_unavailable`; inspect `reason` to distinguish availability from other failures. Hosted errors use `NOT_AVAILABLE_ON_PLATFORM` for runtime/capability refusals, `COMPUTER_LIMIT` for capacity, `SESSION_ENDED` for `computer_not_running`, `NOT_FOUND` for `computer_not_found`, `INVALID_ARGUMENT` for build selection and `SESSION_BUSY` for child identity conflicts. Unknown reasons remain `None`; no refusal automatically retries creation.

| Platform | Instructions / validations | Commands / files / processes | PNG screenshot |
| --- | :---: | :---: | :---: |
| Web | Yes, if the backend supports web steps | — | Yes |
| iOS simulator / Android emulator | Yes | — | Yes |
| Mac computer | — | Yes | Yes |

Mac computers are available to organizations on a current paid Revyl plan. Computer admission may return `COMPUTER_LIMIT`; the SDK does not retry creation. Computer sessions have a hard lifetime from creation (two hours today); `expires_at` is the authoritative deadline. Screenshot observation retries structured startup screen-not-ready errors within a bounded window; other errors are not silently replayed.

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
- [Go SDK](https://github.com/RevylAI/verify/tree/main/go)
- [Live results from other SDKs and limitations](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/end-to-end.md)
- [Python release procedure](https://github.com/RevylAI/verify/blob/main/RELEASING.md#python)

## Troubleshooting

- **`NOT_AVAILABLE_ON_PLATFORM`:** computers do not support instruction/validation, your own model, or exact actions other than `tap`, `screen_size()`, `type_focused(text, clear=False)` and `press_key`; devices do not support commands, files, processes or recording metadata; iOS has no `back()`, Web has no `launch_app()` or `go_home()`, and iOS and Android have no `type_focused()` and no keys other than Enter and Backspace.
- **`MODEL_KEY_MISSING`:** the provider's key variable named in the message is not set. Set it, or pass `CustomModel(id, base_url, api_key=...)`.
- **`MODEL_ERROR`:** the model's endpoint refused the request or the model misbehaved. The message names the host, the HTTP status and the next step: a rejected key and the variable it came from, an unknown model, the path Verify added on a 404, a rate limit after retries, a text-only model, no tool support, a reply cut off at its output cap, or three turns without a tool call.
- **Blank initial screen:** first-frame observation is best effort. Start with an instruction; a transport-level connection does not prove rendered readiness.
- **Validation failed with successful HTTP:** use the validation verdict, not transport counters, to decide success. `soft=True` changes throwing behavior, not the verdict.
- **`ACTION_UNCERTAIN`:** an operation or cleanup outcome was not confirmed. Do not blindly retry mutations or assume a computer has been released.

## License

[Apache 2.0](https://github.com/RevylAI/verify/blob/main/LICENSE).
