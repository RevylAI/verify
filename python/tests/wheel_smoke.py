from __future__ import annotations

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
                response = {"session_id": session_id, "workflow_run_id": "wheel-run"}
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
            elif self.command == "POST" and self.path == stop:
                response = {
                    "success": True,
                    "request_accepted": True,
                    "session_id": session_id,
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
            finally:
                server.shutdown()
                thread.join(timeout=3)
    assert not errors, errors
    starts = [body for method, path, body, _ in requests if path.endswith("/start_device")]
    assert starts == [{"platform": "ios", "idle_timeout_seconds": 600, "is_simulation": True}]
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
    print("Installed revyl_verify mobile loopback smoke passed.")


if __name__ == "__main__":
    main()
