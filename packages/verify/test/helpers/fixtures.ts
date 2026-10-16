import { Agent } from '../../src/agent.js';
import { App } from '../../src/app.js';
import { validateConfig } from '../../src/config.js';
import { createScreen } from '../../src/locator.js';
import { RevylSession } from '../../src/session.js';
import { StepRecorder } from '../../src/steps.js';
import { APP_ID, BUILD_ID, FakeRevyl, RUN_ID, json, png } from './fake-revyl.js';

export async function startSession(fake: FakeRevyl, platform: 'android' | 'web'): Promise<RevylSession> {
  const raw = platform === 'web' ? { platform, app: { appId: APP_ID, buildId: BUILD_ID } } : { platform, app: { appId: APP_ID } };
  const target = validateConfig({ targets: [raw] }, '/project/verify.config.ts').targets[0]!;
  return RevylSession.start(fake.client(), target);
}

export function fixturesFor(session: RevylSession, timeouts = { action: 300, assertion: 300 }) {
  const steps = new StepRecorder();
  const context = {
    platform: session.platform,
    actionTimeout: timeouts.action,
    assertionTimeout: timeouts.assertion,
    session: async () => session,
    signal: () => undefined,
    steps,
  };
  return {
    steps,
    screen: createScreen(context),
    agent: new Agent({ agentTimeout: 5_000, session: async () => session, signal: () => undefined, steps }),
    app: new App({ session, signal: () => undefined, steps, attachmentDir: '/tmp/verify-test-attachments', attachments: [] }),
  };
}

export function fakeWebRuntime(fake: FakeRevyl): FakeRevyl {
  return fake
    .on('POST', /^\/api\/v1\/execution\/start_device$/, (request) =>
      json({ status: 'starting', platform: 'web', session_id: request.body.session_id }),
    )
    .on('GET', /^\/api\/v1\/execution\/device-sessions\/[^/]+$/, () => json({ id: 'x', status: 'running', workflow_run_id: RUN_ID }))
    .on('GET', /device-proxy\/run-1\/screenshot$/, () => new Response(png(1280, 800)))
    .on('GET', /device-proxy\/run-1\/tabs$/, () => json([{ tab_id: 't1', active: true, url_origin: 'https://shop.example.com', route_pattern: '/' }]))
    .on('POST', /device-proxy\/run-1\/(input|scroll|open_url|key)$/, (request) =>
      json({ success: true, action: request.path.split('/').pop(), latency_ms: 1 }),
    )
    .on('POST', /\/device\/sessions\/[^/]+\/stop$/, () => json({ success: true, request_accepted: true, session_id: 'x', status: 'stopping', message: '' }));
}
