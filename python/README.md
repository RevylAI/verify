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

`async_open` returns an `AsyncSession`. Its async methods adapt the synchronous implementation through worker threads, rather than introducing another HTTP stack. Cancelling a method schedules best-effort session close; cancelling open closes the eventual returned session. Cancellation does not forcibly terminate an in-flight thread or undo a remote operation; do not replay an uncertain mutation. Always close explicitly or use `async with await async_open(...)`.

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

## Platforms and cleanup

### Targets and methods

Construct a frozen `Target(platform=...)`:

- **Web:** `app_id` (Revyl UUID) is required. Supply `url` for a public HTTPS site, `build_id` for a specific build, or `branch` for the selected app's latest build. `build_id` cannot be combined with `url` or `branch`. Optional `Viewport(width, height, device_scale_factor=...)` and `SignIn(path, secret, persona=...)` configure the browser and saved sign-in secret reference, not a raw credential.
- **iOS / Android:** provide exactly one of `app_id`, `build_id`, HTTPS `artifact_url` or installed-app `bundle_id`. Optional `device_model` and `os_version` select the device. Do not combine mobile app sources.
- **Mac / Linux:** only `platform` and `start_timeout` are accepted; app/browser/device fields are unavailable.

`start_timeout` defaults to 600 seconds (allowed range 10–1800). Web/mobile also accept `idle_timeout_seconds` (60–3600). `open` and `async_open` accept optional `backend_url`, `app_url`, and default `step_timeout` in seconds. Prefer matching environment variables when selecting a non-default environment.

Session properties include `id`, `platform`, `viewer_url`, `expires_at` and `closed`. Steps return `StepResult` with `passed`, `reason` and `duration_seconds`; commands return `ExecResult` with `exit_code`, `stdout` and `stderr`. Computer methods also include `stat(path)`, `processes()` and `terminate(handle_id)`, with bounded seconds-based timeouts. Errors raise `VerifyError` with a stable `code`. Async session methods have the same arguments/results and are awaited.

| Platform | Instructions / validations | Commands / files / processes | PNG screenshot |
| --- | :---: | :---: | :---: |
| Web | Yes, if the backend supports web steps | — | Yes |
| iOS simulator / Android emulator | Yes | — | Yes |
| Mac / Linux computer | — | Yes | Yes |

Mac and Linux are staging-only early access for enabled organizations and OSes, **not available in production**. Computer admission may return `COMPUTER_LIMIT`; the SDK does not retry creation. Computer sessions have a hard 60-minute lifetime from creation. Screenshot observation retries structured startup screen-not-ready errors within a bounded window; other errors are not silently replayed.

Context-manager exit calls `close()`. Device close acknowledges a stop request; computer close requires terminal state **and confirmed resource release**. Interpreter-exit cleanup is best effort and cannot replace explicit close, especially with asyncio. A failed close is not proof the resource was released; investigate it rather than starting replacement sessions blindly.

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
