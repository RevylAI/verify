"""Run Verify steps on your own model, then exact actions, on a Revyl cloud iPhone.

    cd python && uv run python examples/byo_model.py

Needs a Revyl sign-in (REVYL_API_KEY or 'revyl auth login') and the key for MODEL's
provider, ANTHROPIC_API_KEY for the default 'anthropic/claude-sonnet-5-5'.
"""

import os

from revyl_verify import Target, open

with open(
    Target(platform="ios", bundle_id="com.apple.Preferences"),
    model=os.environ.get("MODEL", "anthropic/claude-sonnet-5-5"),
) as session:
    step = session.instruction("Open General, then About")
    if step.model:
        print(
            f"{len(step.model.turns)} turns, {step.model.input_tokens} input and "
            f"{step.model.output_tokens} output tokens on {step.model.id}"
        )
    session.validation("The screen shows the iOS version")

    session.tap("Back button")
    session.swipe("up")
    session.screenshot(path=".verify/settings.png")
