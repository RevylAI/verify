"""Check a Revyl Mac computer's screen with the Mac's own vision model, then an iOS app inside it.

    cd python && uv run python examples/mac_inference.py

Needs REVYL_API_KEY (or a saved Revyl login from 'revyl auth login') and an organization on a
paid Revyl plan, which comes with Mac computers and local inference. It starts a real,
billable Mac computer. Set IOS_APP_ID and IOS_BUILD_ID to also open that iOS build inside the
Mac, where its steps run on the Mac's model first by default.
"""

import os

from revyl_verify import Target, open

mac = open(Target(platform="mac", inference=True))
try:
    print(f"inference: {mac.inference}")  # "ready", "unavailable" or "unknown"
    mac.validation("The Dock is visible at the bottom of the screen")
    date = mac.extract("the date at the right end of the menu bar")
    print(f"menu bar date: {date.value} (engine: {date.engine})")

    app_id, build_id = os.environ.get("IOS_APP_ID"), os.environ.get("IOS_BUILD_ID")
    if app_id and build_id:
        with mac.open(Target(platform="ios", app_id=app_id, build_id=build_id)) as app:
            step = app.validation("The app's first screen is showing", soft=True)
            print(f"app validation passed: {step.passed} (engine: {step.engine})")
finally:
    mac.close()
