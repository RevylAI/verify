import { setTimeout as delay } from 'node:timers/promises';
import { RevylClient } from './api/client.js';
import { cancelProofRun, createProofRuns, getProofRun, isSettled, type ProofAuthBypass, type ProofEnvironmentValue, type ProofHarness, type ProofRunState, type PullRequestContext } from './api/proof-runs.js';
import { missingCredentialsMessage, resolveCredentials } from './auth.js';
import { trackSession, untrackSession } from './cleanup.js';
import { VerifyError, errorMessage } from './errors.js';
import { detectScmIdentity, registerUrlBuild, uploadBuild, validateWebUrl, type UploadBuildResult, type UrlBuildResult } from './upload.js';

export type { ProofAuthBypass, ProofEnvironmentValue, ProofHarness, PullRequestContext };

/** A mobile CI build to prove. */
export interface ProofBuildTarget {
  /** A debug `.apk`, a simulator `.app` bundle, or a `.zip` holding one. */
  build: string;
  /** The Revyl mobile app (UUID) the build belongs to. */
  appId: string;
  /**
   * Launch variables for this target's run, by name. A string is a plain value: Revyl stores it in the run's snapshot and
   * it may appear in reports, so it must not be a secret. `{ secretRef }` uses the organization launch variable of the same
   * name, which holds a secret: its value stays in Revyl, and only a member API key can reference it.
   */
  environment?: Record<string, ProofEnvironmentValue>;
  /**
   * A deep link Revyl opens after the app launches, like `session.auth_bypass.deep_link` in a Revyl config, for example
   * `myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}`. Each `${NAME}` placeholder resolves from this target's
   * `environment` only, on Revyl's side, so a secret's value never reaches the agent, the report, or the logs. A link with
   * placeholders must use the app's own URL scheme, not `http` or `https`. It opens once on each device the agent starts.
   * If the app also gates sign-in on a launch variable such as `REVYL_AUTH_BYPASS_ENABLED`, set it in `environment` too.
   */
  authBypass?: ProofAuthBypass;
  /** A version label unique within the app. Defaults to the short head commit plus a UTC timestamp. */
  version?: string;
  url?: never;
}

/**
 * A Web deployment to prove in a cloud browser: public HTTPS on port 443, that loads signed in or needs no sign-in (URL
 * builds take no headers or basic auth), where any HTTP status of 400 or above fails the page. It must stay up from the
 * call until the run settles, which can take minutes; with `wait: false` keeping it up is yours.
 */
export interface ProofUrlTarget {
  url: string;
  /** The Revyl Web app (UUID). */
  appId: string;
  build?: never;
  environment?: never;
  authBypass?: never;
  version?: never;
}

export type ProofTarget = ProofBuildTarget | ProofUrlTarget;

export interface ProofSettings {
  /** What the agent should focus on. */
  guidance?: string;
  /** The agent that runs the proof. `revyl` is the only one. */
  harness?: ProofHarness;
  /** Block until every run has settled. Defaults to true. */
  wait?: boolean;
  /** How long `wait` blocks before failing with `TIMEOUT`. Defaults to 30 minutes. The runs keep going on Revyl. */
  timeoutMs?: number;
  /** Defaults to REVYL_API_KEY or the Revyl CLI login. */
  token?: string;
  backendUrl?: string;
  /** Aborting it while waiting cancels every run that hasn't settled. */
  signal?: AbortSignal;
}

/**
 * Up to three targets, one per platform, or a single target given inline. Starting the same targets (the same builds and
 * settings) again at the same head returns the earlier runs in whatever state they are in; to prove again, upload a new
 * build or push a new commit.
 */
export type ProofOptions = ProofSettings & ({ targets: ProofTarget[]; build?: never; url?: never; appId?: never; environment?: never; authBypass?: never; version?: never } | (ProofTarget & { targets?: never }));

export interface ProofTargetRun {
  id: string;
  appId: string;
  /** `ios`, `android`, or `web`, as Revyl reports it. */
  platform?: string;
  /** Revyl's run status, as reported. */
  status: string;
  /** `passed`, `failed`, or `inconclusive` once the run settles with a verdict. */
  verdict?: string;
  /**
   * Revyl's `display_status_label` as reported: the label the pull request comment shows, built from the run's write-up
   * and findings, such as `Ready`, `Ready with issues`, or `Partial coverage`. It can differ from what `verdict` suggests.
   */
  label?: string;
  /** The pull request comment with the report. */
  reportUrl?: string;
  reviewUrl?: string;
  createdAt?: string;
  /** Set once the run is over. */
  settledAt?: string;
  build: UploadBuildResult | UrlBuildResult;
}

export interface ProofRun {
  runs: ProofTargetRun[];
  /**
   * Set once every run has a verdict: `failed` if any run failed, otherwise `inconclusive` if any run is inconclusive
   * (a verdict Verify doesn't recognize counts as inconclusive), otherwise `passed`.
   */
  verdict?: 'passed' | 'failed' | 'inconclusive';
  /** The `label` of the first run whose verdict decided `verdict`, as Revyl reported it. */
  label?: string;
  /** The pull request comment with the report, from the first run that has one. */
  reportUrl?: string;
  pullRequest: PullRequestContext;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEEP_LINK_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_TARGETS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const POLL_INTERVALS_MS = [5_000, 10_000, 15_000];

/**
 * Uploads each target's mobile build or registers its Web deployment URL, then starts one Revyl Proof of Changes run
 * per target on the pull request. With `wait` (the default) it polls until every run settles, and cancels the runs
 * still going if the process is interrupted or `signal` aborts. Needs a pull request on GitHub Actions.
 *
 * Revyl reports on the pull request in a comment but adds no check run, so the result is the CI gate: fail the job
 * unless `verdict` is `passed`.
 */
export async function proof(options: ProofOptions): Promise<ProofRun> {
  const targets = proofTargets(options);
  const harness = options.harness ?? 'revyl';
  if (harness !== 'revyl') throw new VerifyError('INVALID_ARGUMENT', "harness must be 'revyl'.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new VerifyError('INVALID_ARGUMENT', 'timeoutMs must be a positive number of milliseconds.');
  const guidance = options.guidance?.trim() || undefined;
  const pullRequest = detectPullRequest();
  const token = options.token ?? (await resolveCredentials())?.token;
  if (!token) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());

  const builds: Array<UploadBuildResult | UrlBuildResult> = [];
  for (const target of targets) {
    const common = { appId: target.appId, token, ...(options.backendUrl !== undefined ? { backendUrl: options.backendUrl } : {}), ...(options.signal !== undefined ? { signal: options.signal } : {}) };
    builds.push(
      target.url !== undefined
        ? await registerUrlBuild({ ...common, url: target.url })
        : await uploadBuild({ ...common, file: target.build, ...(target.version !== undefined ? { version: target.version } : {}) }),
    );
  }
  const platforms = builds.map((build) => build.platform);
  if (new Set(platforms).size !== platforms.length) throw new VerifyError('INVALID_ARGUMENT', `targets must be one per platform; got ${platforms.join(', ')}.`);

  const client = new RevylClient({ token, backendUrl: options.backendUrl });
  const started = await createProofRuns(
    client,
    {
      pullRequest,
      harness,
      ...(guidance ? { guidance } : {}),
      targets: targets.map((target, index) => ({ appId: target.appId, buildId: builds[index]!.buildId, ...(target.environment ? { environment: target.environment } : {}), ...(target.authBypass ? { authBypass: { deepLink: target.authBypass.deepLink } } : {}) })),
    },
    options.signal,
  );
  const current = await Promise.all(started.map(async (state) => (isSettled(state) ? withIdentity(await getProofRun(client, state.id, options.signal), state) : state)));
  const states = options.wait === false ? current : await waitForAll(client, current, timeoutMs, options.signal);
  const runs = states.map((state, index): ProofTargetRun => ({ ...state, appId: state.appId ?? targets[index]!.appId, build: builds[index]! }));
  return { runs, ...overallVerdict(runs), ...(runs.find((run) => run.reportUrl)?.reportUrl ? { reportUrl: runs.find((run) => run.reportUrl)!.reportUrl! } : {}), pullRequest };
}

function proofTargets(options: ProofOptions): ProofTarget[] {
  const inline = options.build !== undefined || options.url !== undefined;
  if (options.targets !== undefined && inline) throw new VerifyError('INVALID_ARGUMENT', 'Pass targets, or a single build or url with appId, not both.');
  const targets: ProofTarget[] = options.targets ?? (inline ? [options as ProofTarget] : []);
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
    throw new VerifyError('INVALID_ARGUMENT', `proof() needs 1 to ${MAX_TARGETS} targets, one per platform.`);
  }
  for (const target of targets) {
    if ((target.url !== undefined) === (target.build !== undefined)) throw new VerifyError('INVALID_ARGUMENT', 'Each target takes either build (a mobile artifact) or url (a Web deployment), not both.');
    if (typeof target.appId !== 'string' || !UUID.test(target.appId)) throw new VerifyError('INVALID_ARGUMENT', 'Each target needs an appId that is a Revyl app id (a UUID).');
    if (target.url !== undefined) validateWebUrl(target.url);
    if (target.url !== undefined && target.environment !== undefined) throw new VerifyError('INVALID_ARGUMENT', 'environment applies only to mobile builds; a URL target takes no launch variables.');
    if (target.url !== undefined && target.version !== undefined) throw new VerifyError('INVALID_ARGUMENT', 'version applies only to mobile builds.');
    if (target.url !== undefined && target.authBypass !== undefined) throw new VerifyError('INVALID_ARGUMENT', 'authBypass applies only to mobile builds; a URL target takes no deep link.');
    validEnvironment(target.environment);
    validAuthBypass(target.authBypass, target.environment);
  }
  if (new Set(targets.map((target) => target.appId)).size !== targets.length) throw new VerifyError('INVALID_ARGUMENT', 'Each target needs its own appId, one per platform.');
  if (targets.filter((target) => target.url !== undefined).length > 1) throw new VerifyError('INVALID_ARGUMENT', 'targets take at most one url: one target per platform.');
  return targets.map((target) => ({ ...target, ...(target.environment && Object.keys(target.environment).length === 0 ? { environment: undefined } : {}) }) as ProofTarget);
}

function overallVerdict(runs: ProofTargetRun[]): Pick<ProofRun, 'verdict' | 'label'> {
  if (runs.some((run) => run.verdict === undefined)) return {};
  const decide = (verdict: string | undefined) => (verdict === 'failed' ? 'failed' : verdict === 'passed' ? 'passed' : 'inconclusive');
  const verdict = runs.some((run) => run.verdict === 'failed') ? 'failed' : runs.some((run) => decide(run.verdict) === 'inconclusive') ? 'inconclusive' : 'passed';
  const label = runs.find((run) => decide(run.verdict) === verdict)?.label;
  return { verdict, ...(label ? { label } : {}) };
}

async function waitForAll(client: RevylClient, started: ProofRunState[], timeoutMs: number, signal: AbortSignal | undefined): Promise<ProofRunState[]> {
  const deadline = Date.now() + timeoutMs;
  const states = [...started];
  const unsettled = () => states.filter((state) => !isSettled(state));
  const cancelUnsettled = async () => {
    await Promise.all(unsettled().map((state) => cancelProofRun(client, state.id)));
  };
  const tracked = { target: `Proof of Changes run${states.length > 1 ? 's' : ''} ${states.map((state) => state.id).join(', ')}`, close: cancelUnsettled };
  trackSession(tracked);
  try {
    for (let poll = 0; unsettled().length > 0; poll += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new VerifyError('TIMEOUT', `Proof of Changes had no verdict for ${unsettled().map((state) => state.id).join(', ')} after ${Math.round(timeoutMs / 1000)} s. The runs keep going on Revyl.${where(states)}`);
      }
      await delay(Math.min(POLL_INTERVALS_MS[poll] ?? POLL_INTERVALS_MS.at(-1)!, remaining), undefined, { signal });
      for (const [index, state] of states.entries()) {
        if (!isSettled(state)) states[index] = withIdentity(await getProofRun(client, state.id, signal), state);
      }
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    try {
      await cancelUnsettled();
    } catch (cancelError) {
      throw new VerifyError('API_ERROR', `Proof of Changes was interrupted, but cancelling its runs failed: ${errorMessage(cancelError)}`, { cause: cancelError });
    }
    throw signal.reason;
  } finally {
    untrackSession(tracked);
  }
  const ended = states.filter((state) => state.verdict === undefined);
  if (ended.length > 0) {
    throw new VerifyError('PROOF_RUN_ENDED', `Proof of Changes run ${ended.map((state) => `${state.id} (${state.label ?? state.status})`).join(', ')} ended without a verdict.${where(states)}`);
  }
  return states;
}

function withIdentity(state: ProofRunState, known: ProofRunState): ProofRunState {
  return { ...state, ...(known.appId ? { appId: known.appId } : {}), ...(known.platform ? { platform: known.platform } : {}) };
}

function detectPullRequest(): PullRequestContext {
  const identity = detectScmIdentity();
  if (identity?.ciSystem !== 'github-actions' || identity.pr === undefined) {
    throw new VerifyError('PR_CONTEXT_MISSING', 'proof() needs a pull_request event on GitHub Actions to know the repository, pull request, and head commit.');
  }
  return { provider: 'github', repository: identity.repository, number: identity.pr, headSha: identity.commit, ...(identity.baseCommit ? { baseSha: identity.baseCommit } : {}) };
}

function where(states: ProofRunState[]): string {
  const url = states.map((state) => state.reportUrl ?? state.reviewUrl).find(Boolean);
  return url ? ` See ${url}` : '';
}

function validEnvironment(environment: Record<string, ProofEnvironmentValue> | undefined): void {
  if (environment === undefined) return;
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) throw new VerifyError('INVALID_ARGUMENT', 'environment must map variable names to values or { secretRef } references.');
  for (const [name, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_NAME.test(name)) throw new VerifyError('INVALID_ARGUMENT', 'environment has an invalid variable name: use letters, digits, and underscores, not starting with a digit.');
    if (typeof value === 'string') continue;
    if (typeof value !== 'object' || value === null || typeof value.secretRef !== 'string') throw new VerifyError('INVALID_ARGUMENT', `environment variable ${name} must be a string or { secretRef: '${name}' }.`);
    if (value.secretRef !== name) throw new VerifyError('INVALID_ARGUMENT', `environment variable ${name} must reference the launch variable of the same name: { secretRef: '${name}' }.`);
  }
}

function validAuthBypass(authBypass: ProofAuthBypass | undefined, environment: Record<string, ProofEnvironmentValue> | undefined): void {
  if (authBypass === undefined) return;
  if (typeof authBypass !== 'object' || authBypass === null || typeof authBypass.deepLink !== 'string' || authBypass.deepLink.trim() === '') {
    throw new VerifyError('INVALID_ARGUMENT', 'authBypass must be { deepLink: string } with a non-empty deep link.');
  }
  const placeholders = [...authBypass.deepLink.matchAll(DEEP_LINK_PLACEHOLDER)].map((match) => match[1]!);
  if (placeholders.length > 0 && /^\s*https?:/i.test(authBypass.deepLink)) {
    throw new VerifyError('INVALID_ARGUMENT', "authBypass.deepLink has placeholders, so it must use the app's own URL scheme, not http or https.");
  }
  const missing = placeholders.filter((name) => environment?.[name] === undefined);
  if (missing.length > 0) {
    throw new VerifyError('INVALID_ARGUMENT', `authBypass.deepLink uses ${[...new Set(missing)].map((name) => '${' + name + '}').join(', ')}, which the target's environment doesn't set. Placeholders resolve only from the target's environment.`);
  }
}
