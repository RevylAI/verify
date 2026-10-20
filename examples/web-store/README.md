# Web store example

Opens [Sauce Demo](https://www.saucedemo.com), a public practice store, in a Revyl cloud browser, signs in, adds a product to the cart, and checks the cart.

```bash
export REVYL_API_KEY=...            # or: revyl auth login
export REVYL_WEB_APP_ID=...         # a web app you created in Revyl
npm install
node verify/checkout.ts
```

Instruction and validation steps on web run on Revyl staging now and reach Revyl production when Revyl promotes staging to main. To run the whole script on staging, set `REVYL_BACKEND_URL`, `REVYL_APP_URL`, and a staging `REVYL_API_KEY` as [web.md](../../packages/verify/docs/web.md) shows, with `REVYL_WEB_APP_ID` naming a web app in your staging organization. Against a Revyl backend without steps on web, the script opens the store, saves `.verify/sign-in.png`, and stops at the first step with `NOT_AVAILABLE_ON_PLATFORM`.
