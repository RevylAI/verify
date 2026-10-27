# Verify working end to end

This page separates live verification from fake-server coverage. A supported SDK API or passing unit test is not evidence that a cloud workload completed.

## Verification scope

Live verification results for the current revision are pending. No TypeScript, Go, web, mobile, or computer success is claimed here until the run evidence has been reviewed.

## TypeScript: open, act, validate, capture, close

The live record will identify the tested package revision, selected platform and environment, workload, step outcomes, screenshot result, and cleanup result. See [getting started](getting-started.md) for the supported API, not a completed-run claim.

## Go: open, act, validate, capture, close

The live record will identify the tested module revision, context bounds, selected platform and environment, step outcomes, screenshot result, and cleanup result. See the [Go SDK](https://github.com/RevylAI/verify/tree/main/go) for the API.

## Computers: commands, files, processes, capture, release

Mac and Linux are early access on staging for enabled organizations, not yet available in production. Live evidence must distinguish startup, command/file/process/screenshot outcomes, terminal state, physical release, and recording availability. A terminal state alone does not prove release. See [computers](computers.md) and the [shared Linux contract](linux-computers-contract.md).

## Limits of the evidence

Unit tests use fake servers. They cover request contracts, error handling, async polling without replay, expiry, and release-gated recording metadata; they do not establish live capacity, installed software, production availability, or recording generation. Failed or blocked live checks will be recorded alongside successful checks rather than omitted.
