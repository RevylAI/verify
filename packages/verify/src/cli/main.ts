#!/usr/bin/env node
import { rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface as createLineReader } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { MobilePlatform, Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials, revylCredentialsPath } from '../auth.js';
import { changeFromGit } from '../change.js';
import { environment, type Environment } from '../environment.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { proof, type ProofEnvironmentValue, type ProofRun, type ProofTarget } from '../proof.js';
import { QUICK_TUNNEL_URL } from '../tunnel.js';
import { uploadBuild, type UploadBuildResult } from '../upload.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { initProject, validateInitAnswers, webAppIdMissingMessage, type InitAnswers } from './init.js';
import { installVerify, packageHasVerify } from './install.js';
import { signIn } from './login.js';

const INIT_USAGE = `npx ${PACKAGE_NAME} init [--platform ios|android|web|mac] [--app-id <id>] [--url <https-url>] [--force] [--yes] [--no-install]`;
const DOCS = `https://github.com/RevylAI/verify/tree/v${VERSION}/packages/verify/docs`;

const HELP = `verify ${VERSION}: open Revyl cloud browsers, devices, and computers from your code

Usage
  ${INIT_USAGE}
      Install Verify, write verify.config.ts and an example script, and sign in
  npx ${PACKAGE_NAME} login
      Sign in to Revyl through your browser
  npx ${PACKAGE_NAME} logout
      Remove the saved Revyl login from this computer
  npx ${PACKAGE_NAME} upload <artifact> --app-id <id> [--platform ios|android] [--version <label>] [--repo <owner/name> --commit <sha> [--pr <number>]] [--json]
      Upload a CI build (.apk, .app, or .zip) with its pull request identity, detected on GitHub Actions
  npx ${PACKAGE_NAME} proof <artifact> | --url <https-url> --app-id <id> [--guidance <text>] [--env NAME[=value]]... [--env-secret NAME]... [--auth-deep-link <template>] [--timeout <minutes>] [--no-wait] [--summary-file <path>] [--json]
  npx ${PACKAGE_NAME} proof --target <app-id>=<artifact-or-https-url>... [same options]
      Upload each pull request build or register its Web URL, and run Revyl Proof of Changes on it, on GitHub Actions.
      Up to 3 targets, one per platform; --env and --env-secret apply to every mobile target. --env-secret NAME uses the
      organization launch variable NAME and needs a member API key. --auth-deep-link opens a deep link after launch, like
      session.auth_bypass.deep_link; its \${NAME} placeholders resolve only from --env and --env-secret, so single-quote it.
      With --target, pass --auth-deep-link <app-id>=<template> per mobile target. A URL must stay up until its run settles.
      Revyl adds no check run, so this is the CI gate: it exits 0 only when the overall verdict is passed (failed if any
      run failed, else inconclusive if any is, else passed), and 1 otherwise. With --no-wait it exits 0 once the runs start.
      --summary-file writes each run's Markdown write-up to a file once the runs settle.
  npx ${PACKAGE_NAME} proof ... --no-scm [--review-key <key>] [--base-sha <sha>] [--head-sha <sha>] [--title <text>] [--source-url <https-url>]
      Prove the checkout's diff instead of a GitHub pull request, for a source host Revyl can't read, such as GitLab.
      The review key, commits, title, and link are detected on GitLab merge request pipelines and Bitrise pull request
      builds; elsewhere pass --review-key and --base-sha (--review-key alone also selects this mode). Revyl posts
      nothing: the report is a Revyl page for organization members, so post the --summary-file write-up yourself
  npx ${PACKAGE_NAME} env [--start <command>] --expose NAME=port... [--ready NAME=/path]... [--stop <command>] [--seed <command>] [--ready-timeout <seconds>] [--show-urls] -- <command> [args...]
      Start a stack on this runner, give each port a public quick-tunnel URL, run the command with NAME=<url> in its
      environment, then tear everything down. URLs are hidden in logs unless --show-urls is passed; on an interactive
      terminal the wrapped command writes to it directly
  npx ${PACKAGE_NAME} whoami
      Check which Revyl account your credentials belong to

Authentication
  In a terminal, init, login, and your first open() sign you in through your browser and save the
  login to ~/.revyl/credentials.json, which the Revyl CLI shares. In CI, set REVYL_API_KEY instead.

Docs: ${DOCS}
`;

const INIT_HELP = `Usage: ${INIT_USAGE}

Writes verify.config.ts and verify/example.mts, installs Verify when the project lacks it, and signs
you in through your browser when no credentials are saved.

  --platform    ios, android, web, or mac. Without it, init asks. iOS and Android without --app-id
                open the device's built-in Settings app, so the example runs before you upload anything.
  --app-id      The Revyl app to open. Required for web; create a Web app at https://app.revyl.ai first.
  --url         The public HTTPS URL a web target opens (default https://example.com).
  --force       Overwrite existing files.
  --yes         Install Verify without asking.
  --no-install  Skip installing Verify.

Docs: ${DOCS}/getting-started.md
`;

const RELAY_FLUSH_MS = 2_000;
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
    case 'login':
    case 'logout':
    case 'whoami': {
      const { values } = parseArgs({ args: rest, options: { help: { type: 'boolean', short: 'h' } } });
      if (values.help) {
        process.stdout.write(HELP);
        return 0;
      }
      if (command === 'login') return signInAndCheck(Boolean(process.stdin.isTTY) && !process.env.CI);
      return command === 'logout' ? logoutCommand() : whoamiCommand();
    }
    case 'upload':
      return uploadCommand(rest);
    case 'proof':
      return proofCommand(rest);
    case 'env':
      return envCommand(rest);
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
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(INIT_HELP);
    return 0;
  }
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
  await signInAndCheck(interactive);
  const steps =
    answers.platform === 'mac'
      ? ["Mac computers need a current paid Revyl plan; if yours can't start one, ask support@revyl.ai.", 'Run: node verify/example.mts']
      : answers.appId
        ? ['Run: node verify/example.mts']
        : ['Run: node verify/example.mts', 'To test your own app, put its Revyl app id in verify.config.ts in place of the Settings bundle id.'];
  process.stdout.write(
    [
      'Next:',
      ...steps.map((step, index) => `  ${index + 1}. ${step}`),
      '',
    ].join('\n'),
  );
  return 0;
}

async function signInAndCheck(interactive: boolean): Promise<number> {
  const credentials = await resolveCredentials();
  if (!credentials) {
    if (!interactive) throw new VerifyError('AUTH_MISSING', `${missingCredentialsMessage()} In non-interactive environments, set the REVYL_API_KEY secret.`);
    await signIn();
  }
  try {
    return await whoamiCommand();
  } catch (error) {
    if (!interactive || !isVerifyError(error) || error.code !== 'AUTH_REJECTED') throw error;
    await signIn({ force: true });
    return whoamiCommand();
  }
}

async function askInitQuestions(appId: string | undefined, url: string | undefined): Promise<InitAnswers> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const platform = ((await readline.question('What do you want to open? [ios/android/web/mac] (ios): ')).trim().toLowerCase() || 'ios') as Platform;
    if (platform === 'mac') return validateInitAnswers({ platform, ...(appId ? { appId } : {}), ...(url ? { url } : {}) });
    const question = platform === 'web' ? 'Revyl Web app id (Enter if you have none yet): ' : 'Revyl app id (Enter to use the built-in Settings app): ';
    const id = appId ?? ((await readline.question(question)).trim() || undefined);
    if (platform === 'web' && !id) throw new VerifyError('INVALID_ARGUMENT', webAppIdMissingMessage(url));
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
      'auth-deep-link': { type: 'string', multiple: true },
      timeout: { type: 'string' },
      'no-wait': { type: 'boolean' },
      'summary-file': { type: 'string' },
      'no-scm': { type: 'boolean' },
      'review-key': { type: 'string' },
      'base-sha': { type: 'string' },
      'head-sha': { type: 'string' },
      title: { type: 'string' },
      'source-url': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const changeMode = values['no-scm'] === true || values['review-key'] !== undefined;
  const changeFlag = (['base-sha', 'head-sha', 'title', 'source-url'] as const).find((flag) => values[flag] !== undefined);
  if (!changeMode && changeFlag !== undefined) throw new VerifyError('INVALID_ARGUMENT', `--${changeFlag} applies only with --no-scm or --review-key.`);
  if (values['summary-file'] !== undefined && values['no-wait']) throw new VerifyError('INVALID_ARGUMENT', '--summary-file needs the runs to settle, so it does not go with --no-wait.');
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
  const deepLinks = values['auth-deep-link'] ?? [];
  const target = (appId: string, artifactOrUrl: string, deepLink: string | undefined): ProofTarget => {
    if (!artifactOrUrl.startsWith('https://') && !artifactOrUrl.startsWith('http://')) {
      return { appId, build: artifactOrUrl, ...(hasEnvironment ? { environment } : {}), ...(deepLink !== undefined ? { authBypass: { deepLink } } : {}) };
    }
    if (deepLink !== undefined) throw new VerifyError('INVALID_ARGUMENT', '--auth-deep-link applies only to mobile builds; a URL target takes no deep link.');
    return { appId, url: artifactOrUrl };
  };
  let targets: ProofTarget[];
  if (values.target !== undefined) {
    const linksByApp = new Map<string, string>();
    for (const entry of deepLinks) {
      const separator = entry.indexOf('=');
      if (separator <= 0 || separator === entry.length - 1) throw new VerifyError('INVALID_ARGUMENT', 'With --target, --auth-deep-link takes <app-id>=<template>.');
      const appId = entry.slice(0, separator);
      if (linksByApp.has(appId)) throw new VerifyError('INVALID_ARGUMENT', '--auth-deep-link takes one deep link per app.');
      linksByApp.set(appId, entry.slice(separator + 1));
    }
    targets = values.target.map((entry) => {
      const separator = entry.indexOf('=');
      if (separator <= 0 || separator === entry.length - 1) throw new VerifyError('INVALID_ARGUMENT', '--target takes <app-id>=<artifact-or-https-url>.');
      return target(entry.slice(0, separator), entry.slice(separator + 1), linksByApp.get(entry.slice(0, separator)));
    });
    if ([...linksByApp.keys()].some((appId) => !targets.some((entry) => entry.appId === appId))) throw new VerifyError('INVALID_ARGUMENT', '--auth-deep-link names an app id that no --target has.');
  } else {
    const appId = values['app-id'] ?? process.env.REVYL_APP_ID?.trim();
    if (!appId) throw new VerifyError('INVALID_ARGUMENT', 'Pass --app-id (or set REVYL_APP_ID) with the Revyl app this build belongs to.');
    if (build === undefined && values.url === undefined) throw new VerifyError('INVALID_ARGUMENT', 'verify proof takes one artifact path or --url with --app-id, or repeated --target <app-id>=<artifact-or-https-url>.');
    if (deepLinks.length > 1) throw new VerifyError('INVALID_ARGUMENT', '--auth-deep-link takes one deep link for a single target.');
    if (values.url !== undefined && deepLinks.length > 0) throw new VerifyError('INVALID_ARGUMENT', '--auth-deep-link applies only to mobile builds; a URL target takes no deep link.');
    targets = [values.url !== undefined ? { appId, url: values.url } : target(appId, build!, deepLinks[0])];
  }
  if (hasEnvironment && targets.every((entry) => entry.url !== undefined)) throw new VerifyError('INVALID_ARGUMENT', '--env and --env-secret apply only to mobile builds; a URL target takes no launch variables.');
  const change = changeMode
    ? await changeFromGit({
        ...(values['review-key'] !== undefined ? { reviewKey: values['review-key'] } : {}),
        ...(values['base-sha'] !== undefined ? { baseSha: values['base-sha'] } : {}),
        ...(values['head-sha'] !== undefined ? { headSha: values['head-sha'] } : {}),
        ...(values.title !== undefined ? { title: values.title } : {}),
        ...(values['source-url'] !== undefined ? { sourceUrl: values['source-url'] } : {}),
      })
    : undefined;
  const run = await proof({
    targets,
    ...(change !== undefined ? { change } : {}),
    ...(values.guidance !== undefined ? { guidance: values.guidance } : {}),
    ...(values.timeout !== undefined ? { timeoutMs: Number(values.timeout) * 60_000 } : {}),
    wait: !values['no-wait'],
  });
  const summaries = run.runs.flatMap((entry) => (entry.summaryMarkdown ? [entry.summaryMarkdown.trimEnd()] : []));
  if (values['summary-file'] !== undefined) {
    if (summaries.length > 0) await writeFile(values['summary-file'], `${summaries.join('\n\n')}\n`);
    else process.stderr.write(`No run published a write-up, so ${values['summary-file']} was not written.\n`);
  }
  process.stdout.write(values.json ? `${JSON.stringify(run, null, 2)}\n` : proofSummary(run));
  return values['no-wait'] || run.verdict === 'passed' ? 0 : 1;
}

function proofSummary(run: ProofRun): string {
  const pullRequest = run.pullRequest ? `${run.pullRequest.repository}#${run.pullRequest.number}` : `${run.change!.reviewKey} at ${run.change!.headSha.slice(0, 12)}`;
  const lines = run.runs.map((entry) => `  ${entry.platform ?? entry.build.platform} run ${entry.id} (build ${entry.build.buildId}): ${entry.verdict ?? entry.status}${entry.label ? ` (${entry.label})` : ''}`);
  const warnings = run.runs.flatMap((entry) => ('warnings' in entry.build ? entry.build.warnings : [])).map((warning) => `Warning: ${warning}`);
  const outcome = run.verdict ? `Proof of Changes for ${pullRequest}: ${run.verdict}${run.label ? ` (${run.label})` : ''}.` : `Started Proof of Changes for ${pullRequest}.`;
  return [outcome, ...lines, ...(run.reportUrl ? [`Report: ${run.reportUrl}`] : []), ...warnings, ''].join('\n');
}

async function envCommand(args: string[]): Promise<number> {
  const separator = args.indexOf('--');
  const command = separator === -1 ? [] : args.slice(separator + 1);
  if (command.length === 0) throw new VerifyError('INVALID_ARGUMENT', 'verify env needs a command to run after --, for example: verify env --start "docker compose up -d" --expose API_URL=8080 -- node verify/proof.mts');
  const { values, positionals } = parseArgs({
    args: args.slice(0, separator),
    allowPositionals: true,
    options: {
      start: { type: 'string' },
      stop: { type: 'string' },
      seed: { type: 'string' },
      expose: { type: 'string', multiple: true },
      ready: { type: 'string', multiple: true },
      'ready-timeout': { type: 'string' },
      'show-urls': { type: 'boolean' },
    },
  });
  if (positionals.length > 0) throw new VerifyError('INVALID_ARGUMENT', `verify env: unexpected ${positionals[0]}. Quote the start command with --start "<command>", and put the command to run after --.`);
  const expose = Object.fromEntries((values.expose ?? []).map((entry) => {
    const [name, port] = splitPair(entry, '--expose', 'NAME=port');
    if (!/^[0-9]+$/.test(port)) throw new VerifyError('INVALID_ARGUMENT', `--expose ${entry}: the port must be a number.`);
    return [name, Number(port)];
  }));
  const ready = Object.fromEntries((values.ready ?? []).map((entry) => splitPair(entry, '--ready', 'NAME=/path')));
  if (values['ready-timeout'] !== undefined && !/^[1-9][0-9]*$/.test(values['ready-timeout'])) throw new VerifyError('INVALID_ARGUMENT', '--ready-timeout must be a positive number of seconds.');

  const setup = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) process.exit(signal === 'SIGINT' ? 130 : 143);
    interrupted = signal;
    process.stderr.write(`\n[verify] ${signal}: stopping, then tearing the environment down. Send it again to exit now and leave processes behind.\n`);
    if (!child) {
      setup.abort(new VerifyError('ENVIRONMENT_START_FAILED', `Interrupted by ${signal} during setup.`));
      return;
    }
    try {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    let env: Environment;
    try {
      env = await environment({
        ...(values.start ? { start: values.start } : {}),
        ...(values.stop ? { stop: values.stop } : {}),
        ...(values.seed ? { seed: values.seed } : {}),
        expose,
        ready,
        ...(values['ready-timeout'] ? { readyTimeoutMs: Number(values['ready-timeout']) * 1000 } : {}),
        showUrls: values['show-urls'] ?? false,
        signal: setup.signal,
      });
    } catch (error) {
      if (interrupted) {
        process.stderr.write(`${isVerifyError(error) ? `${error.code}: ` : ''}${errorMessage(error)}\n`);
        return interrupted === 'SIGINT' ? 130 : 143;
      }
      throw error;
    }
    let code: number;
    try {
      const [file, ...fileArgs] = command as [string, ...string[]];
      const terminal = Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.CI;
      const redact = !(values['show-urls'] ?? false) && !terminal;
      const running = spawn(file, fileArgs, { stdio: redact ? ['inherit', 'pipe', 'pipe'] : 'inherit', detached: true, env: { ...process.env, ...env.variables } });
      child = running;
      const relayed = redact ? [relayRedacted(running.stdout!, process.stdout), relayRedacted(running.stderr!, process.stderr)] : [];
      code = await new Promise<number>((resolve) => {
        running.once('error', (error) => {
          process.stderr.write(`verify env: could not run ${file}: ${errorMessage(error)}\n`);
          resolve(127);
        });
        running.once('exit', (exitCode, signal) => resolve(exitCode ?? 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGKILL' ? 9 : 15)));
      });
      await Promise.race([Promise.all(relayed), delay(RELAY_FLUSH_MS)]);
      running.stdout?.destroy();
      running.stderr?.destroy();
    } catch (error) {
      await env.close().catch((cleanupError: unknown) => process.stderr.write(`${errorMessage(cleanupError)}\n`));
      throw error;
    }
    try {
      await env.close();
    } catch (error) {
      process.stderr.write(`${isVerifyError(error) ? `${error.code}: ` : ''}${errorMessage(error)}\n`);
      return code === 0 ? 1 : code;
    }
    return code;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** Copies a stream line by line with every quick-tunnel URL replaced, so the wrapped command can't print one into a CI log. */
function relayRedacted(from: NodeJS.ReadableStream, to: NodeJS.WritableStream): Promise<void> {
  const lines = createLineReader({ input: from, crlfDelay: Infinity });
  lines.on('line', (line) => to.write(`${line.replace(QUICK_TUNNEL_URL, '<tunnel url>')}\n`));
  return new Promise((resolve) => lines.once('close', resolve));
}

function splitPair(entry: string, flag: string, shape: string): [string, string] {
  const separator = entry.indexOf('=');
  if (separator <= 0 || separator === entry.length - 1) throw new VerifyError('INVALID_ARGUMENT', `${flag} takes ${shape}, got ${JSON.stringify(entry)}.`);
  return [entry.slice(0, separator), entry.slice(separator + 1)];
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

async function logoutCommand(): Promise<number> {
  try {
    await rm(revylCredentialsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new VerifyError('AUTH_MISSING', `Could not remove ~/.revyl/credentials.json: ${errorMessage(error)}`);
    process.stdout.write('No saved Revyl login on this computer.\n');
    return 0;
  }
  process.stdout.write('Signed out: removed ~/.revyl/credentials.json, which the Revyl CLI shares. The API key it held still works until you delete it in Revyl (Settings → API keys).\n');
  if (process.env.REVYL_API_KEY?.trim()) process.stdout.write('REVYL_API_KEY is still set in this environment, so Verify keeps using it.\n');
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    process.stderr.write(`Verify needs Node.js 22.18 or later; this is Node.js ${process.version}.\n`);
    return 1;
  }
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
