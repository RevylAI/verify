#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials } from '../auth.js';
import { loadConfig } from '../config.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { JsonReporter, ListReporter } from '../reporters.js';
import { collectJobs, runTests, type Reporter } from '../runner.js';
import { VERSION } from '../version.js';
import { initProject, validateInitAnswers, type InitAnswers } from './init.js';

const HELP = `verify ${VERSION}: end-to-end tests for web and mobile apps on Revyl

Usage
  verify init [--platform web|ios|android] [--app-id <id>] [--url <https-url>] [--force]
  verify run [file filters...] [options]
  verify whoami

Run options
  -c, --config <path>     Config file (default: verify.config.ts in the current folder)
  -t, --target <name>     Run only this target; repeat for several
  -g, --grep <regex>      Run only tests whose file, title, or target matches
  -j, --workers <n>       Sessions to run in parallel
      --retries <n>       Retries for failed tests
      --reporter <names>  Comma-separated: list, json (default: list,json)
      --list              List the tests that would run, without starting sessions
      --forbid-only       Fail if a test.only is present (on by default when CI is set)

Authentication
  REVYL_API_KEY, or a login from the Revyl CLI ('revyl auth login').

Docs: https://github.com/RevylAI/verify/tree/main/packages/verify/docs
`;

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
    case 'run':
    case 'test':
      return runCommand(rest);
    case 'init':
      return initCommand(rest);
    case 'whoami':
      return whoamiCommand();
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      target: { type: 'string', short: 't', multiple: true },
      grep: { type: 'string', short: 'g' },
      workers: { type: 'string', short: 'j' },
      retries: { type: 'string' },
      reporter: { type: 'string' },
      list: { type: 'boolean' },
      'forbid-only': { type: 'boolean' },
    },
  });
  const config = await loadConfig(process.cwd(), values.config);
  let grep: RegExp | undefined;
  if (values.grep !== undefined) {
    try {
      grep = new RegExp(values.grep, 'i');
    } catch {
      throw new VerifyError('INVALID_ARGUMENT', `--grep is not a valid regular expression: ${values.grep}`);
    }
  }
  const selection = {
    files: positionals,
    ...(grep ? { grep } : {}),
    ...(values.target ? { targets: values.target } : {}),
    forbidOnly: values['forbid-only'] ?? Boolean(process.env.CI),
  };

  if (values.list) {
    const { jobs, skipped } = await collectJobs(config, selection);
    for (const job of jobs) process.stdout.write(`[${job.target.name}] ${[job.file, ...job.test.titlePath].join(' › ')}\n`);
    process.stdout.write(`\n${jobs.length} to run, ${skipped.length} skipped\n`);
    return 0;
  }

  const credentials = await resolveCredentials();
  if (!credentials) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());
  const reporterNames = values.reporter ? values.reporter.split(',').map((name) => name.trim()) : config.reporters;
  const reporters: Reporter[] = reporterNames.map((name) => {
    if (name === 'list') return new ListReporter();
    if (name === 'json') return JsonReporter.inDir(config.outputDir);
    throw new VerifyError('INVALID_ARGUMENT', `Unknown reporter "${name}". Use list, json, or both.`);
  });

  const controller = new AbortController();
  let interrupts = 0;
  const onInterrupt = (): void => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    process.stderr.write('\nStopping: releasing Revyl sessions. Press Ctrl+C again to exit immediately.\n');
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  try {
    const summary = await runTests({
      config,
      client: new RevylClient({ token: credentials.token }),
      reporters,
      signal: controller.signal,
      ...selection,
      ...(values.workers !== undefined ? { workers: positiveInteger(values.workers, '--workers', 1, 64) } : {}),
      ...(values.retries !== undefined ? { retries: positiveInteger(values.retries, '--retries', 0, 10) } : {}),
    });
    if (summary.status === 'interrupted') return 130;
    if (summary.errors.some((error) => error.code && USAGE_CODES.has(error.code)) && summary.tests.length === 0) return 2;
    return summary.status === 'passed' ? 0 : 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
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
    },
  });
  let answers: InitAnswers;
  if (values.platform) {
    answers = validateInitAnswers({
      platform: values.platform as Platform,
      ...(values['app-id'] ? { appId: values['app-id'] } : {}),
      ...(values.url ? { url: values.url } : {}),
    });
  } else if (process.stdin.isTTY) {
    answers = await askInitQuestions(values['app-id'], values.url);
  } else {
    throw new VerifyError('INVALID_ARGUMENT', 'Pass --platform web, ios, or android when not running in a terminal.');
  }
  const result = await initProject(process.cwd(), answers, { force: values.force ?? false });
  const lines = [
    `Created ${result.created.join(' and ')}${result.gitignoreUpdated ? ', and added .verify/ to .gitignore' : ''}.`,
    '',
    'Next:',
    '  1. npm install --save-dev @revyl/verify',
    "  2. Authenticate: export REVYL_API_KEY=<key from Revyl settings>, or run 'revyl auth login'",
    ...(answers.appId ? [] : ['  3. Put your Revyl app id in verify.config.ts (or set REVYL_APP_ID)']),
    `  ${answers.appId ? 3 : 4}. npx verify run`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
  return 0;
}

async function askInitQuestions(appId: string | undefined, url: string | undefined): Promise<InitAnswers> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const platformAnswer = (await readline.question('What do you want to test? [web/ios/android] (web): ')).trim().toLowerCase() || 'web';
    const platform = platformAnswer as Platform;
    const id = appId ?? ((await readline.question('Revyl app id (Enter to fill in later): ')).trim() || undefined);
    const webUrl =
      platform === 'web' ? (url ?? ((await readline.question('HTTPS URL to test (Enter for https://example.com): ')).trim() || undefined)) : undefined;
    return validateInitAnswers({ platform, ...(id ? { appId: id } : {}), ...(webUrl ? { url: webUrl } : {}) });
  } finally {
    readline.close();
  }
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

const USAGE_CODES = new Set(['CONFIG_NOT_FOUND', 'CONFIG_INVALID', 'NO_TESTS', 'INVALID_ARGUMENT', 'AUTH_MISSING', 'ONLY_IN_CI']);

function positiveInteger(raw: string, flag: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new VerifyError('INVALID_ARGUMENT', `${flag} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export async function runCli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (error) {
    if (isVerifyError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return USAGE_CODES.has(error.code) || error.code === 'AUTH_REJECTED' ? 2 : 1;
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
