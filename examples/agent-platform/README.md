# Build a small agent platform

One task fans out to a cloud browser and an iOS simulator through `@revyl/verify`. Each target runs an instruction and a validation, saves screenshots, closes its session, then uses the **Revyl CLI** to collect its report and recording. A local results page opens automatically and updates as the work happens.

## Run it

You need Node.js **22.18+**, the [Revyl CLI](https://docs.revyl.com/cli), and a Revyl account with web and mobile session access. No Xcode, Android SDK, extra app IDs, or mobile builds are needed.

From the repository root, install and build once:

```sh
npm ci
npm run build
cd examples/agent-platform
```

With `REVYL_API_KEY` already set securely, run:

```sh
npm run demo
```

Alternatively, sign in once with `revyl auth login` before running. Don't mix an environment key with a browser login that overrides a different account. Authentication is server-side; the browser never receives your API key.

**This starts two billable cloud sessions.** The first run also creates a reusable web app named `Verify Agent Platform Demo` in your selected organization; later runs reuse it. Verify registers the public TodoMVC URL as a build. There is no automatic retry that starts another session. The built-in iOS Settings app needs no upload. Both targets close in `finally`; inspect any reported stop failure before starting again.

```sh
npm run demo -- --android             # three sessions: web + iOS + Android
npm run mock                         # synthetic UI rehearsal, no account or sessions
npm run demo -- --no-open             # print the results URL without opening a browser
node quick-check.ts                  # one separate iOS session, the minimal SDK example
```

The default plan adds a task to Playwright's public TodoMVC app on web and checks the operating-system version in mobile Settings. Neither fixture requires credentials. These are **different smoke checks**, not the same flow across three apps. Edit `plans()` and the inline targets in `demo.ts` to use your own apps. An optional positional string changes the task's display label, not its plan; this example is an orchestrator, not a task-planning LLM.

## What to inspect

- The terminal prints viewer links as sessions start and an outcome per step.
- The page shows each target independently, including failures, screenshots, an inline recording, a Revyl report link, and the JSON report download.
- `evidence.ts` calls `revyl device report --session-id <id> --json`. Recordings finalize asynchronously after stop, so the example polls for up to two minutes. A missing recording is reported as missing evidence, never as a passed check or a reason to start another session.
- Evidence lives under this example's ignored `.verify/agent-platform/` directory. The recording is downloaded without forwarding API credentials; signed storage URLs stay out of terminal output and the page's links. Raw reports can contain short-lived signed URLs: treat the directory as private, don't commit it, and don't publicly expose the local server.

The page stays open until **Ctrl+C**. Rerun the command for another take; each live rerun starts fresh sessions. Delete the local `.verify/agent-platform/` folder when its evidence is no longer needed. The dedicated web app remains in Revyl for reuse.

This is a loopback-only, single-task example, not a multi-tenant service. Before hosting it for customers, add authentication, per-customer authorization, budgets/concurrency limits, durable jobs, and an evidence-retention policy. Report links require Revyl access; they aren't anonymous customer share links. The local page demonstrates handing evidence back through your own UI.

## Check it

```sh
npm run typecheck
npm run smoke
npm run mock -- --no-open
```

The root CI's workspace typecheck includes this example. No published SDK code is changed.
