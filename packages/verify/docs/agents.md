# For coding agents

This page is for AI coding agents (Claude Code, Cursor, Codex, and others) that write or fix Verify tests. The rest of the docs in this folder describe the API in full; this page is the workflow.

## Workflow

1. Read `verify.config.ts` to learn the targets and their platforms. A test runs on every target unless it passes `{ targets: [...] }`.
2. Write tests in files matching the config's `tests` glob (by default `tests/**/*.verify.ts`). Import only from `@revyl/verify`.
3. Check that the test files load without starting any session or needing credentials:
   ```bash
   npx verify run --list
   ```
4. Run one file on one target while iterating, because every run starts real cloud sessions:
   ```bash
   npx verify run tests/checkout.verify.ts --target ios
   ```
5. Read `.verify/results.json` rather than scraping terminal output. For each failed test, look at `attempts[].error.code`, `attempts[].error.message`, the failed entry in `attempts[].steps`, `attempts[].viewerUrl`, and the screenshot in `attempts[].attachments`.
6. Look at the failure screenshot before changing the test. The error message for `LOCATOR_NOT_FOUND` on mobile lists the text that was on screen.

## Rules

- Prefer exact locators (`getByText` with `exact: true`, `getByTestId`, `getByRole` with a name) on iOS and Android. They are deterministic and cost no model calls.
- Use `agent.act` for multi-step flows that would be brittle as taps, `agent.assert` for visual or semantic checks, and `agent.extract` to read values. Every agent call runs the model again on every run; nothing is cached or replayed.
- `agent.extract` returns a string. Revyl does not carry values between agent steps, so keep the value in a variable and interpolate it into later steps yourself.
- Never add `app.wait(ms)` to fix timing. Use `expect(locator).toBeVisible()` or `locator.waitFor()`, which wait only as long as needed.
- On web, locators are AI-grounded. Write descriptions a person would understand, and do not use `getByTestId`, `nth()`, or regular expressions there. Use `agent.assert` for text and state checks on web.
- Do not catch `VerifyError` to make a test pass. A `NOT_AVAILABLE_ON_PLATFORM` error means the call needs a different approach on that platform; restrict the test with `{ targets }` or use the alternative named in the message.
- Leave `test.only` out of committed code; CI rejects it.
- Do not put secrets in tests or config. Credentials come from `REVYL_API_KEY` or a Revyl CLI login; web sign-in uses the **name** of a Revyl organization secret.
- Each `verify run` starts paid cloud sessions. Use `--list`, file filters, and `--target` to keep runs small, and do not loop a full suite to probe a fix.

## A good test

```ts
import { expect, test } from '@revyl/verify';

test.describe('sign in', () => {
  test('a returning user lands on their dashboard', async ({ screen, agent }) => {
    await screen.getByTestId('email').fill('demo@example.com');
    await screen.getByTestId('password').fill(process.env.DEMO_PASSWORD!);
    await screen.getByRole('button', { name: 'Sign in', exact: true }).tap();
    await expect(screen.getByText('Dashboard')).toBeVisible({ timeout: 20_000 });
    await agent.assert('The dashboard shows at least one project card');
  });
});
```
