from __future__ import annotations

import base64
import binascii
import http.client
import json
import math
import os
import queue
import re
import socket
import ssl
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypeAlias, cast, get_args
from urllib.parse import urlsplit

from . import _cleanup

if TYPE_CHECKING:
    from ._models import Platform

CleanupStatus = Literal["not_attempted", "not_required", "acknowledged", "confirmed", "unconfirmed"]
RefusalReason = Literal[
    "web_runtime_unavailable",
    "web_runtime_not_configured",
    "computer_limit",
    "runtime_unavailable",
    "computer_runtime_unavailable",
    "computer_at_capacity",
    "computer_not_running",
    "computer_cannot_host_platform",
    "computer_not_found",
    "web_build_required",
    "web_build_not_supported",
    "ios_build_required",
    "ios_build_not_supported",
    "android_build_required",
    "android_build_not_supported",
    "web_session_conflict",
    "ios_session_conflict",
    "android_session_conflict",
    "not_available_on_platform",
    "request_timeout",
    "protocol_error",
]

Json: TypeAlias = "None | bool | int | float | str | list[Json] | dict[str, Json]"


class VerifyError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        result: object | None = None,
        reason: RefusalReason | None = None,
        http_status: int | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.result = result
        self.reason: RefusalReason | None = reason
        self.http_status: int | None = http_status
        self.platform: Platform | None = None
        self.session_id: str | None = None
        self.workflow_run_id: str | None = None
        self.viewer_url: str | None = None
        self.cleanup_status: CleanupStatus = "not_attempted"
        self.cleanup_error: VerifyError | None = None
        super().__init__(f"{code}: {message}")


def obj(value: Json) -> dict[str, Json]:
    if not isinstance(value, dict):
        raise VerifyError("API_ERROR", "Revyl returned an invalid JSON response.")
    return value


def timestamp(value: Json) -> datetime:
    try:
        if not isinstance(value, str):
            raise ValueError
        if not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value
        ):
            raise ValueError
        if value[-1] != "Z" and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
            raise ValueError
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return parsed
    except ValueError:
        raise VerifyError("API_ERROR", "Revyl returned an invalid timestamp.") from None


def decode_bytes(value: Json, limit: int) -> bytes:
    try:
        if not isinstance(value, str) or len(value) > 4 * ((limit + 2) // 3):
            raise ValueError
        normalized = value.replace("-", "+").replace("_", "/")
        decoded = base64.b64decode(normalized, validate=True)
        if len(decoded) > limit or base64.b64encode(decoded).decode() != normalized:
            raise ValueError
        return decoded
    except (ValueError, binascii.Error):
        raise VerifyError("API_ERROR", "Revyl returned invalid base64 data.") from None


def seconds(value: float, minimum: float, maximum: float, name: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise VerifyError(
            "INVALID_ARGUMENT", f"{name} must be between {minimum:g} and {maximum:g} seconds."
        )
    return value


class Cancellation:
    def __init__(self) -> None:
        self.event = threading.Event()
        self._lock = threading.Lock()
        self._callbacks: set[Callable[[], None]] = set()

    def cancel(self) -> None:
        with self._lock:
            self.event.set()
            callbacks = list(self._callbacks)
        for callback in callbacks:
            callback()

    def add(self, callback: Callable[[], None]) -> None:
        with self._lock:
            self._callbacks.add(callback)
            cancelled = self.event.is_set()
        if cancelled:
            callback()

    def remove(self, callback: Callable[[], None]) -> None:
        with self._lock:
            self._callbacks.discard(callback)


class Deadline:
    def __init__(self, seconds: float, cancellation: Cancellation | None = None) -> None:
        self.end = time.monotonic() + seconds
        self.cancellation = cancellation

    def remaining(self) -> float:
        remaining = self.end - time.monotonic()
        if remaining <= 0 or (self.cancellation and self.cancellation.event.is_set()):
            raise VerifyError("TIMEOUT", "Revyl operation exceeded its deadline or was cancelled.")
        return remaining

    def cap(self, seconds: float) -> Deadline:
        result = Deadline(seconds, self.cancellation)
        result.end = min(result.end, self.end)
        return result

    def pause(self, seconds: float) -> None:
        duration = min(seconds, self.remaining())
        if self.cancellation:
            self.cancellation.event.wait(duration)
        else:
            time.sleep(duration)
        self.remaining()


def _connect(host: str, port: int, secure: bool, deadline: Deadline) -> socket.socket:
    results: queue.Queue[tuple[socket.socket | None, Exception | None]] = queue.Queue()
    abandoned = threading.Event()
    lock = threading.Lock()

    def connect() -> None:
        sock: socket.socket | None = None
        try:
            sock = socket.create_connection((host, port), timeout=deadline.remaining())
            sock.settimeout(deadline.remaining())
            if secure:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            deadline.remaining()
            with lock:
                if not abandoned.is_set():
                    results.put((sock, None))
                    sock = None
        except Exception as error:
            results.put((None, error))
        finally:
            if sock is not None:
                sock.close()

    threading.Thread(target=connect, daemon=True).start()
    try:
        while True:
            try:
                sock, error = results.get(timeout=min(0.05, deadline.remaining()))
                if error:
                    raise error
                assert sock is not None
                return sock
            except queue.Empty:
                continue
    except BaseException:
        with lock:
            abandoned.set()
            try:
                sock, _ = results.get_nowait()
                if sock:
                    sock.close()
            except queue.Empty:
                pass
        raise


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes
    content_type: str = ""
    cf_ray: str = ""

    def json(self) -> Json:
        try:
            # JSON is the dynamic boundary; callers narrow each domain field before use.
            return cast(Json, json.loads(self.body, parse_constant=_invalid_constant))
        except (ValueError, UnicodeError, RecursionError):
            raise VerifyError("API_ERROR", "Revyl returned an invalid JSON response.") from None


def _invalid_constant(value: str) -> None:
    raise ValueError


def credentials() -> str:
    try:
        raw = (Path.home() / ".revyl" / "credentials.json").read_bytes()
    except FileNotFoundError:
        stored: dict[str, Json] = {}
    except OSError:
        raise VerifyError(
            "AUTH_MISSING", "Cannot read the Revyl CLI login. Run 'revyl auth login' again."
        ) from None
    else:
        try:
            stored = obj(Response(200, raw).json())
            for field in ("api_key", "access_token", "expires_at"):
                if field in stored and not isinstance(stored[field], str):
                    raise ValueError
            if "local_auth_override" in stored and not isinstance(
                stored["local_auth_override"], bool
            ):
                raise ValueError
        except (VerifyError, ValueError):
            raise VerifyError(
                "AUTH_MISSING",
                "Revyl CLI credentials are not valid JSON. Run 'revyl auth login' again.",
            ) from None
    api_key = stored.get("api_key")
    token = api_key if isinstance(api_key, str) else ""
    access = stored.get("access_token")
    expiry = stored.get("expires_at")
    if isinstance(access, str) and access:
        usable = not expiry
        if expiry:
            try:
                usable = timestamp(expiry) >= datetime.now(timezone.utc) + timedelta(minutes=1)
            except VerifyError:
                usable = False
        if usable:
            token = access
    key = os.environ.get("REVYL_API_KEY", "").strip()
    if (
        key
        and not key.startswith("${")
        and not (stored.get("local_auth_override") is True and token)
    ):
        token = key
    if not token:
        raise VerifyError(
            "AUTH_MISSING",
            "No Revyl credentials found. Set REVYL_API_KEY or run 'revyl auth login'.",
        )
    if any(ord(char) < 32 or ord(char) > 126 for char in token):
        raise VerifyError("AUTH_MISSING", "Revyl credentials contain invalid characters.")
    return token


def origin(raw: str, *, app: bool = False) -> str:
    message = (
        "App" if app else "Backend"
    ) + " URL must use HTTPS without credentials, query, or fragment (HTTP is allowed on loopback)."
    try:
        parsed = urlsplit(raw)
        _ = parsed.port
        if (
            not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or "?" in raw
            or "#" in raw
            or any(ord(c) <= 32 for c in raw)
        ):
            raise ValueError
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        ):
            raise ValueError
        return raw.rstrip("/") if app else f"{parsed.scheme}://{parsed.netloc}"
    except ValueError:
        raise VerifyError("CONFIG_INVALID", message) from None


def refusal_reason(response: Response) -> RefusalReason | None:
    try:
        raw = obj(response.json())
    except VerifyError:
        return None
    detail = raw.get("detail")
    candidates = (
        detail,
        detail.get("error") if isinstance(detail, dict) else None,
        raw.get("error"),
    )
    for value in candidates:
        if isinstance(value, str) and value in get_args(RefusalReason):
            return cast(RefusalReason, value)
    return None


def edge_blocked_error(response: Response) -> VerifyError | None:
    if (
        response.status != 403
        or response.content_type.split(";", 1)[0].strip().lower() != "text/html"
        or not response.cf_ray.strip()
    ):
        return None
    try:
        json.loads(response.body, parse_int=str, parse_float=str, parse_constant=_invalid_constant)
        return None
    except RecursionError:
        return None
    except (ValueError, UnicodeError):
        pass
    return VerifyError(
        "EDGE_BLOCKED",
        "Revyl request was blocked at the network edge (HTTP 403). "
        "Check network access or contact support. Verify will not retry this request.",
        http_status=response.status,
    )


def http_error(response: Response, *, hosted: bool = False) -> VerifyError:
    blocked = edge_blocked_error(response)
    if blocked is not None:
        return blocked
    reason = refusal_reason(response)
    code = "AUTH_REJECTED" if response.status in (401, 403) else "API_ERROR"
    if hosted and response.status not in (401, 403):
        if reason in {
            "web_runtime_unavailable",
            "web_runtime_not_configured",
            "runtime_unavailable",
            "computer_runtime_unavailable",
            "computer_cannot_host_platform",
            "not_available_on_platform",
        }:
            code = "NOT_AVAILABLE_ON_PLATFORM"
        elif reason in {"computer_at_capacity", "computer_limit"}:
            code = "COMPUTER_LIMIT"
        elif reason == "computer_not_running":
            code = "SESSION_ENDED"
        elif reason == "computer_not_found" or response.status == 404:
            code = "NOT_FOUND"
        elif reason is not None and "_build_" in reason:
            code = "INVALID_ARGUMENT"
        elif reason is not None and reason.endswith("_session_conflict"):
            code = "SESSION_BUSY"
        elif response.status in (400, 422):
            code = "INVALID_ARGUMENT"
        elif response.status == 409:
            code = "SESSION_BUSY"
        elif response.status == 408 or response.status >= 500:
            code = "ACTION_UNCERTAIN"
    return VerifyError(
        code,
        f"Revyl request failed (HTTP {response.status}).",
        reason=reason,
        http_status=response.status,
    )


class Client:
    def __init__(self, backend_url: str | None = None) -> None:
        self._token = credentials()
        self.base = origin(
            backend_url or os.environ.get("REVYL_BACKEND_URL") or "https://backend.revyl.ai"
        )

    def request(
        self,
        method: str,
        path: str,
        body: Json = None,
        *,
        deadline: Deadline,
        timeout: float = 30,
        retry: bool = False,
        worker: bool = False,
    ) -> Response:
        for attempt in range(3):
            try:
                response = self._once(method, path, body, deadline.cap(timeout), worker)
            except VerifyError:
                if not retry or attempt == 2:
                    raise
            else:
                if not retry or response.status not in (502, 503, 504) or attempt == 2:
                    return response
            deadline.pause((0.5, 1.5)[min(attempt, 1)])
        raise AssertionError("unreachable")

    def _once(
        self, method: str, path: str, body: Json, deadline: Deadline, worker: bool
    ) -> Response:
        parsed = urlsplit(self.base)
        connection_type = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        connection = connection_type(
            parsed.hostname or "", parsed.port, timeout=deadline.remaining()
        )
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
            "User-Agent": "revyl-verify/0.1.0 python",
            "X-Revyl-Client": "verify",
        }
        if worker:
            headers["X-Revyl-Agent"] = "Verify"
        if method == "POST" and path.endswith("/operations"):
            headers["Prefer"] = "respond-async"
        encoded = None if body is None else json.dumps(body, allow_nan=False).encode()
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        limit = (
            4 * ((128 * 1024 * 1024 + 2) // 3) + 4096
            if path.endswith("/screen/screenshot")
            else 16 * 1024 * 1024
        )
        connected_socket: socket.socket | None = None

        def interrupt() -> None:
            sock = connected_socket or connection.sock
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        timer = None
        if not _cleanup.shutting_down:
            timer = threading.Timer(deadline.remaining(), interrupt)
            timer.daemon = True
            timer.start()
        if deadline.cancellation:
            deadline.cancellation.add(interrupt)
        try:
            if _cleanup.shutting_down:
                connection.connect()
            else:
                connection.sock = _connect(
                    parsed.hostname or "",
                    parsed.port or (443 if parsed.scheme == "https" else 80),
                    parsed.scheme == "https",
                    deadline,
                )
            connected_socket = connection.sock
            deadline.remaining()
            connection.request(method, path, encoded, headers)
            if connection.sock is not None:
                connection.sock.settimeout(deadline.remaining())
            response = connection.getresponse()
            chunks: list[bytes] = []
            length = 0
            while True:
                if connection.sock is not None:
                    connection.sock.settimeout(deadline.remaining())
                chunk = response.read1(min(65536, limit + 1 - length))
                deadline.remaining()
                if not chunk:
                    if response.length not in (None, 0):
                        raise VerifyError("API_ERROR", "Could not read the Revyl response.")
                    break
                chunks.append(chunk)
                length += len(chunk)
                if length > limit:
                    raise VerifyError(
                        "API_ERROR", "Revyl response exceeds the response size limit."
                    )
            return Response(
                response.status,
                b"".join(chunks),
                response.getheader("Content-Type", ""),
                response.getheader("Cf-Ray", ""),
            )
        except TimeoutError:
            raise VerifyError("TIMEOUT", "Revyl HTTP client timed out.") from None
        except (OSError, http.client.HTTPException, ValueError):
            deadline.remaining()
            raise VerifyError(
                "API_ERROR",
                "Could not reach Revyl; the request was not replayed unless it is safe to retry.",
            ) from None
        finally:
            if deadline.cancellation:
                deadline.cancellation.remove(interrupt)
            if timer is not None:
                timer.cancel()
            connection.close()

    def json(
        self,
        method: str,
        path: str,
        body: Json = None,
        *,
        deadline: Deadline,
        retry: bool = False,
        timeout: float = 30,
    ) -> dict[str, Json]:
        response = self.request(method, path, body, deadline=deadline, retry=retry, timeout=timeout)
        if not 200 <= response.status < 300:
            raise http_error(response)
        return obj(response.json())
