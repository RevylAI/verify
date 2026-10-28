from __future__ import annotations

import base64
import math
import re
import threading
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn
from urllib.parse import quote, urlsplit

from ._cleanup import track, untrack
from ._models import (
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    Platform,
    Target,
)
from ._session import Session, save_screenshot
from ._transport import (
    Cancellation,
    Client,
    Deadline,
    Json,
    Response,
    VerifyError,
    decode_bytes,
    obj,
    refusal_reason,
    timestamp,
)

_MAX_OUTPUT = 1_048_576
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_STATES = ("starting", "active", "closing", "stopped", "failed", "owner_lost")
_TERMINAL = ("stopped", "failed", "owner_lost")
_ERRORS = {
    "computer_not_enabled",
    "run_closed",
    "inaccessible",
    "invalid_handle",
    "operation_not_found",
    "owner_unavailable",
    "invalid_request",
    "unauthenticated",
    "forbidden",
    "runtime_unavailable",
    "start_failed",
    "computer_limit",
    "request_conflict",
    "run_conflict",
    "evidence_conflict",
    "evidence_unavailable",
    "authentication_unavailable",
    "operation_limit",
    "screen_starting",
    "screen_unavailable",
}
_AVAILABILITY = (
    "Computers are not yet available in Revyl production. Early access works only on "
    "Revyl staging for enabled organizations and operating systems. See "
    "https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors"
)


def _invalid() -> VerifyError:
    return VerifyError("API_ERROR", "Revyl returned an invalid computer response.")


def _integer(value: Json, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise _invalid()
    return value


def _timeout_ms(seconds: float) -> int:
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not 0.001 <= seconds <= 300
        or not math.isfinite(seconds)
        or not math.isclose(seconds * 1000, round(seconds * 1000), abs_tol=1e-9, rel_tol=0)
    ):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Computer operation timeout must be from 0.001 to 300 seconds in whole milliseconds.",
        )
    return round(seconds * 1000)


def _guest_path(path: str) -> str:
    if (
        not isinstance(path, str)
        or not path
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or re.search(r"[\x00-\x1f\x7f\\:]", path)
    ):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Computer paths must be workspace-relative, without empty, dot, parent, "
            "backslash, colon, or control-character components.",
        )
    if len(_input_bytes(path)) > 1024:
        raise VerifyError("INVALID_ARGUMENT", "Computer paths must fit in 1024 UTF-8 bytes.")
    return path


def _input_bytes(value: str | bytes) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        try:
            return value.encode("utf-8")
        except UnicodeEncodeError:
            pass
    raise VerifyError("INVALID_ARGUMENT", "Computer input must be a UTF-8 string or bytes.")


def _detail(response: Response) -> str | None:
    try:
        raw = response.json()
    except VerifyError:
        return None
    if not isinstance(raw, dict):
        return None
    for field in ("detail", "message", "error"):
        value = raw.get(field)
        if value is not None:
            return value if isinstance(value, str) else None
    return None


class ComputerSession(Session):
    def __init__(
        self,
        client: Client,
        id: str,
        run_id: str,
        platform: Platform,
        viewer_url: str,
        step_timeout: float,
    ) -> None:
        super().__init__(client, id, run_id, platform, viewer_url, step_timeout)
        self._screen_ready_until: float = 0
        self._children: list[Session] = []
        self._child_starts = 0
        self._child_condition = threading.Condition(self._lock)

    @classmethod
    def attach(
        cls,
        client: Client,
        app_url: str,
        computer_id: str,
        step_timeout: float,
        log: Callable[[str], None] | None = None,
        cancellation: Cancellation | None = None,
    ) -> ComputerSession:
        session = cls(
            client,
            computer_id,
            "",
            "mac",
            f"{app_url.rstrip('/')}/sessions/{computer_id}?kind=computer",
            step_timeout,
        )
        session._log_callback = log
        session._cancellation = cancellation or Cancellation()
        deadline = Deadline(30, session._cancellation)
        try:
            report = session._report(session._request("GET", "/report", None, deadline))
            if report.get("os") not in ("macos", "linux") or session.expires_at is None:
                raise _invalid()
            session.platform = "mac" if report["os"] == "macos" else "linux"
            if report["state"] != "active" or datetime.now(timezone.utc) >= session.expires_at:
                raise VerifyError("SESSION_ENDED", "The computer is not active or has expired.")
            deadline.remaining()
        except BaseException as error:
            session._startup_failure(error, cleanup=False, refused=True)
            raise
        track(session)
        session._log("attached")
        return session

    def open(self, target: Target, *, _cancellation: Cancellation | None = None) -> Session:
        if not isinstance(target, Target):
            raise VerifyError("INVALID_ARGUMENT", "open() requires a Target value.")
        target.validate(hosted=True)
        with self._child_condition:
            self._assert_computer_open()
            if self.expires_at is None:
                raise VerifyError(
                    "API_ERROR", "A confirmed computer expiry is required before hosting a session."
                )
            if (self.platform == "mac" and target.platform == "android") or (
                self.platform == "linux" and target.platform == "ios"
            ):
                raise VerifyError(
                    "NOT_AVAILABLE_ON_PLATFORM",
                    "This computer cannot host the requested platform.",
                    reason="computer_cannot_host_platform",
                )
            cancellation = _cancellation or Cancellation()
            self._cancellation.add(cancellation.cancel)
            self._child_starts += 1
        child: Session | None = None
        try:
            child = Session.start(
                self._client,
                self.viewer_url.rsplit("/sessions/", 1)[0],
                target,
                self._step_timeout,
                self._log_callback,
                cancellation,
                computer_session_id=self.id,
                expires_at=self.expires_at,
            )
            with self._child_condition:
                closing = self._closed
                if not closing:
                    self._children.append(child)
            if closing:
                error = VerifyError("SESSION_ENDED", "The computer is closing.")
                child._startup_failure(error)
                raise error
            return child
        finally:
            with self._child_condition:
                if child is None or child.closed:
                    self._cancellation.remove(cancellation.cancel)
                self._child_starts -= 1
                self._child_condition.notify_all()

    @classmethod
    def start(
        cls,
        client: Client,
        app_url: str,
        target: Target,
        step_timeout: float,
        log: Callable[[str], None] | None = None,
        cancellation: Cancellation | None = None,
        *,
        computer_session_id: str | None = None,
        expires_at: datetime | None = None,
    ) -> ComputerSession:
        if (
            target.platform not in {"mac", "linux"}
            or computer_session_id is not None
            or expires_at is not None
        ):
            raise VerifyError("INVALID_ARGUMENT", "A computer target must be mac or linux.")
        session_id = str(uuid.uuid4())
        session = cls(
            client,
            session_id,
            "",
            target.platform,
            f"{app_url.rstrip('/')}/sessions/{quote(session_id, safe='')}?kind=computer",
            step_timeout,
        )
        cancellation = cancellation or Cancellation()
        session._cancellation = cancellation
        deadline = Deadline(target.start_timeout, cancellation)
        session._log_callback = log
        acknowledged = False
        try:
            track(session)
            session._log(f"starting computer {session.viewer_url}. {_AVAILABILITY}")
            response = session._request(
                "POST",
                "",
                {
                    "computer_session_id": session_id,
                    "os": "macos" if target.platform == "mac" else "linux",
                },
                deadline,
            )
            acknowledged = True
            while True:
                report = session._report(response)
                if report["state"] == "active":
                    session._screen_ready_until = time.monotonic() + 30
                    session._log("ready")
                    return session
                if report["state"] != "starting":
                    reason = ""
                    if report.get("failure_reason") == "no_host":
                        reason = (
                            " No host claimed the start within the "
                            "120-second unclaimed-start window."
                        )
                    elif report.get("failure_reason") == "device_limit":
                        reason = " Queued work or the concurrency limit prevented the start."
                    raise VerifyError(
                        "SESSION_START_FAILED",
                        f"The {target.platform} computer ended before it was ready "
                        f"({report['state']}).{reason} See {session.viewer_url}",
                    )
                deadline.pause(2)
                response = session._request("GET", "/report", None, deadline)
        except BaseException as error:
            timed_out = isinstance(error, VerifyError) and (
                error.code == "TIMEOUT"
                or (
                    error.code == "ACTION_UNCERTAIN"
                    and isinstance(error.__cause__, VerifyError)
                    and error.__cause__.code == "TIMEOUT"
                )
            )
            refused = (
                not acknowledged
                and isinstance(error, VerifyError)
                and error.code
                in {
                    "AUTH_REJECTED",
                    "NOT_AVAILABLE_ON_PLATFORM",
                    "INVALID_ARGUMENT",
                    "COMPUTER_LIMIT",
                }
            )
            if refused:
                session._closed = True
                untrack(session)
            if timed_out:
                error = VerifyError(
                    "TIMEOUT",
                    f"The {target.platform} computer startup timed out "
                    f"(startup budget: {target.start_timeout} seconds). A possible cause is that "
                    f"no computer could be assigned. {_AVAILABILITY}. Inspect {session.viewer_url}",
                )
            session._startup_failure(error, cleanup=not refused, refused=refused)
            if timed_out:
                raise error from None
            raise

    def _request(self, method: str, suffix: str, body: Json, deadline: Deadline) -> Response:
        path = "/api/v1/computer-runs" + (f"/{self.id}{suffix}" if suffix else "")
        try:
            response = self._client.request(
                method,
                path,
                body,
                deadline=deadline,
                timeout=310 if suffix == "/stop" or suffix.startswith("/operations") else 30,
                retry=method == "GET" and suffix != "/screen/screenshot",
            )
        except VerifyError as error:
            if method == "POST" or suffix.startswith("/operations/"):
                raise VerifyError(
                    "ACTION_UNCERTAIN",
                    "Computer request outcome is unconfirmed. Verify will not repeat it. "
                    f"See {self.viewer_url}",
                ) from error
            raise VerifyError(
                error.code, f"Could not read the computer state. See {self.viewer_url}"
            ) from None
        if 200 <= response.status < 300:
            return response
        reason = refusal_reason(response)
        detail = reason or _detail(response)
        if suffix == "/recording" and response.status == 404 and detail == "recording_unavailable":
            return response
        if suffix == "/screen/screenshot" and (
            (detail == "screen_unavailable" and response.status in {409, 503})
            or (detail == "screen_starting" and response.status == 409)
        ):
            return response
        if detail == "computer_not_enabled" or (
            response.status == 503 and detail == "runtime_unavailable"
        ):
            raise VerifyError(
                "NOT_AVAILABLE_ON_PLATFORM",
                f"Revyl refused the computer request ({detail}). {_AVAILABILITY}. "
                "Ask support@revyl.ai about staging organization enablement. "
                f"See {self.viewer_url}",
                reason=reason,
                http_status=response.status,
            )
        if response.status == 429 and detail == "computer_limit":
            raise VerifyError(
                "COMPUTER_LIMIT",
                "Computer admission was refused because of queued work (including iOS) "
                "or the concurrency limit. Verify will not retry the start. "
                f"See {self.viewer_url}",
                reason=reason,
                http_status=response.status,
            )
        code = "API_ERROR"
        if detail == "run_closed":
            code = "SESSION_ENDED"
        elif detail in {"inaccessible", "invalid_handle"}:
            code = "NOT_FOUND"
        elif detail in {"operation_not_found", "owner_unavailable"}:
            code = "ACTION_UNCERTAIN"
        elif detail == "invalid_request" or response.status == 422:
            code = "INVALID_ARGUMENT"
        elif response.status in {401, 403}:
            code = "AUTH_REJECTED"
        elif detail == "start_failed":
            code = "SESSION_START_FAILED"
        elif response.status == 409 or detail == "operation_limit":
            code = "SESSION_BUSY"
        elif (suffix.startswith("/operations/") and response.status >= 500) or (
            method == "POST" and (response.status >= 500 or response.status < 400)
        ):
            code = "ACTION_UNCERTAIN"
        description = detail if detail in _ERRORS else f"HTTP {response.status}"
        raise VerifyError(
            code,
            f"Revyl refused the computer request ({description}). See {self.viewer_url}",
            reason=reason,
            http_status=response.status,
        )

    def _report(self, response: Response) -> dict[str, Json]:
        raw = obj(response.json())
        if raw.get("computer_session_id") != self.id or raw.get("state") not in _STATES:
            raise _invalid()
        if raw.get("expires_at") is not None:
            with self._lock:
                self._expires_at = timestamp(raw["expires_at"])
        return raw

    def report(self) -> dict[str, Json]:
        return self._report(self._request("GET", "/report", None, Deadline(30)))

    def _assert_computer_open(self) -> None:
        with self._lock:
            if self.closed or (
                self.expires_at is not None and datetime.now(timezone.utc) >= self.expires_at
            ):
                raise VerifyError(
                    "SESSION_ENDED", f"The {self.platform} computer was closed or expired."
                )

    def _observation_deadline(self, seconds: float) -> Deadline:
        expiry = self.expires_at
        if expiry is not None:
            seconds = min(seconds, max(0, (expiry - datetime.now(timezone.utc)).total_seconds()))
        return Deadline(seconds, self._cancellation)

    def _observe(self, deadline: Deadline) -> None:
        self._assert_computer_open()
        deadline.remaining()

    def _operation(self, command: dict[str, Json], allow_nonzero: bool = False) -> dict[str, Json]:
        self._assert_computer_open()
        request_id = str(uuid.uuid4())
        operation_id = str(uuid.uuid5(uuid.UUID(self.id), request_id))
        deadline = self._observation_deadline(310)
        try:
            response = self._request(
                "POST",
                "/operations",
                {
                    "computer_session_id": self.id,
                    "request_id": request_id,
                    "command": command,
                },
                deadline,
            )
            while True:
                self._observe(deadline)
                if response.status != 202:
                    raw = obj(response.json())
                    if (
                        raw.get("computer_session_id") != self.id
                        or raw.get("operation_id") != operation_id
                        or raw.get("evidence") not in ("recorded", "pending", "failed")
                    ):
                        raise _invalid()
                    execution = obj(raw.get("execution"))
                    outcome = execution.get("outcome")
                    kind = command["kind"]
                    if outcome == "succeeded" or (
                        outcome == "failed"
                        and execution.get("error_code") == "exec_nonzero"
                        and allow_nonzero
                    ):
                        result = obj(execution.get("result"))
                        if result.get("kind") != kind:
                            raise _invalid()
                        if kind == "exec":
                            exit_code = _integer(result.get("exit_code"), -255, 255)
                            if (outcome == "succeeded") != (exit_code == 0):
                                raise _invalid()
                        return result
                    if outcome == "failed":
                        code = execution.get("error_code")
                        if code == "exec_nonzero":
                            result = obj(execution.get("result"))
                            if kind != "exec" or result.get("kind") != "exec":
                                raise _invalid()
                            observed = self._decode_exec(result)
                            if observed.exit_code == 0:
                                raise _invalid()
                            raise VerifyError(
                                "COMMAND_FAILED",
                                "Computer exec failed (exec_nonzero, "
                                f"exit code {observed.exit_code}). See {self.viewer_url}",
                                result=observed,
                            )
                        if code not in ("not_found", "access_denied"):
                            raise _invalid()
                        raise VerifyError(
                            "NOT_FOUND" if code == "not_found" else "ACCESS_DENIED",
                            f"Computer {kind} failed ({code}). See {self.viewer_url}",
                        )
                    if outcome == "timed_out":
                        termination = execution.get("termination")
                        if termination == "unknown":
                            raise VerifyError(
                                "ACTION_UNCERTAIN",
                                f"Computer {kind} timed out; termination is unconfirmed. "
                                f"Verify will not repeat it. See {self.viewer_url}",
                            )
                        if termination != "confirmed":
                            raise _invalid()
                        raise VerifyError(
                            "TIMEOUT",
                            f"Computer {kind} timed out; termination was confirmed. "
                            f"See {self.viewer_url}",
                        )
                    if outcome != "unknown":
                        raise _invalid()
                    raise VerifyError(
                        "ACTION_UNCERTAIN",
                        f"Computer {kind} outcome is unconfirmed. Verify will not repeat it. "
                        f"Inspect operation {operation_id} at {self.viewer_url}",
                    )
                if response.json() is not None:
                    raise _invalid()
                deadline.pause(2)
                self._observe(deadline)
                response = self._request("GET", f"/operations/{operation_id}", None, deadline)
        except VerifyError:
            try:
                self._observe(deadline)
            except VerifyError:
                raise VerifyError(
                    "ACTION_UNCERTAIN",
                    f"Computer operation {operation_id} stopped being observed; "
                    f"its outcome is unconfirmed. See {self.viewer_url}",
                ) from None
            raise

    def _decode_exec(self, result: dict[str, Json]) -> ExecResult:
        exit_code = _integer(result.get("exit_code"), -255, 255)
        stdout = decode_bytes(result.get("stdout", ""), _MAX_OUTPUT)
        stderr = decode_bytes(result.get("stderr", ""), _MAX_OUTPUT)
        if len(stdout) + len(stderr) > _MAX_OUTPUT:
            raise _invalid()
        return ExecResult(
            exit_code,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    def exec(
        self, argv: list[str], *, stdin: str | bytes = b"", timeout: float = 30, check: bool = True
    ) -> ExecResult:
        data = _input_bytes(stdin)
        if (
            not isinstance(argv, list)
            or not 1 <= len(argv) <= 64
            or not argv[0]
            or any(not isinstance(arg, str) or "\0" in arg for arg in argv)
        ):
            raise VerifyError(
                "INVALID_ARGUMENT", "exec() takes 1-64 string arguments without NUL bytes."
            )
        if sum(len(_input_bytes(arg)) for arg in argv) + len(data) > 16_384:
            raise VerifyError(
                "INVALID_ARGUMENT", "Exec argv and stdin together must fit in 16384 bytes."
            )
        if not isinstance(check, bool):
            raise VerifyError("INVALID_ARGUMENT", "exec() check must be a boolean.")
        arguments: list[Json] = list(argv)
        return self._decode_exec(
            self._operation(
                {
                    "kind": "exec",
                    "argv": arguments,
                    "stdin": base64.b64encode(data).decode("ascii"),
                    "timeout_ms": _timeout_ms(timeout),
                },
                not check,
            )
        )

    def read_file(self, path: str, *, timeout: float = 30) -> bytes:
        result = self._operation(
            {"kind": "file_read", "path": _guest_path(path), "timeout_ms": _timeout_ms(timeout)}
        )
        return decode_bytes(result.get("data"), _MAX_OUTPUT)

    def write_file(self, path: str, data: str | bytes, *, timeout: float = 30) -> None:
        content = _input_bytes(data)
        if len(content) > 65_536:
            raise VerifyError("INVALID_ARGUMENT", "write_file() takes at most 65536 bytes.")
        result = self._operation(
            {
                "kind": "file_write",
                "path": _guest_path(path),
                "data": base64.b64encode(content).decode("ascii"),
                "timeout_ms": _timeout_ms(timeout),
            }
        )
        if _integer(result.get("byte_count"), 0, 65_536) != len(content):
            raise _invalid()

    def stat(self, path: str, *, timeout: float = 30) -> FileStat:
        result = self._operation(
            {"kind": "file_stat", "path": _guest_path(path), "timeout_ms": _timeout_ms(timeout)}
        )
        kind = result.get("file_kind")
        if kind != "file" and kind != "directory":
            raise _invalid()
        return FileStat(
            "file" if kind == "file" else "directory",
            _integer(result.get("size_bytes"), 0, 9_007_199_254_740_991),
        )

    def processes(self, *, timeout: float = 30) -> list[ComputerProcess]:
        result = self._operation({"kind": "process_list", "timeout_ms": _timeout_ms(timeout)})
        processes = result.get("processes")
        if not isinstance(processes, list) or len(processes) > 64:
            raise _invalid()
        observed: list[ComputerProcess] = []
        ids: set[str] = set()
        for value in processes:
            process = obj(value)
            handle = obj(process.get("handle"))
            process_id = handle.get("handle_id")
            state = process.get("state")
            exit_code = process.get("exit_code")
            if (
                handle.get("computer_session_id") != self.id
                or not isinstance(process_id, str)
                or not _UUID.fullmatch(process_id)
                or state not in ("running", "exited")
                or process_id in ids
            ):
                raise _invalid()
            if exit_code is not None:
                exit_code = _integer(exit_code, -255, 255)
                if state == "running":
                    raise _invalid()
            ids.add(process_id)
            observed.append(
                ComputerProcess(
                    process_id, "running" if state == "running" else "exited", exit_code
                )
            )
        return observed

    def terminate(self, handle_id: str, *, timeout: float = 30) -> None:
        if not isinstance(handle_id, str) or not _UUID.fullmatch(handle_id):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "terminate() takes a process handle id from processes(), not an OS PID.",
            )
        result = self._operation(
            {
                "kind": "process_terminate",
                "handle": {"computer_session_id": self.id, "handle_id": handle_id},
                "timeout_ms": _timeout_ms(timeout),
            }
        )
        if result.get("termination") != "confirmed":
            raise _invalid()

    def screenshot(self, *, path: str | Path | None = None) -> bytes:
        self._assert_computer_open()
        deadline = self._observation_deadline(30)
        transient = False
        backoff = 0.5
        try:
            while True:
                self._observe(deadline)
                response = self._request("GET", "/screen/screenshot", None, deadline)
                if 200 <= response.status < 300:
                    break
                remaining = self._screen_ready_until - time.monotonic()
                if remaining <= 0:
                    raise self._screen_not_ready()
                if not transient:
                    deadline = deadline.cap(remaining)
                transient = True
                deadline.pause(min(backoff, remaining))
                if time.monotonic() >= self._screen_ready_until:
                    raise self._screen_not_ready()
                backoff = min(backoff * 2, 2)
        except VerifyError:
            self._assert_computer_open()
            if transient and time.monotonic() >= self._screen_ready_until:
                raise self._screen_not_ready() from None
            raise
        self._observe(deadline)
        raw = obj(response.json())
        data = decode_bytes(raw.get("png"), 128 * _MAX_OUTPUT)
        width = _integer(raw.get("width"), 1, 4095)
        height = _integer(raw.get("height"), 1, 4095)
        if (
            len(data) < 24
            or data[:8] != b"\x89PNG\r\n\x1a\n"
            or int.from_bytes(data[16:20], "big") != width
            or int.from_bytes(data[20:24], "big") != height
        ):
            raise _invalid()
        return save_screenshot(data, path)

    def _screen_not_ready(self) -> VerifyError:
        return VerifyError(
            "SESSION_BUSY",
            "The computer desktop is not ready for screenshots after its 30-second startup "
            f"window. Try again later. See {self.viewer_url}",
        )

    def recording(self) -> ComputerRecording | None:
        deadline = Deadline(30)
        report = self._report(self._request("GET", "/report", None, deadline))
        if report["state"] not in _TERMINAL or report.get("release") != "confirmed":
            raise VerifyError(
                "SESSION_BUSY",
                "The computer recording can be requested only after terminal state "
                f"and confirmed release. See {self.viewer_url}",
            )
        response = self._request("GET", "/recording", None, deadline)
        if response.status == 404:
            return None
        raw = obj(response.json())
        url = raw.get("url")
        if not isinstance(url, str) or re.search(r"[\x00-\x20\x7f]", url):
            raise _invalid()
        try:
            parsed = urlsplit(url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
                or "#" in url
            ):
                raise _invalid()
            _ = parsed.port
        except ValueError:
            raise _invalid() from None
        duration = raw.get("duration_seconds")
        if duration is not None:
            if (
                isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or not 0 <= duration <= 1.7976931348623157e308
                or not math.isfinite(duration)
            ):
                raise _invalid()
        started_at = timestamp(raw["started_at"]) if raw.get("started_at") is not None else None
        return ComputerRecording(url, duration, started_at)

    def instruction(self, text: str, *, timeout: float | None = None) -> NoReturn:
        raise VerifyError(
            "NOT_AVAILABLE_ON_PLATFORM",
            "instruction() is not available on computers; use exec() and file operations. "
            f"See {self.viewer_url}",
        )

    def validation(
        self, text: str, *, soft: bool = False, timeout: float | None = None
    ) -> NoReturn:
        raise VerifyError(
            "NOT_AVAILABLE_ON_PLATFORM",
            "validation() is not available on computers; use exec() and file operations. "
            f"See {self.viewer_url}",
        )

    def close(self) -> None:
        with self._close_lock:
            with self._lock:
                if self._closed:
                    if self._close_error is not None:
                        raise self._close_error
                    return
            try:
                with self._child_condition:
                    self._closed = True
                    self._child_condition.notify_all()
                    self._cancellation.cancel()
                    while self._child_starts:
                        self._child_condition.wait()
                    children = list(self._children)
                for child in children:
                    try:
                        child.close()
                    except BaseException:
                        self._log("child cleanup unconfirmed; stopping parent")
                report = self._report(self._request("POST", "/stop", None, Deadline(310)))
                if report.get("release") != "confirmed":
                    raise VerifyError(
                        "ACTION_UNCERTAIN",
                        "Computer stop was requested, but physical release is unconfirmed. "
                        f"Inspect {self.viewer_url}",
                    )
                if report["state"] not in _TERMINAL:
                    raise _invalid()
                self._cleanup_status = "confirmed"
                self._log("physical release confirmed")
            except VerifyError as error:
                self._cleanup_status = "unconfirmed"
                if error.code == "ACTION_UNCERTAIN":
                    error = VerifyError(
                        error.code,
                        f"{error.message} A possible cause is that no computer could be assigned. "
                        f"{_AVAILABILITY}",
                        reason=error.reason,
                        http_status=error.http_status,
                    )
                with self._lock:
                    self._close_error = error
                raise error
            except BaseException:
                self._cleanup_status = "unconfirmed"
                self._close_error = VerifyError(
                    "ACTION_UNCERTAIN",
                    "Computer stop was interrupted; physical release is unconfirmed. "
                    f"Inspect {self.viewer_url}",
                )
                raise
            finally:
                if self._close_error:
                    self._attach_failure(self._close_error)
                    self._log("physical release unconfirmed")
                untrack(self)
