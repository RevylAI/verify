from __future__ import annotations

import asyncio
import base64
import os
import signal
import socket
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast
from uuid import UUID

import pytest
from test_async import event_is_set
from test_computer import ComputerAPI
from test_device import (
    APP_ID,
    BUILD_ID,
    PROXY,
    SESSION_ID,
    START,
    FakeRevyl,
    Reply,
    Request,
    fast_pause,
    isolated_environment,
)

import revyl_verify as verify
from revyl_verify import AsyncSession, Session, Target, VerifyError
from revyl_verify._models import Platform
from revyl_verify._transport import Cancellation, Client, Deadline, Json, Response, obj

__all__ = ["fast_pause", "isolated_environment"]

VIEWER = "https://viewer.test"
COMPUTERS = "/api/v1/computer-runs"
CANCEL = "/api/v1/execution/device/status/cancel/run-1"
SECRET = "fixture-token-do-not-log"
RAW_URL = f"https://untrusted.example.test/private?token={SECRET}"
STEP_TEXT = "private instruction content that must not be logged"
PLATFORMS: tuple[Platform, ...] = ("web", "ios", "android", "mac", "linux")
MOBILE: tuple[Platform, ...] = ("ios", "android")
COMPUTER_PLATFORMS: tuple[Platform, ...] = ("mac", "linux")


class StartupAPI(FakeRevyl):
    def default(self, request: Request) -> Reply:
        response = super().default(request)
        if request.method == "POST" and (request.path.endswith("/stop") or request.path == CANCEL):
            assert isinstance(response.body, dict)
            response.body = {**response.body, "message": RAW_URL}
        return response


@pytest.fixture
def device_api(isolated_environment: None) -> Iterator[StartupAPI]:
    api = StartupAPI()
    try:
        yield api
    finally:
        api.finish()
        assert not api.errors


@pytest.fixture
def computer_api(isolated_environment: None) -> Iterator[ComputerAPI]:
    api = ComputerAPI()
    try:
        yield api
    finally:
        api.close()


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def asynchronous(request: pytest.FixtureRequest) -> bool:
    return cast(bool, request.param)


def target(platform: Platform, *, start_timeout: float = 600) -> Target:
    if platform in COMPUTER_PLATFORMS:
        return Target(platform=platform, start_timeout=start_timeout)
    return Target(
        platform=platform,
        app_id=APP_ID,
        build_id=BUILD_ID if platform == "web" else None,
        start_timeout=start_timeout,
    )


def open_session(
    asynchronous: bool,
    selected: Target,
    backend: str,
    log: Callable[[str], None],
) -> Session | AsyncSession:
    if asynchronous:
        return asyncio.run(
            verify.async_open(selected, backend_url=backend, app_url=VIEWER, log=log)
        )
    return verify.open(selected, backend_url=backend, app_url=VIEWER, log=log)


def close_session(session: Session | AsyncSession) -> None:
    if isinstance(session, AsyncSession):
        asyncio.run(session.close())
    else:
        session.close()


def device_stops(api: FakeRevyl) -> list[Request]:
    return [request for request in api.requests if request.path.endswith("/stop")]


def computer_stops(api: ComputerAPI) -> list[tuple[str, str, Json]]:
    return [call for call in api.calls if call[1].endswith("/stop")]


def assert_private_logs(logs: list[str]) -> None:
    rendered = "\n".join(logs)
    for private in (SECRET, RAW_URL, STEP_TEXT, "test-token", "wss://worker.test"):
        assert private not in rendered


def assert_identity(error: VerifyError, platform: Platform, session_id: str | None) -> None:
    assert error.platform == platform
    assert error.session_id == session_id
    expected = f"{VIEWER}/sessions/{session_id}" if session_id else None
    if expected and platform in COMPUTER_PLATFORMS:
        expected += "?kind=computer"
    assert error.viewer_url == expected


def lose_response(monkeypatch: pytest.MonkeyPatch, server: ThreadingHTTPServer, path: str) -> None:
    handler_class = cast(type[BaseHTTPRequestHandler], server.RequestHandlerClass)
    original = handler_class.end_headers

    def end_headers(handler: BaseHTTPRequestHandler) -> None:
        if handler.path == path:
            handler.close_connection = True
            handler.connection.shutdown(socket.SHUT_RDWR)
            return
        original(handler)

    monkeypatch.setattr(handler_class, "end_headers", end_headers)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_success_logs_in_order_and_close_is_not_replayed(
    asynchronous: bool,
    platform: Platform,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
) -> None:
    logs: list[str] = []
    before_create: list[list[str]] = []
    callback_threads: list[int] = []
    caller_thread = threading.get_ident()

    def log(message: str) -> None:
        callback_threads.append(threading.get_ident())
        logs.append(message)

    def device_handler(request: Request) -> Reply | None:
        if request.path == START:
            before_create.append(list(logs))
        if request.path == PROXY + "execute_step":
            return Reply(
                body={
                    "success": True,
                    "step_output": {"status": "success", "status_reason": RAW_URL},
                }
            )
        return None

    def computer_handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path == COMPUTERS:
            before_create.append(list(logs))
        return None

    device_api.handler = device_handler
    computer_api.override = computer_handler
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    session = open_session(asynchronous, target(platform), backend, log)
    try:
        assert before_create and len(before_create[0]) == 1
        assert "starting" in before_create[0][0]
        if platform not in MOBILE:
            assert session.id in before_create[0][0]
        assert logs[-1] == f"{platform}: ready"
        if platform in MOBILE:
            assert session.id in logs[1]
        if platform in COMPUTER_PLATFORMS:
            computer_api.result = {
                "kind": "exec",
                "exit_code": 0,
                "stdout": base64.b64encode(RAW_URL.encode()).decode(),
                "stderr": "",
            }
            if isinstance(session, AsyncSession):
                asyncio.run(session.exec(["echo", STEP_TEXT]))
            else:
                session.exec(["echo", STEP_TEXT])
        elif isinstance(session, AsyncSession):
            asyncio.run(session.instruction(STEP_TEXT))
        else:
            session.instruction(STEP_TEXT)
    finally:
        close_session(session)
    expected = (
        "physical release confirmed" if platform in COMPUTER_PLATFORMS else "stop acknowledged"
    )
    assert logs[-1] == f"{platform}: {expected}"
    settled_logs = list(logs)
    close_session(session)
    assert logs == settled_logs
    assert session.closed
    if platform in COMPUTER_PLATFORMS:
        assert len([call for call in computer_api.calls if call[1] == COMPUTERS]) == 1
        assert len(computer_stops(computer_api)) == 1
    else:
        assert len(device_api.calls("POST", START)) == 1
        assert len(device_stops(device_api)) == 1
    assert callback_threads
    assert all((thread != caller_thread) == asynchronous for thread in callback_threads)
    assert_private_logs(logs)


@pytest.mark.parametrize("response_kind", ["lost", "malformed", "truncated"])
def test_web_create_failure_keeps_proposed_id_and_cleans_up_once(
    asynchronous: bool,
    response_kind: str,
    device_api: StartupAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []

    def handler(request: Request) -> Reply | None:
        if request.path != START:
            return None
        assert str(request.body["session_id"]) in "\n".join(logs)
        if response_kind == "malformed":
            return Reply(body=b"{not-json")
        if response_kind == "truncated":
            return Reply(body=b"{}", headers={"Content-Length": "100"})
        return None

    device_api.handler = handler
    if response_kind == "lost":
        lose_response(monkeypatch, device_api.server, START)
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target("web"), device_api.url, logs.append)
    starts = device_api.calls("POST", START)
    assert len(starts) == 1
    proposed_id = starts[0].body["session_id"]
    assert isinstance(proposed_id, str)
    UUID(proposed_id)
    assert_identity(caught.value, "web", proposed_id)
    assert caught.value.code == "API_ERROR"
    assert caught.value.cleanup_status == "acknowledged"
    assert caught.value.cleanup_error is None
    assert [call.path for call in device_stops(device_api)] == [
        f"/api/v1/execution/device/sessions/{proposed_id}/stop"
    ]
    assert "stop acknowledged" in logs[-2]
    assert logs[-1] == "web: startup failed; cleanup acknowledged"
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", MOBILE)
def test_mobile_missing_run_id_retains_returned_session_and_stops(
    asynchronous: bool, platform: Platform, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    device_api.handler = lambda request: (
        Reply(body={"session_id": SESSION_ID}) if request.path == START else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), device_api.url, logs.append)
    assert_identity(caught.value, platform, SESSION_ID)
    assert caught.value.code == "SESSION_START_FAILED"
    assert caught.value.workflow_run_id is None
    assert caught.value.cleanup_status == "acknowledged"
    assert caught.value.cleanup_error is None
    assert len(device_api.calls("POST", START)) == len(device_stops(device_api)) == 1
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", MOBILE)
def test_mobile_run_only_failure_cancels_without_inventing_session(
    asynchronous: bool, platform: Platform, device_api: StartupAPI
) -> None:
    logs: list[str] = []

    def handler(request: Request) -> Reply | None:
        if request.path == START:
            return Reply(body={"workflow_run_id": "run-1"})
        if "/worker-connection/" in request.path:
            return Reply(body={"status": "failed", "detail": RAW_URL})
        return None

    device_api.handler = handler
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), device_api.url, logs.append)
    assert_identity(caught.value, platform, SESSION_ID)
    assert caught.value.code == "SESSION_START_FAILED"
    assert caught.value.workflow_run_id == "run-1"
    assert caught.value.cleanup_status == "acknowledged"
    assert len(device_api.calls("POST", CANCEL)) == 1
    assert not device_stops(device_api)
    assert len(device_api.calls("POST", START)) == 1
    assert "run-1" in logs[1]
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", MOBILE)
def test_lost_mobile_create_response_has_unknown_cleanup_not_an_invented_id(
    asynchronous: bool,
    platform: Platform,
    device_api: StartupAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []
    lose_response(monkeypatch, device_api.server, START)
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), device_api.url, logs.append)
    assert_identity(caught.value, platform, None)
    assert caught.value.workflow_run_id is None
    assert caught.value.cleanup_status == "unconfirmed"
    assert caught.value.cleanup_error is None
    assert len(device_api.calls("POST", START)) == 1
    assert len([request for request in device_api.requests if request.method == "POST"]) == 1
    assert all("/sessions/" not in message for message in logs)
    assert_private_logs(logs)


def test_wrong_web_acknowledgment_never_stops_foreign_session(
    asynchronous: bool, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    device_api.handler = lambda request: (
        Reply(body={"session_id": SESSION_ID, "detail": RAW_URL}) if request.path == START else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target("web"), device_api.url, logs.append)
    proposed_id = device_api.calls("POST", START)[0].body["session_id"]
    assert isinstance(proposed_id, str) and proposed_id != SESSION_ID
    assert_identity(caught.value, "web", proposed_id)
    assert caught.value.code == "SESSION_START_FAILED"
    assert caught.value.cleanup_status == "acknowledged"
    assert [call.path for call in device_stops(device_api)] == [
        f"/api/v1/execution/device/sessions/{proposed_id}/stop"
    ]
    assert SESSION_ID not in "\n".join(logs)
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("cleanup_fails", [False, True], ids=["cleanup-ok", "cleanup-fails"])
def test_readiness_failure_preserves_original_error_and_cleanup_outcome(
    asynchronous: bool,
    platform: Platform,
    cleanup_fails: bool,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
    fast_pause: None,
) -> None:
    logs: list[str] = []

    def device_handler(request: Request) -> Reply | None:
        if request.path.endswith("/stop") and cleanup_fails:
            return Reply(503, {"detail": RAW_URL})
        if "/device-sessions/" in request.path or "/worker-connection/" in request.path:
            return Reply(body={"status": "failed", "detail": RAW_URL})
        return None

    def computer_handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path.endswith("/stop") and cleanup_fails:
            return 503, {"detail": RAW_URL}
        return None

    device_api.handler = device_handler
    computer_api.create_state = "failed"
    computer_api.override = computer_handler
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), backend, logs.append)
    error = caught.value
    if platform in COMPUTER_PLATFORMS:
        session_id = computer_api.id
        assert len(computer_stops(computer_api)) == 1
    else:
        session_id = (
            str(device_api.calls("POST", START)[0].body["session_id"])
            if platform == "web"
            else SESSION_ID
        )
        assert len(device_stops(device_api)) == 1
    assert_identity(error, platform, session_id)
    assert error.code == "SESSION_START_FAILED"
    expected_status = (
        "unconfirmed"
        if cleanup_fails
        else "confirmed"
        if platform in COMPUTER_PLATFORMS
        else "acknowledged"
    )
    assert error.cleanup_status == expected_status
    assert (error.cleanup_error is not None) == cleanup_fails
    if error.cleanup_error is not None:
        assert error.cleanup_error is not error
    assert logs[-1] == f"{platform}: startup failed; cleanup {expected_status}"
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", ("web", "ios", "android"))
def test_definite_device_auth_refusal_does_not_stop(
    asynchronous: bool, platform: Platform, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    device_api.handler = lambda request: (
        Reply(401, {"detail": RAW_URL}) if request.path == START else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), device_api.url, logs.append)
    proposed_id = device_api.calls("POST", START)[0].body.get("session_id")
    assert proposed_id is None or isinstance(proposed_id, str)
    assert_identity(caught.value, platform, proposed_id)
    assert caught.value.code == "AUTH_REJECTED"
    assert caught.value.cleanup_status == "not_required"
    assert caught.value.cleanup_error is None
    assert len([request for request in device_api.requests if request.method == "POST"]) == 1
    if proposed_id:
        assert proposed_id in logs[0]
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", COMPUTER_PLATFORMS)
@pytest.mark.parametrize(
    ("status", "detail", "code"),
    [
        (401, "unauthenticated", "AUTH_REJECTED"),
        (403, "computer_not_enabled", "NOT_AVAILABLE_ON_PLATFORM"),
        (429, "computer_limit", "COMPUTER_LIMIT"),
        (503, "runtime_unavailable", "NOT_AVAILABLE_ON_PLATFORM"),
    ],
)
def test_definite_computer_refusal_logs_id_but_never_stops(
    asynchronous: bool,
    platform: Platform,
    status: int,
    detail: str,
    code: str,
    computer_api: ComputerAPI,
) -> None:
    logs: list[str] = []
    computer_api.override = lambda method, path, body: (
        (status, {"detail": detail, "message": RAW_URL}) if path == COMPUTERS else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(
            asynchronous,
            target(platform),
            f"http://127.0.0.1:{computer_api.server.server_port}",
            logs.append,
        )
    assert len(computer_api.calls) == 1
    session_id = obj(computer_api.calls[0][2])["computer_session_id"]
    assert isinstance(session_id, str)
    assert_identity(caught.value, platform, session_id)
    assert caught.value.code == code
    assert caught.value.cleanup_status == "not_required"
    assert caught.value.cleanup_error is None
    assert session_id in logs[0]
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", COMPUTER_PLATFORMS)
@pytest.mark.parametrize("response_kind", ["lost", "malformed", "truncated"])
def test_computer_create_failure_stops_known_uuid_without_replay(
    asynchronous: bool,
    platform: Platform,
    response_kind: str,
    computer_api: ComputerAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []

    def handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path != COMPUTERS:
            return None
        session_id = obj(body)["computer_session_id"]
        assert isinstance(session_id, str) and session_id in "\n".join(logs)
        computer_api.id = session_id
        if response_kind == "malformed":
            return 200, [RAW_URL]
        return None

    computer_api.override = handler
    if response_kind == "lost":
        lose_response(monkeypatch, computer_api.server, COMPUTERS)
    elif response_kind == "truncated":
        computer_api.truncated_paths.add(COMPUTERS)
    with pytest.raises(VerifyError) as caught:
        open_session(
            asynchronous,
            target(platform),
            f"http://127.0.0.1:{computer_api.server.server_port}",
            logs.append,
        )
    UUID(computer_api.id)
    assert_identity(caught.value, platform, computer_api.id)
    assert caught.value.workflow_run_id is None
    assert caught.value.cleanup_status == "confirmed"
    assert caught.value.cleanup_error is None
    assert len([call for call in computer_api.calls if call[1] == COMPUTERS]) == 1
    assert [call[1] for call in computer_stops(computer_api)] == [
        f"{COMPUTERS}/{computer_api.id}/stop"
    ]
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_start_timeout_retains_identity_and_cleanup_result(
    asynchronous: bool,
    platform: Platform,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []
    original = Deadline.__init__

    def short_start(
        self: Deadline, seconds: float, cancellation: Cancellation | None = None
    ) -> None:
        original(self, 0.05 if seconds == 10 else seconds, cancellation)

    monkeypatch.setattr(Deadline, "__init__", short_start)
    device_api.handler = lambda request: (
        Reply(body={"status": "starting"})
        if "/device-sessions/" in request.path or "/worker-connection/" in request.path
        else None
    )
    computer_api.create_state = "starting"
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform, start_timeout=10), backend, logs.append)
    session_id = (
        computer_api.id
        if platform in COMPUTER_PLATFORMS
        else str(device_api.calls("POST", START)[0].body["session_id"])
        if platform == "web"
        else SESSION_ID
    )
    assert_identity(caught.value, platform, session_id)
    assert caught.value.code == "TIMEOUT"
    assert caught.value.cleanup_status == (
        "confirmed" if platform in COMPUTER_PLATFORMS else "acknowledged"
    )
    assert caught.value.cleanup_error is None
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("fail_start", [False, True])
def test_callback_exception_does_not_change_result_or_prevent_cleanup(
    asynchronous: bool,
    platform: Platform,
    fail_start: bool,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
) -> None:
    logs: list[str] = []

    def log(message: str) -> None:
        logs.append(message)
        raise RuntimeError(SECRET)

    if fail_start:
        computer_api.create_state = "failed"
        device_api.handler = lambda request: (
            Reply(body={"status": "failed"})
            if "/device-sessions/" in request.path or "/worker-connection/" in request.path
            else None
        )
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    if fail_start:
        with pytest.raises(VerifyError) as caught:
            open_session(asynchronous, target(platform), backend, log)
        assert caught.value.code == "SESSION_START_FAILED"
        assert caught.value.cleanup_status == (
            "confirmed" if platform in COMPUTER_PLATFORMS else "acknowledged"
        )
        assert caught.value.cleanup_error is None
    else:
        session = open_session(asynchronous, target(platform), backend, log)
        close_session(session)
        close_session(session)
    assert len(logs) >= 3
    assert (
        len(
            computer_stops(computer_api)
            if platform in COMPUTER_PLATFORMS
            else device_stops(device_api)
        )
        == 1
    )
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", MOBILE)
@pytest.mark.parametrize("field", ["session_id", "workflow_run_id"])
@pytest.mark.parametrize(
    "invalid_id", [RAW_URL, "../foreign", "\nforged-log-line", "x" * 256, 1, True, {}, []]
)
def test_invalid_mobile_identifier_is_never_logged_or_used_for_cleanup(
    asynchronous: bool,
    platform: Platform,
    field: str,
    invalid_id: Json,
    device_api: StartupAPI,
) -> None:
    logs: list[str] = []
    acknowledgment: dict[str, Json] = {
        "session_id": SESSION_ID,
        "workflow_run_id": "run-1",
        field: invalid_id,
    }
    device_api.handler = lambda request: (
        Reply(body=acknowledgment) if request.path == START else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), device_api.url, logs.append)
    error = caught.value
    assert error.code == "SESSION_START_FAILED"
    assert error.cleanup_status == "acknowledged"
    assert_identity(error, platform, SESSION_ID)
    assert error.workflow_run_id == ("run-1" if field == "session_id" else None)
    mutations = [request.path for request in device_api.requests if request.method == "POST"]
    expected_stop = (
        f"/api/v1/execution/device/sessions/{SESSION_ID}/stop"
        if field == "workflow_run_id"
        else CANCEL
    )
    assert mutations == [START, expected_stop]
    if isinstance(invalid_id, str):
        assert invalid_id not in "\n".join(logs)
    assert_private_logs(logs)


@pytest.mark.parametrize("invalid_id", [RAW_URL, "../foreign", "\nforged-log-line", "x" * 256])
def test_invalid_web_readiness_run_id_is_rejected_before_proxy_or_cleanup_use(
    asynchronous: bool, invalid_id: str, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    device_api.handler = lambda request: (
        Reply(body={"status": "running", "workflow_run_id": invalid_id})
        if "/device-sessions/" in request.path
        else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target("web"), device_api.url, logs.append)
    proposed_id = device_api.calls("POST", START)[0].body["session_id"]
    assert isinstance(proposed_id, str)
    assert_identity(caught.value, "web", proposed_id)
    assert caught.value.code == "API_ERROR"
    assert caught.value.workflow_run_id is None
    assert caught.value.cleanup_status == "acknowledged"
    assert not any("/device-proxy/" in request.path for request in device_api.requests)
    assert len(device_stops(device_api)) == 1
    assert invalid_id not in "\n".join(logs)
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("response_kind", ["malformed", "negative", "foreign-id", "http503"])
def test_invalid_stop_response_is_unconfirmed_and_repeated_close_does_not_resubmit(
    asynchronous: bool,
    platform: Platform,
    response_kind: str,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
) -> None:
    logs: list[str] = []
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    session = open_session(asynchronous, target(platform), backend, logs.append)

    def device_handler(request: Request) -> Reply | None:
        if not request.path.endswith("/stop"):
            return None
        if response_kind == "http503":
            return Reply(503, {"detail": RAW_URL})
        if response_kind == "malformed":
            return Reply(body=b"{invalid")
        return Reply(
            body={
                "success": response_kind != "negative",
                "request_accepted": response_kind != "negative",
                "session_id": (
                    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
                    if response_kind == "foreign-id"
                    else session.id
                ),
                "status": "stopping",
                "message": RAW_URL,
            }
        )

    def computer_handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if not path.endswith("/stop"):
            return None
        if response_kind == "http503":
            return 503, {"detail": RAW_URL}
        if response_kind == "malformed":
            return 200, [RAW_URL]
        return 200, {
            "computer_session_id": (
                "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
                if response_kind == "foreign-id"
                else session.id
            ),
            "state": "stopped",
            "release": "pending" if response_kind == "negative" else "confirmed",
        }

    device_api.handler = device_handler
    computer_api.override = computer_handler
    with pytest.raises(VerifyError) as first:
        close_session(session)
    assert_identity(first.value, platform, session.id)
    assert first.value.cleanup_status == "unconfirmed"
    assert first.value.cleanup_error is None
    settled_logs = list(logs)
    with pytest.raises(VerifyError) as repeated:
        close_session(session)
    assert repeated.value is first.value
    assert logs == settled_logs
    assert (
        len(
            computer_stops(computer_api)
            if platform in COMPUTER_PLATFORMS
            else device_stops(device_api)
        )
        == 1
    )
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
@pytest.mark.parametrize("typed_error", [False, True])
def test_context_preserves_body_error_and_chains_cleanup_failure(
    asynchronous: bool,
    platform: Platform,
    typed_error: bool,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
) -> None:
    logs: list[str] = []
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    session = open_session(asynchronous, target(platform), backend, logs.append)
    device_api.handler = lambda request: (
        Reply(body={"success": False}) if request.path.endswith("/stop") else None
    )
    computer_api.release = "pending"
    body_error = VerifyError("BODY_FAILED", STEP_TEXT) if typed_error else ValueError(STEP_TEXT)

    async def async_body() -> None:
        assert isinstance(session, AsyncSession)
        async with session:
            raise body_error

    with pytest.raises(type(body_error)) as caught:
        if isinstance(session, AsyncSession):
            asyncio.run(async_body())
        else:
            with session:
                raise body_error
    assert caught.value is body_error
    cleanup_error = body_error.__cause__
    assert isinstance(cleanup_error, VerifyError)
    if isinstance(body_error, VerifyError):
        assert_identity(body_error, platform, session.id)
        assert body_error.code == "BODY_FAILED"
        assert body_error.cleanup_status == "unconfirmed"
        assert body_error.cleanup_error is cleanup_error
    with pytest.raises(VerifyError) as repeated:
        close_session(session)
    assert repeated.value is cleanup_error
    assert (
        len(
            computer_stops(computer_api)
            if platform in COMPUTER_PLATFORMS
            else device_stops(device_api)
        )
        == 1
    )
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_cancelled_async_start_stops_before_readiness_handler_is_released(
    platform: Platform,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
    fast_pause: None,
) -> None:
    entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
    logs: list[str] = []

    def device_handler(request: Request) -> Reply | None:
        if request.path.endswith("/stop"):
            stopped.set()
        elif "/device-sessions/" in request.path or "/worker-connection/" in request.path:
            entered.set()
            assert release.wait(5)
        return None

    def computer_handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path.endswith("/stop"):
            stopped.set()
        elif path.endswith("/report"):
            entered.set()
            assert release.wait(5)
        return None

    device_api.handler = device_handler
    computer_api.create_state = "starting"
    computer_api.override = computer_handler
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )

    async def run() -> None:
        opening = asyncio.create_task(
            verify.async_open(
                target(platform), backend_url=backend, app_url=VIEWER, log=logs.append
            )
        )
        try:
            await event_is_set(entered)
            opening.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(opening, timeout=0.5)
            await event_is_set(stopped)
            assert not release.is_set()
        finally:
            release.set()

    asyncio.run(run())
    assert (
        len(
            computer_stops(computer_api)
            if platform in COMPUTER_PLATFORMS
            else device_stops(device_api)
        )
        == 1
    )
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", COMPUTER_PLATFORMS)
def test_computer_refusal_retains_code_when_deadline_expires_after_response(
    asynchronous: bool,
    platform: Platform,
    computer_api: ComputerAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []
    original = Client.request
    computer_api.override = lambda method, path, body: (
        (429, {"detail": "computer_limit"}) if path == COMPUTERS else None
    )

    def expire_after_response(
        self: Client,
        method: str,
        path: str,
        body: Json = None,
        *,
        deadline: Deadline,
        timeout: float = 30,
        retry: bool = False,
        worker: bool = False,
    ) -> Response:
        response = original(
            self, method, path, body, deadline=deadline, timeout=timeout, retry=retry, worker=worker
        )
        if path == COMPUTERS:
            deadline.end = 0
        return response

    monkeypatch.setattr(Client, "request", expire_after_response)
    with pytest.raises(VerifyError) as caught:
        open_session(
            asynchronous,
            target(platform),
            f"http://127.0.0.1:{computer_api.server.server_port}",
            logs.append,
        )
    assert caught.value.code == "COMPUTER_LIMIT"
    assert caught.value.cleanup_status == "not_required"
    assert len(computer_api.calls) == 1
    assert caught.value.session_id is not None
    assert caught.value.session_id in logs[0]
    assert_private_logs(logs)


@pytest.mark.parametrize("custom_handler", [False, True], ids=["default-handler", "custom-handler"])
def test_sigterm_cleanup_in_child_respects_existing_handler(
    asynchronous: bool, custom_handler: bool, device_api: StartupAPI
) -> None:
    code = "\n".join(
        [
            "import asyncio, signal",
            "import revyl_verify as verify",
            "seen = []",
            "handler = lambda signum, frame: seen.append(signum)",
            "signal.signal(signal.SIGTERM, handler)" if custom_handler else "",
            "target = verify.Target(platform='ios', app_id=" + repr(APP_ID) + ")",
            "session = "
            + ("asyncio.run(verify.async_open(target))" if asynchronous else "verify.open(target)"),
            "assert signal.getsignal(signal.SIGTERM) is handler" if custom_handler else "",
            "signal.raise_signal(signal.SIGTERM)",
            "assert seen == [signal.SIGTERM] and not session.closed" if custom_handler else "",
            "asyncio.run(session.close())" if asynchronous else "session.close()",
        ]
    )
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(Path.home()),
        "REVYL_API_KEY": "child-test-key",
        "REVYL_BACKEND_URL": device_api.url,
        "REVYL_APP_URL": VIEWER,
        "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
    }
    result = subprocess.run(
        [sys.executable, "-c", code], env=environment, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == (0 if custom_handler else 128 + signal.SIGTERM), result.stderr
    assert len(device_api.calls("POST", START)) == 1
    assert len(device_stops(device_api)) == 1


@pytest.mark.parametrize("platform", ("web", "ios", "mac"))
def test_sigterm_during_startup_closes_known_resource_before_readiness_returns(
    asynchronous: bool,
    platform: Platform,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
) -> None:
    entered, release = threading.Event(), threading.Event()

    def device_handler(request: Request) -> Reply | None:
        if "/device-sessions/" in request.path or "/worker-connection/" in request.path:
            entered.set()
            assert release.wait(10)
        return None

    def computer_handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path.endswith("/report"):
            entered.set()
            assert release.wait(10)
        return None

    device_api.handler = device_handler
    computer_api.create_state = "starting"
    computer_api.override = computer_handler
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    selected = target(platform)
    code = (
        "import asyncio; import revyl_verify as verify; "
        + ("asyncio.run(verify.async_open(" if asynchronous else "verify.open(")
        + repr(selected).replace("Target(", "verify.Target(")
        + ("))" if asynchronous else ")")
    )
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(Path.home()),
        "REVYL_API_KEY": "child-test-key",
        "REVYL_BACKEND_URL": backend,
        "REVYL_APP_URL": VIEWER,
        "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
    }
    child = subprocess.Popen(
        [sys.executable, "-c", code],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert entered.wait(5)
        child.send_signal(signal.SIGTERM)
        _, stderr = child.communicate(timeout=5)
        assert child.returncode == 128 + signal.SIGTERM, stderr
        assert not release.is_set()
        assert (
            len(
                computer_stops(computer_api)
                if platform in COMPUTER_PLATFORMS
                else device_stops(device_api)
            )
            == 1
        )
    finally:
        release.set()
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_interrupted_cancellation_caches_uncertainty_without_stopping_or_replaying(
    asynchronous: bool,
    platform: Platform,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    session = open_session(asynchronous, target(platform), backend, logs.append)
    attempts = 0

    def interrupt(self: Cancellation) -> None:
        nonlocal attempts
        attempts += 1
        raise KeyboardInterrupt

    monkeypatch.setattr(Cancellation, "cancel", interrupt)
    with pytest.raises(KeyboardInterrupt):
        close_session(session)
    assert session.closed and attempts == 1
    if platform in COMPUTER_PLATFORMS:
        close_session(session)
        assert len(computer_stops(computer_api)) == 1
        return
    with pytest.raises(VerifyError) as repeated:
        close_session(session)
    assert repeated.value.code == "ACTION_UNCERTAIN"
    assert_identity(repeated.value, platform, session.id)
    assert repeated.value.cleanup_status == "unconfirmed"
    assert not device_stops(device_api)
    assert not computer_stops(computer_api)


@pytest.mark.parametrize("lock_kind", ["close", "registry"])
def test_sigterm_unwinds_sdk_lock_without_deadlocking(
    lock_kind: str, device_api: StartupAPI
) -> None:
    code = "\n".join(
        [
            "import signal",
            "import revyl_verify as verify",
            "from revyl_verify import _cleanup",
            f"session = verify.open(verify.Target(platform='ios', app_id={APP_ID!r}))",
            "if " + repr(lock_kind) + " == 'close':",
            "    session._cancellation.cancel = lambda: signal.raise_signal(signal.SIGTERM)",
            "    session.close()",
            "else:",
            "    with _cleanup._lock:",
            "        signal.raise_signal(signal.SIGTERM)",
        ]
    )
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(Path.home()),
        "REVYL_API_KEY": "child-test-key",
        "REVYL_BACKEND_URL": device_api.url,
        "REVYL_APP_URL": VIEWER,
        "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
    }
    result = subprocess.run(
        [sys.executable, "-c", code], env=environment, capture_output=True, text=True, timeout=5
    )
    assert result.returncode == 128 + signal.SIGTERM, result.stderr
    assert len(device_stops(device_api)) == (0 if lock_kind == "close" else 1)


@pytest.mark.parametrize("platform", ("web", "ios", "android"))
@pytest.mark.parametrize(
    "status",
    [
        "queued",
        "starting",
        "running",
        "verifying",
        "validating",
        "stopping",
        "completed",
        "failed",
        "cancelled",
        "timeout",
    ],
)
def test_device_stop_acceptance_does_not_require_terminal_state_or_claim_release(
    asynchronous: bool, platform: Platform, status: str, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    session = open_session(asynchronous, target(platform), device_api.url, logs.append)
    device_api.handler = lambda request: (
        Reply(
            body={
                "success": True,
                "request_accepted": True,
                "session_id": session.id,
                "status": status,
                "device_released": False,
                "message": RAW_URL,
            }
        )
        if request.path.endswith("/stop")
        else None
    )
    close_session(session)
    close_session(session)
    assert logs[-1] == f"{platform}: stop acknowledged"
    assert not any("physical release" in message for message in logs)
    assert len(device_stops(device_api)) == 1
    assert_private_logs(logs)


@pytest.mark.parametrize("status", [408, 409, 500, 502, 503, 504])
def test_uncertain_web_create_http_error_cleans_up_proposed_id_once(
    asynchronous: bool, status: int, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    device_api.handler = lambda request: (
        Reply(status, {"detail": RAW_URL}) if request.path == START else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target("web"), device_api.url, logs.append)
    starts = device_api.calls("POST", START)
    assert len(starts) == 1
    proposed_id = starts[0].body["session_id"]
    assert isinstance(proposed_id, str)
    assert_identity(caught.value, "web", proposed_id)
    assert caught.value.code == "API_ERROR"
    assert caught.value.cleanup_status == "acknowledged"
    assert [call.path for call in device_stops(device_api)] == [
        f"/api/v1/execution/device/sessions/{proposed_id}/stop"
    ]
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", COMPUTER_PLATFORMS)
@pytest.mark.parametrize("untrusted_id", [RAW_URL, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", True])
def test_computer_create_response_cannot_replace_proposed_identity(
    asynchronous: bool,
    platform: Platform,
    untrusted_id: Json,
    computer_api: ComputerAPI,
) -> None:
    logs: list[str] = []

    def handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path != COMPUTERS:
            return None
        proposed_id = obj(body)["computer_session_id"]
        assert isinstance(proposed_id, str)
        computer_api.id = proposed_id
        return 200, {"computer_session_id": untrusted_id, "state": "active"}

    computer_api.override = handler
    with pytest.raises(VerifyError) as caught:
        open_session(
            asynchronous,
            target(platform),
            f"http://127.0.0.1:{computer_api.server.server_port}",
            logs.append,
        )
    assert_identity(caught.value, platform, computer_api.id)
    assert caught.value.code == "API_ERROR"
    assert caught.value.cleanup_status == "confirmed"
    assert len(computer_api.calls) == 2
    assert computer_stops(computer_api)[0][1] == f"{COMPUTERS}/{computer_api.id}/stop"
    if isinstance(untrusted_id, str):
        assert untrusted_id not in "\n".join(logs)
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", PLATFORMS)
def test_create_timeout_retains_original_timeout_and_known_identity(
    asynchronous: bool,
    platform: Platform,
    device_api: StartupAPI,
    computer_api: ComputerAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    logs: list[str] = []
    original = Deadline.__init__

    def short_start(
        self: Deadline, seconds: float, cancellation: Cancellation | None = None
    ) -> None:
        original(self, 0.1 if seconds == 10 else seconds, cancellation)

    def device_handler(request: Request) -> Reply | None:
        if request.path == START:
            assert release.wait(3)
        return None

    def computer_handler(method: str, path: str, body: Json) -> tuple[int, Json] | None:
        if path == COMPUTERS:
            session_id = obj(body)["computer_session_id"]
            assert isinstance(session_id, str)
            computer_api.id = session_id
            assert release.wait(3)
        return None

    monkeypatch.setattr(Deadline, "__init__", short_start)
    device_api.handler = device_handler
    computer_api.override = computer_handler
    backend = (
        f"http://127.0.0.1:{computer_api.server.server_port}"
        if platform in COMPUTER_PLATFORMS
        else device_api.url
    )
    try:
        with pytest.raises(VerifyError) as caught:
            open_session(asynchronous, target(platform, start_timeout=10), backend, logs.append)
    finally:
        release.set()
    expected_id = (
        computer_api.id
        if platform in COMPUTER_PLATFORMS
        else str(device_api.calls("POST", START)[0].body["session_id"])
        if platform == "web"
        else None
    )
    assert_identity(caught.value, platform, expected_id)
    assert caught.value.code == "TIMEOUT"
    assert caught.value.cleanup_status == (
        "confirmed"
        if platform in COMPUTER_PLATFORMS
        else "unconfirmed"
        if platform in MOBILE
        else "acknowledged"
    )
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", MOBILE)
def test_malicious_mobile_acknowledgment_without_safe_identity_never_attempts_cleanup(
    asynchronous: bool, platform: Platform, device_api: StartupAPI
) -> None:
    logs: list[str] = []
    device_api.handler = lambda request: (
        Reply(body={"session_id": RAW_URL, "workflow_run_id": "\nforged-log-line"})
        if request.path == START
        else None
    )
    with pytest.raises(VerifyError) as caught:
        open_session(asynchronous, target(platform), device_api.url, logs.append)
    assert_identity(caught.value, platform, None)
    assert caught.value.code == "SESSION_START_FAILED"
    assert caught.value.workflow_run_id is None
    assert caught.value.cleanup_status == "unconfirmed"
    assert [request.path for request in device_api.requests] == [START]
    assert "forged-log-line" not in "\n".join(logs)
    assert_private_logs(logs)


@pytest.mark.parametrize("platform", COMPUTER_PLATFORMS)
def test_computer_transport_error_is_not_reclassified_by_expired_deadline(
    asynchronous: bool,
    platform: Platform,
    computer_api: ComputerAPI,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logs: list[str] = []
    create_attempts = 0
    original = Client.request
    transport_error = VerifyError("API_ERROR", "Fixture transport failure.")

    def fail_create_after_deadline(
        self: Client,
        method: str,
        path: str,
        body: Json = None,
        *,
        deadline: Deadline,
        timeout: float = 30,
        retry: bool = False,
        worker: bool = False,
    ) -> Response:
        nonlocal create_attempts
        if method == "POST" and path == COMPUTERS:
            create_attempts += 1
            session_id = obj(body)["computer_session_id"]
            assert isinstance(session_id, str)
            computer_api.id = session_id
            deadline.end = 0
            raise transport_error
        return original(
            self, method, path, body, deadline=deadline, timeout=timeout, retry=retry, worker=worker
        )

    monkeypatch.setattr(Client, "request", fail_create_after_deadline)
    with pytest.raises(VerifyError) as caught:
        open_session(
            asynchronous,
            target(platform),
            f"http://127.0.0.1:{computer_api.server.server_port}",
            logs.append,
        )
    assert caught.value.code == "ACTION_UNCERTAIN"
    assert caught.value.__cause__ is transport_error
    assert_identity(caught.value, platform, computer_api.id)
    assert caught.value.cleanup_status == "confirmed"
    assert caught.value.cleanup_error is None
    assert create_attempts == 1
    assert computer_api.calls == [("POST", f"{COMPUTERS}/{computer_api.id}/stop", None)]
    assert_private_logs(logs)
