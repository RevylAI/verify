import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse as parseYaml } from 'yaml';
import type { RawResponse } from './api/client.js';
import type { Platform } from './api/types.js';
import { VerifyError, isVerifyError, type RefusalReason } from './errors.js';

/** How a session profile run ended, as Revyl reports it. */
export type SessionProfileOutcome = 'succeeded' | 'script_failed' | 'script_timed_out' | 'script_unavailable' | 'output_invalid' | 'runner_failed';

/** The session_profile fields a start or create request carries. */
export interface SessionProfileFields {
  session_profile: { instruction: 'named'; name: string } | { instruction: 'none' };
  session_profile_source?: { project_id: string; git_branch_name?: string };
  session_profile_files?: {
    script: string;
    requires_repository_checkout?: true;
    script_file?: { project_relative_path: string; content: string };
  };
}

/** What open() sends for a session profile, and the name it waits on. name is undefined for profile 'none'. */
export interface SessionProfilePlan {
  name?: string;
  configPath?: string;
  fields: SessionProfileFields;
}

/** The session_profile object a start response or session report carries. */
export interface ReportedSessionProfile {
  name: string;
  status: string;
  outcome?: string;
  failureReason?: string;
  missingGitBranchName?: string;
}

const NONE = 'none';
const PROFILE_NAME = /^[a-z0-9-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRIPT_EXTENSIONS = ['.js', '.py', '.sh', '.ts'];
const SCRIPT_MAX_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 64 * 1024;
const GITHUB_EVENT_LIMIT = 1024 * 1024;
const BRANCH_NAME_LIMIT = 4096;
const INVALID_UTF8_BRANCH = 'invalid-utf8'.repeat(24);
const GIT_ENV_DROPPED = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_OPTIONAL_LOCKS', 'GIT_SSH', 'GIT_SSH_COMMAND']);
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=3 -oConnectionAttempts=1' };
const REPOSITORY_RETRY_DELAYS_MS = [1_000, 2_000];
const PROFILE_PLATFORMS = new Set<Platform>(['web', 'ios', 'android', 'mac']);
const NONE_HINT = "profile: 'none'";

/**
 * Plans the session profile open() sends: profile 'none', an explicit name, or the project's session.default_profile
 * when profile is undefined. Undefined when nothing is sent. Reads .revyl/config.yaml at or above cwd.
 */
export async function planSessionProfile(profile: unknown, platform: Platform, cwd: string): Promise<SessionProfilePlan | undefined> {
  if (profile !== undefined && (typeof profile !== 'string' || (profile !== NONE && !PROFILE_NAME.test(profile)))) {
    throw new VerifyError('INVALID_ARGUMENT', "open(): profile must be a session profile name from session.profiles in .revyl/config.yaml (1-64 lowercase letters, digits or hyphens), or 'none'.");
  }
  if (!PROFILE_PLATFORMS.has(platform)) {
    if (profile === undefined) return undefined;
    throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `open(): session profiles run on web, iOS, Android and Mac sessions, not ${platform}. Leave out profile.`);
  }
  if (profile === NONE) return { fields: { session_profile: { instruction: 'none' } } };
  const configPath = findConfig(cwd);
  if (!configPath) {
    if (profile === undefined) return undefined;
    throw new VerifyError('CONFIG_NOT_FOUND', `open(): profile '${profile}' needs .revyl/config.yaml, but none was found in ${resolve(cwd)} or any folder above it. Run open() from your app's checkout, or pass ${NONE_HINT}.`);
  }
  const config = readConfig(configPath);
  const session = config.session;
  let name = profile as string | undefined;
  if (name === undefined) {
    const fallback = session?.default_profile;
    if (fallback === undefined || fallback === null || fallback === NONE) return undefined;
    if (typeof fallback !== 'string') throw new VerifyError('CONFIG_INVALID', `${configPath}: session.default_profile must be a profile name, or none.`);
    name = fallback;
  }
  const projectId = config.project?.id;
  if (typeof projectId !== 'string' || !UUID.test(projectId)) {
    throw new VerifyError('CONFIG_INVALID', `${configPath}: project.id must be your Revyl project's UUID, which session profile "${name}" needs. Run open() from your app's checkout, whose .revyl/config.yaml has project.id, or pass ${NONE_HINT}.`);
  }
  const profiles = session?.profiles;
  if (profiles !== undefined && profiles !== null && !isMapping(profiles)) throw new VerifyError('CONFIG_INVALID', `${configPath}: session.profiles must be a mapping of profile names.`);
  const entry = profiles ? profiles[name] : undefined;
  if (entry === undefined) {
    const defined = profiles ? Object.keys(profiles).sort() : [];
    throw new VerifyError('CONFIG_INVALID', `${configPath}: session.profiles doesn't define "${name}". Defined: ${defined.length ? defined.join(', ') : 'none'}. Pass one of those, or ${NONE_HINT}.`);
  }
  if (!isMapping(entry) || typeof entry.script !== 'string' || entry.script.trim() === '') {
    throw new VerifyError('CONFIG_INVALID', `${configPath}: session.profiles.${name}.script must be a non-empty string.`);
  }
  const requiresCheckout = entry.requires_repository_checkout;
  if (requiresCheckout !== undefined && requiresCheckout !== null && typeof requiresCheckout !== 'boolean') {
    throw new VerifyError('CONFIG_INVALID', `${configPath}: session.profiles.${name}.requires_repository_checkout must be true or false.`);
  }
  const projectRoot = dirname(dirname(configPath));
  const files = checkoutFiles(name, entry.script, requiresCheckout === true, projectRoot, configPath);
  const branch = await gitBranch(projectRoot);
  return {
    name,
    configPath,
    fields: {
      session_profile: { instruction: 'named', name },
      session_profile_source: { project_id: projectId, ...(branch ? { git_branch_name: branch } : {}) },
      session_profile_files: files,
    },
  };
}

function findConfig(cwd: string): string | undefined {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    const candidate = join(current, '.revyl', 'config.yaml');
    if (existsSync(candidate)) return candidate;
    if (dirname(current) === current) return undefined;
  }
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConfig(configPath: string): { project?: Mapping; session?: Mapping & { profiles?: unknown; default_profile?: unknown } } {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (error) {
    const line = (error as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    throw new VerifyError('CONFIG_INVALID', `${configPath}${line ? ` line ${line}` : ''}: is not valid YAML.`);
  }
  if (!isMapping(parsed)) throw new VerifyError('CONFIG_INVALID', `${configPath}: must be a YAML mapping.`);
  const project = parsed.project;
  const session = parsed.session;
  if (project !== undefined && project !== null && !isMapping(project)) throw new VerifyError('CONFIG_INVALID', `${configPath}: project must be a mapping.`);
  if (session !== undefined && session !== null && !isMapping(session)) throw new VerifyError('CONFIG_INVALID', `${configPath}: session must be a mapping.`);
  return { ...(isMapping(project) ? { project } : {}), ...(isMapping(session) ? { session } : {}) };
}

/** The profile's definition and script file as the checkout has them, uncommitted changes included, as the Revyl CLI's CheckoutFiles builds them. */
function checkoutFiles(name: string, script: string, requiresCheckout: boolean, projectRoot: string, configPath: string): NonNullable<SessionProfileFields['session_profile_files']> {
  const files: NonNullable<SessionProfileFields['session_profile_files']> = { script, ...(requiresCheckout ? { requires_repository_checkout: true as const } : {}) };
  const unavailable = (reason: string) =>
    new VerifyError('SESSION_PROFILE_FAILED', `session profile "${name}": ${reason}. Fix session.profiles.${name}.script in ${configPath}, or pass ${NONE_HINT}.`, { outcome: 'script_unavailable', failureReason: reason });
  let filePath: string;
  let relativePath: string;
  if (script.includes('/')) {
    filePath = resolveRepositoryPath(projectRoot, script, unavailable);
    relativePath = cleanPath(script);
  } else {
    if (script.trim() !== script || script.includes('\\')) return files;
    const found = findRepositoryScript(join(dirname(configPath), 'scripts'), script, unavailable);
    if (!found) return files;
    filePath = found;
    relativePath = '.revyl/scripts/' + found.slice(found.lastIndexOf(sep) + 1);
  }
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch {
    throw unavailable(`could not read script ${relativePath}`);
  }
  if (content.length > SCRIPT_MAX_BYTES) throw unavailable(`script ${relativePath} is ${content.length} bytes, over the ${SCRIPT_MAX_BYTES} Revyl takes`);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw unavailable(`script ${relativePath} isn't UTF-8 text`);
  }
  return { ...files, script_file: { project_relative_path: relativePath, content: text } };
}

function cleanPath(path: string): string {
  const cleaned = posix.normalize(path);
  return cleaned.length > 1 && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
}

function resolveRepositoryPath(projectRoot: string, ref: string, unavailable: (reason: string) => VerifyError): string {
  let realRoot: string;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    throw unavailable(`could not resolve the project root for script ${ref}`);
  }
  const repositoryRoot = repositoryRootOf(realRoot);
  let realScript: string;
  try {
    realScript = realpathSync(join(realRoot, ...ref.split('/')));
  } catch {
    throw unavailable(`script ${ref} was not found in the repository`);
  }
  if (realScript !== repositoryRoot && !realScript.startsWith(repositoryRoot + sep)) throw unavailable(`script ${ref} resolves outside the repository`);
  let info;
  try {
    info = statSync(realScript);
  } catch {
    throw unavailable(`script ${ref} could not be read`);
  }
  if (!info.isFile()) throw unavailable(`script ${ref} is not a regular file`);
  if (process.platform !== 'win32' && (info.mode & 0o111) === 0) throw unavailable(`script ${ref} is not executable (chmod +x it)`);
  return realScript;
}

function repositoryRootOf(projectRoot: string): string {
  for (let current = projectRoot; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return projectRoot;
  }
}

function findRepositoryScript(scriptsDir: string, name: string, unavailable: (reason: string) => VerifyError): string | undefined {
  const matches: string[] = [];
  for (const extension of SCRIPT_EXTENSIONS) {
    const path = join(scriptsDir, name + extension);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unavailable(`.revyl/scripts/${name}${extension} is not a readable regular file`);
    }
    if (!info.isFile()) throw unavailable(`.revyl/scripts/${name}${extension} is not a readable regular file`);
    matches.push(path);
  }
  if (matches.length > 1) throw unavailable(`.revyl/scripts holds more than one file named ${name}; keep one`);
  return matches[0];
}

/**
 * The Git branch the Revyl CLI would send from this checkout, ported from DetectGitBranch with a work directory in
 * revyl-cli/internal/buildselection/git_branch.go: GitHub Actions' or Buildkite's branch when the checkout is the code CI
 * built, otherwise the checked-out branch. Every Git call shares one 5-second budget.
 */
async function gitBranch(projectRoot: string): Promise<string | undefined> {
  const deadline = Date.now() + GIT_TIMEOUT_MS;
  const checkout = await readCheckout((...args) => runGit(projectRoot, deadline, args));
  let detected: { name: string } | undefined;
  if (checkout) {
    detected = detectCIBranch(checkout);
    if (!detected && checkout.branch && !syntheticGitHubBranch(checkout.branch)) detected = branchCandidate(checkout.branch);
  } else if (Date.now() < deadline) {
    detected = detectCIBranch(undefined);
  }
  return detected?.name || undefined;
}

interface Checkout {
  branch: string;
  head: string;
  repository: string;
  parents: string[];
}

const env = (key: string): string => process.env[key] ?? '';

function runGit(dir: string, deadline: number, args: string[]): Promise<{ ok: boolean; stdout: Buffer }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ ok: false, stdout: Buffer.alloc(0) });
  const childEnv: NodeJS.ProcessEnv = { ...GIT_ENV };
  for (const [key, value] of Object.entries(process.env)) if (!GIT_ENV_DROPPED.has(key) && !(key in childEnv)) childEnv[key] = value;
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (ok: boolean) => resolvePromise({ ok, stdout: Buffer.concat(chunks) });
    try {
      const child = spawn('git', ['-C', dir, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'], timeout: remaining, windowsHide: true });
      child.stdout.on('data', (chunk: Buffer) => {
        const kept = chunk.subarray(0, GIT_OUTPUT_LIMIT - size);
        if (kept.length) chunks.push(kept);
        size += kept.length;
      });
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

async function readCheckout(git: (...args: string[]) => Promise<{ ok: boolean; stdout: Buffer }>): Promise<Checkout | undefined> {
  const inside = await git('rev-parse', '--is-inside-work-tree');
  if (!inside.ok || inside.stdout.toString('utf8').trim() !== 'true') return undefined;
  const checkout: Checkout = { branch: '', head: '', repository: '', parents: [] };
  const ref = await git('symbolic-ref', '--quiet', 'HEAD');
  const heads = Buffer.from('refs/heads/');
  if (ref.ok && ref.stdout.subarray(0, heads.length).equals(heads)) {
    let end = ref.stdout.length;
    while (end > heads.length && (ref.stdout[end - 1] === 0x0a || ref.stdout[end - 1] === 0x0d)) end -= 1;
    try {
      checkout.branch = new TextDecoder('utf-8', { fatal: true }).decode(ref.stdout.subarray(heads.length, end));
    } catch {
      checkout.branch = INVALID_UTF8_BRANCH;
    }
  }
  if (checkout.branch && env('GITHUB_ACTIONS') !== 'true' && env('BUILDKITE') !== 'true') return checkout;
  checkout.head = (await git('rev-parse', '--verify', 'HEAD')).stdout.toString('utf8').trim();
  checkout.repository = normalizeRepository((await git('remote', 'get-url', 'origin')).stdout.toString('utf8'));
  if (env('GITHUB_ACTIONS') === 'true' && env('GITHUB_REF').startsWith('refs/pull/')) {
    for (const line of (await git('cat-file', '-p', 'HEAD')).stdout.toString('utf8').split('\n')) {
      if (line === '') break;
      if (line.startsWith('parent ')) checkout.parents.push(line.slice('parent '.length));
    }
  }
  return checkout;
}

function syntheticGitHubBranch(branch: string): boolean {
  if (env('GITHUB_ACTIONS') !== 'true' || !env('GITHUB_REF').startsWith('refs/pull/')) return false;
  return branch === env('GITHUB_REF_NAME') || branch === env('GITHUB_REF');
}

/** A detected branch: undefined when CI and the checkout name none; name '' when CI owns the answer but has no usable name. */
function detectCIBranch(checkout: Checkout | undefined): { name: string } | undefined {
  if (env('GITHUB_ACTIONS') === 'true') return detectGitHubBranch(checkout);
  if (env('BUILDKITE') === 'true') return detectBuildkiteBranch(checkout);
  return undefined;
}

function detectGitHubBranch(checkout: Checkout | undefined): { name: string } | undefined {
  const event = readBranchEvent(env('GITHUB_EVENT_PATH'));
  const repository = normalizeRepository(env('GITHUB_REPOSITORY'));
  if (!repository) return undefined;
  const pr = event.pullRequest;
  if (pr.headRef && pr.headSha) {
    const baseRepository = normalizeRepository(pr.baseRepository);
    const headRepository = normalizeRepository(pr.headRepository);
    if (baseRepository !== repository || !headRepository) return undefined;
    if (checkout) {
      if (checkout.branch && checkout.branch !== pr.headRef && !syntheticGitHubBranch(checkout.branch)) return undefined;
      if (checkout.repository !== baseRepository && checkout.repository !== headRepository) return undefined;
      const ref = env('GITHUB_REF');
      const mergeCheckout = ref.startsWith('refs/pull/') && ref.endsWith('/merge') && sameCommit(checkout.head, env('GITHUB_SHA')) && checkout.parents.some((parent) => sameCommit(parent, pr.headSha));
      if (!sameCommit(checkout.head, pr.headSha) && !mergeCheckout) return undefined;
    }
    return pullRequestHeadBranch(pr.headRef, pr.headRepository, headRepository !== baseRepository);
  }
  if (checkout?.branch) return undefined;
  const ref = env('GITHUB_REF');
  if (env('GITHUB_HEAD_REF') || env('GITHUB_REF_TYPE') === 'tag' || !ref.startsWith('refs/heads/')) return undefined;
  if (checkout && (checkout.repository !== repository || !sameCommit(checkout.head, env('GITHUB_SHA')))) return undefined;
  return branchCandidate(ref.slice('refs/heads/'.length));
}

function detectBuildkiteBranch(checkout: Checkout | undefined): { name: string } | undefined {
  if (env('BUILDKITE_TAG')) return undefined;
  let repositoryUrl = env('BUILDKITE_REPO');
  const pipelineRepository = normalizeRepository(repositoryUrl);
  if (!pipelineRepository) return undefined;
  let repository = pipelineRepository;
  const review = env('BUILDKITE_PULL_REQUEST');
  const reviewed = /^[+-]?[0-9]+$/.test(review) && BigInt(review) > 0n && BigInt(review) <= 9223372036854775807n;
  if (reviewed && env('BUILDKITE_PULL_REQUEST_REPO')) {
    repositoryUrl = env('BUILDKITE_PULL_REQUEST_REPO');
    repository = normalizeRepository(repositoryUrl);
    if (!repository) return undefined;
  }
  const fork = repository !== pipelineRepository;
  const commit = env('BUILDKITE_PULL_REQUEST_HEAD_COMMIT') || env('BUILDKITE_COMMIT');
  let branch = env('BUILDKITE_BRANCH');
  if (fork && branch.includes(':')) branch = branch.slice(branch.indexOf(':') + 1);
  if (checkout) {
    if (checkout.repository !== repository || !sameCommit(checkout.head, commit)) return undefined;
    if (checkout.branch && checkout.branch !== branch) return undefined;
  }
  if (reviewed) return pullRequestHeadBranch(branch, repositoryUrl, fork);
  if (checkout?.branch) return undefined;
  return branchCandidate(branch);
}

/** A pull request's own branch, as owner:branch for a fork. A verified pull request without a usable name still answers. */
function pullRequestHeadBranch(branch: string, headRepository: string, fork: boolean): { name: string } {
  if (!branch) return { name: '' };
  if (!fork) return branchCandidate(branch) ?? { name: '' };
  const owner = repositoryNamespace(headRepository);
  return owner ? (branchCandidate(owner + ':' + branch) ?? { name: '' }) : { name: '' };
}

function branchCandidate(name: string): { name: string } | undefined {
  if (!name) return undefined;
  const codePoints = [...name];
  return { name: codePoints.length <= BRANCH_NAME_LIMIT ? name : codePoints.slice(0, BRANCH_NAME_LIMIT).join('') };
}

interface BranchEvent {
  pullRequest: { headRef: string; headSha: string; headRepository: string; baseRepository: string };
}

const EVENT_SHAPE = {
  number: 'int',
  ref: 'string',
  after: 'string',
  repository: { full_name: 'string' },
  pull_request: { number: 'int', head: { sha: 'string', ref: 'string', repo: { full_name: 'string' } }, base: { repo: { full_name: 'string' } } },
} as const;
type EventShape = 'int' | 'string' | { readonly [key: string]: EventShape };

/** The GitHub event, or an empty one when it's missing, over 1 MiB, or any field it reads has the wrong JSON type. */
function readBranchEvent(path: string): BranchEvent {
  const empty: BranchEvent = { pullRequest: { headRef: '', headSha: '', headRepository: '', baseRepository: '' } };
  let event: unknown;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > GITHUB_EVENT_LIMIT) return empty;
    const data = readFileSync(path);
    if (data.length > GITHUB_EVENT_LIMIT) return empty;
    event = JSON.parse(data.toString('utf8'));
  } catch {
    return empty;
  }
  const fits = (value: unknown, shape: EventShape): boolean => {
    if (value === null) return true;
    if (shape === 'string') return typeof value === 'string';
    if (shape === 'int') return Number.isSafeInteger(value);
    return isMapping(value) && Object.entries(shape).every(([key, inner]) => !Object.hasOwn(value, key) || fits(value[key], inner));
  };
  if (!isMapping(event) || !fits(event, EVENT_SHAPE)) return empty;
  const text = (...keys: string[]): string => {
    let value: unknown = event;
    for (const key of keys) value = isMapping(value) ? value[key] : undefined;
    return typeof value === 'string' ? value : '';
  };
  return {
    pullRequest: {
      headRef: text('pull_request', 'head', 'ref'),
      headSha: text('pull_request', 'head', 'sha'),
      headRepository: text('pull_request', 'head', 'repo', 'full_name'),
      baseRepository: text('pull_request', 'base', 'repo', 'full_name'),
    },
  };
}

/** A repository reference (owner/name, an HTTPS URL or an SSH remote) as its lowercase host and its path, parsed as Go's net/url does. */
function parseRepository(input: string): { host: string; path: string } | undefined {
  let value = input.trim();
  if (!value) return undefined;
  if (value.startsWith('git@') && value.includes(':')) value = 'ssh://' + value.replace(':', '/');
  if (!value.includes('://')) {
    if (value.split('/').length !== 2 || value.startsWith('.')) return undefined;
    value = 'https://github.com/' + value;
  }
  const rest = value.slice(value.indexOf('://') + 3);
  const [beforeFragment = '', ...fragment] = rest.split('#');
  const [target = '', ...query] = beforeFragment.split('?');
  if (fragment.join('#') || query.join('?')) return undefined;
  const slash = target.indexOf('/');
  const authority = slash >= 0 ? target.slice(0, slash) : target;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const hostParts = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(host);
  if (!hostParts || hostParts[1] === '' || hostParts[1] === '[]' || (hostParts[2] !== undefined && !/^[0-9]*$/.test(hostParts[2]))) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(slash >= 0 ? target.slice(slash) : '');
  } catch {
    return undefined;
  }
  path = path.replace(/\/$/, '').replace(/\.git$/, '');
  return path ? { host: host.toLowerCase(), path } : undefined;
}

function normalizeRepository(value: string): string {
  const parsed = parseRepository(value);
  if (!parsed) return '';
  return parsed.host + (parsed.host === 'github.com' ? parsed.path.toLowerCase() : parsed.path);
}

/** The path above a repository's name, the owner on GitHub, in the provider's case. */
function repositoryNamespace(value: string): string {
  const segments = (parseRepository(value)?.path ?? '').replace(/^\//, '').split('/');
  if (segments.length < 2 || segments.includes('')) return '';
  return segments.slice(0, -1).join('/');
}

function sameCommit(a: string, b: string): boolean {
  return (a.length === 40 || a.length === 64) && a.length === b.length && /^[0-9a-f]+$/i.test(a) && a.toLowerCase() === b.toLowerCase();
}

/** The session_profile a start response or session report carries, read in this one place. */
export function reportedSessionProfile(body: unknown): ReportedSessionProfile | undefined {
  if (!isMapping(body) || !isMapping(body.session_profile)) return undefined;
  const profile = body.session_profile;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  return {
    name: text(profile.name) ?? '',
    status: text(profile.status) ?? '',
    ...(text(profile.outcome) ? { outcome: text(profile.outcome) } : {}),
    ...(text(profile.failure_reason) ? { failureReason: text(profile.failure_reason) } : {}),
    ...(text(profile.missing_git_branch_name) ? { missingGitBranchName: text(profile.missing_git_branch_name) } : {}),
  };
}

/** The progress line for a branch Git doesn't have, from the start or create response. */
export function missingBranchNotice(profile: ReportedSessionProfile | undefined, plan: SessionProfilePlan): string | undefined {
  if (!profile?.missingGitBranchName) return undefined;
  return `Git has no branch "${profile.missingGitBranchName}", so session profile ${profile.name || plan.name} reads the repository's default branch instead`;
}

const OUTCOME_FIXES: Record<string, string> = {
  script_failed: "Its script exited with an error. Run the script yourself from the project root to see its output; Revyl doesn't show the output because setup scripts often print secrets.",
  script_timed_out: "Its script didn't finish within Revyl's 300-second limit. Make it finish sooner.",
  script_unavailable: 'Revyl could not find its script: commit it, or check session.profiles in .revyl/config.yaml. A script name with no .revyl/scripts file must be a Library Script in your Revyl organization.',
  output_invalid: 'An output file the script wrote broke a rule, as the reason says. Fix what the script writes there.',
  runner_failed: 'It failed on Revyl\'s side. Open the session again.',
};

/** SESSION_PROFILE_FAILED for a profile Revyl reported as failed. Revyl stops the session itself. */
export function profileFailedError(profile: ReportedSessionProfile, plan: SessionProfilePlan, viewerUrl: string): VerifyError {
  const name = profile.name || plan.name || '';
  const outcome = profile.outcome ?? 'unknown';
  const reason = profile.failureReason ? `: ${sentence(profile.failureReason)}` : '.';
  const fix = OUTCOME_FIXES[outcome] ?? 'Check the session link for what happened.';
  return new VerifyError('SESSION_PROFILE_FAILED', `Session profile "${name}" failed (${outcome})${reason} ${fix} Revyl stopped the session. See ${viewerUrl}`, {
    outcome: profile.outcome as SessionProfileOutcome | undefined,
    failureReason: profile.failureReason,
  });
}

/** NOT_AVAILABLE_ON_PLATFORM for a session that became active without reporting the profile Verify sent. */
export function profileNotReportedError(platform: Platform, viewerUrl: string): VerifyError {
  return new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `This Revyl backend doesn't run session profiles on ${platform} yet, so Verify stopped the session. Pass ${NONE_HINT} to start without one. See ${viewerUrl}`);
}

const REFUSALS: Record<string, { code: VerifyError['code']; fix: (plan: SessionProfilePlan) => string }> = {
  session_profile_undefined: { code: 'CONFIG_INVALID', fix: (plan) => `Check that session.profiles in ${plan.configPath ?? '.revyl/config.yaml'} defines it and that project.id names the project that holds it.` },
  session_profile_source_required: { code: 'INVALID_ARGUMENT', fix: () => 'Update Verify to the latest version; it sends the project with every named profile.' },
  session_profile_files_need_named: { code: 'INVALID_ARGUMENT', fix: () => 'Update Verify to the latest version; it sends checkout files only with a named profile.' },
  session_profile_script_unavailable: { code: 'SESSION_PROFILE_FAILED', fix: () => 'Commit the script or add it to .revyl/scripts, or create the Library Script with that name in your Revyl organization.' },
  repository_connection_missing: { code: 'CONFIG_INVALID', fix: () => "Connect the repository's GitHub or GitLab app to the project in Revyl, then open the session again." },
  project_not_found: { code: 'CONFIG_INVALID', fix: (plan) => `project.id in ${plan.configPath ?? '.revyl/config.yaml'} isn't a project in this API key's organization. Use a key from that organization, or fix project.id.` },
  repository_unavailable: { code: 'API_ERROR', fix: () => "Revyl couldn't read the repository after 3 attempts. Try again in a few minutes." },
};

/**
 * The error for a start or create Revyl refused because of the session profile fields, or undefined when the refusal is about
 * something else. Reads the top-level code, falling back to the sentence an older backend sends.
 */
export function profileRefusalError(response: RawResponse, plan: SessionProfilePlan, platform: Platform): VerifyError | undefined {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return undefined;
  }
  if (!isMapping(body)) return undefined;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const raw = [body.detail, body.message].find((value): value is string => typeof value === 'string' && value.trim() !== '' && !/^[a-z0-9_]+$/.test(value.trim()));
  const said = raw ? sentence(raw.trim().slice(0, 500)) : '';
  const subject = plan.name ? `session profile "${plan.name}"` : 'the session profile request';
  const refusal = code ? REFUSALS[code] : undefined;
  if (code && refusal) {
    return new VerifyError(refusal.code, `Revyl refused ${subject} (${code})${said ? `: ${said}` : '.'} ${refusal.fix(plan)}`, {
      reason: code as RefusalReason,
      httpStatus: response.status,
      ...(code === 'session_profile_script_unavailable' ? { outcome: 'script_unavailable' as const, ...(said ? { failureReason: said } : {}) } : {}),
    });
  }
  const oldDevice = platform !== 'mac' && response.status === 422 && /need a CLI start or Open preview/i.test(raw ?? '');
  const oldComputer = platform === 'mac' && body.detail === 'invalid_request';
  if (oldDevice || oldComputer) {
    return new VerifyError('NOT_AVAILABLE_ON_PLATFORM', `This Revyl backend doesn't support session profiles on ${platform} yet${said ? ` (${said.replace(/[.!?]$/, '')})` : ''}. Pass ${NONE_HINT} to start without one.`, { httpStatus: response.status });
  }
  return undefined;
}

/** Runs a start or create, repeating it with the same body (and session id, where it has one) while Revyl answers repository_unavailable: 3 attempts in all. */
export async function withRepositoryRetry<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      if (!isVerifyError(error) || error.reason !== 'repository_unavailable' || attempt >= REPOSITORY_RETRY_DELAYS_MS.length) throw error;
      await delay(REPOSITORY_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
