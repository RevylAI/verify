# For coding agents

This page is for AI coding agents (Claude Code, Cursor, Codex, and others) that use Verify to check an app on a real browser or device. The rest of this folder describes the API in full; this page is the workflow.

## Workflow

1. Read `verify.config.ts` to learn the target names and their platforms. If there is none, run `npx @revyl/verify init --platform <web|ios|android> --app-id <id>`, or pass a target object to `open()`.
2. Check the credentials once with `npx verify whoami`. It starts no session.
3. Write a short script, or extend an existing one, that opens one target, runs the steps you need, and closes:
   ```ts
   import { open } from '@revyl/verify';

   const session = await open('ios');
   await session.instruction('Sign in as the demo user');
   await session.validation('The dashboard shows at least one project card');
   await session.screenshot({ path: '.verify/dashboard.png' });
   await session.close();
   ```
4. Run it with `node path/to/script.ts`. Share the session link from the first `[verify]` line with the user, so they can watch.
5. Read the outcome from the exit code and stderr. Each step prints `✓` or `✗` with its text; a failure prints `CODE: message`, ending with the session link. Look at any screenshot you saved before changing the script or the app.

## Rules

- Write steps the way you would brief a person: what to do, or what should be true, in one sentence. Name visible things ("the blue Save button in the footer"), not implementation details.
- Use `instruction` for doing and `validation` for checking. Do not ask an instruction to check something, or a validation to change anything.
- Prefer several small steps to one long one. Small steps fail with clearer reasons and time out less.
- Each step stands alone: Revyl does not carry values from one step to the next. Put everything a step needs into its text.
- Every step runs Revyl's agent again; nothing is cached or replayed. Do not rerun a whole script to probe one step.
- Await each step. Two steps at once on one session throw `INVALID_ARGUMENT`.
- Do not catch `VerifyError` to make a check pass. A `NOT_AVAILABLE_ON_PLATFORM` error means Revyl does not offer the call on that platform yet; see [web.md](web.md).
- Always close what you open. Each open session is a paid cloud browser or device.
- Never put secrets in scripts or config. Credentials come from `REVYL_API_KEY` or a Revyl CLI login; web sign-in uses the **name** of a Revyl organization secret.
