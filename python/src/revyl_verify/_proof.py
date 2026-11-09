from __future__ import annotations

import math
import os
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Literal
from urllib.parse import urlsplit

from ._models import UUID_PATTERN
from ._proof_runs import (
    ProofAuthBypass,
    ProofChange,
    ProofEnvironmentValue,
    ProofHarness,
    ProofRunState,
    ProofRunTarget,
    PullRequestContext,
    SecretRef,
    cancel_proof_run,
    create_proof_runs,
    get_proof_run,
    is_settled,
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
_DEEP_LINK_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_WEB_SCHEME = re.compile(r"\s*https?:", re.IGNORECASE)
_REVIEW_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._~:/!#@+=-]{0,199}")
_COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
_MAX_DIFF_BYTES = 5 * 1024 * 1024
_MAX_TARGETS = 3
_DEFAULT_TIMEOUT = 30 * 60.0
_POLL_INTERVALS = (5.0, 10.0, 15.0)


@dataclass(frozen=True)
class ProofTarget:
    """One target of a Proof of Changes run: set exactly one of ``build`` and ``url``.

    ``build`` is a mobile build: a debug ``.apk``, a simulator ``.app`` bundle, or a ``.zip``
    holding one, with ``app_id`` its Revyl mobile app. In ``environment``, a string is a plain
    launch value that Revyl stores with the run and may show in reports, so it must not be a
    secret. ``{"secret_ref": "NAME"}``, under the key ``NAME``, uses the organization launch
    variable of the same name, which holds a secret: its value stays in Revyl, and only a member
    API key can reference it.
    ``auth_bypass`` is a deep link Revyl opens after the app launches, like
    ``session.auth_bypass.deep_link`` in a Revyl config, for example
    ``{"deep_link": "myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}"}``. Each ``${NAME}``
    placeholder resolves from this target's ``environment`` only, on Revyl's side, so a secret's
    value never reaches the agent, the report, or the logs. A link with placeholders must use the
    app's own URL scheme, not ``http`` or ``https``. It opens once on each device the agent starts.
    If the app also gates sign-in on a launch variable such as ``REVYL_AUTH_BYPASS_ENABLED``, set
    it in ``environment`` too.
    ``version`` is a label unique within the app; it defaults to the short head commit plus a UTC
    timestamp.

    ``url`` is a Web deployment to prove in a cloud browser, with ``app_id`` its Revyl Web app. It
    must be public HTTPS on port 443, and any HTTP status of 400 or above fails the page. URL builds
    take no headers or basic auth, so the page must load signed in or without sign-in. It must stay
    up from the call until the run settles, which can take minutes; with ``wait=False``, keeping it
    up is the caller's job. ``environment``, ``auth_bypass``, and ``version`` apply only to
    ``build``.
    """

    app_id: str
    build: str | os.PathLike[str] | None = None
    url: str | None = None
    environment: Mapping[str, ProofEnvironmentValue] | None = field(default=None, repr=False)
    version: str | None = None
    auth_bypass: ProofAuthBypass | None = field(default=None, repr=False)


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
    """Revyl's ``display_status_label`` as reported: the label the pull request comment shows, built
    from the run's write-up and findings, such as ``Ready``, ``Ready with issues``, or ``Partial
    coverage``. It can differ from what ``verdict`` suggests."""
    report_url: str | None
    """The pull request comment with the report, or for a ``change``, the run's report in Revyl."""
    review_url: str | None
    """The pull request, or for a ``change``, its ``source_url``."""
    created_at: str | None
    settled_at: str | None
    """Set once the run is over."""
    summary_markdown: str | None
    """The proof write-up in Markdown, once the run settles and the agent published one."""
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
    """The ``label`` of the first run whose verdict decided ``verdict``, as Revyl reported it."""
    report_url: str | None
    """The ``report_url`` of the first run that has one."""
    pull_request: PullRequestContext | None
    """The pull request proved, without a ``change``."""
    change: ProofChange | None = None
    """The change proved, without its ``diff`` and ``description``."""


def proof(
    build: str | os.PathLike[str] | None = None,
    app_id: str | None = None,
    *,
    url: str | None = None,
    environment: Mapping[str, ProofEnvironmentValue] | None = None,
    auth_bypass: ProofAuthBypass | None = None,
    version: str | None = None,
    targets: Sequence[ProofTarget] | None = None,
    change: ProofChange | None = None,
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
    ``url`` with ``app_id`` (and, for ``build``, ``environment``, ``auth_bypass``, and
    ``version``); see ``ProofTarget``. Starting the same targets (the same builds and settings)
    again at the same head returns the earlier runs in whatever state they are in; to prove
    again, upload a new build or push a new commit. ``harness`` is the agent that runs the proof;
    ``revyl`` is the only one.

    ``change`` proves a ``ProofChange`` instead of a GitHub pull request, for a source host Revyl
    can't read, such as GitLab. Revyl posts nothing anywhere: read each run's ``report_url`` (a
    Revyl page for members of the organization) and ``summary_markdown``, and post the summary
    where your reviewers read it. ``change_from_git()`` builds one from a checkout and CI.

    With ``wait`` (the default) it polls until every run settles, for at most ``timeout`` seconds;
    the runs keep going on Revyl after a timeout. Interrupting the wait cancels the runs that
    haven't settled. Needs a pull request on GitHub Actions, unless ``change`` gives the change
    itself.

    Revyl reports on the pull request in a comment but adds no check run, so the result is the CI
    gate: fail the job unless ``verdict`` is ``passed``.
    """
    chosen = _proof_targets(build, app_id, url, environment, auth_bypass, version, targets)
    if harness != "revyl":
        raise VerifyError("INVALID_ARGUMENT", "harness must be 'revyl'.")
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
    chosen_change = None if change is None else _valid_change(change)
    pull_request = _detect_pull_request() if chosen_change is None else None
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
            ProofRunTarget(target.app_id, built.build_id, target.environment, target.auth_bypass)
            for target, built in zip(chosen, builds)
        ],
        pull_request=pull_request,
        change=chosen_change,
        harness=harness,
        guidance=focus,
    )
    current = [
        _with_identity(get_proof_run(client, state.id), state) if is_settled(state) else state
        for state in started
    ]
    states = _wait_for_all(client, current, timeout) if wait else current
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
            summary_markdown=state.summary_markdown,
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
        change=None if chosen_change is None else replace(chosen_change, description=None, diff=""),
    )


def _proof_targets(
    build: str | os.PathLike[str] | None,
    app_id: str | None,
    url: str | None,
    environment: Mapping[str, ProofEnvironmentValue] | None,
    auth_bypass: ProofAuthBypass | None,
    version: str | None,
    targets: Sequence[ProofTarget] | None,
) -> list[ProofTarget]:
    inline = any(
        value is not None for value in (build, app_id, url, environment, auth_bypass, version)
    )
    if targets is not None and inline:
        raise VerifyError(
            "INVALID_ARGUMENT", "Pass targets, or a single build or url with app_id, not both."
        )
    if targets is None:
        chosen = (
            [ProofTarget(app_id or "", build, url, environment, version, auth_bypass)]
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
        if target.url is not None and target.auth_bypass is not None:
            raise VerifyError(
                "INVALID_ARGUMENT",
                "auth_bypass applies only to mobile builds; a URL target takes no deep link.",
            )
        if not isinstance(target.app_id, str) or not UUID_PATTERN.fullmatch(target.app_id):
            raise VerifyError("INVALID_ARGUMENT", "app_id must be a Revyl app id (a UUID).")
        if target.url is not None:
            validate_web_url(target.url)
        environment = _valid_environment(target.environment)
        valid.append(
            replace(
                target,
                environment=environment,
                auth_bypass=_valid_auth_bypass(target.auth_bypass, environment),
            )
        )
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
        return [state for state in states if not is_settled(state)]

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
                if not is_settled(state):
                    states[index] = _with_identity(get_proof_run(client, state.id), state)
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


def _with_identity(state: ProofRunState, known: ProofRunState) -> ProofRunState:
    return replace(
        state, app_id=known.app_id or state.app_id, platform=known.platform or state.platform
    )


def _detect_pull_request() -> PullRequestContext:
    identity = detect_scm_identity()
    if identity is None or identity.ci_system != "github-actions" or identity.pr is None:
        raise VerifyError(
            "PR_CONTEXT_MISSING",
            "proof() needs a pull_request event on GitHub Actions to know the repository, "
            "pull request, and head commit. Elsewhere, prove the change itself with change (see "
            "change_from_git()).",
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
        if not isinstance(reference, str):
            raise VerifyError(
                "INVALID_ARGUMENT",
                f'environment variable {name} must be a string or {{"secret_ref": "{name}"}}.',
            )
        if reference != name:
            raise VerifyError(
                "INVALID_ARGUMENT",
                f"environment variable {name} must reference the launch variable of the same "
                f'name: {{"secret_ref": "{name}"}}.',
            )
        valid[name] = SecretRef(secret_ref=reference)
    return valid or None


def _valid_auth_bypass(
    auth_bypass: ProofAuthBypass | None, environment: Mapping[str, ProofEnvironmentValue] | None
) -> ProofAuthBypass | None:
    if auth_bypass is None:
        return None
    deep_link = auth_bypass.get("deep_link") if isinstance(auth_bypass, Mapping) else None
    if not isinstance(deep_link, str) or not deep_link.strip():
        raise VerifyError(
            "INVALID_ARGUMENT",
            'auth_bypass must be {"deep_link": str} with a non-empty deep link.',
        )
    placeholders = _DEEP_LINK_PLACEHOLDER.findall(deep_link)
    if placeholders and _WEB_SCHEME.match(deep_link):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "auth_bypass.deep_link has placeholders, so it must use the app's own URL scheme, not "
            "http or https.",
        )
    missing = [name for name in dict.fromkeys(placeholders) if name not in (environment or {})]
    if missing:
        names = ", ".join("${" + name + "}" for name in missing)
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"auth_bypass.deep_link uses {names}, which the target's environment doesn't "
            "set. Placeholders resolve only from the target's environment.",
        )
    return ProofAuthBypass(deep_link=deep_link)


def _valid_change(change: ProofChange) -> ProofChange:
    if not isinstance(change, ProofChange):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "change must be a ProofChange with review_key, head_sha, title, and diff.",
        )
    if not isinstance(change.review_key, str) or not _REVIEW_KEY.fullmatch(change.review_key):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "change.review_key must be 1 to 200 letters, digits, and ._~:/!#@+=-, starting with a "
            "letter or digit, such as gitlab:group/app!17.",
        )
    head_sha = change.head_sha.strip().lower() if isinstance(change.head_sha, str) else ""
    if not _COMMIT.fullmatch(head_sha):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "change.head_sha must be a full commit SHA (40 or 64 hexadecimal characters).",
        )
    base_sha = change.base_sha.strip().lower() if isinstance(change.base_sha, str) else None
    if change.base_sha is not None and (base_sha is None or not _COMMIT.fullmatch(base_sha)):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "change.base_sha must be a full commit SHA (40 or 64 hexadecimal characters).",
        )
    if not isinstance(change.title, str) or not change.title.strip() or len(change.title) > 512:
        raise VerifyError(
            "INVALID_ARGUMENT", "change.title is required and takes at most 512 characters."
        )
    if change.description is not None and (
        not isinstance(change.description, str) or len(change.description) > 65_536
    ):
        raise VerifyError("INVALID_ARGUMENT", "change.description takes at most 65,536 characters.")
    if not isinstance(change.diff, str) or not change.diff.strip():
        raise VerifyError(
            "INVALID_ARGUMENT",
            "change.diff must be a non-empty unified diff (git diff base...head).",
        )
    if len(change.diff.encode("utf-8", "surrogatepass")) > _MAX_DIFF_BYTES:
        raise VerifyError("INVALID_ARGUMENT", "change.diff is over 5 MiB, the most a proof takes.")
    if change.source_url is not None and not _https_url(change.source_url):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "change.source_url must be an https URL of at most 2,048 characters.",
        )
    return replace(change, head_sha=head_sha, base_sha=base_sha, title=change.title.strip())


def _https_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 2048:
        return False
    try:
        parts = urlsplit(value)
        return parts.scheme.lower() == "https" and bool(parts.hostname)
    except ValueError:
        return False


__all__ = ["ProofRun", "ProofTarget", "ProofTargetRun", "proof"]
