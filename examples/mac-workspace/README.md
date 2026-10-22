# Mac workspace example

Opens a Revyl Mac computer, checks `uname`, writes and reads a file, checks its size, and reads it through a command. It closes the computer in `finally`. No app id is needed.

Computers must be enabled for your organization. This API is on Revyl staging; production support depends on its promotion. With credentials for that staging organization:

```bash
export REVYL_BACKEND_URL=https://backend-staging.revyl.ai
export REVYL_APP_URL=https://staging.revyl.ai
export REVYL_API_KEY=...            # or a Revyl CLI login for that environment
npm install
node verify/workspace.ts
```

Running the script starts a paid cloud computer. `npm run typecheck` only compiles it and makes no live requests. See [computers.md](../../packages/verify/docs/computers.md) for bounds, process handles, screenshots, and failure semantics. Instruction and validation steps are not available on computers; Linux is a contract only and cannot be opened yet.
