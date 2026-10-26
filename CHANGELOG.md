# Changelog

## Unreleased

- Add a standard-library-only Go SDK for web, iOS, Android, and early-access Mac and Linux computers. Computer commands, binary files, process handles, screenshots, recording metadata, and confirmed-release cleanup require an enabled staging organization and are not yet available in production. Capacity refusals have a distinct `COMPUTER_LIMIT` code; no start or operation is automatically replayed.

## 0.1.0

Initial release preparation; this entry does not mean the package has been published.

- Open Revyl cloud web browsers, iOS simulators, and Android emulators from TypeScript.
- Run natural-language instruction and validation steps, with typed failures and optional soft validation results.
- Save screenshots, share session links, and close sessions explicitly or during best-effort process cleanup.
- Configure named targets and initialize a script with the `verify` or `revyl-verify` command.
- Use environment credentials or an existing Revyl CLI login, with documentation included in the package.
- Include **early-access Mac computers, not yet available in Revyl production**, for commands, binary files, process handles, screenshots, and confirmed-release cleanup. Mac works only on Revyl staging for enabled organizations through the optional `REVYL_BACKEND_URL` override and matching credentials; ask support@revyl.ai about access.
- Reserve Linux target types and document the future contract; opening Linux is not available in this release.

Requires Node.js 22.18 or later and a Revyl account. There is no bundled test runner or step replay. Mac operations remain covered by source-aligned fake-API tests; a production start never reached active, so it did not prove any operation or confirmed cleanup.
