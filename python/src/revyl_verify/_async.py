from __future__ import annotations

import asyncio
import functools
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from types import TracebackType
from typing import TypeVar

from ._cleanup import _close, install_signal_cleanup
from ._models import (
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    Platform,
    StepResult,
    Target,
)
from ._session import Session
from ._transport import Cancellation, Json, VerifyError

T = TypeVar("T")


class AsyncSession:
    def __init__(self, session: Session) -> None:
        self._session = session

    @property
    def id(self) -> str:
        return self._session.id

    @property
    def platform(self) -> Platform:
        return self._session.platform

    @property
    def viewer_url(self) -> str:
        return self._session.viewer_url

    @property
    def expires_at(self) -> datetime | None:
        return self._session.expires_at

    @property
    def closed(self) -> bool:
        return self._session.closed

    @property
    def steps(self) -> list[StepResult]:
        return list(self._session.steps)

    async def __aenter__(self) -> AsyncSession:
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

    async def instruction(self, text: str, *, timeout: float | None = None) -> StepResult:
        return await self._call(functools.partial(self._session.instruction, text, timeout=timeout))

    async def validation(
        self, text: str, *, timeout: float | None = None, soft: bool = False
    ) -> StepResult:
        return await self._call(
            functools.partial(self._session.validation, text, timeout=timeout, soft=soft)
        )

    async def screenshot(self, *, path: str | Path | None = None) -> bytes:
        return await self._call(functools.partial(self._session.screenshot, path=path))

    async def open(self, target: Target) -> AsyncSession:
        return await _create_session(
            lambda cancellation: self._session.open(target, _cancellation=cancellation)
        )

    async def navigate(self, url: str) -> None:
        await self._call(functools.partial(self._session.navigate, url))

    async def report(self) -> dict[str, Json]:
        return await self._call(self._session.report)

    async def recording(self) -> ComputerRecording | None:
        return await self._call(self._session.recording)

    async def exec(
        self, argv: list[str], *, stdin: bytes | str = b"", timeout: float = 30, check: bool = True
    ) -> ExecResult:
        return await self._call(
            functools.partial(self._session.exec, argv, stdin=stdin, timeout=timeout, check=check)
        )

    async def read_file(self, path: str, *, timeout: float = 30) -> bytes:
        return await self._call(functools.partial(self._session.read_file, path, timeout=timeout))

    async def write_file(self, path: str, data: bytes | str, *, timeout: float = 30) -> None:
        await self._call(functools.partial(self._session.write_file, path, data, timeout=timeout))

    async def stat(self, path: str, *, timeout: float = 30) -> FileStat:
        return await self._call(functools.partial(self._session.stat, path, timeout=timeout))

    async def processes(self, *, timeout: float = 30) -> list[ComputerProcess]:
        return await self._call(functools.partial(self._session.processes, timeout=timeout))

    async def terminate(self, handle_id: str, *, timeout: float = 30) -> None:
        await self._call(functools.partial(self._session.terminate, handle_id, timeout=timeout))

    async def close(self) -> None:
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
    log: Callable[[str], None] | None = None,
) -> AsyncSession:
    from . import open

    return await _create_session(
        lambda cancellation: open(
            target,
            backend_url=backend_url,
            app_url=app_url,
            step_timeout=step_timeout,
            log=log,
            _cancellation=cancellation,
        )
    )


async def async_attach(
    computer_id: str,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | None = None,
) -> AsyncSession:
    from . import attach

    return await _create_session(
        lambda cancellation: attach(
            computer_id,
            backend_url=backend_url,
            app_url=app_url,
            step_timeout=step_timeout,
            log=log,
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
