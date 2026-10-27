# Build a small agent platform

One task fans out to a cloud browser and an iOS simulator through `@revyl/verify`. Each target runs an instruction and a validation, saves screenshots, closes its session, then uses the **Revyl CLI** to collect its report and recording. A local results page opens automatically and updates as the work happens.

## Run it

You need Node.js **22.18+**, the [Revyl CLI](https://docs.revyl.com/cli), and a Revyl account with web and mobile session access. No Xcode, Android SDK, extra app IDs, or mobile builds are needed.

This checkout uses the local workspace SDK (**0.2.0**). From the repository root, install and build once, before loading any API credentials:

```sh
npm ci
npm run build
cd examples/agent-platform
```

For an interactive terminal or screen recording, use the CLI's stored login and launch Node directly:

```sh
unset REVYL_API_KEY
revyl auth login
node demo.ts
```

Finish login before recording and verify the selected organization with `revyl auth status`. Never type an API key into a command, paste it into a terminal, or display credential files. Unsetting `REVYL_API_KEY` selects the stored login instead of leaving a second account in the environment. Authentication is server-side; the results page never receives your API key.

Avoid `npm run demo` when the process inherits secrets: npm rewrites its process title, and macOS Terminal's argument display can expose inherited environment text after that rewrite. Direct Node launch avoids this observed trigger; it is not a guarantee that a secret-bearing process environment is safe to record. Keep credentials out of dependency installation and build processes too. For unattended use, Verify also accepts a securely injected `REVYL_API_KEY`; don't record that environment or dump process metadata.

**This starts two billable cloud sessions.** The first run also creates a reusable web app named `Verify Agent Platform Demo` in your selected organization; later runs reuse it. Verify registers the public TodoMVC URL as a build. There is no automatic retry that starts another session. The built-in iOS Settings app needs no upload. Both targets close in `finally`; inspect any reported stop failure before starting again.

```sh
node demo.ts --android               # three sessions: web + iOS + Android
node demo.ts --mock                  # synthetic UI rehearsal, no account or sessions
node demo.ts --no-open               # print the results URL without opening a browser
node quick-check.ts                  # one separate iOS session, the minimal SDK example
```

The default plan adds a task to Playwright's public TodoMVC app on web and checks the operating-system version in mobile Settings. Neither fixture requires credentials. These are **different smoke checks**, not the same flow across three apps. Edit `plans()` and the inline targets in `demo.ts` to use your own apps. An optional positional string changes the task's display label, not its plan; this example is an orchestrator, not a task-planning LLM.

## What to inspect

- The terminal prints viewer links as sessions start and an outcome per step.
- The page shows each target independently, including failures, screenshots, an inline recording, a Revyl report link, and the JSON report download.
- `evidence.ts` calls `revyl device report --session-id <id> --json`. Recordings finalize asynchronously after stop, so the example polls for up to two minutes. A missing recording is reported as missing evidence, never as a passed check or a reason to start another session.
- A failed recording download preserves the collected report and JSON download, displays an evidence warning, and removes any partial video. It does not change a step's validation result or start another session.
- Evidence lives under this example's ignored `.verify/agent-platform/` directory. The recording is downloaded without forwarding API credentials; signed storage URLs stay out of terminal output and the page's links. Raw reports can contain short-lived signed URLs: treat the directory as private, don't commit it, and don't publicly expose the local server.

The page stays open until **Ctrl+C**. Rerun the command for another take; each live rerun starts fresh sessions. Delete the local `.verify/agent-platform/` folder when its evidence is no longer needed. The dedicated web app remains in Revyl for reuse.

This is a loopback-only, single-task example, not a multi-tenant service. Before hosting it for customers, add authentication, per-customer authorization, budgets/concurrency limits, durable jobs, and an evidence-retention policy. Report links require Revyl access; they aren't anonymous customer share links. The local page demonstrates handing evidence back through your own UI.

## Check it

Run these checks before loading credentials:

```sh
npm run typecheck
npm run smoke
node demo.ts --mock --no-open
```

The root CI's workspace typecheck includes this example. No published SDK code is changed.
