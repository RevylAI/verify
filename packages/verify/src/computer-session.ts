import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RevylClient, responseDetail, sessionViewerUrl, type RawResponse } from './api/client.js';
import type { ComputerCommand, ComputerCommandResponse, ComputerReport, ComputerResult, ComputerScreenshot } from './api/types.js';
import { trackSession, untrackSession } from './cleanup.js';
import type { ResolvedComputerTarget } from './config.js';
import { VerifyError, isVerifyError, type VerifyErrorCode } from './errors.js';
import { pngSize, type ComputerProcess, type ExecOptions, type ExecResult, type FileStat, type OperationOptions, type Session, type SessionOptions, type StepResult } from './session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['starting', 'active', 'closing', 'stopped', 'failed', 'owner_lost']);
const MAX_OUTPUT_BYTES = 1_048_576;
const ERROR_CODES = new Set(['computer_not_enabled', 'run_closed', 'inaccessible', 'invalid_handle', 'operation_not_found', 'owner_unavailable', 'invalid_request', 'unauthenticated', 'forbidden', 'runtime_unavailable', 'start_failed', 'computer_limit', 'request_conflict', 'run_conflict', 'evidence_conflict', 'evidence_unavailable', 'authentication_unavailable', 'operation_limit', 'screen_starting', 'screen_unavailable']);

export class ComputerSession implements Session {
  readonly platform = 'mac' as const;
  readonly target: string;
  readonly id = randomUUID();
  readonly viewerUrl: string;
  readonly steps: StepResult[] = [];
  private readonly lifetime = new AbortController();
  private closePromise: Promise<void> | undefined;

  private constructor(private readonly client: RevylClient, target: ResolvedComputerTarget, private readonly options: SessionOptions) {
    this.target = target.name;
    this.viewerUrl = sessionViewerUrl(this.id, 'computer');
  }

  static async start(client: RevylClient, target: ResolvedComputerTarget, options: SessionOptions): Promise<ComputerSession> {
    if (target.platform !== 'mac') throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', 'Linux computers are planned, but are not available in Verify yet.');
    const session = new ComputerSession(client, target, options);
    const signal = AbortSignal.any([AbortSignal.timeout(target.startTimeout), session.lifetime.signal]);
    trackSession(session);
    try {
      session.log(`starting mac computer ${session.viewerUrl}`);
      let report = session.report(await session.request('POST', '', { computer_session_id: session.id, os: 'macos' }, signal));
      for (;;) {
        if (report.state === 'active') break;
        if (report.state !== 'starting') throw new VerifyError('SESSION_START_FAILED', `The ${session.target} computer ended before it was ready (${report.state}). See ${session.viewerUrl}`);
        await delay(2_000, undefined, { signal });
        report = session.report(await session.request('GET', '/report', undefined, signal));
      }
      session.log('ready');
      return session;
    } catch (error) {
      const timedOut = signal.aborted;
      if (isVerifyError(error) && ['AUTH_REJECTED', 'NOT_AVAILABLE_ON_PLATFORM', 'INVALID_ARGUMENT'].includes(error.code)) {
        session.lifetime.abort();
        untrackSession(session);
      } else {
        await session.close().catch(() => undefined);
      }
      if (timedOut) throw new VerifyError('TIMEOUT', `The ${session.target} computer was not ready within ${target.startTimeout} ms. See ${session.viewerUrl}`);
      throw error;
    }
  }

  get closed(): boolean {
    return this.closePromise !== undefined;
  }

  instruction(): Promise<never> {
    return this.unavailable('instruction');
  }

  validation(): Promise<never> {
    return this.unavailable('validation');
  }

  async screenshot(options: { path?: string } = {}): Promise<Uint8Array> {
    this.assertOpen();
    const response = await this.request('GET', '/screen/screenshot', undefined, this.lifetime.signal);
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
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(310_000)]);
    try {
      let response = await this.request('POST', '/operations', { computer_session_id: this.id, request_id: requestId, command }, signal);
      for (;;) {
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
    const detail = responseDetail(response);
    let code: VerifyErrorCode = 'API_ERROR';
    if (detail === 'computer_not_enabled') code = 'NOT_AVAILABLE_ON_PLATFORM';
    else if (detail === 'run_closed') code = 'SESSION_ENDED';
    else if (detail === 'inaccessible' || detail === 'invalid_handle') code = 'NOT_FOUND';
    else if (detail === 'operation_not_found' || detail === 'owner_unavailable') code = 'ACTION_UNCERTAIN';
    else if (detail === 'invalid_request' || response.status === 422) code = 'INVALID_ARGUMENT';
    else if (response.status === 401 || response.status === 403) code = 'AUTH_REJECTED';
    else if (detail === 'runtime_unavailable' || detail === 'start_failed' || detail === 'computer_limit') code = 'SESSION_START_FAILED';
    else if (response.status === 409 || detail === 'operation_limit') code = 'SESSION_BUSY';
    else if (suffix.startsWith('/operations/') && response.status >= 500) code = 'ACTION_UNCERTAIN';
    else if (method === 'POST' && (response.status >= 500 || response.status < 400)) code = 'ACTION_UNCERTAIN';
    const reason = detail && ERROR_CODES.has(detail) ? detail : `HTTP ${response.status}`;
    throw new VerifyError(code, `Revyl refused the computer request (${reason}).${detail === 'computer_not_enabled' ? ' Computers are alpha; ask support@revyl.ai to enable your organization.' : ''} See ${this.viewerUrl}`);
  }

  private report(response: RawResponse): ComputerReport {
    const report = parseComputerJson<ComputerReport>(response);
    if (!report || report.computer_session_id !== this.id || !STATES.has(report.state)) throw invalidResponse();
    return report;
  }

  private assertOpen(): void {
    if (this.closed) throw new VerifyError('SESSION_ENDED', `The ${this.target} computer was closed.`);
  }

  private unavailable(method: string): Promise<never> {
    return Promise.reject(new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${method}() is not available on mac computers; use exec() and file operations. See ${this.viewerUrl}`));
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

function parseComputerJson<T>(response: RawResponse): T {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  } catch {
    throw invalidResponse();
  }
}
