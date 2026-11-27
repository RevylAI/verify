# Playwright for the clicks, Revyl for the judgment

A Verify web session runs in a Revyl cloud browser, and `session.cdp()` hands you a Chrome DevTools Protocol endpoint for that browser. Attach Playwright to it, drive the page with selectors you already trust, and ask Verify whether the result looks right in plain language. The session's link records both.

Works with TypeScript `@revyl/verify` 0.7.1 and Python `revyl-verify` 0.5.1, and Go `github.com/RevylAI/verify/go` v0.6.1 with chromedp.

## What you'll build

A script that opens a cloud browser on [Sauce Demo](https://www.saucedemo.com), attaches Playwright, signs in with the site's published practice account and adds a product to the cart, then runs one Verify validation on what the page shows.

## Before you start

- A Revyl account, signed in with `npx @revyl/verify login` or with `REVYL_API_KEY` set.
- A Revyl web app id in `WEB_APP_ID` (see [every platform](every-platform.md#before-you-start)).
- Node.js 22.18 or later and, in an ESM project, `npm install @revyl/verify playwright-core`. `playwright-core` is enough: the browser runs in Revyl, so nothing is downloaded.

## The script

Save this as `playwright-cdp.ts`:

```ts
import { open } from '@revyl/verify';
import { chromium } from 'playwright-core';

const target = { platform: 'web', app: { appId: process.env.WEB_APP_ID ?? '', url: 'https://www.saucedemo.com' } } as const;

const session = await open(target);
console.log(`Live view: ${session.viewerUrl}`);
try {
  const { url } = await session.cdp();
  const browser = await chromium.connectOverCDP(url);
  try {
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.locator('#user-name').fill('standard_user');
    await page.locator('#password').fill('secret_sauce');
    await page.locator('#login-button').click();
    await page.locator('#add-to-cart-sauce-labs-backpack').click();
    console.log(`Playwright: signed in and added the backpack on ${new URL(page.url()).pathname}`);

    const check = await session.validation('The cart icon shows 1 item and the backpack button now says Remove.');
    console.log(`Validation passed: ${check.passed}. ${check.reason ?? ''}`);
    await session.screenshot({ path: 'cart.png' });
  } finally {
    await browser.close();
  }
} finally {
  await session.close();
}
```

Run it with `WEB_APP_ID=<your web app id> node playwright-cdp.ts`:

```text
[verify] web: starting web session https://app.revyl.ai/sessions/<id>
[verify] web: ready
Live view: https://app.revyl.ai/sessions/<id>
Playwright: signed in and added the backpack on /inventory.html
[verify] web: ✓ validation "The cart icon shows 1 item and the backpack button now says Remove." (14.9s)
Validation passed: true. … The shopping cart badge displays '1', and the button for the Sauce Labs Backpack displays 'Remove'.
[verify] web: closed
```

The whole run takes about 40 seconds.

## How it works

- **`cdp()` returns a single-use url.** It accepts one connection and expires 60 seconds after `cdp()` returns, so connect right away, and call `cdp()` again for each new connection or retry. Treat it as a credential: don't log or store it.
- **Use the session's own page.** `browser.contexts()[0].pages()[0]` is the tab Verify's steps and the recording follow. `browser.newContext()` is refused, because a session has one browser context.
- **`browser.close()` only disconnects.** The session keeps running, so `session.close()` in the outer `finally` ends it.
- **Verify keeps working while Playwright is attached.** `validation()`, `instruction()`, `screenshot()` and the exact actions all run on the same page.

Locators, DOM access, `evaluate`, console and network events, request interception and screenshots work as with a local Chrome.

## Python

```python
import os

from playwright.sync_api import sync_playwright  # pip install playwright; no browser download

from revyl_verify import Target, open

web = Target(platform="web", app_id=os.environ["WEB_APP_ID"], url="https://www.saucedemo.com")
with open(web) as session:
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(session.cdp().url)
        page = browser.contexts[0].pages[0]
        page.locator("#user-name").fill("standard_user")
        page.locator("#password").fill("secret_sauce")
        page.locator("#login-button").click()
        page.locator("#add-to-cart-sauce-labs-backpack").click()
        session.validation("The cart icon shows 1 item and the backpack button now says Remove.")
        browser.close()  # only disconnects Playwright; leaving the with block ends the session
```

## Go

`s.CDP(ctx)` returns the same single-use endpoint. Pass `endpoint.URL` to chromedp with `remote.NewAllocator(ctx, endpoint.URL, remote.NoModifyURL)` from `github.com/chromedp/chromedp/remote`, then attach to the session's tab. The [Go README](https://github.com/RevylAI/verify/blob/main/go/README.md#cdp-playwright-puppeteer) has the complete chromedp program.

## Limits and errors

- **One connection at a time.** A second connection to the same session is refused until the first disconnects.
- **The window size is fixed.** Viewport emulation such as `page.setViewportSize()` is refused; set the target's `viewport` instead.
- **Navigation is http(s) and `about:blank` only**, downloads are off, and a reply over 24 MB is dropped. Refusals are CDP errors that start with `Revyl:`.
- **Web only.** `cdp()` throws `NOT_AVAILABLE_ON_PLATFORM` on iOS, Android and Mac computers; after `close()` it throws `SESSION_ENDED`.

[api.md](../api.md#cdp-playwright-puppeteer) lists every rule.

## Clean up

`browser.close()` disconnects Playwright and `session.close()` ends the session, each in its own `finally`. The CDP connection ends with the session.

## Next

- [Signed in from the first step](session-profiles.md) to skip the login form.
- [A cloud Mac your agent can drive](mac-computer.md).
