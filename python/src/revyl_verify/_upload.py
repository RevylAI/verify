from __future__ import annotations

import http.client
import json
import os
import re
import socket
import stat
import tempfile
import threading
import time
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import quote, urlencode, urlsplit

from ._models import UUID_PATTERN
from ._transport import Client, Deadline, Json, Response, VerifyError, http_error, obj

MobilePlatform = Literal["ios", "android"]

_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_COMMIT = re.compile(r"^([0-9a-f]{40}|[0-9a-f]{64})$")
_UPLOAD_SOURCE = "verify_upload"
_SESSION_TIMEOUT = 30.0
_PUT_TIMEOUT = 600.0
_FINALIZE_TIMEOUT = 90.0
_CREATE_ATTEMPTS = 4
_CREATE_RETRY_BASE = 0.5
_CREATE_RETRY_CAP = 10.0
_PUT_RETRY_DELAYS = (1.0, 3.0)
_RETRYABLE_PUT_STATUSES = frozenset({429, 500, 502, 503, 504})
_WEB_URL = re.compile(r"^https://[^/?#@\s\\]+(/[^?#\s\\]*)?$")
_WEB_URL_MAX_LENGTH = 2048
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True)
class ScmIdentity:
    """The pull request identity sent with an upload, in the fields `revyl build upload` sends."""

    ci_system: str
    repository: str
    commit: str
    pr: int | None = None
    pr_url: str | None = None
    branch: str | None = None
    base_commit: str | None = None
    run_id: str | None = None
    run_url: str | None = None
    actor: str | None = None
    actor_url: str | None = None


@dataclass(frozen=True)
class ReviewCorrelation:
    """Whether Revyl attached the build to a review, as Revyl reports it.

    ``status`` is ``associated``, ``not_owned``, ``ambiguous_review``, ``stale_review``,
    ``closed_review``, or ``unmatched``; ``no_identity`` when no complete identity was sent, and
    ``unknown`` when Revyl doesn't report it. Only ``associated`` is associated; ``not_owned`` and
    ``unmatched`` builds can still associate later.
    """

    status: str = "unknown"
    matched_target_count: int | None = None
    associated: bool = False


@dataclass(frozen=True)
class UploadResult:
    build_id: str
    version: str
    app_id: str
    platform: MobilePlatform
    package_id: str | None
    identity: ScmIdentity | None
    review_correlation: ReviewCorrelation
    warnings: tuple[str, ...]


def upload_build(
    file: str | os.PathLike[str],
    app_id: str,
    *,
    platform: MobilePlatform | None = None,
    version: str | None = None,
    repo: str | None = None,
    commit: str | None = None,
    pr: int | None = None,
    token: str | None = None,
    backend_url: str | None = None,
) -> UploadResult:
    """Uploads a finished CI build with the pull request identity Revyl matches to a review.

    The identity is detected on GitHub Actions; pass ``repo`` and ``commit`` elsewhere.
    ``token`` defaults to REVYL_API_KEY or the Revyl CLI login.
    """
    if not isinstance(app_id, str) or not UUID_PATTERN.fullmatch(app_id):
        raise VerifyError("INVALID_ARGUMENT", "app_id must be a Revyl app id (a UUID).")
    path, resolved_platform, is_bundle = _inspect_artifact(Path(file), platform)
    identity = detect_scm_identity(repo=repo, commit=commit, pr=pr)
    label = (version or "").strip() or _default_version(identity)
    client = Client(backend_url, token)
    headers = _identity_headers(identity)
    app_path = f"/api/v1/apps/{quote(app_id, safe='')}/builds"
    with tempfile.TemporaryDirectory(prefix="verify-upload-") as scratch:
        upload_path = (
            _zip_app_bundle(path, Path(scratch) / f"{path.name}.zip") if is_bundle else path
        )
        session = _call(
            client.request(
                "POST",
                f"{app_path}/upload-session?{urlencode({'source': _UPLOAD_SOURCE})}",
                {"version": label, "file_name": upload_path.name},
                deadline=Deadline(_SESSION_TIMEOUT),
                timeout=_SESSION_TIMEOUT,
                headers=headers,
            ),
            app_id,
        )
        upload_id, upload_url, content_type = (
            session.get("upload_id"),
            session.get("upload_url"),
            session.get("content_type"),
        )
        if not (
            isinstance(upload_id, str)
            and isinstance(upload_url, str)
            and isinstance(content_type, str)
        ):
            raise VerifyError("API_ERROR", "Revyl returned an invalid upload session.")
        _put_artifact(upload_url, content_type, upload_path)
        metadata: dict[str, Json] = {
            **_identity_metadata(identity, resolved_platform),
            "source": _UPLOAD_SOURCE,
            "platform": resolved_platform,
        }
        build = _call(
            _create_build(
                client,
                app_path,
                {"upload_id": upload_id, "version": label, "metadata": metadata},
                headers,
            ),
            app_id,
        )
    build_id = build.get("id")
    if not isinstance(build_id, str):
        raise VerifyError("API_ERROR", "Revyl returned a build without an id.")
    returned_version = build.get("version")
    package = build.get("package_name")
    return UploadResult(
        build_id=build_id,
        version=returned_version if isinstance(returned_version, str) else label,
        app_id=app_id,
        platform=resolved_platform,
        package_id=package if isinstance(package, str) and package else None,
        identity=identity,
        review_correlation=_review_correlation(build),
        warnings=_validation_warnings(build.get("metadata")),
    )


@dataclass(frozen=True)
class UrlBuildResult:
    """A deployment URL registered as a Web app build."""

    build_id: str
    app_id: str
    platform: Literal["web"]
    url: str
    version: str | None
    reused: bool
    """True when Revyl returned the build it already had for this app, URL, and commit."""
    identity: ScmIdentity | None


def validate_web_url(url: object) -> str:
    """Rejects what Revyl's URL-build route rejects: anything but HTTPS, credentials, a query,
    a fragment, a bad port, or over 2048 characters."""
    if (
        not isinstance(url, str)
        or len(url) > _WEB_URL_MAX_LENGTH
        or not _WEB_URL.fullmatch(url)
        or _CONTROL.search(url)
    ):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "url must be an HTTPS URL of at most 2048 characters, without credentials, a query "
            "string, a fragment, backslashes, or whitespace.",
        )
    try:
        parsed = urlsplit(url)
        _ = parsed.port
    except ValueError:
        raise VerifyError("INVALID_ARGUMENT", "url must be a valid HTTPS URL.") from None
    if not parsed.hostname:
        raise VerifyError("INVALID_ARGUMENT", "url must name a host.")
    return url


def register_url_build(client: Client, url: str, app_id: str) -> UrlBuildResult:
    """Registers a deployment URL as a build of a Web app, like
    `revyl build upload --platform web --url`."""
    if not isinstance(app_id, str) or not UUID_PATTERN.fullmatch(app_id):
        raise VerifyError("INVALID_ARGUMENT", "app_id must be a Revyl app id (a UUID).")
    url = validate_web_url(url)
    identity = detect_scm_identity()
    body: dict[str, Json] = {"url": url, "metadata": _identity_metadata(identity, "web")}
    if identity is not None:
        body["commit_sha"] = identity.commit
    response = client.request(
        "POST",
        f"/api/v1/apps/{quote(app_id, safe='')}/builds/external",
        body,
        deadline=Deadline(_SESSION_TIMEOUT),
        timeout=_SESSION_TIMEOUT,
        headers=_identity_headers(identity),
    )
    if not 200 <= response.status < 300:
        error = http_error(response)
        detail = _detail(response)
        suffix = f": {detail}" if detail else ""
        if response.status == 403 and error.code == "AUTH_REJECTED":
            raise VerifyError(
                "AUTH_REJECTED",
                f"Revyl rejected the URL build (HTTP 403){suffix}. Registering a URL build needs a "
                "Revyl member's own API key with the Member role or higher.",
                http_status=403,
            )
        if response.status == 404:
            raise VerifyError(
                "NOT_FOUND",
                f"Revyl app {app_id} was not found in this organization{suffix}.",
                http_status=404,
            )
        if response.status == 422:
            raise VerifyError(
                "INVALID_ARGUMENT",
                f"Revyl rejected the URL build (HTTP 422){suffix}.",
                http_status=422,
            )
        raise error
    build = obj(response.json())
    build_id = build.get("id")
    if not isinstance(build_id, str) or not build_id:
        raise VerifyError("API_ERROR", "Revyl registered the URL build without returning its id.")
    version = build.get("version")
    return UrlBuildResult(
        build_id=build_id,
        app_id=app_id,
        platform="web",
        url=url,
        version=version if isinstance(version, str) and version else None,
        reused=build.get("was_reused") is True,
        identity=identity,
    )


def detect_scm_identity(
    *,
    repo: str | None = None,
    commit: str | None = None,
    pr: int | None = None,
    env: Mapping[str, str] | None = None,
) -> ScmIdentity | None:
    """Reads explicit identity, else GitHub Actions identity, as `revyl build upload` does."""
    environ = os.environ if env is None else env
    detected = (
        _github_actions_identity(environ) if environ.get("GITHUB_ACTIONS") == "true" else None
    )
    if repo is None and commit is None and pr is None:
        if not detected or not detected.repository or not detected.commit:
            return None
        if not _COMMIT.fullmatch(detected.commit):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "The detected pull request head commit is not a full SHA (40 or 64 hexadecimal "
                "characters). Set REVYL_PR_HEAD_SHA to the PR head SHA, or pass repo and commit.",
            )
        return detected
    repository = (repo or "").strip()
    sha = (commit or "").strip().lower()
    if not repository or not sha:
        raise VerifyError(
            "INVALID_ARGUMENT",
            "An explicit pull request identity needs both repo (owner/name) and commit "
            "(the full PR head SHA).",
        )
    if not _REPOSITORY.fullmatch(repository):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "repo must be the base repository receiving the pull request, as owner/name.",
        )
    if not _COMMIT.fullmatch(sha):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "commit must be the full PR head commit SHA (40 or 64 hexadecimal characters).",
        )
    if pr is not None and (isinstance(pr, bool) or not isinstance(pr, int) or pr <= 0):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "pr must be a positive pull request number; omit it to match by commit.",
        )
    return ScmIdentity(
        ci_system=detected.ci_system if detected else "external",
        repository=repository,
        commit=sha,
        pr=pr,
        pr_url=f"https://github.com/{repository}/pull/{pr}" if pr is not None else None,
        run_id=detected.run_id if detected else None,
        run_url=detected.run_url if detected else None,
        actor=detected.actor if detected else None,
        actor_url=detected.actor_url if detected else None,
    )


def _github_actions_identity(env: Mapping[str, str]) -> ScmIdentity:
    pull_request: dict[str, Json] = {}
    event_path = env.get("GITHUB_EVENT_PATH", "").strip()
    if event_path:
        try:
            event = json.loads(Path(event_path).read_text(encoding="utf-8"))
            if isinstance(event, dict) and isinstance(event.get("pull_request"), dict):
                pull_request = event["pull_request"]
        except (OSError, ValueError):
            pass
    head = pull_request.get("head")
    base = pull_request.get("base")
    head_sha = head.get("sha") if isinstance(head, dict) else None
    base_sha = base.get("sha") if isinstance(base, dict) else None
    number = pull_request.get("number")
    html_url = pull_request.get("html_url")
    repository = env.get("GITHUB_REPOSITORY", "").strip()
    server = env.get("GITHUB_SERVER_URL", "").strip().rstrip("/")
    run_id = env.get("GITHUB_RUN_ID", "").strip()
    actor = env.get("GITHUB_ACTOR", "").strip()
    return ScmIdentity(
        ci_system="github-actions",
        repository=repository,
        commit=(
            _first(
                head_sha if isinstance(head_sha, str) else None,
                env.get("REVYL_PR_HEAD_SHA"),
                env.get("GITHUB_SHA"),
            )
            or ""
        ).lower(),
        pr=number
        if isinstance(number, int) and not isinstance(number, bool) and number > 0
        else None,
        pr_url=_first(html_url if isinstance(html_url, str) else None),
        branch=_first(env.get("GITHUB_HEAD_REF"), env.get("GITHUB_REF_NAME")),
        base_commit=_first(base_sha if isinstance(base_sha, str) else None),
        run_id=run_id or None,
        run_url=f"{server}/{repository}/actions/runs/{run_id}"
        if urlsplit(server).scheme in ("http", "https") and repository and run_id
        else None,
        actor=actor or None,
        actor_url=f"{server}/{actor}" if server and actor else None,
    )


def _identity_headers(identity: ScmIdentity | None) -> dict[str, str]:
    if identity is None:
        return {}
    headers = {
        "X-CI-System": identity.ci_system,
        "X-CI-Commit-SHA": identity.commit,
        "X-CI-Branch": identity.branch,
        "X-CI-Run-ID": identity.run_id,
        "X-CI-Run-URL": identity.run_url,
        "X-CI-Repository": identity.repository,
        "X-CI-Actor": identity.actor,
        "X-CI-Actor-URL": identity.actor_url,
        "X-CI-PR-URL": identity.pr_url,
        "X-CI-PR-Number": str(identity.pr) if identity.pr is not None else None,
    }
    return {name: value for name, value in headers.items() if value and _header_safe(value)}


def _header_safe(value: str) -> bool:
    return all(32 <= ord(char) <= 126 for char in value)


def _identity_metadata(
    identity: ScmIdentity | None, platform: MobilePlatform | Literal["web"]
) -> dict[str, Json]:
    if identity is None:
        return {}
    namespace, _, project = identity.repository.rpartition("/")
    metadata: dict[str, Json] = {
        "ci_system": identity.ci_system,
        "ci_run_id": identity.run_id,
        "ci_run_url": identity.run_url,
        "ci_actor": identity.actor,
        "github_repository": identity.repository,
        "scm_repo": identity.repository,
        "scm_provider": "github",
        "scm_namespace": namespace or None,
        "scm_project": project if namespace else None,
        "scm_branch": identity.branch,
        "scm_review_number": identity.pr,
        "pr_number": identity.pr,
        "scm_head_sha": identity.commit,
        "scm_base_sha": identity.base_commit,
        "scm_platform": platform,
    }
    return {key: value for key, value in metadata.items() if value not in (None, "")}


def _inspect_artifact(path: Path, platform: str | None) -> tuple[Path, MobilePlatform, bool]:
    if platform is not None and platform not in ("ios", "android"):
        raise VerifyError("INVALID_ARGUMENT", "platform must be 'ios' or 'android'.")
    name = path.name.lower()
    if name.endswith(".aab"):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Android App Bundles (.aab) are not supported. Upload a standalone .apk instead.",
        )
    if name.endswith(".apks"):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "Android split APKs and APK Set archives are not supported. "
            "Upload one standalone installable .apk instead.",
        )
    if name.endswith(".ipa"):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "IPA files are not supported. "
            "Upload a simulator-built .app bundle, or a .zip holding one.",
        )
    try:
        info = path.lstat()
    except OSError as error:
        raise VerifyError(
            "INVALID_ARGUMENT", f"Cannot read the build artifact {path}: {error.strerror}"
        ) from None
    inferred: MobilePlatform | None = (
        "android" if name.endswith(".apk") else "ios" if name.endswith((".app", ".zip")) else None
    )
    resolved: MobilePlatform | None = (
        "ios" if platform == "ios" else "android" if platform else inferred
    )
    if resolved is None:
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"Cannot tell the platform of {path.name}. Upload an .apk, an .app bundle, or a .zip, "
            "or pass platform.",
        )
    if stat.S_ISDIR(info.st_mode):
        if not name.endswith(".app"):
            raise VerifyError("INVALID_ARGUMENT", f"{path} is a directory but not an .app bundle.")
        if resolved != "ios":
            raise VerifyError(
                "INVALID_ARGUMENT",
                "An .app bundle is an iOS build; it cannot be uploaded as Android.",
            )
        return path, resolved, True
    if not stat.S_ISREG(info.st_mode):
        raise VerifyError("INVALID_ARGUMENT", f"{path} is not a regular file.")
    if resolved == "ios" and name.endswith(".apk"):
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"{path.name} is an Android build; upload a simulator-built .app bundle for iOS.",
        )
    return path, resolved, False


def _zip_app_bundle(bundle: Path, destination: Path) -> Path:
    """Zips an .app bundle like `revyl build upload`: entries under the bundle name, links kept."""
    try:
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, allowZip64=False) as archive:
            for root, directories, files in os.walk(bundle, onerror=_raise_walk_error):
                directories.sort()
                for name in sorted([*directories, *files]):
                    entry = Path(root) / name
                    arcname = entry.relative_to(bundle.parent).as_posix()
                    info = entry.lstat()
                    stamp = time.localtime(max(info.st_mtime, 315532800))[:6]
                    if stat.S_ISLNK(info.st_mode):
                        link = zipfile.ZipInfo(arcname, stamp)
                        link.create_system = 3
                        link.external_attr = (stat.S_IFLNK | 0o777) << 16
                        archive.writestr(
                            link, os.readlink(entry).replace(os.sep, "/"), zipfile.ZIP_STORED
                        )
                    elif stat.S_ISDIR(info.st_mode):
                        folder = zipfile.ZipInfo(f"{arcname}/", stamp)
                        folder.create_system = 3
                        folder.external_attr = (
                            (stat.S_IFDIR | stat.S_IMODE(info.st_mode)) << 16
                        ) | 0x10
                        archive.writestr(folder, b"", zipfile.ZIP_STORED)
                    elif stat.S_ISREG(info.st_mode):
                        archive.write(entry, arcname)
                    else:
                        raise VerifyError(
                            "INVALID_ARGUMENT",
                            f"{entry} in the .app bundle is not a file, directory, or symlink.",
                        )
    except (OSError, zipfile.LargeZipFile) as error:
        raise VerifyError(
            "INVALID_ARGUMENT", f"Could not zip the .app bundle {bundle}: {error}"
        ) from None
    return destination


def _raise_walk_error(error: OSError) -> None:
    raise VerifyError(
        "INVALID_ARGUMENT", f"Cannot read {error.filename} in the .app bundle: {error.strerror}"
    )


def _put_artifact(upload_url: str, content_type: str, path: Path) -> None:
    parsed = urlsplit(upload_url)
    loopback = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    if not parsed.hostname or (
        parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)
    ):
        raise VerifyError("API_ERROR", "Revyl returned an upload URL that is not HTTPS.")
    target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    size = path.stat().st_size
    for attempt in range(len(_PUT_RETRY_DELAYS) + 1):
        connection_type = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        connection = connection_type(parsed.hostname, parsed.port, timeout=_PUT_TIMEOUT)
        expired = threading.Event()

        def expire(connection: http.client.HTTPConnection = connection) -> None:
            expired.set()
            if connection.sock is not None:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        timer = threading.Timer(_PUT_TIMEOUT, expire)
        timer.daemon = True
        timer.start()
        failure: VerifyError
        retryable: bool
        try:
            with path.open("rb") as body:
                connection.request(
                    "PUT",
                    target,
                    body,
                    {"Content-Type": content_type, "Content-Length": str(size)},
                )
                response = connection.getresponse()
                response.read(16 * 1024)
            if 200 <= response.status < 300:
                return
            failure = VerifyError(
                "UPLOAD_FAILED",
                f"Revyl's storage rejected the artifact upload with HTTP {response.status}.",
                http_status=response.status,
            )
            retryable = response.status in _RETRYABLE_PUT_STATUSES
        except TimeoutError:
            raise VerifyError(
                "TIMEOUT",
                f"The artifact upload got no response within {_PUT_TIMEOUT / 60:g} minutes.",
            ) from None
        except (OSError, http.client.HTTPException) as error:
            if expired.is_set():
                raise VerifyError(
                    "TIMEOUT",
                    f"The artifact upload did not finish within {_PUT_TIMEOUT / 60:g} minutes.",
                ) from None
            failure = VerifyError(
                "UPLOAD_FAILED", f"Could not upload the artifact to Revyl's storage: {error}"
            )
            retryable = True
        finally:
            timer.cancel()
            connection.close()
        if not retryable or attempt == len(_PUT_RETRY_DELAYS):
            raise failure
        time.sleep(_PUT_RETRY_DELAYS[attempt])


def _call(response: Response, app_id: str) -> dict[str, Json]:
    if 200 <= response.status < 300:
        return obj(response.json())
    error = http_error(response)
    detail = _detail(response)
    suffix = f": {detail}" if detail else ""
    if error.code == "EDGE_BLOCKED":
        raise error
    if response.status == 401:
        raise VerifyError(
            "AUTH_REJECTED",
            f"Revyl rejected the upload credentials (HTTP 401){suffix}. Uploads need a Revyl "
            "member's API key, or the job's ci_runner key once the revyl-macos job's activation "
            "hook has run; an organization API key with no runtime authenticator is rejected as "
            "'Invalid API key'.",
            http_status=401,
        )
    if response.status == 403:
        raise VerifyError(
            "AUTH_REJECTED",
            f"Revyl rejected the upload (HTTP 403){suffix}. Uploading a build needs the Member "
            "role or higher; a Viewer's key gets 403.",
            http_status=403,
        )
    if response.status == 404:
        raise VerifyError(
            "NOT_FOUND",
            f"Revyl app {app_id} was not found in this organization{suffix}.",
            http_status=404,
        )
    if response.status == 409:
        raise VerifyError(
            "VERSION_EXISTS",
            f"Revyl already has this build version{suffix}. Pass a version that is unique "
            "within the app.",
            http_status=409,
        )
    if response.status in (400, 413, 422):
        raise VerifyError(
            "ARTIFACT_REJECTED",
            f"Revyl rejected the build (HTTP {response.status}){suffix}.",
            http_status=response.status,
        )
    raise VerifyError(
        "API_ERROR",
        f"Revyl upload request failed (HTTP {response.status}){suffix}.",
        http_status=response.status,
    )


def _detail(response: Response) -> str | None:
    try:
        raw = obj(response.json())
    except VerifyError:
        return None
    detail = raw.get("detail", raw.get("message"))
    return detail[:500] if isinstance(detail, str) else None


def _create_build(client: Client, path: str, body: Json, headers: dict[str, str]) -> Response:
    """Creates the build like revyl-cli's doRequestWithRetryClient: a retry with the same upload_id
    and version returns the existing build, so a 409 after a retry is a real version conflict."""
    for attempt in range(_CREATE_ATTEMPTS):
        last = attempt == _CREATE_ATTEMPTS - 1
        try:
            response = client.request(
                "POST",
                path,
                body,
                deadline=Deadline(_FINALIZE_TIMEOUT),
                timeout=_FINALIZE_TIMEOUT,
                headers=headers,
            )
        except VerifyError as error:
            if last or error.code not in ("API_ERROR", "TIMEOUT"):
                raise
        else:
            if last or not (response.status == 429 or response.status >= 500):
                return response
        time.sleep(min(_CREATE_RETRY_BASE * 2**attempt, _CREATE_RETRY_CAP))
    raise AssertionError("unreachable")


def _review_correlation(build: dict[str, Json]) -> ReviewCorrelation:
    if "review_correlation" not in build:
        return ReviewCorrelation()
    wire = build["review_correlation"]
    if wire is None:
        return ReviewCorrelation(status="no_identity")
    status = wire.get("status") if isinstance(wire, dict) else None
    if not isinstance(wire, dict) or not isinstance(status, str) or not status:
        return ReviewCorrelation()
    count = wire.get("matched_target_count")
    return ReviewCorrelation(
        status=status,
        matched_target_count=count
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0
        else None,
        associated=status == "associated",
    )


def _validation_warnings(metadata: Json) -> tuple[str, ...]:
    if not isinstance(metadata, dict):
        return ()
    validation = metadata.get("artifact_validation")
    warnings = validation.get("warnings") if isinstance(validation, dict) else None
    if not isinstance(warnings, list):
        return ()
    return tuple(item for item in warnings if isinstance(item, str) and item.strip())


def _default_version(identity: ScmIdentity | None) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{identity.commit[:12]}-{stamp}" if identity else stamp


def _first(*values: str | None) -> str | None:
    for value in values:
        if value and value.strip():
            return value.strip()
    return None


__all__ = [
    "ReviewCorrelation",
    "ScmIdentity",
    "UploadResult",
    "UrlBuildResult",
    "detect_scm_identity",
    "upload_build",
]
