from __future__ import annotations

import base64
import http.client
import json
import math
import os
import re
from dataclasses import dataclass, field
from typing import Literal, Protocol
from urllib.parse import urlsplit

from ._transport import Deadline, Json, VerifyError, exchange


@dataclass(frozen=True)
class ModelTool:
    name: str
    description: str
    parameters: dict[str, Json]


@dataclass(frozen=True)
class ModelImage:
    png: bytes
    width: int
    height: int


@dataclass(frozen=True)
class ModelRequest:
    system: str
    text: str
    image: ModelImage
    tools: list[ModelTool]


@dataclass(frozen=True)
class ModelToolCall:
    name: str
    arguments: dict[str, Json]


@dataclass(frozen=True)
class ModelUsage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class ModelReply:
    tool_call: ModelToolCall | None = None
    text: str | None = None
    usage: ModelUsage = field(default_factory=ModelUsage)
    truncated: bool = False


class ModelAdapter(Protocol):
    @property
    def name(self) -> str: ...

    def complete(self, request: ModelRequest, timeout: float) -> ModelReply: ...


_RETRYABLE = {408, 409, 429, 500, 502, 503, 504, 529}
_MAX_RETRY_DELAY = 10.0
_RESPONSE_LIMIT = 16 * 1024 * 1024
_HEADER_NAME = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}")


@dataclass(frozen=True)
class _Endpoint:
    url: str
    host: str
    appended: str
    name: str
    model: str
    secrets: tuple[str, ...]
    key_source: str | None
    url_source: str | None
    max_retries: int


def anthropic(
    model: str,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    max_tokens: int = 4096,
    max_retries: int = 2,
) -> ModelAdapter:
    return _Anthropic(model, api_key, base_url, max_tokens, max_retries)


def openai_compatible(
    model: str,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    headers: dict[str, str] | None = None,
    provider: str | None = None,
    max_tokens: int | None = None,
    max_retries: int = 2,
) -> ModelAdapter:
    return _ChatCompletions(model, base_url, api_key, headers, provider, max_tokens, max_retries)


class _Anthropic:
    def __init__(
        self,
        model: str,
        api_key: str | None,
        base_url: str | None,
        max_tokens: int,
        max_retries: int,
    ) -> None:
        self._model = _require_text(model, "anthropic() model")
        key = (api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")).strip()
        if not key:
            raise VerifyError(
                "MODEL_KEY_MISSING",
                "anthropic() needs api_key or ANTHROPIC_API_KEY in the environment. "
                "Create a key in the Anthropic Console.",
            )
        environment_url = os.environ.get("ANTHROPIC_BASE_URL", "")
        url_source = "ANTHROPIC_BASE_URL" if base_url is None and environment_url.strip() else None
        self.name = f"anthropic/{self._model}"
        self._key = key
        self._max_tokens = max_tokens
        self._endpoint = _endpoint(
            base_url
            if base_url is not None
            else environment_url
            if url_source
            else "https://api.anthropic.com",
            "messages",
            "unless-versioned",
            url_source,
            name=self.name,
            model=self._model,
            secrets=(key,),
            key_source="ANTHROPIC_API_KEY" if api_key is None else "the api_key you passed",
            max_retries=max_retries,
        )

    def complete(self, request: ModelRequest, timeout: float) -> ModelReply:
        body = _post_json(
            self._endpoint,
            {
                "model": self._model,
                "max_tokens": self._max_tokens,
                "system": request.system,
                "tools": [
                    {
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.parameters,
                    }
                    for tool in request.tools
                ],
                "tool_choice": {"type": "any"},
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": base64.b64encode(request.image.png).decode(),
                                },
                            },
                            {"type": "text", "text": request.text},
                        ],
                    }
                ],
            },
            {"x-api-key": self._key, "anthropic-version": "2023-06-01"},
            timeout,
        )
        content = body.get("content")
        blocks = [_record(block) for block in content] if isinstance(content, list) else []
        tool_use = next((block for block in blocks if block.get("type") == "tool_use"), None)
        texts = [block.get("text") for block in blocks if block.get("type") == "text"]
        text = "\n".join(value for value in texts if isinstance(value, str)).strip()
        usage = _record(body.get("usage"))
        name = tool_use.get("name") if tool_use else None
        return ModelReply(
            ModelToolCall(name, _record(tool_use.get("input")))
            if tool_use and isinstance(name, str)
            else None,
            text or None,
            ModelUsage(
                _count(usage.get("input_tokens"))
                + _count(usage.get("cache_creation_input_tokens"))
                + _count(usage.get("cache_read_input_tokens")),
                _count(usage.get("output_tokens")),
            ),
            body.get("stop_reason") == "max_tokens",
        )


class _ChatCompletions:
    def __init__(
        self,
        model: str,
        base_url: str | None,
        api_key: str | None,
        headers: dict[str, str] | None,
        provider: str | None,
        max_tokens: int | None,
        max_retries: int,
        *,
        tool_choice: Literal["required", "auto"] = "required",
        key_source: str | None = None,
    ) -> None:
        self._model = _require_text(model, "openai_compatible() model")
        openai = base_url is None
        environment_url = os.environ.get("OPENAI_BASE_URL", "")
        url_source = "OPENAI_BASE_URL" if openai and environment_url.strip() else None
        key = (
            api_key
            if api_key is not None
            else os.environ.get("OPENAI_API_KEY", "")
            if openai
            else ""
        ).strip()
        self._headers = _check_headers(headers)
        self.name = f"{provider}/{self._model}" if provider else self._model
        self._endpoint = _endpoint(
            base_url
            if base_url is not None
            else environment_url
            if url_source
            else "https://api.openai.com/v1",
            "chat/completions",
            "at-host-root",
            url_source,
            name=self.name,
            model=self._model,
            secrets=tuple(value for value in (key, *self._headers.values()) if value),
            key_source=key_source
            or (
                "the api_key you passed"
                if api_key is not None
                else "OPENAI_API_KEY"
                if key
                else None
            ),
            max_retries=max_retries,
        )
        openai_models = openai or urlsplit(self._endpoint.url).hostname == "api.openai.com"
        self._max_tokens = max_tokens or (4096 if openai_models else 2048)
        self._token_field = "max_completion_tokens" if openai_models else "max_tokens"
        self._tool_choice = tool_choice
        if key:
            self._headers["Authorization"] = f"Bearer {key}"

    def complete(self, request: ModelRequest, timeout: float) -> ModelReply:
        body = _post_json(
            self._endpoint,
            {
                "model": self._model,
                self._token_field: self._max_tokens,
                "tool_choice": self._tool_choice,
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        },
                    }
                    for tool in request.tools
                ],
                "messages": [
                    {"role": "system", "content": request.system},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": request.text},
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": "data:image/png;base64,"
                                    + base64.b64encode(request.image.png).decode()
                                },
                            },
                        ],
                    },
                ],
            },
            self._headers,
            timeout,
        )
        choices = body.get("choices")
        choice = _record(choices[0]) if isinstance(choices, list) and choices else {}
        message = _record(choice.get("message"))
        calls = message.get("tool_calls")
        function = (
            _record(_record(calls[0]).get("function")) if isinstance(calls, list) and calls else {}
        )
        content = message.get("content")
        text = content.strip() if isinstance(content, str) else ""
        usage = _record(body.get("usage"))
        name = function.get("name")
        return ModelReply(
            ModelToolCall(name, _arguments(function.get("arguments")))
            if isinstance(name, str)
            else _tool_call_from_text(text),
            text or None,
            ModelUsage(_count(usage.get("prompt_tokens")), _count(usage.get("completion_tokens"))),
            choice.get("finish_reason") == "length",
        )


def _endpoint(
    root: str,
    path: str,
    version: Literal["unless-versioned", "at-host-root"],
    url_source: str | None,
    *,
    name: str,
    model: str,
    secrets: tuple[str, ...],
    key_source: str | None,
    max_retries: int,
) -> _Endpoint:
    if type(max_retries) is not int or not 0 <= max_retries <= 5:
        raise VerifyError("INVALID_ARGUMENT", "max_retries must be an integer from 0 to 5.")
    source = url_source or "The model base_url"
    raw = root.strip() if isinstance(root, str) else ""
    raw = raw if raw.endswith("/") else raw + "/"
    try:
        url = urlsplit(raw)
        port = url.port
        if not url.scheme or not url.netloc or any(char.isspace() for char in raw):
            raise ValueError
    except ValueError:
        raise VerifyError("INVALID_ARGUMENT", f"{source} is not a valid URL.") from None
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise VerifyError(
            "INVALID_ARGUMENT", f"{source} must be an http(s) URL without credentials."
        )
    host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname
    if port is not None and port != (443 if url.scheme == "https" else 80):
        host += f":{port}"
    versioned = re.search(r"/v\d+[a-z0-9]*/\Z", url.path, re.I) is not None
    add_version = not versioned if version == "unless-versioned" else url.path == "/"
    appended = f"v1/{path}" if add_version else path
    return _Endpoint(
        f"{url.scheme}://{host}{url.path}{appended}",
        host,
        "/" + appended,
        name,
        model,
        secrets,
        key_source,
        url_source,
        max_retries,
    )


def _post_json(
    endpoint: _Endpoint, payload: Json, headers: dict[str, str], timeout: float
) -> dict[str, Json]:
    deadline = Deadline(timeout)
    where = f"{endpoint.name} at {endpoint.host}"
    url = urlsplit(endpoint.url)
    body = json.dumps(payload).encode()
    attempt = 0
    while True:
        try:
            response = exchange(
                url,
                "POST",
                url.path,
                body,
                {"Content-Type": "application/json", **headers},
                deadline,
                _RESPONSE_LIMIT,
                "model",
            )
        except (OSError, http.client.HTTPException, ValueError, VerifyError) as error:
            if deadline.expired():
                raise _timed_out(where) from None
            if attempt < endpoint.max_retries:
                _pause(deadline, 3.0**attempt, where)
                attempt += 1
                continue
            detail = _scrub(
                (error.message if isinstance(error, VerifyError) else str(error))
                or type(error).__name__,
                endpoint.secrets,
            )
            raise VerifyError(
                "MODEL_ERROR",
                f"Could not reach {where}: {detail}. "
                "Check the base_url and that the server is running.",
            ) from None
        text = response.body.decode("utf-8", errors="replace")
        if 200 <= response.status < 300:
            try:
                return _record(json.loads(text, parse_constant=_reject))
            except (ValueError, RecursionError):
                raise VerifyError(
                    "MODEL_ERROR",
                    f"{where} returned a response that is not JSON. "
                    "Check that the base_url serves OpenAI-style chat completions.",
                ) from None
        if response.status in _RETRYABLE and attempt < endpoint.max_retries:
            try:
                retry_after = float(response.headers.get("retry-after", ""))
            except ValueError:
                retry_after = math.nan
            _pause(
                deadline,
                min(retry_after, _MAX_RETRY_DELAY)
                if math.isfinite(retry_after) and retry_after > 0
                else 3.0**attempt,
                where,
            )
            attempt += 1
            continue
        message = re.sub(
            r"[.\s]*\Z", ".", _scrub(_provider_message(text), endpoint.secrets)[:300], count=1
        )
        step = _next_step(response.status, message, endpoint)
        raise VerifyError(
            "MODEL_ERROR",
            f"{where} refused the request (HTTP {response.status}): {message}"
            + (f" {step}" if step else ""),
            http_status=response.status,
        )


def _timed_out(where: str) -> VerifyError:
    return VerifyError(
        "TIMEOUT",
        f"{where} did not answer in time. "
        "Raise local_agent() model_timeout for slow or local models.",
    )


def _pause(deadline: Deadline, seconds: float, where: str) -> None:
    try:
        deadline.pause(seconds)
    except VerifyError:
        raise _timed_out(where) from None


def _next_step(status: int, message: str, endpoint: _Endpoint) -> str:
    if status in (401, 403):
        address = f" (from {endpoint.url_source})" if endpoint.url_source else ""
        if endpoint.key_source:
            return (
                f"{endpoint.host}{address} rejected the key from {endpoint.key_source}. "
                "Check that the key is valid for that endpoint."
            )
        return f"{endpoint.host}{address} needs a key: pass api_key or headers."
    if status == 429:
        return (
            f"Still rate limited after {endpoint.max_retries} retries. Wait and rerun, "
            "run fewer sessions at once, or raise your limit with the provider."
        )
    unsupported = re.search(
        r"not support|unsupported|only supported|not enabled|not allowed|"
        r"cannot (accept|process|read)",
        message,
        re.I,
    )
    if unsupported and re.search(r"image|vision|multimodal|modalit", message, re.I):
        return f"{endpoint.model} does not accept images. Pick a model that takes image input."
    if unsupported and re.search(r"tool|function", message, re.I):
        return f"{endpoint.model} does not support tool calls. Pick a model that does."
    if re.search(
        r"model.*(not.?found|not exist|invalid|unknown|not a valid|no such)|"
        r"(invalid|unknown|no such|not a valid).*model",
        message,
        re.I,
    ):
        return f"Check that '{endpoint.model}' is a model name this provider serves."
    if status == 404:
        address = endpoint.url_source or "the base_url"
        return (
            f"Verify added {endpoint.appended} to {address}. Check that '{endpoint.model}' "
            f"is a model this provider serves, and whether {address} should include /v1."
        )
    if status >= 500:
        return "The provider failed; try again later."
    return ""


def _provider_message(text: str) -> str:
    try:
        body = json.loads(text, parse_constant=_reject)
    except (ValueError, RecursionError):
        plain = " ".join(text.split())
        return plain if plain and not plain.startswith("<") else "no error message"
    record = _record(body)
    error = record.get("error")
    message = error if isinstance(error, str) else _record(error).get("message")
    if message is None:
        message = record.get("message")
    return message if isinstance(message, str) else "no error message"


def _scrub(text: str, secrets: tuple[str, ...]) -> str:
    for secret in secrets:
        if len(secret) >= 4:
            text = text.replace(secret, "[redacted]")
    return text


def _check_headers(headers: dict[str, str] | None) -> dict[str, str]:
    if headers is None:
        return {}
    if not isinstance(headers, dict):
        raise VerifyError(
            "INVALID_ARGUMENT", "Model headers must be a dict of header names to string values."
        )
    if len(headers) > 20:
        raise VerifyError("INVALID_ARGUMENT", "Pass at most 20 model headers.")
    for name, value in headers.items():
        if (
            not isinstance(name, str)
            or not _HEADER_NAME.fullmatch(name)
            or not isinstance(value, str)
            or len(value) > 8192
            or re.search(r"[\r\n\0]", value)
        ):
            raise VerifyError(
                "INVALID_ARGUMENT", "Model headers need valid names and single-line string values."
            )
    return dict(headers)


def _tool_call_from_text(text: str) -> ModelToolCall | None:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = _record(json.loads(text[start : end + 1], parse_constant=_reject))
    except (ValueError, RecursionError):
        return None
    name = parsed.get("name")
    if name is None:
        name = parsed.get("tool")
    if not isinstance(name, str):
        return None
    arguments = parsed.get("arguments")
    if arguments is None:
        arguments = parsed.get("parameters")
    return ModelToolCall(name, _arguments({} if arguments is None else arguments))


def _arguments(value: Json) -> dict[str, Json]:
    if not isinstance(value, str):
        return _record(value)
    try:
        return _record(json.loads(value, parse_constant=_reject))
    except (ValueError, RecursionError):
        return {}


def _record(value: Json) -> dict[str, Json]:
    return value if isinstance(value, dict) else {}


def _count(value: Json) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value) if math.isfinite(value) and value >= 0 else 0


def _require_text(value: object, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise VerifyError("INVALID_ARGUMENT", f"{what} must be a non-empty string.")
    return value.strip()


def _reject(value: str) -> None:
    raise ValueError
