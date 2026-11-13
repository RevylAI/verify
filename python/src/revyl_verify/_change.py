from __future__ import annotations

import os
import re
import subprocess
import threading
from collections.abc import Mapping

from ._proof_runs import ProofChange
from ._transport import VerifyError

_MAX_DIFF_BYTES = 5 * 1024 * 1024
_GIT_TIMEOUT = 60.0


def change_from_git(
    *,
    cwd: str | os.PathLike[str] | None = None,
    review_key: str | None = None,
    head_sha: str | None = None,
    base_sha: str | None = None,
    title: str | None = None,
    description: str | None = None,
    source_url: str | None = None,
    env: Mapping[str, str] | None = None,
) -> ProofChange:
    """Builds a ``change`` for ``proof()`` from a local checkout: the diff from the base commit to
    the head, plus the review key, title, and link that GitLab merge request pipelines and Bitrise
    pull request builds expose. Explicit arguments win over what CI exposes.

    ``cwd`` is the checkout to diff and defaults to the current directory. ``review_key`` and
    ``base_sha`` are detected on GitLab merge request pipelines and Bitrise pull request builds,
    and required elsewhere. ``head_sha`` defaults to the CI's head commit, or the checkout's
    HEAD, and ``title`` to the merge request title from CI, or the head commit's subject. ``env``
    defaults to the process environment. The base commit must be in the checkout, so fetch enough
    history in a shallow clone.
    """
    ci = _ci_change(os.environ if env is None else env)
    directory = os.fspath(cwd) if cwd is not None else os.getcwd()
    head = head_sha if head_sha is not None else ci.get("head_sha")
    head = (head if head is not None else _git(directory, ["rev-parse", "HEAD"])).strip().lower()
    key = review_key if review_key is not None else ci.get("review_key")
    if key is None:
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Pass a review key (review_key), such as gitlab:group/app!17. It is detected only on "
            "GitLab merge request pipelines and Bitrise pull request builds.",
        )
    base = base_sha if base_sha is not None else ci.get("base_sha")
    branch = ci.get("base_branch")
    if base is None and branch is not None:
        base = _merge_base(directory, head, branch)
    if base is None:
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Pass the base commit (base_sha) the change is diffed from. It is detected only on "
            "GitLab merge request pipelines and Bitrise pull request builds.",
        )
    subject = title if title is not None else ci.get("title")
    return ProofChange(
        review_key=key,
        head_sha=head,
        base_sha=base.strip().lower(),
        title=subject
        if subject is not None
        else _git(directory, ["log", "-1", "--format=%s", head]),
        description=description if description is not None else ci.get("description"),
        diff=_git_diff(directory, base.strip(), head),
        source_url=source_url if source_url is not None else ci.get("source_url"),
    )


def _ci_change(env: Mapping[str, str]) -> dict[str, str]:
    def value(name: str) -> str | None:
        return (env.get(name) or "").strip() or None

    found: dict[str, str | None] = {}
    iid = value("CI_MERGE_REQUEST_IID")
    pull_request = value("BITRISE_PULL_REQUEST")
    if env.get("GITLAB_CI") == "true" and iid is not None:
        project = value("CI_MERGE_REQUEST_PROJECT_PATH") or value("CI_PROJECT_PATH")
        project_url = value("CI_MERGE_REQUEST_PROJECT_URL") or value("CI_PROJECT_URL")
        found = {
            "review_key": f"gitlab:{project}!{iid}" if project is not None else None,
            "head_sha": value("CI_MERGE_REQUEST_SOURCE_BRANCH_SHA") or value("CI_COMMIT_SHA"),
            "base_sha": value("CI_MERGE_REQUEST_DIFF_BASE_SHA"),
            "title": value("CI_MERGE_REQUEST_TITLE"),
            "description": value("CI_MERGE_REQUEST_DESCRIPTION"),
            "source_url": f"{project_url.rstrip('/')}/-/merge_requests/{iid}"
            if project_url is not None and project_url.startswith("https://")
            else None,
        }
    elif pull_request is not None:
        repository = _repository_path(value("GIT_REPOSITORY_URL"))
        message = value("BITRISE_GIT_MESSAGE")
        found = {
            "review_key": f"bitrise:{repository}#{pull_request}"
            if repository is not None
            else None,
            "head_sha": value("BITRISE_GIT_COMMIT"),
            "base_branch": value("BITRISEIO_GIT_BRANCH_DEST"),
            "title": (message.split("\n")[0].strip() or None) if message is not None else None,
        }
    return {name: found_value for name, found_value in found.items() if found_value is not None}


def _repository_path(url: str | None) -> str | None:
    if url is None:
        return None
    path = re.sub(r"^[a-z+]+://[^/]+/", "", url, count=1, flags=re.IGNORECASE)
    path = re.sub(r"^[^@/]+@[^:]+:", "", path, count=1)
    path = re.sub(r"\.git$", "", path, count=1).strip("/")
    return path if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._~/-]*", path) else None


def _merge_base(cwd: str, head_sha: str, branch: str) -> str:
    try:
        return _git(cwd, ["merge-base", head_sha, f"origin/{branch}"])
    except VerifyError:
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"Couldn't find the base of the change against origin/{branch}. Fetch that branch and "
            "enough history, or pass the base commit (base_sha).",
        ) from None


def _git_diff(cwd: str, base_sha: str, head_sha: str) -> str:
    failed = (
        "git couldn't diff the base commit against the head. Both commits must be in the "
        "checkout: in a shallow clone, fetch more history (on GitLab, set GIT_DEPTH: 0)."
    )
    try:
        process = subprocess.Popen(
            [
                "git",
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                f"{base_sha}...{head_sha}",
            ],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        raise VerifyError("INVALID_ARGUMENT", failed) from None
    timer = threading.Timer(_GIT_TIMEOUT, process.kill)
    timer.start()
    try:
        output = process.stdout.read(_MAX_DIFF_BYTES + 1) if process.stdout is not None else b""
        if len(output) > _MAX_DIFF_BYTES:
            process.kill()
        returncode = process.wait()
    finally:
        timer.cancel()
        if process.stdout is not None:
            process.stdout.close()
    if len(output) > _MAX_DIFF_BYTES:
        raise VerifyError("INVALID_ARGUMENT", "The diff is over 5 MiB, the most a proof takes.")
    if returncode != 0:
        raise VerifyError("INVALID_ARGUMENT", failed)
    try:
        return output.decode("utf-8")
    except UnicodeDecodeError:
        raise VerifyError("INVALID_ARGUMENT", "The diff isn't valid UTF-8.") from None


def _git(cwd: str, args: list[str]) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_GIT_TIMEOUT,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"git {args[0]} failed in {cwd}; change_from_git() needs a git checkout of the change.",
        ) from None
    return completed.stdout.decode("utf-8", "replace").strip()


__all__ = ["change_from_git"]
