# Web store example

Opens [Sauce Demo](https://www.saucedemo.com), a public practice store, in a Revyl cloud browser, signs in, adds a product to the cart, and checks the cart.

```bash
export REVYL_API_KEY=...            # or: revyl auth login
export REVYL_WEB_APP_ID=...         # a web app you created in Revyl
npm install
node verify/checkout.ts
```

The script uses the default Revyl service. `REVYL_WEB_APP_ID` names the web app in Revyl. Against a backend without web steps, the script stops at its first step with `NOT_AVAILABLE_ON_PLATFORM`.
