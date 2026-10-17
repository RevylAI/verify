import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ID, FakeRevyl, fakeAndroid, json, stepResult } from './helpers/fake-revyl.js';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const jiti = pathToFileURL(createRequire(import.meta.url).resolve('jiti')).href;
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface ScriptRun {
  code: number | null;
  stderr: string;
}

/** Runs a plain Node script that uses Verify against the fake API, the way a user's script would run. */
async function runScript(
  fake: FakeRevyl,
  body: string,
  options: { config?: string; interruptWhen?: () => boolean } = {},
): Promise<ScriptRun> {
  const server = await fake.serve();
  servers.push(server);
  const dir = await mkdtemp(join(tmpdir(), 'verify-script-'));
  if (options.config) await writeFile(join(dir, 'verify.config.ts'), options.config);
  const script = join(dir, 'script.mjs');
  await writeFile(
    script,
    `import { createJiti } from ${JSON.stringify(jiti)};\nconst { open } = await createJiti(import.meta.url).import(${JSON.stringify(entry)});\n${body}\n`,
  );
  const child = spawn(process.execPath, [script], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, REVYL_API_KEY: 'test-key', REVYL_BACKEND_URL: server.url },
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const watcher = setInterval(() => {
    if (!options.interruptWhen?.()) return;
    clearInterval(watcher);
    child.kill('SIGINT');
  }, 50);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearInterval(watcher);
  return { code, stderr };
}

const target = `{ platform: 'android', app: { appId: '${APP_ID}' } }`;

function stepOutcome(passed: boolean): FakeRevyl {
  return fakeAndroid(new FakeRevyl()).on('POST', /execute_step$/, () =>
    json(stepResult({ status: passed ? 'success' : 'failed', validation_result: passed, status_reason: passed ? 'ok' : 'The cart is not empty' })),
  );
}

describe('a script using Verify', () => {
  it('opens a target by name from verify.config.ts, runs steps, closes, and exits 0', async () => {
    const fake = stepOutcome(true);
    const run = await runScript(
      fake,
      `const session = await open('pixel');
await session.instruction('Empty the cart');
await session.validation('The cart is empty');
await session.close();`,
      { config: `export default { targets: { pixel: ${target} } };` },
    );
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('[verify] pixel: ✓ validation "The cart is empty"');
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
    expect(fake.requests[0]?.headers.get('x-revyl-client')).toBe('verify');
  });

  it('exits non-zero on a failed validation and closes the session it left open', async () => {
    const fake = stepOutcome(false);
    const run = await runScript(
      fake,
      `const session = await open(${target});
await session.validation('The cart is empty');
await session.close();`,
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('VALIDATION_FAILED: Validation failed: "The cart is empty". The cart is not empty.');
    expect(run.stderr).toContain('Closing the android session before exiting');
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('closes a session the script forgot to close', async () => {
    const fake = stepOutcome(true);
    const run = await runScript(fake, `const session = await open(${target});\nawait session.validation('The cart is empty');`);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain('the script left open');
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('closes the session on Ctrl+C during a step and exits 130', async () => {
    const fake = fakeAndroid(new FakeRevyl())
      .on('POST', /execute_step$/, () => json({ step_id: 'long', status: 'accepted' }, 202))
      .on('GET', /step_status\/long$/, () => json({ step_id: 'long', status: 'running' }));
    const run = await runScript(fake, `const session = await open(${target});\nawait session.instruction('Browse for a while');`, {
      interruptWhen: () => fake.calls('GET', /step_status\/long$/).length > 0,
    });
    expect(run.code).toBe(130);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('fails with a clear message when there are no credentials', async () => {
    const fake = new FakeRevyl();
    const server = await fake.serve();
    servers.push(server);
    const dir = await mkdtemp(join(tmpdir(), 'verify-script-'));
    const script = join(dir, 'script.mjs');
    await writeFile(
      script,
      `import { createJiti } from ${JSON.stringify(jiti)};\nconst { open } = await createJiti(import.meta.url).import(${JSON.stringify(entry)});\nawait open(${target});\n`,
    );
    const child = spawn(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, REVYL_BACKEND_URL: server.url } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('No Revyl credentials found');
    expect(fake.requests).toHaveLength(0);
  });
});
