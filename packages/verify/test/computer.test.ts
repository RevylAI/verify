import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerSession, computerOperationId } from '../src/computer-session.js';
import { validateTarget, type ResolvedComputerTarget } from '../src/config.js';
import { open } from '../src/open.js';
import type { Session } from '../src/index.js';
import { FakeRevyl, json, png } from './helpers/fake-revyl.js';

const sessions: Session[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
});

function fakeMac(): FakeRevyl {
  return new FakeRevyl()
    .on('POST', /^\/api\/v1\/computer-runs$/, (request) => json({ computer_session_id: request.body.computer_session_id, state: 'active' }))
    .on('POST', /\/computer-runs\/([^/]+)\/stop$/, (_request, match) => json({ computer_session_id: match[1], state: 'stopped', release: 'confirmed' }));
}

async function start(fake: FakeRevyl, lines: string[] = []): Promise<Session> {
  const session = await ComputerSession.start(fake.client(), validateTarget({ platform: 'mac' }) as ResolvedComputerTarget, { stepTimeout: 1000, log: (line) => lines.push(line) });
  sessions.push(session);
  return session;
}

function result(fake: FakeRevyl, execution: unknown): FakeRevyl {
  return fake.on('POST', /\/operations$/, ({ body }) => json({ computer_session_id: body.computer_session_id, operation_id: computerOperationId(body.computer_session_id, body.request_id), execution, evidence: 'recorded' }));
}

describe('computer lifecycle', () => {
  it('opens a named Mac through the public entry point and closes idempotently', async () => {
    const fake = fakeMac();
    const dir = await mkdtemp(join(tmpdir(), 'verify-mac-'));
    await writeFile(join(dir, 'verify.config.ts'), `export default {targets:{mac:{platform:'mac'}}}`);
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubEnv('REVYL_API_KEY', 'test-key');
    const session = await open('mac', { config: join(dir, 'verify.config.ts'), log: false });
    sessions.push(session);
    expect(session.viewerUrl).toBe(`https://app.revyl.ai/sessions/${session.id}?kind=computer`);
    expect(fake.requests[0]?.body).toEqual({ computer_session_id: session.id, os: 'macos' });
    expect(fake.requests[0]?.headers.get('x-revyl-client')).toBe('verify');
    await Promise.all([session.close(), session.close()]);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
    await expect(session.exec(['true'])).rejects.toMatchObject({ code: 'SESSION_ENDED' });
  });

  it('refuses inline and named Linux before credentials or any request', async () => {
    const fake = new FakeRevyl();
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubEnv('REVYL_API_KEY', '');
    vi.stubEnv('REVYL_BACKEND_URL', 'not-a-url');
    await expect(open({ platform: 'linux' })).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM', message: expect.stringContaining('Linux computers are planned') });
    const dir = await mkdtemp(join(tmpdir(), 'verify-linux-'));
    await writeFile(join(dir, 'verify.config.ts'), `export default {targets:{linux:{platform:'linux'}}}`);
    await expect(open('linux', { config: join(dir, 'verify.config.ts') })).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    expect(fake.requests).toHaveLength(0);
  });

  it('waits for the active report without submitting a probe operation', async () => {
    vi.useFakeTimers();
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'starting' }))
      .on('GET', /\/report$/, (_request, match) => json({ computer_session_id: fake.requests[0]?.body.computer_session_id, state: 'active' }));
    const pending = start(fake);
    await vi.advanceTimersByTimeAsync(2_001);
    await pending;
    expect(fake.calls('GET', /\/report$/)).toHaveLength(1);
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(0);
  });

  it('cleans up a failed startup and sanitizes the server failure reason', async () => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'failed', failure_reason: 'private runtime payload' }));
    await expect(start(fake)).rejects.toMatchObject({ code: 'SESSION_START_FAILED', message: expect.not.stringContaining('private runtime payload') });
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('does not send a stop mutation after a definite admission refusal', async () => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, () => json({ detail: 'computer_not_enabled' }, 403));
    await expect(start(fake)).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM', message: expect.stringContaining('Mac computers are in early access') });
    expect(fake.requests).toHaveLength(1);
  });

  it('times out startup and stops the run', async () => {
    const timeout = AbortSignal.timeout;
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 600_000 ? controller.signal : timeout(ms));
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'starting' }))
      .on('GET', /\/report$/, () => json({ computer_session_id: fake.requests[0]?.body.computer_session_id, state: 'starting' }));
    const pending = expect(start(fake)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    controller.abort();
    await pending;
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('does not send unsupported agent steps', async () => {
    const fake = fakeMac();
    const session = await start(fake);
    await expect(session.instruction('hi')).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    await expect(session.validation('ready', { soft: true })).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    expect(fake.requests).toHaveLength(1);
  });

  it('reports uncertain physical release rather than claiming the computer closed', async () => {
    const fake = fakeMac().on('POST', /\/computer-runs\/([^/]+)\/stop$/, (_request, match) => json({ computer_session_id: match[1], state: 'stopped', release: 'unknown' }));
    const lines: string[] = [];
    const session = await start(fake, lines);
    await expect(session.close()).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    expect(lines).not.toContain('mac: closed');
    expect(lines.at(-1)).toContain('close failed');
    await expect(session.close()).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('reads and saves the supported computer screenshot endpoint', async () => {
    const bytes = png(800, 600);
    const fake = fakeMac().on('GET', /\/screen\/screenshot$/, () => json({ width: 800, height: 600, png: Buffer.from(bytes).toString('base64') }));
    const session = await start(fake);
    const dir = await mkdtemp(join(tmpdir(), 'verify-shot-'));
    const path = join(dir, 'nested', 'screen.png');
    expect(Buffer.from(await session.screenshot({ path }))).toEqual(Buffer.from(bytes));
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  });
});

describe('computer operations', () => {
  it('matches Python UUIDv5 for the operation identity', () => {
    expect(computerOperationId('11111111-2222-4333-8444-555555555555', '0b6a8c3e-1111-4222-8333-944455556666')).toBe('0b3be4ad-9a8e-530b-82d0-99b3a8a57787');
  });

  it('executes argv without a shell, sends stdin as base64 and decodes output', async () => {
    const fake = result(fakeMac(), { outcome: 'succeeded', result: { kind: 'exec', exit_code: 0, stdout: Buffer.from('ok\n').toString('base64'), stderr: '' } });
    const session = await start(fake);
    expect(await session.exec(['printf', '%s', 'a b'], { stdin: 'input', timeout: 300_000 })).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' });
    const request = fake.calls('POST', /\/operations$/)[0]!;
    expect(request.body.command).toEqual({ kind: 'exec', argv: ['printf', '%s', 'a b'], stdin: 'aW5wdXQ=', timeout_ms: 300_000 });
    expect(request.headers.get('prefer')).toBe('respond-async');
  });

  it('throws on nonzero exit unless check is false', async () => {
    const fake = result(fakeMac(), { outcome: 'failed', error_code: 'exec_nonzero', result: { kind: 'exec', exit_code: 7, stdout: '', stderr: 'bm8=' } });
    const session = await start(fake);
    await expect(session.exec(['false'])).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    expect(await session.exec(['false'], { check: false })).toEqual({ exitCode: 7, stdout: '', stderr: 'no' });
  });

  it('polls the deterministic operation id after null 202 without resubmitting', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const fake = fakeMac().on('POST', /\/operations$/, () => json(null, 202)).on('GET', /\/operations\/([^/]+)$/, (_request, match) => {
      if (++polls === 1) return json(null, 202);
      return json({ computer_session_id: fake.requests[0]?.body.computer_session_id, operation_id: match[1], execution: { outcome: 'succeeded', result: { kind: 'exec', exit_code: 0 } }, evidence: 'recorded' });
    });
    const session = await start(fake);
    const pending = session.exec(['true']);
    await vi.advanceTimersByTimeAsync(4_001);
    expect(await pending).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(1);
    expect(polls).toBe(2);
  });

  it('keeps the submission alive beyond the owner’s 60-second async hold', async () => {
    const fake = result(fakeMac(), { outcome: 'succeeded', result: { kind: 'exec', exit_code: 0 } });
    const client = fake.client();
    const send = vi.spyOn(client, 'send');
    const session = await ComputerSession.start(client, validateTarget({ platform: 'mac' }) as ResolvedComputerTarget, { stepTimeout: 1000, log: undefined });
    sessions.push(session);
    await session.exec(['true']);
    const options = send.mock.calls.find((call) => call[1].endsWith('/operations'))?.[2];
    expect(options?.timeoutMs).toBeGreaterThan(60_000);
    expect(options?.retry).toBe(false);
  });

  it('refuses malformed pending responses instead of polling an invented contract', async () => {
    const fake = fakeMac().on('POST', /\/operations$/, () => json({ status: 'pending' }, 202));
    const session = await start(fake);
    await expect(session.exec(['true'])).rejects.toMatchObject({ code: 'API_ERROR' });
    expect(fake.calls('GET', /\/operations\//)).toHaveLength(0);
  });

  it('retains a confirmed outcome when report evidence failed and makes the gap visible', async () => {
    const fake = fakeMac().on('POST', /\/operations$/, ({ body }) => json({ computer_session_id: body.computer_session_id, operation_id: computerOperationId(body.computer_session_id, body.request_id), execution: { outcome: 'succeeded', result: { kind: 'exec', exit_code: 0 } }, evidence: 'failed' }));
    const lines: string[] = [];
    const session = await start(fake, lines);
    expect((await session.exec(['true'])).exitCode).toBe(0);
    expect(lines.at(-1)).toContain('report evidence failed');
  });

  it('maps file and process operations one-to-one', async () => {
    const processId = '11111111-2222-4333-8444-555555555555';
    const fake = fakeMac().on('POST', /\/operations$/, ({ body }) => {
      const results = {
        file_read: { kind: 'file_read', data: '_-8=' },
        file_write: { kind: 'file_write', byte_count: 3 },
        file_stat: { kind: 'file_stat', file_kind: 'file', size_bytes: 3 },
        process_list: { kind: 'process_list', processes: [{ handle: { computer_session_id: body.computer_session_id, handle_id: processId }, state: 'running' }] },
        process_terminate: { kind: 'process_terminate', termination: 'confirmed' },
      };
      return json({ computer_session_id: body.computer_session_id, operation_id: computerOperationId(body.computer_session_id, body.request_id), execution: { outcome: 'succeeded', result: results[body.command.kind as keyof typeof results] }, evidence: 'recorded' });
    });
    const session = await start(fake);
    expect(await session.readFile('a')).toEqual(Buffer.from([255, 239]));
    await session.writeFile('a', 'hey');
    expect(await session.stat('a')).toEqual({ kind: 'file', size: 3 });
    expect(await session.processes()).toEqual([{ id: processId, state: 'running' }]);
    await session.terminate(processId);
    expect(fake.calls('POST', /\/operations$/).map((r) => r.body.command.kind)).toEqual(['file_read', 'file_write', 'file_stat', 'process_list', 'process_terminate']);
  });

  it('decodes a maximum-sized file without truncation or a regex stack overflow', async () => {
    const bytes = Buffer.alloc(1_048_576, 255);
    const fake = result(fakeMac(), { outcome: 'succeeded', result: { kind: 'file_read', data: bytes.toString('base64url') + '==' } });
    const session = await start(fake);
    expect(await session.readFile('large.bin')).toEqual(bytes);
  });

  it.each([
    [{ outcome: 'failed', error_code: 'not_found' }, 'NOT_FOUND'],
    [{ outcome: 'failed', error_code: 'access_denied' }, 'ACCESS_DENIED'],
    [{ outcome: 'timed_out', error_code: 'timed_out', termination: 'confirmed' }, 'TIMEOUT'],
    [{ outcome: 'timed_out', error_code: 'timed_out', termination: 'unknown' }, 'ACTION_UNCERTAIN'],
    [{ outcome: 'unknown', error_code: 'lost_ack', termination: 'unknown' }, 'ACTION_UNCERTAIN'],
  ])('maps execution %j to %s', async (execution, code) => {
    const fake = result(fakeMac(), execution);
    const session = await start(fake);
    await expect(session.exec(['true'], { check: false })).rejects.toMatchObject({ code });
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(1);
  });

  it.each([
    [403, 'computer_not_enabled', 'NOT_AVAILABLE_ON_PLATFORM'],
    [401, 'unauthenticated', 'AUTH_REJECTED'],
    [403, 'forbidden', 'AUTH_REJECTED'],
    [409, 'run_closed', 'SESSION_ENDED'],
    [404, 'inaccessible', 'NOT_FOUND'],
    [404, 'invalid_handle', 'NOT_FOUND'],
    [404, 'operation_not_found', 'ACTION_UNCERTAIN'],
    [409, 'owner_unavailable', 'ACTION_UNCERTAIN'],
    [409, 'request_conflict', 'SESSION_BUSY'],
    [429, 'operation_limit', 'SESSION_BUSY'],
    [422, 'invalid_request', 'INVALID_ARGUMENT'],
    [503, 'evidence_unavailable', 'ACTION_UNCERTAIN'],
  ])('maps HTTP %s %s to %s', async (status, detail, code) => {
    const fake = fakeMac().on('POST', /\/operations$/, () => json({ detail }, status));
    const session = await start(fake);
    await expect(session.exec(['true'])).rejects.toMatchObject({ code });
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(1);
  });

  it('does not repeat a mutation after transport failure or echo its raw error', async () => {
    const fake = fakeMac().on('POST', /\/operations$/, () => { throw new Error('private payload'); });
    const session = await start(fake);
    await expect(session.exec(['true'])).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN', message: expect.not.stringContaining('private payload') });
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(1);
  });

  it('rejects invalid inputs before submitting operations', async () => {
    const fake = fakeMac();
    const session = await start(fake);
    for (const path of ['/etc/passwd', '../a', 'a//b', 'a/./b', 'a\\b', 'a\nb']) await expect(session.readFile(path)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.exec([])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.exec(['a\0'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.exec(['a'], { timeout: 300_001 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.exec(['a'], { stdin: Buffer.alloc(16_384) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.writeFile('a', Buffer.alloc(65_537))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(session.terminate('123')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(0);
  });

  it('rejects a response for a different session or result kind', async () => {
    const fake = result(fakeMac(), { outcome: 'succeeded', result: { kind: 'file_write', byte_count: 3 } });
    const session = await start(fake);
    await expect(session.exec(['true'])).rejects.toMatchObject({ code: 'API_ERROR' });
    fake.on('POST', /\/operations$/, () => json({ computer_session_id: 'other', operation_id: 'other', execution: {}, evidence: 'recorded' }));
    await expect(session.readFile('a')).rejects.toMatchObject({ code: 'API_ERROR' });
  });
});
