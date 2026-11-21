import { execFile } from 'node:child_process';
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

function gitBranch(projectRoot: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectRoot, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const branch = error ? '' : String(stdout).trim();
      resolvePromise(branch && branch !== 'HEAD' && branch.length <= 255 ? branch : undefined);
    });
  });
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

/** Runs a start or create, repeating it with the same session id while Revyl answers repository_unavailable: 3 attempts in all. */
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
