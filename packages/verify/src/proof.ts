import { setTimeout as delay } from 'node:timers/promises';
import { RevylClient } from './api/client.js';
import { cancelProofRun, createProofRun, getProofRun, type ProofEnvironmentValue, type ProofHarness, type ProofRunState, type PullRequestContext } from './api/proof-runs.js';
import { missingCredentialsMessage, resolveCredentials } from './auth.js';
import { trackSession, untrackSession } from './cleanup.js';
import { VerifyError, errorMessage } from './errors.js';
import { detectScmIdentity, registerUrlBuild, uploadBuild, type UploadBuildResult, type UrlBuildResult } from './upload.js';

export type { ProofEnvironmentValue, ProofHarness, PullRequestContext };

interface ProofSettings {
  /** The Revyl app (UUID): a mobile app for `build`, a Web app for `url`. */
  appId: string;
  /** What the agent should focus on. */
  guidance?: string;
  /** The agent that runs the proof. Defaults to `revyl`. */
  harness?: ProofHarness;
  /**
   * Launch variables for this run, by name. A string is a plain value: Revyl stores it in the run's snapshot and it may
   * appear in reports, so it must not be a secret. `{ secretRef }` names an organization launch variable that holds a secret.
   */
  environment?: Record<string, ProofEnvironmentValue>;
  /** Block until the run has a verdict. Defaults to true. */
  wait?: boolean;
  /** How long `wait` blocks before failing with `TIMEOUT`. Defaults to 30 minutes. The run keeps going on Revyl. */
  timeoutMs?: number;
  /** A version label unique within the app. Defaults to the short head commit plus a UTC timestamp. */
  version?: string;
  /** Defaults to REVYL_API_KEY or the Revyl CLI login. */
  token?: string;
  backendUrl?: string;
  /** Aborting it while waiting cancels the run. */
  signal?: AbortSignal;
}

export type ProofOptions =
  | (ProofSettings & {
      /** The CI build to prove: a debug `.apk`, a simulator `.app` bundle, or a `.zip` holding one. */
      build: string;
      url?: never;
    })
  | (Omit<ProofSettings, 'environment' | 'version'> & {
      /**
       * A deployment to prove in a cloud browser: public HTTPS on port 443, that loads signed in or needs no sign-in
       * (URL builds take no headers or basic auth), where any HTTP status of 400 or above fails the page. It must stay
       * up from the call until the run settles, which can take minutes; with `wait: false` keeping it up is yours.
       * The same build at the same head commit returns the earlier run, so a stable hostname reuses it.
       */
      url: string;
      build?: never;
      environment?: never;
      version?: never;
    });

export interface ProofRun {
  id: string;
  /** Revyl's run status, as reported. */
  status: string;
  /** `passed`, `failed`, or `inconclusive` once the run settles with a verdict. */
  verdict?: string;
  /** Revyl's display label, such as `Ready`, `Ready with polish`, `Ready with issues`, `Failed`, or `Partial coverage`. */
  label?: string;
  /** The pull request comment with the report. */
  reportUrl?: string;
  reviewUrl?: string;
  createdAt?: string;
  /** Set once the run is over. */
  settledAt?: string;
  pullRequest: PullRequestContext;
  build: UploadBuildResult | UrlBuildResult;
}

const HARNESSES = new Set<ProofHarness>(['revyl', 'cursor', 'capy', 'devin']);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const POLL_INTERVALS_MS = [5_000, 10_000, 15_000];

/**
 * Uploads a pull request's CI build, or registers its deployment URL, and starts a Revyl Proof of Changes run on it. With `wait` (the default) it
 * polls until the run has a verdict, and cancels the run if the process is interrupted or `signal` aborts.
 * Needs a pull request on GitHub Actions.
 */
export async function proof(options: ProofOptions): Promise<ProofRun> {
  const web = options.url !== undefined;
  if (web === (options.build !== undefined)) throw new VerifyError('INVALID_ARGUMENT', 'Pass either build (a mobile artifact) or url (a Web deployment), not both.');
  if (web && options.environment !== undefined) throw new VerifyError('INVALID_ARGUMENT', 'environment applies only to mobile builds; a URL build takes no launch variables.');
  if (web && options.version !== undefined) throw new VerifyError('INVALID_ARGUMENT', 'version applies only to mobile builds.');
  const harness = options.harness ?? 'revyl';
  if (!HARNESSES.has(harness)) throw new VerifyError('INVALID_ARGUMENT', `harness must be one of ${[...HARNESSES].join(', ')}.`);
  const environment = validEnvironment(options.environment);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new VerifyError('INVALID_ARGUMENT', 'timeoutMs must be a positive number of milliseconds.');
  const guidance = options.guidance?.trim() || undefined;
  const pullRequest = detectPullRequest();
  const token = options.token ?? (await resolveCredentials())?.token;
  if (!token) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());

  const target = { appId: options.appId, token, ...(options.backendUrl !== undefined ? { backendUrl: options.backendUrl } : {}), ...(options.signal !== undefined ? { signal: options.signal } : {}) };
  const build = options.url !== undefined
    ? await registerUrlBuild({ ...target, url: options.url })
    : await uploadBuild({ ...target, file: options.build, ...(options.version !== undefined ? { version: options.version } : {}) });
  const client = new RevylClient({ token, backendUrl: options.backendUrl });
  const started = await createProofRun(
    client,
    { appId: options.appId, buildId: build.buildId, pullRequest, harness, ...(guidance ? { guidance } : {}), ...(environment ? { environment } : {}) },
    options.signal,
  );
  const run = (state: ProofRunState): ProofRun => ({ ...state, pullRequest, build });
  if (options.wait === false) return run(started);
  return run(await waitForVerdict(client, started, timeoutMs, options.signal));
}

async function waitForVerdict(client: RevylClient, started: ProofRunState, timeoutMs: number, signal: AbortSignal | undefined): Promise<ProofRunState> {
  const deadline = Date.now() + timeoutMs;
  const tracked = { target: `Proof of Changes run ${started.id}`, close: () => cancelProofRun(client, started.id) };
  trackSession(tracked);
  try {
    let state = started;
    for (let poll = 0; ; poll += 1) {
      if (state.settledAt !== undefined) {
        if (state.verdict !== undefined) return state;
        throw new VerifyError('PROOF_RUN_ENDED', `Proof of Changes run ${state.id} ended without a verdict (${state.label ?? state.status}).${where(state)}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new VerifyError('TIMEOUT', `Proof of Changes run ${state.id} had no verdict after ${Math.round(timeoutMs / 1000)} s. It keeps running on Revyl.${where(state)}`);
      }
      await delay(Math.min(POLL_INTERVALS_MS[poll] ?? POLL_INTERVALS_MS.at(-1)!, remaining), undefined, { signal });
      state = await getProofRun(client, state.id, signal);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    try {
      await cancelProofRun(client, started.id);
    } catch (cancelError) {
      throw new VerifyError('API_ERROR', `Proof of Changes run ${started.id} was interrupted, but cancelling it failed: ${errorMessage(cancelError)}`, { cause: cancelError });
    }
    throw signal.reason;
  } finally {
    untrackSession(tracked);
  }
}

function detectPullRequest(): PullRequestContext {
  const identity = detectScmIdentity();
  if (identity?.ciSystem !== 'github-actions' || identity.pr === undefined) {
    throw new VerifyError('PR_CONTEXT_MISSING', 'proof() needs a pull_request event on GitHub Actions to know the repository, pull request, and head commit.');
  }
  return { provider: 'github', repository: identity.repository, number: identity.pr, headSha: identity.commit, ...(identity.baseCommit ? { baseSha: identity.baseCommit } : {}) };
}

function where(state: ProofRunState): string {
  const url = state.reportUrl ?? state.reviewUrl;
  return url ? ` See ${url}` : '';
}

function validEnvironment(environment: Record<string, ProofEnvironmentValue> | undefined): Record<string, ProofEnvironmentValue> | undefined {
  if (environment === undefined) return undefined;
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) throw new VerifyError('INVALID_ARGUMENT', 'environment must map variable names to values or { secretRef } references.');
  for (const [name, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_NAME.test(name)) throw new VerifyError('INVALID_ARGUMENT', 'environment has an invalid variable name: use letters, digits, and underscores, not starting with a digit.');
    const isReference = typeof value === 'object' && value !== null && typeof value.secretRef === 'string' && value.secretRef.trim() !== '';
    if (typeof value !== 'string' && !isReference) throw new VerifyError('INVALID_ARGUMENT', `environment variable ${name} must be a string or { secretRef: '<launch variable name>' }.`);
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}
