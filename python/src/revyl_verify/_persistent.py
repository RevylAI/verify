"""Persistent Mac computers, exported from revyl_verify: open_persistent() and friends."""

from __future__ import annotations

import re
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from urllib.parse import quote

from ._cleanup import install_signal_cleanup, track
from ._computer import ComputerSession
from ._transport import (
    Client,
    Deadline,
    Json,
    Response,
    VerifyError,
    edge_blocked_error,
    mac_upgrade_message,
    obj,
    origin,
    timestamp,
)

_BASE = "/api/v1/computer-runs"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_NAME_RULE = (
    "1-64 letters, digits, '.', '_' or '-', starting with a letter or digit, and not a UUID"
)
_NAMESPACE = uuid.UUID("c4c351c9-f19a-49b9-b0a9-632ef6c3f486")
_MAX_GENERATIONS = 100
_REFUSED_START_CODES: frozenset[str] = frozenset(
    {
        "AUTH_REJECTED",
        "EDGE_BLOCKED",
        "NOT_AVAILABLE_ON_PLATFORM",
        "INVALID_ARGUMENT",
        "COMPUTER_LIMIT",
        "NOT_FOUND",
    }
)
_SAVE_WAIT_SECONDS = 600.0
_STATES = ("starting", "running", "stopping", "stopped")

PersistentComputerState = Literal["starting", "running", "stopping", "stopped"]
Log = Callable[[str], None] | Literal[False] | None


@dataclass(frozen=True)
class PersistentComputer:
    id: str
    """The computer's ID. It stays the same across every stop and start, and works wherever a name
    does."""
    state: PersistentComputerState
    saved_at: datetime | None
    """When its disk was last saved; None until its first stop finishes saving."""
    saved_off_host: bool
    """Whether that save has been copied off the Mac that made it. save_snapshot() needs this and
    waits for it."""
    created_at: datetime


@dataclass(frozen=True)
class ComputerSnapshot:
    id: str
    name: str
    computer_id: str
    """The persistent computer whose disk it saved."""
    saved_at: datetime
    expires_at: datetime | None
    """When the save stops being usable, if it has an end."""


class PersistentComputerSession(ComputerSession):
    """A running persistent Mac. It has every method of the computer open(Target("mac")) returns,
    such as exec(), read_file(), write_file(), screenshot() and extend(); relative file paths
    are inside the computer's workspace folder, as on open(Target("mac")). close(), and leaving
    a ``with`` block, stop it and keep its disk. ``id`` is the persistent computer's ID: it
    stays the same across stops and starts and matches the id list_persistent() reports.
    """

    name: str
    """The name (or ID) you passed to open_persistent()."""
    created: bool
    """True when this open_persistent() call created the computer; False when it already existed."""
    _save_lock: threading.RLock
    _save_settled: bool = False
    _save_error: VerifyError | None = None

    def __enter__(self) -> PersistentComputerSession:
        return self

    def close(self) -> None:
        """Stops the computer and keeps its disk: files, installed tools and settings are there
        the next time you open_persistent() it. Memory and running processes are not kept.
        Returns once the disk is saved on its Mac, which can take a few minutes. Verify also
        stops it this way if your script exits without calling close(). A snapshot of this
        disk can be saved about 5-6 minutes after close() returns; save_snapshot() waits for
        that.
        """
        with self._save_lock:
            if self._save_settled:
                if self._save_error is not None:
                    raise self._save_error
                return
            try:
                super().close()
                self._await_saved()
            except VerifyError as error:
                self._save_error = error
                self._save_settled = True
                raise
            self._save_settled = True

    def _await_saved(self) -> None:
        deadline = Deadline(_SAVE_WAIT_SECONDS)
        try:
            while True:
                status = _read_status(self._client, self.id, deadline)
                if status is not None and status.state == "stopped":
                    self._log("stopped; disk saved")
                    return
                if status is not None and status.state != "stopping":
                    self._log(f"stopped; it was started again elsewhere ({status.state})")
                    return
                deadline.pause(3)
        except VerifyError as error:
            if error.code != "TIMEOUT" or not deadline.expired():
                raise
            raise VerifyError(
                "TIMEOUT",
                f"{self.name} is stopped, but saving its disk was not confirmed within "
                f"{_SAVE_WAIT_SECONDS:.0f} seconds. The save continues on its own; "
                f"list_persistent() shows it as stopped once done. See {self.viewer_url}",
            ) from error

    def _log(self, message: str) -> None:
        if self._log_callback:
            try:
                self._log_callback(f"{getattr(self, 'name', self.platform)}: {message}")
            except Exception:
                pass


def open_persistent(
    name: str,
    *,
    from_snapshot: str | None = None,
    timeout: int | None = None,
    start_timeout: float = 900,
    backend_url: str | None = None,
    app_url: str | None = None,
    log: Log = None,
) -> PersistentComputerSession:
    """Opens the persistent Mac with this name, creating it if it doesn't exist, starting it if it
    is stopped, and waiting until it is ready. Its disk outlives every stop: close() keeps it, and
    the next open_persistent() with the same name boots from it. Names are 1-64 letters, digits,
    '.', '_' or '-', starting with a letter or digit; the same name opens the same computer from
    Python, TypeScript and Go. Pass an ID from list_persistent() to open an existing computer
    without creating one. If it is already running, open_persistent() connects to it.

    from_snapshot: used only when this call creates the computer: its disk starts as this
    snapshot's (a name or ID from list_snapshots()). If the computer already exists it opens as it
    is; check ``created``.

    timeout: how long this run may last before the computer stops itself (keeping its disk), in
    whole seconds from 60 to 86400. Defaults to 2 hours. Not applied when the computer was already
    running. Same as Target("mac", timeout=...).

    start_timeout: seconds to wait until it is ready, 10-1800, default 900. Covers waiting for an
    earlier stop to finish saving, and a start from a snapshot, which takes up to about 3 minutes.

    Credentials and backend_url/app_url work as for open(). Persistent computers are turned on per
    organization: without them, open_persistent() and save_snapshot() raise VerifyError
    NOT_AVAILABLE_ON_PLATFORM with reason "persistent_computers_not_enabled".

    Every persistent-computer call raises VerifyError, with .code saying what happened and the
    message saying what to do: NOT_FOUND (no computer or snapshot by that name or ID), SESSION_BUSY
    (the computer is running, or its last stop hasn't finished), TIMEOUT (a wait ran out; the call
    can be repeated), COMPUTER_LIMIT (the organization keeps its maximum number of computers or
    snapshots, or can't start another computer now), NOT_AVAILABLE_ON_PLATFORM, INVALID_ARGUMENT,
    AUTH_REJECTED, SESSION_START_FAILED and API_ERROR.

    Example::

        mac = open_persistent("build-cache")
        if mac.created:
            mac.exec(["brew", "install", "jq"])
        mac.close()  # stops it and keeps the disk
    """
    _check_computer(name, "open_persistent()")
    if from_snapshot is not None:
        _check_snapshot(from_snapshot, "from_snapshot")
    if timeout is not None and (
        isinstance(timeout, bool) or not isinstance(timeout, int) or not 60 <= timeout <= 86400
    ):
        raise VerifyError("INVALID_ARGUMENT", "timeout must be whole seconds from 60 to 86400.")
    if (
        isinstance(start_timeout, bool)
        or not isinstance(start_timeout, (int, float))
        or not 10 <= start_timeout <= 1800
    ):
        raise VerifyError("INVALID_ARGUMENT", "start_timeout must be from 10 to 1800 seconds.")
    client, progress, viewer = _connect(backend_url, app_url, log)
    deadline = Deadline(start_timeout)
    computer_id, status = _find(client, name, deadline)
    session = PersistentComputerSession(
        client,
        computer_id,
        "",
        "mac",
        f"{viewer}/sessions/{quote(computer_id, safe='')}?kind=computer",
        180,
    )
    session.name = name
    session.created = status is None
    session._save_lock = threading.RLock()
    session._log_callback = progress
    lifetime: dict[str, Json] | None = None if timeout is None else {"timeout_seconds": timeout}
    started = False
    attempted = False
    try:
        if status is None:
            session._log(
                "creating persistent computer"
                + (f" from snapshot {from_snapshot}" if from_snapshot else "")
                + f" {session.viewer_url}"
            )
            body: dict[str, Json] = {
                "computer_session_id": computer_id,
                "os": "macos",
                "persistent": True,
            }
            if lifetime:
                body.update(lifetime)
            if from_snapshot:
                body["from_snapshot"] = from_snapshot
            attempted = True
            response = _call(
                client,
                "POST",
                _BASE,
                deadline,
                body,
                retry=True,
                not_found=f"There is no snapshot named or with the ID {from_snapshot}. "
                "list_snapshots() shows "
                "your organization's snapshots.",
            )
            started = True
        else:
            if from_snapshot:
                session._log(f"already exists, so from_snapshot {from_snapshot} was not used")
            waiting = False
            while status.state in ("stopping", "stopped"):
                if status.state == "stopped":
                    attempted = True
                    started_response = _call(
                        client,
                        "POST",
                        f"{_BASE}/{computer_id}/start",
                        deadline,
                        lifetime,
                        retry=True,
                        accept=("run_conflict",),
                    )
                    if started_response.status < 300:
                        started = True
                        session._log(f"starting from its saved disk {session.viewer_url}")
                        break
                if not waiting:
                    session._log("waiting for its last stop to finish saving its disk")
                waiting = True
                deadline.pause(5)
                status = _read_status(client, computer_id, deadline) or status
            if status.state in ("running", "starting"):
                session._log(f"already {status.state}; connecting {session.viewer_url}")
            response = _call(client, "GET", f"{_BASE}/{computer_id}/report", deadline)
        started = True
        track(session)
        report = session._report(response)
        while report["state"] != "active":
            if report["state"] != "starting":
                raise VerifyError(
                    "SESSION_START_FAILED",
                    f"{name} ended before it was ready ({report['state']}). Call "
                    f"open_persistent('{name}') again; "
                    f"its disk is kept. See {session.viewer_url}",
                )
            deadline.pause(2)
            report = session._report(
                _call(client, "GET", f"{_BASE}/{computer_id}/report", deadline)
            )
        session._screen_ready_until = time.monotonic() + 30
        session._log("ready")
        return session
    except VerifyError as error:
        stopped = started or (attempted and error.code not in _REFUSED_START_CODES)
        if stopped:
            try:
                ComputerSession.close(session)
            except BaseException:
                pass
        if error.code == "TIMEOUT" and deadline.expired():
            raise VerifyError(
                "TIMEOUT",
                f"{name} was not ready within {start_timeout} seconds."
                + (" It was stopped again and keeps its disk." if stopped else "")
                + f" Call open_persistent('{name}') again, or pass a larger start_timeout. See "
                f"{session.viewer_url}",
            ) from error
        raise


def save_snapshot(
    computer: str,
    snapshot: str,
    *,
    wait_timeout: float = 900,
    backend_url: str | None = None,
    app_url: str | None = None,
    log: Log = None,
) -> ComputerSnapshot:
    """Saves a stopped persistent computer's disk (by name or ID) as a named snapshot, which
    open_persistent(other_name, from_snapshot=...) can start a new computer from. The computer
    must be stopped: close() its session first, or save_snapshot() raises SESSION_BUSY. A disk
    is ready to snapshot about 5-6 minutes after close() returns, once it is copied off its Mac;
    save_snapshot() waits for that (and for a stop still in progress) up to wait_timeout seconds
    (1-3600, default 900), then raises TIMEOUT. Snapshot names follow the computer-name rule and
    are unique in your organization: a name already used for a different save raises
    INVALID_ARGUMENT, while calling it again for the same computer and save returns the snapshot
    it already saved. A snapshot lasts until you delete it.

    Example::

        mac.close()
        snapshot = save_snapshot("build-cache", "build-cache-base")
    """
    _check_computer(computer, "save_snapshot()")
    if not isinstance(snapshot, str) or not _NAME.fullmatch(snapshot) or _UUID.fullmatch(snapshot):
        raise VerifyError(
            "INVALID_ARGUMENT", f"save_snapshot() takes a snapshot name of {_NAME_RULE}."
        )
    if (
        isinstance(wait_timeout, bool)
        or not isinstance(wait_timeout, (int, float))
        or not 1 <= wait_timeout <= 3600
    ):
        raise VerifyError("INVALID_ARGUMENT", "wait_timeout must be from 1 to 3600 seconds.")
    client, progress, _ = _connect(backend_url, app_url, log)
    deadline = Deadline(wait_timeout)

    def say(line: str) -> None:
        if progress:
            progress(f"{computer}: {line}")

    try:
        computer_id, status = _find(client, computer, deadline)
        if status is None:
            raise _computer_not_found(computer)
        waiting = False
        while True:
            response = _call(
                client,
                "POST",
                f"{_BASE}/{computer_id}/snapshots",
                deadline,
                {"name": snapshot},
                retry=True,
                not_found=_computer_not_found(computer).message,
                accept=("computer_not_stopped", "saved_disk_not_durable", "snapshot_name_taken"),
            )
            if response.status < 300:
                say(f"saved snapshot {snapshot}")
                return _to_snapshot(response.json())
            detail = _detail(response)
            status = _read_status(client, computer_id, deadline)
            if detail == "snapshot_name_taken":
                existing = _call(
                    client,
                    "GET",
                    f"{_BASE}/snapshots/{quote(snapshot, safe='')}",
                    deadline,
                    accept=("inaccessible",),
                )
                saved = _to_snapshot(existing.json()) if existing.status == 200 else None
                if (
                    saved
                    and status
                    and saved.computer_id == computer_id
                    and saved.saved_at == status.saved_at
                ):
                    return saved
                raise VerifyError(
                    "INVALID_ARGUMENT",
                    f"Your organization already has a snapshot named {snapshot} "
                    "(snapshot_name_taken). Pick another "
                    f"name, or delete the old one with delete_snapshot('{snapshot}') first.",
                    http_status=response.status,
                )
            if (
                detail == "computer_not_stopped"
                and status is not None
                and status.state in ("running", "starting")
            ):
                raise VerifyError(
                    "SESSION_BUSY",
                    f"{computer} is running. A snapshot saves a stopped computer's disk: close() "
                    "its session first "
                    "(that keeps the disk), then call save_snapshot() again.",
                    http_status=response.status,
                )
            if not waiting:
                say(
                    "waiting for its saved disk to be copied off its Mac (usually about 5 minutes)"
                    if detail == "saved_disk_not_durable"
                    else "waiting for it to finish stopping"
                )
            waiting = True
            deadline.pause(15)
    except VerifyError as error:
        if error.code == "TIMEOUT" and deadline.expired():
            raise VerifyError(
                "TIMEOUT",
                f"{computer}'s disk was not ready to snapshot within {wait_timeout} seconds, so "
                "nothing was saved. Call save_snapshot() again to keep waiting, or pass a larger "
                "wait_timeout.",
            ) from error
        raise


def list_persistent(
    *, backend_url: str | None = None, app_url: str | None = None
) -> list[PersistentComputer]:
    """Lists your organization's persistent computers, stopped ones included, other people's too.
    Revyl stores no names, so each one is shown by its ID; compare with the id of a session
    open_persistent() returned. A name always maps to the same ID, so a name keeps working after
    stops and from any machine or language.
    """
    client, _, _ = _connect(backend_url, app_url, False)
    return [_to_computer(item) for item in _pages(client, "persistent", Deadline(60))]


def list_snapshots(
    *, backend_url: str | None = None, app_url: str | None = None
) -> list[ComputerSnapshot]:
    """Lists your organization's snapshots."""
    client, _, _ = _connect(backend_url, app_url, False)
    return [_to_snapshot(item) for item in _pages(client, "snapshots", Deadline(60))]


def delete_persistent(
    computer: str, *, backend_url: str | None = None, app_url: str | None = None, log: Log = None
) -> None:
    """Deletes a persistent computer (by name or ID) and its saved disk for good. A running
    computer stops first, without saving. Snapshots of it are kept until you delete_snapshot()
    them. Raises NOT_FOUND when there is no such computer, including one already deleted.
    """
    _check_computer(computer, "delete_persistent()")
    client, progress, _ = _connect(backend_url, app_url, log)
    deadline = Deadline(60)
    computer_id, status = _find(client, computer, deadline)
    if status is None:
        raise _computer_not_found(computer)
    _call(
        client,
        "DELETE",
        f"{_BASE}/{computer_id}",
        deadline,
        retry=True,
        not_found=_computer_not_found(computer).message,
    )
    if progress:
        progress(f"{computer}: deleted")


def delete_snapshot(
    snapshot: str, *, backend_url: str | None = None, app_url: str | None = None, log: Log = None
) -> None:
    """Deletes a snapshot by name or ID. Computers already started from it keep their disks. Raises
    NOT_FOUND when there is no such snapshot.
    """
    _check_snapshot(snapshot, "delete_snapshot()")
    client, progress, _ = _connect(backend_url, app_url, log)
    _call(
        client,
        "DELETE",
        f"{_BASE}/snapshots/{quote(snapshot, safe='')}",
        Deadline(60),
        retry=True,
        not_found=f"There is no snapshot named or with the ID {snapshot}. "
        "list_snapshots() shows your "
        "organization's snapshots.",
    )
    if progress:
        progress(f"snapshot {snapshot}: deleted")


def _connect(
    backend_url: str | None, app_url: str | None, log: Log
) -> tuple[Client, Callable[[str], None] | None, str]:
    from . import _progress

    progress = _progress(log)
    install_signal_cleanup()
    viewer = origin(app_url or "https://app.revyl.ai", app=True).rstrip("/")
    return Client(backend_url, app_url), progress, viewer


def _find(
    client: Client, reference: str, deadline: Deadline
) -> tuple[str, PersistentComputer | None]:
    live = [_to_computer(item) for item in _pages(client, "persistent", deadline)]
    if _UUID.fullmatch(reference):
        for computer in live:
            if computer.id == reference.lower():
                return computer.id, computer
        raise _computer_not_found(reference)
    org_id = client.json(
        "GET", "/api/v1/entity/users/get_user_uuid", deadline=deadline, retry=True
    ).get("org_id")
    if not isinstance(org_id, str) or not _UUID.fullmatch(org_id):
        raise VerifyError(
            "API_ERROR", "Revyl did not say which organization this API key belongs to."
        )
    for generation in range(_MAX_GENERATIONS):
        computer_id = str(uuid.uuid5(_NAMESPACE, f"{org_id.lower()}/{reference}/{generation}"))
        for computer in live:
            if computer.id == computer_id:
                return computer_id, computer
        response = _call(
            client, "GET", f"{_BASE}/{computer_id}", deadline, accept=("inaccessible",)
        )
        if response.status == 404:
            return computer_id, None
        persistent = obj(response.json()).get("persistent")
        if persistent is not None:
            return computer_id, _to_computer(persistent)
    raise VerifyError(
        "API_ERROR",
        f"{reference} has been deleted and re-created {_MAX_GENERATIONS} times; use a new name.",
    )


def _read_status(client: Client, computer_id: str, deadline: Deadline) -> PersistentComputer | None:
    persistent = obj(_call(client, "GET", f"{_BASE}/{computer_id}", deadline).json()).get(
        "persistent"
    )
    return None if persistent is None else _to_computer(persistent)


def _pages(
    client: Client, kind: Literal["persistent", "snapshots"], deadline: Deadline
) -> list[Json]:
    items: list[Json] = []
    for _ in range(10):
        body = obj(
            _call(client, "GET", f"{_BASE}/{kind}?limit=100&offset={len(items)}", deadline).json()
        )
        batch = body.get("computers" if kind == "persistent" else "snapshots")
        total = body.get("total")
        if not isinstance(batch, list) or not isinstance(total, int):
            raise _invalid()
        items.extend(batch)
        if not batch or len(items) >= total:
            break
    return items


def _call(
    client: Client,
    method: str,
    path: str,
    deadline: Deadline,
    body: Json = None,
    *,
    retry: bool | None = None,
    not_found: str | None = None,
    accept: tuple[str, ...] = (),
) -> Response:
    response = client.request(
        method,
        path,
        body,
        deadline=deadline,
        timeout=60,
        retry=method == "GET" if retry is None else retry,
    )
    if 200 <= response.status < 300:
        return response
    blocked = edge_blocked_error(response)
    if blocked is not None:
        raise blocked
    detail = _detail(response)
    if detail is not None and detail in accept:
        return response
    upgrade = mac_upgrade_message(response) if detail == "computer_not_enabled" else None
    if upgrade is not None:
        raise VerifyError(
            "NOT_AVAILABLE_ON_PLATFORM",
            upgrade,
            reason="upgrade_required",
            http_status=response.status,
        )
    known = _REFUSALS.get(detail or "")
    if known is not None:
        raise VerifyError(
            known[0],
            known[1],
            reason="persistent_computers_not_enabled"
            if detail == "persistent_computers_not_enabled"
            else None,
            http_status=response.status,
        )
    suffix = f", {detail}" if detail else ""
    if response.status in (401, 403):
        raise VerifyError(
            "AUTH_REJECTED",
            f"Revyl rejected the request (HTTP {response.status}{suffix}). Check that "
            "REVYL_API_KEY is a current key "
            "and that its owner has the Member role or above.",
            http_status=response.status,
        )
    if response.status == 404:
        raise VerifyError(
            "NOT_FOUND",
            not_found or f"Revyl could not find {path} (inaccessible).",
            http_status=404,
        )
    if response.status == 422 or detail == "invalid_request":
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"Revyl refused the request as invalid ({detail or f'HTTP {response.status}'}). Check "
            "the call's "
            "arguments against its docstring; if they match, update Verify.",
            http_status=response.status,
        )
    raise VerifyError(
        "API_ERROR",
        f"Revyl request {method} {path} failed (HTTP {response.status}{suffix}). It is safe to try "
        "again; if it "
        "keeps failing, send this message to support@revyl.ai.",
        http_status=response.status,
    )


_REFUSALS: dict[str, tuple[str, str]] = {
    "persistent_computers_not_enabled": (
        "NOT_AVAILABLE_ON_PLATFORM",
        "Persistent computers aren't enabled for this API key's organization yet "
        "(persistent_computers_not_enabled). Ask support@revyl.ai to turn them on.",
    ),
    "computer_not_enabled": (
        "NOT_AVAILABLE_ON_PLATFORM",
        "Mac computers aren't enabled for this API key's organization (computer_not_enabled). Ask "
        "support@revyl.ai about access.",
    ),
    "runtime_unavailable": (
        "NOT_AVAILABLE_ON_PLATFORM",
        "Revyl has no Mac computers available in this environment (runtime_unavailable).",
    ),
    "persistent_computer_limit": (
        "COMPUTER_LIMIT",
        "Your organization already keeps as many persistent computers as it may "
        "(persistent_computer_limit). "
        "list_persistent() shows them; delete one you no longer need with delete_persistent(), "
        "then try again.",
    ),
    "snapshot_limit": (
        "COMPUTER_LIMIT",
        "Your organization already keeps as many snapshots as it may (snapshot_limit). "
        "list_snapshots() shows "
        "them; delete one you no longer need with delete_snapshot(), then try again.",
    ),
    "computer_limit": (
        "COMPUTER_LIMIT",
        "Revyl refused to start another computer right now (computer_limit): your organization is "
        "at its "
        "concurrency limit or has queued work. Stop a computer you no longer need, or try again "
        "later.",
    ),
    "computer_long_limit": (
        "COMPUTER_LIMIT",
        "Revyl refused a lifetime over 2 hours: the organization already has 2 computers running "
        "longer than 2 "
        "hours (computer_long_limit). Pass a timeout of 7200 or less, or stop one of them.",
    ),
    "saved_disk_unavailable": (
        "SESSION_START_FAILED",
        "The Mac holding this computer's saved disk is offline and the save isn't copied off it "
        "yet, or no Mac can "
        "start it right now (saved_disk_unavailable). The disk is kept; try again later.",
    ),
    "saved_disk_expired": (
        "SESSION_START_FAILED",
        "This computer's saved disk has reached its end and can't start again "
        "(saved_disk_expired). Delete it with "
        "delete_persistent(); open_persistent() with its name then creates a new one.",
    ),
    "snapshot_expired": (
        "SESSION_START_FAILED",
        "This snapshot's saved disk has reached its end and can't start a computer "
        "(snapshot_expired). Save a new "
        "snapshot of a recently stopped computer.",
    ),
    "computer_not_persistent": (
        "INVALID_ARGUMENT",
        "This ID names a computer that isn't persistent (computer_not_persistent). Pass a name, or "
        "an ID from "
        "list_persistent().",
    ),
    "run_conflict": (
        "SESSION_BUSY",
        "The computer's last run hasn't finished stopping (run_conflict). Its disk is kept; try "
        "again in a few "
        "minutes.",
    ),
}


def _detail(response: Response) -> str | None:
    try:
        detail = obj(response.json()).get("detail")
    except VerifyError:
        return None
    return detail if isinstance(detail, str) else None


def _computer_not_found(reference: str) -> VerifyError:
    kind = "with the ID" if _UUID.fullmatch(reference) else "named"
    return VerifyError(
        "NOT_FOUND",
        f"There is no persistent computer {kind} {reference}. list_persistent() shows your "
        "organization's "
        "persistent computers; open_persistent() with a name creates one.",
    )


def _check_computer(value: object, call: str) -> None:
    if not isinstance(value, str) or not (_NAME.fullmatch(value) or _UUID.fullmatch(value)):
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"{call} takes a computer name of {_NAME_RULE}, or an ID from list_persistent().",
        )


def _check_snapshot(value: object, what: str) -> None:
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise VerifyError(
            "INVALID_ARGUMENT", f"{what} takes a snapshot name or ID from list_snapshots()."
        )


def _to_computer(raw: Json) -> PersistentComputer:
    record = obj(raw)
    computer_id, state, durable = (
        record.get("computer_id"),
        record.get("state"),
        record.get("durable"),
    )
    if (
        not isinstance(computer_id, str)
        or not _UUID.fullmatch(computer_id)
        or state not in _STATES
        or not isinstance(durable, bool)
    ):
        raise _invalid()
    saved_at = record.get("saved_at")
    return PersistentComputer(
        id=computer_id.lower(),
        state=cast(PersistentComputerState, state),
        saved_at=None if saved_at is None else timestamp(saved_at),
        saved_off_host=durable,
        created_at=timestamp(record.get("created_at")),
    )


def _to_snapshot(raw: Json) -> ComputerSnapshot:
    record = obj(raw)
    snapshot_id, name, computer_id = record.get("id"), record.get("name"), record.get("computer_id")
    if (
        not isinstance(snapshot_id, str)
        or not _UUID.fullmatch(snapshot_id)
        or not isinstance(name, str)
        or not isinstance(computer_id, str)
        or not _UUID.fullmatch(computer_id)
    ):
        raise _invalid()
    expires_at = record.get("expires_at")
    return ComputerSnapshot(
        id=snapshot_id.lower(),
        name=name,
        computer_id=computer_id.lower(),
        saved_at=timestamp(record.get("saved_at")),
        expires_at=None if expires_at is None else timestamp(expires_at),
    )


def _invalid() -> VerifyError:
    return VerifyError("API_ERROR", "Revyl returned an invalid persistent computer response.")
