# Mac workspace example

Opens a Revyl Mac computer, checks `uname`, writes and reads a file, checks its size, and reads it through a command. It closes the computer in `finally`. No app id is needed.

Mac computers are available to organizations on a current paid Revyl plan. If yours can't start one, ask support@revyl.ai. To run this example:

```bash
export REVYL_API_KEY=...            # or: revyl auth login
npm install
node verify/workspace.mts
```

Running the script starts a paid cloud computer. `npm run typecheck` only compiles it and makes no live requests. See [computers.md](../../packages/verify/docs/computers.md) for bounds, process handles, screenshots, and failure semantics. `instruction()` is not available on computers; `validation()` and `extract()` work on a Mac opened with `inference: true`, as in [mac-inference](../mac-inference).
