import { describe, expect as vitestExpect, it } from 'vitest';
import { expect } from '../src/expect.js';
import { FakeRevyl, fakeAndroid, json, stepResult, type AndroidNodeSpec } from './helpers/fake-revyl.js';
import { fakeWebRuntime, fixturesFor, startSession } from './helpers/fixtures.js';

describe('expect(locator)', () => {
  it('waits until an element appears', async () => {
    const screen: { nodes: AndroidNodeSpec[] } = { nodes: [] };
    const fake = fakeAndroid(new FakeRevyl(), screen);
    const fixtures = fixturesFor(await startSession(fake, 'android'), { action: 300, assertion: 3_000 });
    setTimeout(() => screen.nodes.push({ text: 'Order placed', bounds: [0, 0, 500, 100] }), 600);
    await expect(fixtures.screen.getByText('order placed')).toBeVisible();
  });

  it('checks native text and state, and supports .not', async () => {
    const fake = fakeAndroid(new FakeRevyl(), {
      nodes: [
        { text: 'Total: $42.00', id: 'com.shop:id/total', bounds: [0, 0, 500, 100] },
        { text: 'Pay', cls: 'android.widget.Button', enabled: false, bounds: [0, 200, 500, 300] },
      ],
    });
    const { screen } = fixturesFor(await startSession(fake, 'android'));
    await expect(screen.getByTestId('total')).toHaveText(/\$42\.00/);
    await expect(screen.getByRole('button', { name: 'Pay' })).not.toBeEnabled();
    await expect(screen.getByText('Error')).toBeHidden();
    await vitestExpect(expect(screen.getByTestId('total')).toHaveText('$41')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vitestExpect.stringContaining('its text was "Total: $42.00"'),
    });
  });

  it('checks visibility on web through grounding and points other checks at agent.assert', async () => {
    const fake = fakeWebRuntime(new FakeRevyl()).on('POST', /resolve_target$/, (request) =>
      json({ found: request.body.target.includes('Cart'), x: 10, y: 10 }),
    );
    const { screen } = fixturesFor(await startSession(fake, 'web'));
    await expect(screen.getByText('Cart')).toBeVisible();
    await expect(screen.getByText('Sold out')).not.toBeVisible();
    await vitestExpect(expect(screen.getByText('Cart')).toHaveText('Cart (2)')).rejects.toMatchObject({
      code: 'NOT_AVAILABLE_ON_PLATFORM',
      message: vitestExpect.stringContaining('agent.assert()'),
    });
  });
});

describe('expect(value)', () => {
  it('compares plain values', () => {
    expect('Order #123').toContain('#123');
    expect([1, { a: 2 }]).toContain({ a: 2 });
    expect({ a: [1] }).toEqual({ a: [1] });
    expect(3).toBeGreaterThan(2);
    expect('').not.toBeTruthy();
    vitestExpect(() => expect('abc').toMatch(/z/)).toThrow("expect('abc').toMatch(/z/) failed");
  });
});

describe('agent', () => {
  it('fails the test with the agent reasoning when an assertion does not hold', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] }).on('POST', /execute_step$/, () =>
      json(stepResult({ status: 'failed', validation_result: false, status_reason: 'The cart shows 1 item, not 2.' })),
    );
    const { agent, steps } = fixturesFor(await startSession(fake, 'android'));
    await vitestExpect(agent.assert('The cart shows 2 items')).rejects.toMatchObject({
      code: 'ASSERTION_FAILED',
      message: vitestExpect.stringContaining('The cart shows 1 item, not 2.'),
    });
    vitestExpect(steps.root[0]).toMatchObject({ title: 'agent.assert: The cart shows 2 items', status: 'failed' });
  });

  it('returns extracted text so the test can carry it into later steps', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] }).on('POST', /execute_step$/, () =>
      json(stepResult({ status: 'success', extracted_data: { information: 'A-1234', reasoning: 'Shown under Order number' } })),
    );
    const { agent } = fixturesFor(await startSession(fake, 'android'));
    const orderNumber = await agent.extract('the order number');
    vitestExpect(orderNumber).toBe('A-1234');
  });
});
