# Bring your own model

Runs an instruction and a validation on a cloud iOS simulator with your own Claude model instead of Revyl's agent, then prints which model ran each step. Proven on Claude models; not available on Mac computers. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY` and your own `ANTHROPIC_API_KEY`.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/own-model
