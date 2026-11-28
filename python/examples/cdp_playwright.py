"""Attach Playwright to a Verify web session over the Chrome DevTools Protocol (CDP).

    cd python && uv run python examples/cdp_playwright.py

Needs a Revyl sign-in (REVYL_API_KEY or 'revyl auth login'). Verify finds or creates the Revyl
web app for the URL's origin and logs its id. Playwright connects to Revyl's browser, so it needs
no browser download.
It starts a real, billable session.
"""

from playwright.sync_api import sync_playwright

from revyl_verify import Target, open

target = Target(platform="web", url="https://www.saucedemo.com")

with open(target) as session, sync_playwright() as playwright:
    endpoint = session.cdp()  # works for one connection, within 60 seconds
    browser = playwright.chromium.connect_over_cdp(endpoint.url)
    try:
        page = browser.contexts[0].pages[0]  # the session's own tab; new_context() is refused
        requests: list[str] = []
        page.on("request", lambda request: requests.append(request.url))
        page.goto("https://www.saucedemo.com")
        print(f"title: {page.title()}, {len(requests)} requests, the first {requests[0]}")

        # Sauce Demo publishes these practice credentials on its sign-in page.
        page.locator("#user-name").fill("standard_user")
        page.locator("#password").fill("secret_sauce")
        page.locator("#login-button").click()
        print(f"heading: {page.locator('.title').text_content()}")

        with page.expect_console_message() as message:
            page.evaluate("console.log('hello from Playwright')")
        print(f"console: {message.value.text}")

        session.validation("A list of products is shown")  # Verify steps work while attached
    finally:
        browser.close()  # only disconnects Playwright; session.close() ends the session
