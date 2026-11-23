from __future__ import annotations

import os
import posixpath
import re
import stat
import weakref
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, cast

import yaml

from ._git_branch import detect_git_branch
from ._models import UUID_PATTERN, Platform
from ._transport import (
    Cancellation,
    Client,
    Deadline,
    Json,
    RefusalReason,
    Response,
    SessionProfileOutcome,
    VerifyError,
)

_NONE = "none"
_PROFILE_NAME = re.compile(r"[a-z0-9-]{1,64}")
_SCRIPT_EXTENSIONS = (".js", ".py", ".sh", ".ts")
_SCRIPT_MAX_BYTES = 64 * 1024
_PROFILE_PLATFORMS = ("web", "ios", "android", "mac")
_NONE_HINT = 'profile="none"'
REPOSITORY_RETRY_DELAYS = (1.0, 2.0)


@dataclass(frozen=True)
class SessionProfilePlan:
    name: str | None
    config_path: str | None
    fields: dict[str, Json]
    implicit: bool = False
    uses_default_instruction: bool = False


@dataclass(frozen=True)
class ReportedSessionProfile:
    name: str
    status: str
    outcome: str | None = None
    failure_reason: str | None = None
    missing_git_branch_name: str | None = None


def supports_session_profile_defaults(client: Client, cancellation: Cancellation | None) -> bool:
    try:
        response = client.json(
            "GET",
            "/api/v1/backend-capabilities?contract=session_profile_starts",
            deadline=Deadline(30, cancellation),
        )
    except VerifyError:
        return False
    capabilities = response.get("capabilities")
    return isinstance(capabilities, list) and "device_session_session_profile_picks" in capabilities


class _ConfigLoader(yaml.SafeLoader):
    def construct_mapping(self, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
        seen: set[Any] = set()
        for key_node, _ in node.value:
            if key_node.tag == "tag:yaml.org,2002:merge":
                continue
            key = self.construct_object(key_node, deep=deep)
            try:
                duplicate = key in seen
                seen.add(key)
            except TypeError:
                continue
            if duplicate:
                raise yaml.constructor.ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    "found a duplicate key",
                    key_node.start_mark,
                )
        return super().construct_mapping(node, deep)


_BOOL_TAG = "tag:yaml.org,2002:bool"
_ConfigLoader.yaml_implicit_resolvers = {
    first: [resolver for resolver in resolvers if resolver[0] != _BOOL_TAG]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_ConfigLoader.add_implicit_resolver(
    _BOOL_TAG, re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF")
)


def plan_session_profile(
    profile: object, platform: Platform, cwd: str, session_profile_project_id: str | None = None
) -> SessionProfilePlan | None:
    if session_profile_project_id is not None:
        if not isinstance(session_profile_project_id, str) or not UUID_PATTERN.fullmatch(
            session_profile_project_id
        ):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "open(): session_profile_project_id must be a Revyl project UUID.",
            )
        if not isinstance(profile, str) or profile == _NONE or not _PROFILE_NAME.fullmatch(profile):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "open(): session_profile_project_id requires profile to name a session profile "
                "(1-64 lowercase letters, digits or hyphens), not 'none'.",
            )
    if profile is not None and (
        not isinstance(profile, str) or (profile != _NONE and not _PROFILE_NAME.fullmatch(profile))
    ):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "open(): profile must be a session profile name from session.profiles in "
            ".revyl/config.yaml (1-64 lowercase letters, digits or hyphens), or 'none'.",
        )
    if profile == _NONE:
        return None
    if platform not in _PROFILE_PLATFORMS:
        if profile is None:
            return None
        raise VerifyError(
            "NOT_AVAILABLE_ON_PLATFORM",
            "open(): session profiles run on web, iOS, Android and Mac sessions, "
            f"not {platform}. Leave out profile.",
        )
    if session_profile_project_id is not None:
        return SessionProfilePlan(
            name=cast(str, profile),
            config_path=None,
            fields={
                "session_profile": {"instruction": "named", "name": cast(str, profile)},
                "session_profile_source": {"project_id": session_profile_project_id},
            },
        )
    config_path = _find_config(cwd)
    if config_path is None:
        if profile is None:
            return None
        raise VerifyError(
            "CONFIG_NOT_FOUND",
            f"open(): profile '{profile}' needs .revyl/config.yaml, but none was found in "
            f"{os.path.abspath(cwd)} or any folder above it. Run open() from your app's "
            f"checkout, or pass {_NONE_HINT}.",
        )
    project, session = _read_config(config_path)
    name = profile
    if name is None:
        fallback = session.get("default_profile")
        if fallback is None or fallback == _NONE:
            return None
        if not isinstance(fallback, str):
            raise VerifyError(
                "CONFIG_INVALID",
                f"{config_path}: session.default_profile must be a profile name, or none.",
            )
        name = fallback
    project_id = project.get("id")
    if not isinstance(project_id, str) or not UUID_PATTERN.fullmatch(project_id):
        raise VerifyError(
            "CONFIG_INVALID",
            f"{config_path}: project.id must be your Revyl project's UUID, which session "
            f'profile "{name}" needs. Run open() from your app\'s checkout, whose '
            f".revyl/config.yaml has project.id, or pass {_NONE_HINT}.",
        )
    profiles = session.get("profiles")
    if profiles is not None and not isinstance(profiles, dict):
        raise VerifyError(
            "CONFIG_INVALID", f"{config_path}: session.profiles must be a mapping of profile names."
        )
    entries = {str(key): value for key, value in profiles.items()} if profiles else {}
    if name not in entries:
        defined = sorted(entries)
        raise VerifyError(
            "CONFIG_INVALID",
            f'{config_path}: session.profiles doesn\'t define "{name}". Defined: '
            f"{', '.join(defined) if defined else 'none'}. Pass one of those, or {_NONE_HINT}.",
        )
    entry = entries[name]
    script = entry.get("script") if isinstance(entry, dict) else None
    if not isinstance(entry, dict) or not isinstance(script, str) or not script.strip():
        raise VerifyError(
            "CONFIG_INVALID",
            f"{config_path}: session.profiles.{name}.script must be a non-empty string.",
        )
    requires_checkout = entry.get("requires_repository_checkout")
    if requires_checkout is not None and not isinstance(requires_checkout, bool):
        raise VerifyError(
            "CONFIG_INVALID",
            f"{config_path}: session.profiles.{name}.requires_repository_checkout must be "
            "true or false.",
        )
    project_root = os.path.dirname(os.path.dirname(config_path))
    files = _checkout_files(name, script, requires_checkout is True, project_root, config_path)
    source: dict[str, Json] = {"project_id": project_id}
    branch = detect_git_branch(project_root)
    if branch:
        source["git_branch_name"] = branch
    return SessionProfilePlan(
        name,
        config_path,
        {
            "session_profile": {"instruction": "named", "name": name},
            "session_profile_source": source,
            "session_profile_files": files,
        },
        implicit=profile is None,
    )


def _find_config(cwd: str) -> str | None:
    current = os.path.abspath(cwd)
    while True:
        candidate = os.path.join(current, ".revyl", "config.yaml")
        if os.path.exists(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _read_config(config_path: str) -> tuple[dict[Any, Any], dict[Any, Any]]:
    try:
        with open(config_path, "rb") as stream:
            text = stream.read().decode("utf-8", errors="replace")
        parsed = yaml.load(text, Loader=_ConfigLoader)
    except (OSError, yaml.YAMLError) as error:
        mark = getattr(error, "problem_mark", None) or getattr(error, "context_mark", None)
        line = f" line {mark.line + 1}" if mark is not None else ""
        raise VerifyError("CONFIG_INVALID", f"{config_path}{line}: is not valid YAML.") from None
    if not isinstance(parsed, dict):
        raise VerifyError("CONFIG_INVALID", f"{config_path}: must be a YAML mapping.")
    project, session = parsed.get("project"), parsed.get("session")
    if project is not None and not isinstance(project, dict):
        raise VerifyError("CONFIG_INVALID", f"{config_path}: project must be a mapping.")
    if session is not None and not isinstance(session, dict):
        raise VerifyError("CONFIG_INVALID", f"{config_path}: session must be a mapping.")
    return project or {}, session or {}


def _checkout_files(
    name: str, script: str, requires_checkout: bool, project_root: str, config_path: str
) -> dict[str, Json]:
    files: dict[str, Json] = {"script": script}
    if requires_checkout:
        files["requires_repository_checkout"] = True

    def unavailable(reason: str) -> VerifyError:
        return VerifyError(
            "SESSION_PROFILE_FAILED",
            f'session profile "{name}": {reason}. Fix session.profiles.{name}.script in '
            f"{config_path}, or pass {_NONE_HINT}.",
            outcome="script_unavailable",
            failure_reason=reason,
        )

    if "/" in script:
        file_path = _resolve_repository_path(project_root, script, unavailable)
        relative_path = posixpath.normpath(script)
    else:
        if script.strip() != script or "\\" in script:
            return files
        found = _find_repository_script(
            os.path.join(os.path.dirname(config_path), "scripts"), script, unavailable
        )
        if found is None:
            return files
        file_path = found
        relative_path = ".revyl/scripts/" + os.path.basename(found)
    try:
        with open(file_path, "rb") as stream:
            content = stream.read()
    except OSError:
        raise unavailable(f"could not read script {relative_path}") from None
    if len(content) > _SCRIPT_MAX_BYTES:
        raise unavailable(
            f"script {relative_path} is {len(content)} bytes, over the {_SCRIPT_MAX_BYTES} "
            "Revyl takes"
        )
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        raise unavailable(f"script {relative_path} isn't UTF-8 text") from None
    files["script_file"] = {"project_relative_path": relative_path, "content": text}
    return files


def _resolve_repository_path(
    project_root: str, ref: str, unavailable: Callable[[str], VerifyError]
) -> str:
    try:
        real_root = os.path.realpath(project_root, strict=True)
    except (OSError, ValueError):
        raise unavailable(f"could not resolve the project root for script {ref}") from None
    repository_root = _repository_root_of(real_root)
    try:
        real_script = os.path.realpath(os.path.join(real_root, *ref.split("/")), strict=True)
    except (OSError, ValueError):
        raise unavailable(f"script {ref} was not found in the repository") from None
    if real_script != repository_root and not real_script.startswith(repository_root + os.sep):
        raise unavailable(f"script {ref} resolves outside the repository")
    try:
        info = os.stat(real_script)
    except (OSError, ValueError):
        raise unavailable(f"script {ref} could not be read") from None
    if not stat.S_ISREG(info.st_mode):
        raise unavailable(f"script {ref} is not a regular file")
    if os.name != "nt" and info.st_mode & 0o111 == 0:
        raise unavailable(f"script {ref} is not executable (chmod +x it)")
    return real_script


def _repository_root_of(project_root: str) -> str:
    current = project_root
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return project_root
        current = parent


def _find_repository_script(
    scripts_dir: str, name: str, unavailable: Callable[[str], VerifyError]
) -> str | None:
    matches: list[str] = []
    for extension in _SCRIPT_EXTENSIONS:
        path = os.path.join(scripts_dir, name + extension)
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            raise unavailable(
                f".revyl/scripts/{name}{extension} is not a readable regular file"
            ) from None
        if not stat.S_ISREG(info.st_mode):
            raise unavailable(f".revyl/scripts/{name}{extension} is not a readable regular file")
        matches.append(path)
    if len(matches) > 1:
        raise unavailable(f".revyl/scripts holds more than one file named {name}; keep one")
    return matches[0] if matches else None


def reported_session_profile(body: object) -> ReportedSessionProfile | None:
    if not isinstance(body, dict) or not isinstance(body.get("session_profile"), dict):
        return None
    profile = cast(dict[str, object], body["session_profile"])

    def text(key: str) -> str | None:
        value = profile.get(key)
        return value if isinstance(value, str) and value else None

    return ReportedSessionProfile(
        text("name") or "",
        text("status") or "",
        text("outcome"),
        text("failure_reason"),
        text("missing_git_branch_name"),
    )


def missing_branch_notice(
    profile: ReportedSessionProfile | None, plan: SessionProfilePlan
) -> str | None:
    if profile is None or not profile.missing_git_branch_name:
        return None
    return (
        f'Git has no branch "{profile.missing_git_branch_name}", so session profile '
        f"{profile.name or plan.name} reads the repository's default branch instead"
    )


_OUTCOME_FIXES = {
    "script_failed": "Its script exited with an error. Run the script yourself from the project "
    "root to see its output; Revyl doesn't show the output because setup scripts often print "
    "secrets.",
    "script_timed_out": "Its script didn't finish within Revyl's 300-second limit. Make it "
    "finish sooner.",
    "script_unavailable": "Revyl could not find its script: commit it, or check "
    "session.profiles in .revyl/config.yaml. A script name with no .revyl/scripts file must be "
    "a Library Script in your Revyl organization.",
    "output_invalid": "An output file the script wrote broke a rule, as the reason says. Fix "
    "what the script writes there.",
    "runner_failed": "It failed on Revyl's side. Open the session again.",
}


def profile_failed_error(
    profile: ReportedSessionProfile, plan: SessionProfilePlan, viewer_url: str
) -> VerifyError:
    name = profile.name or plan.name or ""
    outcome = profile.outcome or "unknown"
    reason = f": {_sentence(profile.failure_reason)}" if profile.failure_reason else "."
    fix = _OUTCOME_FIXES.get(outcome, "Check the session link for what happened.")
    return VerifyError(
        "SESSION_PROFILE_FAILED",
        f'Session profile "{name}" failed ({outcome}){reason} {fix} Revyl stops the session. '
        f"See {viewer_url}",
        outcome=cast("SessionProfileOutcome | None", profile.outcome),
        failure_reason=profile.failure_reason,
    )


def profile_not_reported_error(platform: Platform, viewer_url: str) -> VerifyError:
    return VerifyError(
        "NOT_AVAILABLE_ON_PLATFORM",
        f"This Revyl backend doesn't run session profiles on {platform} yet, so Verify stopped "
        f"the session. Pass {_NONE_HINT} to start without one. See {viewer_url}",
    )


def _config_name(plan: SessionProfilePlan) -> str:
    return plan.config_path or ".revyl/config.yaml"


_REFUSALS: dict[str, tuple[str, Callable[[SessionProfilePlan], str]]] = {
    "session_profile_undefined": (
        "CONFIG_INVALID",
        lambda plan: (
            f"Check that session.profiles in {_config_name(plan)} defines it and that "
            "project.id names the project that holds it."
            if plan.config_path
            else "Check that the project's .revyl/config.yaml in Git defines the session profile "
            "and that session_profile_project_id names that project."
        ),
    ),
    "session_profile_source_required": (
        "INVALID_ARGUMENT",
        lambda plan: (
            "Update Verify to the latest version; it sends the project with every named profile."
        ),
    ),
    "session_profile_files_need_named": (
        "INVALID_ARGUMENT",
        lambda plan: (
            "Update Verify to the latest version; it sends checkout files only with a "
            "named profile."
        ),
    ),
    "session_profile_script_unavailable": (
        "SESSION_PROFILE_FAILED",
        lambda plan: (
            "Commit the script or add it to .revyl/scripts, or create the Library "
            "Script with that name in your Revyl organization."
        ),
    ),
    "repository_connection_missing": (
        "CONFIG_INVALID",
        lambda plan: (
            "Connect the repository's GitHub or GitLab app to the project in Revyl, "
            "then open the session again."
        ),
    ),
    "project_not_found": (
        "CONFIG_INVALID",
        lambda plan: (
            f"project.id in {_config_name(plan)} isn't a project in this API key's "
            "organization. Use a key from that organization, or fix project.id."
            if plan.config_path
            else "session_profile_project_id isn't a project in this API key's organization. "
            "Use a key from that organization, or fix session_profile_project_id."
        ),
    ),
    "repository_unavailable": (
        "API_ERROR",
        lambda plan: (
            "Revyl couldn't read the repository after 3 attempts. Try again in a few minutes."
        ),
    ),
}


def profile_refusal_error(
    response: Response, plan: SessionProfilePlan, platform: Platform
) -> VerifyError | None:
    try:
        body = response.json()
    except VerifyError:
        return None
    if not isinstance(body, dict):
        return None
    code = body.get("code") if isinstance(body.get("code"), str) else None
    raw = next(
        (
            value
            for value in (body.get("detail"), body.get("message"))
            if isinstance(value, str)
            and value.strip()
            and not re.fullmatch(r"[a-z0-9_]+", value.strip())
        ),
        None,
    )
    said = _sentence(raw.strip()[:500]) if raw is not None else ""
    subject = f'session profile "{plan.name}"' if plan.name else "the session profile request"
    refusal = _REFUSALS.get(code) if isinstance(code, str) else None
    if isinstance(code, str) and refusal is not None:
        error_code, fix = refusal
        detail = f": {said}" if said else "."
        script_unavailable = code == "session_profile_script_unavailable"
        return VerifyError(
            error_code,
            f"Revyl refused {subject} ({code}){detail} {fix(plan)}",
            reason=cast(RefusalReason, code),
            http_status=response.status,
            outcome="script_unavailable" if script_unavailable else None,
            failure_reason=said if script_unavailable and said else None,
        )
    if response.status != 422:
        return None
    body_detail = body.get("detail")
    legacy_device = platform != "mac" and (
        body_detail == _LEGACY_DEVICE_DETAIL
        or (
            isinstance(body_detail, dict)
            and body_detail.get("error") == "web_session_profile_start_unsupported"
            and body_detail.get("message") == _LEGACY_DEVICE_DETAIL
        )
    )
    legacy_computer = platform == "mac" and body_detail == "invalid_request" and len(body) == 1
    if not legacy_device and not legacy_computer:
        return None
    error = VerifyError(
        "NOT_AVAILABLE_ON_PLATFORM", _LEGACY_UNSUPPORTED, http_status=response.status
    )
    _legacy_refusals.add(error)
    return error


_LEGACY_DEVICE_DETAIL = (
    "Session profiles on this start need a CLI start or Open preview in this release"
)
_LEGACY_UNSUPPORTED = (
    "Revyl doesn't run session profiles for API starts yet; open the session without profile."
)
_legacy_refusals: weakref.WeakSet[VerifyError] = weakref.WeakSet()


def is_legacy_profile_refusal(error: BaseException) -> bool:
    """Whether Revyl refused the start the way a backend without hosted profiles does."""
    return isinstance(error, VerifyError) and error in _legacy_refusals


def _sentence(text: str) -> str:
    trimmed = text.strip()
    return trimmed if trimmed.endswith((".", "!", "?")) else f"{trimmed}."
