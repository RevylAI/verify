#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { MobilePlatform, Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials } from '../auth.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { initProject, validateInitAnswers, type InitAnswers } from './init.js';
import { uploadBuild, type UploadBuildResult } from '../upload.js';
import { proof, type ProofEnvironmentValue, type ProofRun, type ProofTarget } from '../proof.js';
import { installVerify, packageHasVerify } from './install.js';
import { signIn } from './login.js';

const HELP = `verify ${VERSION}: open Revyl cloud browsers, devices, and computers from your code

Usage
  npx ${PACKAGE_NAME} init [--platform web|ios|android|mac] [--app-id <id>] [--url <https-url>] [--force] [--yes] [--no-install]
      Install Verify, write verify.config.ts and an example script, then check authentication
  npx ${PACKAGE_NAME} upload <artifact> --app-id <id> [--platform ios|android] [--version <label>] [--repo <owner/name> --commit <sha> [--pr <number>]] [--json]
      Upload a CI build (.apk, .app, or .zip) with its pull request identity, detected on GitHub Actions
  npx ${PACKAGE_NAME} proof <artifact> | --url <https-url> --app-id <id> [--guidance <text>] [--env NAME[=value]]... [--env-secret NAME]... [--timeout <minutes>] [--no-wait] [--json]
  npx ${PACKAGE_NAME} proof --target <app-id>=<artifact-or-https-url>... [same options]
      Upload each pull request build or register its Web URL, and run Revyl Proof of Changes on it, on GitHub Actions.
      Up to 3 targets, one per platform; --env and --env-secret apply to every mobile target. --env-secret NAME uses the
      organization launch variable NAME and needs a member API key. A URL must stay up until its run settles.
      Revyl adds no check run, so this is the CI gate: it exits 0 only when the overall verdict is passed (failed if any
      run failed, else inconclusive if any is, else passed), and 1 otherwise. With --no-wait it exits 0 once the runs start
  npx ${PACKAGE_NAME} whoami
      Check which Revyl account your credentials belong to

Authentication
  REVYL_API_KEY, or a login from the Revyl CLI ('revyl auth login').

Docs: https://github.com/RevylAI/verify/tree/v${VERSION}/packages/verify/docs
`;

const USAGE_CODES = new Set(['INVALID_ARGUMENT', 'AUTH_MISSING', 'AUTH_REJECTED', 'PR_CONTEXT_MISSING']);

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
      return initCommand(rest);
    case 'upload':
      return uploadCommand(rest);
    case 'proof':
      return proofCommand(rest);
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
    ...(identity ? [reviewLine(result.reviewCorrelation)] : []),
    ...result.warnings.map((warning) => `Warning: ${warning}`),
    '',
  ].join('\n');
}

function reviewLine(correlation: UploadBuildResult['reviewCorrelation']): string {
  if (correlation.status === 'unknown') return 'Revyl did not report the review match; check the pull request for its Revyl status.';
  const targets = correlation.matchedTargetCount === undefined ? '' : ` (${correlation.matchedTargetCount} matched review target${correlation.matchedTargetCount === 1 ? '' : 's'})`;
  const later = correlation.status === 'not_owned' || correlation.status === 'unmatched' ? ' It can still attach once the review picks its targets for this commit.' : '';
  return `Review match: ${correlation.status}${targets}.${later}`;
}

async function proofCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'app-id': { type: 'string' },
      url: { type: 'string' },
      target: { type: 'string', multiple: true },
      guidance: { type: 'string' },
      env: { type: 'string', multiple: true },
      'env-secret': { type: 'string', multiple: true },
      timeout: { type: 'string' },
      'no-wait': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  const [build, ...extra] = positionals;
  const single = build !== undefined || values.url !== undefined || values['app-id'] !== undefined;
  if (extra.length > 0 || (values.target !== undefined && single) || (build !== undefined && values.url !== undefined)) {
    throw new VerifyError('INVALID_ARGUMENT', 'verify proof takes one artifact path or --url with --app-id, or repeated --target <app-id>=<artifact-or-https-url>.');
  }
  if (values.timeout !== undefined && !/^[1-9][0-9]*$/.test(values.timeout)) throw new VerifyError('INVALID_ARGUMENT', '--timeout must be a positive number of minutes.');
  const environment: Record<string, ProofEnvironmentValue> = {};
  for (const entry of values.env ?? []) {
    const separator = entry.indexOf('=');
    const name = separator === -1 ? entry : entry.slice(0, separator);
    const value = separator === -1 ? process.env[name] : entry.slice(separator + 1);
    if (value === undefined) throw new VerifyError('INVALID_ARGUMENT', `--env ${name} has no value: pass NAME=value or set ${name} in the environment.`);
    environment[name] = value;
  }
  for (const name of values['env-secret'] ?? []) {
    if (name.includes('=')) throw new VerifyError('INVALID_ARGUMENT', '--env-secret takes NAME, the organization launch variable that holds the secret, with no value.');
    environment[name] = { secretRef: name };
  }
  const hasEnvironment = Object.keys(environment).length > 0;
  const target = (appId: string, artifactOrUrl: string): ProofTarget =>
    artifactOrUrl.startsWith('https://') || artifactOrUrl.startsWith('http://')
      ? { appId, url: artifactOrUrl }
      : { appId, build: artifactOrUrl, ...(hasEnvironment ? { environment } : {}) };
  let targets: ProofTarget[];
  if (values.target !== undefined) {
    targets = values.target.map((entry) => {
      const separator = entry.indexOf('=');
      if (separator <= 0 || separator === entry.length - 1) throw new VerifyError('INVALID_ARGUMENT', '--target takes <app-id>=<artifact-or-https-url>.');
      return target(entry.slice(0, separator), entry.slice(separator + 1));
    });
  } else {
    const appId = values['app-id'] ?? process.env.REVYL_APP_ID?.trim();
    if (!appId) throw new VerifyError('INVALID_ARGUMENT', 'Pass --app-id (or set REVYL_APP_ID) with the Revyl app this build belongs to.');
    if (build === undefined && values.url === undefined) throw new VerifyError('INVALID_ARGUMENT', 'verify proof takes one artifact path or --url with --app-id, or repeated --target <app-id>=<artifact-or-https-url>.');
    targets = [values.url !== undefined ? { appId, url: values.url } : target(appId, build!)];
  }
  if (hasEnvironment && targets.every((entry) => entry.url !== undefined)) throw new VerifyError('INVALID_ARGUMENT', '--env and --env-secret apply only to mobile builds; a URL target takes no launch variables.');
  const run = await proof({
    targets,
    ...(values.guidance !== undefined ? { guidance: values.guidance } : {}),
    ...(values.timeout !== undefined ? { timeoutMs: Number(values.timeout) * 60_000 } : {}),
    wait: !values['no-wait'],
  });
  process.stdout.write(values.json ? `${JSON.stringify(run, null, 2)}\n` : proofSummary(run));
  return values['no-wait'] || run.verdict === 'passed' ? 0 : 1;
}

function proofSummary(run: ProofRun): string {
  const pullRequest = `${run.pullRequest.repository}#${run.pullRequest.number}`;
  const lines = run.runs.map((entry) => `  ${entry.platform ?? entry.build.platform} run ${entry.id} (build ${entry.build.buildId}): ${entry.verdict ? (entry.label ?? entry.verdict) : entry.status}`);
  const warnings = run.runs.flatMap((entry) => ('warnings' in entry.build ? entry.build.warnings : [])).map((warning) => `Warning: ${warning}`);
  const outcome = run.verdict ? `Proof of Changes for ${pullRequest}: ${run.label ?? run.verdict}.` : `Started Proof of Changes for ${pullRequest}.`;
  return [outcome, ...lines, ...(run.reportUrl ? [`Report: ${run.reportUrl}`] : []), ...warnings, ''].join('\n');
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
