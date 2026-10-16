import { describe, expect, it } from 'vitest';
import { validateConfig, type ResolvedTarget } from '../src/config.js';
import { RevylSession } from '../src/session.js';
import { APP_ID, BUILD_ID, FakeRevyl, RUN_ID, SESSION_ID, fakeAndroid, json, png, stepResult } from './helpers/fake-revyl.js';

function target(raw: Record<string, unknown>): ResolvedTarget {
  return validateConfig({ targets: [raw] }, '/project/verify.config.ts').targets[0]!;
}

const android = target({ platform: 'android', app: { appId: APP_ID }, device: { model: 'Pixel 8' } });

function fakeWeb(fake: FakeRevyl): FakeRevyl {
  let polls = 0;
  return fake
    .on('POST', /\/apps\/[^/]+\/builds\/external$/, () => json({ id: BUILD_ID }))
    .on('POST', /^\/api\/v1\/execution\/start_device$/, (request) =>
      json({ status: 'starting', platform: 'web', session_id: request.body.session_id, workflow_run_id: null }),
    )
    .on('GET', /^\/api\/v1\/execution\/device-sessions\/[^/]+$/, () =>
      json(++polls < 2 ? { id: 'x', status: 'starting' } : { id: 'x', status: 'running', workflow_run_id: RUN_ID }),
    )
    .on('GET', /device-proxy\/run-1\/screenshot$/, () => new Response(png(1280, 800)))
    .on('GET', /device-proxy\/run-1\/tabs$/, () => json([{ tab_id: 't1', active: true, url_origin: 'https://preview.example.com', route_pattern: '/' }]))
    .on('POST', /\/device\/sessions\/[^/]+\/stop$/, () => json({ success: true, request_accepted: true, session_id: 'x', status: 'stopping', message: '' }));
}

describe('RevylSession.start', () => {
  it('starts an Android device and waits for it to connect', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] });
    const session = await RevylSession.start(fake.client(), android);
    expect(session.id).toBe(SESSION_ID);
    expect(session.screenSize).toEqual({ width: 1080, height: 2400 });
    expect(fake.calls('POST', /start_device/)[0]?.body).toEqual({
      platform: 'android',
      is_simulation: true,
      idle_timeout_seconds: 600,
      app_id: APP_ID,
      device_model: 'Pixel 8',
    });
    expect(fake.calls('POST', /launch/)).toHaveLength(0);
  });

  it('launches a preinstalled app when the target names only a bundle id', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] });
    await RevylSession.start(fake.client(), target({ platform: 'android', app: { bundleId: 'com.android.settings' } }));
    expect(fake.calls('POST', /launch/)[0]?.body).toEqual({ bundle_id: 'com.android.settings' });
  });

  it('registers a web URL as a build, starts the browser, and waits until it can take a screenshot', async () => {
    const fake = fakeWeb(new FakeRevyl());
    const session = await RevylSession.start(
      fake.client(),
      target({ platform: 'web', app: { appId: APP_ID, url: 'https://preview.example.com' }, viewport: { width: 1280, height: 800 } }),
    );
    const start = fake.calls('POST', /start_device/)[0]!.body;
    expect(start).toMatchObject({ platform: 'web', app_id: APP_ID, build_id: BUILD_ID, web: { viewport: { width: 1280, height: 800 } } });
    expect(session.id).toBe(start.session_id);
    expect(session.webStartUrl).toBe('https://preview.example.com');
    expect(session.viewerUrl).toBe(`https://app.revyl.ai/sessions/${start.session_id}`);
  });

  it('stops the session when it ends before it is ready', async () => {
    const fake = fakeWeb(new FakeRevyl()).on('GET', /device-sessions/, () => json({ id: 'x', status: 'failed', error_message: 'build crashed' }));
    await expect(
      RevylSession.start(fake.client(), target({ platform: 'web', app: { appId: APP_ID, buildId: BUILD_ID } })),
    ).rejects.toMatchObject({ code: 'SESSION_START_FAILED', message: expect.stringContaining('build crashed') });
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });
});

describe('RevylSession.runStep', () => {
  it('returns a synchronous step result', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] }).on('POST', /execute_step$/, () => json(stepResult({ status: 'success' })));
    const session = await RevylSession.start(fake.client(), android);
    const result = await session.runStep('instruction', 'Open settings', { timeoutMs: 5_000 });
    expect(result.step_output.status).toBe('success');
    expect(fake.calls('POST', /execute_step$/)[0]?.body).toMatchObject({ step_type: 'instruction', step_description: 'Open settings', workflow_run_id: RUN_ID });
  });

  it('polls an accepted step until it completes', async () => {
    let polls = 0;
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] })
      .on('POST', /execute_step$/, () => json({ step_id: 'step-9', status: 'accepted' }, 202))
      .on('GET', /step_status\/step-9$/, () =>
        json(++polls < 2 ? { step_id: 'step-9', status: 'running' } : { step_id: 'step-9', status: 'completed', result: stepResult({ status: 'success' }) }),
      );
    const session = await RevylSession.start(fake.client(), android);
    expect((await session.runStep('validation', 'The cart is empty', { timeoutMs: 10_000 })).success).toBe(true);
    expect(polls).toBe(2);
  });

  it('cancels a step on Revyl when it runs past its timeout', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] })
      .on('POST', /execute_step$/, () => json({ step_id: 'slow', status: 'accepted' }, 202))
      .on('GET', /step_status\/slow$/, () => json({ step_id: 'slow', status: 'running' }))
      .on('POST', /step_cancel\/slow$/, () => json({ step_id: 'slow', status: 'cancelled' }));
    const session = await RevylSession.start(fake.client(), android);
    await expect(session.runStep('instruction', 'Wait forever', { timeoutMs: 1_200 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fake.calls('POST', /step_cancel\/slow$/)).toHaveLength(1);
  });

  it('sends web steps through the same endpoint and reports 501 as a typed platform error', async () => {
    const fake = fakeWeb(new FakeRevyl()).on('POST', /execute_step$/, () => json({ error: 'step_output_not_available' }, 501));
    const session = await RevylSession.start(fake.client(), target({ platform: 'web', app: { appId: APP_ID, buildId: BUILD_ID } }));
    await expect(session.runStep('validation', 'The page loaded', { timeoutMs: 5_000 })).rejects.toMatchObject({
      code: 'NOT_AVAILABLE_ON_PLATFORM',
      message: expect.stringContaining('step_output_not_available'),
    });
    expect(fake.calls('POST', /device-proxy\/run-1\/execute_step$/)).toHaveLength(1);
  });

  it('runs web steps with no change once Revyl accepts them asynchronously', async () => {
    const fake = fakeWeb(new FakeRevyl())
      .on('POST', /execute_step$/, () => json({ step_id: 'web-1', status: 'accepted' }, 202))
      .on('GET', /step_status\/web-1$/, () => json({ step_id: 'web-1', status: 'completed', result: stepResult({ status: 'success', validation_result: true }) }));
    const session = await RevylSession.start(fake.client(), target({ platform: 'web', app: { appId: APP_ID, buildId: BUILD_ID } }));
    expect((await session.runStep('validation', 'The page loaded', { timeoutMs: 5_000 })).step_output.validation_result).toBe(true);
  });

  it('does not repeat a step whose outcome is uncertain', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] }).on('POST', /execute_step$/, () =>
      json({ error: 'request_timeout', execution_uncertain: true }, 504),
    );
    const session = await RevylSession.start(fake.client(), android);
    await expect(session.runStep('instruction', 'Pay', { timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    expect(fake.calls('POST', /execute_step$/)).toHaveLength(1);
  });
});
