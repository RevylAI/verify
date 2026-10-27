# For coding agents

This page is for AI coding agents (Claude Code, Cursor, Codex, and others) that use Verify to check an app on a cloud browser/device or run commands and files on a Mac or Linux computer. The rest of this folder describes the API in full; this page is the workflow.

## Workflow

1. Read `verify.config.ts` to learn the target names and their platforms. If there is none, run `npx @revyl/verify init --platform <web|ios|android> --app-id <id>`, or `npx @revyl/verify init --platform mac` without an app id. You can also pass a target object to `open()`.
2. Check the credentials once with `npx @revyl/verify whoami`. It starts no session.
3. Write a short script, or extend an existing one, that opens one target, runs the steps you need, and closes:
   ```ts
   import { open } from '@revyl/verify';

   const session = await open('ios');
   try {
     await session.instruction('Sign in as the demo user');
     await session.validation('The dashboard shows at least one project card');
     await session.screenshot({ path: '.verify/dashboard.png' });
   } finally {
     await session.close();
   }
   ```
4. Run it with `node path/to/script.ts`. Share the session link from the first `[verify]` line with the user, so they can watch.
5. Read the outcome from the exit code and stderr. Each step prints `✓` or `✗` with its text; a failure prints `CODE: message`, ending with the session link. Look at any screenshot you saved before changing the script or the app.

## Rules

Mac and Linux computers are early access and not yet available in Revyl production. They work only on Revyl staging for organizations enabled for the requested OS through the optional `REVYL_BACKEND_URL` override with matching staging credentials. Read [availability and errors](computers.md#availability-and-errors) before starting a computer; do not try production or repeat an uncertain start/stop to probe availability.

For computer work, use structured `exec(['program', 'arg'])`, `readFile`, `writeFile`, `stat`, and run-owned handles from `processes()`/`terminate(id)`. Check command output with ordinary assertions and close in `finally`; screenshots are supported, but instruction/validation are not. Do not fall back to agent steps on computers or shell/file methods on mobile/web. See [computers.md](computers.md) for limits and staging setup. Linux uses inline targets or config entries; Linux init is intentionally unavailable. Starting a computer is a paid external action and needs the same approval as starting a device.

Computers have a hard 60-minute lifetime from create, not from readiness or activity. `expiresAt` is optional on older APIs; expiry does not prevent close. After terminal state and confirmed release, `recording()` can return private signed metadata or null, including after close. Never log or share its signed URL/query. Do not automatically wait for recordings or retry `COMPUTER_LIMIT` starts: queued work (including iOS) or the concurrency limit may be responsible.

- Write steps the way you would brief a person: what to do, or what should be true, in one sentence. Name visible things ("the blue Save button in the footer"), not implementation details.
- Use `instruction` for doing and `validation` for checking. Do not ask an instruction to check something, or a validation to change anything.
- Prefer several small steps to one long one. Small steps fail with clearer reasons and time out less.
- Each step stands alone: Revyl does not carry values from one step to the next. Put everything a step needs into its text.
- Every step runs Revyl's agent again; nothing is cached or replayed. Do not rerun a whole script to probe one step.
- Await each step. Two steps at once on one session throw `INVALID_ARGUMENT`.
- Do not catch `VerifyError` to make a check pass. A `NOT_AVAILABLE_ON_PLATFORM` error means the call is not offered on that platform; see [web.md](web.md) and [computers.md](computers.md). A `STEP_FAILED` error means the step did not run to an outcome, not that the app is wrong.
- Never automatically repeat a computer mutation after `ACTION_UNCERTAIN` or a timeout: the command may have run, and timeout does not prove termination or rollback. Do not log argv, stdin, file contents, or credentials.
- Always close what you open in `try/finally`. Each open session is paid. Automatic cleanup is best effort with a 15-second bound and skips signal/error events that already have listeners. Device close acknowledges stop, while computer close requires confirmed terminal release.
- Never put secrets in scripts or config. Credentials come from `REVYL_API_KEY` or a Revyl CLI login; web sign-in uses the **name** of a Revyl organization secret.
- Step descriptions are sent to Revyl and logged to stderr by default. Do not include private credentials or customer data in instruction or validation text; use test-only sign-in and synthetic data instead. `log: false` suppresses local progress, not remote processing or reports.
