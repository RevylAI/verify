# Writing tests

A test file is any file matching `tests/**/*.verify.ts` (configurable). It imports `test` and `expect` from `@revyl/verify`:

```ts
import { expect, test } from '@revyl/verify';

test('a shopper can check out', async ({ screen, agent, app }) => {
  await screen.getByText('Running shoes').tap();
  await screen.getByRole('button', { name: 'Add to cart' }).tap();
  await agent.act('Open the cart and check out with the saved card');
  await expect(screen.getByText('Order placed')).toBeVisible();
  const orderNumber = await agent.extract('the order number');
  expect(orderNumber).toMatch(/^[A-Z0-9-]+$/);
});
```

Each test runs once per configured target. A test that should run only on some targets names them:

```ts
test('deep link opens the order', { targets: ['ios', 'android'] }, async ({ app, screen }) => {
  await app.openUrl('shop://orders/123');
  await expect(screen.getByText('Order 123')).toBeVisible();
});
```

## Fixtures

The test function receives:

| Fixture | What it is |
| --- | --- |
| `screen` | Finds elements: `getByText`, `getByLabel`, `getByTestId`, `getByRole`, `locate` |
| `agent` | Natural-language steps run by Revyl's agent: `act`, `assert`, `extract` |
| `app` | App and device controls: `launch`, `close`, `restart`, `openUrl`, `back`, `reload`, `pressKey`, `swipe`, `scroll`, `screenshot`, `wait` |
| `target` | `{ name, platform }` of the target this run uses |
| `step` | `step(title, async () => { … })` groups actions under one title in the report |

## Exact locators and AI steps

Verify gives you two ways to drive an app, and most tests use both.

**Locators** (`screen.getBy…`) find one element and act on it. On iOS and Android they read the app's native UI tree, so `getByText('Sign in', { exact: true })` is exact and fast, and Verify refuses to guess when several elements match. On web, Revyl sessions expose screenshots rather than a DOM, so locators are resolved by Revyl's AI grounding model from a description Verify builds (`getByRole('button', { name: 'Add to cart' })` becomes "the "Add to cart" button"). `screen.locate('the blue Save button in the footer')` uses grounding on every platform.

**Agent steps** (`agent.act`, `agent.assert`, `agent.extract`) hand a goal or a question to Revyl's agent, which looks at the screen and decides what to do. Use them for multi-step flows, for checks that are hard to express as one element ("the chart shows an upward trend"), and for reading values off the screen.

Agent steps call the model on every run. Verify does not cache or replay agent decisions between runs, so a test that relies on many agent steps is slower and costs more than one built on locators. Prefer locators for anything you can name exactly.

## Locators

| Call | iOS and Android | Web |
| --- | --- | --- |
| `getByText(text, { exact? })` | Visible text or accessibility label | AI grounding |
| `getByLabel(label, { exact? })` | Accessibility label (`content-desc`, `accessibilityLabel`) | AI grounding |
| `getByTestId(id)` | `resource-id` (with or without the package prefix), `accessibilityIdentifier` | Not available |
| `getByRole(role, { name?, exact? })` | Native class mapped to `button`, `textbox`, `checkbox`, `switch`, `radio`, `image`, `link`, `heading`, `text` | AI grounding |
| `locate(description)` | AI grounding | AI grounding |

A string matches a case-insensitive substring unless `exact: true`. A `RegExp` works on native locators only. `nth(i)`, `first()`, and `last()` pick one of several native matches.

Actions wait up to `actionTimeout` (15 s by default) for the element to appear:

```ts
await screen.getByText('Continue').tap();
await screen.getByTestId('email').fill('dev@example.com');           // replaces the text; { clear: false } appends
await screen.getByLabel('Photo').longPress({ durationMs: 1000 });
await screen.getByText('Item').doubleTap();
await screen.getByText('Spinner').waitFor({ state: 'hidden', timeout: 30_000 });
const total = await screen.getByTestId('total').textContent();        // native only
const visible = await screen.getByText('Promo').isVisible();          // no waiting
```

## expect

`expect(locator)` retries until the condition holds or `assertionTimeout` (10 s by default) passes:

```ts
await expect(screen.getByText('Welcome back')).toBeVisible();
await expect(screen.getByText('Error')).toBeHidden();
await expect(screen.getByTestId('total')).toHaveText('$42.00');      // native only
await expect(screen.getByRole('button', { name: 'Pay' })).toBeEnabled(); // native only
await expect(screen.getByRole('checkbox')).toHaveCount(3);            // native only
await expect(screen.getByText('Sold out')).not.toBeVisible();
```

On web, `toBeVisible` and `toBeHidden` ask the grounding model whether the element is on screen. Checks that need element state (`toHaveText`, `toBeEnabled`, `toHaveCount`) fail with `NOT_AVAILABLE_ON_PLATFORM` on grounded locators; use `agent.assert` for those.

`expect(value)` checks plain values: `toBe`, `toEqual`, `toContain`, `toMatch`, `toBeTruthy`, `toBeGreaterThan`, `toBeLessThan`, each with `.not`.

## agent

```ts
await agent.act('Sign in as the demo user and open Settings');
await agent.assert('The profile picture is a round avatar with initials');
const price = await agent.extract('the price of the first product, as shown');
```

- `act` fails with `AGENT_STEP_FAILED` when the agent cannot finish the goal.
- `assert` fails with `ASSERTION_FAILED` and the agent's reasoning when the expectation does not hold.
- `extract` returns the answer as a string. Revyl does not carry values between agent steps, so keep the value in a variable and pass it on yourself:

```ts
const code = await agent.extract('the six-digit verification code in the banner');
await screen.getByLabel('Verification code').fill(code);
await agent.assert(`The confirmation screen mentions code ${code}`);
```

Each step has its own timeout (`agentTimeout`, 3 minutes by default): `agent.act('…', { timeout: 300_000 })`. A step that runs out of time is cancelled on Revyl. Verify never repeats an agent step on its own, because the agent may already have changed the app.

## app

```ts
await app.openUrl('https://shop.example.com/cart');  // web navigation, or a deep link on mobile
await app.restart();                                 // relaunch the mobile app, or reopen the web start URL
await app.close(); await app.launch();               // iOS and Android
await app.back();                                    // Android and web
await app.reload();                                  // web
await app.pressKey('Enter');                         // mobile: Enter, Backspace; web: also Tab, Escape, arrows, …
await app.swipe('left');
await app.scroll('down', { amount: 800 });           // web: wheel pixels; mobile: one swipe
const file = await app.screenshot('cart');           // saved under .verify/artifacts and attached to the report
console.log(app.viewerUrl);                          // live view and recording of this session in Revyl
```

## Hooks, groups, and focus

```ts
test.describe('cart', () => {
  test.beforeEach(async ({ app }) => {
    await app.openUrl('https://shop.example.com/cart');
  });

  test('starts empty', async ({ screen }) => {
    await expect(screen.getByText('Your cart is empty')).toBeVisible();
  });

  test.skip('applies a coupon', async () => {});
});
```

`test.only` runs only the focused tests. It is rejected when `CI` is set, so a focused test cannot silently skip the rest of a CI run.

## Sessions between tests

By default each worker keeps one session per target and reuses it: before every test after the first, Verify closes and relaunches the mobile app, or reopens the start URL on web. App data, cookies, and storage persist across tests on the same session. Set `reuseSessions: false` to start a fresh browser or device for every test, which is slower and costs more.

## Timeouts and retries

| Setting | Default | Applies to |
| --- | --- | --- |
| `timeout` | 300 000 ms | One test, including hooks; session start is not counted |
| `actionTimeout` | 15 000 ms | Waiting for a locator before an action |
| `assertionTimeout` | 10 000 ms | One `expect(locator)` |
| `agentTimeout` | 180 000 ms | One agent step |
| `retries` | 1 in CI, 0 elsewhere | Extra attempts for a failed test |

A test that fails and then passes on retry is reported as flaky.
