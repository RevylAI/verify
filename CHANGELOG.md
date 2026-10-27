# Changelog

## Unreleased

- Add a standard-library-only Go SDK for web, iOS, Android, and early-access Mac and Linux computers. Computer commands, binary files, process handles, screenshots, recording metadata, and confirmed-release cleanup require an enabled staging organization and are not yet available in production. Capacity refusals have a distinct `COMPUTER_LIMIT` code; no start or operation is automatically replayed.

## 0.2.0

Prepared for release; see npm for publication status.

- Enable Linux named and inline computer targets with the shared Mac command, file, process, screenshot, and confirmed-release cleanup surface. Both operating systems remain early access on staging for enabled organizations/OSes, not yet available in production.
- Add `COMPUTER_LIMIT` for queued work (including iOS) or concurrency admission refusals, without retrying or stopping a definitely refused start. Preserve `SESSION_BUSY` for operation limits.
- Explain the 120-second unclaimed-start failure without shortening the default 10-minute start timeout.
- Expose optional `expiresAt` and bound operation/screenshot observation by the hard 60-minute lifetime from create, while keeping explicit close possible.
- Add computer `recording()` metadata retrieval after terminal state and confirmed release, including after close. Missing recordings return null; signed URLs remain private, with no automatic waiting or download.
- Keep Linux CLI init intentionally unavailable; use inline targets or config entries. Computer instruction/validation remain locally unavailable.
- Observe mobile first-screen content best-effort for up to 10 seconds after connection/launch, without pretending the runtime provides rendered-readiness guarantees. Generated mobile examples begin with an instruction to wait for the first screen before validation.
- Retry structured computer screen-not-ready responses with bounded backoff during the fixed startup window; do not replay mutations or unrelated failures.
- Skip CI publication when the exact version is already on npm, require explicit administrator opt-in for new CI publications, fail closed on registry lookup errors, and document manual Mac publication, optional trusted publishing, and independent Go module tags.

Regression validation uses fake API responses. The [end-to-end record](https://github.com/RevylAI/verify/blob/v0.2.0/packages/verify/docs/end-to-end.md) distinguishes baseline live runs from startup fixes still awaiting live re-verification.

## 0.1.0

Published manually from a maintainer's Mac without provenance.

- Open Revyl cloud web browsers, iOS simulators, and Android emulators from TypeScript.
- Run natural-language instruction and validation steps, with typed failures and optional soft validation results.
- Save screenshots, share session links, and close sessions explicitly or during best-effort process cleanup.
- Configure named targets and initialize a script with the `verify` or `revyl-verify` command.
- Use environment credentials or an existing Revyl CLI login, with documentation included in the package.
- Include **early-access Mac computers, not yet available in Revyl production**, for commands, binary files, process handles, screenshots, and confirmed-release cleanup. Mac works only on Revyl staging for enabled organizations through the optional `REVYL_BACKEND_URL` override and matching credentials; ask support@revyl.ai about access.
- Reserve Linux target types and document the future contract; opening Linux is not available in this release.

Requires Node.js 22.18 or later and a Revyl account. There is no bundled test runner or step replay. Mac operations remain covered by source-aligned fake-API tests; a production start never reached active, so it did not prove any operation or confirmed cleanup.
