from __future__ import annotations

import atexit
import signal
import threading
import time
from types import FrameType
from typing import Protocol


class Closeable(Protocol):
    def close(self) -> None: ...


CLOSE_ALL_TIMEOUT = 15
_sessions: dict[Closeable, tuple[threading.Event, threading.Thread, float]] = {}
_lock = threading.RLock()
shutting_down = False


def install_signal_cleanup() -> None:
    if threading.current_thread() is threading.main_thread():
        if signal.getsignal(signal.SIGTERM) == signal.SIG_DFL:
            signal.signal(signal.SIGTERM, _terminate)


def _terminate(signum: int, frame: FrameType | None) -> None:
    raise SystemExit(128 + signum)


def track(session: Closeable, close_budget: float = CLOSE_ALL_TIMEOUT) -> None:
    with _lock:
        if session in _sessions:
            return
        event = threading.Event()
        worker = threading.Thread(target=_wait_and_close, args=(session, event), daemon=True)
        _sessions[session] = (event, worker, close_budget)
        worker.start()


def untrack(session: Closeable) -> None:
    with _lock:
        tracked = _sessions.pop(session, None)
    if tracked:
        tracked[0].set()


def _wait_and_close(session: Closeable, event: threading.Event) -> None:
    event.wait()
    with _lock:
        pending = session in _sessions
    if pending:
        _close(session)


def _close(session: Closeable) -> None:
    try:
        session.close()
    except Exception:
        pass


def cleanup() -> None:
    global shutting_down
    shutting_down = True
    with _lock:
        workers = list(_sessions.values())
    deadline = time.monotonic() + max([CLOSE_ALL_TIMEOUT, *(budget for _, _, budget in workers)])
    for event, _, _ in workers:
        event.set()
    for _, worker, _ in workers:
        if worker.ident is not None:
            worker.join(max(0, deadline - time.monotonic()))


atexit.register(cleanup)
