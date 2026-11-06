#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { MobilePlatform, Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials } from '../auth.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { initProject, validateInitAnswers, type InitAnswers } from './init.js';
import { checkGithubApp, proofRepository, resolveProofApp, writeProofFiles } from './proof.js';
import { uploadBuild, type UploadBuildResult } from '../upload.js';
import { installVerify, packageHasVerify } from './install.js';
import { signIn } from './login.js';

const HELP = `verify ${VERSION}: open Revyl cloud browsers, devices, and computers from your code

Usage
  npx ${PACKAGE_NAME} init [--platform web|ios|android|mac] [--app-id <id>] [--url <https-url>] [--force] [--yes] [--no-install]
      Install Verify, write verify.config.ts and an example script, then check authentication
  npx ${PACKAGE_NAME} init --proof --platform ios|android [--app-name <name> | --app-id <id>] [--artifact <path>] [--force] [--yes]
      Write .revyl/config.yaml and .github/workflows/revyl-proof.yml so CI uploads each pull request's build for Proof of Changes
  npx ${PACKAGE_NAME} upload <artifact> --app-id <id> [--platform ios|android] [--version <label>] [--repo <owner/name> --commit <sha> [--pr <number>]] [--json]
      Upload a CI build (.apk, .app, or .zip) with its pull request identity, detected on GitHub Actions
  npx ${PACKAGE_NAME} whoami
      Check which Revyl account your credentials belong to

Authentication
  REVYL_API_KEY, or a login from the Revyl CLI ('revyl auth login').

Docs: https://github.com/RevylAI/verify/tree/v${VERSION}/packages/verify/docs
`;

const USAGE_CODES = new Set(['INVALID_ARGUMENT', 'AUTH_MISSING', 'AUTH_REJECTED']);

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case '-v':
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'init':
      return rest.includes('--proof') ? proofInitCommand(rest) : initCommand(rest);
    case 'upload':
      return uploadCommand(rest);
    case 'whoami':
      return whoamiCommand();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function initCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      platform: { type: 'string', short: 'p' },
      'app-id': { type: 'string' },
      url: { type: 'string' },
      force: { type: 'boolean' },
      yes: { type: 'boolean' },
      'no-install': { type: 'boolean' },
    },
  });
  const interactive = Boolean(process.stdin.isTTY) && !process.env.CI;
  let answers: InitAnswers | undefined;
  if (values.platform) {
    answers = validateInitAnswers({
      platform: values.platform as Platform,
      ...(values['app-id'] ? { appId: values['app-id'] } : {}),
      ...(values.url ? { url: values.url } : {}),
    });
  } else if (!interactive) {
    throw new VerifyError('INVALID_ARGUMENT', 'Pass --platform web, ios, android, or mac when not running in a terminal.');
  }
  if (!values['no-install'] && !(await packageHasVerify(process.cwd()))) {
    let installApproved = !interactive || Boolean(values.yes);
    if (interactive && !values.yes) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await readline.question(`Install ${PACKAGE_NAME} as a dev dependency? (Y/n) `)).trim().toLowerCase();
        installApproved = answer === '' || answer === 'y' || answer === 'yes';
      } finally {
        readline.close();
      }
    }
    if (installApproved) await installVerify(process.cwd());
  }
  answers ??= await askInitQuestions(values['app-id'], values.url);
  const result = await initProject(process.cwd(), answers, { force: values.force ?? false });
  process.stdout.write(`Created ${result.created.join(' and ')}${result.gitignoreUpdated ? ', and added .verify/ to .gitignore' : ''}.\n`);
  const credentials = await resolveCredentials();
  if (!credentials) {
    if (interactive) {
      await signIn();
    } else {
      throw new VerifyError('AUTH_MISSING', `${missingCredentialsMessage()} In non-interactive environments, set the REVYL_API_KEY secret.`);
    }
  }
  try {
    await whoamiCommand();
  } catch (error) {
    if (!interactive || !isVerifyError(error) || error.code !== 'AUTH_REJECTED') throw error;
    await signIn({ force: true });
    await whoamiCommand();
  }
  const steps = [
    'Configure the generated verify.config.ts if needed',
    ...(answers.platform === 'mac' ? ['Mac computers are early access. Ask support@revyl.ai about access.'] : []),
    ...(answers.platform === 'mac' || answers.appId ? [] : ['Put your Revyl app id in verify.config.ts (or set REVYL_APP_ID)']),
    'node verify/example.ts',
  ];
  process.stdout.write(
    [
      'Next:',
      ...steps.map((step, index) => `  ${index + 1}. ${step}`),
      '',
    ].join('\n'),
  );
  return 0;
}

async function askInitQuestions(appId: string | undefined, url: string | undefined): Promise<InitAnswers> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const platform = ((await readline.question('What do you want to open? [web/ios/android/mac] (web): ')).trim().toLowerCase() || 'web') as Platform;
    if (platform === 'mac') return validateInitAnswers({ platform, ...(appId ? { appId } : {}), ...(url ? { url } : {}) });
    const id = appId ?? ((await readline.question('Revyl app id (Enter to fill in later): ')).trim() || undefined);
    const webUrl =
      platform === 'web' ? (url ?? ((await readline.question('HTTPS URL to open (Enter for https://example.com): ')).trim() || undefined)) : undefined;
    return validateInitAnswers({ platform, ...(id ? { appId: id } : {}), ...(webUrl ? { url: webUrl } : {}) });
  } finally {
    readline.close();
  }
}

async function proofInitCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      proof: { type: 'boolean' },
      platform: { type: 'string', short: 'p' },
      'app-id': { type: 'string' },
      'app-name': { type: 'string' },
      artifact: { type: 'string' },
      force: { type: 'boolean' },
      yes: { type: 'boolean' },
    },
  });
  const interactive = Boolean(process.stdin.isTTY) && !process.env.CI;
  const cwd = process.cwd();
  const repository = await proofRepository(cwd);
  const readline = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const platform = (values.platform ?? (await readline?.question('Which platform does CI build? [ios/android]: '))?.trim().toLowerCase()) as MobilePlatform | undefined;
    if (platform !== 'ios' && platform !== 'android') throw new VerifyError('INVALID_ARGUMENT', 'init --proof needs --platform ios or --platform android.');
    if (values['app-id'] && values['app-name']) throw new VerifyError('INVALID_ARGUMENT', 'Pass --app-id or --app-name, not both.');
    const suggested = `${repository?.split('/')[1] ?? 'app'}-${platform}`;
    const appName = values['app-name'] ?? (values['app-id'] || !readline ? suggested : (await readline.question(`Revyl app name (${suggested}): `)).trim() || suggested);
    const credentials = (await resolveCredentials()) ?? (interactive ? await signIn() : undefined);
    if (!credentials) throw new VerifyError('AUTH_MISSING', `${missingCredentialsMessage()} In non-interactive environments, set REVYL_API_KEY.`);
    const client = new RevylClient({ token: credentials.token });
    const app = await resolveProofApp(client, {
      platform,
      ...(values['app-id'] ? { appId: values['app-id'] } : {}),
      appName,
      confirmCreate: async (name) => {
        if (values.yes) return true;
        if (!readline) return false;
        const answer = (await readline.question(`No Revyl app is named "${name}". Create a ${platform} app with that name? (y/N) `)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      },
    });
    const github = await checkGithubApp(client, repository);
    const created = await writeProofFiles(cwd, { platform, appId: app.id, ...(values.artifact ? { artifact: values.artifact } : {}), force: values.force ?? false });
    const steps = [
      ...(github.fix ? [github.fix] : []),
      `Replace the build step in ${created[1]} with your ${platform} build`,
      'Add the REVYL_API_KEY repository secret: a Revyl member\'s API key (gh secret set REVYL_API_KEY)',
      `Commit ${created.join(' and ')} to your default branch before opening pull requests; Revyl reads the policy from there`,
      'Open a pull request: Revyl waits for its uploaded build, then runs Proof of Changes',
    ];
    process.stdout.write(
      [
        `${app.created ? 'Created' : 'Using'} Revyl app "${app.name}" (${app.id}).`,
        github.status === 'granted' ? `The Revyl GitHub App can see ${repository}.` : undefined,
        `Wrote ${created.join(' and ')}. Nothing was published and no session was started.`,
        '',
        'Next:',
        ...steps.map((step, index) => `  ${index + 1}. ${step}`),
        '',
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    );
    return 0;
  } finally {
    readline?.close();
  }
}

async function uploadCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'app-id': { type: 'string' },
      platform: { type: 'string', short: 'p' },
      version: { type: 'string' },
      repo: { type: 'string' },
      commit: { type: 'string' },
      pr: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const [file, ...extra] = positionals;
  if (!file || extra.length > 0) throw new VerifyError('INVALID_ARGUMENT', 'verify upload takes exactly one artifact path.');
  const appId = values['app-id'] ?? process.env.REVYL_APP_ID?.trim();
  if (!appId) throw new VerifyError('INVALID_ARGUMENT', 'Pass --app-id (or set REVYL_APP_ID) with the Revyl app this build belongs to.');
  if (values.pr !== undefined && !/^[1-9][0-9]*$/.test(values.pr)) throw new VerifyError('INVALID_ARGUMENT', '--pr must be a positive pull request number.');
  const result = await uploadBuild({
    file,
    appId,
    ...(values.platform ? { platform: values.platform as MobilePlatform } : {}),
    ...(values.version ? { version: values.version } : {}),
    ...(values.repo !== undefined ? { repo: values.repo } : {}),
    ...(values.commit !== undefined ? { commit: values.commit } : {}),
    ...(values.pr !== undefined ? { pr: Number(values.pr) } : {}),
  });
  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : uploadSummary(result));
  return 0;
}

function uploadSummary(result: UploadBuildResult): string {
  const identity = result.identity;
  return [
    `Uploaded build ${result.buildId} (version ${result.version}) to Revyl app ${result.appId}.`,
    identity
      ? `Pull request identity: ${identity.repository}@${identity.commit}${identity.pr ? ` (PR #${identity.pr})` : ''}, from ${identity.ciSystem}.`
      : 'No pull request identity was detected, so no review can match this build. On a runner other than GitHub Actions, pass --repo and --commit.',
    ...(identity ? ['Revyl does not report the review match yet; check the pull request for its Revyl status.'] : []),
    ...result.warnings.map((warning) => `Warning: ${warning}`),
    '',
  ].join('\n');
}

async function whoamiCommand(): Promise<number> {
  const credentials = await resolveCredentials();
  if (!credentials) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());
  const who = await new RevylClient({ token: credentials.token }).whoAmI();
  const name = who.email ?? who.user_id ?? 'an unnamed user';
  const org = who.org_name ?? who.org_id;
  process.stdout.write(`Signed in to Revyl as ${name}${org ? ` in ${org}` : ''} (credentials from ${credentials.source}).\n`);
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    if (isVerifyError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return USAGE_CODES.has(error.code) ? 2 : 1;
    }
    if (error instanceof TypeError && (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`${error.message}\nRun 'verify --help' for usage.\n`);
      return 2;
    }
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

process.exitCode = await runCli(process.argv.slice(2));
