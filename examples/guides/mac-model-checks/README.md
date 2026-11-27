# Checks on the Mac's own model
> Needs `@revyl/verify` 0.8.0 or later.

Opens a cloud Mac with its own model, opens a document in TextEdit, then runs a validation and an extract on the Mac and prints which engine answered. Local inference comes with paid Revyl plans. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY`.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/guides/mac-model-checks
