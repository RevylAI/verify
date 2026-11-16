from __future__ import annotations

import asyncio
import functools
import threading
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import Literal, TypeVar

from ._agent import Key, KeyModifier, LocalAgent, Location, ModelOption, SwipeDirection
from ._cleanup import _close, install_signal_cleanup
from ._models import (
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    Platform,
    Point,
    ScreenSize,
    StepResult,
    Target,
)
from ._session import Session
from ._transport import Cancellation, Json, VerifyError

T = TypeVar("T")


class AsyncSession:
    """A session from async_open() or async_attach(), with the same methods as Session and
    ComputerSession, awaited. Cancelling a method closes the session in the background.
    """

    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def id(self) -> str:
        """Revyl's session id."""
        return self._session.id

    @property
    def platform(self) -> Platform:
        """The session's platform: web, ios, android, mac or linux."""
        return self._session.platform

    @property
    def viewer_url(self) -> str:
        """The live view of the session in Revyl, and its recording and report once it ends."""
        return self._session.viewer_url

    @property
    def expires_at(self) -> datetime | None:
        """When the session's computer expires, for a computer or a session hosted on one; otherwise
        None.
        """
        return self._session.expires_at

    @property
    def closed(self) -> bool:
        """Whether close() has run."""
        return self._session.closed

    @property
    def steps(self) -> list[StepResult]:
        """Every instruction and validation run on this session, in order."""
        return list(self._session.steps)

    async def __aenter__(self) -> AsyncSession:
        """Returns the session; leaving the async with block awaits close()."""
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
            if isinstance(exc, VerifyError):
                self._session._attach_failure(exc)
            raise exc.with_traceback(traceback) from cleanup_error

    async def _call(self, call: Callable[[], T]) -> T:
        task = asyncio.create_task(asyncio.to_thread(call))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            threading.Thread(target=_close, args=(self._session,), daemon=True).start()
            task.add_done_callback(_consume)
            raise

    async def instruction(
        self,
        text: str,
        *,
        timeout: float | None = None,
        model: ModelOption | None = None,
        agent: LocalAgent | None = None,
    ) -> StepResult:
        """Asks Revyl's agent, or your model when one is set, to do something on the app, and waits
        for the result. A failed step raises INSTRUCTION_FAILED with the StepResult in
        error.result; the session stays open. Browsers and devices only.
        """
        return await self._call(
            functools.partial(
                self._session.instruction, text, timeout=timeout, model=model, agent=agent
            )
        )

    async def validation(
        self,
        text: str,
        *,
        timeout: float | None = None,
        soft: bool = False,
        model: ModelOption | None = None,
        agent: LocalAgent | None = None,
    ) -> StepResult:
        """Asks Revyl's agent, or your model when one is set, whether something holds on screen. A
        failed verdict raises VALIDATION_FAILED with the StepResult in error.result, or returns
        it when soft is True. Browsers and devices only.
        """
        return await self._call(
            functools.partial(
                self._session.validation, text, timeout=timeout, soft=soft, model=model, agent=agent
            )
        )

    async def tap(self, at: Location) -> Point:
        """Taps a point in screenshot pixels, or an element Revyl locates from a description.
        Returns the point tapped, in screenshot pixels.
        """
        return await self._call(functools.partial(self._session.tap, at))

    async def type(self, at: Location, text: str, *, clear: bool = True) -> Point:
        """Taps a text field and types into it, clearing it first unless clear is False. Returns the
        point tapped. On Web, when no text field takes focus at the point, clicks it and types
        into the focused field, and raises ACTION_FAILED when none has focus. Browsers and
        devices only.
        """
        return await self._call(functools.partial(self._session.type, at, text, clear=clear))

    async def type_focused(self, text: str, *, clear: bool = True) -> None:
        """Types into the field that already has focus, without tapping, replacing its content
        unless clear is False. Web and Mac computers, where clear must be False; on iOS and
        Android, use type(location, text).
        """
        await self._call(functools.partial(self._session.type_focused, text, clear=clear))

    async def double_tap(self, at: Location) -> Point:
        """Double-taps a point in screenshot pixels, or an element Revyl locates from a description.
        Returns the point, in screenshot pixels. Browsers and devices only.
        """
        return await self._call(functools.partial(self._session.double_tap, at))

    async def long_press(self, at: Location, *, duration: float | None = None) -> Point:
        """Presses and holds a point or element for duration seconds (0.001 to 5), or Revyl's
        default when left out. Returns the point, in screenshot pixels. Browsers and devices
        only.
        """
        return await self._call(functools.partial(self._session.long_press, at, duration=duration))

    async def swipe(self, direction: SwipeDirection, *, from_: Location | None = None) -> None:
        """Swipes from a point or the screen's center. 'up' moves the finger up, which scrolls
        content down. Browsers and devices only.
        """
        await self._call(functools.partial(self._session.swipe, direction, from_=from_))

    async def drag(self, start: Location, end: Location) -> None:
        """Presses at one point or element, moves to another and releases. Browsers and devices
        only.
        """
        await self._call(functools.partial(self._session.drag, start, end))

    async def press_key(self, key: Key | str, *, modifiers: Sequence[KeyModifier] = ()) -> None:
        """Presses a key on the focused element. iOS and Android take 'enter' and 'backspace'; Web
        and Mac computers also take the other Key names, and modifiers, with which a lowercase
        letter or digit also works. On a Mac computer 'meta' is Command.
        """
        await self._call(functools.partial(self._session.press_key, key, modifiers=modifiers))

    async def back(self) -> None:
        """Goes back: browser history on Web, the back button on Android. On iOS it raises
        NOT_AVAILABLE_ON_PLATFORM.
        """
        await self._call(self._session.back)

    async def go_home(self) -> None:
        """Goes to the home screen on iOS and Android. Not on Web."""
        await self._call(self._session.go_home)

    async def open_url(self, url: str) -> None:
        """Opens a URL or deep link on a device, or loads an http(s) URL in a browser."""
        await self._call(functools.partial(self._session.open_url, url))

    async def launch_app(self, bundle_id: str) -> None:
        """Launches an installed app by bundle ID or package name. Devices only."""
        await self._call(functools.partial(self._session.launch_app, bundle_id))

    async def locate(self, target: str) -> Point:
        """Asks Revyl's grounding model where an element is on the current screen, in screenshot
        pixels. Browsers and devices only.
        """
        return await self._call(functools.partial(self._session.locate, target))

    async def screen_size(self) -> ScreenSize:
        """The screenshot's size in pixels, the space every coordinate uses."""
        return await self._call(self._session.screen_size)

    async def screenshot(self, *, path: str | Path | None = None) -> bytes:
        """A PNG of the screen right now, also written to path when given, creating its folder."""
        return await self._call(functools.partial(self._session.screenshot, path=path))

    async def open(self, target: Target) -> AsyncSession:
        """Opens a hosted browser or device session on this computer from an exact app_id and
        build_id, as an AsyncSession. Computers only.
        """
        return await _create_session(
            lambda cancellation: self._session.open(target, _cancellation=cancellation)
        )

    async def navigate(self, url: str) -> None:
        """Loads an http(s) URL in the browser. Web only."""
        await self._call(functools.partial(self._session.navigate, url))

    async def report(self) -> dict[str, Json]:
        """The session's metadata from Revyl. After close(), waits up to 5 seconds for a final
        status: completed, failed, cancelled or timeout.
        """
        return await self._call(self._session.report)

    async def recording(self) -> ComputerRecording | None:
        """The computer's recording once it has stopped and released its resources, or None when it
        has none; earlier it raises SESSION_BUSY. Computers only.
        """
        return await self._call(self._session.recording)

    async def exec(
        self, argv: list[str], *, stdin: bytes | str = b"", timeout: float = 30, check: bool = True
    ) -> ExecResult:
        """Runs a program with its arguments, not a shell line, for up to timeout seconds. Raises
        COMMAND_FAILED on a non-zero exit unless check is False, which returns the ExecResult
        instead. Computers only.
        """
        return await self._call(
            functools.partial(self._session.exec, argv, stdin=stdin, timeout=timeout, check=check)
        )

    async def read_file(self, path: str, *, timeout: float = 30) -> bytes:
        """Up to the first 1 MiB of a file, by a path relative to the computer's workspace.
        Computers only.
        """
        return await self._call(functools.partial(self._session.read_file, path, timeout=timeout))

    async def write_file(self, path: str, data: bytes | str, *, timeout: float = 30) -> None:
        """Writes up to 64 KiB to a file, by a path relative to the computer's workspace. Computers
        only.
        """
        await self._call(functools.partial(self._session.write_file, path, data, timeout=timeout))

    async def stat(self, path: str, *, timeout: float = 30) -> FileStat:
        """Whether a path is a file or a directory, and its size. Computers only."""
        return await self._call(functools.partial(self._session.stat, path, timeout=timeout))

    async def processes(self, *, timeout: float = 30) -> list[ComputerProcess]:
        """The processes commands on this computer started. Computers only."""
        return await self._call(functools.partial(self._session.processes, timeout=timeout))

    async def terminate(self, handle_id: str, *, timeout: float = 30) -> None:
        """Stops a process from processes(). Computers only."""
        await self._call(functools.partial(self._session.terminate, handle_id, timeout=timeout))

    async def close(self) -> None:
        """Stops the session on Revyl. Safe to call more than once; later calls share the first
        outcome.
        """
        await self._call(self._session.close)


def _consume(task: asyncio.Task[object]) -> None:
    if not task.cancelled():
        task.exception()


async def async_open(
    target: Target,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | Literal[False] | None = None,
    model: ModelOption | None = None,
    agent: LocalAgent | None = None,
) -> AsyncSession:
    """The asyncio form of open(), returning an AsyncSession. Cancelling it interrupts startup and
    closes the session as soon as Revyl names it.
    """
    from . import open

    return await _create_session(
        lambda cancellation: open(
            target,
            backend_url=backend_url,
            app_url=app_url,
            step_timeout=step_timeout,
            log=log,
            model=model,
            agent=agent,
            _cancellation=cancellation,
        )
    )


async def async_attach(
    computer_id: str,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | Literal[False] | None = None,
    stop_on_close: bool = True,
) -> AsyncSession:
    """The asyncio form of attach(), returning an AsyncSession."""
    from . import attach

    return await _create_session(
        lambda cancellation: attach(
            computer_id,
            backend_url=backend_url,
            app_url=app_url,
            step_timeout=step_timeout,
            log=log,
            stop_on_close=stop_on_close,
            _cancellation=cancellation,
        )
    )


async def _create_session(create: Callable[[Cancellation], Session]) -> AsyncSession:
    install_signal_cleanup()
    abandoned = threading.Event()
    cancellation = Cancellation()
    lock = threading.Lock()
    created: list[Session] = []

    def start() -> Session:
        session = create(cancellation)
        with lock:
            if not abandoned.is_set():
                created.append(session)
                return session
        _close(session)
        return session

    task = asyncio.create_task(asyncio.to_thread(start))
    try:
        session = await asyncio.shield(task)
    except asyncio.CancelledError:
        cancellation.cancel()
        with lock:
            abandoned.set()
            if created:
                threading.Thread(target=_close, args=(created[0],), daemon=True).start()
        task.add_done_callback(_consume)
        raise
    return AsyncSession(session)
