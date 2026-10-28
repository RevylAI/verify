from __future__ import annotations

import re
from dataclasses import dataclass, fields
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from ._transport import VerifyError, seconds

Platform = Literal["web", "ios", "android", "mac", "linux"]
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def text_length(text: str) -> int:
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


@dataclass(frozen=True)
class Viewport:
    width: int
    height: int
    device_scale_factor: float | None = None


@dataclass(frozen=True)
class SignIn:
    path: str
    secret: str
    persona: str | None = None


@dataclass(frozen=True)
class Target:
    platform: Platform
    app_id: str | None = None
    bundle_id: str | None = None
    url: str | None = None
    build_id: str | None = None
    artifact_url: str | None = None
    branch: str | None = None
    device_model: str | None = None
    os_version: str | None = None
    start_timeout: float = 600
    idle_timeout_seconds: int | None = None
    viewport: Viewport | None = None
    sign_in: SignIn | None = None

    def validate(self, *, hosted: bool = False) -> None:
        def bad(message: str) -> None:
            raise VerifyError("INVALID_ARGUMENT", message)

        if self.platform not in ("web", "ios", "android", "mac", "linux"):
            bad("Platform must be web, ios, android, mac, or linux.")
        if hosted:
            if self.platform not in ("web", "ios", "android"):
                bad("Hosted targets must be web, ios, or android.")
            if not self.app_id or not self.build_id:
                bad("Hosted targets require both app_id and build_id UUIDs.")
            if any(
                value is not None
                for value in (
                    self.bundle_id,
                    self.url,
                    self.artifact_url,
                    self.branch,
                    self.device_model,
                    self.os_version,
                )
            ):
                bad(
                    "Hosted targets accept existing app_id and build_id, "
                    "not app or device overrides."
                )
        seconds(self.start_timeout, 10, 1800, "start_timeout")
        for name in (
            "app_id",
            "bundle_id",
            "url",
            "build_id",
            "artifact_url",
            "branch",
            "device_model",
            "os_version",
        ):
            value = getattr(self, name)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                bad("Target identifiers must be non-empty strings.")
        if self.platform in ("mac", "linux"):
            if any(
                getattr(self, field.name) is not None
                for field in fields(self)
                if field.name not in ("platform", "start_timeout")
            ):
                bad("Computer targets accept only platform and start_timeout.")
            return
        if self.idle_timeout_seconds is not None and (
            type(self.idle_timeout_seconds) is not int
            or not 60 <= self.idle_timeout_seconds <= 3600
        ):
            bad("idle_timeout_seconds must be between 60 and 3600.")
        for value in (self.app_id, self.build_id):
            if value is not None and not UUID_PATTERN.fullmatch(value):
                bad("app_id and build_id must be Revyl UUIDs.")
        if self.platform == "web":
            if not self.app_id or any(
                value is not None
                for value in (self.bundle_id, self.artifact_url, self.device_model, self.os_version)
            ):
                bad("Web needs app_id and does not accept mobile app or device options.")
            if self.url is not None:
                try:
                    parsed = urlsplit(self.url)
                    if (
                        not parsed.hostname
                        or not re.fullmatch(r"https://[^/?#@\s]+(/[^?#\s]*)?", self.url)
                        or text_length(self.url) > 2048
                    ):
                        raise ValueError
                    _ = parsed.port
                except ValueError:
                    bad("url must be public HTTPS without credentials, query, or fragment.")
            if self.build_id and (self.url or self.branch):
                bad("build_id cannot be combined with url or branch.")
            if self.branch and text_length(self.branch) > 255:
                bad("branch must be non-empty and at most 255 characters.")
            v = self.viewport
            if v is not None:
                if (
                    not isinstance(v, Viewport)
                    or type(v.width) is not int
                    or type(v.height) is not int
                    or not 320 <= v.width <= 3840
                    or not 240 <= v.height <= 2160
                ):
                    bad(
                        "Viewport dimensions must be 320–3840 by 240–2160, with scale 1–3 when set."
                    )
                if v.device_scale_factor is not None:
                    seconds(v.device_scale_factor, 1, 3, "device_scale_factor")
            s = self.sign_in
            if s is not None and (
                not isinstance(s, SignIn)
                or not isinstance(s.path, str)
                or not re.fullmatch(r"/[^?#\\\s]{0,511}", s.path)
                or s.path.startswith("//")
                or not isinstance(s.secret, str)
                or not s.secret.strip()
                or (
                    s.persona is not None
                    and (
                        not isinstance(s.persona, str)
                        or not re.fullmatch(r"[a-z0-9_-]{1,32}", s.persona)
                    )
                )
            ):
                bad(
                    "SignIn needs a local path, a secret name, and an optional "
                    "[a-z0-9_-] persona of at most 32 characters."
                )
            return
        if any(value is not None for value in (self.url, self.branch, self.viewport, self.sign_in)):
            bad("url, branch, viewport, and sign_in apply only to web targets.")
        if not hosted and (
            sum(
                value is not None
                for value in (self.app_id, self.build_id, self.artifact_url, self.bundle_id)
            )
            != 1
        ):
            bad("Mobile needs exactly one of app_id, build_id, artifact_url, or bundle_id.")
        if self.artifact_url and not self.artifact_url.startswith("https://"):
            bad("artifact_url must use HTTPS.")
        for value, limit in (
            (self.bundle_id, 255),
            (self.device_model, 128),
            (self.os_version, 64),
        ):
            if value and text_length(value) > limit:
                bad("Mobile identifiers must be non-empty and within their length limits.")


@dataclass(frozen=True)
class StepResult:
    type: Literal["instruction", "validation"]
    text: str
    passed: bool
    reason: str | None
    duration_seconds: float


@dataclass(frozen=True)
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class FileStat:
    kind: Literal["file", "directory"]
    size: int


@dataclass(frozen=True)
class ComputerProcess:
    id: str
    state: Literal["running", "exited"]
    exit_code: int | None = None


@dataclass(frozen=True)
class ComputerRecording:
    url: str
    duration_seconds: float | None = None
    started_at: datetime | None = None
