from __future__ import annotations

import re
from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from ._transport import VerifyError, seconds

Platform = Literal["web", "ios", "android", "mac", "linux"]
ComputerInferenceReadiness = Literal["ready", "unavailable", "unknown"]
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
    timeout: int | None = None
    inference: bool | None = None
    """Mac: run the computer on a Mac whose own vision model is loaded, so validation() and
    extract() work on it and iOS and Web sessions opened inside it use that model too. Comes with
    paid Revyl plans. Inside a computer (computer.open()), iOS and Web: run this session's steps on
    the hosting Mac's own vision model first, with Revyl's hosted model as the fallback; defaults
    to True inside a computer opened with inference=True, and False turns it off."""

    def validate(self, *, hosted: bool = False) -> None:
        def bad(message: str) -> None:
            raise VerifyError("INVALID_ARGUMENT", message)

        if self.platform not in ("web", "ios", "android", "mac", "linux"):
            bad("Platform must be web, ios, android, mac, or linux.")
        if self.inference is not None and not isinstance(self.inference, bool):
            bad("inference must be True or False.")
        if hosted:
            if self.platform not in ("web", "ios", "android"):
                bad("Hosted targets must be web, ios, or android.")
            ios = self.platform == "ios"
            name = {"web": "Web", "ios": "iOS", "android": "Android"}[self.platform]
            if self.bundle_id is not None and not ios:
                bad(
                    "Inside a computer, bundle_id works only for iOS for now; "
                    f"for {name}, pass app_id and build_id."
                )
            if ios and self.bundle_id is not None:
                if self.app_id is not None or self.build_id is not None:
                    bad(
                        "Inside a computer, iOS takes either bundle_id alone or app_id with "
                        "build_id, not both."
                    )
            elif not self.app_id or not self.build_id:
                bad(
                    f"Inside a computer, {name} needs both app_id and build_id UUIDs"
                    + (
                        ', or bundle_id alone, e.g. Target(platform="ios", '
                        'bundle_id="com.apple.Preferences").'
                        if ios
                        else "."
                    )
                )
            if any(value is not None for value in (self.url, self.artifact_url, self.branch)):
                bad(
                    "url, branch and artifact_url aren't available inside a computer; pass "
                    "app_id and build_id" + (", or bundle_id." if ios else ".")
                )
            if not ios and (self.device_model is not None or self.os_version is not None):
                bad(
                    "Inside a computer, device_model and os_version work only for iOS; "
                    f"leave them out for {name}."
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
                if field.name not in ("platform", "start_timeout", "timeout", "inference")
            ):
                bad("Computer targets accept only platform, start_timeout, timeout, and inference.")
            if self.inference is True and self.platform == "linux":
                bad(
                    'inference is for Mac computers only; use Target(platform="mac", '
                    "inference=True)."
                )
            if self.timeout is not None and (
                type(self.timeout) is not int or not 60 <= self.timeout <= 86_400
            ):
                bad("timeout must be an integer number of seconds from 60 to 86400.")
            return
        if self.timeout is not None:
            bad("timeout applies only to mac and linux targets.")
        if self.inference is not None and not hosted:
            bad(
                "inference applies only to mac targets and to iOS and Web targets passed to "
                "computer.open()."
            )
        if self.inference is True and self.platform == "android":
            bad(
                "inference runs only for iOS and Web sessions inside a Mac computer; leave it "
                "out for Android."
            )
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
class Point:
    x: int
    y: int


@dataclass(frozen=True)
class ScreenSize:
    width: int
    height: int


@dataclass(frozen=True)
class ModelTurn:
    action: str
    ok: bool
    model_seconds: float
    action_seconds: float
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class ModelRun:
    id: str
    grounding: Literal["model", "revyl"]
    turns: list[ModelTurn]
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class StepResult:
    type: Literal["instruction", "validation", "extract"]
    text: str
    passed: bool
    reason: str | None
    duration_seconds: float
    model: ModelRun | None = None
    value: str | None = None
    """What extract() read off the screen. Extract steps only."""
    engine: Literal["local", "hosted"] | None = None
    """Who answered, when Revyl says: "local" is the vision model on the Revyl computer the step
    ran on or inside (Target(platform="mac", inference=True)), "hosted" is Revyl's hosted model."""


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


@dataclass(frozen=True)
class CDPEndpoint:
    """A Chrome DevTools Protocol browser endpoint for a web session, from ``cdp()``.

    ``url`` is a credential: it works for one connection and expires at ``expires_at``,
    60 seconds after ``cdp()`` returned it. Don't log it or store it; repr() leaves it out.
    """

    url: str = field(repr=False)
    expires_at: datetime


@dataclass(frozen=True)
class SessionReportStep:
    """One step in Revyl's report for a session, from report()."""

    type: str
    """Revyl's step type, such as "instruction" or "validation"."""
    description: str | None
    status: str
    """One of "passed", "failed", "warning", "pending" or "running"."""
    passed: bool | None
    """Whether the validation held, or whether the step succeeded; None while Revyl doesn't say."""
    reasoning: str | None
    """Why Revyl judged a validation the way it did."""
    error: str | None


@dataclass(frozen=True)
class SessionReport:
    """A session's outcome and steps as Revyl recorded them, from report()."""

    id: str
    viewer_url: str
    platform: str | None
    """One of "web", "ios", "android", "macos" or "linux", as Revyl names them."""
    status: str
    """Revyl's session status: "completed", "failed", "cancelled" or "timeout" once finished."""
    finished: bool
    """Whether the status is final, so the outcome and steps won't change."""
    error: str | None
    """Why the session failed, when Revyl recorded a reason."""
    started_at: datetime | None
    ended_at: datetime | None
    steps: list[SessionReportStep]
    """In the order they ran. Empty for computers and for sessions Revyl has no report for yet."""
