from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import get_args

import pytest
from test_async import event_is_set
from test_device import (
    APP_ID,
    BUILD_ID,
    PROXY,
    SESSION_ID,
    START,
    FakeRevyl,
    Reply,
    Request,
    fake,
    isolated_environment,
)

import revyl_verify as verify
from revyl_verify import (
    ComputerSession,
    Platform,
    RefusalReason,
    SignIn,
    Target,
    VerifyError,
    Viewport,
)
from revyl_verify._transport import Json, obj

__all__ = ["fake", "isolated_environment"]

COMPUTER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
COMPUTERS = "/api/v1/computer-runs"


@dataclass
class HostedAPI:
    fake: FakeRevyl
    id: str = COMPUTER_ID
    os: str = "macos"
    state: str = "active"
    expiry: str = field(
        default_factory=lambda: (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    )
    handler: Callable[[Request], Reply | None] | None = None

    def respond(self, request: Request) -> Reply | None:
        if self.handler:
            reply = self.handler(request)
            if reply is not None:
                return reply
        if request.path == COMPUTERS:
            self.id = str(request.body["computer_session_id"])
            self.os = str(request.body["os"])
            return Reply(body=self.report())
        if request.path == self.path("/report"):
            return Reply(body=self.report())
        if request.path == self.path("/stop"):
            self.state = "stopped"
            return Reply(body=self.report())
        if request.path == START and "computer_session_id" in request.body:
            return Reply(
                body={"session_id": request.body["session_id"], "workflow_run_id": "run-1"}
            )
        if request.path == PROXY + "open_url":
            return Reply(body={"success": True, "action": "navigate", "status_code": 200})
        return None

    def path(self, suffix: str) -> str:
        return COMPUTERS + "/" + self.id + suffix

    def report(self) -> dict[str, Json]:
        return {
            "computer_session_id": self.id,
            "os": self.os,
            "state": self.state,
            "expires_at": self.expiry,
            "release": "confirmed" if self.state == "stopped" else "pending",
        }

    def attach(self) -> ComputerSession:
        session = verify.attach(self.id, backend_url=self.fake.url)
        self.fake.sessions.append(session)
        return session


@pytest.fixture
def hosted(fake: FakeRevyl) -> HostedAPI:
    api = HostedAPI(fake)
    fake.handler = api.respond
    return api


@pytest.mark.parametrize("os_name,platform", [("macos", "mac"), ("linux", "linux")])
def test_attach_uses_report_only_and_owns_close(
    hosted: HostedAPI, os_name: str, platform: Platform
) -> None:
    hosted.os = os_name
    logs: list[str] = []
    with verify.attach(
        hosted.id,
        backend_url=hosted.fake.url,
        app_url="https://viewer.example.test/custom",
        step_timeout=47,
        log=logs.append,
    ) as computer:
        assert computer.platform == platform
        assert computer.expires_at == datetime.fromisoformat(hosted.expiry)
        assert computer._step_timeout == 47
        assert computer.viewer_url == (
            f"https://viewer.example.test/custom/sessions/{hosted.id}?kind=computer"
        )
        assert [(r.method, r.path) for r in hosted.fake.requests] == [
            ("GET", hosted.path("/report"))
        ]
        assert hosted.fake.requests[0].headers["Authorization"] == "Bearer test-token"
    assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1
    assert logs == [f"{platform}: attached", f"{platform}: physical release confirmed"]


@pytest.mark.parametrize(
    "change",
    [
        {"computer_session_id": SESSION_ID},
        {"state": "starting"},
        {"state": "failed"},
        {"state": "unknown"},
        {"os": "windows"},
        {"os": None},
        {"expires_at": None},
        {"expires_at": "bad"},
        {"expires_at": "2000-01-01T00:00:00Z"},
    ],
)
def test_attach_invalid_report_never_stops(hosted: HostedAPI, change: dict[str, Json]) -> None:
    hosted.handler = lambda request: (
        Reply(body={**hosted.report(), **change})
        if request.path == hosted.path("/report")
        else None
    )
    with pytest.raises(VerifyError) as caught:
        hosted.attach()
    assert caught.value.cleanup_status == "not_required"
    assert all(request.method == "GET" for request in hosted.fake.requests)


@pytest.mark.parametrize("status", [401, 403, 404, 503])
def test_attach_http_failure_never_mutates(hosted: HostedAPI, status: int) -> None:
    hosted.handler = lambda request: Reply(status, {"detail": "untrusted secret"})
    with pytest.raises(VerifyError) as caught:
        hosted.attach()
    assert caught.value.http_status == status
    assert "untrusted secret" not in str(caught.value)
    assert all(request.method == "GET" for request in hosted.fake.requests)


@pytest.mark.parametrize("computer_id", ["", "../bad", "not-a-uuid"])
def test_attach_rejects_invalid_id_before_io(hosted: HostedAPI, computer_id: str) -> None:
    with pytest.raises(VerifyError, match="INVALID_ARGUMENT"):
        verify.attach(computer_id, backend_url=hosted.fake.url)
    assert not hosted.fake.requests


@pytest.mark.parametrize(
    "parent_platform,child_platform",
    [("mac", "web"), ("mac", "ios"), ("linux", "web"), ("linux", "android")],
)
def test_hosted_start_reuses_parent_and_normal_session(
    hosted: HostedAPI, parent_platform: Platform, child_platform: Platform
) -> None:
    parent = hosted.fake.open(Target(parent_platform))
    target = Target(child_platform, app_id=APP_ID, build_id=BUILD_ID)
    if child_platform == "web":
        target = replace(
            target,
            viewport=Viewport(1280, 720, 2),
            sign_in=SignIn("/login", "test-secret"),
            idle_timeout_seconds=120,
        )
    child = parent.open(target)
    assert child._client is parent._client
    assert child._step_timeout == parent._step_timeout
    assert child._log_callback is parent._log_callback
    assert child.expires_at == parent.expires_at
    assert child.id != parent.id
    assert child.viewer_url == f"https://viewer.test/sessions/{child.id}"
    assert child.instruction("Open the app").passed
    assert child.validation("The app is visible").passed
    assert child.screenshot()
    assert child.report()["status"] == "running"
    start = hosted.fake.calls("POST", START)
    assert len(start) == 1
    assert start[0].body == {
        "platform": child_platform,
        "app_id": APP_ID,
        "build_id": BUILD_ID,
        "computer_session_id": parent.id,
        "session_id": child.id,
        "idle_timeout_seconds": 120 if child_platform == "web" else 600,
        **(
            {
                "web": {
                    "viewport": {"width": 1280, "height": 720, "device_scale_factor": 2},
                    "sign_in": {"path": "/login", "secret_name": "test-secret"},
                }
            }
            if child_platform == "web"
            else {"is_simulation": True}
        ),
    }
    parent.close()
    stops = [r.path for r in hosted.fake.requests if r.path.endswith("/stop")]
    assert stops == [f"/api/v1/execution/device/sessions/{child.id}/stop", hosted.path("/stop")]
    assert child.closed
    with pytest.raises(VerifyError, match="SESSION_ENDED"):
        parent.open(target)


@pytest.mark.parametrize("platform", ["web", "ios", "android"])
@pytest.mark.parametrize(
    "change",
    [
        lambda target: replace(target, app_id=None),
        lambda target: replace(target, build_id=None),
        lambda target: replace(target, app_id="invalid"),
        lambda target: replace(target, build_id="invalid"),
        lambda target: replace(target, url="https://example.test"),
        lambda target: replace(target, branch="main"),
        lambda target: replace(target, bundle_id="com.example.app"),
        lambda target: replace(target, artifact_url="https://example.test/app.zip"),
        lambda target: replace(target, device_model="iPhone"),
        lambda target: replace(target, os_version="27"),
    ],
)
def test_hosted_target_requires_exact_build_without_overrides(
    hosted: HostedAPI, platform: Platform, change: Callable[[Target], Target]
) -> None:
    parent = hosted.attach()
    target = change(Target(platform, app_id=APP_ID, build_id=BUILD_ID))
    with pytest.raises(VerifyError, match="INVALID_ARGUMENT"):
        parent.open(target)
    assert not hosted.fake.calls("POST", START)


@pytest.mark.parametrize("platform", ["mac", "linux"])
def test_computers_cannot_be_children(hosted: HostedAPI, platform: Platform) -> None:
    parent = hosted.attach()
    with pytest.raises(VerifyError, match="INVALID_ARGUMENT"):
        parent.open(Target(platform))
    assert not hosted.fake.calls("POST", START)


@pytest.mark.parametrize("os_name,platform", [("macos", "android"), ("linux", "ios")])
def test_cross_os_child_is_refused_locally(
    hosted: HostedAPI, os_name: str, platform: Platform
) -> None:
    hosted.os = os_name
    parent = hosted.attach()
    with pytest.raises(VerifyError) as caught:
        parent.open(Target(platform, app_id=APP_ID, build_id=BUILD_ID))
    assert caught.value.reason == "computer_cannot_host_platform"
    assert not hosted.fake.calls("POST", START)


@pytest.mark.parametrize(
    "reason",
    [
        reason
        for reason in get_args(RefusalReason)
        if reason not in ("request_timeout", "protocol_error")
    ],
)
def test_hosted_refusals_are_typed_safe_and_do_not_stop(
    hosted: HostedAPI, reason: RefusalReason
) -> None:
    parent = hosted.attach()
    hosted.handler = lambda request: (
        Reply(503, {"detail": {"error": reason, "message": "never expose secret"}})
        if request.path == START
        else None
    )
    with pytest.raises(VerifyError) as caught:
        parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    error = caught.value
    assert error.reason == reason and error.http_status == 503
    if reason in {"computer_at_capacity", "computer_limit"}:
        assert error.code == "COMPUTER_LIMIT"
    elif reason == "computer_not_found":
        assert error.code == "NOT_FOUND"
    elif reason == "computer_not_running":
        assert error.code == "SESSION_ENDED"
    elif "_build_" in reason:
        assert error.code == "INVALID_ARGUMENT"
    elif reason.endswith("_session_conflict"):
        assert error.code == "SESSION_BUSY"
    else:
        assert error.code == "NOT_AVAILABLE_ON_PLATFORM"
    assert error.cleanup_status == "not_required"
    assert "never expose secret" not in str(error)
    assert not any(r.path.endswith("/stop") for r in hosted.fake.requests)
    assert not parent.closed
    assert len(hosted.fake.calls("POST", START)) == 1


@pytest.mark.parametrize("reason", ["request_timeout", "protocol_error"])
def test_hosted_transient_error_reasons_do_not_skip_startup_cleanup(
    hosted: HostedAPI, reason: RefusalReason
) -> None:
    parent = hosted.attach()
    hosted.handler = lambda request: (
        Reply(503, {"error": reason}) if request.path == START else None
    )
    with pytest.raises(VerifyError) as caught:
        parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    assert caught.value.reason == reason
    assert caught.value.code == "ACTION_UNCERTAIN"
    child_id = hosted.fake.calls("POST", START)[0].body["session_id"]
    assert len(hosted.fake.calls("POST", f"/api/v1/execution/device/sessions/{child_id}/stop")) == 1


@pytest.mark.parametrize(
    "change",
    [
        lambda body: {"bad": True},
        lambda body: {**body, "session_id": SESSION_ID},
        lambda body: {**body, "platform": "android"},
        lambda body: {**body, "workflow_run_id": ""},
        lambda body: {**body, "workflow_run_id": "../unsafe"},
    ],
)
def test_ambiguous_child_start_cleans_known_id_not_parent(
    hosted: HostedAPI, change: Callable[[dict[str, Json]], dict[str, Json]]
) -> None:
    parent = hosted.attach()
    hosted.handler = lambda request: (
        Reply(body=change({"session_id": request.body["session_id"], "workflow_run_id": "run-1"}))
        if request.path == START
        else None
    )
    with pytest.raises(VerifyError):
        parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    child_id = hosted.fake.calls("POST", START)[0].body["session_id"]
    stops = [r.path for r in hosted.fake.requests if r.path.endswith("/stop")]
    assert stops == [f"/api/v1/execution/device/sessions/{child_id}/stop"]
    assert not parent.closed


def test_unknown_parent_expiry_prevents_child_start(hosted: HostedAPI) -> None:
    parent = hosted.attach()
    parent._expires_at = None
    with pytest.raises(VerifyError, match="confirmed computer expiry"):
        parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    assert not hosted.fake.calls("POST", START)


@pytest.mark.parametrize("status", [400, 403, 404, 409, 422, 429, 408, 500])
def test_unrecognized_child_error_never_replays_and_cleans_only_ambiguous_starts(
    hosted: HostedAPI, status: int
) -> None:
    parent = hosted.attach()
    hosted.handler = lambda request: (
        Reply(status, {"detail": {"error": "untrusted", "message": "private"}})
        if request.path == START
        else None
    )
    with pytest.raises(VerifyError) as caught:
        parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    assert caught.value.reason is None
    assert caught.value.http_status == status
    assert "untrusted" not in str(caught.value) and "private" not in str(caught.value)
    assert not parent.closed
    assert len(hosted.fake.calls("POST", START)) == 1
    child_id = hosted.fake.calls("POST", START)[0].body["session_id"]
    stops = [r.path for r in hosted.fake.requests if r.path.endswith("/stop")]
    assert stops == (
        [f"/api/v1/execution/device/sessions/{child_id}/stop"] if status in (408, 500) else []
    )


def test_parent_expiry_bounds_child_start(hosted: HostedAPI) -> None:
    hosted.expiry = (datetime.now(timezone.utc) + timedelta(seconds=0.3)).isoformat()
    parent = hosted.attach()
    release = threading.Event()

    def respond(request: Request) -> Reply | None:
        if request.path == START:
            release.wait(2)
        return None

    hosted.handler = respond
    try:
        with pytest.raises(VerifyError, match="TIMEOUT"):
            parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID, start_timeout=60))
        assert not parent.closed
        assert len(hosted.fake.calls("POST", START)) == 1
    finally:
        release.set()


def test_expired_child_rejects_operations_but_preserves_report_and_close(hosted: HostedAPI) -> None:
    parent = hosted.attach()
    child = parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    child._expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    requests_before = len(hosted.fake.requests)
    for operation in (
        lambda: child.navigate("http://localhost:3000"),
        lambda: child.instruction("Open settings"),
        lambda: child.validation("Settings visible"),
        child.screenshot,
    ):
        with pytest.raises(VerifyError, match="SESSION_ENDED"):
            operation()
    assert len(hosted.fake.requests) == requests_before
    assert child.report()["status"] == "running"
    child.close()
    assert child.closed and not parent.closed


def test_child_inflight_operation_is_bounded_by_parent_expiry(hosted: HostedAPI) -> None:
    parent = hosted.attach()
    child = parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    child._expires_at = datetime.now(timezone.utc) + timedelta(seconds=0.2)
    release = threading.Event()

    def respond(request: Request) -> Reply | None:
        if request.path == PROXY + "open_url":
            release.wait(2)
        return None

    hosted.handler = respond
    try:
        with pytest.raises(VerifyError, match="TIMEOUT"):
            child.navigate("http://localhost:3000")
        assert len(hosted.fake.calls("POST", PROXY + "open_url")) == 1
        assert not parent.closed
    finally:
        release.set()


def test_parent_close_cancels_child_operation_and_stops_child_first(hosted: HostedAPI) -> None:
    parent = hosted.attach()
    child = parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    entered, release = threading.Event(), threading.Event()
    errors: list[BaseException] = []

    def respond(request: Request) -> Reply | None:
        if request.path == PROXY + "open_url":
            entered.set()
            release.wait(3)
        return None

    def navigate() -> None:
        try:
            child.navigate("http://localhost:3000")
        except BaseException as error:
            errors.append(error)

    hosted.handler = respond
    thread = threading.Thread(target=navigate)
    thread.start()
    try:
        assert entered.wait(2)
        parent.close()
        thread.join(1)
        assert not thread.is_alive()
        assert len(errors) == 1 and isinstance(errors[0], VerifyError)
        assert errors[0].code == "TIMEOUT"
        assert child.closed
        stops = [r.path for r in hosted.fake.requests if r.path.endswith("/stop")]
        assert stops == [f"/api/v1/execution/device/sessions/{child.id}/stop", hosted.path("/stop")]
    finally:
        release.set()
        thread.join(3)


def test_parent_close_waits_for_child_start_and_then_closes_in_order(hosted: HostedAPI) -> None:
    parent = hosted.attach()
    entered, release = threading.Event(), threading.Event()
    children: list[verify.Session] = []
    errors: list[BaseException] = []

    def respond(request: Request) -> Reply | None:
        if request.path == START:
            entered.set()
            assert release.wait(3)
        return None

    def opening() -> None:
        try:
            children.append(parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID)))
        except BaseException as error:
            errors.append(error)

    hosted.handler = respond
    thread = threading.Thread(target=opening)
    closing = threading.Thread(target=parent.close)
    thread.start()
    try:
        assert entered.wait(2)
        closing.start()
        with parent._child_condition:
            assert parent._child_condition.wait_for(lambda: parent.closed, timeout=2)
        closing.join(1)
        assert not closing.is_alive()
        assert not release.is_set()
        with pytest.raises(VerifyError, match="SESSION_ENDED"):
            parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
        assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1
    finally:
        release.set()
        thread.join(3)
        closing.join(3)
    assert not children
    assert len(errors) == 1 and isinstance(errors[0], VerifyError)
    assert errors[0].code == "TIMEOUT"
    child_id = hosted.fake.calls("POST", START)[0].body["session_id"]
    stops = [r.path for r in hosted.fake.requests if r.path.endswith("/stop")]
    assert stops == [
        f"/api/v1/execution/device/sessions/{child_id}/stop",
        hosted.path("/stop"),
    ]


def test_child_close_failure_does_not_prevent_parent_stop(hosted: HostedAPI) -> None:
    parent = hosted.attach()
    child = parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    hosted.handler = lambda request: (
        Reply(500, {"detail": "untrusted"})
        if request.path == f"/api/v1/execution/device/sessions/{child.id}/stop"
        else None
    )
    logs: list[str] = []
    parent._log_callback = logs.append
    parent.close()
    parent.close()
    assert hosted.state == "stopped"
    assert "mac: child cleanup unconfirmed; stopping parent" in logs
    assert parent._cleanup_status == "confirmed"
    assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1


def test_slow_child_closes_share_one_budget_before_parent_stop(
    hosted: HostedAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    from revyl_verify import _computer

    assert _computer._CHILD_CLEANUP_SECONDS == 5
    monkeypatch.setattr(_computer, "_CHILD_CLEANUP_SECONDS", 0.2)
    parent = hosted.attach()
    children = [parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID)) for _ in range(2)]
    release = threading.Event()

    def respond(request: Request) -> Reply | None:
        if request.path.startswith("/api/v1/execution/device/sessions/"):
            release.wait(3)
        return None

    hosted.handler = respond
    started = time.monotonic()
    try:
        parent.close()
        assert time.monotonic() - started < 1
        assert not release.is_set()
        assert parent._cleanup_status == "confirmed"
        assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1
        child_stops = [
            request.path
            for request in hosted.fake.requests
            if request.path.startswith("/api/v1/execution/device/sessions/")
        ]
        assert child_stops == [f"/api/v1/execution/device/sessions/{children[0].id}/stop"]
    finally:
        release.set()


def test_parent_stop_does_not_wait_forever_for_child_close_lock(
    hosted: HostedAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("revyl_verify._computer._CHILD_CLEANUP_SECONDS", 0.2)
    parent = hosted.attach()
    child = parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    child._close_lock.acquire()
    try:
        started = time.monotonic()
        parent.close()
        assert time.monotonic() - started < 1
        assert parent._cleanup_status == "confirmed"
        assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1
        assert not child.closed
    finally:
        child._close_lock.release()
        child.close()


def test_pending_start_join_budget_still_attempts_parent_stop(
    hosted: HostedAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("revyl_verify._computer._CHILD_CLEANUP_SECONDS", 0.2)
    parent = hosted.attach()
    entered, release = threading.Event(), threading.Event()
    failures: list[BaseException] = []

    def respond(request: Request) -> Reply | None:
        if request.path == START:
            entered.set()
            release.wait(3)
        elif request.path.startswith("/api/v1/execution/device/sessions/"):
            release.wait(3)
        return None

    def start_child() -> None:
        try:
            parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
        except BaseException as error:
            failures.append(error)

    hosted.handler = respond
    opening = threading.Thread(target=start_child)
    opening.start()
    try:
        assert entered.wait(2)
        started = time.monotonic()
        parent.close()
        assert time.monotonic() - started < 1
        assert not release.is_set()
        assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1
        assert parent._cleanup_status == "confirmed"
    finally:
        release.set()
        opening.join(3)
    assert not opening.is_alive() and len(failures) == 1


def test_interrupted_child_join_attempts_parent_stop_before_reraising(
    hosted: HostedAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    parent = hosted.attach()
    parent._child_starts = 1

    def interrupt(timeout: float | None = None) -> bool:
        raise KeyboardInterrupt

    monkeypatch.setattr(parent._child_condition, "wait", interrupt)
    with pytest.raises(KeyboardInterrupt):
        parent.close()
    assert len(hosted.fake.calls("POST", hosted.path("/stop"))) == 1
    assert parent._cleanup_status == "confirmed"
    parent.close()


@pytest.mark.parametrize("asynchronous", [False, True])
def test_report_without_known_id_is_not_found_without_io(
    hosted: HostedAPI, asynchronous: bool
) -> None:
    from revyl_verify._transport import Client

    session = verify.Session(Client(hosted.fake.url), "", "run-1", "ios", "", 30)
    with pytest.raises(VerifyError) as caught:
        if asynchronous:
            asyncio.run(verify.AsyncSession(session).report())
        else:
            session.report()
    assert caught.value.code == "NOT_FOUND"
    assert not hosted.fake.requests


def test_async_attach_child_navigation_and_close(hosted: HostedAPI) -> None:
    async def run() -> None:
        async with await verify.async_attach(hosted.id, backend_url=hosted.fake.url) as parent:
            async with await parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID)) as child:
                await child.navigate("http://localhost:3000/path?q=private#fragment")
                assert (await child.instruction("Open settings")).passed
                assert (await child.validation("Settings visible")).passed
                assert (await child.report())["status"] == "running"
            assert child.closed and not parent.closed
        assert parent.closed

    asyncio.run(run())
    assert len(hosted.fake.calls("POST", PROXY + "open_url")) == 1


@pytest.mark.parametrize("platform,os_name", [("ios", "macos"), ("android", "linux")])
def test_async_native_children_use_existing_session_operations(
    hosted: HostedAPI, platform: Platform, os_name: str
) -> None:
    hosted.os = os_name

    async def run() -> None:
        async with await verify.async_attach(hosted.id, backend_url=hosted.fake.url) as parent:
            child = await parent.open(Target(platform, app_id=APP_ID, build_id=BUILD_ID))
            assert (await child.instruction("Open settings")).passed
            assert (await child.validation("Settings visible")).passed
            assert await child.screenshot()
            assert (await child.report())["status"] == "running"
        assert child.closed

    asyncio.run(run())
    assert len(hosted.fake.calls("POST", START)) == 1


@pytest.mark.parametrize("phase", ["attach", "child"])
def test_async_cancelled_creation_never_closes_parent(hosted: HostedAPI, phase: str) -> None:
    entered, release = threading.Event(), threading.Event()

    def respond(request: Request) -> Reply | None:
        if request.path == (hosted.path("/report") if phase == "attach" else START):
            entered.set()
            assert release.wait(3)
        return None

    async def run() -> None:
        parent = hosted.attach() if phase == "child" else None
        hosted.handler = respond
        task = asyncio.create_task(
            verify.async_attach(hosted.id, backend_url=hosted.fake.url)
            if parent is None
            else verify.AsyncSession(parent).open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
        )
        try:
            await event_is_set(entered)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 0.5)
            if parent:
                for _ in range(300):
                    if parent._child_starts == 0:
                        break
                    await asyncio.sleep(0.005)
                assert parent._child_starts == 0 and not parent.closed
        finally:
            release.set()

    asyncio.run(run())
    assert not hosted.fake.calls("POST", hosted.path("/stop"))
    if phase == "attach":
        assert not any(request.method == "POST" for request in hosted.fake.requests)
    else:
        child_id = hosted.fake.calls("POST", START)[0].body["session_id"]
        assert (
            len(hosted.fake.calls("POST", f"/api/v1/execution/device/sessions/{child_id}/stop"))
            == 1
        )


@pytest.mark.parametrize("envelope", ["detail", "nested", "error"])
@pytest.mark.parametrize("asynchronous", [False, True])
def test_ordinary_web_capacity_preserves_code_and_safe_reason(
    hosted: HostedAPI, envelope: str, asynchronous: bool
) -> None:
    reason = "web_runtime_unavailable"
    body: dict[str, Json] = (
        {"detail": {"error": reason, "message": "private"}}
        if envelope == "nested"
        else {envelope: reason, "message": "private"}
    )
    hosted.handler = lambda request: Reply(409, body) if request.path == START else None
    with pytest.raises(VerifyError) as caught:
        target = Target("web", app_id=APP_ID, build_id=BUILD_ID)
        if asynchronous:
            asyncio.run(verify.async_open(target, backend_url=hosted.fake.url))
        else:
            hosted.fake.open(target)
    assert caught.value.code == "API_ERROR"
    assert caught.value.reason == reason and caught.value.http_status == 409
    assert "private" not in str(caught.value)
    assert caught.value.cleanup_status == "not_required"
    assert [(request.method, request.path) for request in hosted.fake.requests] == [("POST", START)]


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("phase", ["unknown_start_conflict", "readiness"])
def test_ordinary_web_uncertain_or_allocated_failure_keeps_cleanup(
    hosted: HostedAPI, asynchronous: bool, phase: str
) -> None:
    def respond(request: Request) -> Reply | None:
        if phase == "unknown_start_conflict" and request.path == START:
            return Reply(409, {"detail": "unknown conflict"})
        if phase == "readiness" and request.path.startswith("/api/v1/execution/device-sessions/"):
            return Reply(409, {"detail": {"error": "web_runtime_unavailable"}})
        return None

    hosted.handler = respond
    with pytest.raises(VerifyError) as caught:
        target = Target("web", app_id=APP_ID, build_id=BUILD_ID)
        if asynchronous:
            asyncio.run(verify.async_open(target, backend_url=hosted.fake.url))
        else:
            hosted.fake.open(target)
    assert caught.value.code == "API_ERROR"
    assert caught.value.cleanup_status == "acknowledged"
    starts = hosted.fake.calls("POST", START)
    assert len(starts) == 1
    session_id = starts[0].body["session_id"]
    assert (
        len(hosted.fake.calls("POST", f"/api/v1/execution/device/sessions/{session_id}/stop")) == 1
    )


@pytest.mark.parametrize(
    "status,reason,code",
    [
        (429, "computer_limit", "COMPUTER_LIMIT"),
        (503, "runtime_unavailable", "NOT_AVAILABLE_ON_PLATFORM"),
    ],
)
def test_computer_capacity_preserves_codes(
    hosted: HostedAPI, status: int, reason: RefusalReason, code: str
) -> None:
    hosted.handler = lambda request: (
        Reply(status, {"detail": reason}) if request.path == COMPUTERS else None
    )
    with pytest.raises(VerifyError) as caught:
        hosted.fake.open(Target("mac"))
    assert caught.value.code == code
    assert caught.value.reason == reason and caught.value.http_status == status
    assert not any(r.path.endswith("/stop") for r in hosted.fake.requests)


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:3000/",
        "http://127.0.0.1:3000/?q=test#fragment",
        "https://example.test/path",
        "http://[::1]:3000/",
    ],
)
def test_web_navigation_accepts_http_and_never_logs_url(hosted: HostedAPI, url: str) -> None:
    logs: list[str] = []
    with verify.open(
        Target("web", app_id=APP_ID, build_id=BUILD_ID),
        backend_url=hosted.fake.url,
        log=logs.append,
    ) as session:
        session.navigate(url)
    requests = hosted.fake.calls("POST", PROXY + "open_url")
    assert len(requests) == 1 and requests[0].body == {"url": url}
    assert all(url not in line for line in logs)


@pytest.mark.parametrize(
    "url",
    [
        "",
        "example.test",
        "ftp://example.test",
        "http://user:password@example.test",
        "http://user@example.test",
        "http://example.test\\@evil.test",
        "http://example.test/\n",
        "http://example.test/\x00",
        "http://example.test/\x7f",
        "http://example.test/\x85",
        "http://example.test/ space",
        "http://example.test/\u00a0space",
        "http:///path",
        "http://[invalid]",
        "http://localhost:99999",
    ],
)
def test_navigation_rejects_unsafe_url_before_io(hosted: HostedAPI, url: str) -> None:
    session = hosted.fake.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    with pytest.raises(VerifyError, match="INVALID_ARGUMENT"):
        session.navigate(url)
    assert not hosted.fake.calls("POST", PROXY + "open_url")


@pytest.mark.parametrize("platform", ["ios", "android", "mac", "linux"])
def test_navigation_is_web_only(hosted: HostedAPI, platform: Platform) -> None:
    session = hosted.fake.open(
        Target(platform) if platform in ("mac", "linux") else Target(platform, app_id=APP_ID)
    )
    with pytest.raises(VerifyError, match="NOT_AVAILABLE_ON_PLATFORM"):
        session.navigate("http://localhost:3000")
    assert not hosted.fake.calls("POST", PROXY + "open_url")


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"success": None},
        {"success": False},
        {"success": "true"},
        {"success": True, "action": "open_url"},
        {"success": True, "status_code": True},
        {"success": True, "status_code": 99},
        {"success": True, "status_code": 600},
        {"success": True, "status_code": "200"},
        {"success": True, "status_code": None},
        {"success": True, "action": None},
    ],
)
def test_navigation_requires_valid_success_envelope(
    hosted: HostedAPI, body: dict[str, Json]
) -> None:
    session = hosted.fake.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    hosted.handler = lambda request: (
        Reply(body=body) if request.path == PROXY + "open_url" else None
    )
    with pytest.raises(VerifyError) as caught:
        session.navigate("http://localhost:3000")
    assert caught.value.code == ("ACTION_FAILED" if body == {"success": False} else "API_ERROR")
    assert len(hosted.fake.calls("POST", PROXY + "open_url")) == 1


def test_navigation_accepts_absent_action_and_never_retries_failure(hosted: HostedAPI) -> None:
    session = hosted.fake.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    hosted.handler = lambda request: (
        Reply(body={"success": True}) if request.path == PROXY + "open_url" else None
    )
    session.navigate("http://localhost:3000")
    hosted.handler = lambda request: (
        Reply(503, {"message": "private URL and secret"})
        if request.path == PROXY + "open_url"
        else None
    )
    with pytest.raises(VerifyError) as caught:
        session.navigate("http://localhost:3000")
    assert "private URL and secret" not in str(caught.value)
    assert len(hosted.fake.calls("POST", PROXY + "open_url")) == 2
    assert obj(hosted.fake.requests[-1].body) == {"url": "http://localhost:3000"}


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("reason,status", [("request_timeout", 504), ("protocol_error", 502)])
def test_navigation_uncertainty_keeps_hosted_session_open(
    hosted: HostedAPI, asynchronous: bool, reason: RefusalReason, status: int
) -> None:
    parent = hosted.attach()
    session = parent.open(Target("web", app_id=APP_ID, build_id=BUILD_ID))
    hosted.handler = lambda request: (
        Reply(
            status,
            {
                "success": False,
                "action": "navigate",
                "error": reason,
                "code": reason,
                "failure_stage": "input",
                "input_dispatched": True,
                "execution_uncertain": True,
                "message": "private origin response",
            },
        )
        if request.path == PROXY + "open_url"
        else None
    )
    with pytest.raises(VerifyError) as caught:
        if asynchronous:
            asyncio.run(verify.AsyncSession(session).navigate("http://localhost:3000/private"))
        else:
            session.navigate("http://localhost:3000/private")
    assert caught.value.code == "ACTION_UNCERTAIN"
    assert caught.value.reason == reason and caught.value.http_status == status
    assert "private" not in str(caught.value)
    if reason == "request_timeout":
        assert "did not confirm within the action budget" in str(caught.value)
        assert "may still complete" in str(caught.value)
        assert "session is still open" in str(caught.value)
    assert len(hosted.fake.calls("POST", PROXY + "open_url")) == 1
    assert not any(request.path.endswith("/stop") for request in hosted.fake.requests)
    assert not session.closed
    assert session.screenshot()
    session.close()
