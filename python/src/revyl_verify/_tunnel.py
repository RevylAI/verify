from __future__ import annotations

import errno
import hashlib
import http.client
import io
import os
import platform
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future
from concurrent.futures import wait as wait_for
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from ._transport import VerifyError

QUICK_TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)
MIN_CLOUDFLARED_VERSION = "2026.10.2"
PINNED_CLOUDFLARED_VERSION = "2026.10.7"


@dataclass(frozen=True)
class _Pinned:
    asset: str
    asset_sha256: str
    binary_sha256: str


PINNED_CLOUDFLARED = {
    "linux-x64": _Pinned(
        asset="cloudflared-linux-amd64",
        asset_sha256="1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872",
        binary_sha256="1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872",
    ),
    "linux-arm64": _Pinned(
        asset="cloudflared-linux-arm64",
        asset_sha256="3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775",
        binary_sha256="3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775",
    ),
    "darwin-arm64": _Pinned(
        asset="cloudflared-darwin-arm64.tgz",
        asset_sha256="3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd",
        binary_sha256="2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12",
    ),
    "darwin-x64": _Pinned(
        asset="cloudflared-darwin-amd64.tgz",
        asset_sha256="02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848",
        binary_sha256="5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86",
    ),
}
DOWNLOAD_TIMEOUT = 120
DOWNLOAD_MAX_BYTES = 150 * 1024 * 1024
TUNNEL_START_TIMEOUT = 60
TUNNEL_STOP_GRACE = 5
PROBE_TIMEOUT = 5
LOG_TAIL_LINES = 20
RATE_LIMIT_BACKOFF = (5, 15)

_cloudflared_lock = threading.Lock()
_cloudflared: Future[str] | None = None
_edge_lock = threading.Lock()
_edge_resolved = False
_edge_address: str | None = None


class Abort:
    """Stops setup steps running on any thread with the reason given first."""

    def __init__(self) -> None:
        self.event = threading.Event()
        self.reason: BaseException = VerifyError(
            "ENVIRONMENT_START_FAILED", "Environment setup was aborted."
        )
        self._lock = threading.Lock()

    def abort(self, reason: BaseException) -> None:
        with self._lock:
            if self.event.is_set():
                return
            self.reason = reason
            self.event.set()

    def check(self) -> None:
        if self.event.is_set():
            raise self.reason

    def sleep(self, seconds: float) -> None:
        if self.event.wait(seconds):
            raise self.reason


class QuickTunnel:
    """A Cloudflare quick tunnel for one local port, served by cloudflared in its own group."""

    def __init__(self, binary: str, port: int) -> None:
        self.port = port
        self.url = ""
        self._registered = False
        self._tail: deque[str] = deque(maxlen=LOG_TAIL_LINES)
        self._config_dir = tempfile.mkdtemp(prefix="verify-tunnel-")
        config_file = os.path.join(self._config_dir, "config.yml")
        Path(config_file).write_text("no-autoupdate: true\n")
        try:
            self._process = subprocess.Popen(
                [
                    binary,
                    "tunnel",
                    "--no-autoupdate",
                    "--config",
                    config_file,
                    "--metrics",
                    "127.0.0.1:0",
                    "--grace-period",
                    "1s",
                    "--url",
                    f"http://localhost:{port}",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as error:
            shutil.rmtree(self._config_dir, ignore_errors=True)
            raise VerifyError("TUNNEL_FAILED", f"Could not run cloudflared: {error}") from error
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        stream = self._process.stderr
        assert stream is not None
        try:
            for raw in stream:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if not self.url:
                    match = QUICK_TUNNEL_URL.search(line)
                    if match:
                        self.url = match.group(0)
                if "Registered tunnel connection" in line:
                    self._registered = True
                if " INF " in line:
                    continue
                self._tail.append(QUICK_TUNNEL_URL.sub("<tunnel url>", line))
        finally:
            stream.close()
            shutil.rmtree(self._config_dir, ignore_errors=True)

    @property
    def running(self) -> bool:
        return self._process.poll() is None

    def probe(self, path: str) -> int | str:
        return probe_quick_tunnel(self.url, path)

    def diagnostics(self) -> str:
        return "\n".join(self._tail) or "(nothing beyond informational lines)"

    def rate_limited(self) -> bool:
        return any(re.search(r"\b429\b", line) for line in self._tail)

    def close(self) -> None:
        stop_process_group(self._process, TUNNEL_STOP_GRACE, "cloudflared")

    def wait_started(self, deadline: float, abort: Abort) -> None:
        while not (self.url and self._registered):
            abort.check()
            code = self._process.poll()
            if code is not None:
                self._reader.join(1)
                raise VerifyError(
                    "TUNNEL_FAILED",
                    f"cloudflared exited ({describe_exit(code)}) before the quick tunnel for port "
                    f"{self.port} was up. Its last output:\n{self.diagnostics()}",
                )
            if time.monotonic() > deadline:
                raise VerifyError(
                    "TUNNEL_FAILED",
                    f"The quick tunnel for port {self.port} was not up after "
                    f"{TUNNEL_START_TIMEOUT} s. cloudflared's last output:\n{self.diagnostics()}",
                )
            abort.sleep(0.25)


def start_quick_tunnel(
    port: int,
    abort: Abort,
    log: Callable[[str], None],
    register: Callable[[QuickTunnel], None],
) -> QuickTunnel:
    """Starts a quick tunnel for a local port, retrying Cloudflare rate limiting within 60 s.

    `register` receives each spawned tunnel before it is up, so teardown can stop it.
    """
    binary = resolve_cloudflared(log, abort)
    deadline = time.monotonic() + TUNNEL_START_TIMEOUT
    for attempt in range(len(RATE_LIMIT_BACKOFF) + 1):
        abort.check()
        tunnel = QuickTunnel(binary, port)
        register(tunnel)
        try:
            tunnel.wait_started(deadline, abort)
            return tunnel
        except BaseException as error:
            try:
                tunnel.close()
            except Exception:
                pass
            if abort.event.is_set() or not tunnel.rate_limited():
                raise
            if (
                attempt == len(RATE_LIMIT_BACKOFF)
                or time.monotonic() + RATE_LIMIT_BACKOFF[attempt] > deadline
            ):
                raise VerifyError(
                    "TUNNEL_FAILED",
                    f"Cloudflare refused to create a quick tunnel for port {port} (HTTP 429). "
                    "Quick tunnels are rate-limited per network address, so wait a few minutes "
                    "before trying again.",
                ) from error
            log(
                f"Cloudflare rate-limited the quick tunnel for port {port}; "
                f"trying again in {RATE_LIMIT_BACKOFF[attempt]} s."
            )
            abort.sleep(RATE_LIMIT_BACKOFF[attempt])
    raise AssertionError("unreachable")


class _EdgeConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, address: str) -> None:
        self._address = address
        self._tls = ssl.create_default_context()
        super().__init__(host, 443, timeout=PROBE_TIMEOUT, context=self._tls)

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        try:
            self.sock = self._tls.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def probe_quick_tunnel(url: str, path: str) -> int | str:
    """Returns the HTTP status a quick tunnel URL answers with right now, or a network error code.

    A new quick-tunnel hostname takes a few seconds to appear in DNS, and a lookup made before
    then is cached as missing for up to a minute. So the probe reaches Cloudflare's edge by the
    address of trycloudflare.com and names the tunnel host in TLS and the Host header, and the
    tunnel host is never looked up early. The certificate is still checked against the tunnel host.
    """
    global _edge_resolved, _edge_address
    host = urlsplit(url).hostname or ""
    with _edge_lock:
        if not _edge_resolved:
            try:
                _edge_address = str(
                    socket.getaddrinfo("trycloudflare.com", 443, type=socket.SOCK_STREAM)[0][4][0]
                )
            except OSError:
                _edge_address = None
            _edge_resolved = True
        address = _edge_address
    connection = _EdgeConnection(host, address or host)
    try:
        connection.request("GET", path)
        return connection.getresponse().status
    except (OSError, http.client.HTTPException) as error:
        return network_error(error)
    finally:
        connection.close()


def network_error(error: BaseException) -> str:
    if isinstance(error, TimeoutError):
        return "TIMEOUT"
    if isinstance(error, ssl.SSLError):
        return error.reason or "SSL_ERROR"
    if isinstance(error, socket.gaierror):
        return "ENOTFOUND"
    if isinstance(error, OSError) and error.errno is not None and error.errno in errno.errorcode:
        return errno.errorcode[error.errno]
    return type(error).__name__


def describe_exit(code: int) -> str:
    if code >= 0:
        return str(code)
    try:
        return signal.Signals(-code).name
    except ValueError:
        return f"signal {-code}"


def stop_process_group(process: subprocess.Popen[bytes], grace: float, label: str) -> None:
    """Signals a child's process group, then waits for every process in it to exit."""
    pgid = process.pid
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 2.0)):
        if not _group_alive(process):
            return
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            return
        until = time.monotonic() + wait
        while time.monotonic() < until and _group_alive(process):
            time.sleep(0.1)
    if _group_alive(process):
        raise RuntimeError(f"{label} (process group {pgid}) was still running after SIGKILL")


def _group_alive(process: subprocess.Popen[bytes]) -> bool:
    process.poll()
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def resolve_cloudflared(log: Callable[[str], None], abort: Abort) -> str:
    """Finds or downloads cloudflared once per process; waiting for it stops when setup aborts."""
    global _cloudflared
    with _cloudflared_lock:
        if _cloudflared is None:
            _cloudflared = Future()
            threading.Thread(
                target=_resolve_into, args=(_cloudflared, log), daemon=True
            ).start()
        future = _cloudflared
    while not wait_for([future], timeout=0.25).done:
        abort.check()
    return future.result()


def _resolve_into(future: Future[str], log: Callable[[str], None]) -> None:
    global _cloudflared
    try:
        future.set_result(_find_cloudflared(log))
    except BaseException as error:
        with _cloudflared_lock:
            _cloudflared = None
        future.set_exception(error)


def _find_cloudflared(log: Callable[[str], None]) -> str:
    installed = _cloudflared_version("cloudflared")
    if installed and _compare_versions(installed, MIN_CLOUDFLARED_VERSION) >= 0:
        return "cloudflared"
    if installed:
        log(
            f"Ignoring cloudflared {installed} on PATH: releases before {MIN_CLOUDFLARED_VERSION} "
            f"trust revoked certificates. Using the pinned {PINNED_CLOUDFLARED_VERSION} instead."
        )
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        machine, machine
    )
    key = f"{sys.platform}-{arch}"
    pinned = PINNED_CLOUDFLARED.get(key)
    if pinned is None:
        raise VerifyError(
            "TUNNEL_UNAVAILABLE",
            f"cloudflared is not on PATH, and Verify has no pinned cloudflared for {key}. "
            f"Install cloudflared {MIN_CLOUDFLARED_VERSION} or later.",
        )
    errors: list[str] = []
    for base in (
        os.environ.get("XDG_CACHE_HOME") or os.path.join(Path.home(), ".cache"),
        tempfile.gettempdir(),
    ):
        directory = os.path.join(base, "revyl-verify", "cloudflared", PINNED_CLOUDFLARED_VERSION)
        binary = os.path.join(directory, "cloudflared")
        try:
            if _file_has_sha256(binary, pinned.binary_sha256):
                return binary
            os.makedirs(directory, exist_ok=True)
            log(
                f"cloudflared is not on PATH. Downloading cloudflared {PINNED_CLOUDFLARED_VERSION} "
                f"into {directory}."
            )
            _download_cloudflared(pinned, directory, binary)
            return binary
        except Exception as error:
            errors.append(f"{directory}: {error}")
    raise VerifyError(
        "TUNNEL_UNAVAILABLE",
        f"cloudflared is not on PATH, and downloading the pinned cloudflared "
        f"{PINNED_CLOUDFLARED_VERSION} failed ({'; '.join(errors)}). Install cloudflared "
        f"{MIN_CLOUDFLARED_VERSION} or later on the runner.",
    )


def _download_cloudflared(pinned: _Pinned, directory: str, binary: str) -> None:
    url = (
        "https://github.com/cloudflare/cloudflared/releases/download/"
        f"{PINNED_CLOUDFLARED_VERSION}/{pinned.asset}"
    )
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            if int(response.headers.get("content-length") or 0) > DOWNLOAD_MAX_BYTES:
                raise RuntimeError("the download is larger than expected")
            buffer = io.BytesIO()
            while chunk := response.read(1 << 20):
                if buffer.tell() + len(chunk) > DOWNLOAD_MAX_BYTES:
                    raise RuntimeError("the download is larger than expected")
                if time.monotonic() > deadline:
                    raise RuntimeError(f"the download took longer than {DOWNLOAD_TIMEOUT} s")
                buffer.write(chunk)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"GitHub returned HTTP {error.code}") from None
    asset = buffer.getvalue()
    if hashlib.sha256(asset).hexdigest() != pinned.asset_sha256:
        raise RuntimeError(f"{pinned.asset} did not match its pinned sha256")
    staging = tempfile.mkdtemp(prefix=".download-", dir=directory)
    try:
        staged_binary = os.path.join(staging, "cloudflared")
        if pinned.asset.endswith(".tgz"):
            with tarfile.open(fileobj=io.BytesIO(asset), mode="r:gz") as archive:
                member = archive.extractfile("cloudflared")
                if member is None:
                    raise RuntimeError(f"{pinned.asset} has no cloudflared binary")
                Path(staged_binary).write_bytes(member.read())
        else:
            Path(staged_binary).write_bytes(asset)
        if not _file_has_sha256(staged_binary, pinned.binary_sha256):
            raise RuntimeError("the extracted cloudflared did not match its pinned sha256")
        os.chmod(staged_binary, 0o755)
        os.replace(staged_binary, binary)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _file_has_sha256(path: str, expected: str) -> bool:
    if not os.path.isfile(path):
        return False
    return hashlib.sha256(Path(path).read_bytes()).hexdigest() == expected


def _cloudflared_version(binary: str) -> str | None:
    try:
        result = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, timeout=10, check=True
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(r"version (\d+\.\d+\.\d+)", result.stdout)
    return match.group(1) if match else None


def _compare_versions(a: str, b: str) -> int:
    left = [int(part) for part in a.split(".")]
    right = [int(part) for part in b.split(".")]
    for index in range(3):
        difference = (left[index] if index < len(left) else 0) - (
            right[index] if index < len(right) else 0
        )
        if difference != 0:
            return difference
    return 0
