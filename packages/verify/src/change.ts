import { execFile } from 'node:child_process';
import type { ProofChange } from './api/proof-runs.js';
import { VerifyError } from './errors.js';

export interface ChangeFromGitOptions {
  /** The checkout to diff. Defaults to the current directory. */
  cwd?: string;
  /** Detected on GitLab merge request pipelines and Bitrise pull request builds; required elsewhere. */
  reviewKey?: string;
  /** Defaults to the CI's head commit, or the checkout's HEAD. */
  headSha?: string;
  /** Detected on GitLab merge request pipelines and Bitrise pull request builds; required elsewhere. */
  baseSha?: string;
  /** Defaults to the merge request title from CI, or the head commit's subject. */
  title?: string;
  description?: string;
  sourceUrl?: string;
}

interface CiChange {
  reviewKey?: string;
  headSha?: string;
  baseSha?: string;
  baseBranch?: string;
  title?: string;
  description?: string;
  sourceUrl?: string;
}

const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

/**
 * Builds a `change` for `proof()` from a local checkout: the diff from the base commit to the head, plus the review
 * key, title, and link that GitLab merge request pipelines and Bitrise pull request builds expose. Explicit options win
 * over what CI exposes. The base commit must be in the checkout, so fetch enough history in a shallow clone.
 */
export async function changeFromGit(options: ChangeFromGitOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<ProofChange> {
  const ci = ciChange(env);
  const cwd = options.cwd ?? process.cwd();
  const headSha = (options.headSha ?? ci.headSha ?? (await git(cwd, ['rev-parse', 'HEAD']))).trim().toLowerCase();
  const reviewKey = options.reviewKey ?? ci.reviewKey;
  if (reviewKey === undefined) {
    throw new VerifyError('INVALID_ARGUMENT', 'Pass a review key (reviewKey, or --review-key), such as gitlab:group/app!17. It is detected only on GitLab merge request pipelines and Bitrise pull request builds.');
  }
  const baseSha = options.baseSha ?? ci.baseSha ?? (ci.baseBranch !== undefined ? await mergeBase(cwd, headSha, ci.baseBranch) : undefined);
  if (baseSha === undefined) {
    throw new VerifyError('INVALID_ARGUMENT', 'Pass the base commit (baseSha, or --base-sha) the change is diffed from. It is detected only on GitLab merge request pipelines and Bitrise pull request builds.');
  }
  const title = options.title ?? ci.title ?? (await git(cwd, ['log', '-1', '--format=%s', headSha])).trim();
  const description = options.description ?? ci.description;
  const sourceUrl = options.sourceUrl ?? ci.sourceUrl;
  return {
    reviewKey,
    headSha,
    baseSha: baseSha.trim().toLowerCase(),
    title,
    ...(description !== undefined ? { description } : {}),
    diff: await gitDiff(cwd, baseSha.trim(), headSha),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
}

function ciChange(env: NodeJS.ProcessEnv): CiChange {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const iid = value('CI_MERGE_REQUEST_IID');
  if (env.GITLAB_CI === 'true' && iid !== undefined) {
    const project = value('CI_MERGE_REQUEST_PROJECT_PATH') ?? value('CI_PROJECT_PATH');
    const projectUrl = value('CI_MERGE_REQUEST_PROJECT_URL') ?? value('CI_PROJECT_URL');
    return {
      ...(project !== undefined ? { reviewKey: `gitlab:${project}!${iid}` } : {}),
      headSha: value('CI_MERGE_REQUEST_SOURCE_BRANCH_SHA') ?? value('CI_COMMIT_SHA'),
      baseSha: value('CI_MERGE_REQUEST_DIFF_BASE_SHA'),
      title: value('CI_MERGE_REQUEST_TITLE'),
      description: value('CI_MERGE_REQUEST_DESCRIPTION'),
      ...(projectUrl?.startsWith('https://') ? { sourceUrl: `${projectUrl.replace(/\/+$/, '')}/-/merge_requests/${iid}` } : {}),
    };
  }
  const pullRequest = value('BITRISE_PULL_REQUEST');
  if (pullRequest !== undefined) {
    const repository = repositoryPath(value('GIT_REPOSITORY_URL'));
    return {
      ...(repository !== undefined ? { reviewKey: `bitrise:${repository}#${pullRequest}` } : {}),
      headSha: value('BITRISE_GIT_COMMIT'),
      baseBranch: value('BITRISEIO_GIT_BRANCH_DEST'),
      title: value('BITRISE_GIT_MESSAGE')?.split('\n')[0]?.trim() || undefined,
    };
  }
  return {};
}

function repositoryPath(url: string | undefined): string | undefined {
  const path = url?.replace(/^[a-z+]+:\/\/[^/]+\//i, '').replace(/^[^@/]+@[^:]+:/, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  return path && /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(path) ? path : undefined;
}

async function mergeBase(cwd: string, headSha: string, branch: string): Promise<string> {
  try {
    return await git(cwd, ['merge-base', headSha, `origin/${branch}`]);
  } catch {
    throw new VerifyError('INVALID_ARGUMENT', `Couldn't find the base of the change against origin/${branch}. Fetch that branch and enough history, or pass the base commit (baseSha, or --base-sha).`);
  }
}

async function gitDiff(cwd: string, baseSha: string, headSha: string): Promise<string> {
  let output: Buffer;
  try {
    output = await gitBuffer(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${baseSha}...${headSha}`], MAX_DIFF_BYTES + 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new VerifyError('INVALID_ARGUMENT', 'The diff is over 5 MiB, the most a proof takes.');
    throw new VerifyError('INVALID_ARGUMENT', "git couldn't diff the base commit against the head. Both commits must be in the checkout: in a shallow clone, fetch more history (on GitLab, set GIT_DEPTH: 0).", { cause: error });
  }
  if (output.length > MAX_DIFF_BYTES) throw new VerifyError('INVALID_ARGUMENT', 'The diff is over 5 MiB, the most a proof takes.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw new VerifyError('INVALID_ARGUMENT', "The diff isn't valid UTF-8.");
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (await gitBuffer(cwd, args, 1024 * 1024)).toString('utf8').trim();
  } catch (error) {
    throw new VerifyError('INVALID_ARGUMENT', `git ${args[0]} failed in ${cwd}; changeFromGit() needs a git checkout of the change.`, { cause: error });
  }
}

function gitBuffer(cwd: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer, timeout: GIT_TIMEOUT_MS }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}
