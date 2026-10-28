# Mac workspace example

Opens a Revyl Mac computer, checks `uname`, writes and reads a file, checks its size, and reads it through a command. It closes the computer in `finally`. No app id is needed.

Mac computers are **early access**. Ask support@revyl.ai about access before running this example:

```bash
export REVYL_API_KEY=...            # or: revyl auth login
npm install
node verify/workspace.ts
```

Running the script starts a paid cloud computer. `npm run typecheck` only compiles it and makes no live requests. See [computers.md](../../packages/verify/docs/computers.md) for bounds, process handles, screenshots, and failure semantics. Instruction and validation steps are not available on computers. Linux supports the same SDK surface with `open({ platform: 'linux' })` or a config target; this Mac-specific example still checks macOS output.
