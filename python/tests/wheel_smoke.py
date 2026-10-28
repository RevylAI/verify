from __future__ import annotations

import asyncio
import json
import os
import struct
import tempfile
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def screenshot_png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(
                ">I",
                zlib.crc32(kind + data) & 0xFFFFFFFF,
            )
        )

    pixels = bytearray()
    for y in range(20):
        pixels.append(0)
        for x in range(20):
            pixels.extend(b"\x00\x00\x00" if (x, y) == (10, 10) else b"\xff\xff\xff")
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 20, 20, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(pixels)))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    requests: list[tuple[str, str, dict[str, object], dict[str, str]]] = []
    errors: list[str] = []
    image = screenshot_png()
    proxy = "/api/v1/execution/device-proxy/wheel-run/"
    session_id = "11111111-2222-4333-8444-555555555555"
    computer_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    computer_path = f"/api/v1/computer-runs/{computer_id}"
    stop = f"/api/v1/execution/device/sessions/{session_id}/stop"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.respond()

        def do_POST(self) -> None:
            self.respond()

        def log_message(self, format: str, *args: object) -> None:
            pass

        def respond(self) -> None:
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body: dict[str, object] = json.loads(raw) if raw else {}
            requests.append((self.command, self.path, body, dict(self.headers.items())))
            status = 200
            response: object
            if self.command == "POST" and self.path == "/api/v1/execution/start_device":
                response = {
                    "session_id": body.get("session_id", session_id),
                    "workflow_run_id": "wheel-run",
                }
            elif self.path in (computer_path + "/report", computer_path + "/stop"):
                response = {
                    "computer_session_id": computer_id,
                    "os": "macos",
                    "state": "stopped" if self.path.endswith("/stop") else "active",
                    "expires_at": "2999-01-01T00:00:00Z",
                    "release": "confirmed" if self.path.endswith("/stop") else "pending",
                }
            elif self.command == "GET" and self.path.startswith(
                "/api/v1/execution/device-sessions/"
            ):
                response = {"status": "running", "workflow_run_id": "wheel-run"}
            elif self.command == "POST" and self.path == proxy + "open_url":
                response = {"success": True, "action": "navigate"}
            elif self.command == "GET" and self.path.endswith("worker-connection/wheel-run"):
                response = {"status": "ready", "worker_ws_url": "wss://worker.test"}
            elif self.command == "GET" and self.path == proxy + "health":
                response = {"device_connected": True}
            elif self.command == "POST" and self.path == proxy + "launch":
                response = {"success": body == {"bundle_id": "com.apple.Preferences"}}
            elif self.command == "GET" and self.path == proxy + "screenshot":
                response = image
            elif self.command == "POST" and self.path == proxy + "execute_step":
                response = {
                    "success": True,
                    "step_output": {
                        "status": "success",
                        "status_reason": "Visible",
                        "validation_result": True,
                    },
                }
            elif self.command == "POST" and self.path.endswith("/stop"):
                response = {
                    "success": True,
                    "request_accepted": True,
                    "session_id": self.path.split("/")[-2],
                    "status": "stopping",
                }
            else:
                errors.append(f"Unexpected {self.command} {self.path}")
                response, status = {}, 599
            payload = response if isinstance(response, bytes) else json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with tempfile.TemporaryDirectory(prefix="verify-wheel-home-") as temporary:
        os.environ["HOME"] = temporary
        os.environ["REVYL_API_KEY"] = "wheel-test-key"
        os.environ["REVYL_APP_URL"] = "https://viewer.test"
        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            os.environ["REVYL_BACKEND_URL"] = f"http://127.0.0.1:{server.server_port}"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                import revyl_verify

                assert revyl_verify.__version__ == "0.1.0"
                assert callable(revyl_verify.attach) and callable(revyl_verify.async_attach)
                assert callable(revyl_verify.ComputerSession.open)
                assert callable(revyl_verify.Session.navigate)
                assert callable(revyl_verify.AsyncSession.open)
                assert callable(revyl_verify.AsyncSession.navigate)
                with revyl_verify.open(
                    revyl_verify.Target(
                        platform="ios",
                        bundle_id="com.apple.Preferences",
                    )
                ) as session:
                    assert session.id == session_id and session.platform == "ios"
                    assert session.instruction("Open General in Settings").passed
                    assert session.validation("General is visible").passed
                    destination = Path(temporary) / "screen.png"
                    assert session.screenshot(path=destination) == image == destination.read_bytes()
                    assert len(session.steps) == 2
                assert session.closed
                session.close()
                target = revyl_verify.Target(
                    "web",
                    app_id="0b6a8c3e-1111-4222-8333-944455556666",
                    build_id="9a9a9a9a-1111-4222-8333-944455556666",
                )
                with revyl_verify.attach(computer_id) as computer:
                    with computer.open(target) as browser:
                        browser.navigate("http://localhost:3000")
                        assert browser.report()["status"] == "running"

                async def check_async() -> None:
                    async with await revyl_verify.async_attach(computer_id) as computer:
                        async with await computer.open(target) as browser:
                            await browser.navigate("http://localhost:3000")
                            assert (await browser.report())["status"] == "running"

                asyncio.run(check_async())
            finally:
                server.shutdown()
                thread.join(timeout=3)
    assert not errors, errors
    starts = [body for method, path, body, _ in requests if path.endswith("/start_device")]
    assert starts[0] == {"platform": "ios", "idle_timeout_seconds": 600, "is_simulation": True}
    assert len(starts) == 3
    assert all(start["computer_session_id"] == computer_id for start in starts[1:])
    assert all(start["session_id"] != computer_id for start in starts[1:])
    launches = [body for method, path, body, _ in requests if path == proxy + "launch"]
    assert launches == [{"bundle_id": "com.apple.Preferences"}]
    steps = [body for method, path, body, _ in requests if path == proxy + "execute_step"]
    assert steps == [
        {
            "step_type": "instruction",
            "step_description": "Open General in Settings",
            "workflow_run_id": "wheel-run",
            "session_id": session_id,
        },
        {
            "step_type": "validation",
            "step_description": "General is visible",
            "workflow_run_id": "wheel-run",
            "session_id": session_id,
        },
    ]
    assert len([path for method, path, _, _ in requests if method == "POST" and path == stop]) == 1
    for _, path, _, headers in requests:
        assert headers["Authorization"] == "Bearer wheel-test-key"
        assert headers["X-Revyl-Client"] == "verify"
        assert "revyl-verify/" in headers["User-Agent"]
        if path.startswith(proxy):
            assert headers["X-Revyl-Agent"] == "Verify"
    print("Installed revyl_verify mobile and hosted sync/async loopback smoke passed.")


if __name__ == "__main__":
    main()
