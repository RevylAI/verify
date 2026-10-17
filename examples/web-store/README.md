# Web store example

Opens [Sauce Demo](https://www.saucedemo.com), a public practice store, in a Revyl cloud browser, signs in, adds a product to the cart, and checks the cart.

```bash
export REVYL_API_KEY=...            # or: revyl auth login
export REVYL_WEB_APP_ID=...         # a web app you created in Revyl
npm install
node verify/checkout.ts
```

Revyl's live web sessions do not run instruction and validation steps yet. Until they do, this script opens the store, saves `.verify/sign-in.png`, and then stops at the first step with `NOT_AVAILABLE_ON_PLATFORM`. It needs no change once Revyl enables steps on web. See [web.md](../../packages/verify/docs/web.md).
