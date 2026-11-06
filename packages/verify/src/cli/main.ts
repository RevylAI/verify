#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials } from '../auth.js';
import { environment, type Environment } from '../environment.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { initProject, validateInitAnswers, type InitAnswers } from './init.js';
import { installVerify, packageHasVerify } from './install.js';
import { signIn } from './login.js';

const HELP = `verify ${VERSION}: open Revyl cloud browsers, devices, and computers from your code

Usage
  npx ${PACKAGE_NAME} init [--platform web|ios|android|mac] [--app-id <id>] [--url <https-url>] [--force] [--yes] [--no-install]
      Install Verify, write verify.config.ts and an example script, then check authentication
  npx ${PACKAGE_NAME} env [--start <command>] --expose NAME=port... [--ready NAME=/path]... [--stop <command>] [--seed <command>] [--ready-timeout <seconds>] [--show-urls] -- <command> [args...]
      Start a stack on this runner, give each port a public quick-tunnel URL, run the command with NAME=<url> in its
      environment, then tear everything down. URLs are hidden in logs unless --show-urls is passed
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
      return initCommand(rest);
    case 'env':
      return envCommand(rest);
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
    if (child?.pid) process.kill(-child.pid, signal);
    else setup.abort(new VerifyError('ENVIRONMENT_START_FAILED', `Interrupted by ${signal} during setup.`));
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
      const running = spawn(file, fileArgs, { stdio: 'inherit', detached: true, env: { ...process.env, ...env.variables } });
      child = running;
      code = await new Promise<number>((resolve) => {
        running.once('error', (error) => {
          process.stderr.write(`verify env: could not run ${file}: ${errorMessage(error)}\n`);
          resolve(127);
        });
        running.once('exit', (exitCode, signal) => resolve(exitCode ?? 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGKILL' ? 9 : 15)));
      });
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
