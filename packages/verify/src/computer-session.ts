import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RevylClient, responseDetail, responseErrorCode, sessionViewerUrl, type RawResponse } from './api/client.js';
import type { ComputerCommand, ComputerCommandResponse, ComputerPlatform, ComputerRecordingResponse, ComputerReport, ComputerResult, ComputerScreenshot } from './api/types.js';
import { trackSession, untrackSession } from './cleanup.js';
import type { ResolvedComputerTarget } from './config.js';
import { VerifyError, isVerifyError, type VerifyErrorCode } from './errors.js';
import { pngSize, type ComputerProcess, type ComputerRecording, type ExecOptions, type ExecResult, type FileStat, type OperationOptions, type Session, type SessionOptions, type StepResult } from './session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['starting', 'active', 'closing', 'stopped', 'failed', 'owner_lost']);
const MAX_OUTPUT_BYTES = 1_048_576;
const COMPUTER_AVAILABILITY = 'Computers are not yet available in Revyl production. Early access works only on Revyl staging for enabled organizations and operating systems. See https://github.com/RevylAI/verify/blob/main/packages/verify/docs/computers.md#availability-and-errors';
const COMPUTER_CAPACITY = 'Computer admission was refused because of queued work (including iOS) or the concurrency limit. Verify will not retry the start.';
const ERROR_CODES = new Set(['computer_not_enabled', 'run_closed', 'inaccessible', 'invalid_handle', 'operation_not_found', 'owner_unavailable', 'invalid_request', 'unauthenticated', 'forbidden', 'runtime_unavailable', 'start_failed', 'computer_limit', 'request_conflict', 'run_conflict', 'evidence_conflict', 'evidence_unavailable', 'authentication_unavailable', 'operation_limit', 'screen_starting', 'screen_unavailable']);

export class ComputerSession implements Session {
  readonly platform: ComputerPlatform;
  readonly target: string;
  readonly id = randomUUID();
  readonly viewerUrl: string;
  readonly steps: StepResult[] = [];
  private readonly lifetime = new AbortController();
  private closePromise: Promise<void> | undefined;
  private expiresAtMs: number | undefined;

  private constructor(private readonly client: RevylClient, target: ResolvedComputerTarget, private readonly options: SessionOptions) {
    this.target = target.name;
    this.platform = target.platform;
    this.viewerUrl = sessionViewerUrl(this.id, 'computer');
  }

  static async start(client: RevylClient, target: ResolvedComputerTarget, options: SessionOptions): Promise<ComputerSession> {
    const session = new ComputerSession(client, target, options);
    const signal = AbortSignal.any([AbortSignal.timeout(target.startTimeout), session.lifetime.signal]);
    let createAcknowledged = false;
    trackSession(session);
    try {
      session.log(`starting computer ${session.viewerUrl}. ${COMPUTER_AVAILABILITY}`);
      const response = await session.request('POST', '', { computer_session_id: session.id, os: target.platform === 'mac' ? 'macos' : 'linux' }, signal);
      createAcknowledged = true;
      let report = session.report(response);
      for (;;) {
        if (report.state === 'active') break;
        if (report.state !== 'starting') {
          const reason = report.failure_reason === 'no_host' ? ' No host claimed the start within the 120-second unclaimed-start window.' : report.failure_reason === 'device_limit' ? ` ${COMPUTER_CAPACITY}` : '';
          throw new VerifyError('SESSION_START_FAILED', `The ${session.target} computer ended before it was ready (${report.state}).${reason} See ${session.viewerUrl}`);
        }
        await delay(2_000, undefined, { signal });
        report = session.report(await session.request('GET', '/report', undefined, signal));
      }
      session.log('ready');
      return session;
    } catch (error) {
      const timedOut = signal.aborted;
      if (!createAcknowledged && isVerifyError(error) && ['AUTH_REJECTED', 'NOT_AVAILABLE_ON_PLATFORM', 'INVALID_ARGUMENT', 'COMPUTER_LIMIT'].includes(error.code)) {
        session.lifetime.abort();
        untrackSession(session);
      } else {
        await session.close().catch(() => undefined);
      }
      if (timedOut) throw new VerifyError('TIMEOUT', `The ${session.target} computer was not ready within ${target.startTimeout} ms. A possible cause is that no computer could be assigned. ${COMPUTER_AVAILABILITY}. Inspect ${session.viewerUrl}`);
      throw error;
    }
  }

  get closed(): boolean {
    return this.closePromise !== undefined;
  }

  get expiresAt(): Date | undefined {
    return this.expiresAtMs === undefined ? undefined : new Date(this.expiresAtMs);
  }

  async recording(): Promise<ComputerRecording | null> {
    const signal = AbortSignal.timeout(30_000);
    const report = this.report(await this.request('GET', '/report', undefined, signal));
    if (!['stopped', 'failed', 'owner_lost'].includes(report.state) || report.release !== 'confirmed') {
      throw new VerifyError('SESSION_BUSY', `The computer recording can be requested only after terminal state and confirmed release. See ${this.viewerUrl}`);
    }
    const response = await this.request('GET', '/recording', undefined, signal);
    if (response.status === 404 && responseErrorCode(response) === 'recording_unavailable') return null;
    const raw = parseComputerJson<ComputerRecordingResponse>(response);
    if (!raw || typeof raw.url !== 'string' || !/^https:\/\//i.test(raw.url) || /[\x00-\x20\x7f]/.test(raw.url)) throw invalidResponse();
    let url: URL;
    try {
      url = new URL(raw.url);
    } catch {
      throw invalidResponse();
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (raw.duration_seconds != null && (typeof raw.duration_seconds !== 'number' || !Number.isFinite(raw.duration_seconds) || raw.duration_seconds < 0))) throw invalidResponse();
    const startedAt = raw.started_at == null ? undefined : parseTimestamp(raw.started_at);
    return { url: raw.url, ...(raw.duration_seconds != null ? { durationSeconds: raw.duration_seconds } : {}), ...(startedAt ? { startedAt } : {}) };
  }

  instruction(): Promise<never> {
    return this.unavailable('instruction');
  }

  validation(): Promise<never> {
    return this.unavailable('validation');
  }

  async screenshot(options: { path?: string } = {}): Promise<Uint8Array> {
    this.assertOpen();
    const signal = this.observationSignal(30_000);
    const response = await this.request('GET', '/screen/screenshot', undefined, signal);
    this.assertOpen();
    const raw = parseComputerJson<ComputerScreenshot>(response);
    const bytes = decodeBytes(raw?.png, 128 * MAX_OUTPUT_BYTES);
    const size = pngSize(bytes);
    if (!size || size.width > 4095 || size.height > 4095 || size.width !== raw.width || size.height !== raw.height) throw invalidResponse();
    if (options.path) {
      const path = resolve(options.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    return bytes;
  }

  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const stdin = options.stdin === undefined ? Buffer.alloc(0) : inputBytes(options.stdin);
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64 || !argv[0] || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || argv.reduce((sum, arg) => sum + Buffer.byteLength(arg), 0) + stdin.length > 16_384) {
      throw new VerifyError('INVALID_ARGUMENT', 'exec() takes 1-64 string arguments without NUL bytes; argv and stdin together must fit in 16384 bytes.');
    }
    const result = await this.operation({ kind: 'exec', argv, stdin: stdin.toString('base64'), timeout_ms: operationTimeout(options) }, options.check === false);
    if (result.kind !== 'exec' || !Number.isInteger(result.exit_code) || result.exit_code < -255 || result.exit_code > 255) throw invalidResponse();
    const stdout = decodeBytes(result.stdout ?? '', MAX_OUTPUT_BYTES);
    const stderr = decodeBytes(result.stderr ?? '', MAX_OUTPUT_BYTES);
    if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) throw invalidResponse();
    return { exitCode: result.exit_code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  }

  async readFile(path: string, options: OperationOptions = {}): Promise<Buffer> {
    const result = await this.operation({ kind: 'file_read', path: guestPath(path), timeout_ms: operationTimeout(options) });
    if (result.kind !== 'file_read') throw invalidResponse();
    return decodeBytes(result.data, MAX_OUTPUT_BYTES);
  }

  async writeFile(path: string, data: string | Uint8Array, options: OperationOptions = {}): Promise<void> {
    const bytes = inputBytes(data);
    if (bytes.length > 65_536) throw new VerifyError('INVALID_ARGUMENT', 'writeFile() takes at most 65536 bytes.');
    const result = await this.operation({ kind: 'file_write', path: guestPath(path), data: bytes.toString('base64'), timeout_ms: operationTimeout(options) });
    if (result.kind !== 'file_write' || result.byte_count !== bytes.length) throw invalidResponse();
  }

  async stat(path: string, options: OperationOptions = {}): Promise<FileStat> {
    const result = await this.operation({ kind: 'file_stat', path: guestPath(path), timeout_ms: operationTimeout(options) });
    if (result.kind !== 'file_stat' || !['file', 'directory'].includes(result.file_kind) || !Number.isSafeInteger(result.size_bytes) || result.size_bytes < 0) throw invalidResponse();
    return { kind: result.file_kind, size: result.size_bytes };
  }

  async processes(options: OperationOptions = {}): Promise<ComputerProcess[]> {
    const result = await this.operation({ kind: 'process_list', timeout_ms: operationTimeout(options) });
    if (result.kind !== 'process_list' || !Array.isArray(result.processes) || result.processes.length > 64) throw invalidResponse();
    const ids = new Set<string>();
    return result.processes.map((process) => {
      if (!process || process.handle?.computer_session_id !== this.id || !UUID.test(process.handle.handle_id) || !['running', 'exited'].includes(process.state) || (process.exit_code != null && (!Number.isInteger(process.exit_code) || process.exit_code < -255 || process.exit_code > 255)) || (process.state === 'running' && process.exit_code != null) || ids.has(process.handle.handle_id)) throw invalidResponse();
      ids.add(process.handle.handle_id);
      return { id: process.handle.handle_id, state: process.state, ...(process.exit_code != null ? { exitCode: process.exit_code } : {}) };
    });
  }

  async terminate(processId: string, options: OperationOptions = {}): Promise<void> {
    if (typeof processId !== 'string' || !UUID.test(processId)) throw new VerifyError('INVALID_ARGUMENT', 'terminate() takes a process handle id from processes(), not an OS PID.');
    const result = await this.operation({ kind: 'process_terminate', handle: { computer_session_id: this.id, handle_id: processId }, timeout_ms: operationTimeout(options) });
    if (result.kind !== 'process_terminate' || result.termination !== 'confirmed') throw invalidResponse();
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.lifetime.abort();
      try {
        const report = this.report(await this.request('POST', '/stop', undefined, AbortSignal.timeout(310_000)));
        if (report.release !== 'confirmed') {
          throw new VerifyError('ACTION_UNCERTAIN', `Computer stop was requested, but physical release is unconfirmed. Inspect ${this.viewerUrl}`);
        }
        if (!['stopped', 'failed', 'owner_lost'].includes(report.state)) throw invalidResponse();
        this.log('closed');
      } catch (error) {
        if (isVerifyError(error) && error.code === 'ACTION_UNCERTAIN') {
          const message = `${error.message} A possible cause is that no computer could be assigned. ${COMPUTER_AVAILABILITY}`;
          this.log(`close failed (ACTION_UNCERTAIN); ${message}`);
          throw new VerifyError('ACTION_UNCERTAIN', message, { cause: error });
        }
        this.log(`close failed (${isVerifyError(error) ? error.code : 'API_ERROR'}); inspect ${this.viewerUrl}`);
        throw error;
      } finally {
        untrackSession(this);
      }
    })();
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async operation(command: ComputerCommand, allowNonzero = false): Promise<ComputerResult> {
    this.assertOpen();
    const requestId = randomUUID();
    const operationId = computerOperationId(this.id, requestId);
    const signal = this.observationSignal(310_000);
    try {
      let response = await this.request('POST', '/operations', { computer_session_id: this.id, request_id: requestId, command }, signal);
      for (;;) {
        if (signal.aborted) throw signal.reason;
        if (response.status !== 202) {
          const body = parseComputerJson<ComputerCommandResponse>(response);
          if (body?.computer_session_id !== this.id || body.operation_id !== operationId || !['recorded', 'pending', 'failed'].includes(body.evidence) || !body.execution) throw invalidResponse();
          const execution = body.execution;
          if (execution.outcome === 'succeeded' || (execution.outcome === 'failed' && execution.error_code === 'exec_nonzero' && allowNonzero)) {
            const result = execution.result;
            if (!result || result.kind !== command.kind || (execution.outcome === 'succeeded' && result.kind === 'exec' && result.exit_code !== 0) || (execution.outcome === 'failed' && result.kind === 'exec' && result.exit_code === 0)) throw invalidResponse();
            if (body.evidence !== 'recorded') this.log(`operation ${operationId}: execution observed, report evidence ${body.evidence}`);
            return result;
          }
          if (execution.outcome === 'failed') {
            if (execution.error_code === 'exec_nonzero' && (execution.result?.kind !== 'exec' || !Number.isInteger(execution.result.exit_code) || execution.result.exit_code === 0 || command.kind !== 'exec')) throw invalidResponse();
            const code = { exec_nonzero: 'COMMAND_FAILED', not_found: 'NOT_FOUND', access_denied: 'ACCESS_DENIED' }[execution.error_code] as VerifyErrorCode | undefined;
            if (!code) throw invalidResponse();
            throw new VerifyError(code, `Computer ${command.kind} failed (${execution.error_code}${execution.result ? `, exit code ${execution.result.exit_code}` : ''}). See ${this.viewerUrl}`);
          }
          if (execution.outcome === 'timed_out') {
            if (execution.termination === 'unknown') throw new VerifyError('ACTION_UNCERTAIN', `Computer ${command.kind} timed out; termination is unconfirmed. Verify will not repeat it. See ${this.viewerUrl}`);
            if (execution.termination !== 'confirmed') throw invalidResponse();
            throw new VerifyError('TIMEOUT', `Computer ${command.kind} timed out; termination was confirmed. See ${this.viewerUrl}`);
          }
          if (execution.outcome !== 'unknown') throw invalidResponse();
          throw new VerifyError('ACTION_UNCERTAIN', `Computer ${command.kind} outcome is unconfirmed. Verify will not repeat it. Inspect operation ${operationId} at ${this.viewerUrl}`);
        }
        if (parseComputerJson<unknown>(response) !== null) throw invalidResponse();
        await delay(2_000, undefined, { signal });
        response = await this.request('GET', `/operations/${operationId}`, undefined, signal);
      }
    } catch (error) {
      if (signal.aborted) throw new VerifyError('ACTION_UNCERTAIN', `Computer operation ${operationId} stopped being observed; its outcome is unconfirmed. See ${this.viewerUrl}`);
      throw error;
    }
  }

  private async request(method: 'GET' | 'POST', suffix: string, body: unknown, signal: AbortSignal): Promise<RawResponse> {
    const path = `/api/v1/computer-runs${suffix === '' ? '' : `/${this.id}${suffix}`}`;
    let response: RawResponse;
    try {
      response = await this.client.send(method, path, { body, signal, timeoutMs: suffix === '/stop' || suffix.startsWith('/operations') ? 310_000 : 30_000, retry: method === 'GET', headers: suffix === '/operations' ? { Prefer: 'respond-async' } : undefined });
    } catch (error) {
      if (method === 'POST' || suffix.startsWith('/operations/')) throw new VerifyError('ACTION_UNCERTAIN', `Computer request outcome is unconfirmed. Verify will not repeat it. See ${this.viewerUrl}`);
      if (isVerifyError(error)) throw new VerifyError(error.code, `Could not read the computer state. See ${this.viewerUrl}`);
      throw error;
    }
    if (response.status >= 200 && response.status < 300) return response;
    if (suffix === '/recording' && response.status === 404 && responseErrorCode(response) === 'recording_unavailable') return response;
    const detail = responseDetail(response);
    if (detail === 'computer_not_enabled' || (response.status === 503 && detail === 'runtime_unavailable')) {
      throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `Revyl refused the computer request (${detail}). ${COMPUTER_AVAILABILITY}. Ask support@revyl.ai about staging organization enablement. See ${this.viewerUrl}`);
    }
    if (response.status === 429 && detail === 'computer_limit') throw new VerifyError('COMPUTER_LIMIT', `${COMPUTER_CAPACITY} See ${this.viewerUrl}`);
    let code: VerifyErrorCode = 'API_ERROR';
    if (detail === 'run_closed') code = 'SESSION_ENDED';
    else if (detail === 'inaccessible' || detail === 'invalid_handle') code = 'NOT_FOUND';
    else if (detail === 'operation_not_found' || detail === 'owner_unavailable') code = 'ACTION_UNCERTAIN';
    else if (detail === 'invalid_request' || response.status === 422) code = 'INVALID_ARGUMENT';
    else if (response.status === 401 || response.status === 403) code = 'AUTH_REJECTED';
    else if (detail === 'start_failed') code = 'SESSION_START_FAILED';
    else if (response.status === 409 || detail === 'operation_limit') code = 'SESSION_BUSY';
    else if (suffix.startsWith('/operations/') && response.status >= 500) code = 'ACTION_UNCERTAIN';
    else if (method === 'POST' && (response.status >= 500 || response.status < 400)) code = 'ACTION_UNCERTAIN';
    const reason = detail && ERROR_CODES.has(detail) ? detail : `HTTP ${response.status}`;
    throw new VerifyError(code, `Revyl refused the computer request (${reason}). See ${this.viewerUrl}`);
  }

  private report(response: RawResponse): ComputerReport {
    const report = parseComputerJson<ComputerReport>(response);
    if (!report || report.computer_session_id !== this.id || !STATES.has(report.state)) throw invalidResponse();
    if (report.expires_at != null) this.expiresAtMs = parseTimestamp(report.expires_at).getTime();
    return report;
  }

  private assertOpen(): void {
    if (this.closed || (this.expiresAtMs !== undefined && Date.now() >= this.expiresAtMs)) throw new VerifyError('SESSION_ENDED', `The ${this.target} computer was closed or expired.`);
  }

  private observationSignal(timeoutMs: number): AbortSignal {
    const remainingMs = this.expiresAtMs === undefined ? timeoutMs : Math.min(timeoutMs, this.expiresAtMs - Date.now());
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(Math.max(0, remainingMs))]);
  }

  private unavailable(method: string): Promise<never> {
    return Promise.reject(new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${method}() is not available on computers; use exec() and file operations. See ${this.viewerUrl}`));
  }

  private log(line: string): void {
    this.options.log?.(`${this.target}: ${line}`);
  }
}

export function computerOperationId(sessionId: string, requestId: string): string {
  const hash = createHash('sha1').update(Buffer.from(sessionId.replaceAll('-', ''), 'hex')).update(requestId).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operationTimeout(options: OperationOptions): number {
  const timeout = options.timeout ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) throw new VerifyError('INVALID_ARGUMENT', 'Computer operation timeout must be an integer from 1 to 300000 ms.');
  return timeout;
}

function guestPath(path: string): string {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 1024 || path.split('/').some((part) => ['', '.', '..'].includes(part)) || /[\x00-\x1f\x7f\\:]/.test(path)) throw new VerifyError('INVALID_ARGUMENT', 'Computer paths must be workspace-relative, without empty, dot, parent, backslash, colon, or control-character components.');
  return path;
}

function inputBytes(value: string | Uint8Array): Buffer {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new VerifyError('INVALID_ARGUMENT', 'Computer input must be a string or Uint8Array.');
  return Buffer.from(value);
}

function decodeBytes(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || !/^[a-zA-Z0-9+/_-]*={0,2}$/.test(value)) throw invalidResponse();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value.replaceAll('-', '+').replaceAll('_', '/')) throw invalidResponse();
  return bytes;
}

function invalidResponse(): VerifyError {
  return new VerifyError('API_ERROR', 'Revyl returned an invalid computer response.');
}

function parseTimestamp(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalidResponse();
  const calendarTime = new Date(`${value.slice(0, 19)}Z`);
  if (!Number.isFinite(calendarTime.getTime()) || calendarTime.toISOString().slice(0, 19) !== value.slice(0, 19)) throw invalidResponse();
  return new Date(value);
}

function parseComputerJson<T>(response: RawResponse): T {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  } catch {
    throw invalidResponse();
  }
}
