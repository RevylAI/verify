from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, TypeAlias, TypedDict
from urllib.parse import quote

from ._transport import Client, Deadline, Json, Response, VerifyError, http_error, obj

# Revyl's Proof API, as declared in revyl-cli/docs/proof-api.md. This module is the only place
# that knows its paths, wire shapes, and refusal codes.

ProofHarness = Literal["revyl"]


class SecretRef(TypedDict):
    """Uses the organization launch variable of the same name, which holds a secret."""

    secret_ref: str


ProofEnvironmentValue: TypeAlias = "str | SecretRef"


class ProofAuthBypass(TypedDict):
    """A deep link Revyl opens after the app launches; see ``ProofTarget.auth_bypass``."""

    deep_link: str


@dataclass(frozen=True)
class PullRequestContext:
    provider: Literal["github"]
    repository: str
    number: int
    head_sha: str
    base_sha: str | None = None


@dataclass(frozen=True)
class ProofRunTarget:
    app_id: str
    build_id: str
    environment: Mapping[str, ProofEnvironmentValue] | None = field(default=None, repr=False)
    auth_bypass: ProofAuthBypass | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ProofRunState:
    id: str
    status: str
    app_id: str | None = None
    """Known from the create response; a GET may not repeat it."""
    platform: str | None = None
    verdict: str | None = None
    label: str | None = None
    report_url: str | None = None
    review_url: str | None = None
    created_at: str | None = None
    settled_at: str | None = None


_PROOF_RUNS_PATH = "/api/v1/proof-runs"
_CREATE_TIMEOUT = 60.0
_CREATE_RETRY_DELAYS = (0.5, 1.0, 2.0)
_GET_TIMEOUT = 30.0
_CANCEL_TIMEOUT = 15.0
_VERDICT_STATUSES = frozenset({"passed", "failed", "inconclusive"})
_TERMINAL_STATUSES = _VERDICT_STATUSES | {"cancelled", "superseded"}
_REFUSALS: dict[str, tuple[str, str | None]] = {
    "principal_not_allowed": (
        "AUTH_REJECTED",
        "The Proof API takes a Revyl member API key or a Revyl CI runner job key.",
    ),
    "access_denied": (
        "AUTH_REJECTED",
        "Starting proofs needs the Member role or higher; a Viewer's key is refused.",
    ),
    "environment_secret_ref_not_allowed": (
        "SECRET_REF_NOT_ALLOWED",
        "Only a member API key can reference a secret launch variable; a CI runner job key "
        "cannot. Use a member key, or pass the variable as a plain non-secret value.",
    ),
    "repository_not_accessible": (
        "GITHUB_APP_NOT_CONNECTED",
        "Grant the repository to the Revyl GitHub App, then run `revyl github status`.",
    ),
    "github_app_not_connected": (
        "GITHUB_APP_NOT_CONNECTED",
        "Run `revyl github connect`, or grant the repository to the Revyl GitHub App.",
    ),
    "pull_request_not_found": ("NOT_FOUND", None),
    "app_not_found": ("NOT_FOUND", None),
    "build_not_found": ("NOT_FOUND", None),
    "proof_run_not_found": ("NOT_FOUND", None),
    "pull_request_not_open": ("PR_CLOSED", None),
    "head_sha_mismatch": ("HEAD_NOT_CURRENT", "The pull request moved on; prove its current head."),
    "base_sha_mismatch": (
        "HEAD_NOT_CURRENT",
        "The pull request's base moved on; prove it again from a fresh run of the job.",
    ),
    "config_managed_review": (
        "CONFIG_MANAGED_REVIEW",
        "The repository's own Revyl config already proves this head.",
    ),
    "proof_settings_conflict": (
        "PROOF_RUN_CONFLICT",
        "Proofs with other apps, settings, environment, or auth bypass already cover this head; "
        "upload a new build or push a new commit to prove again.",
    ),
    "untrusted_pull_request_head": (
        "UNTRUSTED_PR_HEAD",
        "Pull requests from forks are not proved.",
    ),
    "build_not_supported": ("BUILD_REJECTED", None),
    "build_scm_mismatch": (
        "BUILD_REJECTED",
        "The build was uploaded for another repository, pull request, or commit.",
    ),
    "unsupported_platform": ("BUILD_REJECTED", None),
    "duplicate_target_platform": ("INVALID_ARGUMENT", None),
    "web_build_unreachable": (
        "PREVIEW_UNREACHABLE",
        "The Web URL must be reachable from the request until its run settles.",
    ),
    "environment_not_supported_on_web": ("INVALID_ARGUMENT", None),
    "environment_secret_ref_not_found": (
        "INVALID_ARGUMENT",
        "Create the organization launch variable first.",
    ),
    "environment_secret_ref_alias_unsupported": ("INVALID_ARGUMENT", None),
    "environment_secret_value_refused": (
        "INVALID_ARGUMENT",
        "Reference the secret launch variable by name instead of sending its value.",
    ),
    "harness_not_supported": ("INVALID_ARGUMENT", None),
    "invalid_request": ("INVALID_ARGUMENT", None),
    "proof_run_limit_reached": (
        "PROOF_RUN_LIMIT",
        "Too many Proof API runs are queued or running for the organization; try again once some "
        "settle.",
    ),
    "provider_unavailable": ("PROVIDER_UNAVAILABLE", "Revyl could not reach GitHub."),
}


def create_proof_runs(
    client: Client,
    *,
    targets: list[ProofRunTarget],
    pull_request: PullRequestContext,
    harness: ProofHarness,
    guidance: str | None,
) -> list[ProofRunState]:
    """Starts one run per target, retrying 5xx and network errors like an upload does: a repeat
    of the same request returns the existing runs, so it is safe to send again."""
    wire_targets: list[Json] = []
    for target in targets:
        wire: dict[str, Json] = {"app_id": target.app_id, "build_id": target.build_id}
        if target.environment is not None:
            wire["environment"] = {
                name: {"value": value}
                if isinstance(value, str)
                else {"secret_ref": value["secret_ref"]}
                for name, value in target.environment.items()
            }
        if target.auth_bypass is not None:
            wire["auth_bypass"] = {"deep_link": target.auth_bypass["deep_link"]}
        wire_targets.append(wire)
    scm: dict[str, Json] = {
        "provider": pull_request.provider,
        "repo": pull_request.repository,
        "pr_number": pull_request.number,
        "head_sha": pull_request.head_sha,
    }
    if pull_request.base_sha:
        scm["base_sha"] = pull_request.base_sha
    settings: dict[str, Json] = {"harness": harness}
    if guidance is not None:
        settings["guidance"] = guidance
    response = _send_create(client, {"targets": wire_targets, "scm": scm, "settings": settings})
    if not 200 <= response.status < 300:
        raise _proof_run_error(response, "POST", _PROOF_RUNS_PATH)
    runs = obj(response.json()).get("runs")
    if not isinstance(runs, list) or len(runs) != len(targets):
        raise VerifyError(
            "API_ERROR",
            f"Revyl answered POST {_PROOF_RUNS_PATH} without one run per target.",
            http_status=response.status,
        )
    return [_wire_state(run, response.status, f"POST {_PROOF_RUNS_PATH}") for run in runs]


def _send_create(client: Client, body: Json) -> Response:
    for attempt in range(len(_CREATE_RETRY_DELAYS) + 1):
        last = attempt == len(_CREATE_RETRY_DELAYS)
        try:
            response = client.request(
                "POST",
                _PROOF_RUNS_PATH,
                body,
                deadline=Deadline(_CREATE_TIMEOUT),
                timeout=_CREATE_TIMEOUT,
            )
        except VerifyError as error:
            if last or error.code not in ("API_ERROR", "TIMEOUT"):
                raise
        else:
            if last or response.status < 500:
                return response
        time.sleep(_CREATE_RETRY_DELAYS[attempt])
    raise AssertionError("unreachable")


def get_proof_run(client: Client, run_id: str) -> ProofRunState:
    path = f"{_PROOF_RUNS_PATH}/{quote(run_id, safe='')}"
    response = client.request(
        "GET", path, deadline=Deadline(_GET_TIMEOUT * 3 + 2), timeout=_GET_TIMEOUT, retry=True
    )
    return _state(response, "GET", path, run_id)


def cancel_proof_run(client: Client, run_id: str) -> None:
    """Stops the run's agent and releases its device; cancelling a settled run changes nothing."""
    path = f"{_PROOF_RUNS_PATH}/{quote(run_id, safe='')}/cancel"
    response = client.request(
        "POST", path, deadline=Deadline(_CANCEL_TIMEOUT), timeout=_CANCEL_TIMEOUT, retry=True
    )
    if not 200 <= response.status < 300:
        raise _proof_run_error(response, "POST", path)


def is_settled(state: ProofRunState) -> bool:
    """Whether the run is over: it has settled, or its status is one Revyl never leaves."""
    return state.settled_at is not None or state.status in _TERMINAL_STATUSES


def _state(response: Response, method: str, path: str, known_id: str) -> ProofRunState:
    if not 200 <= response.status < 300:
        raise _proof_run_error(response, method, path)
    return _wire_state(response.json(), response.status, f"{method} {path}", known_id)


def _wire_state(
    value: Json, http_status: int, what: str, known_id: str | None = None
) -> ProofRunState:
    wire = value if isinstance(value, dict) else {}

    def text(key: str) -> str | None:
        value = wire.get(key)
        return value if isinstance(value, str) and value else None

    run_id = text("proof_run_id") or known_id
    status = wire.get("status")
    if run_id is None or not isinstance(status, str):
        raise VerifyError(
            "API_ERROR",
            f"Revyl returned a proof run to {what} without an id and status.",
            http_status=http_status,
        )
    return ProofRunState(
        id=run_id,
        status=status,
        app_id=text("app_id"),
        platform=text("platform"),
        verdict=text("verdict") or (status if status in _VERDICT_STATUSES else None),
        label=text("display_status_label"),
        report_url=text("report_url"),
        review_url=text("review_url"),
        created_at=text("created_at"),
        settled_at=text("settled_at"),
    )


def _proof_run_error(response: Response, method: str, path: str) -> VerifyError:
    error = http_error(response)
    if error.code == "EDGE_BLOCKED":
        return error
    code, said, run_ids = _refusal(response)
    if code is None:
        return error
    known = _REFUSALS.get(code)
    if known is None:
        return VerifyError(
            error.code,
            f"{error.message} ({code})",
            reason=error.reason,
            http_status=response.status,
            proof_run_ids=run_ids,
        )
    mapped, hint = known
    message = (
        f"Revyl refused the proof (HTTP {response.status}, {code}){f': {said}' if said else ''}."
    )
    return VerifyError(
        mapped,
        f"{message} {hint}" if hint else message,
        http_status=response.status,
        proof_run_ids=run_ids,
    )


def _refusal(response: Response) -> tuple[str | None, str | None, list[str] | None]:
    try:
        raw = obj(response.json())
    except VerifyError:
        return None, None, None
    code, detail, ids = raw.get("code"), raw.get("detail"), raw.get("existing_proof_run_ids")
    run_ids = (
        [item for item in ids if isinstance(item, str) and item] if isinstance(ids, list) else []
    )
    return (
        code if isinstance(code, str) and code else None,
        detail[:500] if isinstance(detail, str) and detail else None,
        run_ids or None,
    )
