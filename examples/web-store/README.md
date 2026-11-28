# Web store example

Opens [Sauce Demo](https://www.saucedemo.com), a public practice store, in a Revyl cloud browser, signs in, adds a product to the cart, and checks the cart.

Web is available to every organization, and the target needs only the URL: on the first run Verify finds or creates one Revyl web app for its origin and prints its id, which `appId` in `verify.config.ts` pins. See [web.md](../../packages/verify/docs/web.md).

```bash
export REVYL_API_KEY=...            # or: revyl auth login
npm install
node verify/checkout.mts
```

The script uses the default Revyl service. Against a backend without web steps, the script stops at its first step with `NOT_AVAILABLE_ON_PLATFORM`.
