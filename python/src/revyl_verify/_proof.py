from __future__ import annotations

import math
import os
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal, get_args

from ._models import UUID_PATTERN
from ._proof_runs import (
    ProofEnvironmentValue,
    ProofHarness,
    ProofRunState,
    ProofRunTarget,
    PullRequestContext,
    SecretRef,
    cancel_proof_run,
    create_proof_runs,
    get_proof_run,
)
from ._transport import Client, VerifyError, credentials
from ._upload import (
    UploadResult,
    UrlBuildResult,
    detect_scm_identity,
    register_url_build,
    upload_build,
    validate_web_url,
)

_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MAX_TARGETS = 3
_DEFAULT_TIMEOUT = 30 * 60.0
_POLL_INTERVALS = (5.0, 10.0, 15.0)


@dataclass(frozen=True)
class ProofTarget:
    """One target of a Proof of Changes run: set exactly one of ``build`` and ``url``.

    ``build`` is a mobile build: a debug ``.apk``, a simulator ``.app`` bundle, or a ``.zip``
    holding one, with ``app_id`` its Revyl mobile app. In ``environment``, a string is a plain
    launch value that Revyl stores with the run and may show in reports, so it must not be a secret;
    ``{"secret_ref": "NAME"}`` names an organization launch variable that holds a secret.
    ``version`` is a label unique within the app; it defaults to the short head commit plus a UTC
    timestamp.

    ``url`` is a Web deployment to prove in a cloud browser, with ``app_id`` its Revyl Web app. It
    must be public HTTPS on port 443, and any HTTP status of 400 or above fails the page. URL builds
    take no headers or basic auth, so the page must load signed in or without sign-in. It must stay
    up from the call until the run settles, which can take minutes; with ``wait=False``, keeping it
    up is the caller's job. ``environment`` and ``version`` apply only to ``build``.
    """

    app_id: str
    build: str | os.PathLike[str] | None = None
    url: str | None = None
    environment: Mapping[str, ProofEnvironmentValue] | None = field(default=None, repr=False)
    version: str | None = None


@dataclass(frozen=True)
class ProofTargetRun:
    id: str
    app_id: str
    platform: str | None
    """``ios``, ``android``, or ``web``, as Revyl reports it."""
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
    build: UploadResult | UrlBuildResult
    """The uploaded mobile build, or the registered Web URL build."""


@dataclass(frozen=True)
class ProofRun:
    runs: tuple[ProofTargetRun, ...]
    verdict: Literal["passed", "failed", "inconclusive"] | None
    """Set once every run has a verdict: ``failed`` if any run failed, otherwise ``inconclusive`` if
    any run is inconclusive (a verdict Verify doesn't recognize counts as inconclusive), otherwise
    ``passed``."""
    label: str | None
    """The label of the first run whose verdict decided ``verdict``."""
    report_url: str | None
    """The pull request comment with the report, from the first run that has one."""
    pull_request: PullRequestContext


def proof(
    build: str | os.PathLike[str] | None = None,
    app_id: str | None = None,
    *,
    url: str | None = None,
    environment: Mapping[str, ProofEnvironmentValue] | None = None,
    version: str | None = None,
    targets: Sequence[ProofTarget] | None = None,
    guidance: str | None = None,
    harness: ProofHarness = "revyl",
    wait: bool = True,
    timeout: float = _DEFAULT_TIMEOUT,
    token: str | None = None,
    backend_url: str | None = None,
) -> ProofRun:
    """Uploads each target's mobile build or registers its Web deployment URL, then starts one
    Revyl Proof of Changes run per target on the pull request.

    Pass up to three ``targets``, one per platform, or a single target inline as ``build`` or
    ``url`` with ``app_id`` (and, for ``build``, ``environment`` and ``version``); see
    ``ProofTarget``. Revyl reuses the earlier runs when the same target set (the same builds) is
    started again at the same head commit, so a stable hostname reuses a Web run.

    With ``wait`` (the default) it polls until every run settles, for at most ``timeout`` seconds;
    the runs keep going on Revyl after a timeout. Interrupting the wait cancels the runs that
    haven't settled. Needs a pull request on GitHub Actions.
    """
    chosen = _proof_targets(build, app_id, url, environment, version, targets)
    if harness not in get_args(ProofHarness):
        raise VerifyError(
            "INVALID_ARGUMENT", f"harness must be one of {', '.join(get_args(ProofHarness))}."
        )
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

    builds: list[UploadResult | UrlBuildResult] = []
    for target in chosen:
        builds.append(
            register_url_build(client, target.url, target.app_id)
            if target.url is not None
            else upload_build(
                target.build or "",
                target.app_id,
                version=target.version,
                token=resolved_token,
                backend_url=backend_url,
            )
        )
    platforms = [built.platform for built in builds]
    if len(set(platforms)) != len(platforms):
        raise VerifyError(
            "INVALID_ARGUMENT", f"targets must be one per platform; got {', '.join(platforms)}."
        )

    started = create_proof_runs(
        client,
        targets=[
            ProofRunTarget(target.app_id, built.build_id, target.environment)
            for target, built in zip(chosen, builds)
        ],
        pull_request=pull_request,
        harness=harness,
        guidance=focus,
    )
    ordered = [
        next((state for state in started if state.app_id == target.app_id), started[index])
        for index, target in enumerate(chosen)
    ]
    states = _wait_for_all(client, ordered, timeout) if wait else ordered
    runs = tuple(
        ProofTargetRun(
            id=state.id,
            app_id=state.app_id or target.app_id,
            platform=state.platform,
            status=state.status,
            verdict=state.verdict,
            label=state.label,
            report_url=state.report_url,
            review_url=state.review_url,
            created_at=state.created_at,
            settled_at=state.settled_at,
            build=built,
        )
        for state, target, built in zip(states, chosen, builds)
    )
    verdict, label = _overall_verdict(runs)
    return ProofRun(
        runs=runs,
        verdict=verdict,
        label=label,
        report_url=next((run.report_url for run in runs if run.report_url), None),
        pull_request=pull_request,
    )


def _proof_targets(
    build: str | os.PathLike[str] | None,
    app_id: str | None,
    url: str | None,
    environment: Mapping[str, ProofEnvironmentValue] | None,
    version: str | None,
    targets: Sequence[ProofTarget] | None,
) -> list[ProofTarget]:
    inline = any(value is not None for value in (build, app_id, url, environment, version))
    if targets is not None and inline:
        raise VerifyError(
            "INVALID_ARGUMENT", "Pass targets, or a single build or url with app_id, not both."
        )
    if targets is None:
        chosen = (
            [ProofTarget(app_id or "", build, url, environment, version)]
            if build is not None or url is not None
            else []
        )
    elif isinstance(targets, Sequence) and not isinstance(targets, str):
        chosen = list(targets)
    else:
        chosen = []
    if not 1 <= len(chosen) <= _MAX_TARGETS:
        raise VerifyError(
            "INVALID_ARGUMENT", f"proof() needs 1 to {_MAX_TARGETS} targets, one per platform."
        )
    valid: list[ProofTarget] = []
    for target in chosen:
        if not isinstance(target, ProofTarget):
            raise VerifyError("INVALID_ARGUMENT", "targets must be ProofTarget values.")
        if (target.url is None) == (target.build is None):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "Each target takes either build (a mobile artifact) or url (a Web deployment), "
                "not both.",
            )
        if target.url is not None and target.environment is not None:
            raise VerifyError(
                "INVALID_ARGUMENT",
                "environment applies only to mobile builds; a URL target takes no launch "
                "variables.",
            )
        if target.url is not None and target.version is not None:
            raise VerifyError("INVALID_ARGUMENT", "version applies only to mobile builds.")
        if not isinstance(target.app_id, str) or not UUID_PATTERN.fullmatch(target.app_id):
            raise VerifyError("INVALID_ARGUMENT", "app_id must be a Revyl app id (a UUID).")
        if target.url is not None:
            validate_web_url(target.url)
        valid.append(replace(target, environment=_valid_environment(target.environment)))
    if len({target.app_id for target in valid}) != len(valid):
        raise VerifyError("INVALID_ARGUMENT", "Each target needs its own app_id, one per platform.")
    if sum(target.url is not None for target in valid) > 1:
        raise VerifyError(
            "INVALID_ARGUMENT", "targets take at most one url: one target per platform."
        )
    return valid


def _overall_verdict(
    runs: Sequence[ProofTargetRun],
) -> tuple[Literal["passed", "failed", "inconclusive"] | None, str | None]:
    if any(run.verdict is None for run in runs):
        return None, None

    def decide(verdict: str | None) -> Literal["passed", "failed", "inconclusive"]:
        return (
            "failed" if verdict == "failed" else "passed" if verdict == "passed" else "inconclusive"
        )

    decided = [decide(run.verdict) for run in runs]
    verdict: Literal["passed", "failed", "inconclusive"] = (
        "failed"
        if "failed" in decided
        else "inconclusive"
        if "inconclusive" in decided
        else "passed"
    )
    return verdict, next(run.label for run, own in zip(runs, decided) if own == verdict)


def _wait_for_all(
    client: Client, started: list[ProofRunState], timeout: float
) -> list[ProofRunState]:
    deadline = time.monotonic() + timeout
    states = list(started)

    def unsettled() -> list[ProofRunState]:
        return [state for state in states if state.settled_at is None]

    poll = 0
    try:
        while unsettled():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VerifyError(
                    "TIMEOUT",
                    "Proof of Changes had no verdict for "
                    f"{', '.join(state.id for state in unsettled())} after {round(timeout)} s. "
                    f"The runs keep going on Revyl.{_where(states)}",
                )
            time.sleep(min(_POLL_INTERVALS[min(poll, len(_POLL_INTERVALS) - 1)], remaining))
            poll += 1
            for index, state in enumerate(states):
                if state.settled_at is None:
                    fresh = get_proof_run(client, state.id)
                    states[index] = replace(
                        fresh,
                        app_id=fresh.app_id or state.app_id,
                        platform=fresh.platform or state.platform,
                    )
    except KeyboardInterrupt:
        failures: list[VerifyError] = []
        for state in unsettled():
            try:
                cancel_proof_run(client, state.id)
            except VerifyError as error:
                failures.append(error)
        if failures:
            raise VerifyError(
                "API_ERROR",
                "Proof of Changes was interrupted, but cancelling its runs failed: "
                f"{failures[0].message}",
            ) from failures[0]
        raise
    ended = [state for state in states if state.verdict is None]
    if ended:
        raise VerifyError(
            "PROOF_RUN_ENDED",
            "Proof of Changes run "
            f"{', '.join(f'{state.id} ({state.label or state.status})' for state in ended)} "
            f"ended without a verdict.{_where(states)}",
        )
    return states


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


def _where(states: Sequence[ProofRunState]) -> str:
    url = next(
        (
            state.report_url or state.review_url
            for state in states
            if state.report_url or state.review_url
        ),
        None,
    )
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


__all__ = ["ProofRun", "ProofTarget", "ProofTargetRun", "proof"]
