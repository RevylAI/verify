from __future__ import annotations

from collections.abc import Callable

from ._async import AsyncSession, async_attach, async_open
from ._cleanup import install_signal_cleanup
from ._computer import ComputerSession
from ._models import (
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    Platform,
    SignIn,
    StepResult,
    Target,
    Viewport,
)
from ._session import Session
from ._transport import Cancellation, CleanupStatus, RefusalReason, VerifyError, origin, seconds

__version__ = "0.1.0"
__all__ = [
    "AsyncSession",
    "ComputerProcess",
    "ComputerRecording",
    "ComputerSession",
    "CleanupStatus",
    "ExecResult",
    "FileStat",
    "Platform",
    "RefusalReason",
    "Session",
    "SignIn",
    "StepResult",
    "Target",
    "VerifyError",
    "Viewport",
    "attach",
    "async_attach",
    "async_open",
    "open",
]


def open(
    target: Target,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | None = None,
    _cancellation: Cancellation | None = None,
) -> Session:
    from ._transport import Client

    if not isinstance(target, Target):
        raise VerifyError("INVALID_ARGUMENT", "open() requires a Target value.")
    target.validate()
    install_signal_cleanup()
    seconds(step_timeout, 1, 3600, "step_timeout")
    if log is not None and not callable(log):
        raise VerifyError("INVALID_ARGUMENT", "log must be a callable or None.")
    client = Client(backend_url)
    viewer = origin(app_url or "https://app.revyl.ai", app=True)
    session = (ComputerSession if target.platform in ("mac", "linux") else Session).start(
        client, viewer, target, step_timeout, log, _cancellation
    )
    return session


def attach(
    computer_id: str,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | None = None,
    stop_on_close: bool = True,
    _cancellation: Cancellation | None = None,
) -> ComputerSession:
    from ._models import UUID_PATTERN
    from ._transport import Client

    if not isinstance(computer_id, str) or not UUID_PATTERN.fullmatch(computer_id):
        raise VerifyError("INVALID_ARGUMENT", "attach() requires a computer UUID.")
    if not isinstance(stop_on_close, bool):
        raise VerifyError("INVALID_ARGUMENT", "stop_on_close must be a boolean.")
    seconds(step_timeout, 1, 3600, "step_timeout")
    if log is not None and not callable(log):
        raise VerifyError("INVALID_ARGUMENT", "log must be a callable or None.")
    install_signal_cleanup()
    client = Client(backend_url)
    viewer = origin(app_url or "https://app.revyl.ai", app=True)
    return ComputerSession.attach(
        client, viewer, computer_id, step_timeout, log, _cancellation, stop_on_close=stop_on_close
    )
