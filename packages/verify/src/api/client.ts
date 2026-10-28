import { setTimeout as delay } from 'node:timers/promises';
import { VerifyError, errorMessage, type RefusalReason } from '../errors.js';
import { VERSION } from '../version.js';
import type {
  AppResponse,
  BuildPage,
  BuildResponse,
  DeviceSessionDetail,
  DeviceSessionStopResponse,
  StartDeviceRequest,
  StartDeviceResponse,
  WhoAmI,
  WorkerConnection,
} from './types.js';

export const DEFAULT_BACKEND_URL = 'https://backend.revyl.ai';
export const DEFAULT_APP_URL = 'https://app.revyl.ai';

/** Sent on every request so Revyl can attribute sessions that Verify starts. */
export const CLIENT_HEADER_VALUE = 'verify';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1500];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export interface RevylClientOptions {
  token: string;
  backendUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  timeoutMs?: number;
  retry?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export class RevylClient {
  readonly backendUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: RevylClientOptions) {
    this.token = options.token;
    this.backendUrl = validateBackendUrl(options.backendUrl ?? DEFAULT_BACKEND_URL);
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async send(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const url = new URL(path, this.backendUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
    }
    const retry = options.retry ?? method === 'GET';
    const attempts = retry ? RETRY_DELAYS_MS.length + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.sendOnce(method, url, options);
      const retryable = outcome instanceof Error || RETRYABLE_STATUSES.has(outcome.status);
      if (!retryable || attempt >= attempts || options.signal?.aborted) {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 1500, undefined, { signal: options.signal }).catch(() => undefined);
    }
  }

  async json<T>(method: 'GET' | 'POST', path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    if (response.status < 200 || response.status >= 300) throw apiError(method, path, response);
    return parseJson<T>(response, `${method} ${path}`);
  }

  startDevice(request: StartDeviceRequest, signal?: AbortSignal): Promise<StartDeviceResponse> {
    return this.json('POST', '/api/v1/execution/start_device', { body: request, retry: false, timeoutMs: 120_000, signal });
  }

  getDeviceSession(sessionId: string, signal?: AbortSignal): Promise<DeviceSessionDetail> {
    return this.json('GET', `/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`, { signal });
  }

  getWorkerConnection(workflowRunId: string, signal?: AbortSignal): Promise<WorkerConnection> {
    return this.json('GET', `/api/v1/execution/streaming/worker-connection/${encodeURIComponent(workflowRunId)}`, { signal });
  }

  stopDeviceSession(sessionId: string, retry = true): Promise<DeviceSessionStopResponse> {
    return this.json('POST', `/api/v1/execution/device/sessions/${encodeURIComponent(sessionId)}/stop`, { retry });
  }

  cancelDevice(workflowRunId: string): Promise<unknown> {
    return this.json('POST', `/api/v1/execution/device/status/cancel/${encodeURIComponent(workflowRunId)}`, { retry: true });
  }

  getApp(appId: string, signal?: AbortSignal): Promise<AppResponse> {
    return this.json('GET', `/api/v1/apps/${encodeURIComponent(appId)}`, { signal });
  }

  registerWebUrlBuild(
    appId: string,
    request: { url: string; branch_name?: string },
    signal?: AbortSignal,
  ): Promise<BuildResponse> {
    return this.json('POST', `/api/v1/apps/${encodeURIComponent(appId)}/builds/external`, { body: request, retry: true, signal });
  }

  async latestWebBuild(appId: string, branch: { branchId?: string; branchName?: string }, signal?: AbortSignal): Promise<BuildResponse | undefined> {
    const page = await this.json<BuildPage>('GET', `/api/v1/apps/${encodeURIComponent(appId)}/builds`, {
      query: {
        artifact_kinds: ['web_external', 'web_bundle'],
        branch_id: branch.branchId,
        branch_name: branch.branchName,
        include_jobs: 'false',
        page: '1',
        page_size: '1',
      },
      signal,
    });
    return page.items[0];
  }

  whoAmI(): Promise<WhoAmI> {
    return this.json('GET', '/api/v1/entity/users/get_user_uuid');
  }

  worker(
    workflowRunId: string,
    action: string,
    options: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; signal?: AbortSignal; retry?: boolean },
  ): Promise<RawResponse> {
    const path = `/api/v1/execution/device-proxy/${encodeURIComponent(workflowRunId)}/${action}`;
    return this.send(options.method, path, {
      body: options.body,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      retry: options.retry ?? false,
      headers: { 'X-Revyl-Agent': 'Verify' },
    });
  }

  private async sendOnce(method: 'GET' | 'POST', url: URL, options: RequestOptions): Promise<RawResponse | VerifyError> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': `revyl-verify/${VERSION} node/${process.versions.node}`,
      'X-Revyl-Client': CLIENT_HEADER_VALUE,
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        signal,
      });
      return { status: response.status, headers: response.headers, body: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      if (options.signal?.aborted) {
        return new VerifyError('TIMEOUT', `Revyl request ${method} ${url.pathname} ran past its caller's deadline.`, { cause: error });
      }
      if (timeout.aborted) {
        return new VerifyError(
          'TIMEOUT',
          `Revyl request ${method} ${url.pathname} got no response within ${options.timeoutMs ?? this.requestTimeoutMs} ms.`,
          { cause: error },
        );
      }
      return new VerifyError('API_ERROR', `Could not reach Revyl at ${url.origin}: ${errorMessage(error)}`, { cause: error });
    }
  }
}

export function appUrl(origin = DEFAULT_APP_URL): string {
  validateBackendUrl(origin, 'viewer');
  return origin.replace(/\/+$/, '');
}

export function sessionViewerUrl(sessionId: string, kind?: 'computer', origin?: string): string {
  return `${appUrl(origin)}/sessions/${encodeURIComponent(sessionId)}${kind ? `?kind=${kind}` : ''}`;
}

export function parseJson<T>(response: RawResponse, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as T;
  } catch (error) {
    throw new VerifyError('API_ERROR', `Revyl returned a response to ${what} that is not JSON (HTTP ${response.status}).`, {
      cause: error,
    });
  }
}

export function responseDetail(response: RawResponse): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const detail = record.detail ?? record.message ?? record.error;
  if (typeof detail === 'string') return detail.slice(0, 500);
  if (Array.isArray(detail)) {
    return detail
      .map((item) => (typeof item === 'object' && item !== null && 'msg' in item ? String((item as { msg: unknown }).msg) : String(item)))
      .join('; ')
      .slice(0, 500);
  }
  return undefined;
}

export function responseErrorCode(response: RawResponse): string | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

export function apiError(method: string, path: string, response: RawResponse): VerifyError {
  const blocked = edgeBlockedError(response);
  if (blocked) return blocked;
  const detail = path === '/api/v1/execution/start_device' ? responseKnownDetail(response, START_ERROR_DETAILS) : responseDetail(response);
  const suffix = detail ? `: ${detail}` : '';
  if (response.status === 401 || response.status === 403) {
    return new VerifyError(
      'AUTH_REJECTED',
      `Revyl rejected the request ${method} ${path} (HTTP ${response.status})${suffix}. Check REVYL_API_KEY or run 'revyl auth login'.`,
      { reason: responseRefusalReason(response), httpStatus: response.status },
    );
  }
  return new VerifyError('API_ERROR', `Revyl request ${method} ${path} failed with HTTP ${response.status}${suffix}`, { reason: responseRefusalReason(response), httpStatus: response.status });
}

export function edgeBlockedError(response: RawResponse): VerifyError | undefined {
  if (response.status !== 403 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html' || !response.headers.get('cf-ray')?.trim()) return undefined;
  try {
    JSON.parse(new TextDecoder().decode(response.body));
    return undefined;
  } catch {}
  return new VerifyError('EDGE_BLOCKED', 'Revyl request was blocked at the network edge (HTTP 403). Check network access or contact support. Verify will not retry this request.', { httpStatus: response.status });
}

const REFUSAL_REASONS = new Set<RefusalReason>([
  'web_runtime_unavailable', 'web_runtime_not_configured', 'computer_limit', 'runtime_unavailable', 'computer_runtime_unavailable',
  'computer_at_capacity', 'computer_not_running', 'computer_cannot_host_platform', 'computer_not_found',
  'web_build_required', 'web_build_not_supported', 'ios_build_required', 'ios_build_not_supported',
  'android_build_required', 'android_build_not_supported', 'web_session_conflict', 'ios_session_conflict',
  'android_session_conflict', 'not_available_on_platform', 'request_timeout', 'protocol_error',
]);

const START_ERROR_DETAILS = new Set<string>([
  ...REFUSAL_REASONS,
  'web_start_actor_invalid', 'web_app_required', 'web_app_not_found', 'web_idle_timeout_invalid',
  'web_preview_overrides_unsupported', 'web_env_override_invalid', 'web_env_override_secret',
  'web_sign_in_config_invalid', 'web_sign_in_override_not_secret', 'web_env_overrides_not_supported',
  'web_build_selection_invalid', 'web_build_not_found', 'web_build_invalid', 'web_billing_not_configured',
  'web_concurrency_unavailable', 'web_worker_unavailable', 'web_session_fence_conflict',
  'web_callback_conflict', 'web_start_in_progress', 'web_start_unconfirmed', 'web_session_inputs_unavailable',
  'sign_in_secret_not_found', 'sign_in_secret_unavailable', 'proof_sign_in_not_configured',
]);

export function responseRefusalReason(response: RawResponse): RefusalReason | undefined {
  return responseKnownDetail(response, REFUSAL_REASONS);
}

function responseKnownDetail<T extends string>(response: RawResponse, codes: ReadonlySet<T>): T | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const values: unknown[] = [record.detail];
    if (record.detail && typeof record.detail === 'object') values.push((record.detail as Record<string, unknown>).error);
    values.push(record.error);
    return values.find((value): value is T => typeof value === 'string' && codes.has(value as T));
  } catch {
    return undefined;
  }
}

function validateBackendUrl(raw: string, label = 'backend'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VerifyError('CONFIG_INVALID', `The ${label} URL is not a valid URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new VerifyError('CONFIG_INVALID', `The ${label} URL must use HTTPS (plain HTTP is allowed only on loopback).`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new VerifyError('CONFIG_INVALID', `The ${label} URL must be an origin without credentials, query, or fragment.`);
  }
  return url.origin;
}
