from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, TypeAlias, TypedDict
from urllib.parse import quote

from ._transport import Client, Deadline, Json, Response, VerifyError, http_error, obj

# Built against Revyl's provisional proof-runs contract (REVL-18697), which is not declared
# yet. This module is the only place that knows the paths and wire shapes, so aligning to the
# declared contract changes nothing outside it.

ProofHarness = Literal["revyl", "cursor", "capy", "devin"]


class SecretRef(TypedDict):
    """Names an organization launch variable that holds a secret."""

    secret_ref: str


ProofEnvironmentValue: TypeAlias = "str | SecretRef"


@dataclass(frozen=True)
class PullRequestContext:
    provider: Literal["github"]
    repository: str
    number: int
    head_sha: str
    base_sha: str | None = None


@dataclass(frozen=True)
class ProofRunState:
    id: str
    status: str
    verdict: str | None = None
    label: str | None = None
    report_url: str | None = None
    review_url: str | None = None
    created_at: str | None = None
    settled_at: str | None = None


_PROOF_RUNS_PATH = "/api/v1/proof-runs"
_CREATE_TIMEOUT = 60.0
_GET_TIMEOUT = 30.0
_CANCEL_TIMEOUT = 15.0
_GITHUB_APP_FIX = (
    "Proof of Changes needs the Revyl GitHub App on the repository: run `revyl github connect`, "
    "or grant the repository to the Revyl GitHub App."
)
_REFUSALS = {
    "config_managed_review": "CONFIG_MANAGED_REVIEW",
    "github_app_not_connected": "GITHUB_APP_NOT_CONNECTED",
    "github_app_not_installed": "GITHUB_APP_NOT_CONNECTED",
    "github_repository_not_granted": "GITHUB_APP_NOT_CONNECTED",
    "pull_request_closed": "PR_CLOSED",
    "head_sha_not_current": "HEAD_NOT_CURRENT",
    "app_not_found": "NOT_FOUND",
    "build_not_found": "NOT_FOUND",
    "platform_mismatch": "PLATFORM_MISMATCH",
}


def create_proof_run(
    client: Client,
    *,
    app_id: str,
    build_id: str,
    pull_request: PullRequestContext,
    harness: ProofHarness,
    guidance: str | None,
    environment: Mapping[str, ProofEnvironmentValue] | None,
) -> ProofRunState:
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
    if environment is not None:
        settings["environment"] = {
            name: {"value": value}
            if isinstance(value, str)
            else {"secret_ref": value["secret_ref"]}
            for name, value in environment.items()
        }
    response = client.request(
        "POST",
        _PROOF_RUNS_PATH,
        {"app_id": app_id, "build_id": build_id, "scm": scm, "settings": settings},
        deadline=Deadline(_CREATE_TIMEOUT),
        timeout=_CREATE_TIMEOUT,
    )
    return _state(response, "POST", _PROOF_RUNS_PATH)


def get_proof_run(client: Client, run_id: str) -> ProofRunState:
    path = f"{_PROOF_RUNS_PATH}/{quote(run_id, safe='')}"
    response = client.request(
        "GET", path, deadline=Deadline(_GET_TIMEOUT * 3 + 2), timeout=_GET_TIMEOUT, retry=True
    )
    return _state(response, "GET", path, run_id)


def cancel_proof_run(client: Client, run_id: str) -> None:
    path = f"{_PROOF_RUNS_PATH}/{quote(run_id, safe='')}/cancel"
    response = client.request(
        "POST", path, deadline=Deadline(_CANCEL_TIMEOUT), timeout=_CANCEL_TIMEOUT, retry=True
    )
    if response.status != 409 and not 200 <= response.status < 300:
        raise http_error(response)


def _state(
    response: Response, method: str, path: str, known_id: str | None = None
) -> ProofRunState:
    if not 200 <= response.status < 300:
        raise _proof_run_error(response, method, path)
    wire = obj(response.json())

    def text(key: str) -> str | None:
        value = wire.get(key)
        return value if isinstance(value, str) and value else None

    run_id = text("proof_run_id") or known_id
    status = wire.get("status")
    if run_id is None or not isinstance(status, str):
        raise VerifyError(
            "API_ERROR",
            f"Revyl returned a proof run to {method} {path} without an id and status.",
            http_status=response.status,
        )
    return ProofRunState(
        id=run_id,
        status=status,
        verdict=text("verdict"),
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
    code, run_id = _refusal(response)
    mapped = _REFUSALS.get(code) if code else None
    message = f"Revyl request {method} {path} failed (HTTP {response.status})"
    if mapped == "GITHUB_APP_NOT_CONNECTED":
        message = f"{message}: {code}. {_GITHUB_APP_FIX}"
    elif mapped == "CONFIG_MANAGED_REVIEW":
        message = (
            f"{message}: {code}. The repository's .revyl/config.yaml already runs Proof of Changes "
            "for this head, so proof() can't start another run."
        )
    elif mapped:
        message = f"{message}: {code}."
    elif response.status == 409 and run_id:
        mapped = "PROOF_RUN_CONFLICT"
        message = f"{message}. Proof run {run_id} already covers this head with different settings."
    elif response.status == 404 and method == "GET":
        mapped = "NOT_FOUND"
        message = f"{message}."
    else:
        return error
    return VerifyError(
        mapped, message, reason=error.reason, http_status=response.status, proof_run_id=run_id
    )


def _refusal(response: Response) -> tuple[str | None, str | None]:
    try:
        raw = obj(response.json())
    except VerifyError:
        return None, None
    detail = raw.get("detail")
    nested = detail if isinstance(detail, dict) else {}

    def first(*values: Json) -> str | None:
        return next((value for value in values if isinstance(value, str) and value), None)

    return (
        first(raw.get("error"), raw.get("code"), nested.get("error"), nested.get("code"), detail),
        first(raw.get("proof_run_id"), nested.get("proof_run_id")),
    )
