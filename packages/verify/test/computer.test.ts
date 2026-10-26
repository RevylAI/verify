import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerSession, computerOperationId } from '../src/computer-session.js';
import { validateTarget, type ResolvedComputerTarget } from '../src/config.js';
import { open } from '../src/open.js';
import type { Session } from '../src/index.js';
import { FakeRevyl, json, png } from './helpers/fake-revyl.js';

const sessions: Session[] = [];
const contract: {
  active: Record<string, unknown>;
  stopped: Record<string, unknown>;
  operation: Record<string, unknown>;
  exec: Record<string, unknown>;
  nonzero: Record<string, unknown>;
  uuidV5: { session_id: string; request_id: string; operation_id: string };
} = JSON.parse(readFileSync(new URL('../../../go/testdata/computer-contract.json', import.meta.url), 'utf8'));
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
});

function fakeMac(): FakeRevyl {
  return new FakeRevyl()
    .on('POST', /^\/api\/v1\/computer-runs$/, (request) => json({ ...contract.active, computer_session_id: request.body.computer_session_id }))
    .on('POST', /\/computer-runs\/([^/]+)\/stop$/, (_request, match) => json({ ...contract.stopped, computer_session_id: match[1] }));
}

async function start(fake: FakeRevyl, lines: string[] = [], platform: 'mac' | 'linux' = 'mac'): Promise<Session> {
  const session = await ComputerSession.start(fake.client(), validateTarget({ platform }) as ResolvedComputerTarget, { stepTimeout: 1000, log: (line) => lines.push(line) });
  sessions.push(session);
  return session;
}

function result(fake: FakeRevyl, execution: unknown): FakeRevyl {
  return fake.on('POST', /\/operations$/, ({ body }) => json({ ...contract.operation, computer_session_id: body.computer_session_id, operation_id: computerOperationId(body.computer_session_id, body.request_id), execution }));
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

  it.each(['inline', 'named'])('opens %s Linux through the public entry point', async (mode) => {
    const fake = fakeMac();
    vi.stubGlobal('fetch', fake.fetch);
    vi.stubEnv('REVYL_API_KEY', 'test-key');
    const dir = await mkdtemp(join(tmpdir(), 'verify-linux-'));
    await writeFile(join(dir, 'verify.config.ts'), `export default {targets:{linux:{platform:'linux'}}}`);
    const session = await open(mode === 'inline' ? { platform: 'linux' } : 'linux', { config: join(dir, 'verify.config.ts'), log: false });
    sessions.push(session);
    expect(session.platform).toBe('linux');
    expect(fake.requests[0]?.body).toEqual({ computer_session_id: session.id, os: 'linux' });
    await expect(session.instruction('hi')).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    await expect(session.validation('hi')).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    expect(fake.requests).toHaveLength(1);
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

  it.each([
    [403, { detail: 'computer_not_enabled' }],
    [503, { error: 'computer_not_enabled' }],
    [503, { detail: 'runtime_unavailable' }],
    [503, { error: 'runtime_unavailable' }],
  ])('explains definite admission refusal %s without a stop mutation', async (status, body) => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, () => json(body, status));
    await expect(start(fake)).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM', message: expect.stringMatching(/Computers are not yet available in Revyl production.*computers\.md#availability-and-errors/) });
    expect(fake.requests).toHaveLength(1);
  });

  it('times out startup and stops the run', async () => {
    const timeout = AbortSignal.timeout;
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 600_000 ? controller.signal : timeout(ms));
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'starting' }))
      .on('GET', /\/report$/, () => json({ computer_session_id: fake.requests[0]?.body.computer_session_id, state: 'starting' }));
    const pending = expect(start(fake)).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringMatching(/no computer could be assigned.*Computers are not yet available in Revyl production.*computers\.md#availability-and-errors/) });
    await vi.waitFor(() => expect(fake.requests).toHaveLength(1));
    controller.abort();
    await pending;
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it.each(['mac', 'linux'] as const)('does not retry or stop definite %s capacity refusal', async (platform) => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, () => json({ detail: 'computer_limit' }, 429));
    await expect(start(fake, [], platform)).rejects.toMatchObject({ code: 'COMPUTER_LIMIT', message: expect.stringContaining('queued work (including iOS) or the concurrency limit. Verify will not retry the start.') });
    expect(fake.requests).toHaveLength(1);
  });

  it('surfaces the 120-second no-host transition without shortening the start timeout', async () => {
    vi.useFakeTimers();
    const beganAt = Date.now();
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'starting' }))
      .on('GET', /\/report$/, () => json({ computer_session_id: fake.requests[0]?.body.computer_session_id, state: Date.now() - beganAt < 120_000 ? 'starting' : 'failed', failure_reason: 'no_host' }));
    const pending = expect(start(fake)).rejects.toMatchObject({ code: 'SESSION_START_FAILED', message: expect.stringContaining('No host claimed the start within the 120-second unclaimed-start window.') });
    await vi.advanceTimersByTimeAsync(120_001);
    await pending;
    expect(fake.calls('GET', /\/report$/)).toHaveLength(1);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('explains device_limit without guessing the capacity cause', async () => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'failed', failure_reason: 'device_limit' }));
    await expect(start(fake)).rejects.toMatchObject({ code: 'SESSION_START_FAILED', message: expect.stringContaining('queued work (including iOS) or the concurrency limit') });
  });

  it('still cleans up an admitted start when a readiness read becomes unavailable', async () => {
    vi.useFakeTimers();
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'starting' }))
      .on('GET', /\/report$/, () => json({ detail: 'runtime_unavailable' }, 503));
    const pending = expect(start(fake)).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it('requires terminal state even with confirmed release on close', async () => {
    const fake = fakeMac().on('POST', /\/computer-runs\/([^/]+)\/stop$/, (_request, match) => json({ computer_session_id: match[1], state: 'closing', release: 'confirmed' }));
    await expect((await start(fake)).close()).rejects.toMatchObject({ code: 'API_ERROR' });
  });

  it('does not send unsupported agent steps', async () => {
    const fake = fakeMac();
    const session = await start(fake);
    await expect(session.instruction('hi')).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    await expect(session.validation('ready', { soft: true })).rejects.toMatchObject({ code: 'NOT_AVAILABLE_ON_PLATFORM' });
    expect(fake.requests).toHaveLength(1);
  });

  it.each([
    ['stopped', 'unknown'],
    ['starting', 'pending'],
  ])('reports uncertain physical release rather than claiming the computer closed (%s/%s)', async (state, release) => {
    const fake = fakeMac().on('POST', /\/computer-runs\/([^/]+)\/stop$/, (_request, match) => json({ computer_session_id: match[1], state, release }));
    const lines: string[] = [];
    const session = await start(fake, lines);
    await expect(session.close()).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN', message: expect.stringMatching(/no computer could be assigned.*Computers are not yet available in Revyl production.*computers\.md#availability-and-errors/) });
    expect(lines).not.toContain('mac: closed');
    expect(lines.at(-1)).toContain('close failed');
    expect(lines.at(-1)).toContain('Computers are not yet available in Revyl production');
    await expect(session.close()).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it.each(['mac', 'linux'] as const)('reads and saves the supported %s screenshot endpoint', async (platform) => {
    const bytes = png(800, 600);
    const fake = fakeMac().on('GET', /\/screen\/screenshot$/, () => json({ width: 800, height: 600, png: Buffer.from(bytes).toString('base64') }));
    const session = await start(fake, [], platform);
    const dir = await mkdtemp(join(tmpdir(), 'verify-shot-'));
    const path = join(dir, 'nested', 'screen.png');
    expect(Buffer.from(await session.screenshot({ path }))).toEqual(Buffer.from(bytes));
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  });
});

describe('computer expiry', () => {
  it('exposes a copy of expires_at and refuses expired operations while allowing close', async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'active', expires_at: expiresAt.toISOString() }));
    const session = await start(fake);
    expect(session.expiresAt).toEqual(expiresAt);
    session.expiresAt?.setTime(0);
    expect(session.expiresAt).toEqual(expiresAt);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await expect(session.exec(['true'])).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await expect(session.screenshot()).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await session.close();
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(0);
    expect(fake.calls('POST', /\/stop$/)).toHaveLength(1);
  });

  it.each([undefined, null])('allows an older report with expires_at %s', async (expires_at) => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'active', expires_at }));
    expect((await start(fake)).expiresAt).toBeUndefined();
  });

  it.each(['not-a-date', '2026-10-26T12:00:00', '2026-02-30T12:00:00Z', '2026-10-26T24:00:00Z', 123])('rejects invalid expires_at %s', async (expires_at) => {
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'active', expires_at }));
    await expect(start(fake)).rejects.toMatchObject({ code: 'API_ERROR', message: 'Revyl returned an invalid computer response.' });
  });

  it('bounds pending operation observation by remaining lifetime without replay', async () => {
    vi.useFakeTimers();
    const nativeTimeout = AbortSignal.timeout;
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms === 1000 ? controller.signal : nativeTimeout(ms));
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'active', expires_at: new Date(Date.now() + 1000).toISOString() }))
      .on('POST', /\/operations$/, () => json(null, 202));
    const session = await start(fake);
    const pending = expect(session.exec(['true'])).rejects.toMatchObject({ code: 'ACTION_UNCERTAIN' });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await pending;
    expect(timeout).toHaveBeenCalledWith(1000);
    expect(fake.calls('POST', /\/operations$/)).toHaveLength(1);
    expect(fake.calls('GET', /\/operations\//)).toHaveLength(0);
  });

  it('bounds screenshot observation by remaining lifetime', async () => {
    const nativeTimeout = AbortSignal.timeout;
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => ms <= 1000 ? controller.signal : nativeTimeout(ms));
    const fake = fakeMac().on('POST', /^\/api\/v1\/computer-runs$/, ({ body }) => json({ computer_session_id: body.computer_session_id, state: 'active', expires_at: new Date(Date.now() + 1000).toISOString() }))
      .on('GET', /\/screen\/screenshot$/, () => new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('expired')), { once: true })));
    const session = await start(fake);
    const pending = expect(session.screenshot()).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(fake.calls('GET', /\/screen\/screenshot$/)).toHaveLength(1));
    controller.abort();
    await pending;
  });
});

describe.each(['mac', 'linux'] as const)('%s computer recording', (platform) => {
  function recordingFake(state = 'stopped', release = 'confirmed'): FakeRevyl {
    const fake = fakeMac();
    return fake.on('GET', /\/report$/, () => json({ computer_session_id: fake.requests[0]?.body.computer_session_id, state, release, expires_at: '2000-01-01T00:00:00Z' }));
  }

  it('returns private HTTPS metadata after close, without fetching or logging the signed URL', async () => {
    const url = 'https://recording.test/video.mp4?signature=private';
    const fake = recordingFake().on('GET', /\/recording$/, () => json({ url, duration_seconds: 1.5, started_at: '2026-10-26T12:00:00+01:00' }));
    const lines: string[] = [];
    const session = await start(fake, lines, platform);
    await session.close();
    expect(await session.recording()).toEqual({ url, durationSeconds: 1.5, startedAt: new Date('2026-10-26T11:00:00Z') });
    expect(fake.requests.map((r) => r.path.split('/').at(-1))).toEqual(['computer-runs', 'stop', 'report', 'recording']);
    expect(lines.join('\n')).not.toContain('signature');
  });

  it('omits nullable optional metadata', async () => {
    const fake = recordingFake().on('GET', /\/recording$/, () => json({ url: 'https://recording.test/video', duration_seconds: null, started_at: null }));
    expect(await (await start(fake, [], platform)).recording()).toEqual({ url: 'https://recording.test/video' });
  });

  it('accepts zero duration and an absent start timestamp', async () => {
    const fake = recordingFake().on('GET', /\/recording$/, () => json({ url: 'https://recording.test/video', duration_seconds: 0 }));
    expect(await (await start(fake, [], platform)).recording()).toEqual({ url: 'https://recording.test/video', durationSeconds: 0 });
  });

  it('rejects a nonfinite wire duration without exposing the URL', async () => {
    const fake = recordingFake().on('GET', /\/recording$/, () => new Response('{"url":"https://recording.test/?signature=private","duration_seconds":1e999}'));
    await expect((await start(fake, [], platform)).recording()).rejects.toMatchObject({ code: 'API_ERROR', message: 'Revyl returned an invalid computer response.' });
  });

  it('returns null only for the recording_unavailable error without waiting', async () => {
    const fake = recordingFake().on('GET', /\/recording$/, () => json({ error: 'recording_unavailable' }, 404));
    expect(await (await start(fake, [], platform)).recording()).toBeNull();
    expect(fake.calls('GET', /\/recording$/)).toHaveLength(1);
  });

  it.each([['active', 'confirmed'], ['stopped', 'pending'], ['failed', 'unknown']])('refuses pre-release recording %s/%s without fetching it', async (state, release) => {
    const fake = recordingFake(state, release);
    await expect((await start(fake, [], platform)).recording()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(fake.calls('GET', /\/recording$/)).toHaveLength(0);
  });

  it.each([
    { url: 'http://recording.test/?signature=private' },
    { url: 'invalid?signature=private' },
    { url: 'https:recording.test/video?signature=private' },
    { url: 'https://recording.test/\n?signature=private' },
    { url: 'https://user:password@recording.test/?signature=private' },
    { url: 'https://recording.test/?signature=private', duration_seconds: -1 },
    { url: 'https://recording.test/?signature=private', duration_seconds: '2' },
    { url: 'https://recording.test/?signature=private', started_at: '2026-10-26T12:00:00' },
    { url: 'https://recording.test/?signature=private', started_at: 'bad' },
    { url: 'https://recording.test/?signature=private', started_at: '2026-02-30T12:00:00Z' },
    null,
  ])('rejects malformed recording metadata privately: %j', async (metadata) => {
    const fake = recordingFake().on('GET', /\/recording$/, () => json(metadata));
    await expect((await start(fake, [], platform)).recording()).rejects.toMatchObject({ code: 'API_ERROR', message: 'Revyl returned an invalid computer response.' });
  });

  it('does not treat an unrelated recording 404 as absence', async () => {
    const fake = recordingFake().on('GET', /\/recording$/, () => json({ error: 'inaccessible' }, 404));
    await expect((await start(fake, [], platform)).recording()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

const startComputer = start;
describe.each(['mac', 'linux'] as const)('%s computer operations', (platform) => {
  const start = (fake: FakeRevyl, lines: string[] = []) => startComputer(fake, lines, platform);
  it('matches Python UUIDv5 for the operation identity', () => {
    expect(computerOperationId(contract.uuidV5!.session_id, contract.uuidV5!.request_id)).toBe(contract.uuidV5!.operation_id);
  });

  it('executes argv without a shell, sends stdin as base64 and decodes output', async () => {
    const fake = result(fakeMac(), contract.exec);
    const session = await start(fake);
    expect(await session.exec(['printf', '%s', 'a b'], { stdin: 'input', timeout: 300_000 })).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' });
    const request = fake.calls('POST', /\/operations$/)[0]!;
    expect(request.body.command).toEqual({ kind: 'exec', argv: ['printf', '%s', 'a b'], stdin: 'aW5wdXQ=', timeout_ms: 300_000 });
    expect(request.headers.get('prefer')).toBe('respond-async');
  });

  it('throws on nonzero exit unless check is false', async () => {
    const fake = result(fakeMac(), contract.nonzero);
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
    [503, 'runtime_unavailable', 'NOT_AVAILABLE_ON_PLATFORM'],
    [429, 'computer_limit', 'COMPUTER_LIMIT'],
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
