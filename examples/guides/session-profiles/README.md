# Signed in from the first step

Opens a cloud browser with the `signed-in` profile, which signs in to a demo site's public test account first, then validates the signed-in page. Needs Node.js 22.18 or later.

1. Set `project.id` in `.revyl/config.yaml` to your Revyl project's id.
2. `cp .env.example .env` and fill in `REVYL_API_KEY` and `WEB_APP_ID`, a web app you created in Revyl.
3. `npm install`, then `npm start`

Guide: https://docs.revyl.com/verify/guides/session-profiles
