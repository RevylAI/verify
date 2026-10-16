import { describe, expect, it } from 'vitest';
import { FakeRevyl, fakeAndroid, json, type AndroidNodeSpec } from './helpers/fake-revyl.js';
import { fakeWebRuntime, fixturesFor, startSession } from './helpers/fixtures.js';

const loginScreen: AndroidNodeSpec[] = [
  { text: 'Welcome back', bounds: [0, 100, 1080, 200] },
  { cls: 'android.widget.EditText', desc: 'Email', id: 'com.shop:id/email', bounds: [40, 300, 1040, 400] },
  { text: 'Sign in', cls: 'android.widget.Button', id: 'com.shop:id/sign_in', bounds: [40, 500, 1040, 600] },
  { text: 'Sign in with Google', cls: 'android.widget.Button', bounds: [40, 700, 1040, 800] },
  { text: 'Offscreen', bounds: [0, 3000, 1080, 3100] },
];

describe('native locators', () => {
  it('taps the center of the element matching exact text', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: loginScreen });
    const { screen, steps } = fixturesFor(await startSession(fake, 'android'));
    await screen.getByText('Sign in', { exact: true }).tap();
    expect(fake.calls('POST', /\/tap$/)[0]?.body).toEqual({ x: 540, y: 550 });
    expect(steps.root[0]).toMatchObject({ title: 'getByText("Sign in").tap()', status: 'passed' });
  });

  it('refuses to guess between several matches', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: loginScreen });
    const { screen } = fixturesFor(await startSession(fake, 'android'));
    await expect(screen.getByText('sign in').tap()).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS', message: expect.stringContaining('matches 2 elements') });
    await screen.getByText('sign in').last().tap();
    expect(fake.calls('POST', /\/tap$/)[0]?.body).toEqual({ x: 540, y: 750 });
  });

  it('finds fields by test id without the Android package prefix, and types into them', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: loginScreen });
    const { screen } = fixturesFor(await startSession(fake, 'android'));
    await screen.getByTestId('email').fill('dev@example.com');
    expect(fake.calls('POST', /\/input$/)[0]?.body).toEqual({ x: 540, y: 350, text: 'dev@example.com', clear_first: true });
    expect(await screen.getByRole('textbox', { name: 'Email' }).count()).toBe(1);
    expect(await screen.getByRole('button').count()).toBe(2);
  });

  it('ignores elements outside the screen and lists what is visible when nothing matches', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: loginScreen });
    const { screen } = fixturesFor(await startSession(fake, 'android'));
    await expect(screen.getByText('Offscreen').tap()).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('"Welcome back"'),
    });
  });
});

describe('grounded locators', () => {
  it('taps on web through Revyl grounding with a description of the element', async () => {
    let attempts = 0;
    const fake = fakeWebRuntime(new FakeRevyl()).on('POST', /tap_target$/, () =>
      ++attempts < 2 ? json({ success: false, action: 'tap', latency_ms: 1, error: 'target_not_found' }, 404) : json({ success: true, action: 'tap', latency_ms: 1 }),
    );
    const { screen } = fixturesFor(await startSession(fake, 'web'), { action: 5_000, assertion: 300 });
    await screen.getByRole('button', { name: 'Add to cart' }).tap();
    const calls = fake.calls('POST', /tap_target$/);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.target).toBe('the "Add to cart" button');
  });

  it('types on web at the grounded point and passes the screen token back', async () => {
    const fake = fakeWebRuntime(new FakeRevyl()).on('POST', /resolve_target$/, () => json({ found: true, x: 300, y: 120, screen_token: 'tok' }));
    const { screen } = fixturesFor(await startSession(fake, 'web'));
    await screen.locate('the search box').fill('red shoes');
    expect(fake.calls('POST', /\/input$/)[0]?.body).toEqual({ x: 300, y: 120, screen_token: 'tok', text: 'red shoes', clear_first: true });
  });

  it('explains that test ids need a native UI tree', async () => {
    const fake = fakeWebRuntime(new FakeRevyl());
    const { screen } = fixturesFor(await startSession(fake, 'web'));
    await expect(screen.getByTestId('cart').tap()).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
  });

  it('does not repeat a tap whose outcome is uncertain', async () => {
    const fake = fakeWebRuntime(new FakeRevyl()).on('POST', /tap_target$/, () =>
      json({ success: false, action: 'tap', latency_ms: 1, error: 'request_timeout', execution_uncertain: true }, 504),
    );
    const { screen } = fixturesFor(await startSession(fake, 'web'), { action: 5_000, assertion: 300 });
    await expect(screen.locate('Checkout').tap()).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    expect(fake.calls('POST', /tap_target$/)).toHaveLength(1);
  });
});

describe('app controls', () => {
  it('scrolls web pages with the wheel and mobile screens with a swipe', async () => {
    const web = fakeWebRuntime(new FakeRevyl());
    await fixturesFor(await startSession(web, 'web')).app.scroll('down');
    expect(web.calls('POST', /\/scroll$/)[0]?.body).toEqual({ dx: 0, dy: 600 });

    const android = fakeAndroid(new FakeRevyl(), { nodes: [] });
    await fixturesFor(await startSession(android, 'android')).app.scroll('down');
    expect(android.calls('POST', /\/swipe$/)[0]?.body).toEqual({ direction: 'up', x: 540, y: 1200, duration_ms: 500 });
  });

  it('limits mobile keys to the ones devices support', async () => {
    const android = fakeAndroid(new FakeRevyl(), { nodes: [] });
    const { app } = fixturesFor(await startSession(android, 'android'));
    await app.pressKey('Enter');
    expect(android.calls('POST', /\/key$/)[0]?.body).toEqual({ key: 'ENTER' });
    await expect(app.pressKey('Escape')).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
  });
});
