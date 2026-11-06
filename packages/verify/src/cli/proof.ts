import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RevylClient } from '../api/client.js';
import type { AppResponse, MobilePlatform } from '../api/types.js';
import { VerifyError } from '../errors.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

export const PROOF_CONFIG_FILE = join('.revyl', 'config.yaml');
export const PROOF_WORKFLOW_FILE = join('.github', 'workflows', 'revyl-proof.yml');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ARTIFACTS: Record<MobilePlatform, string> = {
  ios: 'build/Build/Products/Debug-iphonesimulator/App.app',
  android: 'app/build/outputs/apk/debug/app-debug.apk',
};
const API_PLATFORM: Record<MobilePlatform, string> = { ios: 'iOS', android: 'Android' };

export type GithubAppStatus = 'granted' | 'not_connected' | 'not_granted' | 'unknown';

/** The GitHub repository behind the current folder, which must be the repository root. */
export async function proofRepository(cwd: string): Promise<string | undefined> {
  if (!existsSync(join(cwd, '.git'))) {
    throw new VerifyError('INVALID_ARGUMENT', 'Run verify init --proof from the root of your Git repository: .revyl/config.yaml and .github/workflows belong there.');
  }
  let origin: string;
  try {
    origin = (await promisify(execFile)('git', ['config', '--get', 'remote.origin.url'], { cwd, timeout: 10_000 })).stdout.trim();
  } catch {
    return undefined;
  }
  return /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
}

/** Uses the given app id, or the app with exactly this name, or creates it once `confirmCreate` agrees. */
export async function resolveProofApp(
  client: RevylClient,
  options: { platform: MobilePlatform; appId?: string; appName: string; confirmCreate: (name: string) => Promise<boolean> },
): Promise<{ id: string; name: string; created: boolean }> {
  const wanted = API_PLATFORM[options.platform];
  if (options.appId !== undefined) {
    if (!UUID.test(options.appId)) throw new VerifyError('INVALID_ARGUMENT', '--app-id must be a Revyl app id (a UUID).');
    const app = await client.getApp(options.appId);
    requirePlatform(app, options.platform);
    return { id: app.id, name: app.name ?? options.appId, created: false };
  }
  const name = options.appName.trim();
  if (name === '') throw new VerifyError('INVALID_ARGUMENT', '--app-name must not be empty.');
  const page = await client.json<{ items: AppResponse[] }>('GET', '/api/v1/apps/', { query: { search: name, page: '1', page_size: '100' } });
  const existing = page.items.find((app) => app.name?.toLowerCase() === name.toLowerCase());
  if (existing) {
    requirePlatform(existing, options.platform);
    return { id: existing.id, name: existing.name ?? name, created: false };
  }
  if (!(await options.confirmCreate(name))) {
    throw new VerifyError('INVALID_ARGUMENT', `No Revyl app is named "${name}". Re-run and confirm creating it, pass --yes, or pass --app-id with an existing ${wanted} app.`);
  }
  const created = await client.json<AppResponse>('POST', '/api/v1/apps/', { body: { name, platform: wanted }, retry: false });
  return { id: created.id, name: created.name ?? name, created: true };
}

function requirePlatform(app: AppResponse, platform: MobilePlatform): void {
  if (app.platform?.toLowerCase() !== platform) {
    throw new VerifyError('INVALID_ARGUMENT', `Revyl app "${app.name ?? app.id}" is for ${app.platform ?? 'an unknown platform'}, not ${API_PLATFORM[platform]}. Pick another name or app id.`);
  }
}

/** Whether the Revyl GitHub App can see the repository, with the exact fix when it can't. */
export async function checkGithubApp(client: RevylClient, repository: string | undefined): Promise<{ status: GithubAppStatus; fix?: string }> {
  if (!repository) {
    return { status: 'unknown', fix: 'Could not read a github.com origin remote, so the GitHub App check was skipped. Proof of Changes needs the Revyl GitHub App installed on the repository: run `revyl github connect`, then `revyl github status` from the repository.' };
  }
  let state: { has_access?: boolean; installation?: unknown; repositories?: Array<{ owner?: string; repo?: string }> };
  try {
    state = await client.json('GET', '/api/v1/integrations/github/repositories');
  } catch (error) {
    return { status: 'unknown', fix: `Could not check the Revyl GitHub App (${(error as Error).message}). Run \`revyl github status\` from the repository to check it.` };
  }
  if (!state.installation || !state.has_access) {
    return { status: 'not_connected', fix: `Your Revyl organization has no GitHub App connected. Run \`revyl github connect\`, install the Revyl GitHub App with access to ${repository}, then run \`revyl github status\`.` };
  }
  const [owner, name] = repository.toLowerCase().split('/');
  const granted = (state.repositories ?? []).some((repo) => repo.owner?.toLowerCase() === owner && repo.repo?.toLowerCase() === name);
  if (!granted) {
    return { status: 'not_granted', fix: `The Revyl GitHub App is connected but can't see ${repository}. Add ${repository} to the app's repository access on GitHub, then run \`revyl github status\`.` };
  }
  return { status: 'granted' };
}

/** Writes the Proof of Changes policy and the GitHub Actions workflow that uploads each pull request's build. */
export async function writeProofFiles(
  cwd: string,
  options: { platform: MobilePlatform; appId: string; artifact?: string; force?: boolean },
): Promise<string[]> {
  const artifact = options.artifact ?? DEFAULT_ARTIFACTS[options.platform];
  if (/[\r\n"`$]/.test(artifact)) throw new VerifyError('INVALID_ARGUMENT', '--artifact must be a plain path without quotes, backticks, $ or newlines.');
  const files: Array<[string, string]> = [
    [PROOF_CONFIG_FILE, configYaml(options.platform, options.appId)],
    [PROOF_WORKFLOW_FILE, workflowYaml(options.platform, options.appId, artifact)],
  ];
  const existing = files.map(([path]) => path).filter((path) => existsSync(join(cwd, path)));
  if (existing.length > 0 && !options.force) {
    throw new VerifyError('INVALID_ARGUMENT', `${existing.join(' and ')} already exist. Re-run with --force to overwrite.`);
  }
  for (const [path, content] of files) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  return files.map(([path]) => path);
}

function configYaml(platform: MobilePlatform, appId: string): string {
  return `# Revyl reads this file from your default branch: commit it there before opening pull requests.
# Each pull request waits for the build that .github/workflows/revyl-proof.yml uploads, then runs Proof of Changes.
project:
  id: "${randomUUID()}"

pr_review:
  build:
    kind: ci_upload_to_revyl
    app_ids:
      ${platform}: "${appId}"
  proof_of_changes:
    enabled: true
    harness:
      kind: revyl
`;
}

function workflowYaml(platform: MobilePlatform, appId: string, artifact: string): string {
  const what = platform === 'ios' ? 'a simulator .app bundle (or a .zip holding one)' : 'a debug .apk';
  return `# Uploads each pull request's build to Revyl, which then runs Proof of Changes on it.
# Needs the REVYL_API_KEY repository secret: a Revyl member's API key.
name: Revyl Proof of Changes

on:
  pull_request:

permissions:
  contents: read

jobs:
  upload:
    name: Upload build to Revyl
    runs-on: ${platform === 'ios' ? 'macos-latest' : 'ubuntu-latest'}
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: Build the app
        # Replace this step with the commands that build ${what} at ${artifact}.
        run: |
          echo "::error::Replace the build step in .github/workflows/revyl-proof.yml with your ${platform} build."
          exit 1
      - name: Upload the build to Revyl
        run: npx --yes ${PACKAGE_NAME}@${VERSION} upload "${artifact}" --app-id ${appId} --platform ${platform}
        env:
          REVYL_API_KEY: \${{ secrets.REVYL_API_KEY }}
`;
}
