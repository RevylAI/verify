# A Mac that remembers
> Needs `@revyl/verify` 0.8.0 or later.

Builds a Swift file and signs in to a demo site on a persistent cloud Mac, closes it, reopens it with both still there, then deletes it. Persistent computers are enabled per organization; ask support@revyl.ai. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY`.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/guides/persistent-computers#dev-environment
