from __future__ import annotations

import base64
import json
import os
import re
import secrets
import socket
import sys
import threading
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from ._transport import (
    Cancellation,
    Deadline,
    Json,
    Response,
    VerifyError,
    obj,
    stored_or_env_token,
)

AUTH_PATH = "/api/v1/entity/users/cli-device-authorizations"
WHOAMI_PATH = "/api/v1/entity/users/get_user_uuid"
_sign_in_lock = threading.Lock()


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def interactive() -> bool:
    return (
        sys.stdin is not None
        and sys.stdin.isatty()
        and sys.stderr is not None
        and sys.stderr.isatty()
        and not os.environ.get("CI")
    )


def sign_in(backend: str, viewer: str, cancellation: Cancellation | None = None) -> str:
    with _sign_in_lock:
        existing = stored_or_env_token()
        if existing:
            return existing
        try:
            return _approve(backend, viewer, Deadline(600, cancellation))
        except VerifyError as error:
            if error.code != "TIMEOUT":
                raise
            raise VerifyError(
                "AUTH_MISSING",
                "Revyl sign-in was cancelled or timed out. "
                "Run your script again to sign in, or use revyl auth login.",
            ) from None


def _approve(backend: str, viewer: str, deadline: Deadline) -> str:
    label = " ".join(socket.gethostname().split())[:80] or "Revyl CLI"
    authorization = _call(
        backend,
        AUTH_PATH,
        {"client_instance_id": _client_instance_id(), "device_label": label},
        deadline,
    )
    device_code = _required(authorization, "device_code")
    user_code = _required(authorization, "user_code")
    url = _required(authorization, "verification_uri_complete")
    parsed = urlsplit(url)
    if (
        _origin(url) != _origin(viewer)
        or parsed.path != "/cli/device"
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise _invalid()
    expires_in, interval = authorization.get("expires_in"), authorization.get("interval")
    if (
        not isinstance(expires_in, int)
        or isinstance(expires_in, bool)
        or expires_in <= 0
        or not isinstance(interval, int)
        or isinstance(interval, bool)
        or interval < 0
    ):
        raise _invalid()
    deadline = deadline.cap(expires_in)
    wait = float(interval or 5)
    sys.stderr.write(
        f"Open this URL to approve, then confirm the code below:\n{url}\nCode: {user_code}\n"
        "Waiting for approval (Ctrl+C to cancel)...\n"
    )
    sys.stderr.flush()
    threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    while True:
        try:
            deadline.pause(wait)
        except VerifyError:
            if deadline.cancellation and deadline.cancellation.event.is_set():
                raise
            raise VerifyError(
                "AUTH_MISSING",
                "The Revyl login request expired. "
                "Run your script again to sign in, or use revyl auth login.",
            ) from None
        credential = _call(
            backend, f"{AUTH_PATH}/credentials", {"device_code": device_code}, deadline
        )
        state = credential.get("state")
        if state == "pending":
            wait = min(wait * 1.5, 15.0)
            continue
        if state == "denied":
            raise VerifyError(
                "AUTH_REJECTED",
                "The Revyl login request was denied. "
                "Run your script again to sign in, or use revyl auth login.",
            )
        if state != "approved":
            raise _invalid()
        token = _required(credential, "api_key_token")
        who = _call(backend, WHOAMI_PATH, None, deadline, token=token)
        concurrent = stored_or_env_token()
        if concurrent:
            try:
                _call(backend, WHOAMI_PATH, None, deadline, token=concurrent)
                return concurrent
            except VerifyError as error:
                if error.code != "AUTH_REJECTED":
                    raise
        key_id = _optional(credential, "api_key_id")
        stored: dict[str, Json] = (
            {"api_key": token, "api_key_id": key_id, "auth_method": "browser_api_key"}
            if key_id
            else {"access_token": token, "expires_at": _expiry(token), "auth_method": "browser"}
        )
        for field in ("email", "org_id", "user_id"):
            value = _optional(who, field) or _optional(credential, field)
            if value:
                stored[field] = value
        if os.environ.get("REVYL_API_KEY", "").strip():
            stored["local_auth_override"] = True
        _write_private_state("credentials.json", stored)
        return token


def _open_browser(url: str) -> None:
    try:
        opened = webbrowser.open(url)
    except webbrowser.Error:
        opened = False
    if not opened:
        sys.stderr.write("Open the URL above in your browser to finish signing in.\n")
        sys.stderr.flush()


def _call(
    backend: str,
    path: str,
    body: dict[str, Json] | None,
    deadline: Deadline,
    *,
    token: str | None = None,
) -> dict[str, Json]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "revyl-verify/0.4.2 python",
        "X-Revyl-Client": "verify",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(
        backend + path, data=data, headers=headers, method="GET" if body is None else "POST"
    )
    limit = deadline.cap(15.0)
    done = threading.Event()
    outcome: list[bytes | Exception] = []

    def fetch() -> None:
        try:
            with build_opener(_NoRedirects()).open(request, timeout=15.0) as response:
                outcome.append(response.read(1024 * 1024))
        except Exception as error:
            outcome.append(error)
        finally:
            done.set()

    threading.Thread(target=fetch, daemon=True).start()
    try:
        while not done.wait(min(0.25, limit.remaining())):
            pass
    except VerifyError:
        deadline.remaining()
        raise VerifyError(
            "AUTH_MISSING",
            "Could not reach Revyl to sign in. "
            "Run your script again, use revyl auth login, or set REVYL_API_KEY.",
        ) from None
    try:
        if isinstance(outcome[0], Exception):
            raise outcome[0]
        raw = outcome[0]
    except HTTPError as error:
        error.close()
        if error.code == 404 and token is None:
            raise VerifyError(
                "AUTH_MISSING",
                "The Revyl login request is unavailable or expired. "
                "Run your script again, or use revyl auth login.",
            ) from None
        raise VerifyError(
            "AUTH_REJECTED",
            f"Revyl sign-in failed (HTTP {error.code}). "
            "Run your script again, use revyl auth login, or set REVYL_API_KEY.",
            http_status=error.code,
        ) from None
    except (OSError, ValueError):
        deadline.remaining()
        raise VerifyError(
            "AUTH_MISSING",
            "Could not reach Revyl to sign in. "
            "Run your script again, use revyl auth login, or set REVYL_API_KEY.",
        ) from None
    try:
        return obj(Response(200, raw).json())
    except VerifyError:
        raise _invalid() from None


def _origin(raw: str) -> tuple[str, str, int | None]:
    parts = urlsplit(raw)
    try:
        port = parts.port
    except ValueError:
        raise _invalid() from None
    scheme = parts.scheme.lower()
    if port == {"https": 443, "http": 80}.get(scheme):
        port = None
    return scheme, parts.hostname or "", port


def _optional(value: dict[str, Json], key: str) -> str | None:
    text = value.get(key)
    if text is None:
        return None
    if not isinstance(text, str) or len(text) > 8192 or re.search(r"[\x00-\x1f\x7f]", text):
        raise _invalid()
    return text or None


def _required(value: dict[str, Json], key: str) -> str:
    text = _optional(value, key)
    if not text:
        raise _invalid()
    return text


def _invalid() -> VerifyError:
    return VerifyError(
        "AUTH_REJECTED",
        "Revyl returned an invalid sign-in response. "
        "Run your script again, use revyl auth login, or set REVYL_API_KEY.",
    )


def _expiry(token: str) -> str:
    try:
        part = token.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        expires = payload.get("exp") if isinstance(payload, dict) else None
        if not isinstance(expires, (int, float)) or isinstance(expires, bool) or expires <= 0:
            raise ValueError
        moment = datetime.fromtimestamp(int(expires), timezone.utc)
    except (IndexError, ValueError, OverflowError, OSError):
        moment = datetime.now(timezone.utc) + timedelta(minutes=30)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _client_instance_id() -> str:
    path = Path.home() / ".revyl" / "client-identity.json"
    try:
        identity = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        identity = None
    except OSError:
        raise VerifyError(
            "AUTH_MISSING", "Could not read the Revyl client identity. Check ~/.revyl permissions."
        ) from None
    value = identity.get("client_instance_id") if isinstance(identity, dict) else None
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        return value
    created = secrets.token_hex(16)
    _write_private_state("client-identity.json", {"client_instance_id": created})
    return created


def _write_private_state(name: str, value: dict[str, Json]) -> None:
    directory = Path.home() / ".revyl"
    destination = directory / name
    temporary = directory / f".{name}.{secrets.token_hex(16)}"
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir():
            raise OSError
        if os.name != "nt":
            directory.chmod(0o700)
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            raise OSError
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(value, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    except OSError:
        raise VerifyError(
            "AUTH_MISSING",
            "Could not save Revyl sign-in state. Use a writable, owner-only ~/.revyl directory.",
        ) from None
    finally:
        temporary.unlink(missing_ok=True)
