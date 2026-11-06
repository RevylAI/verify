import { apiError, parseJson, responseErrorCode, type RawResponse, type RevylClient } from './client.js';
import { VerifyError } from '../errors.js';

/*
 * The proof-runs endpoints are not declared by Revyl yet (REVL-860). This module is the only place that knows
 * their paths and wire shapes, so aligning to the declared contract changes nothing outside it.
 */

export type ProofHarness = 'revyl' | 'cursor' | 'capy' | 'devin';
export type ProofRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'errored';
export type ProofVerdict = 'ready' | 'ready_with_polish' | 'ready_with_issues' | 'failed' | 'inconclusive';

export interface PullRequestContext {
  provider: 'github';
  repository: string;
  number: number;
  headSha: string;
  baseSha: string;
}

export interface CreateProofRunRequest {
  appId: string;
  buildId: string;
  pullRequest: PullRequestContext;
  harness: ProofHarness;
  guidance?: string;
  environment?: Record<string, string>;
}

export interface ProofRunState {
  id: string;
  status: ProofRunStatus;
  verdict?: ProofVerdict;
  reportUrl: string;
}

const STATUSES = new Set<ProofRunStatus>(['queued', 'running', 'completed', 'cancelled', 'errored']);
const VERDICTS = new Set<ProofVerdict>(['ready', 'ready_with_polish', 'ready_with_issues', 'failed', 'inconclusive']);
const GITHUB_APP_REFUSALS = new Set(['github_app_not_connected', 'github_app_not_installed', 'github_repository_not_granted']);
const PROOF_RUNS_PATH = '/api/v1/proof-runs';
const CREATE_TIMEOUT_MS = 60_000;
const CANCEL_TIMEOUT_MS = 15_000;

interface ProofRunWire {
  proof_run_id?: unknown;
  status?: unknown;
  verdict?: unknown;
  report_url?: unknown;
}

export async function createProofRun(client: RevylClient, request: CreateProofRunRequest, signal?: AbortSignal): Promise<ProofRunState> {
  const { pullRequest } = request;
  const response = await client.send('POST', PROOF_RUNS_PATH, {
    body: {
      app_id: request.appId,
      build_id: request.buildId,
      scm: { provider: pullRequest.provider, repo: pullRequest.repository, pr_number: pullRequest.number, head_sha: pullRequest.headSha, base_sha: pullRequest.baseSha },
      settings: {
        harness: request.harness,
        ...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
        ...(request.environment !== undefined ? { environment: request.environment } : {}),
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
  return proofRunState(await client.send('GET', path, { signal }), 'GET', path);
}

export async function cancelProofRun(client: RevylClient, id: string): Promise<void> {
  const path = `${PROOF_RUNS_PATH}/${encodeURIComponent(id)}/cancel`;
  const response = await client.send('POST', path, { retry: true, timeoutMs: CANCEL_TIMEOUT_MS });
  if (response.status === 409) return;
  if (response.status < 200 || response.status >= 300) throw apiError('POST', path, response);
}

function proofRunState(response: RawResponse, method: string, path: string): ProofRunState {
  if (response.status < 200 || response.status >= 300) throw proofRunError(response, method, path);
  const wire = parseJson<ProofRunWire>(response, `${method} ${path}`);
  const { proof_run_id: id, status, verdict, report_url: reportUrl } = wire;
  if (typeof id !== 'string' || id === '' || typeof reportUrl !== 'string' || !STATUSES.has(status as ProofRunStatus)) {
    throw new VerifyError('API_ERROR', `Revyl returned a proof run to ${method} ${path} without a known id, status, and report URL.`, { httpStatus: response.status });
  }
  if (status === 'completed' && !VERDICTS.has(verdict as ProofVerdict)) {
    throw new VerifyError('API_ERROR', `Revyl completed proof run ${id} with an unknown verdict.`, { httpStatus: response.status });
  }
  return { id, status: status as ProofRunStatus, ...(status === 'completed' ? { verdict: verdict as ProofVerdict } : {}), reportUrl };
}

function proofRunError(response: RawResponse, method: string, path: string): VerifyError {
  const error = apiError(method, path, response);
  const code = responseErrorCode(response);
  if (code !== undefined && GITHUB_APP_REFUSALS.has(code)) {
    return new VerifyError(
      'GITHUB_APP_NOT_CONNECTED',
      `${error.message}. Proof of Changes needs the Revyl GitHub App installed with access to the repository: run \`revyl github connect\`, then \`revyl github status\`.`,
      { httpStatus: response.status },
    );
  }
  if (response.status === 404 && method === 'GET') return new VerifyError('NOT_FOUND', error.message, { httpStatus: 404 });
  return error;
}
