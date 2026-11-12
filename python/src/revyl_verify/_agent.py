from __future__ import annotations

import io
import json
import math
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, TypeGuard, cast

from PIL import Image

from ._model import (
    ModelAdapter,
    ModelImage,
    ModelRequest,
    ModelTool,
    ModelToolCall,
    _ChatCompletions,
    anthropic,
)
from ._models import ModelRun, ModelTurn, Point, ScreenSize
from ._transport import Deadline, Json, VerifyError, seconds

Grounding = Literal["model", "revyl"]
DevicePlatform = Literal["ios", "android", "web"]
Location = Point | str
SwipeDirection = Literal["up", "down", "left", "right"]
Key = Literal[
    "enter",
    "backspace",
    "tab",
    "escape",
    "delete",
    "space",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "home",
    "end",
    "pageup",
    "pagedown",
]
KeyModifier = Literal["ctrl", "shift", "alt", "meta"]
WEB_KEYS: dict[str, str] = {
    "enter": "Enter",
    "backspace": "Backspace",
    "tab": "Tab",
    "escape": "Escape",
    "delete": "Delete",
    "space": "Space",
    "arrowup": "ArrowUp",
    "arrowdown": "ArrowDown",
    "arrowleft": "ArrowLeft",
    "arrowright": "ArrowRight",
    "home": "Home",
    "end": "End",
    "pageup": "PageUp",
    "pagedown": "PageDown",
}


@dataclass(frozen=True)
class LocalAgent:
    model: ModelAdapter
    grounding: Grounding = "revyl"
    max_turns: int = 20
    model_timeout: float = 60
    max_image_side: int = 1280

    def __post_init__(self) -> None:
        if not callable(getattr(self.model, "complete", None)) or not isinstance(
            getattr(self.model, "name", None), str
        ):
            raise VerifyError(
                "INVALID_ARGUMENT",
                "local_agent() needs a model adapter, such as anthropic() or openai_compatible().",
            )
        if self.grounding not in ("model", "revyl"):
            raise VerifyError(
                "INVALID_ARGUMENT", "local_agent() grounding must be 'model' or 'revyl'."
            )
        _bounded(self.max_turns, 1, 100, "max_turns")
        seconds(self.model_timeout, 1, 600, "local_agent() model_timeout")
        _bounded(self.max_image_side, 256, 4096, "max_image_side")


def local_agent(
    model: ModelAdapter,
    *,
    grounding: Grounding = "revyl",
    max_turns: int = 20,
    model_timeout: float = 60,
    max_image_side: int = 1280,
) -> LocalAgent:
    return LocalAgent(model, grounding, max_turns, model_timeout, max_image_side)


@dataclass(frozen=True)
class CustomModel:
    id: str
    base_url: str
    api_key: str | None = None
    headers: dict[str, str] | None = None
    provider: str | None = None
    grounding: Grounding | None = None


ModelOption = str | CustomModel


@dataclass(frozen=True)
class _Provider:
    label: str
    env: tuple[str, ...]
    base_url: str | None = None
    tool_choice: Literal["required", "auto"] = "required"
    max_tokens: int | None = None


_PROVIDERS = {
    "anthropic": _Provider("Anthropic", ("ANTHROPIC_API_KEY",)),
    "openai": _Provider("OpenAI", ("OPENAI_API_KEY",)),
    "google": _Provider(
        "Google AI Studio",
        ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "auto",
        4096,
    ),
    "openrouter": _Provider("OpenRouter", ("OPENROUTER_API_KEY",), "https://openrouter.ai/api/v1"),
    "groq": _Provider("Groq", ("GROQ_API_KEY",), "https://api.groq.com/openai/v1"),
    "cerebras": _Provider("Cerebras", ("CEREBRAS_API_KEY",), "https://api.cerebras.ai/v1"),
    "xai": _Provider("xAI", ("XAI_API_KEY",), "https://api.x.ai/v1"),
    "ollama": _Provider("Ollama", (), "http://localhost:11434/v1"),
}
_USAGE = (
    "Pass 'provider/model', such as 'anthropic/claude-sonnet-5-5', with a provider of "
    + ", ".join(_PROVIDERS)
    + ", or CustomModel(id, base_url) for your own OpenAI-compatible endpoint."
)


def choose_agent(
    model: ModelOption | None, agent: LocalAgent | None, where: str
) -> LocalAgent | None:
    if model is not None and agent is not None:
        raise VerifyError("INVALID_ARGUMENT", f"{where} takes model or agent, not both.")
    if model is not None:
        return _agent_for_model(model)
    if agent is not None and not isinstance(agent, LocalAgent):
        raise VerifyError("INVALID_ARGUMENT", f"{where} takes an agent made with local_agent().")
    return agent


def _agent_for_model(option: ModelOption) -> LocalAgent:
    if isinstance(option, str):
        slash = option.find("/")
        prefix = option[:slash] if slash > 0 else ""
        model_id = option[slash + 1 :].strip()
        provider = _PROVIDERS.get(prefix)
        if provider is None or not model_id:
            raise VerifyError("INVALID_ARGUMENT", f"Unknown model '{option[:100]}'. {_USAGE}")
        key_variable = next(
            (variable for variable in provider.env if os.environ.get(variable, "").strip()), None
        )
        if provider.env and key_variable is None:
            raise VerifyError(
                "MODEL_KEY_MISSING",
                f"model '{option}' reads its key from {' or '.join(provider.env)}, which is not "
                f"set. Set it to your {provider.label} API key.",
            )
        if prefix == "anthropic":
            return LocalAgent(anthropic(model_id))
        return LocalAgent(
            _ChatCompletions(
                model_id,
                provider.base_url,
                os.environ[key_variable].strip() if key_variable else None,
                None,
                prefix,
                provider.max_tokens,
                2,
                tool_choice=provider.tool_choice,
                key_source=key_variable,
            )
        )
    if (
        not isinstance(option, CustomModel)
        or not isinstance(option.id, str)
        or not isinstance(option.base_url, str)
    ):
        raise VerifyError("INVALID_ARGUMENT", f"model must be a string or a CustomModel. {_USAGE}")
    if option.api_key is not None and not isinstance(option.api_key, str):
        raise VerifyError("INVALID_ARGUMENT", "model api_key must be a string.")
    if option.provider is not None and (
        not isinstance(option.provider, str) or not option.provider.strip()
    ):
        raise VerifyError("INVALID_ARGUMENT", "model provider must be a non-empty string.")
    return LocalAgent(
        _ChatCompletions(
            option.id,
            option.base_url,
            option.api_key,
            option.headers,
            option.provider.strip() if option.provider else None,
            None,
            2,
        ),
        option.grounding or "revyl",
    )


@dataclass(frozen=True)
class Tap:
    at: Location


@dataclass(frozen=True)
class DoubleTap:
    at: Location


@dataclass(frozen=True)
class LongPress:
    at: Location
    duration_ms: int | None = None


@dataclass(frozen=True)
class TypeText:
    at: Location
    text: str
    clear: bool


@dataclass(frozen=True)
class TypeFocused:
    text: str
    clear: bool


@dataclass(frozen=True)
class Swipe:
    direction: SwipeDirection
    start: Location | None


@dataclass(frozen=True)
class Drag:
    start: Location
    end: Location


@dataclass(frozen=True)
class PressKey:
    key: str
    modifiers: tuple[KeyModifier, ...] = ()


@dataclass(frozen=True)
class Back:
    pass


@dataclass(frozen=True)
class GoHome:
    pass


@dataclass(frozen=True)
class OpenUrl:
    url: str


DeviceAction = (
    Tap
    | DoubleTap
    | LongPress
    | TypeText
    | TypeFocused
    | Swipe
    | Drag
    | PressKey
    | Back
    | GoHome
    | OpenUrl
)


def check_key(
    platform: str, key: object, modifiers: object = ()
) -> tuple[str, tuple[KeyModifier, ...]]:
    if (
        not isinstance(modifiers, (list, tuple))
        or len(modifiers) > 4
        or not all(modifier in ("ctrl", "shift", "alt", "meta") for modifier in modifiers)
    ):
        raise VerifyError(
            "INVALID_ARGUMENT",
            "press_key() modifiers are up to four of 'ctrl', 'shift', 'alt' and 'meta'.",
        )
    checked = cast(tuple[KeyModifier, ...], tuple(modifiers))
    if platform != "web":
        if key in ("enter", "backspace") and not checked:
            return key, ()
        if checked or (isinstance(key, str) and key in WEB_KEYS):
            raise VerifyError(
                "NOT_AVAILABLE_ON_PLATFORM",
                "On iOS and Android, press_key() takes only 'enter' or 'backspace', with no "
                "modifiers; tap the on-screen control instead.",
            )
        raise VerifyError("INVALID_ARGUMENT", "press_key() takes 'enter' or 'backspace'.")
    if isinstance(key, str) and (
        key in WEB_KEYS or (checked and re.fullmatch(r"[a-z0-9]", key) is not None)
    ):
        return key, checked
    raise VerifyError(
        "INVALID_ARGUMENT",
        "press_key() takes one of "
        + ", ".join(f"'{name}'" for name in WEB_KEYS)
        + ", or a lowercase letter or digit with modifiers, such as "
        "press_key('a', modifiers=['ctrl']).",
    )


@dataclass(frozen=True)
class AgentControls:
    platform: DevicePlatform
    capture: Callable[[Deadline], tuple[bytes, str | None]]
    screen_size: Callable[[Deadline], ScreenSize]
    perform: Callable[[DeviceAction, str | None, Deadline], Point | None]


_VALIDATION_ATTEMPTS = 3
_NO_TOOL_LIMIT = 3
_ABORTING_CODES = {
    "SESSION_ENDED",
    "SESSION_BUSY",
    "AUTH_REJECTED",
    "EDGE_BLOCKED",
    "MODEL_ERROR",
    "TIMEOUT",
    "API_ERROR",
    "ACTION_UNCERTAIN",
}


def run_local_step(
    kind: Literal["instruction", "validation"],
    task: str,
    agent: LocalAgent,
    controls: AgentControls,
    deadline: Deadline,
    log: Callable[[str], None],
) -> tuple[bool, str | None, ModelRun]:
    name = agent.model.name
    turns: list[ModelTurn] = []
    history: list[str] = []
    size = controls.screen_size(deadline)
    tools = (
        [_VERDICT_TOOL]
        if kind == "validation"
        else _instruction_tools(controls.platform, agent.grounding)
    )
    offered = [tool.name for tool in tools]
    limit = _VALIDATION_ATTEMPTS if kind == "validation" else agent.max_turns
    system = (
        _validation_prompt(controls.platform)
        if kind == "validation"
        else _instruction_prompt(controls.platform, agent.grounding)
    )

    def run() -> ModelRun:
        return ModelRun(
            name,
            agent.grounding,
            turns,
            sum(turn.input_tokens for turn in turns),
            sum(turn.output_tokens for turn in turns),
        )

    without_tool = 0
    for turn in range(1, limit + 1):
        deadline.remaining()
        png, screen_token = controls.capture(deadline)
        image = fit_png(png, agent.max_image_side)
        model_started = time.monotonic()
        reply = agent.model.complete(
            ModelRequest(system, _turn_text(kind, task, image, history), image, tools),
            min(agent.model_timeout, deadline.remaining()),
        )
        model_seconds = time.monotonic() - model_started
        model_ms = round(model_seconds * 1000)

        def record(action: str, ok: bool, action_seconds: float = 0) -> None:
            turns.append(
                ModelTurn(
                    action,
                    ok,
                    model_seconds,
                    action_seconds,
                    reply.usage.input_tokens,
                    reply.usage.output_tokens,
                )
            )

        call = reply.tool_call
        if reply.truncated:
            raise VerifyError(
                "MODEL_ERROR",
                f"{name}'s reply was cut off at its output token cap "
                + (
                    "in the middle of a tool call, so Verify did not use it"
                    if call
                    else "before it called a tool"
                )
                + ". Pass the model to local_agent() through an adapter with a higher "
                "max_tokens, such as anthropic(model, max_tokens=8192) or "
                "openai_compatible(model, base_url=..., max_tokens=8192).",
            )
        if call is None:
            without_tool += 1
            if without_tool == _NO_TOOL_LIMIT:
                raise VerifyError(
                    "MODEL_ERROR",
                    f"{name} answered {_NO_TOOL_LIMIT} times in a row without calling a tool. "
                    "Pick a model that supports tool calls.",
                )
            record("no tool call", False)
            history.append(f"{turn}. You answered without calling a tool. Call exactly one tool.")
            log(f"  · turn {turn}: no tool call ({model_ms} ms)")
            continue
        without_tool = 0
        if call.name not in offered:
            record(call.name[:40], False)
            history.append(
                f"{turn}. {call.name[:40]}: failed: not one of the offered tools "
                f"({', '.join(offered)})."
            )
            log(f"  · turn {turn}: not an offered tool ({model_ms} ms)")
            continue
        if call.name in ("done", "verdict"):
            passed = call.arguments.get("success" if call.name == "done" else "passed") is True
            raw_reason = call.arguments.get("reason")
            reason = raw_reason[:1000] if isinstance(raw_reason, str) else None
            outcome = f"{call.name} {'true' if passed else 'false'}"
            record(outcome, True)
            log(f"  · turn {turn}: {outcome} ({model_ms} ms)")
            return passed, reason or None, run()
        action_started = time.monotonic()
        action = call.name
        ok = False
        try:
            device_action = _to_action(call, controls.platform, agent.grounding, image, size)
            action = _describe(device_action)
            at = controls.perform(device_action, screen_token, deadline)
            ok = True
            history.append(f"{turn}. {action}{f' at ({at.x}, {at.y})' if at else ''}: done.")
        except Exception as error:
            if isinstance(error, VerifyError) and error.code in _ABORTING_CODES:
                raise
            message = error.message if isinstance(error, VerifyError) else str(error)
            history.append(f"{turn}. {action}: failed: {message[:300]}")
        action_seconds = time.monotonic() - action_started
        record(action, ok, action_seconds)
        log(
            f"  · turn {turn}: {call.name}{'' if ok else ' (failed)'} "
            f"(model {model_ms} ms, action {round(action_seconds * 1000)} ms)"
        )
        deadline.pause(0.5 if controls.platform == "web" else 1)
    if kind == "validation":
        raise VerifyError("STEP_FAILED", f"{name} gave no verdict in {limit} attempts.")
    return False, f"{name} did not finish within {limit} turns.", run()


def fit_png(data: bytes, max_side: int) -> ModelImage:
    try:
        with Image.open(io.BytesIO(data)) as source:
            width, height = source.size
            factor = math.ceil(max(width, height) / max_side)
            if factor <= 1:
                return ModelImage(data, width, height)
            width, height = width // factor, height // factor
            reduced = (
                source.convert("RGBA").crop((0, 0, width * factor, height * factor)).reduce(factor)
            )
            output = io.BytesIO()
            reduced.save(output, format="PNG")
            return ModelImage(output.getvalue(), width, height)
    except (OSError, ValueError):
        raise VerifyError(
            "ACTION_FAILED", "Revyl returned a screenshot that is not a PNG."
        ) from None


def is_number(value: object) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def js_round(value: float) -> int:
    return math.floor(value + 0.5)


def _to_action(
    call: ModelToolCall,
    platform: DevicePlatform,
    grounding: Grounding,
    image: ModelImage,
    size: ScreenSize,
) -> DeviceAction:
    args = call.arguments

    def location(required: bool, prefix: str = "") -> Location | None:
        if grounding == "revyl":
            target = args.get(f"{prefix}target")
            if isinstance(target, str) and target.strip():
                return target.strip()[:500]
            if required:
                raise VerifyError(
                    "INVALID_ARGUMENT",
                    f"{prefix}target is required: describe the element by its visible text or "
                    "appearance.",
                )
            return None
        x, y = args.get(f"{prefix}x"), args.get(f"{prefix}y")
        if not is_number(x) or not is_number(y):
            if required:
                raise VerifyError("INVALID_ARGUMENT", f"{prefix}x and {prefix}y are required.")
            return None
        if x < 0 or y < 0 or x >= image.width or y >= image.height:
            raise VerifyError(
                "INVALID_ARGUMENT",
                f"({x}, {y}) is outside the {image.width}x{image.height} screenshot.",
            )
        return Point(
            js_round(x * size.width / image.width), js_round(y * size.height / image.height)
        )

    def required(prefix: str = "") -> Location:
        at = location(True, prefix)
        assert at is not None
        return at

    if call.name == "tap":
        return Tap(required())
    if call.name == "double_tap":
        return DoubleTap(required())
    if call.name == "long_press":
        return LongPress(required())
    if call.name == "type":
        text = args.get("text")
        if not isinstance(text, str):
            raise VerifyError("INVALID_ARGUMENT", "text is required.")
        return TypeText(required(), text, args.get("clear") is not False)
    if call.name == "type_focused":
        if platform != "web":
            raise VerifyError(
                "NOT_AVAILABLE_ON_PLATFORM",
                "type_focused is available only in a web browser; use type, which taps the "
                "field first.",
            )
        text = args.get("text")
        if not isinstance(text, str):
            raise VerifyError("INVALID_ARGUMENT", "text is required.")
        return TypeFocused(text, args.get("clear") is not False)
    if call.name == "drag":
        return Drag(required("from_"), required("to_"))
    if call.name == "swipe":
        direction = args.get("direction")
        if direction not in ("up", "down", "left", "right"):
            raise VerifyError("INVALID_ARGUMENT", "direction must be up, down, left or right.")
        return Swipe(cast(SwipeDirection, direction), location(False))
    if call.name == "press_key":
        if platform != "web":
            key = args.get("key")
            if key != "enter" and key != "backspace":
                raise VerifyError("INVALID_ARGUMENT", "key must be enter or backspace.")
            return PressKey(key)
        modifiers = args.get("modifiers")
        return PressKey(
            *check_key(platform, args.get("key"), () if modifiers is None else modifiers)
        )
    if call.name == "back":
        return Back()
    if call.name == "go_home":
        if platform == "web":
            raise VerifyError(
                "NOT_AVAILABLE_ON_PLATFORM",
                "A web browser has no home screen; use open_url to load a page.",
            )
        return GoHome()
    url = args.get("url")
    if not isinstance(url, str) or not url:
        raise VerifyError("INVALID_ARGUMENT", "url is required.")
    return OpenUrl(url)


def _describe(action: DeviceAction) -> str:
    def where(at: Location | None) -> str:
        if at is None:
            return ""
        return f' "{at}"' if isinstance(at, str) else f" ({at.x}, {at.y})"

    if isinstance(action, Tap):
        return f"tap{where(action.at)}"
    if isinstance(action, DoubleTap):
        return f"double tap{where(action.at)}"
    if isinstance(action, LongPress):
        return f"long press{where(action.at)}"
    if isinstance(action, (TypeText, TypeFocused)):
        text = action.text[:40] + "…" if len(action.text) > 40 else action.text
        into = where(action.at) if isinstance(action, TypeText) else " the focused field"
        return f"type {json.dumps(text, ensure_ascii=False)} into{into}"
    if isinstance(action, Swipe):
        return f"swipe {action.direction}" + (f" from{where(action.start)}" if action.start else "")
    if isinstance(action, Drag):
        return f"drag from{where(action.start)} to{where(action.end)}"
    if isinstance(action, PressKey):
        return "press " + "+".join([*action.modifiers, action.key])
    if isinstance(action, Back):
        return "back"
    if isinstance(action, GoHome):
        return "home"
    return f"open {action.url}"


_PLATFORM_LABEL = {"ios": "iPhone simulator", "android": "Android emulator", "web": "web browser"}


def _instruction_prompt(platform: DevicePlatform, grounding: Grounding) -> str:
    return "\n".join(
        [
            f"You operate a {_PLATFORM_LABEL[platform]} to carry out a task. Every turn you see "
            "the current screenshot and the actions taken so far, and you call exactly one tool.",
            "To point at an element, describe it in target by its visible text or look, "
            'for example "General row" or "Search field". Do not give coordinates.'
            if grounding == "revyl"
            else "To point at an element, give the pixel coordinates of its center in the "
            "screenshot, x to the right and y down from the top-left corner.",
            "Check the screenshot before each action: the previous action may not have done what "
            "you expected. To see content further down, swipe up.",
            "Call done with success true as soon as the screenshot shows the task is complete. "
            "Call done with success false and a reason if it cannot be done.",
        ]
    )


def _validation_prompt(platform: DevicePlatform) -> str:
    return (
        "You check whether a statement holds on the current screen of a "
        f"{_PLATFORM_LABEL[platform]}. Judge only what the screenshot shows, then call verdict "
        "with passed and a one-sentence reason."
    )


def _turn_text(
    kind: Literal["instruction", "validation"], task: str, image: ModelImage, history: list[str]
) -> str:
    lines = [
        f"Statement: {task}" if kind == "validation" else f"Task: {task}",
        f"The screenshot is {image.width}x{image.height} pixels.",
    ]
    if kind == "instruction":
        lines.append(
            "Actions so far:\n" + "\n".join(history[-30:]) if history else "No actions yet."
        )
    elif history:
        lines.append("Earlier attempts:\n" + "\n".join(history))
    return "\n".join(lines)


_VERDICT_TOOL = ModelTool(
    "verdict",
    "Report whether the statement holds on the screen.",
    {
        "type": "object",
        "properties": {"passed": {"type": "boolean"}, "reason": {"type": "string"}},
        "required": ["passed", "reason"],
    },
)


def _instruction_tools(platform: DevicePlatform, grounding: Grounding) -> list[ModelTool]:
    properties: dict[str, Json]
    if grounding == "revyl":
        properties = {
            "target": {"type": "string", "description": "The element, by its visible text or look."}
        }
        required: list[Json] = ["target"]
    else:
        properties = {
            "x": {"type": "integer", "description": "Screenshot pixel x."},
            "y": {"type": "integer", "description": "Screenshot pixel y."},
        }
        required = ["x", "y"]
    at: dict[str, Json] = {"type": "object", "properties": properties, "required": required}
    drag_properties: dict[str, Json] = {
        f"{prefix}{name}": schema
        for prefix in ("from_", "to_")
        for name, schema in properties.items()
    }
    drag_required: list[Json] = [
        f"{prefix}{name}" for prefix in ("from_", "to_") for name in required
    ]
    web = platform == "web"
    tools = [
        ModelTool("tap", "Tap an element.", at),
        ModelTool("double_tap", "Double-tap an element.", at),
        ModelTool(
            "long_press", "Press and hold an element, for example to open a context menu.", at
        ),
        ModelTool(
            "type",
            "Tap a text field and type into it. Clears the field first unless clear is false.",
            {
                "type": "object",
                "properties": {
                    **properties,
                    "text": {"type": "string"},
                    "clear": {"type": "boolean"},
                },
                "required": [*required, "text"],
            },
        ),
    ]
    if web:
        tools.append(
            ModelTool(
                "type_focused",
                "Type into the field that already has focus, without tapping. Clears the field "
                "first unless clear is false.",
                {
                    "type": "object",
                    "properties": {"text": {"type": "string"}, "clear": {"type": "boolean"}},
                    "required": ["text"],
                },
            )
        )
    tools += [
        ModelTool(
            "swipe",
            "Swipe from a point, or from the screen's center. up moves the finger up, "
            "which scrolls content down.",
            {
                "type": "object",
                "properties": {
                    "direction": {"type": "string", "enum": ["up", "down", "left", "right"]},
                    **properties,
                },
                "required": ["direction"],
            },
        ),
        ModelTool(
            "drag",
            "Press an element, move it to another place and release, for example to reorder a "
            "list or move a slider.",
            {"type": "object", "properties": drag_properties, "required": drag_required},
        ),
        ModelTool(
            "press_key",
            "Press a key on the focused element, optionally with modifiers held, such as "
            "escape, tab, arrowdown, or a with ctrl.",
            {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": f"One of {', '.join(WEB_KEYS)}, or a lowercase letter or "
                        "digit when modifiers are given.",
                    },
                    "modifiers": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["ctrl", "shift", "alt", "meta"]},
                    },
                },
                "required": ["key"],
            },
        )
        if web
        else ModelTool(
            "press_key",
            "Press a key on the focused field.",
            {
                "type": "object",
                "properties": {"key": {"type": "string", "enum": ["enter", "backspace"]}},
                "required": ["key"],
            },
        ),
    ]
    if platform != "ios":
        tools.append(
            ModelTool(
                "back",
                "Go back in browser history." if web else "Press the Android back button.",
                {"type": "object", "properties": {}},
            )
        )
    if not web:
        tools.append(
            ModelTool("go_home", "Go to the home screen.", {"type": "object", "properties": {}})
        )
    tools += [
        ModelTool(
            "open_url",
            "Load a URL in the current tab." if web else "Open a URL or deep link on the device.",
            {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
        ),
        ModelTool(
            "done",
            "Finish the task.",
            {
                "type": "object",
                "properties": {"success": {"type": "boolean"}, "reason": {"type": "string"}},
                "required": ["success", "reason"],
            },
        ),
    ]
    return tools


def _bounded(value: int, minimum: int, maximum: int, name: str) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise VerifyError(
            "INVALID_ARGUMENT",
            f"local_agent() {name} must be an integer from {minimum} to {maximum}.",
        )
