from __future__ import annotations

import io
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast
from urllib.parse import parse_qs, urlsplit

import pytest
from PIL import Image

import revyl_verify as verify
from revyl_verify import Session, SignIn, Target, VerifyError, Viewport
from revyl_verify._models import Platform
from revyl_verify._session import non_blank_png
from revyl_verify._transport import Cancellation, Client, Deadline, Json

APP_ID = "0b6a8c3e-1111-4222-8333-944455556666"
BUILD_ID = "9a9a9a9a-1111-4222-8333-944455556666"
SESSION_ID = "11111111-2222-4333-8444-555555555555"
START = "/api/v1/execution/start_device"
PROXY = "/api/v1/execution/device-proxy/run-1/"
STOP = f"/api/v1/execution/device/sessions/{SESSION_ID}/stop"
APP = f"/api/v1/apps/{APP_ID}"
FIXTURES = cast(
    dict[str, dict[str, Json]],
    json.loads((Path(__file__).parent / "fixtures/device-contract.json").read_text()),
)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REVYL_API_KEY", "test-token")


@pytest.mark.parametrize("name", ["device-contract.json", "computer-contract.json"])
def test_packaged_contract_fixtures_match_go_when_available(name: str) -> None:
    canonical = Path(__file__).parents[2] / "go/testdata" / name
    if not canonical.is_file():
        pytest.skip("Go canonical fixtures are not included in Python distributions")
    assert (Path(__file__).parent / "fixtures" / name).read_bytes() == canonical.read_bytes()


def png(content: bool = True) -> bytes:
    image = Image.new("RGB", (20, 20), "white")
    image.putpixel((0, 0), (0, 0, 0))
    if content:
        image.putpixel((10, 10), (0, 0, 0))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: dict[str, Json]


@dataclass
class Reply:
    status: int = 200
    body: Json | bytes = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)


class FakeRevyl:
    def __init__(self) -> None:
        self.requests: list[Request] = []
        self.errors: list[str] = []
        self.handler: Callable[[Request], Reply | None] = lambda request: None
        self.sessions: list[Session] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.respond()

            def do_POST(self) -> None:
                self.respond()

            def log_message(self, format: str, *args: object) -> None:
                pass

            def respond(self) -> None:
                parsed = urlsplit(self.path)
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                request = Request(
                    self.command,
                    parsed.path,
                    parse_qs(parsed.query),
                    dict(self.headers.items()),
                    json.loads(raw) if raw else {},
                )
                fake.requests.append(request)
                try:
                    response = fake.handler(request) or fake.default(request)
                except Exception as error:
                    fake.errors.append(type(error).__name__)
                    response = Reply(599, {"detail": "fake handler failed"})
                data = response.body
                payload = data if isinstance(data, bytes) else json.dumps(data).encode()
                self.send_response(response.status)
                if not {"Content-Length", "Transfer-Encoding"}.intersection(response.headers):
                    self.send_header("Content-Length", str(len(payload)))
                for key, value in response.headers.items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True
        )
        self.thread.start()

    def default(self, request: Request) -> Reply:
        path = request.path
        if request.method == "POST" and path == START:
            if request.body["platform"] == "web":
                return Reply(
                    body={**FIXTURES["webStart"], "session_id": request.body["session_id"]}
                )
            return Reply(body=FIXTURES["androidStart"])
        if request.method == "GET" and path.startswith("/api/v1/execution/device-sessions/"):
            return Reply(body=FIXTURES["webReady"])
        routes: dict[tuple[str, str], Reply] = {
            ("GET", "/api/v1/execution/streaming/worker-connection/run-1"): Reply(
                body=FIXTURES["workerConnection"]
            ),
            ("GET", PROXY + "health"): Reply(body=FIXTURES["health"]),
            ("GET", PROXY + "screenshot"): Reply(body=png()),
            ("POST", PROXY + "launch"): Reply(body={"success": True}),
            ("POST", APP + "/builds/external"): Reply(body={"id": BUILD_ID}),
            ("GET", APP): Reply(body={"platform": "web", "default_branch_id": "default-branch"}),
            ("GET", APP + "/builds"): Reply(body={"items": [{"id": BUILD_ID}]}),
        }
        if (request.method, path) in routes:
            return routes[request.method, path]
        if request.method == "POST" and path == PROXY + "execute_step":
            key = "validationPassed" if request.body["step_type"] == "validation" else "stepResult"
            return Reply(body=FIXTURES[key])
        if request.method == "POST" and path.endswith("/stop"):
            return Reply(body={**FIXTURES["stop"], "session_id": path.split("/")[-2]})
        if request.method == "POST" and "/device/status/cancel/" in path:
            return Reply(body={**FIXTURES["stop"], "workflow_run_id": path.rsplit("/", 1)[-1]})
        self.errors.append(f"Unexpected {request.method} {path}")
        return Reply(599)

    def calls(self, method: str, path: str) -> list[Request]:
        return [r for r in self.requests if (r.method, r.path) == (method, path)]

    def open(self, target: Target | None = None) -> Session:
        session = verify.open(
            target or Target(platform="android", app_id=APP_ID),
            backend_url=self.url,
            app_url="https://viewer.test",
        )
        self.sessions.append(session)
        return session

    def finish(self) -> None:
        try:
            for session in self.sessions:
                if not session.closed:
                    session.close()
        finally:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)


@pytest.fixture
def fake(isolated_environment: None) -> Iterator[FakeRevyl]:
    server = FakeRevyl()
    try:
        yield server
    finally:
        server.finish()
        assert not server.errors


@pytest.fixture
def fast_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    def pause(self: Deadline, seconds: float) -> None:
        self.remaining()
        time.sleep(0.001)
        self.remaining()

    monkeypatch.setattr(Deadline, "pause", pause)


@pytest.mark.parametrize("platform", ["ios", "android"])
@pytest.mark.parametrize("source", ["app_id", "build_id", "artifact_url", "bundle_id"])
def test_mobile_start_and_launch(fake: FakeRevyl, platform: Platform, source: str) -> None:
    values = {
        "app_id": APP_ID,
        "build_id": BUILD_ID,
        "artifact_url": "https://example.test/app.zip",
        "bundle_id": "com.example.app",
    }
    target = Target(
        platform=platform,
        device_model="test-device",
        os_version="test-os",
        idle_timeout_seconds=90,
        app_id=values["app_id"] if source == "app_id" else None,
        build_id=values["build_id"] if source == "build_id" else None,
        artifact_url=values["artifact_url"] if source == "artifact_url" else None,
        bundle_id=values["bundle_id"] if source == "bundle_id" else None,
    )
    session = fake.open(target)
    expected: dict[str, Json] = {
        "platform": platform,
        "is_simulation": True,
        "device_model": "test-device",
        "os_version": "test-os",
        "idle_timeout_seconds": 90,
    }
    if source != "bundle_id":
        expected["app_url" if source == "artifact_url" else source] = values[source]
    assert fake.calls("POST", START)[0].body == expected
    launches = fake.calls("POST", PROXY + "launch")
    assert [call.body for call in launches] == (
        [{"bundle_id": "com.example.app"}] if source == "bundle_id" else []
    )
    assert session.id == SESSION_ID and session.platform == platform
    assert session.viewer_url == "https://viewer.test/sessions/" + SESSION_ID


@pytest.mark.parametrize("source", ["url", "build", "branch", "default"])
def test_web_build_resolution(fake: FakeRevyl, source: str) -> None:
    session = fake.open(
        Target(
            platform="web",
            app_id=APP_ID,
            url="https://example.test/store" if source == "url" else None,
            branch="feature/a b" if source in ("url", "branch") else None,
            build_id=BUILD_ID if source == "build" else None,
            viewport=Viewport(1280, 800, 2),
            sign_in=SignIn("/login", "test-login", "shopper"),
            idle_timeout_seconds=120,
        )
    )
    assert fake.calls("POST", START)[0].body == {
        "platform": "web",
        "app_id": APP_ID,
        "build_id": BUILD_ID,
        "session_id": session.id,
        "idle_timeout_seconds": 120,
        "web": {
            "viewport": {"width": 1280, "height": 800, "device_scale_factor": 2},
            "sign_in": {"path": "/login", "secret_name": "test-login", "persona": "shopper"},
        },
    }
    registered = fake.calls("POST", APP + "/builds/external")
    assert [r.body for r in registered] == (
        [{"url": "https://example.test/store", "branch_name": "feature/a b"}]
        if source == "url"
        else []
    )
    builds = fake.calls("GET", APP + "/builds")
    if source in ("branch", "default"):
        assert builds[0].query == {
            "artifact_kinds": ["web_external", "web_bundle"],
            "include_jobs": ["false"],
            "page": ["1"],
            "page_size": ["1"],
            **(
                {"branch_name": ["feature/a b"]}
                if source == "branch"
                else {"branch_id": ["default-branch"]}
            ),
        }
    else:
        assert not builds
    assert len(fake.calls("GET", APP)) == (source == "default")
    assert not fake.calls("POST", PROXY + "launch")
    assert session.instruction("Open the cart").passed


def test_all_requests_have_wire_attribution(fake: FakeRevyl) -> None:
    with fake.open() as session:
        session.instruction("Open settings")
        session.validation("Settings visible")
        session.screenshot()
        session.report()
    for request in fake.requests:
        assert request.headers["Authorization"] == "Bearer test-token"
        assert request.headers["X-Revyl-Client"] == "verify"
        assert "revyl-verify/" in request.headers["User-Agent"]
        assert "python" in request.headers["User-Agent"]
        if request.path.startswith(PROXY):
            assert request.headers["X-Revyl-Agent"] == "Verify"


@pytest.mark.parametrize(
    "target",
    [
        Target(platform="android"),
        Target(platform="ios", app_id="not-uuid"),
        Target(platform="android", app_id=APP_ID, bundle_id="com.app"),
        Target(platform="android", artifact_url="http://example.test/app.zip"),
        Target(platform="ios", bundle_id=" "),
        Target(platform="ios", bundle_id="x" * 256),
        Target(platform="android", app_id=APP_ID, url="https://example.test"),
        Target(platform="ios", app_id=APP_ID, idle_timeout_seconds=59),
        Target(platform="ios", app_id=APP_ID, idle_timeout_seconds=True),
        Target(platform="ios", app_id=APP_ID, start_timeout=float("nan")),
        Target(platform="web"),
        Target(platform="web", app_id=APP_ID, url="http://example.test"),
        Target(platform="web", app_id=APP_ID, url="https://secret@example.test"),
        Target(platform="web", app_id=APP_ID, url="https://example.test/?token=secret"),
        Target(platform="web", app_id=APP_ID, url="https://example.test/#secret"),
        Target(platform="web", app_id=APP_ID, build_id=BUILD_ID, branch="main"),
        Target(platform="web", app_id=APP_ID, viewport=Viewport(319, 800)),
        Target(platform="web", app_id=APP_ID, viewport=Viewport(1280, 800, 4)),
        Target(platform="web", app_id=APP_ID, sign_in=SignIn("//evil.test", "secret")),
        Target(platform="web", app_id=APP_ID, sign_in=SignIn("/login", "secret", "UPPER")),
        Target(platform="web", app_id=APP_ID, branch="x" * 256),
        Target(platform="mac", app_id=APP_ID),
        Target(platform="linux", bundle_id="com.app"),
    ],
)
def test_invalid_targets_never_reach_network(fake: FakeRevyl, target: Target) -> None:
    with pytest.raises(VerifyError) as caught:
        fake.open(target)
    assert caught.value.code == "INVALID_ARGUMENT"
    assert not fake.requests


@pytest.mark.parametrize("accepted", [False, True])
def test_sync_and_accepted_steps(fake: FakeRevyl, fast_pause: None, accepted: bool) -> None:
    polls = 0

    def handler(request: Request) -> Reply | None:
        nonlocal polls
        if accepted and request.path == PROXY + "execute_step":
            return Reply(202, {"status": "accepted", "step_id": "step/1"})
        if request.path == PROXY + "step_status/step%2F1":
            polls += 1
            return Reply(
                body=FIXTURES["stepRunning"]
                if polls == 1
                else {
                    "status": "completed",
                    "result": FIXTURES["stepResult"],
                }
            )
        return None

    fake.handler = handler
    session = fake.open()
    result = session.instruction("  Open the cart  ")
    assert (result.type, result.text, result.passed, result.reason) == (
        "instruction",
        "Open the cart",
        True,
        "Done",
    )
    assert result.duration_seconds >= 0 and session.steps == [result]
    assert fake.calls("POST", PROXY + "execute_step")[0].body == {
        "step_type": "instruction",
        "step_description": "Open the cart",
        "workflow_run_id": "run-1",
        "session_id": SESSION_ID,
    }
    assert polls == (2 if accepted else 0)


@pytest.mark.parametrize(
    ("fixture", "soft", "code"),
    [
        ("validationPassed", False, None),
        ("validationFailed", True, None),
        ("validationFailed", False, "VALIDATION_FAILED"),
        ("stepResult", True, "STEP_FAILED"),
        ("stepResult", False, "STEP_FAILED"),
    ],
)
def test_validation_verdicts(fake: FakeRevyl, fixture: str, soft: bool, code: str | None) -> None:
    session = fake.open()
    fake.handler = lambda r: (
        Reply(body=FIXTURES[fixture]) if r.path.endswith("execute_step") else None
    )
    if code:
        with pytest.raises(VerifyError) as caught:
            session.validation("The cart is visible", soft=soft)
        assert caught.value.code == code
        if code == "VALIDATION_FAILED":
            assert caught.value.result == session.steps[-1]
            assert session.steps[-1].passed is False
    else:
        result = session.validation("The cart is visible", soft=soft)
        assert result.passed is (fixture == "validationPassed")
        assert session.steps == [result]


@pytest.mark.parametrize(
    ("state", "result", "code"),
    [
        ("cancelled", None, "STEP_FAILED"),
        ("unknown", None, "API_ERROR"),
        ("completed", None, "API_ERROR"),
        ("failed", {"success": False}, "STEP_FAILED"),
        ("completed", {"success": "true"}, "API_ERROR"),
        ("completed", {"success": True, "step_output": []}, "API_ERROR"),
        (
            "completed",
            {"success": True, "step_output": {"validation_result": "true"}},
            "API_ERROR",
        ),
    ],
)
def test_terminal_poll_failures(
    fake: FakeRevyl,
    fast_pause: None,
    state: str,
    result: Json,
    code: str,
) -> None:
    session = fake.open()

    def handler(request: Request) -> Reply | None:
        if request.path == PROXY + "execute_step":
            return Reply(202, FIXTURES["stepAccepted"])
        if request.path == PROXY + "step_status/step-1":
            return Reply(body={"status": state, "result": result})
        return None

    fake.handler = handler
    with pytest.raises(VerifyError) as caught:
        session.validation("visible", soft=True)
    assert caught.value.code == code
    assert not session.steps
    fake.handler = lambda request: None
    assert session.instruction("Can run another step").passed


def test_poll_http_failure_is_not_a_soft_validation(fake: FakeRevyl, fast_pause: None) -> None:
    session = fake.open()

    def handler(request: Request) -> Reply | None:
        if request.path == PROXY + "execute_step":
            return Reply(202, FIXTURES["stepAccepted"])
        if request.path == PROXY + "step_status/step-1":
            return Reply(503, {"detail": "secret-token"})
        return None

    fake.handler = handler
    with pytest.raises(VerifyError) as caught:
        session.validation("visible", soft=True)
    assert caught.value.code == "ACTION_FAILED"
    assert "secret-token" not in str(caught.value)
    assert len(fake.calls("GET", PROXY + "step_status/step-1")) == 3
    assert len(fake.calls("POST", PROXY + "execute_step")) == 1
    assert not session.steps


def test_failed_instruction_records_result(fake: FakeRevyl) -> None:
    session = fake.open()
    fake.handler = lambda r: (
        Reply(body={"success": False, "step_output": {"status_reason": "Not completed"}})
        if r.path.endswith("execute_step")
        else None
    )
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings")
    assert caught.value.code == "INSTRUCTION_FAILED"
    assert caught.value.result == session.steps[-1]
    assert not session.steps[-1].passed and session.steps[-1].reason == "Not completed"


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (401, {"detail": "secret-token"}, "AUTH_REJECTED"),
        (403, {"detail": "secret-token"}, "AUTH_REJECTED"),
        (409, {"detail": "Another step is executing"}, "SESSION_BUSY"),
        (409, {"detail": "Session is not running secret-token"}, "SESSION_ENDED"),
        (404, {}, "SESSION_ENDED"),
        (410, {}, "SESSION_ENDED"),
        (501, {"error": "step_output_not_available"}, "NOT_AVAILABLE_ON_PLATFORM"),
        (503, {"execution_uncertain": True, "detail": "secret-token"}, "ACTION_UNCERTAIN"),
        (400, {"detail": "secret-token"}, "ACTION_FAILED"),
    ],
)
def test_worker_errors_are_typed_and_redacted(
    fake: FakeRevyl,
    status: int,
    body: Json,
    code: str,
) -> None:
    session = fake.open()
    fake.handler = lambda r: Reply(status, body) if r.path.endswith("execute_step") else None
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings")
    assert caught.value.code == code
    assert "secret-token" not in str(caught.value)
    assert session.viewer_url in str(caught.value)
    assert len(fake.calls("POST", PROXY + "execute_step")) == 1


@pytest.mark.parametrize(
    "payload",
    [
        b"secret-token",
        b"[]",
        b"null",
        b'{"success":NaN}',
        b'{"status":"accepted"}',
        b'{"success":1}',
    ],
)
def test_malformed_step_response_is_redacted(fake: FakeRevyl, payload: bytes) -> None:
    session = fake.open()
    fake.handler = lambda r: Reply(body=payload) if r.path.endswith("execute_step") else None
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings")
    assert caught.value.code == "API_ERROR"
    assert "secret-token" not in str(caught.value)
    assert not session.steps


@pytest.mark.parametrize(
    ("field_name", "value"),
    [
        ("status", 7),
        ("status", []),
        ("status_reason", 1),
        ("reasoning", False),
        ("validation_result", "true"),
        ("validation_result", 1),
    ],
)
def test_malformed_optional_step_fields_fail_closed(
    fake: FakeRevyl,
    field_name: str,
    value: Json,
) -> None:
    session = fake.open()
    fake.handler = lambda r: (
        Reply(body={"success": True, "step_output": {field_name: value}})
        if r.path.endswith("execute_step")
        else None
    )
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings")
    assert caught.value.code == "API_ERROR"
    assert not session.steps


def test_get_retries_are_bounded(fake: FakeRevyl, fast_pause: None) -> None:
    session = fake.open()
    attempts = 0

    def handler(request: Request) -> Reply | None:
        nonlocal attempts
        if request.path == PROXY + "screenshot":
            attempts += 1
            return Reply(503) if attempts < 3 else Reply(body=png())
        return None

    fake.handler = handler
    assert session.screenshot() == png() and attempts == 3
    fake.handler = lambda r: Reply(503) if r.path.endswith("screenshot") else None
    before = len(fake.calls("GET", PROXY + "screenshot"))
    with pytest.raises(VerifyError):
        session.screenshot()
    assert len(fake.calls("GET", PROXY + "screenshot")) - before == 3


@pytest.mark.parametrize("path", [START, PROXY + "launch", PROXY + "execute_step"])
def test_mutations_are_never_replayed(fake: FakeRevyl, fast_pause: None, path: str) -> None:
    if path == PROXY + "execute_step":
        session = fake.open()
    fake.handler = lambda r: Reply(503, {"execution_uncertain": True}) if r.path == path else None
    with pytest.raises(VerifyError):
        if path == PROXY + "execute_step":
            session.instruction("Open settings")
        elif path == PROXY + "launch":
            fake.open(Target(platform="ios", bundle_id="com.apple.Preferences"))
        else:
            fake.open()
    assert len(fake.calls("POST", path)) == 1


def test_idempotent_external_registration_retries_are_bounded(
    fake: FakeRevyl,
    fast_pause: None,
) -> None:
    fake.handler = lambda request: Reply(503) if request.path == APP + "/builds/external" else None
    with pytest.raises(VerifyError) as caught:
        fake.open(Target(platform="web", app_id=APP_ID, url="https://example.test"))
    assert caught.value.code == "API_ERROR"
    calls = fake.calls("POST", APP + "/builds/external")
    assert len(calls) == 3
    assert all(call.body == {"url": "https://example.test"} for call in calls)
    assert not fake.calls("POST", START)


def test_timeout_cancels_accepted_step_with_fresh_budget(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = fake.open()

    def handler(request: Request) -> Reply | None:
        if request.path == PROXY + "execute_step":
            return Reply(202, FIXTURES["stepAccepted"])
        if request.path == PROXY + "step_cancel/step-1":
            return Reply(body={"success": True})
        return None

    fake.handler = handler

    def expire(self: Deadline, seconds: float) -> None:
        self.end = 0
        self.remaining()

    monkeypatch.setattr(Deadline, "pause", expire)
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings", timeout=1)
    assert caught.value.code == "TIMEOUT"
    assert len(fake.calls("POST", PROXY + "step_cancel/step-1")) == 1
    assert not session.closed and not session.steps
    fake.handler = lambda r: None
    assert session.instruction("Another step").passed


@pytest.mark.parametrize("text", ["", " ", "x" * 4001, "😀" * 2001])
def test_invalid_step_text(fake: FakeRevyl, text: str) -> None:
    session = fake.open()
    with pytest.raises(VerifyError) as caught:
        session.instruction(text)
    assert caught.value.code == "INVALID_ARGUMENT"
    assert not fake.calls("POST", PROXY + "execute_step")


@pytest.mark.parametrize("timeout", [0, -1, True, float("inf"), float("nan"), 3601])
def test_invalid_step_timeout(fake: FakeRevyl, timeout: float) -> None:
    session = fake.open()
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings", timeout=timeout)
    assert caught.value.code == "INVALID_ARGUMENT"
    assert not fake.calls("POST", PROXY + "execute_step")


def test_invalid_soft_option_is_local(fake: FakeRevyl) -> None:
    session = fake.open()
    with pytest.raises(VerifyError) as caught:
        session.validation("Visible", soft=cast(bool, "yes"))
    assert caught.value.code == "INVALID_ARGUMENT"
    assert not fake.calls("POST", PROXY + "execute_step")


def test_concurrent_steps_rejected_locally(fake: FakeRevyl) -> None:
    session = fake.open()
    entered, release = threading.Event(), threading.Event()
    results: list[object] = []

    def handler(request: Request) -> Reply | None:
        if request.path.endswith("execute_step"):
            entered.set()
            assert release.wait(3)
        return None

    fake.handler = handler
    worker = threading.Thread(target=lambda: results.append(session.instruction("First")))
    worker.start()
    try:
        assert entered.wait(3)
        with pytest.raises(VerifyError) as caught:
            session.instruction("Second")
        assert caught.value.code == "INVALID_ARGUMENT"
        assert len(fake.calls("POST", PROXY + "execute_step")) == 1
    finally:
        release.set()
        worker.join(3)
    assert len(results) == 1


def test_screenshot_write_and_closed_session(fake: FakeRevyl, tmp_path: Path) -> None:
    session = fake.open()
    path = tmp_path / "nested/screen.png"
    assert session.screenshot(path=path) == path.read_bytes() == png()
    session.close()
    session.close()
    assert session.closed and len(fake.calls("POST", STOP)) == 1
    with pytest.raises(VerifyError) as caught:
        session.screenshot()
    assert caught.value.code == "SESSION_ENDED"


@pytest.mark.parametrize("data", [b"not png", b"\x89PNG\r\n\x1a\n", b"secret-token"])
def test_screenshot_rejects_invalid_data(fake: FakeRevyl, data: bytes) -> None:
    session = fake.open()
    fake.handler = lambda r: Reply(body=data) if r.path.endswith("screenshot") else None
    with pytest.raises(VerifyError) as caught:
        session.screenshot()
    assert caught.value.code == "ACTION_FAILED"
    assert "secret-token" not in str(caught.value)


def test_screenshot_rejects_zero_dimensions(fake: FakeRevyl) -> None:
    session = fake.open()
    data = bytearray(png())
    data[16:20] = b"\0" * 4
    fake.handler = lambda r: Reply(body=bytes(data)) if r.path.endswith("screenshot") else None
    with pytest.raises(VerifyError) as caught:
        session.screenshot()
    assert caught.value.code == "ACTION_FAILED"


def test_first_screen_ignores_status_bar_and_bounds_images() -> None:
    assert non_blank_png(png()) is True
    assert non_blank_png(png(False)) is False
    oversized = bytearray(png())
    oversized[16:20] = struct.pack(">I", 16_000_001)
    with pytest.raises(VerifyError):
        non_blank_png(bytes(oversized))


@pytest.mark.parametrize("first", [200, 409, 503])
def test_first_screen_waits_after_launch_without_replaying(
    fake: FakeRevyl,
    fast_pause: None,
    first: int,
) -> None:
    shots = 0

    def handler(request: Request) -> Reply | None:
        nonlocal shots
        if request.path.endswith("screenshot"):
            assert len(fake.calls("POST", PROXY + "launch")) == 1
            shots += 1
            return Reply(first, png(False)) if shots == 1 else Reply(body=png())
        return None

    fake.handler = handler
    session = fake.open(Target(platform="ios", bundle_id="com.apple.Preferences"))
    assert not session.closed and shots == 2
    assert len(fake.calls("POST", PROXY + "launch")) == 1


@pytest.mark.parametrize("status", [200, 400, 401, 403, 404, 410, 429, 500, 501, 502, 504])
def test_first_screen_is_best_effort(fake: FakeRevyl, status: int) -> None:
    fake.handler = lambda r: Reply(status, b"not png") if r.path.endswith("screenshot") else None
    assert not fake.open().closed
    assert len(fake.calls("GET", PROXY + "screenshot")) == 1


def test_first_screen_exhausted_budget_is_nonfatal(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pauses: list[float] = []

    def expire(self: Deadline, seconds: float) -> None:
        pauses.append(seconds)
        self.end = 0
        self.remaining()

    monkeypatch.setattr(Deadline, "pause", expire)
    fake.handler = lambda r: Reply(body=png(False)) if r.path.endswith("screenshot") else None
    session = fake.open()
    assert not session.closed and pauses == [0.5]
    assert not fake.calls("POST", STOP)


@pytest.mark.parametrize("failure", ["assignment", "launch", "web"])
def test_startup_failure_cleans_up(fake: FakeRevyl, failure: str) -> None:
    def handler(request: Request) -> Reply | None:
        if failure == "assignment" and "/worker-connection/" in request.path:
            return Reply(body={"status": "failed"})
        if failure == "launch" and request.path.endswith("launch"):
            return Reply(body={"success": False})
        if failure == "web" and "/device-sessions/" in request.path:
            return Reply(body={"status": "failed"})
        return None

    fake.handler = handler
    target = (
        Target(platform="web", app_id=APP_ID, build_id=BUILD_ID)
        if failure == "web"
        else Target(platform="ios", bundle_id="com.apple.Preferences")
    )
    with pytest.raises(VerifyError) as caught:
        fake.open(target)
    assert caught.value.code == "SESSION_START_FAILED"
    assert len([r for r in fake.requests if r.path.endswith("/stop")]) == 1


def test_startup_timeout_cleans_up(fake: FakeRevyl, monkeypatch: pytest.MonkeyPatch) -> None:
    fake.handler = lambda r: (
        Reply(body={"status": "starting"}) if "/worker-connection/" in r.path else None
    )

    def expire(self: Deadline, seconds: float) -> None:
        self.end = 0
        self.remaining()

    monkeypatch.setattr(Deadline, "pause", expire)
    with pytest.raises(VerifyError) as caught:
        fake.open()
    assert caught.value.code == "TIMEOUT"
    assert len(fake.calls("POST", STOP)) == 1


@pytest.mark.parametrize(
    "payload",
    [b"secret-token", b"[]", b"null", b'{"session_id":7}', b'{"workflow_run_id":false}', b"{}"],
)
def test_malformed_start_response_is_redacted(fake: FakeRevyl, payload: bytes) -> None:
    fake.handler = lambda r: Reply(body=payload) if r.path == START else None
    with pytest.raises(VerifyError) as caught:
        fake.open()
    assert caught.value.code in ("API_ERROR", "SESSION_START_FAILED")
    assert "secret-token" not in str(caught.value)
    assert len(fake.calls("POST", START)) == 1


@pytest.mark.parametrize("items", [[], None, [{"id": ""}]])
def test_web_missing_build_never_starts(fake: FakeRevyl, items: Json) -> None:
    fake.handler = lambda r: Reply(body={"items": items}) if r.path == APP + "/builds" else None
    with pytest.raises(VerifyError) as caught:
        fake.open(Target(platform="web", app_id=APP_ID))
    assert caught.value.code == "SESSION_START_FAILED"
    assert not fake.calls("POST", START)


def test_context_exception_and_interpreter_exit_cleanup(fake: FakeRevyl) -> None:
    with pytest.raises(RuntimeError, match="body failure"), fake.open():
        raise RuntimeError("body failure")
    assert len(fake.calls("POST", STOP)) == 1
    code = (
        "from revyl_verify import open,Target; "
        f"open(Target(platform='ios',bundle_id='com.apple.Preferences'),backend_url={fake.url!r})"
    )
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ["HOME"],
        "REVYL_API_KEY": "child-test-key",
        "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
    }
    result = subprocess.run(
        [sys.executable, "-c", code], env=environment, capture_output=True, text=True, timeout=10
    )
    assert result.returncode == 0, result.stderr
    assert len(fake.calls("POST", STOP)) == 2


def test_interrupted_close_caches_uncertainty_without_replay(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = fake.open()
    attempts = 0
    original = session._client.json

    def interrupted(
        method: str,
        path: str,
        body: Json = None,
        *,
        deadline: Deadline,
        retry: bool = False,
        timeout: float = 30,
    ) -> dict[str, Json]:
        nonlocal attempts
        if path == STOP:
            attempts += 1
            raise KeyboardInterrupt
        return original(method, path, body, deadline=deadline, retry=retry, timeout=timeout)

    monkeypatch.setattr(session._client, "json", interrupted)
    with pytest.raises(KeyboardInterrupt):
        session.close()
    with pytest.raises(VerifyError) as caught:
        session.close()
    assert caught.value.code == "ACTION_UNCERTAIN"
    assert attempts == 1 and session.closed


def test_request_timeout_has_no_mutation_replay(
    fake: FakeRevyl, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = fake.open()
    original = Deadline.__init__

    def short(
        self: Deadline,
        seconds: float,
        cancellation: Cancellation | None = None,
    ) -> None:
        original(self, min(seconds, 0.05), cancellation)

    monkeypatch.setattr(Deadline, "__init__", short)

    def handler(request: Request) -> Reply | None:
        if request.path.endswith("execute_step"):
            time.sleep(0.2)
        return None

    fake.handler = handler
    with pytest.raises(VerifyError) as caught:
        session.instruction("Open settings", timeout=1)
    assert caught.value.code == "TIMEOUT"
    assert len(fake.calls("POST", PROXY + "execute_step")) == 1
    assert not fake.calls("POST", PROXY + "step_cancel/step-1")
    assert not session.steps


def test_dns_resolution_is_bounded_by_request_deadline(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resolving, release, resolved = threading.Event(), threading.Event(), threading.Event()
    original = socket.getaddrinfo

    def delayed_dns(
        host: bytes | str | None,
        port: bytes | str | int | None,
        family: int = 0,
        type: int = 0,
        proto: int = 0,
        flags: int = 0,
    ) -> list[tuple[socket.AddressFamily, socket.SocketKind, int, str, tuple[object, ...]]]:
        resolving.set()
        try:
            assert release.wait(2)
            return cast(
                list[tuple[socket.AddressFamily, socket.SocketKind, int, str, tuple[object, ...]]],
                original(host, port, family, type, proto, flags),
            )
        finally:
            resolved.set()

    monkeypatch.setattr(socket, "getaddrinfo", delayed_dns)
    client = Client(fake.url)
    try:
        with pytest.raises(VerifyError) as caught:
            client.request("POST", START, {}, deadline=Deadline(0.05))
        assert caught.value.code == "TIMEOUT"
        assert resolving.is_set() and not release.is_set()
        assert not fake.requests
    finally:
        release.set()
        assert resolved.wait(3)


@pytest.mark.parametrize("path", [START, PROXY + "execute_step"])
def test_truncated_content_length_never_confirms_or_replays_post(
    fake: FakeRevyl,
    path: str,
) -> None:
    session = fake.open() if path != START else None
    fake.handler = lambda request: (
        Reply(200, b"{}", {"Content-Length": "20"}) if request.path == path else None
    )
    with pytest.raises(VerifyError) as caught:
        if path == START:
            fake.open()
        else:
            assert session is not None
            session.instruction("Open settings")
    assert caught.value.code in ("API_ERROR", "ACTION_UNCERTAIN")
    assert len(fake.calls("POST", path)) == 1


def test_truncated_chunked_response_never_confirms_or_replays_post(fake: FakeRevyl) -> None:
    fake.handler = lambda request: Reply(
        200,
        b"2\r\n{}\r\n",
        {"Transfer-Encoding": "chunked"},
    )
    with pytest.raises(VerifyError) as caught:
        fake.open()
    assert caught.value.code == "API_ERROR"
    assert len(fake.calls("POST", START)) == 1
