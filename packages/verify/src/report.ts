import { RevylClient, apiError, appUrl, edgeBlockedError, parseJson, sessionViewerUrl } from './api/client.js';
import type { DeviceSessionDetail } from './api/types.js';
import { VerifyError } from './errors.js';
import { credentialsForUse } from './open.js';
import { FINAL_STATUSES } from './session.js';

export interface SessionReportStep {
  /** The step's kind, such as 'instruction' or 'validation'. */
  type: string;
  description: string | null;
  /** 'passed', 'failed', 'warning', 'pending' or 'running'. */
  status: string;
  /** Whether the step passed, or null when Revyl recorded no verdict. */
  passed: boolean | null;
  /** Revyl's reasoning for the verdict. */
  reasoning: string | null;
  error: string | null;
}

export interface SessionReport {
  id: string;
  /** The session's page in Revyl, with its recording. */
  viewerUrl: string;
  /** 'web', 'ios', 'android', 'macos' or 'linux'. */
  platform: string | null;
  /** The session's status, such as 'running', 'completed' or 'failed'. */
  status: string;
  /** Whether the status is final: completed, failed, cancelled or timeout. */
  finished: boolean;
  /** Why the session failed, when Revyl recorded a reason. */
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The steps in Revyl's report, in the order they ran. Empty for computers and for sessions without a report yet. */
  steps: SessionReportStep[];
}

export interface ReportOptions {
  backendUrl?: string;
  appUrl?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReportStepRecord = {
  step_type?: unknown;
  step_description?: unknown;
  status?: unknown;
  effective_status?: unknown;
  success?: unknown;
  validation_result?: unknown;
  validation_reasoning?: unknown;
  error_message?: unknown;
  execution_order?: unknown;
};

/**
 * Reads a session's outcome and steps from Revyl, including after the process that ran it exited.
 * Pass the session id, such as session.id or the id at the end of its viewer link.
 */
export async function report(sessionId: string, options: ReportOptions = {}): Promise<SessionReport> {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) {
    throw new VerifyError('INVALID_ARGUMENT', 'report() takes a Revyl session id (a UUID), such as session.id or the id at the end of the session link.');
  }
  appUrl(options.appUrl);
  const credentials = await credentialsForUse(options);
  const client = new RevylClient({ token: credentials.token, backendUrl: options.backendUrl });
  const sessionPath = `/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`;
  const sessionResponse = await client.send('GET', sessionPath);
  if (sessionResponse.status === 404 && !edgeBlockedError(sessionResponse)) {
    throw new VerifyError(
      'NOT_FOUND',
      `Revyl has no session ${sessionId} in this API key's organization at ${client.backendUrl}. Check the id and the API key.`,
      { httpStatus: 404 },
    );
  }
  if (sessionResponse.status < 200 || sessionResponse.status >= 300) throw apiError('GET', sessionPath, sessionResponse);
  const detail = parseJson<(DeviceSessionDetail & { started_at?: unknown; ended_at?: unknown }) | null>(sessionResponse, `GET ${sessionPath}`);
  if (!detail || typeof detail !== 'object' || typeof detail.status !== 'string') {
    throw new VerifyError('API_ERROR', `Revyl returned a session without a status for GET ${sessionPath}.`);
  }

  const reportPath = `/api/v1/reports-v3/reports/by-session/${encodeURIComponent(sessionId)}/context`;
  const reportResponse = await client.send('GET', reportPath, { query: { include_steps: 'true', include_actions: 'false', include_llm_calls: 'false' } });
  let records: ReportStepRecord[] = [];
  if (reportResponse.status !== 404 || edgeBlockedError(reportResponse)) {
    if (reportResponse.status < 200 || reportResponse.status >= 300) throw apiError('GET', reportPath, reportResponse);
    const steps = parseJson<{ steps?: unknown } | null>(reportResponse, `GET ${reportPath}`)?.steps;
    if (steps != null && !Array.isArray(steps)) throw new VerifyError('API_ERROR', `Revyl returned a report whose steps are not a list for GET ${reportPath}.`);
    records = (steps ?? []).filter((step): step is ReportStepRecord => typeof step === 'object' && step !== null);
  }
  const order = (step: ReportStepRecord) => (typeof step.execution_order === 'number' ? step.execution_order : Number.POSITIVE_INFINITY);
  const platform = text(detail.platform);
  return {
    id: sessionId,
    viewerUrl: sessionViewerUrl(sessionId, platform === 'macos' || platform === 'linux' ? 'computer' : undefined, options.appUrl),
    platform,
    status: detail.status,
    finished: FINAL_STATUSES.has(detail.status),
    error: text(detail.error_message),
    startedAt: text(detail.started_at),
    endedAt: text(detail.ended_at),
    steps: [...records].sort((a, b) => order(a) - order(b)).map((step) => ({
      type: text(step.step_type) ?? 'step',
      description: text(step.step_description),
      status: text(step.effective_status) ?? text(step.status) ?? 'unknown',
      passed: typeof step.validation_result === 'boolean' ? step.validation_result : typeof step.success === 'boolean' ? step.success : null,
      reasoning: text(step.validation_reasoning),
      error: text(step.error_message),
    })),
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
