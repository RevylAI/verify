import { setTimeout as delay } from 'node:timers/promises';
import { apiError, parseJson, type RawResponse, type RevylClient } from './client.js';
import { VerifyError, isVerifyError, type VerifyErrorCode } from '../errors.js';

/*
 * Revyl's Proof API, as declared in revyl-cli/docs/proof-api.md. This module is the only place that knows its paths,
 * wire shapes, and refusal codes.
 */

export type ProofHarness = 'revyl';

export interface PullRequestContext {
  provider: 'github';
  repository: string;
  number: number;
  headSha: string;
  baseSha?: string;
}

/**
 * A change Revyl can't read from a source host, uploaded with the proof request: the proof agent reads `diff` instead
 * of a checkout, and Revyl posts nothing anywhere.
 */
export interface ProofChange {
  /** Names the review in your own terms and groups its heads, such as `gitlab:group/app!17`. A new head supersedes. */
  reviewKey: string;
  headSha: string;
  baseSha?: string;
  /** Read by the proof agent as the pull request's title. */
  title: string;
  /** Read by the proof agent as the pull request's body. */
  description?: string;
  /** A unified diff (`git diff base...head`), at most 5 MiB of UTF-8. */
  diff: string;
  /** An https link to the review. It comes back as each run's `reviewUrl` and is never shown to the agent or fetched. */
  sourceUrl?: string;
}

export type ProofEnvironmentValue = string | { secretRef: string };

export interface ProofAuthBypass {
  deepLink: string;
}

export interface ProofRunTarget {
  appId: string;
  buildId: string;
  environment?: Record<string, ProofEnvironmentValue>;
  authBypass?: ProofAuthBypass;
}

export interface CreateProofRunsRequest {
  pullRequest?: PullRequestContext;
  change?: ProofChange;
  targets: ProofRunTarget[];
  harness: ProofHarness;
  guidance?: string;
}

export interface ProofRunState {
  id: string;
  /** Known from the create response; a GET may not repeat them. */
  appId?: string;
  platform?: string;
  status: string;
  verdict?: string;
  label?: string;
  reportUrl?: string;
  reviewUrl?: string;
  createdAt?: string;
  settledAt?: string;
  summaryMarkdown?: string;
}

const PROOF_RUNS_PATH = '/api/v1/proof-runs';
const CREATE_TIMEOUT_MS = 60_000;
const CREATE_RETRY_DELAYS_MS = [500, 1_000, 2_000];
const CANCEL_TIMEOUT_MS = 15_000;
const VERDICT_STATUSES = new Set(['passed', 'failed', 'inconclusive']);
const TERMINAL_STATUSES = new Set([...VERDICT_STATUSES, 'cancelled', 'superseded']);

const REFUSALS: Record<string, { code: VerifyErrorCode; hint?: string }> = {
  principal_not_allowed: { code: 'AUTH_REJECTED', hint: 'The Proof API takes a Revyl member API key or a Revyl CI runner job key.' },
  access_denied: { code: 'AUTH_REJECTED', hint: "Starting proofs needs the Member role or higher; a Viewer's key is refused." },
  environment_secret_ref_not_allowed: { code: 'SECRET_REF_NOT_ALLOWED', hint: 'Only a member API key can reference a secret launch variable; a CI runner job key cannot. Use a member key, or pass the variable as a plain non-secret value.' },
  repository_not_accessible: { code: 'GITHUB_APP_NOT_CONNECTED', hint: 'Grant the repository to the Revyl GitHub App, then run `revyl github status`.' },
  github_app_not_connected: { code: 'GITHUB_APP_NOT_CONNECTED', hint: 'Run `revyl github connect`, or grant the repository to the Revyl GitHub App.' },
  pull_request_not_found: { code: 'NOT_FOUND' },
  app_not_found: { code: 'NOT_FOUND' },
  build_not_found: { code: 'NOT_FOUND' },
  proof_run_not_found: { code: 'NOT_FOUND' },
  pull_request_not_open: { code: 'PR_CLOSED' },
  head_sha_mismatch: { code: 'HEAD_NOT_CURRENT', hint: 'The pull request moved on; prove its current head.' },
  base_sha_mismatch: { code: 'HEAD_NOT_CURRENT', hint: "The pull request's base moved on; prove it again from a fresh run of the job." },
  config_managed_review: { code: 'CONFIG_MANAGED_REVIEW', hint: "The repository's own Revyl config already proves this head." },
  proof_settings_conflict: { code: 'PROOF_RUN_CONFLICT', hint: 'Proofs with other apps, settings, environment, auth bypass, or change content already cover this head; upload a new build or prove a new head to prove again.' },
  head_superseded: { code: 'HEAD_SUPERSEDED', hint: 'A newer head of this review key was already proved, so this older head is not proved again.' },
  diff_too_large: { code: 'INVALID_ARGUMENT', hint: 'The diff is over 5 MiB.' },
  untrusted_pull_request_head: { code: 'UNTRUSTED_PR_HEAD', hint: 'Pull requests from forks are not proved.' },
  build_not_supported: { code: 'BUILD_REJECTED' },
  build_scm_mismatch: { code: 'BUILD_REJECTED', hint: 'The build was uploaded for another repository, pull request, or commit.' },
  unsupported_platform: { code: 'BUILD_REJECTED' },
  duplicate_target_platform: { code: 'INVALID_ARGUMENT' },
  web_build_unreachable: { code: 'PREVIEW_UNREACHABLE', hint: 'The Web URL must be reachable from the request until its run settles.' },
  environment_not_supported_on_web: { code: 'INVALID_ARGUMENT' },
  environment_secret_ref_not_found: { code: 'INVALID_ARGUMENT', hint: 'Create the organization launch variable first.' },
  environment_secret_ref_alias_unsupported: { code: 'INVALID_ARGUMENT' },
  environment_secret_value_refused: { code: 'INVALID_ARGUMENT', hint: 'Reference the secret launch variable by name instead of sending its value.' },
  auth_bypass_not_supported_on_web: { code: 'INVALID_ARGUMENT', hint: 'Web targets take no auth bypass deep link.' },
  auth_bypass_placeholder_not_found: { code: 'INVALID_ARGUMENT', hint: "Each ${NAME} placeholder in the deep link must name an entry of the same target's environment." },
  harness_not_supported: { code: 'INVALID_ARGUMENT' },
  invalid_request: { code: 'INVALID_ARGUMENT' },
  proof_run_limit_reached: { code: 'PROOF_RUN_LIMIT', hint: 'Too many Proof API runs are queued or running for the organization; try again once some settle.' },
  provider_unavailable: { code: 'PROVIDER_UNAVAILABLE', hint: 'Revyl could not reach GitHub.' },
};

/**
 * Starts one run per target, retrying 5xx and network errors like an upload does: a repeat of the same request returns
 * the existing runs, so it is safe to send again.
 */
export async function createProofRuns(client: RevylClient, request: CreateProofRunsRequest, signal?: AbortSignal): Promise<ProofRunState[]> {
  const { pullRequest, change } = request;
  const body = {
    targets: request.targets.map((target) => ({
      app_id: target.appId,
      build_id: target.buildId,
      ...(target.environment !== undefined ? { environment: wireEnvironment(target.environment) } : {}),
      ...(target.authBypass !== undefined ? { auth_bypass: { deep_link: target.authBypass.deepLink } } : {}),
    })),
    ...(change !== undefined
      ? {
          change: {
            review_key: change.reviewKey,
            head_sha: change.headSha,
            ...(change.baseSha ? { base_sha: change.baseSha } : {}),
            title: change.title,
            ...(change.description !== undefined ? { description: change.description } : {}),
            diff: change.diff,
            ...(change.sourceUrl !== undefined ? { source_url: change.sourceUrl } : {}),
          },
        }
      : {
          scm: {
            provider: pullRequest!.provider,
            repo: pullRequest!.repository,
            pr_number: pullRequest!.number,
            head_sha: pullRequest!.headSha,
            ...(pullRequest!.baseSha ? { base_sha: pullRequest!.baseSha } : {}),
          },
        }),
    settings: { harness: request.harness, ...(request.guidance !== undefined ? { guidance: request.guidance } : {}) },
  };
  const response = await sendCreate(client, body, signal);
  if (response.status < 200 || response.status >= 300) throw proofRunError(response, 'POST', PROOF_RUNS_PATH);
  const wire = parseJson<{ runs?: unknown }>(response, `POST ${PROOF_RUNS_PATH}`);
  if (!Array.isArray(wire.runs) || wire.runs.length !== request.targets.length) {
    throw new VerifyError('API_ERROR', `Revyl answered POST ${PROOF_RUNS_PATH} without one run per target.`, { httpStatus: response.status });
  }
  return wire.runs.map((run) => wireState(run, response.status, `POST ${PROOF_RUNS_PATH}`));
}

async function sendCreate(client: RevylClient, body: unknown, signal: AbortSignal | undefined): Promise<RawResponse> {
  for (let attempt = 0; ; attempt += 1) {
    let outcome: RawResponse | VerifyError;
    try {
      outcome = await client.send('POST', PROOF_RUNS_PATH, { body, timeoutMs: CREATE_TIMEOUT_MS, retry: false, signal });
    } catch (error) {
      if (signal?.aborted || !isVerifyError(error) || (error.code !== 'API_ERROR' && error.code !== 'TIMEOUT')) throw error;
      outcome = error;
    }
    const wait = CREATE_RETRY_DELAYS_MS[attempt];
    if (!(outcome instanceof VerifyError || outcome.status >= 500) || wait === undefined) {
      if (outcome instanceof VerifyError) throw outcome;
      return outcome;
    }
    try {
      await delay(wait, undefined, { signal });
    } catch (error) {
      throw new VerifyError('TIMEOUT', "Starting the proof runs ran past its caller's deadline.", { cause: error });
    }
  }
}

export async function getProofRun(client: RevylClient, id: string, signal?: AbortSignal): Promise<ProofRunState> {
  const path = `${PROOF_RUNS_PATH}/${encodeURIComponent(id)}`;
  const response = await client.send('GET', path, { signal });
  if (response.status < 200 || response.status >= 300) throw proofRunError(response, 'GET', path);
  return wireState(parseJson<unknown>(response, `GET ${path}`), response.status, `GET ${path}`, id);
}

/** Stops the run's agent and releases its device; cancelling a settled run changes nothing. */
export async function cancelProofRun(client: RevylClient, id: string): Promise<void> {
  const path = `${PROOF_RUNS_PATH}/${encodeURIComponent(id)}/cancel`;
  const response = await client.send('POST', path, { retry: true, timeoutMs: CANCEL_TIMEOUT_MS });
  if (response.status < 200 || response.status >= 300) throw proofRunError(response, 'POST', path);
}

/** Whether the run is over: it has settled, or its status is one Revyl never leaves. */
export function isSettled(state: ProofRunState): boolean {
  return state.settledAt !== undefined || TERMINAL_STATUSES.has(state.status);
}

function wireEnvironment(environment: Record<string, ProofEnvironmentValue>): Record<string, { value: string } | { secret_ref: string }> {
  return Object.fromEntries(Object.entries(environment).map(([name, value]) => [name, typeof value === 'string' ? { value } : { secret_ref: value.secretRef }]));
}

function wireState(value: unknown, httpStatus: number, what: string, knownId?: string): ProofRunState {
  const wire = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const id = typeof wire.proof_run_id === 'string' && wire.proof_run_id !== '' ? wire.proof_run_id : knownId;
  if (id === undefined || typeof wire.status !== 'string') {
    throw new VerifyError('API_ERROR', `Revyl returned a proof run to ${what} without an id and status.`, { httpStatus });
  }
  const text = (key: string): string | undefined => (typeof wire[key] === 'string' && wire[key] !== '' ? (wire[key] as string) : undefined);
  const fields: Array<[keyof ProofRunState, string | undefined]> = [
    ['appId', text('app_id')],
    ['platform', text('platform')],
    ['verdict', text('verdict') ?? (VERDICT_STATUSES.has(wire.status) ? wire.status : undefined)],
    ['label', text('display_status_label')],
    ['reportUrl', text('report_url')],
    ['reviewUrl', text('review_url')],
    ['createdAt', text('created_at')],
    ['settledAt', text('settled_at')],
    ['summaryMarkdown', text('summary_markdown')],
  ];
  return { id, status: wire.status, ...Object.fromEntries(fields.filter(([, value]) => value !== undefined)) };
}

function proofRunError(response: RawResponse, method: string, path: string): VerifyError {
  const error = apiError(method, path, response);
  if (error.code === 'EDGE_BLOCKED') return error;
  const { code, message, existingRunIds } = refusal(response);
  const known = code === undefined ? undefined : REFUSALS[code];
  if (!known) return code === undefined ? error : new VerifyError(error.code, `${error.message} (${code})`, { httpStatus: response.status, ...(existingRunIds.length > 0 ? { proofRunIds: existingRunIds } : {}) });
  const refused = `Revyl refused the proof (HTTP ${response.status}, ${code})${message ? `: ${message}` : ''}.`;
  return new VerifyError(known.code, known.hint ? `${refused} ${known.hint}` : refused, {
    httpStatus: response.status,
    ...(existingRunIds.length > 0 ? { proofRunIds: existingRunIds } : {}),
  });
}

function refusal(response: RawResponse): { code?: string; message?: string; existingRunIds: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return { existingRunIds: [] };
  }
  if (typeof parsed !== 'object' || parsed === null) return { existingRunIds: [] };
  const record = parsed as Record<string, unknown>;
  const ids = Array.isArray(record.existing_proof_run_ids) ? record.existing_proof_run_ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  return {
    ...(typeof record.code === 'string' && record.code !== '' ? { code: record.code } : {}),
    ...(typeof record.detail === 'string' && record.detail !== '' ? { message: record.detail.slice(0, 500) } : {}),
    existingRunIds: ids,
  };
}
