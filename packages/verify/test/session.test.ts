import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateTarget } from '../src/config.js';
import { Session } from '../src/session.js';
import { APP_ID, BUILD_ID, FakeRevyl, RUN_ID, SESSION_ID, fakeAndroid, fakeWeb, json, png, stepResult } from './helpers/fake-revyl.js';

const started: Session[] = [];

afterEach(async () => {
  await Promise.allSettled(started.splice(0).map((session) => session.close()));
});

async function start(fake: FakeRevyl, target: Record<string, unknown>, lines: string[] = []): Promise<Session> {
  const session = await Session.start(fake.client(), validateTarget(target), { stepTimeout: 5_000, log: (line) => lines.push(line) });
  started.push(session);
  return session;
}

const android = { platform: 'android', app: { appId: APP_ID }, device: { model: 'Pixel 8' } };
const web = { platform: 'web', app: { appId: APP_ID, buildId: BUILD_ID } };

describe('starting a session', () => {
  it('starts an Android device, waits for it to connect, and logs the session link', async () => {
    const fake = fakeAndroid(new FakeRevyl());
    const lines: string[] = [];
    const session = await start(fake, android, lines);
    expect(session).toMatchObject({ id: SESSION_ID, platform: 'android', target: 'android', viewerUrl: `https://app.revyl.ai/sessions/${SESSION_ID}` });
    expect(fake.calls('POST', /start_device/)[0]?.body).toEqual({
      platform: 'android',
      is_simulation: true,
      idle_timeout_seconds: 600,
      app_id: APP_ID,
      device_model: 'Pixel 8',
    });
    expect(fake.calls('POST', /launch/)).toHaveLength(0);
    expect(lines).toEqual([`android: starting android session ${session.viewerUrl}`, 'android: ready']);
  });

  it('launches an app already on the device when the target names only a bundle id', async () => {
    const fake = fakeAndroid(new FakeRevyl());
    await start(fake, { platform: 'android', app: { bundleId: 'com.android.settings' } });
    expect(fake.calls('POST', /start_device/)[0]?.body).not.toHaveProperty('app_id');
    expect(fake.calls('POST', /launch/)[0]?.body).toEqual({ bundle_id: 'com.android.settings' });
  });

  it('registers a web URL as a build, starts the browser, and waits until it can take a screenshot', async () => {
    const fake = fakeWeb(new FakeRevyl());
    const session = await start(fake, {
      platform: 'web',
      app: { appId: APP_ID, url: 'https://preview.example.com' },
      viewport: { width: 1280, height: 800 },
      signIn: { path: '/__test/sign-in', secret: 'E2E_TOKEN' },
    });
    const body = fake.calls('POST', /start_device/)[0]!.body;
    expect(body).toMatchObject({
      platform: 'web',
      app_id: APP_ID,
      build_id: BUILD_ID,
      web: { viewport: { width: 1280, height: 800 }, sign_in: { path: '/__test/sign-in', secret_name: 'E2E_TOKEN' } },
    });
    expect(session.id).toBe(body.session_id);
  });

  it('stops the session when it ends before it is ready', async () => {
    const fake = fakeWeb(new FakeRevyl()).on('GET', /device-sessions/, () => json({ id: 'x', status: 'failed', error_message: 'build crashed' }));
    await expect(start(fake, web)).rejects.toMatchObject({ code: 'SESSION_START_FAILED', message: expect.stringContaining('build crashed') });
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });
});

describe('instruction and validation', () => {
  it('runs an instruction and records it', async () => {
    const fake = fakeAndroid(new FakeRevyl()).on('POST', /execute_step$/, () => json(stepResult({ status: 'success' })));
    const lines: string[] = [];
    const session = await start(fake, android, lines);
    const result = await session.instruction('  Open settings ');
    expect(result).toMatchObject({ type: 'instruction', text: 'Open settings', passed: true });
    expect(session.steps).toEqual([result]);
    expect(fake.calls('POST', /execute_step$/)[0]?.body).toEqual({
      step_type: 'instruction',
      step_description: 'Open settings',
      session_id: SESSION_ID,
      workflow_run_id: RUN_ID,
    });
    expect(lines.at(-1)).toMatch(/^android: ✓ instruction "Open settings" \(\d+\.\ds\)$/);
  });

  it('throws INSTRUCTION_FAILED with Revyl\'s reason and the session link', async () => {
    const fake = fakeAndroid(new FakeRevyl()).on('POST', /execute_step$/, () =>
      json(stepResult({ status: 'failed', status_reason: 'No settings icon on screen' }, false)),
    );
    const session = await start(fake, android);
    await expect(session.instruction('Open settings')).rejects.toMatchObject({
      code: 'INSTRUCTION_FAILED',
      message: expect.stringMatching(/No settings icon on screen\. See https:\/\/app\.revyl\.ai\/sessions\//),
    });
  });

  it('polls an accepted step until it completes', async () => {
    let polls = 0;
    const fake = fakeAndroid(new FakeRevyl())
      .on('POST', /execute_step$/, () => json({ step_id: 'step-9', status: 'accepted' }, 202))
      .on('GET', /step_status\/step-9$/, () =>
        json(
          ++polls < 2
            ? { step_id: 'step-9', status: 'running' }
            : { step_id: 'step-9', status: 'completed', result: stepResult({ status: 'success', validation_result: true }) },
        ),
      );
    const session = await start(fake, android);
    expect((await session.validation('The cart is empty')).passed).toBe(true);
    expect(polls).toBe(2);
  });

  it('throws VALIDATION_FAILED when the validation does not hold, or returns the result when soft', async () => {
    const fake = fakeAndroid(new FakeRevyl()).on('POST', /execute_step$/, () =>
      json(stepResult({ status: 'failed', validation_result: false, status_reason: 'The cart shows 1 item, not 2.' })),
    );
    const lines: string[] = [];
    const session = await start(fake, android, lines);
    await expect(session.validation('The cart shows 2 items')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('The cart shows 1 item, not 2.'),
    });
    expect(lines.at(-1)).toContain('✗ validation "The cart shows 2 items"');
    const soft = await session.validation('The cart shows 2 items', { soft: true });
    expect(soft).toMatchObject({ passed: false, reason: 'The cart shows 1 item, not 2.' });
    expect(session.steps.map((step) => step.passed)).toEqual([false, false]);
  });

  it('cancels a step on Revyl when it runs past its timeout', async () => {
    const fake = fakeAndroid(new FakeRevyl())
      .on('POST', /execute_step$/, () => json({ step_id: 'slow', status: 'accepted' }, 202))
      .on('GET', /step_status\/slow$/, () => json({ step_id: 'slow', status: 'running' }))
      .on('POST', /step_cancel\/slow$/, () => json({ step_id: 'slow', status: 'cancelled' }));
    const session = await start(fake, android);
    await expect(session.instruction('Wait forever', { timeout: 1_200 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fake.calls('POST', /step_cancel\/slow$/)).toHaveLength(1);
  });

  it('sends web steps through the same endpoint and reports 501 as a typed platform error', async () => {
    const fake = fakeWeb(new FakeRevyl()).on('POST', /execute_step$/, () => json({ error: 'step_output_not_available' }, 501));
    const session = await start(fake, web);
    await expect(session.validation('The page loaded')).rejects.toMatchObject({
      code: 'NOT_AVAILABLE_ON_PLATFORM',
      message: expect.stringContaining('step_output_not_available'),
    });
    expect(fake.calls('POST', /device-proxy\/run-1\/execute_step$/)).toHaveLength(1);
  });

  it('runs web steps with no change once Revyl accepts them asynchronously', async () => {
    const fake = fakeWeb(new FakeRevyl())
      .on('POST', /execute_step$/, () => json({ step_id: 'web-1', status: 'accepted' }, 202))
      .on('GET', /step_status\/web-1$/, () =>
        json({ step_id: 'web-1', status: 'completed', result: stepResult({ status: 'success', validation_result: true }) }),
      );
    const session = await start(fake, web);
    expect((await session.validation('The page loaded')).passed).toBe(true);
  });

  it('does not repeat a step whose outcome is uncertain', async () => {
    const fake = fakeAndroid(new FakeRevyl()).on('POST', /execute_step$/, () =>
      json({ error: 'request_timeout', execution_uncertain: true }, 504),
    );
    const session = await start(fake, android);
    await expect(session.instruction('Pay')).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    expect(fake.calls('POST', /execute_step$/)).toHaveLength(1);
  });

  it('runs one step at a time and rejects empty descriptions', async () => {
    const fake = fakeAndroid(new FakeRevyl())
      .on('POST', /execute_step$/, () => json({ step_id: 's', status: 'accepted' }, 202))
      .on('GET', /step_status\/s$/, () => json({ step_id: 's', status: 'completed', result: stepResult({ status: 'success' }) }));
    const session = await start(fake, android);
    const first = session.instruction('Open settings');
    await expect(session.instruction('Open profile')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('one step at a time') });
    await first;
    await expect(session.validation('   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('screenshots and closing', () => {
  it('writes a screenshot when given a path', async () => {
    const fake = fakeAndroid(new FakeRevyl());
    const session = await start(fake, android);
    const path = join(await mkdtemp(join(tmpdir(), 'verify-shot-')), 'nested', 'home.png');
    const bytes = await session.screenshot({ path });
    expect(bytes).toEqual(png(1080, 2400));
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });

  it('stops the session once, and refuses steps afterwards', async () => {
    const fake = fakeAndroid(new FakeRevyl());
    const session = await start(fake, android);
    await Promise.all([session.close(), session.close()]);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
    expect(session.closed).toBe(true);
    await expect(session.validation('Anything')).rejects.toMatchObject({ code: 'SESSION_ENDED' });
  });

  it('removes its process listeners once no session is open', async () => {
    const before = process.listenerCount('beforeExit');
    const session = await start(fakeAndroid(new FakeRevyl()), android);
    expect(process.listenerCount('beforeExit')).toBe(before + 1);
    await session.close();
    expect(process.listenerCount('beforeExit')).toBe(before);
  });
});
