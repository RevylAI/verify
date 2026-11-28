# Web CDP example

Attaches [Playwright](https://playwright.dev) to a Revyl cloud browser over the Chrome DevTools Protocol (CDP), next to Verify's steps. It opens [Sauce Demo](https://www.saucedemo.com), a public practice store, with Verify, then uses Playwright to listen for network requests and a console message, sign in with locators and read the page heading. While Playwright is attached it runs a Verify validation, then it disconnects Playwright and closes the session.

Web is available to every organization, and the target needs only the URL: on the first run Verify finds or creates one Revyl web app for its origin and prints its id, which `appId` in `verify.config.ts` pins. See [web.md](../../packages/verify/docs/web.md).

```bash
export REVYL_API_KEY=...            # or: revyl auth login
npm install
node verify/playwright.mts
```

`playwright-core` is enough: Playwright connects to Revyl's browser, so it downloads no browser of its own. The rules for CDP on a Verify session, such as using the session's own page and connecting once per `cdp()` call, are in [the API reference](../../packages/verify/docs/api.md#cdp-playwright-puppeteer). Against a backend without CDP, `cdp()` throws `NOT_AVAILABLE_ON_PLATFORM`.
