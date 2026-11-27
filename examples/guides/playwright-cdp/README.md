# Playwright for the clicks, Revyl for the judgment

Attaches Playwright to a Revyl cloud browser over CDP to sign in and add to the cart, then checks the page with one Verify validation. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY` and `WEB_APP_ID`, the id of a web app you created in Revyl.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/guides/playwright-cdp
