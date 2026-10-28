from __future__ import annotations

import os

from ._async import AsyncSession, async_open
from ._cleanup import track
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
from ._transport import VerifyError, origin, seconds

__version__ = "0.1.0"
__all__ = [
    "AsyncSession",
    "ComputerProcess",
    "ComputerRecording",
    "ComputerSession",
    "ExecResult",
    "FileStat",
    "Platform",
    "Session",
    "SignIn",
    "StepResult",
    "Target",
    "VerifyError",
    "Viewport",
    "async_open",
    "open",
]


def open(
    target: Target,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
) -> Session:
    from ._transport import Client

    if not isinstance(target, Target):
        raise VerifyError("INVALID_ARGUMENT", "open() requires a Target value.")
    target.validate()
    seconds(step_timeout, 1, 3600, "step_timeout")
    client = Client(backend_url)
    viewer = origin(app_url or os.environ.get("REVYL_APP_URL") or "https://app.revyl.ai", app=True)
    session = (ComputerSession if target.platform in ("mac", "linux") else Session).start(
        client, viewer, target, step_timeout
    )
    track(session)
    return session
