from __future__ import annotations

import asyncio
import functools
import http.client
import math
import os
import re
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import TracebackType
from typing import Literal

from ._async import _consume
from ._cleanup import _close, install_signal_cleanup, track, untrack
from ._transport import Cancellation, VerifyError
from ._tunnel import (
    QUICK_TUNNEL_URL,
    Abort,
    QuickTunnel,
    describe_exit,
    network_error,
    start_quick_tunnel,
    stop_process_group,
)

ExposeProvider = Literal["quick-tunnel"]

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
START_GROUP_GRACE = 10
COMMAND_GRACE = 5
READY_POLL = 1
READY_REQUEST_TIMEOUT = 5
OUTPUT_TAIL_LINES = 40
TUNNEL_NOT_ROUTED = frozenset({502, 530})


@dataclass(frozen=True)
class _Exposed:
    name: str
    port: int
    ready_path: str | None


@dataclass(frozen=True)
class _Settings:
    start: str | None
    stop: str | None
    seed: str | None
    expose: tuple[_Exposed, ...]
    cwd: str | None
    env: dict[str, str]
    ready_timeout: float
    seed_timeout: float
    stop_timeout: float
    show_urls: bool
    log: Callable[[str], None] | None


class _Command:
    def __init__(
        self, label: str, command: str, env: Mapping[str, str], environment: Environment
    ) -> None:
        self.tail: deque[str] = deque(maxlen=OUTPUT_TAIL_LINES)
        self._label = label
        self._environment = environment
        try:
            self.process = subprocess.Popen(
                command,
                shell=True,
                start_new_session=True,
                cwd=environment._settings.cwd,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
        except OSError as error:
            raise VerifyError(
                "ENVIRONMENT_START_FAILED", f"Could not run the {label} command: {error}"
            ) from error
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        stream = self.process.stdout
        assert stream is not None
        with stream:
            for raw in stream:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not self._environment._settings.show_urls:
                    line = QUICK_TUNNEL_URL.sub("<tunnel url>", line)
                self.tail.append(line)
                self._environment._log(f"{self._label}: {line}")

    def output(self) -> str:
        self._reader.join(1)
        return "\n".join(self.tail)

    def finish(self, timeout: float, abort: Abort | None = None) -> int | Literal["timeout"]:
        """Waits for the command, stopping its process group when it overruns or is interrupted."""
        end = time.monotonic() + timeout
        try:
            while True:
                code = self.process.poll()
                if code is not None:
                    self._reader.join(1)
                    return code if code >= 0 else 128 - code
                if abort is not None and abort.event.is_set():
                    raise abort.reason
                if time.monotonic() >= end:
                    stop_process_group(self.process, COMMAND_GRACE, "command")
                    return "timeout"
                time.sleep(0.1)
        except BaseException:
            stop_process_group(self.process, COMMAND_GRACE, "command")
            raise


class Environment:
    """A running stack with a public URL per exposed port.

    Close it, or leave its `with` block, after the run that uses the URLs has finished.
    """

    def __init__(self, settings: _Settings) -> None:
        self._settings = settings
        self._urls: dict[str, str] = {}
        self._tunnels: dict[str, QuickTunnel] = {}
        self._workers: list[threading.Thread] = []
        self._started: _Command | None = None
        self._abort = Abort()
        self._lock = threading.Lock()
        self._closing = False
        self._closed = False
        self._close_error: VerifyError | None = None
        self._close_lock = threading.Lock()
        self._close_budget = settings.stop_timeout + COMMAND_GRACE + START_GROUP_GRACE + 15

    @property
    def urls(self) -> dict[str, str]:
        """The public URL of each exposed name."""
        return dict(self._urls)

    @property
    def variables(self) -> dict[str, str]:
        """The same URLs as plain values, ready to pass to a Revyl run as environment variables."""
        return dict(self._urls)

    @property
    def closed(self) -> bool:
        return self._closed

    def __enter__(self) -> Environment:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            self.close()
        except BaseException as cleanup_error:
            if exc is None:
                raise
            raise exc.with_traceback(traceback) from cleanup_error

    def close(self) -> None:
        """Removes the public URLs, runs stop, and stops the start command's process group.

        Raises ``CLEANUP_FAILED`` when a step fails, after trying every step. Safe to call more
        than once; later calls raise the first call's failure.
        """
        with self._close_lock:
            if self._closed:
                if self._close_error:
                    raise self._close_error
                return
            self._closed = True
            try:
                self._tear_down()
            except VerifyError as error:
                self._close_error = error
                raise
            except BaseException:
                self._close_error = VerifyError(
                    "CLEANUP_FAILED",
                    "Environment cleanup was interrupted. Check the runner for leftover "
                    "processes before reusing it.",
                )
                raise

    def _log(self, line: str) -> None:
        if self._settings.log:
            try:
                self._settings.log(line)
            except Exception:
                pass

    def _register(self, name: str, tunnel: QuickTunnel) -> None:
        with self._lock:
            if not self._closing:
                self._tunnels[name] = tunnel
                return
        try:
            tunnel.close()
        except Exception:
            pass
        raise self._abort.reason

    def _spawn(self, label: str, command: str) -> _Command:
        with self._lock:
            self._abort.check()
            spawned = _Command(label, command, {**self._settings.env, **self._urls}, self)
            if label == "start":
                self._started = spawned
            return spawned

    def _set_up(self) -> None:
        settings, abort = self._settings, self._abort
        abort.check()
        errors: dict[str, BaseException] = {}

        def expose(entry: _Exposed) -> None:
            try:
                start_quick_tunnel(
                    entry.port,
                    abort,
                    self._log,
                    functools.partial(self._register, entry.name),
                )
            except BaseException as error:
                errors[entry.name] = error

        self._workers = [
            threading.Thread(target=expose, args=(entry,), daemon=True) for entry in settings.expose
        ]
        for worker in self._workers:
            worker.start()
        for worker in self._workers:
            worker.join()
        abort.check()
        for entry in settings.expose:
            if entry.name in errors:
                raise errors[entry.name]
        for entry in settings.expose:
            url = self._tunnels[entry.name].url
            self._urls[entry.name] = url
            if os.environ.get("GITHUB_ACTIONS") == "true" and not settings.show_urls:
                sys.stdout.write(f"::add-mask::{url}\n")
                sys.stdout.flush()
            self._log(
                f"Exposed port {entry.port} as {entry.name}={url}"
                if settings.show_urls
                else f"Exposed port {entry.port} as {entry.name} through a quick tunnel. "
                "The URL is hidden; pass show_urls=True to print it."
            )
        if settings.start:
            self._spawn("start", settings.start)
        self._wait_until_ready()
        self._log(f"Environment ready: {', '.join(entry.name for entry in settings.expose)}.")
        if settings.seed:
            seed = self._spawn("seed", settings.seed)
            outcome = seed.finish(settings.seed_timeout, abort)
            if outcome != 0:
                raise VerifyError(
                    "ENVIRONMENT_START_FAILED",
                    f"The seed command {_describe_outcome(outcome, settings.seed_timeout)}. "
                    f"Its last output:\n{seed.output()}",
                )

    def _wait_until_ready(self) -> None:
        settings, abort = self._settings, self._abort
        deadline = time.monotonic() + settings.ready_timeout
        local = {entry.name: False for entry in settings.expose}
        last: dict[str, int | str] = {entry.name: "no response" for entry in settings.expose}
        pending = list(settings.expose)
        while True:
            for entry in list(pending):
                abort.check()
                self._check_start(entry.name)
                tunnel = self._tunnels[entry.name]
                if not tunnel.running:
                    raise VerifyError(
                        "TUNNEL_FAILED",
                        f"The quick tunnel for {entry.name} exited. cloudflared's last output:\n"
                        f"{tunnel.diagnostics()}",
                    )
                if not local[entry.name]:
                    status = (
                        _probe_local_http(entry.port, entry.ready_path)
                        if entry.ready_path
                        else _probe_local_port(entry.port)
                    )
                    local[entry.name] = _is_ok(status) if entry.ready_path else status == "open"
                    last[entry.name] = "no response" if local[entry.name] else status
                if local[entry.name]:
                    status = tunnel.probe(entry.ready_path or "/")
                    last[entry.name] = status
                    if isinstance(status, int) and (
                        _is_ok(status) if entry.ready_path else status not in TUNNEL_NOT_ROUTED
                    ):
                        pending.remove(entry)
                        continue
                if time.monotonic() >= deadline:
                    where = (
                        "through its public URL"
                        if local[entry.name]
                        else f"on localhost:{entry.port}"
                    )
                    answer = last[entry.name]
                    raise VerifyError(
                        "ENVIRONMENT_NOT_READY",
                        f"{entry.name} was not ready {where} after "
                        f"{round(settings.ready_timeout)} s: "
                        f"{f'GET {entry.ready_path}' if entry.ready_path else 'the port'} last "
                        f"answered {f'HTTP {answer}' if isinstance(answer, int) else answer}.",
                    )
            if not pending:
                return
            abort.sleep(READY_POLL)

    def _check_start(self, name: str) -> None:
        started = self._started
        code = started.process.poll() if started else None
        if started is None or code is None or code == 0:
            return
        how = f"exited with code {code}" if code > 0 else f"was killed by {describe_exit(code)}"
        raise VerifyError(
            "ENVIRONMENT_START_FAILED",
            f"The start command {how} before {name} was ready. "
            f"Its last output:\n{started.output()}",
        )

    def _tear_down(self) -> None:
        settings = self._settings
        with self._lock:
            self._closing = True
            self._abort.abort(
                VerifyError("ENVIRONMENT_START_FAILED", "The environment was closed during setup.")
            )
        for worker in self._workers:
            worker.join()
        with self._lock:
            tunnels = list(self._tunnels.items())
        failures: list[str] = []
        tunnel_errors: dict[str, BaseException] = {}

        def close_tunnel(name: str, tunnel: QuickTunnel) -> None:
            try:
                tunnel.close()
            except Exception as error:
                tunnel_errors[name] = error

        closing = [
            threading.Thread(target=close_tunnel, args=item, daemon=True) for item in tunnels
        ]
        for thread in closing:
            thread.start()
        for thread in closing:
            thread.join()
        for name, _ in tunnels:
            if name in tunnel_errors:
                failures.append(f"the quick tunnel for {name}: {_message(tunnel_errors[name])}")
        if settings.stop and (self._started or not settings.start):
            try:
                stop = _Command("stop", settings.stop, {**settings.env, **self._urls}, self)
                outcome = stop.finish(settings.stop_timeout)
                if outcome != 0:
                    failures.append(
                        f"the stop command {_describe_outcome(outcome, settings.stop_timeout)}"
                    )
            except Exception as error:
                failures.append(f"the stop command: {_message(error)}")
        if self._started:
            try:
                stop_process_group(self._started.process, START_GROUP_GRACE, "the start command")
            except Exception as error:
                failures.append(_message(error))
        untrack(self)
        if failures:
            raise VerifyError(
                "CLEANUP_FAILED",
                f"Environment cleanup failed: {'; '.join(failures)}. Check the runner for leftover "
                "processes before reusing it.",
            )
        self._log("Environment closed.")


class AsyncEnvironment:
    """An `Environment` for asyncio code. Close it, or leave its `async with` block, when done."""

    def __init__(self, environment: Environment) -> None:
        self._environment = environment

    @property
    def urls(self) -> dict[str, str]:
        return self._environment.urls

    @property
    def variables(self) -> dict[str, str]:
        return self._environment.variables

    @property
    def closed(self) -> bool:
        return self._environment.closed

    async def __aenter__(self) -> AsyncEnvironment:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            await self.close()
        except BaseException as cleanup_error:
            if exc is None:
                raise
            raise exc.with_traceback(traceback) from cleanup_error

    async def close(self) -> None:
        task = asyncio.create_task(asyncio.to_thread(self._environment.close))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            task.add_done_callback(_consume)
            raise


def environment(
    *,
    expose: Mapping[str, int],
    start: str | None = None,
    stop: str | None = None,
    seed: str | None = None,
    ready: Mapping[str, str] | None = None,
    provider: ExposeProvider = "quick-tunnel",
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str | None] | None = None,
    ready_timeout: float = 300,
    seed_timeout: float = 300,
    stop_timeout: float = 120,
    show_urls: bool = False,
    log: Callable[[str], None] | Literal[False] | None = None,
    _cancellation: Cancellation | None = None,
) -> Environment:
    """Starts a stack on this machine and gives each exposed port a public URL.

    A Revyl run in the cloud can then reach the stack. Use it as a context manager around the run,
    so the URLs stay up until the run has settled::

        with environment(start="docker compose up -d", stop="docker compose down",
                         expose={"API_URL": 8080}, ready={"API_URL": "/health"}) as env:
            ...  # pass env.variables to the run

    Each exposed port gets a Cloudflare quick tunnel before ``start`` runs, so ``start``, ``seed``,
    ``stop`` and the run see the URLs as environment variables named by the ``expose`` keys.
    ``start`` runs through ``sh -c`` in its own process group and may keep running or exit 0 once
    it has started things in the background. Each name waits for its ``ready`` path to answer 2xx
    or 3xx on localhost and through its public URL; a name without a path waits for its port to
    accept connections and for its URL to reach it. ``seed`` runs once everything is ready.

    ``env`` adds variables to start, stop and seed; a ``None`` value removes an inherited one.
    Timeouts are seconds. URLs are hidden in logs (and masked on GitHub Actions) unless
    ``show_urls`` is true. Progress and the commands' output go to stderr by default; pass a
    callable to receive each line instead, or ``False`` to turn them off.

    Leaving the ``with`` block, ``close()``, a setup error, Ctrl+C, SIGTERM (when the program has
    no handler of its own) and interpreter exit tear down the tunnels, run ``stop`` and stop the
    start command's process group, with every step bounded. Raises ``VerifyError`` with
    ``ENVIRONMENT_START_FAILED``, ``ENVIRONMENT_NOT_READY``, ``TUNNEL_FAILED``,
    ``TUNNEL_UNAVAILABLE`` or ``CLEANUP_FAILED``. Runs on macOS and Linux.
    """
    settings = _validate(
        expose=expose,
        start=start,
        stop=stop,
        seed=seed,
        ready=ready,
        provider=provider,
        cwd=cwd,
        env=env,
        ready_timeout=ready_timeout,
        seed_timeout=seed_timeout,
        stop_timeout=stop_timeout,
        show_urls=show_urls,
        log=log,
    )
    install_signal_cleanup()
    running = Environment(settings)
    track(running, running._close_budget)

    def abort_setup() -> None:
        running._abort.abort(
            VerifyError("ENVIRONMENT_START_FAILED", "Environment setup was aborted.")
        )

    if _cancellation is not None:
        _cancellation.add(abort_setup)
    try:
        running._set_up()
    except BaseException as error:
        try:
            running.close()
        except VerifyError as cleanup_error:
            running._log(cleanup_error.message)
            if isinstance(error, VerifyError):
                error.cleanup_error = cleanup_error
        except BaseException:
            pass
        raise
    finally:
        if _cancellation is not None:
            _cancellation.remove(abort_setup)
    return running


async def async_environment(
    *,
    expose: Mapping[str, int],
    start: str | None = None,
    stop: str | None = None,
    seed: str | None = None,
    ready: Mapping[str, str] | None = None,
    provider: ExposeProvider = "quick-tunnel",
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str | None] | None = None,
    ready_timeout: float = 300,
    seed_timeout: float = 300,
    stop_timeout: float = 120,
    show_urls: bool = False,
    log: Callable[[str], None] | Literal[False] | None = None,
) -> AsyncEnvironment:
    """The asyncio form of `environment()`: ``async with await async_environment(...) as env``.

    Setup runs on a worker thread. Cancelling it aborts setup and tears down what was started.
    """
    install_signal_cleanup()
    cancellation = Cancellation()
    task = asyncio.create_task(
        asyncio.to_thread(
            functools.partial(
                environment,
                expose=expose,
                start=start,
                stop=stop,
                seed=seed,
                ready=ready,
                provider=provider,
                cwd=cwd,
                env=env,
                ready_timeout=ready_timeout,
                seed_timeout=seed_timeout,
                stop_timeout=stop_timeout,
                show_urls=show_urls,
                log=log,
                _cancellation=cancellation,
            )
        )
    )
    try:
        created = await asyncio.shield(task)
    except asyncio.CancelledError:
        cancellation.cancel()
        task.add_done_callback(_close_abandoned)
        raise
    return AsyncEnvironment(created)


def _close_abandoned(task: asyncio.Task[Environment]) -> None:
    if task.cancelled() or task.exception() is not None:
        return
    threading.Thread(target=_close, args=(task.result(),), daemon=True).start()


def _validate(
    *,
    expose: Mapping[str, int],
    start: str | None,
    stop: str | None,
    seed: str | None,
    ready: Mapping[str, str] | None,
    provider: str,
    cwd: str | os.PathLike[str] | None,
    env: Mapping[str, str | None] | None,
    ready_timeout: float,
    seed_timeout: float,
    stop_timeout: float,
    show_urls: bool,
    log: Callable[[str], None] | Literal[False] | None,
) -> _Settings:
    def bad(message: str) -> VerifyError:
        return VerifyError("INVALID_ARGUMENT", f"environment(): {message}")

    if os.name == "nt":
        raise VerifyError("INVALID_ARGUMENT", "environment() runs on macOS and Linux runners.")
    for key, command in (("start", start), ("stop", stop), ("seed", seed)):
        if command is not None and (not isinstance(command, str) or not command.strip()):
            raise bad(f"{key} must be a non-empty shell command.")
    if not isinstance(expose, Mapping) or not expose:
        raise bad("expose must name at least one port, as {NAME: port}.")
    ready = ready or {}
    if not isinstance(ready, Mapping):
        raise bad("ready must map exposed names to paths.")
    for name in ready:
        if name not in expose:
            raise bad(f"ready.{name} has no matching expose.{name}.")
    if provider != "quick-tunnel":
        raise bad("provider must be 'quick-tunnel'.")
    exposed: list[_Exposed] = []
    for name, port in expose.items():
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise bad(f"expose name {name!r} must be a valid environment variable name.")
        if type(port) is not int or not 1 <= port <= 65535:
            raise bad(f"expose.{name} must be a port from 1 to 65535.")
        path = ready.get(name)
        if path is not None and (not isinstance(path, str) or not path.startswith("/")):
            raise bad(f"ready.{name} must be a path starting with /.")
        exposed.append(_Exposed(name, port, path or None))
    variables = dict(os.environ)
    for key, value in (env or {}).items():
        if value is None:
            variables.pop(key, None)
        elif isinstance(key, str) and isinstance(value, str):
            variables[key] = value
        else:
            raise bad("env must map variable names to strings or None.")
    for option, timeout in (
        ("ready_timeout", ready_timeout),
        ("seed_timeout", seed_timeout),
        ("stop_timeout", stop_timeout),
    ):
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or timeout <= 0
        ):
            raise bad(f"{option} must be a positive number of seconds.")
    if log is not None and log is not False and not callable(log):
        raise bad("log must be a callable, False, or None.")
    return _Settings(
        start=start or None,
        stop=stop or None,
        seed=seed or None,
        expose=tuple(exposed),
        cwd=os.fspath(cwd) if cwd else None,
        env=variables,
        ready_timeout=ready_timeout,
        seed_timeout=seed_timeout,
        stop_timeout=stop_timeout,
        show_urls=show_urls is True,
        log=None if log is False else log or _stderr,
    )


def _stderr(line: str) -> None:
    sys.stderr.write(f"[verify] {line}\n")
    sys.stderr.flush()


def _describe_outcome(outcome: int | Literal["timeout"], timeout: float) -> str:
    if outcome == "timeout":
        return f"ran longer than {round(timeout)} s and was stopped"
    return f"exited with code {outcome}"


def _message(error: BaseException) -> str:
    return error.message if isinstance(error, VerifyError) else str(error)


def _is_ok(status: int | str) -> bool:
    return isinstance(status, int) and 200 <= status < 400


def _probe_local_http(port: int, path: str) -> int | str:
    connection = http.client.HTTPConnection("localhost", port, timeout=READY_REQUEST_TIMEOUT)
    try:
        connection.request("GET", path)
        return connection.getresponse().status
    except (OSError, http.client.HTTPException) as error:
        return network_error(error)
    finally:
        connection.close()


def _probe_local_port(port: int) -> str:
    try:
        socket.create_connection(("localhost", port), timeout=READY_REQUEST_TIMEOUT).close()
    except OSError as error:
        return network_error(error)
    return "open"
