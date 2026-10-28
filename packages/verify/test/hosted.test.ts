import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { attach, open } from '../src/index.js';
import { ComputerSession } from '../src/computer-session.js';
import { DeviceSession, type OpenedSession, type Session } from '../src/session.js';
import { validateTarget, type ResolvedDeviceTarget } from '../src/config.js';
import { APP_ID, BUILD_ID, FakeRevyl, fakeAndroid, json, png, stepResult } from './helpers/fake-revyl.js';

const COMPUTER_ID = '12345678-1234-4234-8234-123456789abc';
const sessions: Session[] = [];
const web = { platform: 'web' as const, app: { appId: APP_ID, buildId: BUILD_ID } };

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function runtime(os = 'macos'): FakeRevyl {
  return new FakeRevyl()
    .on('GET', /\/computer-runs\/[^/]+\/report$/, () => json({ computer_session_id: COMPUTER_ID, os, state: 'active', expires_at: new Date(Date.now() + 60_000).toISOString() }))
    .on('POST', /\/computer-runs\/[^/]+\/stop$/, () => json({ computer_session_id: COMPUTER_ID, state: 'stopped', release: 'confirmed' }))
    .on('POST', /\/start_device$/, ({ body }) => json({ session_id: body.session_id, workflow_run_id: 'child-run', platform: body.platform }))
    .on('GET', /\/device-sessions\/[^/]+$/, (_request, match) => json({ id: match[0].split('/').at(-1), status: 'running', workflow_run_id: 'child-run' }))
    .on('GET', /\/worker-connection\/child-run$/, () => json({ status: 'ready', worker_ws_url: 'wss://example.com', workflow_run_id: 'child-run' }))
    .on('GET', /\/child-run\/health$/, () => json({ device_connected: true }))
    .on('GET', /\/child-run\/screenshot$/, () => new Response(png(800, 600)))
    .on('POST', /\/child-run\/open_url$/, () => json({ success: true, action: 'navigate', status_code: 200 }))
    .on('POST', /\/child-run\/execute_step$/, () => json(stepResult({ status: 'success', validation_result: true })))
    .on('POST', /\/device\/sessions\/[^/]+\/stop$/, () => json({ success: true }));
}

async function computer(fake: FakeRevyl): Promise<ComputerSession> {
  const parent = await ComputerSession.attach(fake.client(), COMPUTER_ID, { stepTimeout: 1_000, log: undefined });
  sessions.push(parent);
  return parent;
}

describe('attached computers and hosted children', () => {
  it.each(['macos', 'linux'])('attaches to %s without creating or mutating a session', async (os) => {
    const fake = runtime(os);
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubEnv('REVYL_API_KEY', 'test-key');
    const parent = await attach(COMPUTER_ID, { log: false });
    sessions.push(parent);
    expect(parent.platform).toBe(os === 'macos' ? 'mac' : 'linux');
    expect(parent.id).toBe(COMPUTER_ID);
    expect(parent.viewerUrl).toContain(COMPUTER_ID);
    expect(parent.expiresAt).toBeInstanceOf(Date);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers.get('authorization')).toBe('Bearer test-key');
    expect((await parent.report()).computer_session_id).toBe(COMPUTER_ID);
  });

  it.each([
    { computer_session_id: 'wrong', state: 'active', os: 'macos' },
    { computer_session_id: COMPUTER_ID, state: 'active', os: 'unknown' },
    { computer_session_id: COMPUTER_ID, state: 'active', os: 'macos' },
    { computer_session_id: COMPUTER_ID, state: 'stopped', os: 'macos' },
    { computer_session_id: COMPUTER_ID, state: 'active', os: 'macos', expires_at: '2000-01-01T00:00:00Z' },
  ])('rejects invalid/nonrunning attach without stopping it', async (report) => {
    const fake = runtime().on('GET', /\/report$/, () => json(report));
    await expect(computer(fake)).rejects.toBeDefined();
    expect(fake.requests).toHaveLength(1);
  });

  it.each([['macos', 'web'], ['macos', 'ios'], ['linux', 'android'], ['linux', 'web']] as const)('starts %s child %s and closes it before its parent', async (os, platform) => {
    const fake = runtime(os);
    const parent = await computer(fake);
    const child = await parent.open({ ...web, platform });
    const payload = fake.calls('POST', /\/start_device$/)[0]!.body;
    expect(payload).toMatchObject({ computer_session_id: COMPUTER_ID, app_id: APP_ID, build_id: BUILD_ID, platform, session_id: child.id });
    expect(child.id).not.toBe(COMPUTER_ID);
    expect(payload.is_simulation).toBe(platform === 'web' ? undefined : true);
    expect(child.expiresAt?.getTime()).toBe(parent.expiresAt?.getTime());
    expect((await child.report()).status).toBe('running');
    expect(await child.screenshot()).toEqual(png(800, 600));
    expect((await child.validation('A button is visible')).passed).toBe(true);
    await parent.close();
    const stops = fake.calls('POST', /\/stop$/);
    expect(stops.map((call) => call.path)).toEqual([`/api/v1/execution/device/sessions/${child.id}/stop`, `/api/v1/computer-runs/${COMPUTER_ID}/stop`]);
    await expect(child.screenshot()).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await expect(parent.open(web)).rejects.toMatchObject({ code: 'SESSION_ENDED' });
  });

  it('navigates hosted web to loopback only after its existing build starts', async () => {
    const fake = runtime();
    const child = await (await computer(fake)).open(web);
    await child.navigate('http://localhost:3000/feature?test=1');
    expect(fake.calls('POST', /\/open_url$/)[0]?.body).toEqual({ url: 'http://localhost:3000/feature?test=1' });
    expect(fake.calls('POST', /\/start_device$/)[0]?.body).not.toHaveProperty('url');
    expect(fake.calls('POST', /\/builds\/external$/)).toHaveLength(0);
  });

  it.each([
    ['computer_at_capacity', 409, 'COMPUTER_LIMIT'],
    ['computer_not_running', 409, 'SESSION_ENDED'],
    ['computer_cannot_host_platform', 409, 'NOT_AVAILABLE_ON_PLATFORM'],
    ['computer_runtime_unavailable', 503, 'NOT_AVAILABLE_ON_PLATFORM'],
    ['web_runtime_not_configured', 503, 'NOT_AVAILABLE_ON_PLATFORM'],
    ['computer_not_found', 404, 'NOT_FOUND'],
    ['web_build_required', 422, 'INVALID_ARGUMENT'],
    ['web_session_conflict', 409, 'SESSION_BUSY'],
  ])('retains safe nested %s without replay or child stop', async (reason, status, code) => {
    const fake = runtime().on('POST', /\/start_device$/, () => json({ detail: { error: reason, platform: 'web', message: 'private payload' } }, status as number));
    await expect((await computer(fake)).open(web)).rejects.toMatchObject({ code, reason, httpStatus: status, message: expect.not.stringContaining('private payload') });
    expect(fake.calls('POST', /\/start_device$/)).toHaveLength(1);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(0);
  });

  it('cleans uncertain child startup identity without stopping its parent', async () => {
    const fake = runtime().on('POST', /\/start_device$/, () => { throw new TypeError('network disconnected'); });
    const parent = await computer(fake);
    await expect(parent.open(web)).rejects.toMatchObject({ code: 'API_ERROR' });
    const childId = fake.calls('POST', /\/start_device$/)[0]?.body.session_id;
    expect(fake.calls('POST', /\/stop$/).map((call) => call.path)).toEqual([`/api/v1/execution/device/sessions/${childId}/stop`]);
    expect(parent.closed).toBe(false);
  });

  it.each([
    { session_id: 'a different session', workflow_run_id: 'child-run' },
    { workflow_run_id: '' },
    { workflow_run_id: 'invalid / run' },
    { workflow_run_id: 'child-run', platform: 'android' },
  ])('cleans only the requested identity after malformed acknowledgment', async (response) => {
    const fake = runtime().on('POST', /\/start_device$/, ({ body }) => json({ session_id: body.session_id, ...response }));
    await expect((await computer(fake)).open(web)).rejects.toMatchObject({ code: 'SESSION_START_FAILED' });
    const requested = fake.calls('POST', /\/start_device$/)[0]!.body.session_id;
    expect(fake.calls('POST', /\/stop$/).map((call) => call.path)).toEqual([`/api/v1/execution/device/sessions/${requested}/stop`]);
  });

  it('rejects unsupported and overridden hosted targets without sending a start', async () => {
    const fake = runtime();
    const parent = await computer(fake);
    for (const target of [
      { platform: 'android', app: { appId: APP_ID, buildId: BUILD_ID } },
      { ...web, app: { appId: APP_ID } },
      { ...web, app: { appId: APP_ID, buildId: BUILD_ID, url: 'http://localhost:3000' } },
      { platform: 'ios', app: { appId: APP_ID, buildId: BUILD_ID }, device: { model: 'Other phone' } },
    ]) await expect(parent.open(target as typeof web)).rejects.toBeDefined();
    expect(fake.calls('POST', /\/start_device$/)).toHaveLength(0);
  });

  it('keeps the parent usable after a child closes', async () => {
    const fake = runtime();
    const parent = await computer(fake);
    const child = await parent.open(web);
    await child.close();
    expect(parent.closed).toBe(false);
    expect((await parent.report()).state).toBe('active');
    expect(fake.calls('POST', /\/computer-runs\/[^/]+\/stop$/)).toHaveLength(0);
  });

  it('requires a known parent expiry before starting a child', async () => {
    const fake = runtime().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'active' }));
    const parent = await ComputerSession.start(fake.client(), validateTarget({ platform: 'mac' }) as import('../src/config.js').ResolvedComputerTarget, { stepTimeout: 1000, log: undefined });
    sessions.push(parent);
    await expect(parent.open(web)).rejects.toMatchObject({ code: 'API_ERROR' });
    expect(fake.calls('POST', /\/start_device$/)).toHaveLength(0);
  });

  it.each([null, [], 'unexpected'])('rejects a nonobject hosted response and cleans the allocated identity', async (response) => {
    const fake = runtime().on('POST', /\/start_device$/, () => json(response));
    await expect((await computer(fake)).open(web)).rejects.toMatchObject({ code: 'API_ERROR' });
    const requested = fake.calls('POST', /\/start_device$/)[0]!.body.session_id;
    expect(fake.calls('POST', /\/stop$/).map((call) => call.path)).toEqual([`/api/v1/execution/device/sessions/${requested}/stop`]);
  });

  it('joins in-flight child starts before stopping the computer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = runtime().on('POST', /\/start_device$/, async ({ body }) => {
      await gate;
      return json({ session_id: body.session_id, workflow_run_id: 'child-run' });
    });
    const parent = await computer(fake);
    const pending = expect(parent.open(web)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(fake.calls('POST', /\/start_device$/)).toHaveLength(1));
    const close = parent.close();
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(0);
    release();
    await pending;
    await close;
    const childId = fake.calls('POST', /\/start_device$/)[0]?.body.session_id;
    expect(fake.calls('POST', /\/stop$/).map((call) => call.path)).toEqual([`/api/v1/execution/device/sessions/${childId}/stop`, `/api/v1/computer-runs/${COMPUTER_ID}/stop`]);
  });

  it('stops the parent after five seconds even when a child stop is still pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = runtime().on('POST', /\/device\/sessions\/[^/]+\/stop$/, async () => {
      await gate;
      return json({ success: true });
    });
    const parent = await computer(fake);
    const child = await parent.open(web);
    const started = performance.now();
    try {
      await parent.close();
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(fake.calls('POST', /\/stop$/).map((call) => call.path)).toEqual([`/api/v1/execution/device/sessions/${child.id}/stop`, `/api/v1/computer-runs/${COMPUTER_ID}/stop`]);
    } finally {
      release();
      await child.close();
    }
  }, 10_000);

  it('bounds the combined pending-start and child-stop phase before stopping the parent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = runtime().on('POST', /\/start_device$/, async ({ body }) => {
      await gate;
      return json({ session_id: body.session_id, workflow_run_id: 'child-run' });
    });
    const parent = await computer(fake);
    const pending = expect(parent.open(web)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(fake.calls('POST', /\/start_device$/)).toHaveLength(1));
    const started = performance.now();
    try {
      await parent.close();
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(fake.calls('POST', /\/computer-runs\/[^/]+\/stop$/)).toHaveLength(1);
    } finally {
      release();
      await pending;
    }
  }, 10_000);
});

describe('safe startup refusal and navigation', () => {
  it('keeps legacy Session implementations valid while open returns the extended API', () => {
    expectTypeOf<Omit<OpenedSession, 'report' | 'navigate' | 'open'>>().toMatchTypeOf<Session>();
    expectTypeOf<Awaited<ReturnType<typeof open>>>().toMatchTypeOf<OpenedSession>();
  });

  it('rejects an unknown native session ID before requesting a report', async () => {
    const fake = fakeAndroid(new FakeRevyl())
      .on('POST', /\/start_device$/, () => json({ workflow_run_id: 'run-1' }))
      .on('POST', /\/status\/cancel\/run-1$/, () => json({ success: true }));
    const session = await DeviceSession.start(fake.client(), validateTarget({ platform: 'android', app: { appId: APP_ID } }) as ResolvedDeviceTarget, { stepTimeout: 1000, log: undefined });
    sessions.push(session);
    const requests = fake.requests.length;
    await expect(session.report()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.requests).toHaveLength(requests);
  });

  it.each([{ detail: 'web_app_required' }, { detail: { error: 'web_app_required', message: 'private URL or token' } }])('retains safe start diagnostics without exposing server messages', async (body) => {
    const fake = runtime().on('POST', /\/start_device$/, () => json(body, 422));
    await expect(DeviceSession.start(fake.client(), validateTarget(web) as ResolvedDeviceTarget, { stepTimeout: 1000, log: undefined })).rejects.toMatchObject({ code: 'API_ERROR', reason: undefined, httpStatus: 422, message: expect.stringContaining('web_app_required') });
    expect(fake.requests).toHaveLength(1);
  });

  it('does not restore raw startup payloads as diagnostics', async () => {
    const fake = runtime().on('POST', /\/start_device$/, () => json({ detail: 'private URL or token', message: 'private URL or token' }, 422));
    await expect(DeviceSession.start(fake.client(), validateTarget(web) as ResolvedDeviceTarget, { stepTimeout: 1000, log: undefined })).rejects.toMatchObject({ code: 'API_ERROR', reason: undefined, message: expect.not.stringContaining('private URL or token') });
  });

  it.each([{ detail: 'web_runtime_unavailable' }, { detail: { error: 'web_runtime_unavailable', message: 'private' } }, { error: 'web_runtime_unavailable' }])('retains web startup capacity while keeping API_ERROR', async (body) => {
    const fake = runtime().on('POST', /\/start_device$/, () => json(body, 409));
    await expect(DeviceSession.start(fake.client(), validateTarget(web) as ResolvedDeviceTarget, { stepTimeout: 1000, log: undefined })).rejects.toMatchObject({ code: 'API_ERROR', reason: 'web_runtime_unavailable', httpStatus: 409, message: expect.not.stringContaining('private') });
    expect(fake.requests).toHaveLength(1);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(0);
    expect(fake.calls('POST', /\/status\/cancel\//)).toHaveLength(0);
  });

  it('navigates a normal web session without retrying a refused mutation', async () => {
    const fake = runtime().on('POST', /\/open_url$/, () => json({ detail: 'unavailable' }, 503));
    const session = await DeviceSession.start(fake.client(), validateTarget(web) as ResolvedDeviceTarget, { stepTimeout: 1000, log: undefined });
    sessions.push(session);
    await expect(session.navigate('http://localhost:3000')).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    expect(fake.calls('POST', /\/open_url$/)).toHaveLength(1);
  });

  it.each([[429, 'computer_limit', 'COMPUTER_LIMIT'], [503, 'runtime_unavailable', 'NOT_AVAILABLE_ON_PLATFORM']] as const)('retains computer startup %s detail with existing code', async (status, reason, code) => {
    const fake = runtime().on('POST', /^\/api\/v1\/computer-runs$/, () => json({ detail: reason }, status));
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubEnv('REVYL_API_KEY', 'test-key');
    await expect(open({ platform: 'mac' }, { log: false })).rejects.toMatchObject({ code, reason, httpStatus: status });
    expect(fake.requests).toHaveLength(1);
  });

  it.each([[429, 'computer_limit', 'COMPUTER_LIMIT'], [503, 'runtime_unavailable', 'NOT_AVAILABLE_ON_PLATFORM']] as const)('retains nested computer startup %s detail without cleanup', async (status, reason, code) => {
    const fake = runtime().on('POST', /^\/api\/v1\/computer-runs$/, () => json({ detail: { error: reason, message: 'private' } }, status));
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubEnv('REVYL_API_KEY', 'test-key');
    await expect(open({ platform: 'mac' }, { log: false })).rejects.toMatchObject({ code, reason, httpStatus: status });
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects unsafe navigation and wrong action envelopes without retry', async () => {
    const fake = runtime().on('POST', /\/open_url$/, () => json({ success: true, action: 'tap' }));
    const child = await (await computer(fake)).open(web);
    for (const url of ['file:///etc/passwd', 'https://user:password@example.com', 'http://localhost/a\nsecret', 'http://localhost/\\secret']) await expect(child.navigate(url)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.calls('POST', /\/open_url$/)).toHaveLength(0);
    await expect(child.navigate('https://example.com')).rejects.toMatchObject({ code: 'API_ERROR' });
    expect(fake.calls('POST', /\/open_url$/)).toHaveLength(1);
  });
});
