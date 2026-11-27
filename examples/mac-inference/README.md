# Mac inference example

Opens a Revyl Mac computer with its own vision model (`inference: true`), checks its screen with `validation()`, and reads the menu bar date with `extract()`. Both run on the Mac's model, so they carry no inference charge; you pay the Mac's minutes. When `IOS_APP_ID` and `IOS_BUILD_ID` name an iOS app and build in Revyl, it also opens that app inside the Mac, where its validation runs on the same model by default, and prints which model answered. It closes everything in `finally`.

It needs an organization on a paid Revyl plan, which comes with Mac computers and local inference; if yours can't open one, upgrade its plan. To run it:

```bash
export REVYL_API_KEY=...            # or: revyl auth login
export IOS_APP_ID=... IOS_BUILD_ID=...   # optional
npm install
node verify/checks.ts
```

Running the script starts a paid cloud computer. `npm run typecheck` only compiles it and makes no live requests. See [the Mac model guide](../../packages/verify/docs/guides/mac-model-checks.md) and [apps inside an inference Mac](../../packages/verify/docs/guides/apps-inside-an-inference-mac.md).
