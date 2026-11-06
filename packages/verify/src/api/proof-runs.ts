import { apiError, parseJson, type RawResponse, type RevylClient } from './client.js';
import { VerifyError, type VerifyErrorCode } from '../errors.js';

/*
 * Built against Revyl's provisional proof-runs contract (REVL-18697), which is not declared yet. This module is the
 * only place that knows the paths and wire shapes, so aligning to the declared contract changes nothing outside it.
 */

export type ProofHarness = 'revyl' | 'cursor' | 'capy' | 'devin';

export interface PullRequestContext {
  provider: 'github';
  repository: string;
  number: number;
  headSha: string;
  baseSha?: string;
}

export type ProofEnvironmentValue = string | { secretRef: string };

export interface CreateProofRunRequest {
  appId: string;
  buildId: string;
  pullRequest: PullRequestContext;
  harness: ProofHarness;
  guidance?: string;
  environment?: Record<string, ProofEnvironmentValue>;
}

export interface ProofRunState {
  id: string;
  status: string;
  verdict?: string;
  label?: string;
  reportUrl?: string;
  reviewUrl?: string;
  createdAt?: string;
  settledAt?: string;
}

const PROOF_RUNS_PATH = '/api/v1/proof-runs';
const CREATE_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 15_000;
const GITHUB_APP_FIX = 'Proof of Changes needs the Revyl GitHub App on the repository: run `revyl github connect`, or grant the repository to the Revyl GitHub App.';
const REFUSALS: Record<string, VerifyErrorCode> = {
  config_managed_review: 'CONFIG_MANAGED_REVIEW',
  github_app_not_connected: 'GITHUB_APP_NOT_CONNECTED',
  github_app_not_installed: 'GITHUB_APP_NOT_CONNECTED',
  github_repository_not_granted: 'GITHUB_APP_NOT_CONNECTED',
  pull_request_closed: 'PR_CLOSED',
  head_sha_not_current: 'HEAD_NOT_CURRENT',
  app_not_found: 'NOT_FOUND',
  build_not_found: 'NOT_FOUND',
  platform_mismatch: 'PLATFORM_MISMATCH',
  preview_unreachable: 'PREVIEW_UNREACHABLE',
  url_unreachable: 'PREVIEW_UNREACHABLE',
};

export async function createProofRun(client: RevylClient, request: CreateProofRunRequest, signal?: AbortSignal): Promise<ProofRunState> {
  const { pullRequest } = request;
  const response = await client.send('POST', PROOF_RUNS_PATH, {
    body: {
      app_id: request.appId,
      build_id: request.buildId,
      scm: {
        provider: pullRequest.provider,
        repo: pullRequest.repository,
        pr_number: pullRequest.number,
        head_sha: pullRequest.headSha,
        ...(pullRequest.baseSha ? { base_sha: pullRequest.baseSha } : {}),
      },
      settings: {
        harness: request.harness,
        ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
        ...(request.environment !== undefined ? { environment: wireEnvironment(request.environment) } : {}),
      },
    },
    timeoutMs: CREATE_TIMEOUT_MS,
    retry: false,
    signal,
  });
  return proofRunState(response, 'POST', PROOF_RUNS_PATH);
}

export async function getProofRun(client: RevylClient, id: string, signal?: AbortSignal): Promise<ProofRunState> {
  const path = `${PROOF_RUNS_PATH}/${encodeURIComponent(id)}`;
  return proofRunState(await client.send('GET', path, { signal }), 'GET', path, id);
}

export async function cancelProofRun(client: RevylClient, id: string): Promise<void> {
  const path = `${PROOF_RUNS_PATH}/${encodeURIComponent(id)}/cancel`;
  const response = await client.send('POST', path, { retry: true, timeoutMs: CANCEL_TIMEOUT_MS });
  if (response.status === 409) return;
  if (response.status < 200 || response.status >= 300) throw apiError('POST', path, response);
}

function wireEnvironment(environment: Record<string, ProofEnvironmentValue>): Record<string, { value: string } | { secret_ref: string }> {
  return Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, typeof value === 'string' ? { value } : { secret_ref: value.secretRef }]));
}

function proofRunState(response: RawResponse, method: string, path: string, knownId?: string): ProofRunState {
  if (response.status < 200 || response.status >= 300) throw proofRunError(response, method, path);
  const wire = parseJson<Record<string, unknown>>(response, `${method} ${path}`);
  const id = typeof wire.proof_run_id === 'string' && wire.proof_run_id !== '' ? wire.proof_run_id : knownId;
  if (id === undefined || typeof wire.status !== 'string') {
    throw new VerifyError('API_ERROR', `Revyl returned a proof run to ${method} ${path} without an id and status.`, { httpStatus: response.status });
  }
  const text = (key: string): string | undefined => (typeof wire[key] === 'string' && wire[key] !== '' ? (wire[key] as string) : undefined);
  const fields: Array<[keyof ProofRunState, string | undefined]> = [
    ['verdict', text('verdict')],
    ['label', text('display_status_label')],
    ['reportUrl', text('report_url')],
    ['reviewUrl', text('review_url')],
    ['createdAt', text('created_at')],
    ['settledAt', text('settled_at')],
  ];
  return { id, status: wire.status, ...Object.fromEntries(fields.filter(([, value]) => value !== undefined)) };
}

function proofRunError(response: RawResponse, method: string, path: string): VerifyError {
  const error = apiError(method, path, response);
  if (error.code === 'EDGE_BLOCKED') return error;
  const { code, message, proofRunId } = refusal(response);
  const mapped = code === undefined ? undefined : REFUSALS[code];
  const options = { httpStatus: response.status, ...(proofRunId ? { proofRunId } : {}) };
  const refused = `Revyl refused the proof run (HTTP ${response.status}${code ? `, ${code}` : ''})${message ? `: ${message}` : ''}.`;
  if (mapped === 'GITHUB_APP_NOT_CONNECTED') return new VerifyError(mapped, `${refused} ${GITHUB_APP_FIX}`, options);
  if (mapped === 'CONFIG_MANAGED_REVIEW') {
    return new VerifyError(mapped, `${refused} The repository's .revyl/config.yaml already runs Proof of Changes for this head, so proof() can't start another run.`, options);
  }
  if (mapped === 'PREVIEW_UNREACHABLE') {
    return new VerifyError(mapped, `${refused} Revyl couldn't load the URL: it must be public HTTPS on port 443 and answer below HTTP 400 without headers or basic auth.`, options);
  }
  if (mapped) return new VerifyError(mapped, refused, options);
  if (response.status === 409 && proofRunId) {
    return new VerifyError('PROOF_RUN_CONFLICT', `${refused} Proof run ${proofRunId} already covers this head with different settings.`, options);
  }
  if (response.status === 404 && method === 'GET') return new VerifyError('NOT_FOUND', error.message, options);
  return error;
}

function refusal(response: RawResponse): { code?: string; message?: string; proofRunId?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const detail = typeof record.detail === 'object' && record.detail !== null ? (record.detail as Record<string, unknown>) : {};
  const first = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value !== '');
  const code = first(record.error, record.code, detail.error, detail.code, record.detail);
  const message = first(detail.message, record.message, record.detail);
  return {
    code,
    ...(message !== undefined && message !== code ? { message: message.slice(0, 500) } : {}),
    proofRunId: first(record.proof_run_id, detail.proof_run_id),
  };
}
