import { randomUUID } from 'node:crypto';
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
  ResolveTargetResult,
  StartDeviceRequest,
  StepAccepted,
  StepStatus,
  WebTab,
  WorkerActionResult,
  WorkerHealth,
} from './api/types.js';
import type { ResolvedTarget } from './config.js';
import { VerifyError, errorMessage } from './errors.js';

const POLL_INTERVAL_MS = 2_000;
const DEVICE_CONNECT_TIMEOUT_MS = 90_000;
const STEP_POLL_BASE_MS = 500;
const STEP_POLL_MAX_MS = 5_000;
const STEP_CANCEL_TIMEOUT_MS = 5_000;
const ENDED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout', 'stopping']);
const STEP_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const UNCERTAIN_ERROR_CODES = new Set(['request_timeout', 'connection_closed', 'protocol_error']);

export interface ScreenSize {
  width: number;
  height: number;
}

export interface StartSessionOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/** One live Revyl cloud device or browser session, driven through Revyl's public device API. */
export class RevylSession {
  readonly platform: Platform;
  readonly targetName: string;
  readonly id: string;
  readonly viewerUrl: string;
  screenSize: ScreenSize | undefined;
  /** Where a web test starts: the configured URL, or the origin the build opened. */
  webStartUrl: string | undefined;
  /** The bundle id launched when the target names one; otherwise the installed app is launched. */
  bundleId: string | undefined;
  private workflowRunId: string;
  private stopPromise: Promise<void> | undefined;

  private constructor(
    private readonly client: RevylClient,
    platform: Platform,
    targetName: string,
    id: string,
    workflowRunId: string,
  ) {
    this.platform = platform;
    this.targetName = targetName;
    this.id = id;
    this.workflowRunId = workflowRunId;
    this.viewerUrl = sessionViewerUrl(id);
  }

  static async start(client: RevylClient, target: ResolvedTarget, options: StartSessionOptions = {}): Promise<RevylSession> {
    const { signal } = options;
    const deadline = Date.now() + target.startTimeout;
    if (target.platform === 'web') {
      const buildId = await resolveWebBuildId(client, target, signal);
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
      const response = await client.startDevice(request, signal);
      if (response.session_id !== sessionId) {
        throw new VerifyError(
          'SESSION_START_FAILED',
          `Revyl did not start the ${target.name} web session: ${response.error ?? response.message ?? 'the start was not acknowledged'}`,
        );
      }
      const session = new RevylSession(client, 'web', target.name, sessionId, response.workflow_run_id ?? '');
      options.onProgress?.(`${target.name}: web session ${session.viewerUrl}`);
      await session.untilStarted(async () => {
        await session.waitForWebReady(deadline, signal);
        session.webStartUrl = target.app.url ?? (await session.webOrigin(signal));
      });
      return session;
    }

    const request: StartDeviceRequest = {
      platform: target.platform,
      is_simulation: true,
      idle_timeout_seconds: target.idleTimeoutSeconds,
      ...(target.app.appId ? { app_id: target.app.appId } : {}),
      ...(target.app.buildId ? { build_id: target.app.buildId } : {}),
      ...(target.app.artifactUrl ? { app_url: target.app.artifactUrl } : {}),
      ...(target.device?.model ? { device_model: target.device.model } : {}),
      ...(target.device?.osVersion ? { os_version: target.device.osVersion } : {}),
    };
    const response = await client.startDevice(request, signal);
    if (!response.workflow_run_id) {
      throw new VerifyError(
        'SESSION_START_FAILED',
        `Revyl did not start the ${target.name} device: ${response.error ?? response.message ?? 'no workflow run was returned'}`,
      );
    }
    const session = new RevylSession(client, target.platform, target.name, response.session_id ?? '', response.workflow_run_id);
    options.onProgress?.(`${target.name}: device session ${session.id ? session.viewerUrl : response.workflow_run_id}`);
    session.bundleId = target.app.bundleId;
    await session.untilStarted(async () => {
      await session.waitForDeviceReady(deadline, signal);
      if (!target.app.appId && !target.app.buildId && !target.app.artifactUrl) await session.launchApp(signal);
    });
    return session;
  }

  get hasStopped(): boolean {
    return this.stopPromise !== undefined;
  }

  stop(): Promise<void> {
    this.stopPromise ??= (async () => {
      if (this.id) await this.client.stopDeviceSession(this.id);
      else await this.client.cancelDevice(this.workflowRunId);
    })();
    return this.stopPromise;
  }

  async launchApp(signal?: AbortSignal): Promise<void> {
    this.requireMobile('Launching an app');
    await this.perform('launch', this.bundleId ? { bundle_id: this.bundleId } : {}, signal);
  }

  async killApp(signal?: AbortSignal): Promise<void> {
    this.requireMobile('Closing the app');
    await this.perform('kill_app', {}, signal);
  }

  /** Puts a reused session back at the start of the app before the next test. */
  async resetForNextTest(signal?: AbortSignal): Promise<void> {
    if (this.platform === 'web') {
      if (this.webStartUrl) await this.perform('open_url', { url: this.webStartUrl }, signal);
      return;
    }
    await this.killApp(signal);
    await this.launchApp(signal);
  }

  async screenshot(signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.worker('GET', 'screenshot', { signal, retry: true });
    const size = pngSize(response.body);
    if (!size) throw new VerifyError('ACTION_FAILED', 'Revyl returned a screenshot that is not a PNG image.');
    if (this.platform === 'web') this.screenSize = size;
    return response.body;
  }

  /** The coordinate space taps and swipes use: the screenshot on web, the device's reported size on mobile. */
  async readScreenSize(signal?: AbortSignal): Promise<ScreenSize> {
    if (this.screenSize) return this.screenSize;
    if (this.platform === 'web') {
      await this.screenshot(signal);
      return this.screenSize!;
    }
    const health = parseJson<WorkerHealth>(await this.worker('GET', 'health', { signal, retry: true }), 'health');
    if (!health.screen_width || !health.screen_height) {
      throw new VerifyError('ACTION_FAILED', `The ${this.targetName} device did not report its screen size.`);
    }
    this.screenSize = { width: health.screen_width, height: health.screen_height };
    return this.screenSize;
  }

  async hierarchy(signal?: AbortSignal): Promise<string> {
    this.requireMobile('Reading the UI hierarchy');
    const response = await this.worker('GET', 'hierarchy', { signal, retry: true });
    return new TextDecoder().decode(response.body);
  }

  async act(
    action: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; acceptErrorCodes?: string[] } = {},
  ): Promise<WorkerActionResult> {
    const response = await this.worker('POST', action, { body, signal: options.signal, acceptErrorCodes: options.acceptErrorCodes });
    return parseJson<WorkerActionResult>(response, action);
  }

  async perform(action: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerActionResult> {
    const result = await this.act(action, body ?? {}, { signal });
    if (result.success !== true) {
      throw new VerifyError('ACTION_FAILED', `${action} did not succeed on the ${this.targetName} session: ${result.error ?? 'no reason given'}`);
    }
    return result;
  }

  async resolveTarget(description: string, signal?: AbortSignal): Promise<ResolveTargetResult> {
    const response = await this.worker('POST', 'resolve_target', {
      body: { target: description, ...(this.id ? { session_id: this.id } : {}) },
      signal,
      acceptErrorCodes: ['target_not_found', 'grounding_failed', 'stale_target'],
    });
    const result = parseJson<ResolveTargetResult>(response, 'resolve_target');
    return { ...result, found: result.found === true };
  }

  async runStep(
    type: LiveStepType,
    description: string,
    options: { metadata?: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal },
  ): Promise<LiveStepResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.worker('POST', 'execute_step', {
      body: {
        step_type: type,
        step_description: description,
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(this.id ? { session_id: this.id } : {}),
        workflow_run_id: this.workflowRunId,
      },
      signal,
    });
    const body = parseJson<LiveStepResult | StepAccepted>(response, 'execute_step');
    if ('success' in body) return body;
    if (body.status !== 'accepted' || !body.step_id) {
      throw new VerifyError('API_ERROR', 'Revyl answered execute_step without a result or an accepted step id.');
    }

    let wait = STEP_POLL_BASE_MS;
    try {
      for (;;) {
        await delay(wait, undefined, { signal });
        const statusResponse = await this.worker('GET', `step_status/${encodeURIComponent(body.step_id)}`, { signal, retry: true });
        const status = parseJson<StepStatus>(statusResponse, 'step_status');
        if (status.status === 'running') {
          wait = Math.min(wait * 2, STEP_POLL_MAX_MS);
          continue;
        }
        if (!STEP_TERMINAL_STATUSES.has(status.status) || !status.result) {
          throw new VerifyError('API_ERROR', `Step ${body.step_id} reported status ${status.status} without a result Verify can read.`);
        }
        return status.result;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      await this.worker('POST', `step_cancel/${encodeURIComponent(body.step_id)}`, {
        body: {},
        signal: AbortSignal.timeout(STEP_CANCEL_TIMEOUT_MS),
      }).catch(() => undefined);
      if (timeout.aborted) {
        throw new VerifyError('TIMEOUT', `The ${type} step did not finish within ${options.timeoutMs} ms and was cancelled: "${description}"`);
      }
      throw new VerifyError('CANCELLED', `The ${type} step was cancelled: "${description}"`);
    }
  }

  async webOrigin(signal?: AbortSignal): Promise<string | undefined> {
    const response = await this.worker('GET', 'tabs', { signal, retry: true });
    const tabs = parseJson<WebTab[]>(response, 'tabs');
    return (tabs.find((tab) => tab.active) ?? tabs[0])?.url_origin;
  }

  requireMobile(feature: string): void {
    if (this.platform === 'web') {
      throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${feature} is available on iOS and Android sessions, not on web.`);
    }
  }

  requireWeb(feature: string): void {
    if (this.platform !== 'web') {
      throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${feature} is available on web sessions, not on ${this.platform}.`);
    }
  }

  private async worker(
    method: 'GET' | 'POST',
    action: string,
    options: { body?: unknown; signal?: AbortSignal; retry?: boolean; acceptErrorCodes?: string[] },
  ): Promise<RawResponse> {
    if (this.stopPromise) throw new VerifyError('SESSION_ENDED', `The ${this.targetName} session was stopped.`);
    const response = await this.client.worker(this.workflowRunId, action, {
      method,
      body: options.body,
      signal: options.signal,
      retry: options.retry,
    });
    if (response.status >= 200 && response.status < 300) return response;
    const code = responseErrorCode(response);
    if (code && options.acceptErrorCodes?.includes(code)) return response;
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
          `Revyl's ${this.platform} sessions do not run natural-language agent steps yet (${code ?? 'HTTP 501'}). ` +
            'agent.act, agent.assert, and agent.extract will work here with no change to your tests once Revyl enables them; ' +
            'until then, use screen locators and expect() on this target.',
        );
      }
      return new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `${baseAction} is not available on ${this.platform} sessions (${reason}).`);
    }
    if (response.status === 404 || response.status === 410) {
      return new VerifyError('SESSION_ENDED', `The ${this.targetName} session is no longer reachable (${reason}). See ${this.viewerUrl}`);
    }
    if (response.status === 409) {
      return new VerifyError('ACTION_FAILED', `The ${this.targetName} session is busy and refused ${baseAction}: ${reason}`);
    }
    if (method === 'POST' && (isExecutionUncertain(response) || (code && UNCERTAIN_ERROR_CODES.has(code)))) {
      return new VerifyError(
        'ACTION_UNCERTAIN',
        `${baseAction} may or may not have been applied (${reason}); Verify does not repeat it. Check the session at ${this.viewerUrl}`,
      );
    }
    return new VerifyError('ACTION_FAILED', `${baseAction} failed on the ${this.targetName} session (HTTP ${response.status}): ${reason}`);
  }

  private async untilStarted(waitForReady: () => Promise<void>): Promise<void> {
    try {
      await waitForReady();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  private async waitForWebReady(deadline: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const detail = await this.client.getDeviceSession(this.id, signal);
      if (ENDED_STATUSES.has(detail.status)) {
        throw new VerifyError(
          'SESSION_START_FAILED',
          `The ${this.targetName} web session ended before it was ready (${detail.status}): ${detail.error_message ?? 'no reason given'}. See ${this.viewerUrl}`,
        );
      }
      if (detail.status === 'running' && detail.workflow_run_id) {
        this.workflowRunId = detail.workflow_run_id;
        const response = await this.client.worker(this.workflowRunId, 'screenshot', { method: 'GET', signal });
        const size = response.status === 200 ? pngSize(response.body) : undefined;
        if (size) {
          this.screenSize = size;
          return;
        }
        if (response.status !== 503 && response.status !== 409 && responseErrorCode(response) !== 'not_ready') {
          throw this.workerError('GET', 'screenshot', response);
        }
      }
      await waitBeforeDeadline(deadline, signal, `The ${this.targetName} web session was not ready in time. See ${this.viewerUrl}`);
    }
  }

  private async waitForDeviceReady(deadline: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const connection = await this.client.getWorkerConnection(this.workflowRunId, signal);
      if (connection.status === 'ready' && connection.worker_ws_url) break;
      if (connection.status === 'cancelled' || connection.status === 'stopped' || connection.status === 'failed') {
        throw new VerifyError(
          'SESSION_START_FAILED',
          `The ${this.targetName} device did not start (${connection.status}): ${connection.message ?? 'no reason given'}`,
        );
      }
      await waitBeforeDeadline(deadline, signal, `The ${this.targetName} device was not assigned in time.`);
    }
    const connectDeadline = Math.min(deadline, Date.now() + DEVICE_CONNECT_TIMEOUT_MS);
    for (;;) {
      const response = await this.client.worker(this.workflowRunId, 'health', { method: 'GET', signal, retry: true });
      if (response.status === 200) {
        const health = parseJson<WorkerHealth>(response, 'health');
        if (health.device_connected) {
          if (health.screen_width && health.screen_height) {
            this.screenSize = { width: health.screen_width, height: health.screen_height };
          }
          return;
        }
      } else if (response.status !== 503) {
        throw this.workerError('GET', 'health', response);
      }
      await waitBeforeDeadline(connectDeadline, signal, `The ${this.targetName} device did not connect in time.`);
    }
  }
}

async function resolveWebBuildId(
  client: RevylClient,
  target: Extract<ResolvedTarget, { platform: 'web' }>,
  signal?: AbortSignal,
): Promise<string> {
  const { app } = target;
  if (app.buildId) return app.buildId;
  if (app.url) {
    const build = await client.registerWebUrlBuild(app.appId, { url: app.url, ...(app.branch ? { branch_name: app.branch } : {}) }, signal);
    if (!build.id) throw new VerifyError('API_ERROR', `Revyl registered ${app.url} without returning a build id.`);
    return build.id;
  }
  let branchId: string | undefined;
  if (!app.branch) {
    const detail = await client.getApp(app.appId, signal);
    if (detail.platform && detail.platform.toLowerCase() !== 'web') {
      throw new VerifyError('CONFIG_INVALID', `Target ${target.name}: Revyl app ${app.appId} is a ${detail.platform} app, not a web app.`);
    }
    branchId = detail.default_branch_id ?? undefined;
  }
  const latest = await client.latestWebBuild(app.appId, { branchId, branchName: app.branch }, signal);
  if (!latest?.id) {
    throw new VerifyError(
      'SESSION_START_FAILED',
      `Target ${target.name}: Revyl app ${app.appId} has no web build${app.branch ? ` on branch ${app.branch}` : ''}. ` +
        "Set app.url to a deployed HTTPS URL, or build one with 'revyl build --platform web'.",
    );
  }
  return latest.id;
}

async function waitBeforeDeadline(deadline: number, signal: AbortSignal | undefined, timeoutMessage: string): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new VerifyError('TIMEOUT', timeoutMessage);
  try {
    await delay(Math.min(POLL_INTERVAL_MS, remaining), undefined, { signal });
  } catch (error) {
    throw new VerifyError('CANCELLED', `Cancelled while waiting: ${errorMessage(error)}`, { cause: error });
  }
}

function isExecutionUncertain(response: RawResponse): boolean {
  try {
    return (JSON.parse(new TextDecoder().decode(response.body)) as { execution_uncertain?: unknown }).execution_uncertain === true;
  } catch {
    return false;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function pngSize(bytes: Uint8Array): ScreenSize | undefined {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
