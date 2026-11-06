from __future__ import annotations

import math
import os
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import get_args

from ._proof_runs import (
    ProofEnvironmentValue,
    ProofHarness,
    ProofRunState,
    PullRequestContext,
    SecretRef,
    cancel_proof_run,
    create_proof_run,
    get_proof_run,
)
from ._transport import Client, VerifyError, credentials
from ._upload import (
    UploadResult,
    UrlBuildResult,
    detect_scm_identity,
    register_url_build,
    upload_build,
)

_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_DEFAULT_TIMEOUT = 30 * 60.0
_POLL_INTERVALS = (5.0, 10.0, 15.0)


@dataclass(frozen=True)
class ProofRun:
    id: str
    status: str
    """Revyl's run status, as reported."""
    verdict: str | None
    """``passed``, ``failed``, or ``inconclusive`` once the run settles with a verdict."""
    label: str | None
    """Revyl's display label, such as ``Ready``, ``Ready with issues``, or ``Partial coverage``."""
    report_url: str | None
    """The pull request comment with the report."""
    review_url: str | None
    created_at: str | None
    settled_at: str | None
    """Set once the run is over."""
    pull_request: PullRequestContext
    build: UploadResult | UrlBuildResult
    """The uploaded mobile build, or the registered Web URL build."""


def proof(
    build: str | os.PathLike[str] | None = None,
    app_id: str | None = None,
    *,
    url: str | None = None,
    guidance: str | None = None,
    harness: ProofHarness = "revyl",
    environment: Mapping[str, ProofEnvironmentValue] | None = None,
    wait: bool = True,
    timeout: float = _DEFAULT_TIMEOUT,
    version: str | None = None,
    token: str | None = None,
    backend_url: str | None = None,
) -> ProofRun:
    """Uploads a pull request's CI build, or registers its deployment URL, and starts a Revyl
    Proof of Changes run on it.

    Pass exactly one target: ``build``, a debug ``.apk``, a simulator ``.app`` bundle, or a
    ``.zip`` holding one, for a mobile app; or ``url``, a deployment to prove in a cloud browser,
    for a Web app. ``app_id`` is the Revyl app (UUID) the target belongs to.

    A ``url`` must be public HTTPS on port 443, and any HTTP status of 400 or above fails the
    page. URL builds take no headers or basic auth, so the page must load signed in or without
    sign-in. The URL must stay up from the call until the run settles, which can take minutes;
    with ``wait=False``, keeping it up is the caller's job. The same build at the same head commit
    returns the earlier run, so a stable hostname reuses it. ``environment`` and ``version``
    apply only to mobile builds.

    With ``wait`` (the default) it polls until the run has a verdict, for at most ``timeout``
    seconds; the run keeps going on Revyl after a timeout. Interrupting the wait cancels the run.
    In ``environment``, a string is a plain value that Revyl stores with the run and may show in
    reports, so it must not be a secret; ``{"secret_ref": "NAME"}`` names an organization launch
    variable that holds a secret. Needs a pull request on GitHub Actions.
    """
    web = url is not None
    if web == (build is not None):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Pass either build (a mobile artifact) or url (a Web deployment), not both.",
        )
    if web and environment is not None:
        raise VerifyError(
            "INVALID_ARGUMENT",
            "environment applies only to mobile builds; a URL build takes no launch variables.",
        )
    if web and version is not None:
        raise VerifyError("INVALID_ARGUMENT", "version applies only to mobile builds.")
    if not isinstance(app_id, str):
        raise VerifyError("INVALID_ARGUMENT", "app_id must be a Revyl app id (a UUID).")
    if harness not in get_args(ProofHarness):
        raise VerifyError(
            "INVALID_ARGUMENT", f"harness must be one of {', '.join(get_args(ProofHarness))}."
        )
    launch = _valid_environment(environment)
    if not isinstance(wait, bool):
        raise VerifyError("INVALID_ARGUMENT", "wait must be a boolean.")
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise VerifyError("INVALID_ARGUMENT", "timeout must be a positive number of seconds.")
    if guidance is not None and not isinstance(guidance, str):
        raise VerifyError("INVALID_ARGUMENT", "guidance must be a string.")
    focus = (guidance or "").strip() or None
    pull_request = _detect_pull_request()
    resolved_token = credentials() if token is None else token
    client = Client(backend_url, resolved_token)

    target: UploadResult | UrlBuildResult = (
        register_url_build(client, url, app_id)
        if url is not None
        else upload_build(
            build or "", app_id, version=version, token=resolved_token, backend_url=backend_url
        )
    )
    started = create_proof_run(
        client,
        app_id=app_id,
        build_id=target.build_id,
        pull_request=pull_request,
        harness=harness,
        guidance=focus,
        environment=launch,
    )
    state = _wait_for_verdict(client, started, timeout) if wait else started
    return ProofRun(
        id=state.id,
        status=state.status,
        verdict=state.verdict,
        label=state.label,
        report_url=state.report_url,
        review_url=state.review_url,
        created_at=state.created_at,
        settled_at=state.settled_at,
        pull_request=pull_request,
        build=target,
    )


def _wait_for_verdict(client: Client, started: ProofRunState, timeout: float) -> ProofRunState:
    deadline = time.monotonic() + timeout
    state = started
    poll = 0
    try:
        while True:
            if state.settled_at is not None:
                if state.verdict is not None:
                    return state
                raise VerifyError(
                    "PROOF_RUN_ENDED",
                    f"Proof of Changes run {state.id} ended without a verdict "
                    f"({state.label or state.status}).{_where(state)}",
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerifyError(
                    "TIMEOUT",
                    f"Proof of Changes run {state.id} had no verdict after {round(timeout)} s. "
                    f"It keeps running on Revyl.{_where(state)}",
                )
            time.sleep(min(_POLL_INTERVALS[min(poll, len(_POLL_INTERVALS) - 1)], remaining))
            poll += 1
            state = get_proof_run(client, state.id)
    except KeyboardInterrupt:
        try:
            cancel_proof_run(client, started.id)
        except VerifyError as error:
            raise VerifyError(
                "API_ERROR",
                f"Proof of Changes run {started.id} was interrupted, but cancelling it failed: "
                f"{error.message}",
            ) from error
        raise


def _detect_pull_request() -> PullRequestContext:
    identity = detect_scm_identity()
    if identity is None or identity.ci_system != "github-actions" or identity.pr is None:
        raise VerifyError(
            "PR_CONTEXT_MISSING",
            "proof() needs a pull_request event on GitHub Actions to know the repository, "
            "pull request, and head commit.",
        )
    return PullRequestContext(
        provider="github",
        repository=identity.repository,
        number=identity.pr,
        head_sha=identity.commit,
        base_sha=identity.base_commit or None,
    )


def _where(state: ProofRunState) -> str:
    url = state.report_url or state.review_url
    return f" See {url}" if url else ""


def _valid_environment(
    environment: Mapping[str, ProofEnvironmentValue] | None,
) -> dict[str, ProofEnvironmentValue] | None:
    if environment is None:
        return None
    if not isinstance(environment, Mapping):
        raise VerifyError(
            "INVALID_ARGUMENT",
            'environment must map variable names to values or {"secret_ref": ...} references.',
        )
    valid: dict[str, ProofEnvironmentValue] = {}
    for name, value in environment.items():
        if not isinstance(name, str) or not _ENVIRONMENT_NAME.fullmatch(name):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "environment has an invalid variable name: use letters, digits, and underscores, "
                "not starting with a digit.",
            )
        if isinstance(value, str):
            valid[name] = value
            continue
        reference = value.get("secret_ref") if isinstance(value, Mapping) else None
        if not isinstance(reference, str) or not reference.strip():
            raise VerifyError(
                "INVALID_ARGUMENT",
                f"environment variable {name} must be a string or "
                '{"secret_ref": "<launch variable name>"}.',
            )
        valid[name] = SecretRef(secret_ref=reference)
    return valid or None


__all__ = ["ProofRun", "proof"]
