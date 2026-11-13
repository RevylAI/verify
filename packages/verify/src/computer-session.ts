import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RevylClient, edgeBlockedError, responseDetail, responseErrorCode, responseRefusalReason, sessionViewerUrl, type RawResponse } from './api/client.js';
import type { ComputerCommand, ComputerCommandResponse, ComputerPlatform, ComputerRecordingResponse, ComputerReport, ComputerResult, ComputerScreenshot } from './api/types.js';
import { trackSession, untrackSession } from './cleanup.js';
import { validateHostedTarget, type HostedTargetConfig, type ResolvedComputerTarget } from './config.js';
import { VerifyError, isVerifyError, type VerifyErrorCode } from './errors.js';
import { WEB_KEYS, checkKey, type Key, type KeyModifier, type Location, type Point } from './agent/loop.js';
import { DeviceSession, checkLocation, pngSize, type ComputerProcess, type ComputerRecording, type ExecOptions, type ExecResult, type FileStat, type OpenedSession, type OperationOptions, type Session, type SessionOptions, type StepResult } from './session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['starting', 'active', 'closing', 'stopped', 'failed', 'owner_lost']);
const MAX_OUTPUT_BYTES = 1_048_576;
const COMPUTER_AVAILABILITY = 'Mac computers need a current paid Revyl plan, and Linux computers are not generally available. Ask support@revyl.ai about access.';
const COMPUTER_CAPACITY = 'Computer admission was refused because of queued work (including iOS) or the concurrency limit. Verify will not retry the start.';
const ERROR_CODES = new Set(['computer_not_enabled', 'run_closed', 'inaccessible', 'invalid_handle', 'operation_not_found', 'owner_unavailable', 'invalid_request', 'unauthenticated', 'forbidden', 'runtime_unavailable', 'start_failed', 'computer_limit', 'request_conflict', 'run_conflict', 'evidence_conflict', 'evidence_unavailable', 'authentication_unavailable', 'operation_limit', 'screen_starting', 'screen_unavailable', 'screen_control_held', 'screen_control_lost', 'screen_input_unavailable', 'screen_input_uncertain', 'screen_key_unsupported', 'screen_text_unsupported', 'screen_target_not_found', 'screen_target_unavailable']);
const COMPUTER_KEYS: Record<Key, string> = { enter: 'Return', backspace: 'BackSpace', tab: 'Tab', escape: 'Escape', delete: 'Delete', space: 'space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down' };
const REFUSAL_NEXT_STEPS = {
  AUTH_REJECTED: "Check that REVYL_API_KEY is a current key and that its owner has the Member role or above in this computer's organization.",
  SESSION_ENDED: 'This computer has stopped; start a new computer to continue.',
  NOT_FOUND: 'Check that the id is right and that REVYL_API_KEY belongs to the organization that started this computer.',
  ACTION_UNCERTAIN: "The request may have taken effect. Verify will not repeat it; check the computer's state before you do.",
  INVALID_ARGUMENT: "Check the call's arguments against the docs; if they match, update Verify to the latest version.",
  SESSION_START_FAILED: 'Start a new computer.',
  SESSION_BUSY: 'The computer is busy with other work; try again once it finishes.',
  API_ERROR: 'Try again; if it keeps failing, send this message to support@revyl.ai.',
} satisfies Partial<Record<VerifyErrorCode, string>>;
const SCREEN_CALLS = 'For the screen, use screenshot(), tap({ x, y }) or tap({ target }), typeFocused(text, { clear: false }) and pressKey(); for commands, use exec().';

export class ComputerSession implements Session {
  readonly platform: ComputerPlatform;
  readonly target: string;
  readonly id: string;
  readonly viewerUrl: string;
  readonly steps: StepResult[] = [];
  private readonly lifetime = new AbortController();
  private closePromise: Promise<void> | undefined;
  private expiresAtMs: number | undefined;
  private screenReadyUntilMs = 0;
  private readonly children = new Set<Session>();
  private readonly childStarts = new Set<Promise<Session>>();
  private closing = false;

  private constructor(private readonly client: RevylClient, target: ResolvedComputerTarget, private readonly options: SessionOptions, id: string = randomUUID(), private readonly stopOnClose = true) {
    this.id = id;
    this.target = target.name;
    this.platform = target.platform;
    this.viewerUrl = sessionViewerUrl(this.id, 'computer', options.appUrl);
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
      let report = session.parseReport(response);
      for (;;) {
        if (report.state === 'active') break;
        if (report.state !== 'starting') {
          const reason = report.failure_reason === 'no_host' ? ' No host claimed the start within the 120-second unclaimed-start window.' : report.failure_reason === 'device_limit' ? ` ${COMPUTER_CAPACITY}` : '';
          throw new VerifyError('SESSION_START_FAILED', `The ${session.target} computer ended before it was ready (${report.state}).${reason} See ${session.viewerUrl}`);
        }
        await delay(2_000, undefined, { signal });
        report = session.parseReport(await session.request('GET', '/report', undefined, signal));
      }
      session.screenReadyUntilMs = Date.now() + 30_000;
      session.log('ready');
      return session;
    } catch (error) {
      const timedOut = signal.aborted;
      if (!createAcknowledged && isVerifyError(error) && ['AUTH_REJECTED', 'EDGE_BLOCKED', 'NOT_AVAILABLE_ON_PLATFORM', 'INVALID_ARGUMENT', 'COMPUTER_LIMIT'].includes(error.code)) {
        session.lifetime.abort();
        untrackSession(session);
      } else {
        await session.close().catch(() => undefined);
      }
      if (timedOut) throw new VerifyError('TIMEOUT', `The ${session.target} computer was not ready within ${target.startTimeout} ms. A possible cause is that no computer could be assigned. ${COMPUTER_AVAILABILITY} Inspect ${session.viewerUrl}`);
      throw error;
    }
  }

  get closed(): boolean {
    return this.closePromise !== undefined;
  }

  static async attach(client: RevylClient, computerId: string, options: SessionOptions & { stopOnClose?: boolean }): Promise<ComputerSession> {
    if (typeof computerId !== 'string' || !UUID.test(computerId)) throw new VerifyError('INVALID_ARGUMENT', 'attach() requires a computer session UUID.');
    const probe = new ComputerSession(client, { name: 'computer', platform: 'mac', startTimeout: 600_000 }, options, computerId);
    const response = await probe.request('GET', '/report', undefined, AbortSignal.timeout(30_000));
    const raw = parseComputerJson<ComputerReport & { os?: string }>(response);
    if (!raw || raw.computer_session_id !== computerId || !['macos', 'linux'].includes(raw.os ?? '') || raw.expires_at == null) throw invalidResponse();
    const session = new ComputerSession(client, { name: raw.os === 'macos' ? 'mac' : 'linux', platform: raw.os === 'macos' ? 'mac' : 'linux', startTimeout: 600_000 }, options, computerId, options.stopOnClose ?? true);
    session.parseReport(response);
    if (raw.state !== 'active' || (session.expiresAtMs !== undefined && Date.now() >= session.expiresAtMs)) throw new VerifyError('SESSION_ENDED', 'The computer is not active or has expired.');
    if (session.stopOnClose) trackSession(session);
    return session;
  }

  async open(target: HostedTargetConfig): Promise<OpenedSession> {
    this.assertOpen();
    if (this.expiresAtMs === undefined) throw new VerifyError('API_ERROR', 'The computer report must include expiry before opening a hosted child.');
    const resolved = validateHostedTarget(target);
    if ((this.platform === 'mac' && resolved.platform === 'android') || (this.platform === 'linux' && resolved.platform === 'ios')) throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', 'This computer cannot host the requested platform.', { reason: 'computer_cannot_host_platform' });
    const pending = DeviceSession.start(this.client, resolved, this.options, {
      id: this.id,
      signal: this.lifetime.signal,
      expiresAt: this.expiresAt,
      register: (session) => { this.children.add(session); },
    });
    this.childStarts.add(pending);
    try {
      return await pending;
    } finally {
      this.childStarts.delete(pending);
    }
  }

  async report(): Promise<Record<string, unknown>> {
    const report = this.parseReport(await this.request('GET', '/report', undefined, AbortSignal.timeout(30_000)));
    return { ...report };
  }

  navigate(): Promise<never> {
    return this.unavailable('navigate');
  }

  /** Clicks a point in screenshot pixels, or an element Revyl finds from a description, with the left button. Returns the point clicked. */
  async tap(at: Location): Promise<Point> {
    if (at && typeof at === 'object' && 'target' in at && ('x' in at || 'y' in at)) throw new VerifyError('INVALID_ARGUMENT', 'tap() takes a point { x, y } or a description { target }, not both.');
    const location = checkLocation(at);
    if ('target' in location) return this.tapTarget(location.target);
    const { x, y } = location;
    let response: RawResponse;
    try {
      response = await this.act({ action: 'click', x, y });
    } catch (error) {
      if (isVerifyError(error) && error.code === 'INVALID_ARGUMENT' && error.httpStatus === 422) throw new VerifyError('INVALID_ARGUMENT', `Nothing was clicked: the computer refused a click at (${x}, ${y}). That happens when the point is no longer on its screen, for example after its display size changed. Take a new screenshot() and pick the point from it. See ${this.viewerUrl}`, { cause: error, reason: error.reason, httpStatus: 422 });
      throw error;
    }
    if (response.status === 422) {
      const size = await this.screenSize().catch(() => undefined);
      const range = size ? `x is 0 to ${size.width - 1} and y is 0 to ${size.height - 1}, in pixels of the image screenshot() returns.` : 'Use a point inside the image screenshot() returns.';
      throw new VerifyError('INVALID_ARGUMENT', `Nothing was clicked: (${x}, ${y}) is outside the screen. ${range}`);
    }
    return { x, y };
  }

  private async tapTarget(target: string): Promise<Point> {
    let response: RawResponse;
    try {
      response = await this.act({ action: 'click', target }, 90_000);
    } catch (error) {
      if (isVerifyError(error) && error.code === 'INVALID_ARGUMENT' && error.httpStatus === 422) throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `Nothing was clicked: this Revyl backend can't click a described target on a computer yet (invalid_request). Read the point off screenshot() and pass it to tap({ x, y }). See ${this.viewerUrl}`, { cause: error, httpStatus: 422 });
      throw error;
    }
    let point: { x?: unknown; y?: unknown } | undefined;
    try { point = (JSON.parse(new TextDecoder().decode(response.body)) as { point?: { x?: unknown; y?: unknown } } | null)?.point; } catch {}
    const { x, y } = point ?? {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || (x as number) < 0 || (y as number) < 0) throw new VerifyError('ACTION_UNCERTAIN', `Revyl answered the described click without the point it clicked, so where it landed is unknown. Take a screenshot() to check. See ${this.viewerUrl}`);
    return { x: x as number, y: y as number };
  }

  type(): Promise<never> {
    return this.unavailable('type');
  }

  /** Types into whatever has keyboard focus. Computers can't clear a field, so pass { clear: false }. */
  async typeFocused(text: string, options: { clear?: boolean } = {}): Promise<void> {
    if (options.clear !== false) throw new VerifyError('INVALID_ARGUMENT', "On a computer, typeFocused() can't clear the field first, so pass { clear: false } to type at the cursor: typeFocused(text, { clear: false }). To replace text, select it first, for example with pressKey('a', { modifiers: ['meta'] }) (Command+A on a Mac computer).");
    if (typeof text !== 'string' || text.length > 16_384) throw new VerifyError('INVALID_ARGUMENT', 'typeFocused() takes text of at most 16384 characters.');
    const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.exec(text);
    if (control) throw new VerifyError('INVALID_ARGUMENT', `Nothing was typed: typeFocused() on a computer takes newline and tab but no other control characters, and the text has one at index ${control.index}. Use pressKey() for keys such as 'escape'.`);
    const chunks: string[] = [];
    let chunk = '';
    for (const character of text) {
      if ([...chunk].length === 500 || Buffer.byteLength(chunk + character) > 1_500) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += character;
    }
    if (chunk) chunks.push(chunk);
    const total = [...text].length;
    let typed = 0;
    for (const part of chunks) {
      const length = [...part].length;
      try {
        await this.act({ action: 'type', text: part });
      } catch (error) {
        if (chunks.length === 1 || !isVerifyError(error)) throw error;
        const uncertain = error.code === 'ACTION_UNCERTAIN';
        const done = typed === 0 ? `typed nothing${uncertain ? ' for certain' : ''}: the first` : `typed the first ${typed} of ${total} characters; the next`;
        throw new VerifyError(error.code, `typeFocused() ${done} ${length}${typed === 0 ? ` of ${total}` : ''} characters ${uncertain ? 'may have been typed' : 'were not typed'}, and nothing after them was. ${error.message}`, { cause: error, reason: error.reason, httpStatus: error.httpStatus });
      }
      typed += length;
    }
  }

  doubleTap(): Promise<never> {
    return this.unavailable('doubleTap');
  }

  longPress(): Promise<never> {
    return this.unavailable('longPress');
  }

  swipe(): Promise<never> {
    return this.unavailable('swipe');
  }

  drag(): Promise<never> {
    return this.unavailable('drag');
  }

  /** Presses a key with modifiers held. 'meta' is the Command key on a Mac computer, and 'alt' is Option. */
  async pressKey(key: Key | string, options: { modifiers?: KeyModifier[] } = {}): Promise<void> {
    const checked = checkKey('web', key, options.modifiers ?? []);
    const name = checked.key in WEB_KEYS ? COMPUTER_KEYS[checked.key as Key] : checked.key;
    const modifiers = [...new Set(checked.modifiers)].map((modifier) => (modifier === 'meta' ? 'cmd' : modifier));
    await this.act({ action: 'key', keys: [...modifiers, name].join('+') });
  }

  back(): Promise<never> {
    return this.unavailable('back');
  }

  goHome(): Promise<never> {
    return this.unavailable('goHome');
  }

  openUrl(): Promise<never> {
    return this.unavailable('openUrl');
  }

  launchApp(): Promise<never> {
    return this.unavailable('launchApp');
  }

  locate(): Promise<never> {
    return Promise.reject(new VerifyError('NOT_AVAILABLE_ON_PLATFORM', "locate() isn't available on computers, because Revyl can't find a point there without clicking it. tap({ target }) clicks a description and returns the point it clicked; to choose the point yourself, read it off screenshot() and pass it to tap({ x, y })."));
  }

  /** The screenshot's size in pixels, the space tap() uses. */
  async screenSize(): Promise<{ width: number; height: number }> {
    const { width, height } = pngSize(await this.screenshot())!;
    return { width, height };
  }

  get expiresAt(): Date | undefined {
    return this.expiresAtMs === undefined ? undefined : new Date(this.expiresAtMs);
  }

  async recording(): Promise<ComputerRecording | null> {
    const signal = AbortSignal.timeout(30_000);
    const report = this.parseReport(await this.request('GET', '/report', undefined, signal));
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
    let retrySignal = signal;
    let response: RawResponse;
    let transient = false;
    let backoffMs = 500;
    const notReady = () => new VerifyError('SESSION_BUSY', `The computer desktop is not ready for screenshots after its 30-second startup window. Try again later. See ${this.viewerUrl}`);
    try {
      for (;;) {
        this.assertOpen();
        response = await this.request('GET', '/screen/screenshot', undefined, retrySignal);
        if (response.status >= 200 && response.status < 300) break;
        const remainingMs = this.screenReadyUntilMs - Date.now();
        if (remainingMs <= 0) throw notReady();
        if (!transient) retrySignal = AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]);
        transient = true;
        await delay(Math.min(backoffMs, remainingMs), undefined, { signal: retrySignal });
        if (Date.now() >= this.screenReadyUntilMs) throw notReady();
        backoffMs = Math.min(backoffMs * 2, 2_000);
      }
    } catch (error) {
      if (transient && !this.lifetime.signal.aborted && (this.expiresAtMs === undefined || Date.now() < this.expiresAtMs) && retrySignal.aborted && Date.now() >= this.screenReadyUntilMs) throw notReady();
      if (retrySignal.aborted) throw new VerifyError('TIMEOUT', `Computer screenshot observation was cancelled or exceeded its deadline. See ${this.viewerUrl}`);
      throw error;
    }
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
      this.closing = true;
      this.lifetime.abort();
      const childCleanup = (async () => {
        await Promise.allSettled([...this.childStarts]);
        return Promise.allSettled([...this.children].map((child) => child.close()));
      })();
      const childDeadline = new AbortController();
      const childResults = await Promise.race([childCleanup, delay(5_000, undefined, { signal: childDeadline.signal })]);
      childDeadline.abort();
      try {
        if (!this.stopOnClose) {
          if (!childResults || childResults.some((result) => result.status === 'rejected')) throw new VerifyError('ACTION_UNCERTAIN', `Hosted child cleanup is unconfirmed; the attached computer was left running. See ${this.viewerUrl}`);
          this.log('detached; computer left running');
          return;
        }
        const report = this.parseReport(await this.request('POST', '/stop', undefined, AbortSignal.timeout(310_000)));
        if (report.release !== 'confirmed') {
          throw new VerifyError('ACTION_UNCERTAIN', `Computer stop was requested, but physical release is unconfirmed. Inspect ${this.viewerUrl}`);
        }
        if (!['stopped', 'failed', 'owner_lost'].includes(report.state)) throw invalidResponse();
        if (!childResults || childResults.some((result) => result.status === 'rejected')) this.log('a child stop was unconfirmed before the parent was released');
        this.log('closed');
      } catch (error) {
        if (this.stopOnClose && isVerifyError(error) && error.code === 'ACTION_UNCERTAIN') {
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
    let wireCommand: unknown = command;
    if (command.kind === 'exec') {
      const { argv, ...fields } = command;
      wireCommand = { ...fields, argv_b64: argv.map(encodeWireText) };
    } else if (command.kind === 'file_read' || command.kind === 'file_write' || command.kind === 'file_stat') {
      const { path, ...fields } = command;
      wireCommand = { ...fields, path_b64: encodeWireText(path) };
    }
    try {
      let response = await this.request('POST', '/operations', { computer_session_id: this.id, request_id: requestId, command: wireCommand }, signal);
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

  private async request(method: 'GET' | 'POST', suffix: string, body: unknown, signal: AbortSignal, timeoutMs?: number): Promise<RawResponse> {
    const path = `/api/v1/computer-runs${suffix === '' ? '' : `/${this.id}${suffix}`}`;
    let response: RawResponse;
    try {
      response = await this.client.send(method, path, { body, signal, timeoutMs: timeoutMs ?? (suffix === '/stop' || suffix.startsWith('/operations') ? 310_000 : 30_000), retry: method === 'GET' && suffix !== '/screen/screenshot', headers: suffix === '/operations' ? { Prefer: 'respond-async' } : undefined });
    } catch (error) {
      if (suffix === '/screen/actions') throw new VerifyError('ACTION_UNCERTAIN', `The screen action may have happened: Revyl's answer never arrived. Verify will not repeat it; take a screenshot() to check before you do. See ${this.viewerUrl}`);
      if (method === 'POST' || suffix.startsWith('/operations/')) throw new VerifyError('ACTION_UNCERTAIN', `Computer request outcome is unconfirmed. Verify will not repeat it. See ${this.viewerUrl}`);
      if (isVerifyError(error)) throw new VerifyError(error.code, `Could not read the computer state. See ${this.viewerUrl}`);
      throw error;
    }
    if (response.status >= 200 && response.status < 300) return response;
    const blocked = edgeBlockedError(response);
    if (blocked) throw blocked;
    if (suffix === '/recording' && response.status === 404 && responseErrorCode(response) === 'recording_unavailable') return response;
    const detail = responseRefusalReason(response) ?? responseDetail(response);
    const refusal = { reason: responseRefusalReason(response), httpStatus: response.status };
    const reason = detail && ERROR_CODES.has(detail) ? detail : `HTTP ${response.status}`;
    if (suffix === '/screen/screenshot') {
      let raw: { detail?: unknown; message?: unknown; error?: unknown } | null = null;
      try { raw = JSON.parse(new TextDecoder().decode(response.body)); } catch {}
      const code = raw?.detail ?? raw?.message ?? raw?.error;
      if ((code === 'screen_unavailable' && (response.status === 409 || response.status === 503)) || (code === 'screen_starting' && response.status === 409)) return response;
    }
    if (detail === 'computer_not_enabled' || (response.status === 503 && detail === 'runtime_unavailable')) {
      throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `Revyl refused the computer request (${detail}). ${COMPUTER_AVAILABILITY} See ${this.viewerUrl}`, refusal);
    }
    if (response.status === 429 && detail === 'computer_limit') throw new VerifyError('COMPUTER_LIMIT', `${COMPUTER_CAPACITY} See ${this.viewerUrl}`, refusal);
    if (suffix === '/screen/actions') {
      if (response.status === 422 && detail === 'screen_point_outside') return response;
      if (response.status === 409 && detail === 'screen_starting') return response;
      if (detail === 'screen_target_not_found') throw new VerifyError('ACTION_FAILED', `Nothing was clicked: Revyl could not find the described target on the screen (screen_target_not_found). Take a screenshot() and pass a point to tap({ x, y }). See ${this.viewerUrl}`, refusal);
      if (detail === 'screen_target_unavailable') throw new VerifyError('API_ERROR', `Nothing was clicked: Revyl could not look up the described target just now (screen_target_unavailable). It is safe to try again. See ${this.viewerUrl}`, refusal);
      if (detail === 'screen_control_held') throw new VerifyError('SESSION_BUSY', `Nothing happened: someone else is controlling this computer's screen in the viewer (screen_control_held). Try again after they release it; control frees itself after 2 minutes without input. See ${this.viewerUrl}`, refusal);
      if (detail === 'screen_input_uncertain' || detail === 'screen_unavailable' || detail === 'screen_input_unavailable') throw new VerifyError('ACTION_UNCERTAIN', `The screen action may have happened (${detail}). Verify will not repeat it; take a screenshot() to check before you do. See ${this.viewerUrl}`, refusal);
      if (response.status === 403) throw new VerifyError('AUTH_REJECTED', `Revyl refused the screen action (forbidden). The API key's owner needs the Member role or above in the organization, and CI runner keys can't control the screen yet. See ${this.viewerUrl}`, refusal);
      if (response.status === 503 && detail === 'authentication_unavailable') throw new VerifyError('API_ERROR', `Nothing happened: Revyl could not confirm your access just now (authentication_unavailable). It is safe to try again. See ${this.viewerUrl}`, refusal);
      if (detail === 'screen_text_unsupported') throw new VerifyError('INVALID_ARGUMENT', `Nothing was typed: this computer can't type some of these characters (screen_text_unsupported). See ${this.viewerUrl}`, refusal);
      if (detail === 'screen_control_lost') throw new VerifyError('SESSION_BUSY', `Nothing happened: control of this computer's screen changed hands before the action was sent (screen_control_lost). Try again; if someone is controlling the screen in the viewer, wait until they release it, which happens on its own after 2 minutes without input. See ${this.viewerUrl}`, refusal);
      if (detail === 'screen_key_unsupported') throw new VerifyError('INVALID_ARGUMENT', `Nothing was pressed: this computer can't press that key (screen_key_unsupported). Use a key pressKey() lists in the docs, or typeFocused() for a printable character. See ${this.viewerUrl}`, refusal);
    }
    let code: keyof typeof REFUSAL_NEXT_STEPS = 'API_ERROR';
    if (response.status === 401 || response.status === 403) code = 'AUTH_REJECTED';
    else if (detail === 'run_closed') code = 'SESSION_ENDED';
    else if (detail === 'inaccessible' || detail === 'invalid_handle') code = 'NOT_FOUND';
    else if (detail === 'operation_not_found' || detail === 'owner_unavailable') code = 'ACTION_UNCERTAIN';
    else if (detail === 'invalid_request' || response.status === 422) code = 'INVALID_ARGUMENT';
    else if (detail === 'start_failed') code = 'SESSION_START_FAILED';
    else if (response.status === 409 || detail === 'operation_limit') code = 'SESSION_BUSY';
    else if (suffix.startsWith('/operations/') && response.status >= 500) code = 'ACTION_UNCERTAIN';
    else if (method === 'POST' && (response.status >= 500 || response.status < 400)) code = 'ACTION_UNCERTAIN';
    let next = REFUSAL_NEXT_STEPS[code];
    if (suffix === '/screen/actions' && code === 'ACTION_UNCERTAIN') next = 'The screen action may have happened. Verify will not repeat it; take a screenshot() to check before you do.';
    else if (suffix === '/screen/actions' && code === 'INVALID_ARGUMENT') next = 'Part of the screen action may have run, so take a screenshot() to check the screen before you try again.';
    else if (code === 'ACTION_UNCERTAIN' && method === 'GET' && !suffix.startsWith('/operations/')) next = 'Nothing on the computer changed; it is safe to try again.';
    throw new VerifyError(code, `Revyl refused the computer request (${reason}). ${next} See ${this.viewerUrl}`, refusal);
  }

  private async act(action: Record<string, unknown>, timeoutMs = 30_000): Promise<RawResponse> {
    this.assertOpen();
    const signal = this.observationSignal(timeoutMs);
    const deadlineMs = Date.now() + 30_000;
    for (;;) {
      const response = await this.request('POST', '/screen/actions', { action, screenshot: false }, signal, timeoutMs);
      if (response.status !== 409) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1_000 : 1_000;
      const seconds = Math.ceil(waitMs / 1_000);
      const starting = new VerifyError('SESSION_BUSY', `Nothing happened: the computer's screen is still starting (screen_starting). Try again in ${seconds} second${seconds === 1 ? '' : 's'}. See ${this.viewerUrl}`, { httpStatus: 409 });
      if (Date.now() + waitMs >= deadlineMs) throw starting;
      try {
        await delay(waitMs, undefined, { signal });
      } catch {
        this.assertOpen();
        throw starting;
      }
      this.assertOpen();
    }
  }

  private parseReport(response: RawResponse): ComputerReport {
    const report = parseComputerJson<ComputerReport>(response);
    if (!report || report.computer_session_id !== this.id || !STATES.has(report.state)) throw invalidResponse();
    if (report.expires_at != null) this.expiresAtMs = parseTimestamp(report.expires_at).getTime();
    return report;
  }

  private assertOpen(): void {
    if (this.closing || this.closed || (this.expiresAtMs !== undefined && Date.now() >= this.expiresAtMs)) throw new VerifyError('SESSION_ENDED', `The ${this.target} computer was closed or expired.`);
  }

  private observationSignal(timeoutMs: number): AbortSignal {
    const remainingMs = this.expiresAtMs === undefined ? timeoutMs : Math.min(timeoutMs, this.expiresAtMs - Date.now());
    return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(Math.max(0, remainingMs))]);
  }

  private unavailable(method: string): Promise<never> {
    return Promise.reject(new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${method}() is not available on computers. ${SCREEN_CALLS} See ${this.viewerUrl}`));
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

function encodeWireText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
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
