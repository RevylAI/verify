import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateConfig, type VerifyConfig } from '../src/config.js';
import { JsonReporter, ListReporter } from '../src/reporters.js';
import { collectJobs, runTests, type RunSummary } from '../src/runner.js';
import { APP_ID, FakeRevyl, SESSION_ID, fakeAndroid, json, stepResult } from './helpers/fake-revyl.js';
import { fakeWebRuntime } from './helpers/fixtures.js';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

async function project(tests: Record<string, string>, config: Partial<VerifyConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'verify-run-'));
  await mkdir(join(dir, 'tests'));
  for (const [name, source] of Object.entries(tests)) {
    await writeFile(join(dir, 'tests', name), `import { test, expect } from ${JSON.stringify(entry)};\n${source}`);
  }
  const resolved = validateConfig(
    { targets: [{ platform: 'android', app: { appId: APP_ID } }], retries: 0, ...config },
    join(dir, 'verify.config.ts'),
  );
  return { dir, config: resolved };
}

async function run(fake: FakeRevyl, setup: Awaited<ReturnType<typeof project>>, extra: { grep?: RegExp } = {}) {
  let printed = '';
  const summary: RunSummary = await runTests({
    config: setup.config,
    client: fake.client(),
    reporters: [new ListReporter({ write: (text: string) => (printed += text) }, setup.dir), JsonReporter.inDir(setup.config.outputDir)],
    ...extra,
  });
  return { summary, printed };
}

describe('runTests', () => {
  it('runs tests on one reused session and restarts the app between them', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [{ text: 'Home', bounds: [0, 0, 500, 100] }] }).on('POST', /execute_step$/, () =>
      json(stepResult({ status: 'success', extracted_data: { information: '3' } })),
    );
    const setup = await project({
      'home.verify.ts': `
test('shows home', async ({ screen }) => {
  await expect(screen.getByText('Home')).toBeVisible();
});
test('reads the badge', async ({ agent, step }) => {
  const count = await step('read badge', () => agent.extract('the cart badge number'));
  expect(Number(count)).toBe(3);
});`,
    });
    const { summary, printed } = await run(fake, setup);
    expect(summary.status).toBe('passed');
    expect(summary.stats).toMatchObject({ passed: 2, failed: 0 });
    expect(fake.calls('POST', /start_device/)).toHaveLength(1);
    expect(fake.calls('POST', /kill_app/)).toHaveLength(1);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
    expect(printed).toContain('✓ [android] tests/home.verify.ts › reads the badge');
    const report = JSON.parse(await readFile(join(setup.config.outputDir, 'results.json'), 'utf8'));
    expect(report).toMatchObject({ schemaVersion: 1, status: 'passed' });
    expect(report.tests[1].attempts[0].steps[0]).toMatchObject({ title: 'read badge', steps: [{ title: 'agent.extract: the cart badge number' }] });
  });

  it('retries a failed test, captures a failure screenshot, and reports a flaky pass', async () => {
    let calls = 0;
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] }).on('POST', /execute_step$/, () =>
      json(stepResult(++calls === 1 ? { status: 'failed', validation_result: false, status_reason: 'Spinner still visible' } : { status: 'success', validation_result: true })),
    );
    const setup = await project({ 'flaky.verify.ts': `test('loads', async ({ agent }) => { await agent.assert('The feed has loaded'); });` }, { retries: 1 });
    const { summary } = await run(fake, setup);
    const [result] = summary.tests;
    expect(result?.status).toBe('flaky');
    expect(result?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
    expect(result?.attempts[0]?.error).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(result?.attempts[0]?.attachments[0]?.name).toBe('failure.png');
    expect(result?.attempts[0]?.viewerUrl).toMatch(/^https:\/\/app\.revyl\.ai\/sessions\//);
  });

  it('prints each failure with its session link and fails the run', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] });
    const setup = await project({ 'fail.verify.ts': `test('checks out', async ({ screen }) => { await screen.getByText('Checkout').tap({ timeout: 200 }); });` });
    const { summary, printed } = await run(fake, setup);
    expect(summary.status).toBe('failed');
    expect(printed).toContain('LOCATOR_NOT_FOUND');
    expect(printed).toContain('Session: https://app.revyl.ai/sessions/');
    expect(printed).toContain('Failed step: getByText("Checkout").tap()');
  });

  it('times out a hung test and runs the next test on the same session', async () => {
    const fake = fakeAndroid(new FakeRevyl(), { nodes: [] });
    const setup = await project({
      'slow.verify.ts': `
test('hangs', { timeout: 1000 }, async ({ app }) => { await app.wait(60000); });
test('after', async () => {});`,
    });
    const { summary } = await run(fake, setup);
    expect(summary.tests.map((result) => [result.title, result.status])).toEqual([
      ['hangs', 'failed'],
      ['after', 'passed'],
    ]);
    expect(summary.tests[0]?.attempts[0]?.error).toMatchObject({ code: 'TIMEOUT' });
  });

  it('runs web and mobile targets, honors per-test targets, and reports web agent steps as not yet available', async () => {
    const fake = fakeWebRuntime(fakeAndroid(new FakeRevyl(), { nodes: [] }))
      .on('POST', /execute_step$/, (request) =>
        request.body.session_id === SESSION_ID
          ? json(stepResult({ status: 'success', validation_result: true }))
          : json({ error: 'step_output_not_available' }, 501),
      )
      .on('POST', /^\/api\/v1\/execution\/start_device$/, (request) =>
        request.body.platform === 'web'
          ? json({ status: 'starting', platform: 'web', session_id: request.body.session_id })
          : json({ status: 'starting', platform: 'android', session_id: SESSION_ID, workflow_run_id: 'run-1' }),
      );
    const setup = await project(
      {
        'cross.verify.ts': `
test('agent check', async ({ agent }) => { await agent.assert('The page loaded'); });
test('android only', { targets: ['android'] }, async ({ target }) => { expect(target.platform).toBe('android'); });`,
      },
      {
        targets: [
          { platform: 'android', app: { appId: APP_ID } },
          { platform: 'web', app: { appId: APP_ID, buildId: APP_ID } },
        ],
      },
    );
    const { summary } = await run(fake, setup);
    const outcome = Object.fromEntries(summary.tests.map((result) => [`${result.target}:${result.title}`, result.status]));
    expect(outcome).toEqual({ 'web:agent check': 'failed', 'android:agent check': 'passed', 'android:android only': 'passed' });
    const web = summary.tests.find((result) => result.target === 'web');
    expect(web?.attempts[0]?.error?.code).toBe('NOT_AVAILABLE_ON_PLATFORM');
  });
});

describe('collectJobs', () => {
  it('applies only, skip, grep, and describe titles', async () => {
    const setup = await project({
      'a.verify.ts': `
test.describe('cart', () => {
  test.only('adds an item', async () => {});
  test('removes an item', async () => {});
});
test.skip('later', async () => {});`,
    });
    const { jobs, skipped } = await collectJobs(setup.config);
    expect(jobs.map((job) => job.test.titlePath)).toEqual([['cart', 'adds an item']]);
    expect(skipped).toHaveLength(2);
    await expect(collectJobs(setup.config, { forbidOnly: true })).rejects.toMatchObject({ code: 'ONLY_IN_CI' });
  });

  it('reports a test file that does not load', async () => {
    const setup = await project({ 'broken.verify.ts': 'test(' });
    await expect(collectJobs(setup.config)).rejects.toMatchObject({ code: 'COLLECTION_ERROR', message: expect.stringContaining('broken.verify.ts') });
  });

  it('rejects a test that names an unknown target', async () => {
    const setup = await project({ 'a.verify.ts': `test('x', { targets: ['ipad'] }, async () => {});` });
    await expect(collectJobs(setup.config)).rejects.toMatchObject({ message: expect.stringContaining('"ipad"') });
  });
});
