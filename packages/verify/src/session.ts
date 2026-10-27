import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RevylClient,
  apiError,
  parseJson,
  responseDetail,
  responseErrorCode,
  sessionViewerUrl,
  type RawResponse,
} from './api/client.js';
import type {
  LiveStepResult,
  LiveStepType,
  Platform,
  StartDeviceRequest,
  StepAccepted,
  StepStatus,
  WorkerActionResult,
  WorkerHealth,
} from './api/types.js';
import { trackSession, untrackSession } from './cleanup.js';
import type { ResolvedDeviceTarget } from './config.js';
import { VerifyError, errorMessage, isVerifyError } from './errors.js';
import { screenHasContent } from './screen-readiness.js';

const POLL_INTERVAL_MS = 2_000;
const DEVICE_CONNECT_TIMEOUT_MS = 90_000;
const STEP_POLL_BASE_MS = 500;
const STEP_POLL_MAX_MS = 5_000;
const STEP_CANCEL_TIMEOUT_MS = 5_000;
const MAX_STEP_TEXT_LENGTH = 4_000;
const ENDED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout', 'stopping']);
const STEP_TERMINAL_STATUSES = new Set(['completed', 'failed']);
const SESSION_NOT_RUNNING = /session is (not running|not active|stopping)/i;
const UNCERTAIN_ERROR_CODES = new Set(['request_timeout', 'connection_closed', 'protocol_error']);

export type StepType = LiveStepType;

/** The outcome of one instruction or validation, as Revyl's agent reported it. */
export interface StepResult {
  type: StepType;
  text: string;
  passed: boolean;
  /** Revyl's explanation, when it gave one. */
  reason?: string;
  durationMs: number;
}

export interface StepOptions {
  /** Milliseconds before the step is cancelled on Revyl. Defaults to stepTimeout from the config, or 180000. */
  timeout?: number;
}

export interface ValidationOptions extends StepOptions {
  /** Return a failed result instead of throwing VALIDATION_FAILED. */
  soft?: boolean;
}

export interface OperationOptions {
  /** Milliseconds Revyl lets the operation run on the computer, up to 300000. Defaults to 30000. */
  timeout?: number;
}

export interface ExecOptions extends OperationOptions {
  /** Throw COMMAND_FAILED when the command exits non-zero. Defaults to true; false returns the result instead. */
  check?: boolean;
  /** Bytes sent to the command's standard input. */
  stdin?: string | Uint8Array;
}

/** The outcome of a command run on a computer. Revyl keeps the first 1 MiB of stdout and stderr together. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FileStat {
  kind: 'file' | 'directory';
  size: number;
}

/** A process a command on this computer started. Its id is Revyl's handle, not a PID. */
export interface ComputerProcess {
  id: string;
  state: 'running' | 'exited';
  exitCode?: number;
}

export interface ComputerRecording {
  url: string;
  durationSeconds?: number;
  startedAt?: Date;
}

/**
 * One live Revyl session: a cloud browser, an iOS or Android device, or a computer.
 * A call the session's platform does not offer throws NOT_AVAILABLE_ON_PLATFORM.
 */
export interface Session {
  readonly platform: Platform;
  /** The target name: its key in verify.config.ts, or the platform for a target passed inline. */
  readonly target: string;
  /** Revyl's session id. */
  readonly id: string;
  /** The live view of the session in Revyl, and its recording and report once it ends. */
  readonly viewerUrl: string;
  /** Every instruction and validation run on this session, in order. */
  readonly steps: StepResult[];
  readonly closed: boolean;
  readonly expiresAt?: Date;
  recording(): Promise<ComputerRecording | null>;
  /** Asks Revyl's agent to do something on the app. Browsers and devices only. */
  instruction(text: string, options?: StepOptions): Promise<StepResult>;
  /** Asks Revyl's agent whether something holds on screen. Browsers and devices only. */
  validation(text: string, options?: ValidationOptions): Promise<StepResult>;
  /** A PNG of the screen right now, also written to path when given. */
  screenshot(options?: { path?: string }): Promise<Uint8Array>;
  /** Runs a program with its arguments, not a shell line. Computers only. */
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Up to the first 1 MiB of a file, by a path relative to the computer's workspace. Computers only. */
  readFile(path: string, options?: OperationOptions): Promise<Buffer>;
  /** Writes up to 64 KiB to a file, by a path relative to the computer's workspace. Computers only. */
  writeFile(path: string, data: string | Uint8Array, options?: OperationOptions): Promise<void>;
  /** Whether a path is a file or a directory, and its size. Computers only. */
  stat(path: string, options?: OperationOptions): Promise<FileStat>;
  /** The processes commands on this computer started. Computers only. */
  processes(options?: OperationOptions): Promise<ComputerProcess[]>;
  /** Stops a process from processes(). Computers only. */
  terminate(processId: string, options?: OperationOptions): Promise<void>;
  /** Stops the session on Revyl. Safe to call more than once. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface SessionOptions {
  stepTimeout: number;
  log: ((line: string) => void) | undefined;
}

/** A Revyl cloud browser or iOS or Android device. */
export class DeviceSession implements Session {
  readonly platform: Platform;
  /** The target name: its key in verify.config.ts, or the platform for a target passed inline. */
  readonly target: string;
  /** Revyl's session id. */
  readonly id: string;
  /** The live view of the session in Revyl, and its recording and report once it ends. */
  readonly viewerUrl: string;
  /** Every instruction and validation run on this session, in order. */
  readonly steps: StepResult[] = [];
  private workflowRunId: string;
  private closePromise: Promise<void> | undefined;
  private stepRunning = false;

  private constructor(
    private readonly client: RevylClient,
    target: ResolvedDeviceTarget,
    id: string,
    workflowRunId: string,
    private readonly options: SessionOptions,
  ) {
    this.platform = target.platform;
    this.target = target.name;
    this.id = id;
    this.workflowRunId = workflowRunId;
    this.viewerUrl = sessionViewerUrl(id);
  }

  static async start(client: RevylClient, target: ResolvedDeviceTarget, options: SessionOptions): Promise<DeviceSession> {
    const deadline = Date.now() + target.startTimeout;
    if (target.platform === 'web') {
      const buildId = await resolveWebBuildId(client, target);
      const sessionId = randomUUID();
      const request: StartDeviceRequest = {
        platform: 'web',
        session_id: sessionId,
        app_id: target.app.appId,
        build_id: buildId,
        idle_timeout_seconds: target.idleTimeoutSeconds,
        web: {
          ...(target.viewport
            ? {
                viewport: {
                  width: target.viewport.width,
                  height: target.viewport.height,
                  ...(target.viewport.deviceScaleFactor ? { device_scale_factor: target.viewport.deviceScaleFactor } : {}),
                },
              }
            : {}),
          ...(target.signIn
            ? { sign_in: { path: target.signIn.path, secret_name: target.signIn.secret, ...(target.signIn.persona ? { persona: target.signIn.persona } : {}) } }
            : {}),
        },
      };
      const response = await client.startDevice(request);
      if (response.session_id !== sessionId) {
        throw new VerifyError(
          'SESSION_START_FAILED',
          `Revyl did not start the ${target.name} web session: ${response.error ?? response.message ?? 'the start was not acknowledged'}`,
        );
      }
      const session = new DeviceSession(client, target, sessionId, response.workflow_run_id ?? '', options);
      await session.untilReady(() => session.waitForWebReady(deadline));
      return session;
    }

    const { app } = target;
    const request: StartDeviceRequest = {
      platform: target.platform,
      is_simulation: true,
      idle_timeout_seconds: target.idleTimeoutSeconds,
      ...(app.appId ? { app_id: app.appId } : {}),
      ...(app.buildId ? { build_id: app.buildId } : {}),
      ...(app.artifactUrl ? { app_url: app.artifactUrl } : {}),
      ...(target.device?.model ? { device_model: target.device.model } : {}),
      ...(target.device?.osVersion ? { os_version: target.device.osVersion } : {}),
    };
    const response = await client.startDevice(request);
    if (!response.workflow_run_id) {
      throw new VerifyError(
        'SESSION_START_FAILED',
        `Revyl did not start the ${target.name} device: ${response.error ?? response.message ?? 'no workflow run was returned'}`,
      );
    }
    const session = new DeviceSession(client, target, response.session_id ?? '', response.workflow_run_id, options);
    await session.untilReady(async () => {
      await session.waitForDeviceReady(deadline);
      if (app.bundleId) await session.launch(app.bundleId);
      await session.waitForScreenContent(deadline);
    });
    return session;
  }

  get closed(): boolean {
    return this.closePromise !== undefined;
  }

  /** Asks Revyl's agent to do something on the app, such as "add the first product to the cart". Throws INSTRUCTION_FAILED when it cannot. */
  async instruction(text: string, options: StepOptions = {}): Promise<StepResult> {
    const result = await this.step('instruction', text, options.timeout);
    if (!result.passed) {
      throw new VerifyError('INSTRUCTION_FAILED', `Instruction failed: "${result.text}". ${sentence(result.reason)} See ${this.viewerUrl}`);
    }
    return result;
  }

  /**
   * Asks Revyl's agent whether something holds on screen, such as "the cart shows 2 items". Throws VALIDATION_FAILED when it does not,
   * unless soft is set, and STEP_FAILED when Revyl could not reach a verdict.
   */
  async validation(text: string, options: ValidationOptions = {}): Promise<StepResult> {
    const result = await this.step('validation', text, options.timeout);
    if (!result.passed && !options.soft) {
      throw new VerifyError('VALIDATION_FAILED', `Validation failed: "${result.text}". ${sentence(result.reason)} See ${this.viewerUrl}`);
    }
    return result;
  }

  /** A PNG of the screen right now, also written to path when given. */
  async screenshot(options: { path?: string } = {}): Promise<Uint8Array> {
    const response = await this.worker('GET', 'screenshot', { retry: true });
    if (!pngSize(response.body)) throw new VerifyError('ACTION_FAILED', 'Revyl returned a screenshot that is not a PNG image.');
    if (options.path) {
      const path = resolve(options.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, response.body);
    }
    return response.body;
  }

  exec(): Promise<ExecResult> {
    return this.computerOnly('exec');
  }

  recording(): Promise<never> {
    return this.computerOnly('recording');
  }

  readFile(): Promise<Buffer> {
    return this.computerOnly('readFile');
  }

  writeFile(): Promise<void> {
    return this.computerOnly('writeFile');
  }

  stat(): Promise<FileStat> {
    return this.computerOnly('stat');
  }

  processes(): Promise<ComputerProcess[]> {
    return this.computerOnly('processes');
  }

  terminate(): Promise<void> {
    return this.computerOnly('terminate');
  }

  /** Stops the session on Revyl. Safe to call more than once. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        if (this.id) await this.client.stopDeviceSession(this.id);
        else await this.client.cancelDevice(this.workflowRunId);
        this.log('closed');
      } finally {
        untrackSession(this);
      }
    })();
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async step(type: StepType, text: string, timeout: number | undefined): Promise<StepResult> {
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_STEP_TEXT_LENGTH) {
      throw new VerifyError('INVALID_ARGUMENT', `${type}() takes a description of 1 to ${MAX_STEP_TEXT_LENGTH} characters.`);
    }
    const timeoutMs = timeout ?? this.options.stepTimeout;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new VerifyError('INVALID_ARGUMENT', `${type}() takes a timeout of at least 1000 ms.`);
    }
    if (this.stepRunning) {
      throw new VerifyError('INVALID_ARGUMENT', 'Run one step at a time on a session: await each instruction or validation before starting the next.');
    }
    this.stepRunning = true;
    const description = text.trim();
    const startedAt = Date.now();
    try {
      const outcome = await this.runStep(type, description, timeoutMs);
      const output = outcome.step_output ?? {};
      const reason = output.status_reason ?? output.reasoning ?? undefined;
      if (type === 'validation' && (outcome.success !== true || typeof output.validation_result !== 'boolean')) {
        const why = outcome.success === true ? 'Revyl returned no verdict.' : sentence(reason);
        throw new VerifyError('STEP_FAILED', `Validation did not reach a verdict: "${description}". ${why} See ${this.viewerUrl}`);
      }
      const passed = type === 'validation' ? output.validation_result === true : outcome.success === true && output.status !== 'failed';
      const result: StepResult = { type, text: description, passed, ...(reason ? { reason } : {}), durationMs: Date.now() - startedAt };
      this.steps.push(result);
      this.log(`${passed ? '✓' : '✗'} ${type} "${description}" (${formatDuration(result.durationMs)})${!passed && reason ? `: ${reason}` : ''}`);
      return result;
    } catch (error) {
      this.log(`✗ ${type} "${description}": ${isVerifyError(error) ? error.code : errorMessage(error)}`);
      throw error;
    } finally {
      this.stepRunning = false;
    }
  }

  private async runStep(type: StepType, description: string, timeoutMs: number): Promise<LiveStepResult> {
    const signal = AbortSignal.timeout(timeoutMs);
    let stepId: string | undefined;
    try {
      const response = await this.worker('POST', 'execute_step', {
        body: {
          step_type: type,
          step_description: description,
          ...(this.id ? { session_id: this.id } : {}),
          workflow_run_id: this.workflowRunId,
        },
        signal,
        timeoutMs,
      });
      const body = parseJson<LiveStepResult | StepAccepted>(response, 'execute_step');
      if ('success' in body) return body;
      if (body.status !== 'accepted' || !body.step_id) {
        throw new VerifyError('API_ERROR', 'Revyl answered execute_step without a result or an accepted step id.');
      }
      stepId = body.step_id;
      for (let wait = STEP_POLL_BASE_MS; ; wait = Math.min(wait * 2, STEP_POLL_MAX_MS)) {
        await delay(wait, undefined, { signal });
        const status = parseJson<StepStatus>(
          await this.worker('GET', `step_status/${encodeURIComponent(stepId)}`, { signal, retry: true }),
          'step_status',
        );
        if (status.status === 'running') continue;
        if (status.status === 'cancelled') {
          throw new VerifyError('STEP_FAILED', `The ${type} was cancelled on Revyl before it finished: "${description}". See ${this.viewerUrl}`);
        }
        if (!STEP_TERMINAL_STATUSES.has(status.status) || !status.result) {
          throw new VerifyError('API_ERROR', `Step ${stepId} reported status ${status.status} without a result Verify can read.`);
        }
        return status.result;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      if (stepId) {
        await this.client
          .worker(this.workflowRunId, `step_cancel/${encodeURIComponent(stepId)}`, {
            method: 'POST',
            body: {},
            signal: AbortSignal.timeout(STEP_CANCEL_TIMEOUT_MS),
          })
          .catch(() => undefined);
      }
      throw new VerifyError('TIMEOUT', `The ${type} did not finish within ${timeoutMs} ms and was cancelled: "${description}". See ${this.viewerUrl}`);
    }
  }

  private async launch(bundleId: string): Promise<void> {
    const response = await this.worker('POST', 'launch', { body: { bundle_id: bundleId } });
    const result = parseJson<WorkerActionResult>(response, 'launch');
    if (result.success !== true) {
      throw new VerifyError('SESSION_START_FAILED', `Could not launch ${bundleId} on the ${this.target} device: ${result.error ?? 'no reason given'}`);
    }
  }

  private async waitForScreenContent(startDeadline: number): Promise<void> {
    const deadline = Math.min(startDeadline, Date.now() + 10_000);
    while (Date.now() < deadline) {
      try {
        const response = await this.client.worker(this.workflowRunId, 'screenshot', {
          method: 'GET', retry: false, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (response.status === 200) {
          const content = screenHasContent(response.body);
          if (content === true) return;
          if (content === undefined) break;
        } else if (response.status !== 409 && response.status !== 503) {
          break;
        }
      } catch {
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(500, remaining));
    }
    this.log('debug: best-effort first-screen wait ended without non-blank content; the runtime has no rendered-readiness signal');
  }

  private log(line: string): void {
    this.options.log?.(`${this.target}: ${line}`);
  }

  private computerOnly(call: string): Promise<never> {
    return Promise.reject(
      new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${call}() runs on computer targets (platform 'mac' or 'linux'), not on ${this.platform} sessions.`),
    );
  }

  private async worker(
    method: 'GET' | 'POST',
    action: string,
    options: { body?: unknown; signal?: AbortSignal; retry?: boolean; timeoutMs?: number },
  ): Promise<RawResponse> {
    if (this.closePromise) throw new VerifyError('SESSION_ENDED', `The ${this.target} session was closed.`);
    const response = await this.client.worker(this.workflowRunId, action, { method, ...options });
    if (response.status >= 200 && response.status < 300) return response;
    throw this.workerError(method, action, response);
  }

  private workerError(method: 'GET' | 'POST', action: string, response: RawResponse): VerifyError {
    const baseAction = action.split('/')[0] ?? action;
    const code = responseErrorCode(response);
    const detail = responseDetail(response);
    const reason = detail ?? code ?? `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) return apiError(method, `device-proxy/${baseAction}`, response);
    if (response.status === 501 || code === 'not_available_on_platform' || code === 'step_output_not_available') {
      if (baseAction === 'execute_step' || baseAction === 'step_status') {
        return new VerifyError(
          'NOT_AVAILABLE_ON_PLATFORM',
          `The Revyl backend at ${this.client.backendUrl} does not run instruction and validation steps on ${this.platform} sessions (${code ?? 'HTTP 501'}).`,
        );
      }
      return new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${baseAction} is not available on ${this.platform} sessions (${reason}).`);
    }
    if (response.status === 404 || response.status === 410) {
      return new VerifyError('SESSION_ENDED', `The ${this.target} session is no longer reachable (${reason}). See ${this.viewerUrl}`);
    }
    if (response.status === 409) {
      if (SESSION_NOT_RUNNING.test(reason)) {
        return new VerifyError('SESSION_ENDED', `The ${this.target} session is no longer running (${reason}). See ${this.viewerUrl}`);
      }
      return new VerifyError('SESSION_BUSY', `The ${this.target} session is busy and refused ${baseAction}: ${reason}`);
    }
    if (method === 'POST' && (isExecutionUncertain(response) || (code && UNCERTAIN_ERROR_CODES.has(code)))) {
      return new VerifyError(
        'ACTION_UNCERTAIN',
        `${baseAction} may or may not have been applied (${reason}); Verify does not repeat it. Check the session at ${this.viewerUrl}`,
      );
    }
    return new VerifyError('ACTION_FAILED', `${baseAction} failed on the ${this.target} session (HTTP ${response.status}): ${reason}`);
  }

  private async untilReady(waitForReady: () => Promise<void>): Promise<void> {
    trackSession(this);
    this.log(`starting ${this.platform} session ${this.viewerUrl}`);
    try {
      await waitForReady();
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
    this.log('ready');
  }

  private async waitForWebReady(deadline: number): Promise<void> {
    for (;;) {
      const detail = await this.client.getDeviceSession(this.id);
      if (ENDED_STATUSES.has(detail.status)) {
        throw new VerifyError(
          'SESSION_START_FAILED',
          `The ${this.target} web session ended before it was ready (${detail.status}): ${detail.error_message ?? 'no reason given'}. See ${this.viewerUrl}`,
        );
      }
      if (detail.status === 'running' && detail.workflow_run_id) {
        this.workflowRunId = detail.workflow_run_id;
        const response = await this.client.worker(this.workflowRunId, 'screenshot', { method: 'GET' });
        if (response.status === 200 && pngSize(response.body)) return;
        if (response.status !== 503 && response.status !== 409 && responseErrorCode(response) !== 'not_ready') {
          throw this.workerError('GET', 'screenshot', response);
        }
      }
      await waitBeforeDeadline(deadline, `The ${this.target} web session was not ready in time. See ${this.viewerUrl}`);
    }
  }

  private async waitForDeviceReady(deadline: number): Promise<void> {
    for (;;) {
      const connection = await this.client.getWorkerConnection(this.workflowRunId);
      if (connection.status === 'ready' && connection.worker_ws_url) break;
      if (connection.status === 'cancelled' || connection.status === 'stopped' || connection.status === 'failed') {
        throw new VerifyError(
          'SESSION_START_FAILED',
          `The ${this.target} device did not start (${connection.status}): ${connection.message ?? 'no reason given'}`,
        );
      }
      await waitBeforeDeadline(deadline, `The ${this.target} device was not assigned in time.`);
    }
    const connectDeadline = Math.min(deadline, Date.now() + DEVICE_CONNECT_TIMEOUT_MS);
    for (;;) {
      const response = await this.client.worker(this.workflowRunId, 'health', { method: 'GET', retry: true });
      if (response.status === 200 && parseJson<WorkerHealth>(response, 'health').device_connected) return;
      if (response.status !== 200 && response.status !== 503) throw this.workerError('GET', 'health', response);
      await waitBeforeDeadline(connectDeadline, `The ${this.target} device did not connect in time.`);
    }
  }
}

async function resolveWebBuildId(
  client: RevylClient,
  target: Extract<ResolvedDeviceTarget, { platform: 'web' }>,
): Promise<string> {
  const { app } = target;
  if (app.buildId) return app.buildId;
  if (app.url) {
    const build = await client.registerWebUrlBuild(app.appId, { url: app.url, ...(app.branch ? { branch_name: app.branch } : {}) });
    if (!build.id) throw new VerifyError('API_ERROR', `Revyl registered ${app.url} without returning a build id.`);
    return build.id;
  }
  let branchId: string | undefined;
  if (!app.branch) {
    const detail = await client.getApp(app.appId);
    if (detail.platform && detail.platform.toLowerCase() !== 'web') {
      throw new VerifyError('CONFIG_INVALID', `Target ${target.name}: Revyl app ${app.appId} is a ${detail.platform} app, not a web app.`);
    }
    branchId = detail.default_branch_id ?? undefined;
  }
  const latest = await client.latestWebBuild(app.appId, { branchId, branchName: app.branch });
  if (!latest?.id) {
    throw new VerifyError(
      'SESSION_START_FAILED',
      `Target ${target.name}: Revyl app ${app.appId} has no web build${app.branch ? ` on branch ${app.branch}` : ''}. ` +
        "Set app.url to a deployed HTTPS URL, or build one with 'revyl build --platform web'.",
    );
  }
  return latest.id;
}

async function waitBeforeDeadline(deadline: number, timeoutMessage: string): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new VerifyError('TIMEOUT', timeoutMessage);
  await delay(Math.min(POLL_INTERVAL_MS, remaining));
}

function isExecutionUncertain(response: RawResponse): boolean {
  try {
    return (JSON.parse(new TextDecoder().decode(response.body)) as { execution_uncertain?: unknown }).execution_uncertain === true;
  } catch {
    return false;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function formatDuration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function sentence(reason: string | undefined): string {
  if (!reason) return 'Revyl gave no reason.';
  return /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
}
