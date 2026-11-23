# Web CDP example

Attaches [Playwright](https://playwright.dev) to a Revyl cloud browser over the Chrome DevTools Protocol (CDP), next to Verify's steps. It opens [Sauce Demo](https://www.saucedemo.com), a public practice store, with Verify, then uses Playwright to listen for network requests and a console message, sign in with locators and read the page heading. While Playwright is attached it runs a Verify validation, then it disconnects Playwright and closes the session.

Web is available to every organization. Create the Web app first; see [Create the Web app](../../packages/verify/docs/web.md#create-the-web-app).

```bash
export REVYL_API_KEY=...            # or: revyl auth login
export REVYL_WEB_APP_ID=...         # a web app you created in Revyl
npm install
node verify/playwright.ts
```

`playwright-core` is enough: Playwright connects to Revyl's browser, so it downloads no browser of its own. The rules for CDP on a Verify session, such as using the session's own page and connecting once per `cdp()` call, are in [the API reference](../../packages/verify/docs/api.md#cdp-playwright-puppeteer). Against a backend without CDP, `cdp()` throws `NOT_AVAILABLE_ON_PLATFORM`.
