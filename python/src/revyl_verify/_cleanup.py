from __future__ import annotations

import atexit
import threading
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._session import Session

_sessions: dict[Session, tuple[threading.Event, threading.Thread]] = {}
_lock = threading.Lock()
shutting_down = False


def track(session: Session) -> None:
    event = threading.Event()
    worker = threading.Thread(target=_wait_and_close, args=(session, event), daemon=True)
    with _lock:
        _sessions[session] = (event, worker)
        worker.start()


def untrack(session: Session) -> None:
    with _lock:
        tracked = _sessions.pop(session, None)
    if tracked:
        tracked[0].set()


def _wait_and_close(session: Session, event: threading.Event) -> None:
    event.wait()
    with _lock:
        pending = session in _sessions
    if pending:
        _close(session)


def _close(session: Session) -> None:
    try:
        session.close()
    except Exception:
        pass


def cleanup() -> None:
    global shutting_down
    shutting_down = True
    with _lock:
        workers = list(_sessions.values())
    deadline = time.monotonic() + 15
    for event, _ in workers:
        event.set()
    for _, worker in workers:
        worker.join(max(0, deadline - time.monotonic()))


atexit.register(cleanup)
