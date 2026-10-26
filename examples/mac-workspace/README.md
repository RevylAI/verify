# Mac workspace example

Opens a Revyl Mac computer, checks `uname`, writes and reads a file, checks its size, and reads it through a command. It closes the computer in `finally`. No app id is needed.

Mac computers are **early access and not yet available in Revyl production**. They work only on Revyl staging for enabled organizations through the optional `REVYL_BACKEND_URL` override. Ask support@revyl.ai about access; no availability date is promised. Use credentials for that staging organization:

```bash
export REVYL_BACKEND_URL=https://backend-staging.revyl.ai
export REVYL_APP_URL=https://staging.revyl.ai
export REVYL_API_KEY=...            # or a Revyl CLI login for that environment
npm install
node verify/workspace.ts
```

Running the script starts a paid cloud computer. `npm run typecheck` only compiles it and makes no live requests. See [computers.md](../../packages/verify/docs/computers.md) for optional staging access, bounds, process handles, screenshots, and failure semantics. Instruction and validation steps are not available on computers. Linux supports the same SDK surface with `open({ platform: 'linux' })` or a config target, subject to staging organization/OS enablement; this Mac-specific example still checks macOS output.
