from __future__ import annotations

import os
import sys
from collections.abc import Callable
from typing import Literal

from ._agent import (
    CustomModel,
    Grounding,
    Key,
    KeyModifier,
    LocalAgent,
    Location,
    ModelOption,
    SwipeDirection,
    choose_agent,
    local_agent,
)
from ._async import AsyncSession, async_attach, async_open
from ._cleanup import install_signal_cleanup
from ._computer import ComputerSession
from ._model import (
    ModelAdapter,
    ModelImage,
    ModelReply,
    ModelRequest,
    ModelTool,
    ModelToolCall,
    ModelUsage,
    anthropic,
    openai_compatible,
)
from ._models import (
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    ModelRun,
    ModelTurn,
    Platform,
    Point,
    ScreenSize,
    SignIn,
    StepResult,
    Target,
    Viewport,
)
from ._session import Session
from ._transport import Cancellation, CleanupStatus, RefusalReason, VerifyError, origin, seconds

__version__ = "0.4.2"
__all__ = [
    "AsyncSession",
    "ComputerProcess",
    "ComputerRecording",
    "ComputerSession",
    "CleanupStatus",
    "CustomModel",
    "ExecResult",
    "FileStat",
    "Grounding",
    "Key",
    "KeyModifier",
    "LocalAgent",
    "Location",
    "ModelAdapter",
    "ModelImage",
    "ModelOption",
    "ModelReply",
    "ModelRequest",
    "ModelRun",
    "ModelTool",
    "ModelToolCall",
    "ModelTurn",
    "ModelUsage",
    "Platform",
    "Point",
    "RefusalReason",
    "ScreenSize",
    "Session",
    "SignIn",
    "StepResult",
    "SwipeDirection",
    "Target",
    "VerifyError",
    "Viewport",
    "anthropic",
    "attach",
    "async_attach",
    "async_current_computer",
    "async_open",
    "current_computer",
    "local_agent",
    "open",
    "openai_compatible",
]


def _print_progress(line: str) -> None:
    print("[verify] " + line, file=sys.stderr, flush=True)


def _progress(log: Callable[[str], None] | Literal[False] | None) -> Callable[[str], None] | None:
    if log is False:
        return None
    if log is None:
        return _print_progress
    if not callable(log):
        raise VerifyError("INVALID_ARGUMENT", "log must be a callable, False, or None.")
    return log


def _current_computer_id() -> str:
    computer_id = os.environ.get("REVYL_COMPUTER_ID", "").strip()
    if not computer_id:
        raise VerifyError(
            "COMPUTER_ID_MISSING",
            "No current Revyl computer is available. Run this job on a revyl-macos runner.",
        )
    return computer_id


def open(
    target: Target,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | Literal[False] | None = None,
    model: ModelOption | None = None,
    agent: LocalAgent | None = None,
    _cancellation: Cancellation | None = None,
) -> Session:
    from ._transport import Client

    if not isinstance(target, Target):
        raise VerifyError("INVALID_ARGUMENT", "open() requires a Target value.")
    target.validate()
    local = choose_agent(model, agent, "open()")
    computer = target.platform in ("mac", "linux")
    if local is not None and computer:
        raise VerifyError(
            "NOT_AVAILABLE_ON_PLATFORM",
            "Your own model runs steps on browsers and devices, not on computers.",
        )
    install_signal_cleanup()
    seconds(step_timeout, 1, 3600, "step_timeout")
    progress = _progress(log)
    viewer = origin(app_url or "https://app.revyl.ai", app=True)
    client = Client(backend_url, app_url, _cancellation)
    session = (ComputerSession if computer else Session).start(
        client, viewer, target, step_timeout, progress, _cancellation
    )
    session._agent = local
    return session


def attach(
    computer_id: str,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | Literal[False] | None = None,
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
    progress = _progress(log)
    install_signal_cleanup()
    viewer = origin(app_url or "https://app.revyl.ai", app=True)
    client = Client(backend_url, app_url, _cancellation)
    return ComputerSession.attach(
        client,
        viewer,
        computer_id,
        step_timeout,
        progress,
        _cancellation,
        stop_on_close=stop_on_close,
    )


def current_computer(
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | Literal[False] | None = None,
    stop_on_close: bool = False,
) -> ComputerSession:
    return attach(
        _current_computer_id(),
        backend_url=backend_url,
        app_url=app_url,
        step_timeout=step_timeout,
        log=log,
        stop_on_close=stop_on_close,
    )


async def async_current_computer(
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    step_timeout: float = 180,
    log: Callable[[str], None] | Literal[False] | None = None,
    stop_on_close: bool = False,
) -> AsyncSession:
    return await async_attach(
        _current_computer_id(),
        backend_url=backend_url,
        app_url=app_url,
        step_timeout=step_timeout,
        log=log,
        stop_on_close=stop_on_close,
    )
