#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials } from '../auth.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { initProject, validateInitAnswers, type InitAnswers } from './init.js';

const HELP = `verify ${VERSION}: open Revyl cloud browsers, devices, and computers from your code

Usage
  npx ${PACKAGE_NAME} init [--platform web|ios|android|mac] [--app-id <id>] [--url <https-url>] [--force]
      Write verify.config.ts and an example script, verify/example.ts
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
    throw new VerifyError('INVALID_ARGUMENT', 'Pass --platform web, ios, android, or mac when not running in a terminal.');
  }
  const result = await initProject(process.cwd(), answers, { force: values.force ?? false });
  const steps = [
    `npm install --save-dev ${PACKAGE_NAME}`,
    "Authenticate: export REVYL_API_KEY=<key from Revyl settings>, or run 'revyl auth login'",
    ...(answers.platform === 'mac' ? ['Mac computers are early access. Ask support@revyl.ai about access.'] : []),
    ...(answers.platform === 'mac' || answers.appId ? [] : ['Put your Revyl app id in verify.config.ts (or set REVYL_APP_ID)']),
    'node verify/example.ts',
  ];
  process.stdout.write(
    [
      `Created ${result.created.join(' and ')}${result.gitignoreUpdated ? ', and added .verify/ to .gitignore' : ''}.`,
      '',
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
