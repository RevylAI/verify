# Your iOS app, checked on the Mac's model
> Needs `@revyl/verify` 0.8.0 or later.

Opens your iOS app on a simulator inside a cloud Mac with its own model, then prints which engine answered a validation and an extract. Local inference comes with paid Revyl plans. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY`, `IOS_APP_ID` and `IOS_BUILD_ID` from your app's page in Revyl.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/guides/apps-inside-an-inference-mac
