from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable
from datetime import datetime
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
from ._async import AsyncSession, async_attach, async_open, async_report
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
    CDPEndpoint,
    ComputerInferenceReadiness,
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    ModelRun,
    ModelTurn,
    Platform,
    Point,
    ScreenSize,
    SessionReport,
    SessionReportStep,
    SignIn,
    StepResult,
    Target,
    Viewport,
)
from ._persistent import (
    ComputerSnapshot,
    PersistentComputer,
    PersistentComputerSession,
    delete_persistent,
    delete_snapshot,
    list_persistent,
    list_snapshots,
    open_persistent,
    save_snapshot,
)
from ._session import Session
from ._transport import (
    Cancellation,
    CleanupStatus,
    Json,
    RefusalReason,
    SessionProfileOutcome,
    VerifyError,
    seconds,
    timestamp,
)

__version__ = "0.6.2"
__all__ = [
    "AsyncSession",
    "CDPEndpoint",
    "ComputerInferenceReadiness",
    "ComputerProcess",
    "ComputerRecording",
    "ComputerSession",
    "ComputerSnapshot",
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
    "PersistentComputer",
    "PersistentComputerSession",
    "Platform",
    "Point",
    "RefusalReason",
    "ScreenSize",
    "Session",
    "SessionProfileOutcome",
    "SessionReport",
    "SessionReportStep",
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
    "async_report",
    "current_computer",
    "delete_persistent",
    "delete_snapshot",
    "list_persistent",
    "list_snapshots",
    "local_agent",
    "open",
    "open_persistent",
    "openai_compatible",
    "report",
    "save_snapshot",
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
    profile: str | None = None,
    _cancellation: Cancellation | None = None,
) -> Session:
    from ._session_profile import is_legacy_profile_refusal, plan_session_profile
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
    plan = plan_session_profile(profile, target.platform, os.getcwd())
    install_signal_cleanup()
    seconds(step_timeout, 1, 3600, "step_timeout")
    progress = _progress(log)
    client = Client(backend_url, app_url, _cancellation)
    viewer = client.app
    start = (ComputerSession if computer else Session).start
    try:
        session = start(client, viewer, target, step_timeout, progress, _cancellation, profile=plan)
    except VerifyError as error:
        if plan is None or not plan.implicit or not is_legacy_profile_refusal(error):
            raise
        if progress is not None:
            try:
                progress(
                    f"Skipping default session profile {plan.name}: Revyl doesn't run session "
                    'profiles for API starts yet. Pass profile="none" to silence this.'
                )
            except Exception:
                pass
        session = start(client, viewer, target, step_timeout, progress, _cancellation)
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
    client = Client(backend_url, app_url, _cancellation)
    return ComputerSession.attach(
        client,
        client.app,
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


def report(
    session_id: str,
    *,
    backend_url: str | None = None,
    app_url: str | None = None,
    _cancellation: Cancellation | None = None,
) -> SessionReport:
    """Reads a finished or running session's outcome and steps from Revyl by its ID (session.id,
    or the last part of its viewer_url), also after the process that ran it has exited. Works for
    browser, device and computer sessions; steps is empty for computers and for sessions Revyl has
    no report for yet. Credentials and backend_url/app_url work as for open().

    Raises VerifyError INVALID_ARGUMENT for an ID that isn't a UUID, NOT_FOUND when this API key's
    organization has no session with that ID, AUTH_REJECTED and API_ERROR.

    Example::

        result = report("0b9c4e1a-2f3d-4c5b-8a6e-7d8f9a0b1c2d")
        print(result.status, [step.passed for step in result.steps])
    """
    from ._models import UUID_PATTERN
    from ._session import _FINAL_STATUSES
    from ._transport import Client, Deadline, http_error, obj

    if not isinstance(session_id, str) or not UUID_PATTERN.fullmatch(session_id):
        raise VerifyError(
            "INVALID_ARGUMENT", "report() requires a session UUID, such as session.id."
        )
    client = Client(backend_url, app_url, _cancellation)
    deadline = Deadline(95, _cancellation)
    response = client.request(
        "GET", f"/api/v1/execution/device-sessions/{session_id}", deadline=deadline, retry=True
    )
    if response.status == 404:
        raise VerifyError(
            "NOT_FOUND",
            f"Revyl has no session {session_id} in this API key's organization at "
            f"{client.base}. Check the id and the API key.",
            http_status=404,
        )
    if not 200 <= response.status < 300:
        raise http_error(response)
    detail = obj(response.json())
    response = client.request(
        "GET",
        f"/api/v1/reports-v3/reports/by-session/{session_id}/context"
        "?include_steps=true&include_actions=false&include_llm_calls=false",
        deadline=deadline,
        retry=True,
    )
    if response.status == 404:
        raw_steps: Json = []
    elif not 200 <= response.status < 300:
        raise http_error(response)
    else:
        raw_steps = obj(response.json()).get("steps", [])
    if not isinstance(raw_steps, list):
        raise VerifyError("API_ERROR", "Revyl returned an invalid session report.")
    steps: list[tuple[int, SessionReportStep]] = []
    for item in raw_steps:
        step = obj(item)
        order = step.get("execution_order")
        status = step.get("effective_status") or step.get("status")
        passed = step.get("validation_result")
        if not isinstance(passed, bool):
            passed = step.get("success")
        if (
            not isinstance(order, int)
            or isinstance(order, bool)
            or not isinstance(step.get("step_type"), str)
            or not isinstance(status, str)
            or (passed is not None and not isinstance(passed, bool))
        ):
            raise VerifyError("API_ERROR", "Revyl returned an invalid session report.")
        steps.append(
            (
                order,
                SessionReportStep(
                    type=str(step["step_type"]),
                    description=_report_text(step.get("step_description")),
                    status=status,
                    passed=passed,
                    reasoning=_report_text(step.get("validation_reasoning")),
                    error=_report_text(step.get("error_message")),
                ),
            )
        )
    status = detail.get("status")
    platform = _report_text(detail.get("platform"))
    if not isinstance(status, str):
        raise VerifyError("API_ERROR", "Revyl returned an invalid session report.")
    return SessionReport(
        id=session_id,
        viewer_url=f"{client.app}/sessions/{session_id}"
        + ("?kind=computer" if platform in ("macos", "linux") else ""),
        platform=platform,
        status=status,
        finished=status in _FINAL_STATUSES,
        error=_report_text(detail.get("error_message")),
        started_at=_report_time(detail.get("started_at")),
        ended_at=_report_time(detail.get("ended_at")),
        steps=[step for _, step in sorted(steps, key=lambda pair: pair[0])],
    )


def _report_text(value: Json) -> str | None:
    if value is not None and not isinstance(value, str):
        raise VerifyError("API_ERROR", "Revyl returned an invalid session report.")
    return value or None


def _report_time(value: Json) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, str) and re.fullmatch(r"[\d\-]+T[\d:]+(?:\.\d+)?", value):
        value += "Z"
    return timestamp(value)
