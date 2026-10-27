# Verify working end to end

These live runs were made on **2026-10-27**, using source commit [`6029513369f13e73914b550d0cd26ece615b4e13`](https://github.com/RevylAI/verify/tree/6029513369f13e73914b550d0cd26ece615b4e13). They are baseline evidence, not live verification of subsequent fixes or proof that npm 0.2.0 has been published. The separate published-package check used `@revyl/verify@0.1.0`.

Only reviewed public scripts, sanitized transcripts, result projections, and two reviewed screenshots were used here. No private reports, device identifiers, session links, signed recording URLs, or recordings are published.

## Live results

Web, iOS, and Android ran in production. Mac and Linux ran on staging with early-access access enabled; computers are not yet available in production. Durations below are observed script wall times, not performance targets.

| SDK | Platform and workload | Result | Total time | Cleanup |
| --- | --- | --- | --- | --- |
| TypeScript source | Web: add a TodoMVC task, validate it, capture PNG | Passed | 66.6 s | Stop acknowledged |
| TypeScript source | iOS Settings: General → About, validate OS version, capture PNG | Passed | 66.3 s | Stop acknowledged |
| TypeScript source | Android Settings: About, validate visible OS version, capture PNG | Passed | 88.2 s | Stop acknowledged |
| Go source | Web: same TodoMVC task, validation, PNG | Passed | 67.7 s | Stop acknowledged |
| Go source | iOS Settings: General → About, OS-version validation, PNG | Passed | 75.3 s | Stop acknowledged |
| TypeScript source | Mac: command, file round-trip, PNG | Passed | 18.3 s | Terminal state and release confirmed |
| Go source | Mac: command, file round-trip, PNG | Passed | 18.0 s | Terminal state and release confirmed |

Every passing web/mobile row includes a passing instruction and validation plus a captured screenshot. Device close acknowledges the stop request; it does not itself prove physical release. The computer reports independently recorded `state: stopped` and `release: confirmed`.

### Web proof

The instruction was `Add a task named Verify readiness proof to the todo list.` The validation was `The todo list contains an active task named Verify readiness proof.` Both SDKs passed. The TypeScript transcript records:

```json
{"platform":"web","status":"passed","close":"acknowledged","steps":[{"type":"instruction","passed":true,"durationMs":42564},{"type":"validation","passed":true,"durationMs":14669}],"totalDurationMs":66633}
```

![The live TodoMVC screenshot shows the active Verify readiness proof task](https://api-nightly.capy.ai/pr-assets/QpzIwvNb-A7Q2trQyL5ZDGgscNuM2kS5Gju_uLiLs0I.png)

### Mobile proof and the Android recipe

The iOS scripts launched `com.apple.Preferences`, instructed `Open General, then About.`, then validated `The screen shows the operating system version.` TypeScript and Go both passed.

The TypeScript Android run passed the OS-version validation. The Go Android run did **not**: About opened, but the version was offscreen, so `VALIDATION_FAILED` was the correct outcome. Its corrected recipe must explicitly scroll or navigate until the version is visible before validating it; that changed recipe is pending live re-verification and is not listed as a pass.

For example, the maintained [Settings example](https://github.com/RevylAI/verify/tree/main/examples/mobile-settings) now asks the agent to open About **and scroll or navigate until the operating system version is visible**. Validating a screen immediately after navigation is not a substitute for bringing the specific fact into view.

### Mac proof

Both SDKs opened a Mac computer, ran `uname -a` with exit code 0, wrote `Verify readiness proof\n` to a workspace-relative file, read back identical bytes, captured a PNG, and closed with confirmed release. They used argv arrays, not an implicit shell. This proves those operations for those runs; it does not establish process-control behavior or future host capacity.

## Affected cases awaiting re-verification

The release changes three paths that must be checked again against the new head. Their earlier results are retained as failures or caveated observations, not silently promoted to successes:

- **Generated iOS example:** published 0.1.0 failed twice with `VALIDATION_FAILED` on a blank white screen. Its screenshot came from the failed validation report because the script's later screenshot line was never reached. The new initializer first instructs the agent to wait for the app's first screen; fake-server coverage passes, but the changed stranger path still needs live proof.
- **Go Android recipe:** the OS-version validation failed while its target was offscreen. The instruction now needs explicit scrolling/navigation before validation; the corrected live result is pending.
- **Linux screenshot:** TypeScript commands and file round-trip passed, but immediate capture returned `SESSION_BUSY` with `screen_unavailable`; release was confirmed. Go captured successfully only after a manually prescribed 15-second wait. Neither result proves the new SDK-managed retry path. Linux remains early access, and screenshot readiness is separate from command readiness.

![The published initializer's failed iOS validation saw a blank first screen](https://api-nightly.capy.ai/pr-assets/LM-VpAucGHhl0-Ct-DD5IIaQbFnN_I8xNYxcZf41Avk.png)

Both SDKs now make a bounded, best-effort mobile blank-frame observation after connection/launch. It can time out or skip unavailable images without failing open; **the runtime has no rendered-readiness signal**, and non-blank pixels do not prove the app is foreground or loaded. The generated example's first instruction remains necessary. See [mobile readiness](mobile.md#steps).

Computer capture retries only structured startup screen-not-ready responses during a fixed 30-second window after active readiness, bounded by cancellation and expiry. Callers do not need a sleep. That behavior has fake-server coverage; the Linux live retry proof is pending. See [computers](computers.md).

## Reading the verdict

Fetch a web/mobile report with:

```bash
revyl device report --session-id <session-id> --json
```

Do not infer a passing validation from `status: success`, `passed_steps`, or `failed_steps`. These can reflect successful execution of a validation whose semantic verdict is false. Read each step's **`effective_status` and `validation_result`**, and compare **`validations_passed` with `total_validations`**. Effective passed/failed step counts summarize semantic outcomes where provided. The SDK maps the actual validation verdict to `StepResult.passed` and throws `VALIDATION_FAILED` by default.

For the failed Go Android baseline, the public projection records transport counts `passed_steps: 3`, `failed_steps: 0`, but `effective_failed_steps: 1`, `total_validations: 1`, and `validations_passed: 0`; the validation step has `effective_status: failed` and projected `validationPassed: false`. The transport counts do not override that failure.

## Reproducing the workflow

Use an authorized account and the exact source revision when comparing to the baseline. These commands prepare the TypeScript source; they do not publish it:

```bash
git clone https://github.com/RevylAI/verify.git
cd verify
git checkout 6029513369f13e73914b550d0cd26ece615b4e13
npm ci
npm run build
```

For Go, pin the same baseline with `go get github.com/RevylAI/verify/go@6029513369f13e73914b550d0cd26ece615b4e13` in your own module. Use the [TypeScript API](getting-started.md) or [Go API](https://github.com/RevylAI/verify/tree/main/go) to open the target, run an instruction, validate the visible outcome, capture a screenshot, and close in `finally` or a bounded deferred cleanup context. The web workload uses `https://demo.playwright.dev/todomvc` and a Revyl web app ID supplied privately through `REVYL_WEB_APP_ID`.

Do not use the baseline's blank-screen initializer or offscreen Android assertion as a recommended recipe. To test the fixes, use the reviewed new source revision rather than the baseline commit or the older npm package. Ask Revyl for the approved computer endpoints and matching credentials; never place credentials in argv or publish signed recording URLs.

## Limits

Fake-server tests cover contracts, observation bounds, errors, expiry, and cleanup. They do not prove live availability, app rendering, installed software, recording generation, or successful physical release. Downloaded recordings existed for the baseline runs but remain private and are not evidence published here. No claim is made about retry success until the affected live checks are repeated.
