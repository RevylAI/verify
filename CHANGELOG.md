# Changelog

## 0.1.0

Initial release preparation; this entry does not mean the package has been published.

- Open Revyl cloud web browsers, iOS simulators, and Android emulators from TypeScript.
- Run natural-language instruction and validation steps, with typed failures and optional soft validation results.
- Save screenshots, share session links, and close sessions explicitly or during best-effort process cleanup.
- Configure named targets and initialize a script with the `verify` or `revyl-verify` command.
- Use environment credentials or an existing Revyl CLI login, with documentation included in the package.
- Open **early-access Mac computers** for commands, binary files, process handles, screenshots, and confirmed-release cleanup. Organization enablement is required; ask support@revyl.ai.
- Reserve Linux target types and document the future contract; opening Linux is not available in this release.

Requires Node.js 22.18 or later and a Revyl account. There is no bundled test runner or step replay. Mac runtime integration is covered by source-aligned fake-API tests, not a live Mac run.
