import { createReadStream, openAsBlob, readFileSync } from 'node:fs';
import { lstat, mkdtemp, open as openFile, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createDeflateRaw, crc32 } from 'node:zlib';
import { apiError, parseJson, RevylClient, type RawResponse } from './api/client.js';
import type { MobilePlatform } from './api/types.js';
import { missingCredentialsMessage, resolveCredentials } from './auth.js';
import { VerifyError, errorMessage, isVerifyError } from './errors.js';

export interface UploadBuildOptions {
  /** A debug `.apk`, a simulator `.app` bundle, or a `.zip` holding one. */
  file: string;
  /** The Revyl app (UUID) the build belongs to. */
  appId: string;
  /** Inferred from the file: `.apk` is Android, `.app` and `.zip` are iOS. */
  platform?: MobilePlatform;
  /** A version label unique within the app. Defaults to the short head commit plus a UTC timestamp. */
  version?: string;
  /** The base repository receiving the pull request, as owner/name. Requires `commit`; overrides GitHub Actions detection. */
  repo?: string;
  /** The full pull request head commit SHA, never a merge commit. Requires `repo`. */
  commit?: string;
  /** Selects the pull request explicitly. Requires `repo` and `commit`; without it Revyl matches by head commit. */
  pr?: number;
  /** Defaults to REVYL_API_KEY or the Revyl CLI login. */
  token?: string;
  backendUrl?: string;
  signal?: AbortSignal;
}

/** The pull request identity sent with an upload, in the same fields `revyl build upload` sends. */
export interface ScmIdentity {
  /** `github-actions` when detected from the runner, `external` for explicit repo and commit outside it. */
  ciSystem: string;
  repository: string;
  commit: string;
  pr?: number;
  prUrl?: string;
  branch?: string;
  baseCommit?: string;
  runId?: string;
  runUrl?: string;
  actor?: string;
  actorUrl?: string;
}

/**
 * Revyl's review match for the upload: `no_identity` when no complete pull request identity was sent, `unknown` when
 * Revyl doesn't report a match. `not_owned` and `unmatched` can still associate once the review freezes its targets.
 */
export type ReviewCorrelationStatus = 'associated' | 'not_owned' | 'ambiguous_review' | 'stale_review' | 'closed_review' | 'unmatched' | 'no_identity' | 'unknown' | (string & {});

export interface ReviewCorrelation {
  status: ReviewCorrelationStatus;
  /** True only for `associated`; any other or unrecognized status is not associated. */
  associated: boolean;
  matchedTargetCount?: number;
}

export interface UploadBuildResult {
  buildId: string;
  version: string;
  appId: string;
  platform: MobilePlatform;
  packageId?: string;
  /** Undefined when no pull request identity was detected or given, so no review can match the build. */
  identity?: ScmIdentity;
  reviewCorrelation: ReviewCorrelation;
  warnings: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const UPLOAD_SOURCE = 'verify_upload';
const SESSION_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 10 * 60_000;
const FINALIZE_TIMEOUT_MS = 90_000;
const PUT_RETRY_DELAYS_MS = [1_000, 3_000];
const FINALIZE_RETRY_DELAYS_MS = [500, 1_000, 2_000];
const RETRYABLE_PUT_STATUSES = new Set([429, 500, 502, 503, 504]);
const ZIP_LIMIT = 0xffff_ffff;

/**
 * Uploads a finished CI build to a Revyl app with the pull request identity Revyl uses
 * to attach it to a review. Detects the identity on GitHub Actions; pass `repo` and `commit` elsewhere.
 */
export async function uploadBuild(options: UploadBuildOptions): Promise<UploadBuildResult> {
  if (typeof options.appId !== 'string' || !UUID.test(options.appId)) throw new VerifyError('INVALID_ARGUMENT', 'appId must be a Revyl app id (a UUID).');
  const artifact = await inspectArtifact(options.file, options.platform);
  const identity = detectScmIdentity(options);
  const version = options.version?.trim() || defaultVersion(identity);
  const token = options.token ?? (await resolveCredentials())?.token;
  if (!token) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());
  const client = new RevylClient({ token, backendUrl: options.backendUrl });
  const headers = identityHeaders(identity);
  const appPath = `/api/v1/apps/${encodeURIComponent(options.appId)}/builds`;

  const zipDir = artifact.directory ? await mkdtemp(join(tmpdir(), 'verify-upload-')) : undefined;
  try {
    const filePath = zipDir ? await zipAppBundle(artifact.path, join(zipDir, `${basename(artifact.path)}.zip`)) : artifact.path;
    const fileName = basename(filePath);
    const session = await call<{ upload_id: string; upload_url: string; content_type: string }>(
      client.send('POST', `${appPath}/upload-session`, { query: { source: UPLOAD_SOURCE }, body: { version, file_name: fileName }, headers, timeoutMs: SESSION_TIMEOUT_MS, retry: false, signal: options.signal }),
      'POST', `${appPath}/upload-session`, options.appId,
    );
    await putArtifact(session.upload_url, session.content_type, filePath, options.signal);
    const build = await call<{ id: string; version?: string; package_name?: string | null; metadata?: Record<string, unknown>; review_correlation?: unknown }>(
      createBuild(client, appPath, { upload_id: session.upload_id, version, metadata: { ...identityMetadata(identity, artifact.platform), source: UPLOAD_SOURCE, platform: artifact.platform } }, headers, options.signal),
      'POST', appPath, options.appId,
    );
    return {
      buildId: build.id,
      version: build.version ?? version,
      appId: options.appId,
      platform: artifact.platform,
      ...(build.package_name ? { packageId: build.package_name } : {}),
      ...(identity ? { identity } : {}),
      reviewCorrelation: reviewCorrelation('review_correlation' in build, build.review_correlation),
      warnings: validationWarnings(build.metadata),
    };
  } finally {
    if (zipDir) await rm(zipDir, { recursive: true, force: true });
  }
}

/** A deployment URL registered as a Web app build. */
export interface UrlBuildResult {
  buildId: string;
  appId: string;
  platform: 'web';
  url: string;
  version?: string;
  /** True when Revyl returned the build it already had for this app, URL, and commit. */
  reused: boolean;
  identity?: ScmIdentity;
}

const WEB_URL = /^https:\/\/[^/?#@\s\\]+(\/[^?#\s\\]*)?$/;
const WEB_URL_MAX_LENGTH = 2048;

/** Rejects what Revyl's URL-build route rejects: anything but HTTPS, credentials, a query, a fragment, or over 2048 characters. */
export function validateWebUrl(url: unknown): string {
  if (typeof url !== 'string' || url.length > WEB_URL_MAX_LENGTH || !WEB_URL.test(url) || /[\x00-\x1f\x7f]/.test(url)) {
    throw new VerifyError('INVALID_ARGUMENT', 'url must be an HTTPS URL of at most 2048 characters, without credentials, a query string, a fragment, backslashes, or whitespace.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VerifyError('INVALID_ARGUMENT', 'url must be a valid HTTPS URL.');
  }
  if (parsed.hostname === '') throw new VerifyError('INVALID_ARGUMENT', 'url must name a host.');
  return url;
}

/** Registers a deployment URL as a build of a Web app, like `revyl build upload --platform web --url`. */
export async function registerUrlBuild(options: { url: string; appId: string; token: string; backendUrl?: string; signal?: AbortSignal }): Promise<UrlBuildResult> {
  if (typeof options.appId !== 'string' || !UUID.test(options.appId)) throw new VerifyError('INVALID_ARGUMENT', 'appId must be a Revyl app id (a UUID).');
  const url = validateWebUrl(options.url);
  const identity = detectScmIdentity();
  const client = new RevylClient({ token: options.token, backendUrl: options.backendUrl });
  const path = `/api/v1/apps/${encodeURIComponent(options.appId)}/builds/external`;
  const response = await client.send('POST', path, {
    body: { url, ...(identity ? { commit_sha: identity.commit } : {}), metadata: identityMetadata(identity, 'web') },
    headers: identityHeaders(identity),
    retry: false,
    signal: options.signal,
  });
  if (response.status < 200 || response.status >= 300) {
    const error = apiError('POST', path, response);
    if (response.status === 403 && error.code === 'AUTH_REJECTED') {
      throw new VerifyError('AUTH_REJECTED', `${error.message} Registering a URL build needs a Revyl member's own API key with the Member role or higher.`, { httpStatus: 403 });
    }
    if (response.status === 404) throw new VerifyError('NOT_FOUND', `Revyl app ${options.appId} was not found in this organization: ${error.message}`, { httpStatus: 404 });
    if (response.status === 422) throw new VerifyError('INVALID_ARGUMENT', error.message, { httpStatus: 422 });
    throw error;
  }
  const build = parseJson<{ id?: unknown; version?: unknown; was_reused?: unknown }>(response, `POST ${path}`);
  if (typeof build.id !== 'string' || build.id === '') throw new VerifyError('API_ERROR', 'Revyl registered the URL build without returning its id.');
  return {
    buildId: build.id,
    appId: options.appId,
    platform: 'web',
    url,
    ...(typeof build.version === 'string' && build.version ? { version: build.version } : {}),
    reused: build.was_reused === true,
    ...(identity ? { identity } : {}),
  };
}

/** Reads the pull request identity from explicit options, else from GitHub Actions, mirroring `revyl build upload`. */
export function detectScmIdentity(options: Pick<UploadBuildOptions, 'repo' | 'commit' | 'pr'> = {}, env: NodeJS.ProcessEnv = process.env): ScmIdentity | undefined {
  const detected = env.GITHUB_ACTIONS === 'true' ? githubActionsIdentity(env) : undefined;
  if (options.repo === undefined && options.commit === undefined && options.pr === undefined) {
    if (!detected?.repository || !detected.commit) return undefined;
    if (!COMMIT.test(detected.commit)) throw new VerifyError('INVALID_ARGUMENT', 'The pull request head commit detected on GitHub Actions is not a full commit SHA (40 or 64 hexadecimal characters).');
    return detected;
  }
  const repository = options.repo?.trim();
  const commit = options.commit?.trim().toLowerCase();
  if (!repository || !commit) throw new VerifyError('INVALID_ARGUMENT', 'An explicit pull request identity needs both repo (owner/name) and commit (the full PR head SHA).');
  if (!REPOSITORY.test(repository)) throw new VerifyError('INVALID_ARGUMENT', 'repo must be the base repository receiving the pull request, as owner/name.');
  if (!COMMIT.test(commit)) throw new VerifyError('INVALID_ARGUMENT', 'commit must be the full PR head commit SHA (40 or 64 hexadecimal characters).');
  if (options.pr !== undefined && (!Number.isInteger(options.pr) || options.pr <= 0)) throw new VerifyError('INVALID_ARGUMENT', 'pr must be a positive pull request number; omit it to match by commit.');
  return {
    ciSystem: detected?.ciSystem ?? 'external',
    repository,
    commit,
    ...(options.pr !== undefined ? { pr: options.pr, prUrl: `https://github.com/${repository}/pull/${options.pr}` } : {}),
    ...pick(detected, ['runId', 'runUrl', 'actor', 'actorUrl']),
  };
}

function githubActionsIdentity(env: NodeJS.ProcessEnv): ScmIdentity {
  const event = readGithubEvent(env.GITHUB_EVENT_PATH);
  const repository = env.GITHUB_REPOSITORY?.trim() ?? '';
  const server = /^https?:\/\//i.test(env.GITHUB_SERVER_URL?.trim() ?? '') ? env.GITHUB_SERVER_URL?.trim().replace(/\/+$/, '') : undefined;
  const runId = env.GITHUB_RUN_ID?.trim();
  const actor = env.GITHUB_ACTOR?.trim();
  const pullRequest = event?.pull_request;
  return {
    ciSystem: 'github-actions',
    repository,
    commit: firstNonEmpty(pullRequest?.head?.sha, env.REVYL_PR_HEAD_SHA, env.GITHUB_SHA)?.toLowerCase() ?? '',
    ...optional('branch', firstNonEmpty(env.GITHUB_HEAD_REF, env.GITHUB_REF_NAME)),
    ...(typeof pullRequest?.number === 'number' && pullRequest.number > 0 ? { pr: pullRequest.number } : {}),
    ...optional('prUrl', pullRequest?.html_url?.trim()),
    ...optional('baseCommit', pullRequest?.base?.sha?.trim()),
    ...optional('runId', runId),
    ...optional('runUrl', server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : undefined),
    ...optional('actor', actor),
    ...optional('actorUrl', server && actor ? `${server}/${actor}` : undefined),
  };
}

interface GithubEvent {
  pull_request?: { number?: number; html_url?: string; head?: { sha?: string }; base?: { sha?: string } };
}

function readGithubEvent(path: string | undefined): GithubEvent | undefined {
  if (!path?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as GithubEvent) : undefined;
  } catch {
    return undefined;
  }
}

function identityHeaders(identity: ScmIdentity | undefined): Record<string, string> {
  if (!identity) return {};
  const headers: Record<string, string | undefined> = {
    'X-CI-System': identity.ciSystem,
    'X-CI-Commit-SHA': identity.commit,
    'X-CI-Branch': identity.branch,
    'X-CI-Run-ID': identity.runId,
    'X-CI-Run-URL': identity.runUrl,
    'X-CI-Repository': identity.repository,
    'X-CI-Actor': identity.actor,
    'X-CI-Actor-URL': identity.actorUrl,
    'X-CI-PR-URL': identity.prUrl,
    'X-CI-PR-Number': identity.pr === undefined ? undefined : String(identity.pr),
  };
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => Boolean(entry[1]) && /^[\x20-\x7e]*$/.test(entry[1] ?? '')));
}

function identityMetadata(identity: ScmIdentity | undefined, platform: MobilePlatform | 'web'): Record<string, unknown> {
  if (!identity) return {};
  const [namespace, project] = splitRepository(identity.repository);
  const metadata: Record<string, unknown> = {
    ci_system: identity.ciSystem,
    ci_run_id: identity.runId,
    ci_run_url: identity.runUrl,
    ci_actor: identity.actor,
    github_repository: identity.repository,
    scm_repo: identity.repository,
    scm_provider: 'github',
    scm_namespace: namespace,
    scm_project: project,
    scm_branch: identity.branch,
    scm_review_number: identity.pr,
    pr_number: identity.pr,
    scm_head_sha: identity.commit,
    scm_base_sha: identity.baseCommit,
    scm_platform: platform,
  };
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined && value !== ''));
}

function splitRepository(repository: string): [string | undefined, string | undefined] {
  const separator = repository.lastIndexOf('/');
  if (separator <= 0 || separator === repository.length - 1) return [undefined, undefined];
  return [repository.slice(0, separator), repository.slice(separator + 1)];
}

async function inspectArtifact(file: string, platform: MobilePlatform | undefined): Promise<{ path: string; platform: MobilePlatform; directory: boolean }> {
  if (typeof file !== 'string' || file.trim() === '') throw new VerifyError('INVALID_ARGUMENT', 'file must be the path to an .apk, an .app bundle, or a .zip holding one.');
  if (platform !== undefined && platform !== 'ios' && platform !== 'android') throw new VerifyError('INVALID_ARGUMENT', "platform must be 'ios' or 'android'.");
  const name = basename(file).toLowerCase();
  if (name.endsWith('.aab')) throw new VerifyError('INVALID_ARGUMENT', 'Android App Bundles (.aab) are not supported. Upload a standalone .apk instead.');
  if (name.endsWith('.apks')) throw new VerifyError('INVALID_ARGUMENT', 'Android split APKs and APK Set archives are not supported. Upload one standalone installable .apk instead.');
  if (name.endsWith('.ipa')) throw new VerifyError('INVALID_ARGUMENT', 'IPA files are not supported. Upload a simulator-built .app bundle, or a .zip holding one.');
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    throw new VerifyError('INVALID_ARGUMENT', `Cannot read the build artifact ${file}: ${errorMessage(error)}`, { cause: error });
  }
  const inferred: MobilePlatform | undefined = name.endsWith('.apk') ? 'android' : name.endsWith('.app') || name.endsWith('.zip') ? 'ios' : undefined;
  const resolved = platform ?? inferred;
  if (!resolved) throw new VerifyError('INVALID_ARGUMENT', `Cannot tell the platform of ${basename(file)}. Upload an .apk, an .app bundle, or a .zip, or pass platform.`);
  if (stats.isDirectory()) {
    if (!name.endsWith('.app')) throw new VerifyError('INVALID_ARGUMENT', `${file} is a directory but not an .app bundle.`);
    if (resolved !== 'ios') throw new VerifyError('INVALID_ARGUMENT', 'An .app bundle is an iOS build; it cannot be uploaded as Android.');
    return { path: file, platform: resolved, directory: true };
  }
  if (!stats.isFile()) throw new VerifyError('INVALID_ARGUMENT', `${file} is not a regular file.`);
  if (resolved === 'ios' && name.endsWith('.apk')) throw new VerifyError('INVALID_ARGUMENT', `${basename(file)} is an Android build; upload a simulator-built .app bundle for iOS.`);
  return { path: file, platform: resolved, directory: false };
}

async function putArtifact(uploadUrl: string, contentType: string, filePath: string, signal: AbortSignal | undefined): Promise<void> {
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new VerifyError('API_ERROR', 'Revyl returned an upload session without a valid upload URL.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new VerifyError('API_ERROR', 'Revyl returned an upload URL that is not HTTPS.');
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(PUT_TIMEOUT_MS);
    let outcome: Response | VerifyError;
    try {
      outcome = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: await openAsBlob(filePath),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new VerifyError('TIMEOUT', "The artifact upload ran past its caller's deadline.", { cause: error });
      outcome = timeout.aborted
        ? new VerifyError('TIMEOUT', `The artifact upload got no response within ${PUT_TIMEOUT_MS / 60_000} minutes.`, { cause: error })
        : new VerifyError('UPLOAD_FAILED', `Could not upload the artifact to Revyl's storage: ${errorMessage(error)}`, { cause: error });
    }
    if (outcome instanceof Response && outcome.ok) {
      await outcome.body?.cancel();
      return;
    }
    const retryable = outcome instanceof VerifyError ? outcome.code === 'UPLOAD_FAILED' : RETRYABLE_PUT_STATUSES.has(outcome.status);
    const failure =
      outcome instanceof VerifyError
        ? outcome
        : new VerifyError('UPLOAD_FAILED', `Revyl's storage rejected the artifact upload with HTTP ${outcome.status}.`, { httpStatus: outcome.status });
    if (outcome instanceof Response) await outcome.body?.cancel();
    const wait = PUT_RETRY_DELAYS_MS[attempt];
    if (!retryable || wait === undefined) throw failure;
    await backoff(wait, signal);
  }
}

async function call<T>(pending: Promise<RawResponse>, method: string, path: string, appId: string): Promise<T> {
  const response = await pending;
  if (response.status >= 200 && response.status < 300) return parseJson<T>(response, `${method} ${path}`);
  const error = apiError(method, path, response);
  if (error.code === 'EDGE_BLOCKED') throw error;
  const detail = error.message;
  switch (response.status) {
    case 401:
      throw new VerifyError(
        'AUTH_REJECTED',
        `${detail} Uploads need a Revyl member's API key, or the job's ci_runner key once the revyl-macos job's activation hook has run; an organization API key with no runtime authenticator is rejected as "Invalid API key".`,
        { httpStatus: 401 },
      );
    case 403:
      throw new VerifyError('AUTH_REJECTED', `${detail} Uploading a build needs the Member role or higher in the app's organization; a Viewer's key gets 403.`, { httpStatus: 403 });
    case 404:
      throw new VerifyError('NOT_FOUND', `Revyl app ${appId} was not found in this organization: ${detail}`, { httpStatus: 404 });
    case 409:
      throw new VerifyError('VERSION_EXISTS', `${detail}. Pass a version that is unique within the app.`, { httpStatus: 409 });
    case 400:
    case 413:
    case 422:
      throw new VerifyError('ARTIFACT_REJECTED', detail, { httpStatus: response.status });
    default:
      throw error;
  }
}

async function backoff(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    throw new VerifyError('TIMEOUT', "The upload ran past its caller's deadline.", { cause: error });
  }
}

function reviewCorrelation(present: boolean, wire: unknown): ReviewCorrelation {
  if (present && wire === null) return { status: 'no_identity', associated: false };
  if (typeof wire !== 'object' || wire === null) return { status: 'unknown', associated: false };
  const { status, matched_target_count: count } = wire as { status?: unknown; matched_target_count?: unknown };
  if (typeof status !== 'string' || status === '') return { status: 'unknown', associated: false };
  return { status, associated: status === 'associated', ...(typeof count === 'number' && Number.isInteger(count) && count >= 0 ? { matchedTargetCount: count } : {}) };
}

async function createBuild(client: RevylClient, path: string, body: unknown, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<RawResponse> {
  for (let attempt = 0; ; attempt += 1) {
    let outcome: RawResponse | VerifyError;
    try {
      outcome = await client.send('POST', path, { body, headers, timeoutMs: FINALIZE_TIMEOUT_MS, retry: false, signal });
    } catch (error) {
      if (signal?.aborted || !isVerifyError(error) || (error.code !== 'API_ERROR' && error.code !== 'TIMEOUT')) throw error;
      outcome = error;
    }
    const retryable = outcome instanceof VerifyError || outcome.status >= 500 || outcome.status === 429;
    const wait = FINALIZE_RETRY_DELAYS_MS[attempt];
    if (!retryable || wait === undefined) {
      if (outcome instanceof VerifyError) throw outcome;
      return outcome;
    }
    await backoff(wait, signal);
  }
}

function validationWarnings(metadata: Record<string, unknown> | undefined): string[] {
  const validation = metadata?.artifact_validation;
  if (typeof validation !== 'object' || validation === null) return [];
  const warnings = (validation as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string' && warning.trim() !== '') : [];
}

function defaultVersion(identity: ScmIdentity | undefined): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return identity ? `${identity.commit.slice(0, 12)}-${timestamp}` : timestamp;
}

/** Zips an .app bundle the way `revyl build upload` does: entries under the bundle's name, symlinks kept as links. */
async function zipAppBundle(appPath: string, zipPath: string): Promise<string> {
  const handle = await openFile(zipPath, 'w');
  const central: Buffer[] = [];
  let offset = 0;
  const write = async (chunk: Uint8Array) => {
    await handle.write(chunk);
    offset += chunk.length;
  };
  try {
    for (const entry of await bundleEntries(appPath, basename(appPath))) {
      const headerOffset = offset;
      const stats = await lstat(entry.path);
      const [dosTime, dosDate] = dosDateTime(stats.mtime);
      const name = Buffer.from(entry.isDirectory ? `${entry.name}/` : entry.name, 'utf8');
      let method = 0;
      let flags = 0x0800;
      let checksum = 0;
      let size = 0;
      let compressed = 0;
      let mode = stats.mode & 0o7777;
      if (entry.isDirectory) {
        mode |= 0o040000;
        await write(localHeader(name, flags, method, dosTime, dosDate, 0, 0, 0));
      } else if (stats.isSymbolicLink()) {
        mode |= 0o120000;
        const target = Buffer.from((await readlink(entry.path)).split('\\').join('/'), 'utf8');
        checksum = crc32(target);
        size = compressed = target.length;
        await write(localHeader(name, flags, method, dosTime, dosDate, checksum, size, size));
        await write(target);
      } else {
        mode |= 0o100000;
        method = 8;
        flags |= 0x0008;
        await write(localHeader(name, flags, method, dosTime, dosDate, 0, 0, 0));
        await pipeline(
          createReadStream(entry.path),
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              checksum = crc32(chunk, checksum);
              size += chunk.length;
              yield chunk;
            }
          },
          createDeflateRaw(),
          async (deflated: AsyncIterable<Buffer>) => {
            for await (const chunk of deflated) {
              compressed += chunk.length;
              await write(chunk);
            }
          },
        );
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(checksum, 4);
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
        await write(descriptor);
      }
      if (size > ZIP_LIMIT || compressed > ZIP_LIMIT || offset > ZIP_LIMIT) throw zipTooLarge();
      central.push(centralHeader(name, flags, method, dosTime, dosDate, checksum, compressed, size, mode, headerOffset));
    }
    if (central.length >= 0xffff) throw zipTooLarge();
    const centralOffset = offset;
    for (const header of central) await write(header);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(end);
    if (offset > ZIP_LIMIT) throw zipTooLarge();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return zipPath;
}

async function bundleEntries(path: string, name: string): Promise<Array<{ path: string; name: string; isDirectory: boolean }>> {
  const entries: Array<{ path: string; name: string; isDirectory: boolean }> = [];
  for (const child of (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const childPath = join(path, child.name);
    const childName = `${name}/${child.name}`;
    if (child.isDirectory()) {
      entries.push({ path: childPath, name: childName, isDirectory: true }, ...(await bundleEntries(childPath, childName)));
    } else if (child.isFile() || child.isSymbolicLink()) {
      entries.push({ path: childPath, name: childName, isDirectory: false });
    } else {
      throw new VerifyError('INVALID_ARGUMENT', `${childPath} in the .app bundle is not a file, directory, or symlink.`);
    }
  }
  return entries;
}

function localHeader(name: Buffer, flags: number, method: number, time: number, date: number, checksum: number, compressed: number, size: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressed, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function centralHeader(name: Buffer, flags: number, method: number, time: number, date: number, checksum: number, compressed: number, size: number, mode: number, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressed, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

function dosDateTime(value: Date): [number, number] {
  const year = Math.max(1980, value.getFullYear());
  return [(value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2), ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()];
}

function zipTooLarge(): VerifyError {
  return new VerifyError('INVALID_ARGUMENT', 'The .app bundle is too large to zip without ZIP64. Zip it yourself and upload the .zip.');
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value) => Boolean(value));
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

function pick<T extends object, K extends keyof T>(source: T | undefined, keys: K[]): Partial<Pick<T, K>> {
  if (!source) return {};
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])) as Partial<Pick<T, K>>;
}
