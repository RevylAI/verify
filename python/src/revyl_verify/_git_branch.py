from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote_to_bytes

_TIMEOUT_SECONDS = 5.0
_OUTPUT_LIMIT = 64 * 1024
_NAME_LIMIT = 4096
_EVENT_LIMIT = 1024 * 1024
_NONE, _LOCAL, _GITHUB, _BUILDKITE = "none", "local_git", "github_actions", "buildkite"
_DROPPED_ENV = {
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_TERMINAL_PROMPT",
    "GCM_INTERACTIVE",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_OPTIONAL_LOCKS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
}
_GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GCM_INTERACTIVE": "never",
    "GIT_ASKPASS": "",
    "SSH_ASKPASS": "",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_SSH_COMMAND": "ssh -oBatchMode=yes -oConnectTimeout=3 -oConnectionAttempts=1",
}
_GO_SPACE = "\t\n\v\f\r \x85\xa0\u1680\u2028\u2029\u202f\u205f\u3000" + "".join(
    chr(code) for code in range(0x2000, 0x200B)
)
_EVENT_FIELDS: dict[str, Any] = {
    "number": int,
    "ref": str,
    "after": str,
    "repository": {"full_name": str},
    "pull_request": {
        "number": int,
        "head": {"sha": str, "ref": str, "repo": {"full_name": str}},
        "base": {"repo": {"full_name": str}},
    },
}


@dataclass
class _Checkout:
    branch: str = ""
    head: str = ""
    repository: str = ""
    parents: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Buildkite:
    review_number: int
    repository_url: str
    repository: str
    fork: bool
    commit: str
    branch: str


def detect_git_branch(project_root: str) -> str | None:
    """The branch the Revyl CLI's DetectGitBranch finds for a checkout, or None."""
    deadline = time.monotonic() + _TIMEOUT_SECONDS
    checkout = _read_checkout(project_root, deadline)
    if checkout is not None:
        name, origin = _detect_ci_branch(checkout)
        if origin == _NONE and checkout.branch and not _synthetic_github_branch(checkout.branch):
            name, origin = _candidate(checkout.branch, _LOCAL)
    elif time.monotonic() < deadline:
        name, origin = _detect_ci_branch(None)
    else:
        name = ""
    return name or None


def _env(name: str) -> str:
    return os.environ.get(name, "")


def _trim_space(value: str) -> str:
    return value.strip(_GO_SPACE)


def _run_git(project_root: str, deadline: float, *args: str) -> tuple[str, bool]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "", False
    environment = {key: value for key, value in os.environ.items() if key not in _DROPPED_ENV}
    environment.update(_GIT_ENV)
    try:
        completed = subprocess.run(
            ["git", "-C", os.path.normpath(project_root), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=remaining,
            check=False,
        )
        output, ok = completed.stdout, completed.returncode == 0
    except subprocess.TimeoutExpired as error:
        output, ok = error.stdout or b"", False
    except (OSError, ValueError, subprocess.SubprocessError):
        output, ok = b"", False
    return output[:_OUTPUT_LIMIT].decode("utf-8", errors="surrogateescape"), ok


def _read_checkout(project_root: str, deadline: float) -> _Checkout | None:
    inside, ok = _run_git(project_root, deadline, "rev-parse", "--is-inside-work-tree")
    if not ok or _trim_space(inside) != "true":
        return None
    checkout = _Checkout()
    reference, ok = _run_git(project_root, deadline, "symbolic-ref", "--quiet", "HEAD")
    if ok and reference.startswith("refs/heads/"):
        checkout.branch = reference[len("refs/heads/") :].rstrip("\r\n")
    if checkout.branch and _env("GITHUB_ACTIONS") != "true" and _env("BUILDKITE") != "true":
        return checkout
    checkout.head = _trim_space(
        _run_git(project_root, deadline, "rev-parse", "--verify", "HEAD")[0]
    )
    remote = _run_git(project_root, deadline, "remote", "get-url", "origin")[0]
    checkout.repository = _normalize_repository(remote)
    if _env("GITHUB_ACTIONS") == "true" and _env("GITHUB_REF").startswith("refs/pull/"):
        commit = _run_git(project_root, deadline, "cat-file", "-p", "HEAD")[0]
        for line in commit.split("\n"):
            if line == "":
                break
            if line.startswith("parent "):
                checkout.parents.append(line[len("parent ") :])
    return checkout


def _synthetic_github_branch(branch: str) -> bool:
    if _env("GITHUB_ACTIONS") != "true" or not _env("GITHUB_REF").startswith("refs/pull/"):
        return False
    return branch in (_env("GITHUB_REF_NAME"), _env("GITHUB_REF"))


def _candidate(name: str, origin: str) -> tuple[str, str]:
    if name == "":
        return "", _NONE
    if any("\udc80" <= character <= "\udcff" for character in name):
        return "invalid-utf8" * 24, origin
    return name[:_NAME_LIMIT], origin


def _detect_ci_branch(checkout: _Checkout | None) -> tuple[str, str]:
    if _env("GITHUB_ACTIONS") == "true":
        return _detect_github_branch(checkout)
    if _env("BUILDKITE") == "true":
        return _detect_buildkite_branch(checkout)
    return "", _NONE


def _text(value: Any, *keys: str) -> str:
    for key in keys:
        value = value.get(key) if isinstance(value, dict) else None
    return value if isinstance(value, str) else ""


def _detect_github_branch(checkout: _Checkout | None) -> tuple[str, str]:
    absent = ("", _NONE)
    event = _read_branch_event(_env("GITHUB_EVENT_PATH"))
    repository = _normalize_repository(_env("GITHUB_REPOSITORY"))
    if repository == "":
        return absent
    head_ref = _text(event, "pull_request", "head", "ref")
    head_sha = _text(event, "pull_request", "head", "sha")
    if head_ref and head_sha:
        head_full_name = _text(event, "pull_request", "head", "repo", "full_name")
        base_repository = _normalize_repository(
            _text(event, "pull_request", "base", "repo", "full_name")
        )
        head_repository = _normalize_repository(head_full_name)
        if base_repository != repository or head_repository == "":
            return absent
        if checkout is not None:
            if (
                checkout.branch
                and checkout.branch != head_ref
                and not _synthetic_github_branch(checkout.branch)
            ):
                return absent
            if checkout.repository not in (base_repository, head_repository):
                return absent
            ref = _env("GITHUB_REF")
            merge_checkout = (
                ref.startswith("refs/pull/")
                and ref.endswith("/merge")
                and _same_commit(checkout.head, _env("GITHUB_SHA"))
                and any(_same_commit(parent, head_sha) for parent in checkout.parents)
            )
            if not _same_commit(checkout.head, head_sha) and not merge_checkout:
                return absent
        return _pull_request_head_branch(
            head_ref, head_full_name, head_repository != base_repository, _GITHUB
        )
    if checkout is not None and checkout.branch:
        return absent
    ref = _env("GITHUB_REF")
    if (
        _env("GITHUB_HEAD_REF")
        or _env("GITHUB_REF_TYPE") == "tag"
        or not ref.startswith("refs/heads/")
    ):
        return absent
    if checkout is not None and (
        checkout.repository != repository or not _same_commit(checkout.head, _env("GITHUB_SHA"))
    ):
        return absent
    return _candidate(ref[len("refs/heads/") :], _GITHUB)


def _go_atoi(value: str) -> int:
    if not re.fullmatch(r"[+-]?[0-9]+", value):
        return 0
    number = int(value)
    return number if -(2**63) <= number < 2**63 else 0


def _read_buildkite_source() -> _Buildkite | None:
    if _env("BUILDKITE_TAG"):
        return None
    repository_url = _env("BUILDKITE_REPO")
    pipeline_repository = _normalize_repository(repository_url)
    if pipeline_repository == "":
        return None
    repository = pipeline_repository
    review = _go_atoi(_env("BUILDKITE_PULL_REQUEST"))
    review_number = 0
    if review > 0:
        review_number = review
        head_repository_url = _env("BUILDKITE_PULL_REQUEST_REPO")
        if head_repository_url:
            repository_url = head_repository_url
            repository = _normalize_repository(head_repository_url)
            if repository == "":
                return None
    fork = repository != pipeline_repository
    commit = _env("BUILDKITE_PULL_REQUEST_HEAD_COMMIT") or _env("BUILDKITE_COMMIT")
    branch = _env("BUILDKITE_BRANCH")
    if fork and ":" in branch:
        branch = branch.split(":", 1)[1]
    return _Buildkite(review_number, repository_url, repository, fork, commit, branch)


def _detect_buildkite_branch(checkout: _Checkout | None) -> tuple[str, str]:
    absent = ("", _NONE)
    source = _read_buildkite_source()
    if source is None:
        return absent
    if checkout is not None:
        if checkout.repository != source.repository or not _same_commit(
            checkout.head, source.commit
        ):
            return absent
        if checkout.branch and checkout.branch != source.branch:
            return absent
    if source.review_number > 0:
        return _pull_request_head_branch(
            source.branch, source.repository_url, source.fork, _BUILDKITE
        )
    if checkout is not None and checkout.branch:
        return absent
    return _candidate(source.branch, _BUILDKITE)


def _pull_request_head_branch(
    branch: str, head_repository: str, fork: bool, origin: str
) -> tuple[str, str]:
    if branch == "":
        return "", origin
    if not fork:
        return _candidate(branch, origin)
    owner = _repository_namespace(head_repository)
    if owner == "":
        return "", origin
    return _candidate(owner + ":" + branch, origin)


def _event_fits(value: dict[str, Any], fields: dict[str, Any]) -> bool:
    for key, kind in fields.items():
        item = value.get(key)
        if item is None:
            continue
        if isinstance(kind, dict):
            if not isinstance(item, dict) or not _event_fits(item, kind):
                return False
        elif kind is int:
            if isinstance(item, bool) or not isinstance(item, int) or not -(2**63) <= item < 2**63:
                return False
        elif not isinstance(item, str):
            return False
    return True


def _reject_constant(value: str) -> None:
    raise ValueError(value)


def _read_branch_event(path: str) -> dict[str, Any]:
    try:
        info = os.stat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > _EVENT_LIMIT:
            return {}
        with open(path, "rb") as stream:
            data = stream.read(_EVENT_LIMIT + 1)
        if len(data) > _EVENT_LIMIT:
            return {}
        event = json.loads(data.decode("utf-8", errors="replace"), parse_constant=_reject_constant)
    except (OSError, ValueError, RecursionError):
        return {}
    return event if isinstance(event, dict) and _event_fits(event, _EVENT_FIELDS) else {}


def _parse_repository(value: str) -> tuple[str, str]:
    value = _trim_space(value)
    if value == "":
        return "", ""
    if value.startswith("git@") and ":" in value:
        value = "ssh://" + value.replace(":", "/", 1)
    if "://" not in value:
        if value.count("/") != 1 or value.startswith("."):
            return "", ""
        value = "https://github.com/" + value
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        return "", ""
    scheme, rest = value.split("://", 1)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", scheme):
        return "", ""
    rest, _, fragment = rest.partition("#")
    rest, _, query = rest.partition("?")
    if fragment or query:
        return "", ""
    slash = rest.find("/")
    authority, path = (rest, "") if slash < 0 else (rest[:slash], rest[slash:])
    host = authority.rpartition("@")[2]
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return "", ""
        hostname, port = host[1:end], host[end + 1 :]
        if port and not port.startswith(":"):
            return "", ""
    else:
        colon = host.rfind(":")
        hostname, port = (host, "") if colon < 0 else (host[:colon], host[colon:])
    if hostname == "" or not re.fullmatch(r"(:[0-9]*)?", port):
        return "", ""
    if re.search(r"%(?![0-9A-Fa-f]{2})", path):
        return "", ""
    decoded = unquote_to_bytes(path).decode("utf-8", errors="surrogateescape")
    decoded = decoded.removesuffix("/").removesuffix(".git")
    if decoded == "":
        return "", ""
    return host.lower(), decoded


def _normalize_repository(value: str) -> str:
    host, path = _parse_repository(value)
    if path == "":
        return ""
    return host + (path.lower() if host == "github.com" else path)


def _repository_namespace(value: str) -> str:
    segments = _parse_repository(value)[1].removeprefix("/").split("/")
    if len(segments) < 2 or any(segment == "" for segment in segments):
        return ""
    return "/".join(segments[:-1])


def _same_commit(a: str, b: str) -> bool:
    if len(a) not in (40, 64) or len(a) != len(b):
        return False
    if not re.fullmatch(r"[0-9A-Fa-f]+", a):
        return False
    return a.lower() == b.lower()
