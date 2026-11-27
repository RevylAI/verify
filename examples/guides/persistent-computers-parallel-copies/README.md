# Parallel Macs from one snapshot
> Needs `@revyl/verify` 0.8.0, which isn't on npm yet.

Prepares one persistent cloud Mac, saves it as a snapshot, starts 2 copies from it in parallel, runs a shard on each, then deletes the copies and the snapshot. Persistent computers are enabled per organization; ask support@revyl.ai. Needs Node.js 22.18 or later.

1. `cp .env.example .env` and fill in `REVYL_API_KEY`.
2. `npm install`
3. `npm start`

Guide: https://docs.revyl.com/verify/guides/persistent-computers#parallel-copies
