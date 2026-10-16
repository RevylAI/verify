# Web store example

Tests [Sauce Demo](https://www.saucedemo.com), a public practice store, in a Revyl cloud browser.

```bash
export REVYL_API_KEY=...            # or: revyl auth login
export REVYL_WEB_APP_ID=...         # a web app you created in Revyl
npm install
npx verify run
```

Web locators are resolved by Revyl's AI grounding model, so these tests describe elements the way a person would. Agent steps (`agent.act`, `agent.assert`) are left out because Revyl's live web sessions do not run them yet; see [web.md](../../packages/verify/docs/web.md).
