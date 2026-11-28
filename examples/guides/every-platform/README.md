# One script, every platform

Runs one check each on a cloud browser, an iOS simulator and an Android emulator, all at once, and prints each platform's result. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY`. The web session needs no Revyl app made first: Verify finds or creates one for the URL and prints its id.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/guides/every-platform
