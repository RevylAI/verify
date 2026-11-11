"""A custom local agent: an OpenAI-compatible endpoint, a turn cap and coordinates from the model.

    ollama pull qwen3-vl:8b && cd python && uv run python examples/custom_agent.py

Defaults to Ollama on this machine; set MODEL_BASE_URL and MODEL for another endpoint.
"""

import os

from revyl_verify import Target, local_agent, open, openai_compatible

agent = local_agent(
    openai_compatible(
        os.environ.get("MODEL", "qwen3-vl:8b"),
        base_url=os.environ.get("MODEL_BASE_URL", "http://localhost:11434/v1"),
    ),
    grounding="model",
    max_turns=10,
)

with open(Target(platform="ios", bundle_id="com.apple.Preferences"), agent=agent) as session:
    session.instruction("Open General, then About")
    session.validation("The screen shows the iOS version")
