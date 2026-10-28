from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from revyl_verify._computer import ComputerSession
from revyl_verify._models import Target
from revyl_verify._transport import Client, Deadline, Json, Response, VerifyError, obj

PROCESS_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 8 + (2).to_bytes(4, "big") + (3).to_bytes(4, "big")


class ComputerAPI:
    def __init__(self) -> None:
        self.id: str = ""
        self.os: Json = None
        self.calls: list[tuple[str, str, Json]] = []
        self.truncated_paths: set[str] = set()
        self.headers: list[str | None] = []
        self.stopped: bool = False
        self.create_state: str = "active"
        self.release: str = "confirmed"
        self.expiry: str | None = None
        self.pending: bool = False
        self.execution: dict[str, Json] | None = None
        self.result: dict[str, Json] | None = None
        self.evidence: Json = "recorded"
        self.operation_id: str = ""
        self.screens: list[tuple[int, Json]] = []
        self.recording: tuple[int, Json] = (
            200,
            {
                "url": "https://media.example.test/recording.mp4?signature=fixture-only",
                "duration_seconds": 12.5,
                "started_at": "2026-10-26T12:00:00Z",
            },
        )
        self.override: Callable[[str, str, Json], tuple[int, Json] | None] | None = None
        api = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.respond("GET")

            def do_POST(self) -> None:
                self.respond("POST")

            def log_message(self, format: str, *args: object) -> None:
                pass

            def respond(self, method: str) -> None:
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = Response(200, data).json() if data else None
                api.calls.append((method, self.path, body))
                api.headers.append(self.headers.get("Prefer"))
                status, response = api.respond(method, self.path, body)
                encoded = json.dumps(response).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                advertised = len(encoded) + (1 if self.path in api.truncated_paths else 0)
                self.send_header("Content-Length", str(advertised))
                self.end_headers()
                try:
                    self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def report(self) -> dict[str, Json]:
        report: dict[str, Json] = {
            "computer_session_id": self.id,
            "state": "stopped" if self.stopped else self.create_state,
            "release": self.release if self.stopped else "pending",
        }
        if self.expiry is not None:
            report["expires_at"] = self.expiry
        return report

    def envelope(self) -> dict[str, Json]:
        return {
            "computer_session_id": self.id,
            "operation_id": self.operation_id,
            "evidence": self.evidence,
            "execution": self.execution,
        }

    def respond(self, method: str, path: str, body: Json) -> tuple[int, Json]:
        if self.override is not None:
            overridden = self.override(method, path, body)
            if overridden is not None:
                return overridden
        if path == "/api/v1/computer-runs":
            request = obj(body)
            self.id = str(request["computer_session_id"])
            self.os = request["os"]
            self.stopped = False
            return 200, self.report()
        suffix = path.removeprefix(f"/api/v1/computer-runs/{self.id}")
        if suffix == "/stop":
            self.stopped = True
            return 200, self.report()
        if suffix == "/report":
            return 200, self.report()
        if suffix == "/recording":
            return self.recording
        if suffix == "/screen/screenshot":
            if self.screens:
                return self.screens.pop(0)
            return 200, {"png": base64.b64encode(PNG).decode(), "width": 2, "height": 3}
        if suffix == "/operations":
            request = obj(body)
            self.operation_id = str(uuid.uuid5(uuid.UUID(self.id), str(request["request_id"])))
            command = obj(request["command"])
            if self.execution is None:
                result = self.result
                if result is None:
                    kind = command["kind"]
                    if kind == "exec":
                        result = {"kind": kind, "exit_code": 0, "stdout": "b2sK", "stderr": ""}
                    elif kind == "file_read":
                        result = {"kind": kind, "data": "AP8="}
                    elif kind == "file_write":
                        data = command["data"]
                        assert isinstance(data, str)
                        result = {"kind": kind, "byte_count": len(base64.b64decode(data))}
                    elif kind == "file_stat":
                        result = {"kind": kind, "file_kind": "file", "size_bytes": 2}
                    elif kind == "process_list":
                        result = {
                            "kind": kind,
                            "processes": [
                                {
                                    "handle": {
                                        "computer_session_id": self.id,
                                        "handle_id": PROCESS_ID,
                                    },
                                    "state": "running",
                                }
                            ],
                        }
                    else:
                        result = {"kind": kind, "termination": "confirmed"}
                self.execution = {"outcome": "succeeded", "result": result}
            if self.pending:
                return 202, None
            return 200, self.envelope()
        if suffix == f"/operations/{self.operation_id}":
            return 200, self.envelope()
        return 404, {"detail": "inaccessible"}


class ComputerTests(unittest.TestCase):
    def setUp(self) -> None:
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        isolated_environment = patch.dict(
            os.environ,
            {
                "HOME": home.name,
                "REVYL_API_KEY": "fixture-token",
            },
        )
        isolated_environment.start()
        self.addCleanup(isolated_environment.stop)
        self.api = ComputerAPI()
        self.addCleanup(self.api.close)
        with patch("revyl_verify._transport.credentials", return_value="fixture-token"):
            self.client = Client(f"http://127.0.0.1:{self.api.server.server_port}")

    def start(self, platform: str = "mac") -> ComputerSession:
        target = Target("linux" if platform == "linux" else "mac")
        return ComputerSession.start(self.client, "https://app.example.test", target, 30)

    def assert_code(self, code: str, callback: Callable[[], object]) -> VerifyError:
        with self.assertRaises(VerifyError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def reset_operation(self) -> None:
        self.api.execution = None
        self.api.result = None

    def test_platforms_and_all_operations(self) -> None:
        for platform, os_name in (("mac", "macos"), ("linux", "linux")):
            with self.subTest(platform=platform):
                self.reset_operation()
                session = self.start(platform)
                self.assertEqual(self.api.os, os_name)
                self.assertEqual(session.platform, platform)
                self.assertEqual(session.steps, [])
                self.assertIn(f"/sessions/{session.id}?kind=computer", session.viewer_url)
                self.assertEqual(
                    session.exec(["printf", "ok"], stdin="hi", timeout=0.001).stdout, "ok\n"
                )
                self.assertEqual(self.api.headers[-1], "respond-async")
                command = obj(obj(self.api.calls[-1][2])["command"])
                self.assertEqual(command["timeout_ms"], 1)
                self.assertEqual(command["stdin"], "aGk=")
                self.reset_operation()
                self.assertEqual(session.read_file("folder/file"), b"\0\xff")
                self.reset_operation()
                session.write_file("file", "é")
                self.reset_operation()
                self.assertEqual(session.stat("file").size, 2)
                self.reset_operation()
                self.assertEqual(session.processes()[0].id, PROCESS_ID)
                self.reset_operation()
                session.terminate(PROCESS_ID)
                self.assertEqual(session.screenshot(), PNG)
                session.close()
                session.close()
                self.assertTrue(session.closed)
                self.assert_code("SESSION_ENDED", lambda: session.exec(["true"]))
                self.assert_code("NOT_AVAILABLE_ON_PLATFORM", lambda: session.instruction("click"))
                self.assert_code("NOT_AVAILABLE_ON_PLATFORM", lambda: session.validation("exists"))
                self.assertEqual(session.report()["state"], "stopped")
                recording = session.recording()
                self.assertIsNotNone(recording)
                assert recording is not None
                self.assertEqual(recording.duration_seconds, 12.5)

    def test_shared_uuid_fixture_and_async_null_poll(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures/computer-contract.json"
        fixture = obj(Response(200, fixture_path.read_bytes()).json())
        vector = obj(fixture["uuidV5"])
        session_id = vector["session_id"]
        request_id = vector["request_id"]
        assert isinstance(session_id, str) and isinstance(request_id, str)
        self.api.id = session_id
        session = ComputerSession(
            self.client, session_id, session_id, "mac", "https://example.test", 30
        )
        self.api.pending = True
        with (
            patch(
                "revyl_verify._computer.uuid.uuid4",
                return_value=uuid.UUID(request_id),
            ),
            patch.object(Deadline, "pause"),
        ):
            self.assertEqual(session.exec(["true"]).exit_code, 0)
        self.assertEqual(self.api.operation_id, vector["operation_id"])
        self.assertTrue(self.api.calls[-1][1].endswith(self.api.operation_id))

    def test_nonzero_check_and_result(self) -> None:
        session = self.start()
        self.api.execution = {
            "outcome": "failed",
            "error_code": "exec_nonzero",
            "result": {"kind": "exec", "exit_code": 7, "stdout": "", "stderr": "bm8="},
        }
        error = self.assert_code("COMMAND_FAILED", lambda: session.exec(["false"]))
        self.assertEqual(getattr(error.result, "exit_code"), 7)
        self.assertEqual(session.exec(["false"], check=False).stderr, "no")
        self.assertNotIn("bm8=", error.message)

    def test_execution_outcomes_and_malformed_envelopes(self) -> None:
        session = self.start()
        cases: list[tuple[dict[str, Json], str]] = [
            ({"outcome": "failed", "error_code": "not_found"}, "NOT_FOUND"),
            ({"outcome": "failed", "error_code": "access_denied"}, "ACCESS_DENIED"),
            ({"outcome": "failed", "error_code": "private-detail"}, "API_ERROR"),
            ({"outcome": "timed_out", "termination": "confirmed"}, "TIMEOUT"),
            ({"outcome": "timed_out", "termination": "unknown"}, "ACTION_UNCERTAIN"),
            ({"outcome": "timed_out", "termination": "bad"}, "API_ERROR"),
            ({"outcome": "unknown"}, "ACTION_UNCERTAIN"),
            ({"outcome": "bad"}, "API_ERROR"),
            ({"outcome": "succeeded", "result": {"kind": "file_read"}}, "API_ERROR"),
            ({"outcome": "succeeded", "result": {"kind": "exec", "exit_code": 1}}, "API_ERROR"),
            (
                {
                    "outcome": "failed",
                    "error_code": "exec_nonzero",
                    "result": {"kind": "exec", "exit_code": 0},
                },
                "API_ERROR",
            ),
        ]
        for execution, code in cases:
            with self.subTest(execution=execution):
                self.api.execution = execution
                self.assert_code(code, lambda: session.exec(["true"]))
        invalid_evidence: list[Json] = [None, "bad", [], {}]
        for evidence in invalid_evidence:
            with self.subTest(evidence=evidence):
                self.api.execution = {
                    "outcome": "succeeded",
                    "result": {"kind": "exec", "exit_code": 0},
                }
                self.api.evidence = evidence
                self.assert_code("API_ERROR", lambda: session.exec(["true"]))

    def test_http_error_mapping_and_sanitization(self) -> None:
        session = self.start()
        cases = [
            (403, "computer_not_enabled", "NOT_AVAILABLE_ON_PLATFORM"),
            (503, "runtime_unavailable", "NOT_AVAILABLE_ON_PLATFORM"),
            (429, "computer_limit", "COMPUTER_LIMIT"),
            (409, "run_closed", "SESSION_ENDED"),
            (404, "inaccessible", "NOT_FOUND"),
            (404, "invalid_handle", "NOT_FOUND"),
            (404, "operation_not_found", "ACTION_UNCERTAIN"),
            (503, "owner_unavailable", "ACTION_UNCERTAIN"),
            (422, "private-detail", "INVALID_ARGUMENT"),
            (401, "private-detail", "AUTH_REJECTED"),
            (400, "start_failed", "SESSION_START_FAILED"),
            (409, "request_conflict", "SESSION_BUSY"),
            (400, "operation_limit", "SESSION_BUSY"),
            (500, "private-detail", "ACTION_UNCERTAIN"),
            (302, "private-detail", "ACTION_UNCERTAIN"),
            (400, "private-detail", "API_ERROR"),
        ]
        for status, detail, code in cases:
            with self.subTest(status=status, detail=detail):
                self.api.override = lambda method, path, body: (status, {"detail": detail})
                error = self.assert_code(code, lambda: session.exec(["true"]))
                self.assertNotIn("private-detail", error.message)
        self.assertEqual(
            len([call for call in self.api.calls if call[0] == "POST"]), len(cases) + 1
        )

    def test_invalid_inputs_have_no_requests(self) -> None:
        session = self.start()
        count = len(self.api.calls)
        for argv in ([], [""], ["true\0"], ["x"] * 65, ["é" * 8193]):
            self.assert_code("INVALID_ARGUMENT", lambda: session.exec(argv))
        for timeout in (0, -1, 300.001, 0.0001, 0.0015, float("nan"), float("inf"), True, 10**500):
            self.assert_code("INVALID_ARGUMENT", lambda: session.exec(["true"], timeout=timeout))
        for path in ("", "/file", "a//b", "a/./b", "../b", "x\\y", "a:b", "x\x7f", "é" * 513):
            self.assert_code("INVALID_ARGUMENT", lambda: session.read_file(path))
        self.assert_code("INVALID_ARGUMENT", lambda: session.write_file("file", b"x" * 65_537))
        self.assert_code("INVALID_ARGUMENT", lambda: session.exec(["true"], stdin=b"x" * 16_384))
        self.assert_code("INVALID_ARGUMENT", lambda: session.terminate("1234"))
        self.assertEqual(len(self.api.calls), count)

    def test_output_validation(self) -> None:
        session = self.start()
        invalid_results: list[dict[str, Json]] = [
            {"kind": "exec", "exit_code": True},
            {"kind": "exec", "exit_code": 256},
            {"kind": "exec", "exit_code": 0, "stdout": "Zh=="},
            {"kind": "exec", "exit_code": 0, "stdout": "A"},
            {
                "kind": "exec",
                "exit_code": 0,
                "stdout": base64.b64encode(b"x" * 1_048_576).decode(),
                "stderr": "eA==",
            },
        ]
        for result in invalid_results:
            self.api.execution = {"outcome": "succeeded", "result": result}
            self.assert_code("API_ERROR", lambda: session.exec(["true"]))
        self.api.execution = {
            "outcome": "succeeded",
            "result": {"kind": "exec", "exit_code": 0, "stdout": "_w==", "stderr": ""},
        }
        self.assertEqual(session.exec(["true"]).stdout, "\ufffd")
        for value in (-1, True, 9_007_199_254_740_992, 1.5):
            self.api.execution = {
                "outcome": "succeeded",
                "result": {"kind": "file_stat", "file_kind": "file", "size_bytes": value},
            }
            self.assert_code("API_ERROR", lambda: session.stat("file"))
        self.api.execution = {
            "outcome": "succeeded",
            "result": {"kind": "file_write", "byte_count": 2},
        }
        self.assert_code("API_ERROR", lambda: session.write_file("file", b"x"))
        self.api.execution = {
            "outcome": "succeeded",
            "result": {"kind": "process_terminate", "termination": "unknown"},
        }
        self.assert_code("API_ERROR", lambda: session.terminate(PROCESS_ID))

    def test_process_validation(self) -> None:
        session = self.start()
        valid: dict[str, Json] = {
            "handle": {"computer_session_id": session.id, "handle_id": PROCESS_ID},
            "state": "running",
        }
        invalid: list[Json] = [
            None,
            {
                "handle": {"computer_session_id": "other", "handle_id": PROCESS_ID},
                "state": "running",
            },
            {**valid, "exit_code": 0},
            {**valid, "state": "bad"},
            {**valid, "state": "exited", "exit_code": True},
        ]
        for process in invalid:
            self.api.execution = {
                "outcome": "succeeded",
                "result": {"kind": "process_list", "processes": [process]},
            }
            self.assert_code("API_ERROR", session.processes)
        invalid_process_lists: list[list[Json]] = [[valid, valid], [valid] * 65]
        for processes in invalid_process_lists:
            self.api.execution = {
                "outcome": "succeeded",
                "result": {"kind": "process_list", "processes": processes},
            }
            self.assert_code("API_ERROR", session.processes)

    def test_screenshot_retry_fixed_window_and_file(self) -> None:
        session = self.start("linux")
        self.api.screens = [
            (503, {"detail": "screen_unavailable"}),
            (409, {"message": "screen_starting"}),
        ]
        with patch.object(Deadline, "pause") as pause, tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "screen.png"
            self.assertEqual(session.screenshot(path=path), PNG)
            self.assertEqual(path.read_bytes(), PNG)
            self.assertEqual([call.args[0] for call in pause.call_args_list], [0.5, 1])
        session._screen_ready_until = time.monotonic() - 1
        self.api.screens = [(503, {"error": "screen_unavailable"})]
        self.assert_code("SESSION_BUSY", session.screenshot)
        self.assertEqual(session.screenshot(), PNG)
        self.api.screens = [(503, {"detail": "screen_starting"})]
        self.assert_code("API_ERROR", session.screenshot)
        self.api.screens = [(200, {"png": base64.b64encode(PNG).decode(), "width": 3, "height": 3})]
        self.assert_code("API_ERROR", session.screenshot)

    def test_release_is_confirmed_and_close_is_cached(self) -> None:
        session = self.start()
        self.api.release = "pending"
        error = self.assert_code("ACTION_UNCERTAIN", session.close)
        self.assertTrue(session.closed)
        again = self.assert_code("ACTION_UNCERTAIN", session.close)
        self.assertIs(error, again)
        self.assertEqual(sum(path.endswith("/stop") for _, path, _ in self.api.calls), 1)
        self.assert_code("SESSION_BUSY", session.recording)

    def test_expiry_prevents_work_but_allows_close_and_recording(self) -> None:
        self.api.expiry = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        session = self.start()
        self.assertIsNotNone(session.expires_at)
        count = len(self.api.calls)
        self.assert_code("SESSION_ENDED", lambda: session.exec(["true"]))
        self.assert_code("SESSION_ENDED", session.screenshot)
        self.assertEqual(len(self.api.calls), count)
        session.close()
        self.assertIsNotNone(session.recording())

    def test_recording_validation_and_unavailable(self) -> None:
        session = self.start()
        self.assert_code("SESSION_BUSY", session.recording)
        session.close()
        for url in (
            "http://media.example.test/a",
            "https://u:p@media.example.test/a",
            "https://media.example.test/a#x",
            "https://media.example.test/a\n",
            "https://",
        ):
            self.api.recording = 200, {"url": url}
            self.assert_code("API_ERROR", session.recording)
        for duration in (-1, True, "12", 10**500):
            self.api.recording = (
                200,
                {"url": "https://media.example.test/a", "duration_seconds": duration},
            )
            self.assert_code("API_ERROR", session.recording)
        self.api.recording = 404, {"error": "recording_unavailable"}
        self.assertIsNone(session.recording())
        self.api.recording = 404, {"error": "other"}
        self.assert_code("API_ERROR", session.recording)

    def test_start_refusal_does_not_stop_and_failure_does(self) -> None:
        for status, detail in (
            (403, "computer_not_enabled"),
            (503, "runtime_unavailable"),
            (429, "computer_limit"),
            (422, "invalid_request"),
        ):
            self.api.calls.clear()
            self.api.override = lambda method, path, body: (status, {"detail": detail})
            with self.assertRaises(VerifyError):
                self.start()
            self.assertEqual(len(self.api.calls), 1)
        self.api.override = None
        self.api.calls.clear()
        self.api.create_state = "failed"
        self.assert_code("SESSION_START_FAILED", self.start)
        self.assertEqual(sum(path.endswith("/stop") for _, path, _ in self.api.calls), 1)

    def test_request_transport_failure_is_uncertain_not_replayed(self) -> None:
        session = self.start()
        with patch.object(
            self.client, "request", side_effect=VerifyError("TIMEOUT", "private-detail")
        ) as request:
            error = self.assert_code("ACTION_UNCERTAIN", lambda: session.exec(["true"]))
            self.assertNotIn("private-detail", error.message)
            self.assertEqual(request.call_count, 1)

    def test_start_poll_identity_and_cleanup(self) -> None:
        self.api.create_state = "starting"

        def active(method: str, path: str, body: Json) -> tuple[int, Json] | None:
            if path.endswith("/report"):
                self.api.create_state = "active"
            return None

        self.api.override = active
        with patch.object(Deadline, "pause") as pause:
            session = self.start()
        self.assertEqual(pause.call_args.args, (2,))
        self.assertEqual(session.report()["state"], "active")
        self.api.override = lambda method, path, body: (
            (200, {"computer_session_id": "other", "state": "active"})
            if path.endswith("/report")
            else None
        )
        self.assert_code("API_ERROR", session.report)
        invalid_states: list[Json] = [[], {}, "invalid"]
        for state in invalid_states:
            self.api.override = lambda method, path, body: (
                200,
                {"computer_session_id": session.id, "state": state},
            )
            self.assert_code("API_ERROR", session.report)

    def test_async_requires_null_and_matching_identity(self) -> None:
        session = self.start()
        self.api.override = lambda method, path, body: (
            (202, {}) if path.endswith("/operations") else None
        )
        self.assert_code("API_ERROR", lambda: session.exec(["true"]))
        self.api.override = None
        session.exec(["true"])
        for field, value in (("computer_session_id", "other"), ("operation_id", "other")):

            def mismatch(method: str, path: str, body: Json) -> tuple[int, Json] | None:
                return 200, {**self.api.envelope(), field: value}

            self.api.override = mismatch
            self.assert_code("API_ERROR", lambda: session.exec(["true"]))

    def test_operation_observation_deadline_and_close_cancellation(self) -> None:
        session = self.start()
        self.api.pending = True
        with patch.object(session, "_observation_deadline", return_value=Deadline(0.01)):
            self.assert_code("ACTION_UNCERTAIN", lambda: session.exec(["true"]))
        self.assertEqual(sum(path.endswith("/operations") for _, path, _ in self.api.calls), 1)
        response = Response(202, b"null")

        def close_during_request(
            method: str, suffix: str, body: Json, deadline: Deadline
        ) -> Response:
            session._closed = True
            return response

        with patch.object(session, "_request", side_effect=close_during_request):
            self.assert_code("ACTION_UNCERTAIN", lambda: session.exec(["true"]))

    def test_expiry_caps_observation_deadline(self) -> None:
        self.api.expiry = (datetime.now(timezone.utc) + timedelta(seconds=10)).isoformat()
        session = self.start()
        self.assertLessEqual(session._observation_deadline(310).remaining(), 10)

    def test_close_interrupts_in_flight_operation_without_replay(self) -> None:
        session = self.start()
        entered, release, completed = threading.Event(), threading.Event(), threading.Event()
        failures: list[VerifyError] = []

        def blocked_operation(method: str, path: str, body: Json) -> tuple[int, Json] | None:
            if method == "POST" and path.endswith("/operations"):
                entered.set()
                self.assertTrue(release.wait(3))
            return None

        def execute() -> None:
            try:
                session.exec(["sleep", "300"])
            except VerifyError as error:
                failures.append(error)
            finally:
                completed.set()

        self.api.override = blocked_operation
        worker = threading.Thread(target=execute)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            session.close()
            self.assertTrue(completed.wait(1), "close left the operation waiting on its response")
            self.assertFalse(release.is_set())
            self.assertTrue(session.closed)
            self.assertTrue(self.api.stopped)
            self.assertEqual([error.code for error in failures], ["ACTION_UNCERTAIN"])
            self.assertEqual(sum(path.endswith("/operations") for _, path, _ in self.api.calls), 1)
            self.assertEqual(sum(path.endswith("/stop") for _, path, _ in self.api.calls), 1)
        finally:
            release.set()
            worker.join(3)

    def test_interrupted_close_caches_uncertainty_without_replay(self) -> None:
        session = self.start()
        with patch.object(session, "_request", side_effect=KeyboardInterrupt) as request:
            with self.assertRaises(KeyboardInterrupt):
                session.close()
            self.assert_code("ACTION_UNCERTAIN", session.close)
            self.assertEqual(request.call_count, 1)
        self.assertTrue(session.closed)

    def test_truncated_mutation_response_cannot_confirm_result_or_release(self) -> None:
        for suffix in ("/operations", "/stop"):
            with self.subTest(suffix=suffix):
                self.reset_operation()
                session = self.start()
                path = f"/api/v1/computer-runs/{session.id}{suffix}"
                self.api.truncated_paths.add(path)
                operation = session.close if suffix == "/stop" else lambda: session.exec(["true"])
                self.assert_code("ACTION_UNCERTAIN", operation)
                if suffix == "/stop":
                    self.assert_code("ACTION_UNCERTAIN", session.close)
                self.assertEqual(sum(call_path == path for _, call_path, _ in self.api.calls), 1)
                self.api.truncated_paths.clear()
                if not session.closed:
                    session.close()

    def test_start_deadline_cleans_up_and_returns_timeout(self) -> None:
        self.api.create_state = "starting"
        with patch("revyl_verify._computer.Deadline", side_effect=[Deadline(0.05), Deadline(310)]):
            self.assert_code("TIMEOUT", self.start)
        self.assertTrue(any(path.endswith("/stop") for _, path, _ in self.api.calls))

    def test_confirmed_release_requires_terminal_state(self) -> None:
        session = self.start()
        self.api.override = lambda method, path, body: (
            (200, {"computer_session_id": session.id, "state": "active", "release": "confirmed"})
            if path.endswith("/stop")
            else None
        )
        self.assert_code("API_ERROR", session.close)


if __name__ == "__main__":
    unittest.main()
