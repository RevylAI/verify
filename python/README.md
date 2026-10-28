<h1 align="center">Verify for Python</h1>

<p align="center"><em>Cloud browsers, mobile devices and computers from Python.</em></p>

Verify is a thin [Revyl](https://revyl.com) SDK, not a test runner. Open a web browser, iOS simulator or Android emulator for natural-language instructions and validations, or an early-access Mac/Linux computer for commands, files, processes and screenshots.

## For coding agents

Use Python ≥3.10 and the `revyl_verify` import. The distribution is named `revyl-verify`; it is separate from the `revyl` CLI. Python 0.1.0 is prepared in this repository, **not published to PyPI or verified against live Revyl sessions**. The Go/TypeScript live results do not prove Python behavior.

Run only explicitly authorized cloud workloads. Keep API keys, signed recording URLs and session links private. Use context managers so errors still trigger cleanup; there is no runner, automatic step replay or creation retry.

## Install

Until a Python release is published, install a reviewed checkout from the repository root:

```bash
uv pip install ./python
# Or, in an activated virtual environment:
python -m pip install ./python
```

After a maintainer publishes 0.1.0, the corresponding registry command will be `uv pip install revyl-verify==0.1.0` (or `python -m pip install revyl-verify==0.1.0`). Do not treat that command as evidence the package exists today. Pillow is the only runtime dependency, for PNG blank-frame inspection; HTTP uses the standard library.

## Authenticate

Supply `REVYL_API_KEY` through a secret manager, or use the separately installed [Revyl CLI](https://github.com/RevylAI/revyl-cli#install):

```bash
revyl auth login
```

Credential precedence matches the other SDKs: a usable stored CLI login marked `local_auth_override`, then `REVYL_API_KEY`, then another usable CLI login. An expired access token can fall back to its stored API key. Never pass keys in argv, source, screenshots or logs. `REVYL_BACKEND_URL` and `REVYL_APP_URL` override the API and viewer origins; credentials must belong to the selected environment.

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

`open` returns a `Session`, which is also a context manager. `instruction` and `validation` wait for completion; a failed validation raises by default even if HTTP succeeded. Pass `soft=True` to `validation` to inspect a failed verdict without raising. Screenshots return PNG `bytes` and optionally save them to `path`. `report()` returns a JSON dictionary: for devices it is the session-details/report metadata from `/execution/device-sessions/{id}`, not a fabricated report endpoint.

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

### Linux computer (enabled staging organizations only)

Configure the approved staging API/viewer origins and matching credentials privately before running:

```python
from revyl_verify import Target, open

with open(Target(platform="linux", start_timeout=600)) as session:
    result = session.exec(["uname", "-a"], timeout=30, check=True)
    session.write_file("message.txt", b"Hello from Verify\n")
    contents = session.read_file("message.txt")
    processes = session.processes()
    session.screenshot(path="linux.png")

recording = session.recording()
```

`exec(argv, stdin=bytes_or_string, timeout=30, check=True)` preserves argument boundaries and raises on command failure by default. File and process operations are computer-only. File paths are workspace-relative, not arbitrary absolute guest paths. `recording()` returns computer recording metadata or `None`, including after close; it does not wait for or download a recording. Signed URLs in that metadata are credentials. Recording is locally unavailable on devices.

### Attach and open a hosted browser

Attach to an existing active computer with `attach(computer_id)`, or create one with `open(Target(platform="mac"))`. Attaching checks its identity, operating system and unexpired active report without creating or stopping anything on failure. A successful attach takes close ownership: exiting its context stops that computer, not merely the local handle.

```python
from revyl_verify import Target, attach

with attach("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") as computer:
    with computer.open(
        Target(
            platform="web",
            app_id="11111111-2222-4333-8444-555555555555",
            build_id="66666666-7777-4888-8999-aaaaaaaaaaaa",
        )
    ) as browser:
        browser.navigate("http://localhost:3000")
        browser.validation("The application home page is visible")
```

Use real IDs from the same authorized environment; these are placeholders. The existing Web build must point to a supported HTTPS source. After startup, `navigate(url)` sends a single deterministic navigation request and accepts HTTP or HTTPS, including the hosting computer's localhost. It rejects credentials, control characters and backslashes; it never logs the URL. It is available on ordinary and hosted Web sessions, not on mobile or computer sessions, and returns `None` after a confirmed navigation response.

`computer.open(target)` requires **both** `app_id` and `build_id` UUIDs. Hosted Web accepts `viewport`, `sign_in`, `idle_timeout_seconds` and `start_timeout`, but no `url` or `branch`; the server currently accepts external Web builds, not bundled Web artifacts. Hosted iOS/Android use the selected build and fixed simulator/emulator configuration, so `bundle_id`, `artifact_url`, `device_model`, `os_version`, `url`, `branch`, `viewport` and `sign_in` are unavailable. Mac hosts Web/iOS; Linux hosts Android and exposes Web only subject to server capability. **Linux-hosted Web is currently unavailable in the runtime.** All hosting depends on the computer's enabled server capability and capacity.

Children reuse their parent's credentials, API/viewer origins, step timeout and log callback. They return normal sessions with instruction, validation, screenshot, report and close methods. The parent's remaining lifetime bounds child startup and worker requests; report and close remain available after expiry. Closing a parent prevents new children, cancels and waits for in-flight starts, closes its children and then stops the computer; child startup failure never closes the parent. Confirmed physical parent release supersedes an earlier child-close uncertainty, which is logged safely. An ambiguous child start is cleaned up using its preallocated ID, without replaying creation. A definitive refusal does not issue a child stop.

For async code use `async with await async_attach(computer_id) as computer`, then `async with await computer.open(target) as browser` and `await browser.navigate(url)`. `async_attach` accepts the same overrides as `async_open`. Cancelling a child open cleans up only that child and leaves the parent open; cancelling attach before it succeeds does not stop the existing computer.

## Platforms and cleanup

### Targets and methods

Construct a frozen `Target(platform=...)`:

- **Web:** `app_id` (Revyl UUID) is required. Supply `url` for a public HTTPS site, `build_id` for a specific build, or `branch` for the selected app's latest build. `build_id` cannot be combined with `url` or `branch`. Optional `Viewport(width, height, device_scale_factor=...)` and `SignIn(path, secret, persona=...)` configure the browser and saved sign-in secret reference, not a raw credential.
- **iOS / Android:** provide exactly one of `app_id`, `build_id`, HTTPS `artifact_url` or installed-app `bundle_id`. Optional `device_model` and `os_version` select the device. Do not combine mobile app sources.
- **Mac / Linux:** only `platform` and `start_timeout` are accepted; app/browser/device fields are unavailable.

`start_timeout` defaults to 600 seconds (allowed range 10–1800). Web/mobile also accept `idle_timeout_seconds` (60–3600). `open`, `async_open`, `attach` and `async_attach` accept optional `backend_url`, `app_url`, and default `step_timeout` in seconds. Prefer matching environment variables when selecting a non-default environment.

Pass `log=callback` to either opening API for sanitized lifecycle progress, including the viewer link as soon as the session identity is known. The default is quiet. Async callbacks run on a worker thread, so make them thread-safe; callback exceptions do not interrupt resource cleanup. Progress never includes app URLs, command or step content, credentials, recording URLs, or raw server errors. Viewer links and session IDs are still private operational context.

Startup `VerifyError` instances retain optional typed `platform`, `session_id`, `workflow_run_id`, and `viewer_url`, plus `cleanup_status` and `cleanup_error`. These fields remain available even though opening did not return a session:

```python
from revyl_verify import Target, VerifyError, open

try:
    session = open(Target(platform="linux"), log=lambda line: None)
except VerifyError as error:
    session_id = error.session_id
    viewer_url = error.viewer_url
    cleanup_status = error.cleanup_status
    cleanup_error = error.cleanup_error
else:
    session.close()
```

Cleanup status is `acknowledged` for a validated device stop response, `confirmed` for terminal computer state plus physical release, `unconfirmed` when cleanup failed or no usable mobile identity was returned, and `not_required` after a definite create refusal. `not_attempted` applies before startup ownership exists. An unknown mobile ID is `None`, never invented. Web/computer caller-generated IDs remain available after an uncertain create; a mismatched web acknowledgment never authorizes stopping the other ID. Startup cleanup uses a fresh bounded deadline, preserves the original failure, and attaches a separate cleanup error. Do not retry creation to recover an uncertain outcome; inspect the known session privately. A device stop acknowledgment does not prove physical release.

Session properties include `id`, `platform`, `viewer_url`, `expires_at` and `closed`. Steps return `StepResult` with `passed`, `reason` and `duration_seconds`; commands return `ExecResult` with `exit_code`, `stdout` and `stderr`. Computer methods also include `stat(path)`, `processes()` and `terminate(handle_id)`, with bounded seconds-based timeouts. Errors raise `VerifyError` with a stable `code`. Async session methods have the same arguments/results and are awaited.

`VerifyError.reason` is an optional exported `RefusalReason` literal containing only a known safe server code; `http_status` is the response status when available. Raw server messages and payloads are not exposed through these fields. Ordinary Web startup `409 web_runtime_unavailable` keeps `code="API_ERROR"`, computer admission keeps `COMPUTER_LIMIT` for `computer_limit` and `NOT_AVAILABLE_ON_PLATFORM` for `runtime_unavailable`; inspect `reason` to distinguish availability from other failures. Hosted errors use `NOT_AVAILABLE_ON_PLATFORM` for runtime/capability refusals, `COMPUTER_LIMIT` for capacity, `SESSION_ENDED` for `computer_not_running`, `NOT_FOUND` for `computer_not_found`, `INVALID_ARGUMENT` for build selection and `SESSION_BUSY` for child identity conflicts. Unknown reasons remain `None`; no refusal automatically retries creation.

| Platform | Instructions / validations | Commands / files / processes | PNG screenshot |
| --- | :---: | :---: | :---: |
| Web | Yes, if the backend supports web steps | — | Yes |
| iOS simulator / Android emulator | Yes | — | Yes |
| Mac / Linux computer | — | Yes | Yes |

Mac and Linux are staging-only early access for enabled organizations and OSes, **not available in production**. Computer admission may return `COMPUTER_LIMIT`; the SDK does not retry creation. Computer sessions have a hard 60-minute lifetime from creation. Screenshot observation retries structured startup screen-not-ready errors within a bounded window; other errors are not silently replayed.

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
- [Go SDK](https://github.com/RevylAI/verify/tree/main/go)
- [Live results from other SDKs and limitations](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/end-to-end.md)
- [Python release procedure](https://github.com/RevylAI/verify/blob/main/RELEASING.md#python-distribution-release-pyv010)

## Troubleshooting

- **`NOT_AVAILABLE_ON_PLATFORM`:** computers do not support instruction/validation; devices do not support commands, files, processes or recording metadata.
- **Blank initial screen:** first-frame observation is best effort. Start with an instruction; a transport-level connection does not prove rendered readiness.
- **Validation failed with successful HTTP:** use the validation verdict, not transport counters, to decide success. `soft=True` changes throwing behavior, not the verdict.
- **`ACTION_UNCERTAIN`:** an operation or cleanup outcome was not confirmed. Do not blindly retry mutations or assume a computer has been released.

## License

[Apache 2.0](https://github.com/RevylAI/verify/blob/main/LICENSE).
