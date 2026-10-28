from __future__ import annotations

import io
import re
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType
from typing import Literal, NoReturn
from urllib.parse import quote, urlencode, urlsplit
from uuid import uuid4

from PIL import Image, UnidentifiedImageError

from ._cleanup import track, untrack
from ._models import (
    UUID_PATTERN,
    ComputerProcess,
    ComputerRecording,
    ExecResult,
    FileStat,
    Platform,
    StepResult,
    Target,
    text_length,
)
from ._transport import (
    Cancellation,
    CleanupStatus,
    Client,
    Deadline,
    Json,
    Response,
    VerifyError,
    obj,
    refusal_reason,
    seconds,
)


def png_size(data: bytes) -> tuple[int, int]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise VerifyError("ACTION_FAILED", "Revyl returned a screenshot that is not a PNG.")
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if width < 1 or height < 1:
        raise VerifyError("ACTION_FAILED", "Revyl returned a screenshot that is not a PNG.")
    return width, height


def non_blank_png(data: bytes) -> bool:
    width, height = png_size(data)
    if len(data) > 16 * 1024 * 1024 or width * height > 16_000_000:
        raise VerifyError("API_ERROR", "Screenshot exceeds PNG limits.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            interior = image.convert("RGB").crop(
                (width // 10, height // 10, width - width // 10, height - height // 10)
            )
            return interior.getcolors(maxcolors=1) is None
    except (OSError, ValueError, UnidentifiedImageError):
        raise VerifyError("API_ERROR", "Screenshot PNG could not be inspected.") from None


def save_screenshot(data: bytes, path: str | Path | None) -> bytes:
    if path is not None:
        try:
            destination = Path(path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        except OSError:
            raise VerifyError("ACTION_FAILED", "Could not write screenshot.") from None
    return data


class Session:
    def __init__(
        self,
        client: Client,
        id: str,
        run_id: str,
        platform: Platform,
        viewer_url: str,
        step_timeout: float,
    ) -> None:
        self._client = client
        self.id = id
        self._run_id = run_id
        self.platform = platform
        self.viewer_url = viewer_url
        self._step_timeout = step_timeout
        self.steps: list[StepResult] = []
        self._expires_at: datetime | None = None
        self._closed = False
        self._close_error: VerifyError | None = None
        self._lock = threading.RLock()
        self._close_lock = threading.Lock()
        self._step_running = False
        self._cancellation = Cancellation()
        self._log_callback: Callable[[str], None] | None = None
        self._cleanup_status: CleanupStatus = "not_attempted"

    def _log(self, message: str) -> None:
        if self._log_callback:
            try:
                self._log_callback(f"{self.platform}: {message}")
            except Exception:
                pass

    def _startup_failure(
        self,
        error: BaseException,
        *,
        cleanup: bool = True,
        refused: bool = False,
    ) -> None:
        if cleanup:
            try:
                self.close()
            except BaseException:
                pass
        else:
            self._cleanup_status = "not_required" if refused else "unconfirmed"
        self._attach_failure(error)
        self._log(f"startup failed; cleanup {self._cleanup_status}")

    def _attach_failure(self, error: BaseException) -> None:
        if isinstance(error, VerifyError):
            error.platform = self.platform
            error.session_id = self.id or None
            error.workflow_run_id = self._run_id or None
            error.viewer_url = self.viewer_url if self.id else None
            error.cleanup_status = self._cleanup_status
            error.cleanup_error = self._close_error if self._close_error is not error else None

    @property
    def expires_at(self) -> datetime | None:
        return self._expires_at

    @property
    def closed(self) -> bool:
        return self._closed

    def __enter__(self) -> Session:
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
            if isinstance(exc, VerifyError):
                self._attach_failure(exc)
            raise exc.with_traceback(traceback) from cleanup_error

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
    ) -> Session:
        cancellation = cancellation or Cancellation()
        deadline = Deadline(target.start_timeout, cancellation)
        if expires_at is not None:
            deadline = deadline.cap((expires_at - datetime.now(timezone.utc)).total_seconds())
        hosted = computer_session_id is not None
        body: dict[str, Json] = {
            "platform": target.platform,
            "idle_timeout_seconds": target.idle_timeout_seconds or 600,
        }
        proposed_id = str(uuid4())
        if hosted:
            if proposed_id == computer_session_id:
                raise VerifyError("API_ERROR", "Could not allocate a distinct child session ID.")
            body.update(computer_session_id=computer_session_id, session_id=proposed_id)
        if target.platform == "web":
            web: dict[str, Json] = {}
            if target.viewport:
                web["viewport"] = {"width": target.viewport.width, "height": target.viewport.height}
                if target.viewport.device_scale_factor is not None:
                    obj(web["viewport"])["device_scale_factor"] = (
                        target.viewport.device_scale_factor
                    )
            if target.sign_in:
                sign_in: dict[str, Json] = {
                    "path": target.sign_in.path,
                    "secret_name": target.sign_in.secret,
                }
                if target.sign_in.persona:
                    sign_in["persona"] = target.sign_in.persona
                web["sign_in"] = sign_in
            body.update(
                session_id=proposed_id,
                app_id=target.app_id,
                build_id=_web_build(client, target, deadline),
                web=web,
            )
        else:
            body["is_simulation"] = True
            for key, value in (
                ("app_id", target.app_id),
                ("build_id", target.build_id),
                ("app_url", target.artifact_url),
                ("device_model", target.device_model),
                ("os_version", target.os_version),
            ):
                if value is not None:
                    body[key] = value
        session = cls(
            client,
            proposed_id if target.platform == "web" or hosted else "",
            "",
            target.platform,
            app_url + "/sessions/" + (proposed_id if target.platform == "web" or hosted else ""),
            step_timeout,
        )
        session._log_callback = log
        session._cancellation = cancellation
        session._expires_at = expires_at
        submitted = False
        refused = False
        try:
            session._log("starting session" + (" " + session.viewer_url if session.id else ""))
            deadline.remaining()
            submitted = True
            if session.id:
                track(session)
            response = client.request(
                "POST", "/api/v1/execution/start_device", body, deadline=deadline, timeout=120
            )
            if not 200 <= response.status < 300:
                refused = response.status in (400, 401, 403, 404, 405, 422, 429)
                from ._transport import http_error

                error = http_error(response, hosted=hosted)
                refused = refused or (
                    hosted
                    and (
                        (response.status == 503 and error.reason is not None)
                        or (400 <= response.status < 500 and response.status != 408)
                    )
                )
                raise error
            start = obj(response.json())
            session_id, run_id = start.get("session_id"), start.get("workflow_run_id")
            valid_run_id = isinstance(run_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,255}", run_id)
            valid_session_id = isinstance(session_id, str) and UUID_PATTERN.fullmatch(session_id)
            if valid_run_id and isinstance(run_id, str):
                session._run_id = run_id
            if (
                not hosted
                and target.platform != "web"
                and valid_session_id
                and isinstance(session_id, str)
            ):
                session.id = session_id
                session.viewer_url = app_url + "/sessions/" + quote(session_id, safe="")
            if session.id or session._run_id:
                track(session)
                if target.platform != "web":
                    session._log(
                        "assigned session "
                        + (session.viewer_url if session.id else session._run_id)
                    )
            if (
                (session_id is not None and not valid_session_id)
                or (run_id is not None and not valid_run_id)
                or ((target.platform == "web" or hosted) and session_id != proposed_id)
                or (target.platform != "web" and not session._run_id)
                or (
                    hosted
                    and (
                        not session._run_id
                        or ("platform" in start and start["platform"] != target.platform)
                    )
                )
            ):
                raise VerifyError(
                    "SESSION_START_FAILED", "Revyl did not acknowledge the new session."
                )
            session._ready(target, deadline)
            if target.platform != "web":
                session._wait_first_screen(deadline.cap(10))
            if hosted:
                deadline.remaining()
            session._log("ready")
        except BaseException as error:
            session._startup_failure(
                error,
                cleanup=submitted and not refused and bool(session.id or session._run_id),
                refused=refused,
            )
            if not session.id and not session._run_id or refused:
                untrack(session)
            raise
        return session

    def _path(self, action: str) -> str:
        return "/api/v1/execution/device-proxy/" + quote(self._run_id, safe="") + "/" + action

    def _ready(self, target: Target, deadline: Deadline) -> None:
        if self.platform == "web":
            while True:
                detail = self._client.json(
                    "GET",
                    "/api/v1/execution/device-sessions/" + quote(self.id, safe=""),
                    deadline=deadline,
                    retry=True,
                )
                if detail.get("status") in (
                    "completed",
                    "failed",
                    "cancelled",
                    "timeout",
                    "stopping",
                ):
                    raise VerifyError(
                        "SESSION_START_FAILED",
                        "Web session ended before becoming ready. See " + self.viewer_url,
                    )
                run = detail.get("workflow_run_id")
                if detail.get("status") == "running" and isinstance(run, str) and run:
                    if not re.fullmatch(r"[A-Za-z0-9_-]{1,255}", run):
                        raise VerifyError("API_ERROR", "Revyl returned an invalid workflow ID.")
                    self._run_id = run
                    response = self._client.request(
                        "GET", self._path("screenshot"), deadline=deadline, worker=True
                    )
                    if response.status == 200:
                        png_size(response.body)
                        return
                    if response.status not in (409, 503):
                        raise self._worker_error("GET", response)
                deadline.pause(2)
        while True:
            connection = self._client.json(
                "GET",
                "/api/v1/execution/streaming/worker-connection/" + quote(self._run_id, safe=""),
                deadline=deadline,
                retry=True,
            )
            if (
                connection.get("status") == "ready"
                and isinstance(connection.get("worker_ws_url"), str)
                and connection.get("worker_ws_url")
            ):
                break
            if connection.get("status") in ("cancelled", "stopped", "failed"):
                raise VerifyError("SESSION_START_FAILED", "Device assignment failed.")
            deadline.pause(2)
        connected = deadline.cap(90)
        while True:
            response = self._client.request(
                "GET", self._path("health"), deadline=connected, retry=True, worker=True
            )
            if response.status == 200:
                if obj(response.json()).get("device_connected") is True:
                    break
            elif response.status != 503:
                raise self._worker_error("GET", response)
            connected.pause(2)
        if target.bundle_id:
            launched = obj(
                self._worker(
                    "POST", "launch", {"bundle_id": target.bundle_id}, deadline=deadline
                ).json()
            )
            if launched.get("success") is not True:
                raise VerifyError("SESSION_START_FAILED", "Could not launch the installed app.")

    def _wait_first_screen(self, deadline: Deadline) -> None:
        try:
            while True:
                response = self._client.request(
                    "GET", self._path("screenshot"), deadline=deadline, timeout=10, worker=True
                )
                if response.status == 200:
                    if non_blank_png(response.body):
                        return
                elif response.status not in (409, 503):
                    return
                deadline.pause(0.5)
        except VerifyError:
            return

    def _worker_error(self, method: str, response: Response) -> VerifyError:
        try:
            raw = obj(response.json())
        except VerifyError:
            raw = {}
        error, reason = raw.get("error"), raw.get("detail", raw.get("message", ""))
        code = "ACTION_FAILED"
        if response.status in (401, 403):
            code = "AUTH_REJECTED"
        elif response.status == 501 or error in (
            "not_available_on_platform",
            "step_output_not_available",
        ):
            code = "NOT_AVAILABLE_ON_PLATFORM"
        elif response.status in (404, 410):
            code = "SESSION_ENDED"
        elif response.status == 409:
            code = (
                "SESSION_ENDED"
                if any(
                    isinstance(value, str)
                    and re.search(r"session is (not running|not active|stopping)", value, re.I)
                    for value in (reason, error)
                )
                else "SESSION_BUSY"
            )
        elif method == "POST" and (
            raw.get("execution_uncertain") is True
            or error in ("request_timeout", "connection_closed", "protocol_error")
        ):
            code = "ACTION_UNCERTAIN"
        return VerifyError(
            code,
            f"Revyl session request failed (HTTP {response.status}). See {self.viewer_url}",
            reason=refusal_reason(response),
            http_status=response.status,
        )

    def _worker(
        self,
        method: str,
        action: str,
        body: Json = None,
        *,
        deadline: Deadline,
        timeout: float = 30,
        retry: bool = False,
    ) -> Response:
        if self.closed:
            raise VerifyError("SESSION_ENDED", "The session was closed.")
        if self.expires_at is not None:
            remaining = (self.expires_at - datetime.now(timezone.utc)).total_seconds()
            if remaining <= 0:
                raise VerifyError("SESSION_ENDED", "The hosting computer has expired.")
            deadline = deadline.cap(remaining)
        response = self._client.request(
            method,
            self._path(action),
            body,
            deadline=deadline,
            timeout=timeout,
            retry=retry,
            worker=True,
        )
        if not 200 <= response.status < 300:
            raise self._worker_error(method, response)
        return response

    def instruction(self, text: str, *, timeout: float | None = None) -> StepResult:
        result = self._step("instruction", text, timeout)
        if not result.passed:
            raise VerifyError(
                "INSTRUCTION_FAILED", "Instruction failed. See " + self.viewer_url, result=result
            )
        return result

    def open(self, target: Target, *, _cancellation: Cancellation | None = None) -> Session:
        self._computer_only()

    def navigate(self, url: str) -> None:
        if self.platform != "web":
            raise VerifyError("NOT_AVAILABLE_ON_PLATFORM", "navigate() is available only on web.")
        try:
            if (
                not isinstance(url, str)
                or not url
                or text_length(url) > 2048
                or re.search(r"[\s\x00-\x1f\x7f-\x9f\\]", url)
            ):
                raise ValueError
            parsed = urlsplit(url)
            if (
                parsed.scheme not in ("http", "https")
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
            ):
                raise ValueError
            _ = parsed.port
        except ValueError:
            raise VerifyError(
                "INVALID_ARGUMENT",
                "Navigation needs an HTTP(S) URL without credentials or controls.",
            ) from None
        response = self._worker(
            "POST",
            "open_url",
            {"url": url},
            deadline=Deadline(self._step_timeout, self._cancellation),
            timeout=self._step_timeout,
        )
        result = obj(response.json())
        status = result.get("status_code")
        if (
            not isinstance(result.get("success"), bool)
            or ("action" in result and result["action"] != "navigate")
            or ("status_code" in result and (type(status) is not int or not 100 <= status <= 599))
        ):
            raise VerifyError("API_ERROR", "Revyl returned an invalid navigation response.")
        if result["success"] is not True:
            raise VerifyError("ACTION_FAILED", "Revyl did not confirm web navigation.")

    def validation(
        self, text: str, *, timeout: float | None = None, soft: bool = False
    ) -> StepResult:
        if not isinstance(soft, bool):
            raise VerifyError("INVALID_ARGUMENT", "soft must be a boolean.")
        result = self._step("validation", text, timeout)
        if not result.passed and not soft:
            raise VerifyError(
                "VALIDATION_FAILED", "Validation failed. See " + self.viewer_url, result=result
            )
        return result

    def _step(
        self, kind: Literal["instruction", "validation"], text: str, timeout: float | None
    ) -> StepResult:
        if not isinstance(text, str) or not text.strip() or text_length(text) > 4000:
            raise VerifyError(
                "INVALID_ARGUMENT", "Step description must contain 1–4000 characters."
            )
        duration = seconds(
            self._step_timeout if timeout is None else timeout, 1, 3600, "Step timeout"
        )
        with self._lock:
            if self._step_running:
                raise VerifyError(
                    "INVALID_ARGUMENT", "Run one instruction or validation at a time on a session."
                )
            self._step_running = True
        deadline = Deadline(duration, self._cancellation)
        started = time.monotonic()
        step_id: str | None = None
        try:
            body: dict[str, Json] = {
                "step_type": kind,
                "step_description": text.strip(),
                "workflow_run_id": self._run_id,
            }
            if self.id:
                body["session_id"] = self.id
            outcome = obj(
                self._worker(
                    "POST", "execute_step", body, deadline=deadline, timeout=duration
                ).json()
            )
            if "success" not in outcome:
                accepted_id = outcome.get("step_id")
                if (
                    outcome.get("status") != "accepted"
                    or not isinstance(accepted_id, str)
                    or not accepted_id
                ):
                    raise VerifyError(
                        "API_ERROR", "Revyl returned neither a step result nor an accepted step ID."
                    )
                step_id = accepted_id
                backoff = 0.5
                while True:
                    deadline.pause(backoff)
                    backoff = min(backoff * 2, 5)
                    status = obj(
                        self._worker(
                            "GET",
                            "step_status/" + quote(step_id, safe=""),
                            deadline=deadline,
                            retry=True,
                        ).json()
                    )
                    state = status.get("status")
                    if state == "running":
                        continue
                    if state == "cancelled":
                        raise VerifyError(
                            "STEP_FAILED",
                            "Step was cancelled before finishing. See " + self.viewer_url,
                        )
                    if state not in ("completed", "failed"):
                        raise VerifyError("API_ERROR", "Revyl returned an unknown step status.")
                    outcome = obj(status.get("result"))
                    break
            success = outcome.get("success")
            if not isinstance(success, bool):
                raise VerifyError("API_ERROR", "Terminal step status has no readable result.")
            raw_output = outcome.get("step_output")
            output = {} if raw_output is None else obj(raw_output)
            for field in ("status", "status_reason", "reasoning"):
                if output.get(field) is not None and not isinstance(output[field], str):
                    raise VerifyError("API_ERROR", "Revyl returned an invalid step response.")
            if output.get("validation_result") is not None and not isinstance(
                output["validation_result"], bool
            ):
                raise VerifyError("API_ERROR", "Revyl returned an invalid step response.")
            verdict = output.get("validation_result")
            if kind == "validation" and (not success or not isinstance(verdict, bool)):
                raise VerifyError(
                    "STEP_FAILED", "Validation did not reach a verdict. See " + self.viewer_url
                )
            reason = output.get("status_reason") or output.get("reasoning")
            result = StepResult(
                kind,
                text.strip(),
                verdict is True
                if kind == "validation"
                else success and output.get("status") != "failed",
                reason if isinstance(reason, str) else None,
                time.monotonic() - started,
            )
            self.steps.append(result)
            return result
        except VerifyError as error:
            if error.code == "TIMEOUT" and step_id:
                try:
                    self._client.request(
                        "POST",
                        self._path("step_cancel/" + quote(step_id, safe="")),
                        {},
                        deadline=Deadline(5),
                        timeout=5,
                        worker=True,
                    )
                except VerifyError:
                    pass
            raise
        finally:
            with self._lock:
                self._step_running = False

    def screenshot(self, *, path: str | Path | None = None) -> bytes:
        response = self._worker(
            "GET", "screenshot", deadline=Deadline(95, self._cancellation), retry=True
        )
        png_size(response.body)
        return save_screenshot(response.body, path)

    def report(self) -> dict[str, Json]:
        if not self.id:
            raise VerifyError("NOT_FOUND", "No session ID is available to read its report.")
        return self._client.json(
            "GET",
            "/api/v1/execution/device-sessions/" + quote(self.id, safe=""),
            deadline=Deadline(95),
            retry=True,
        )

    def close(self) -> None:
        self._close_with_deadline(None)

    def _close_with_deadline(self, deadline: Deadline | None) -> None:
        if deadline is None:
            self._close_lock.acquire()
        elif not self._close_lock.acquire(timeout=deadline.remaining()):
            raise VerifyError("TIMEOUT", "Session cleanup exceeded its deadline.")
        try:
            if self._closed:
                if self._close_error:
                    raise self._close_error
                return
            try:
                self._closed = True
                self._cancellation.cancel()
                path = (
                    "/api/v1/execution/device/sessions/" + quote(self.id, safe="") + "/stop"
                    if self.id
                    else "/api/v1/execution/device/status/cancel/" + quote(self._run_id, safe="")
                )
                if not self.id and not self._run_id:
                    raise VerifyError(
                        "ACTION_UNCERTAIN", "No session identity is available to request cleanup."
                    )
                result = self._client.json("POST", path, deadline=deadline or Deadline(30))
                response_id = result.get("session_id")
                if (
                    result.get("success") is not True
                    or result.get("request_accepted") is not True
                    or not isinstance(response_id, str)
                    or not UUID_PATTERN.fullmatch(response_id)
                    or (self.id and response_id != self.id)
                    or (not self.id and result.get("workflow_run_id") != self._run_id)
                    or result.get("status")
                    not in (
                        "queued",
                        "starting",
                        "running",
                        "verifying",
                        "stopping",
                        "validating",
                        "completed",
                        "failed",
                        "cancelled",
                        "timeout",
                    )
                ):
                    raise VerifyError(
                        "ACTION_UNCERTAIN", "Revyl did not acknowledge the stop request."
                    )
                if not self.id:
                    self.id = response_id
                    self.viewer_url += quote(response_id, safe="")
                self._cleanup_status = "acknowledged"
                self._log("stop acknowledged")
            except VerifyError as error:
                self._cleanup_status = "unconfirmed"
                self._close_error = error
                raise
            except BaseException:
                self._cleanup_status = "unconfirmed"
                self._close_error = VerifyError(
                    "ACTION_UNCERTAIN", "Session stop was interrupted; its outcome is unconfirmed."
                )
                raise
            finally:
                if self._close_error:
                    self._attach_failure(self._close_error)
                    self._log("stop unconfirmed")
                untrack(self)
        finally:
            self._close_lock.release()

    def _computer_only(self) -> NoReturn:
        raise VerifyError(
            "NOT_AVAILABLE_ON_PLATFORM",
            "This operation runs on computer targets, not web or mobile sessions.",
        )

    def exec(
        self, argv: list[str], *, stdin: bytes | str = b"", timeout: float = 30, check: bool = True
    ) -> ExecResult:
        self._computer_only()

    def read_file(self, path: str, *, timeout: float = 30) -> bytes:
        self._computer_only()

    def write_file(self, path: str, data: bytes | str, *, timeout: float = 30) -> None:
        self._computer_only()

    def stat(self, path: str, *, timeout: float = 30) -> FileStat:
        self._computer_only()

    def processes(self, *, timeout: float = 30) -> list[ComputerProcess]:
        self._computer_only()

    def terminate(self, handle_id: str, *, timeout: float = 30) -> None:
        self._computer_only()

    def recording(self) -> ComputerRecording | None:
        self._computer_only()


def _web_build(client: Client, target: Target, deadline: Deadline) -> str:
    if target.build_id:
        return target.build_id
    path = "/api/v1/apps/" + quote(target.app_id or "", safe="")
    if target.url:
        body: dict[str, Json] = {"url": target.url}
        if target.branch:
            body["branch_name"] = target.branch
        build = client.json("POST", path + "/builds/external", body, deadline=deadline, retry=True)
        build_id = build.get("id")
    else:
        query: list[tuple[str, str]] = [
            ("artifact_kinds", "web_external"),
            ("artifact_kinds", "web_bundle"),
            ("include_jobs", "false"),
            ("page", "1"),
            ("page_size", "1"),
        ]
        if target.branch:
            query.append(("branch_name", target.branch))
        else:
            detail = client.json("GET", path, deadline=deadline, retry=True)
            platform = detail.get("platform")
            if platform is not None and (
                not isinstance(platform, str) or platform.lower() != "web"
            ):
                raise VerifyError("CONFIG_INVALID", "Revyl app is not a web app.")
            branch_id = detail.get("default_branch_id")
            if isinstance(branch_id, str) and branch_id:
                query.append(("branch_id", branch_id))
        builds = client.json(
            "GET", path + "/builds?" + urlencode(query), deadline=deadline, retry=True
        )
        items = builds.get("items")
        build_id = obj(items[0]).get("id") if isinstance(items, list) and items else None
    if not isinstance(build_id, str) or not build_id:
        raise VerifyError(
            "SESSION_START_FAILED",
            "Revyl app has no web build. Set url or create a web build first.",
        )
    return build_id
