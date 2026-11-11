#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { RevylClient } from '../api/client.js';
import type { Platform } from '../api/types.js';
import { missingCredentialsMessage, resolveCredentials, revylCredentialsPath } from '../auth.js';
import { VerifyError, errorMessage, isVerifyError } from '../errors.js';
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
  npx ${PACKAGE_NAME} whoami
      Check which Revyl account your credentials belong to

Authentication
  In a terminal, init, login, and your first open() sign you in through your browser and save the
  login to ~/.revyl/credentials.json, which the Revyl CLI shares. In CI, set REVYL_API_KEY instead.

Docs: ${DOCS}
`;

const INIT_HELP = `Usage: ${INIT_USAGE}

Writes verify.config.ts and verify/example.ts, installs Verify when the project lacks it, and signs
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
    case 'login':
      return signInAndCheck(Boolean(process.stdin.isTTY) && !process.env.CI);
    case 'logout':
      return logoutCommand();
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
      ? ['Mac computers are early access. Ask support@revyl.ai about access.', 'Once your organization has Mac access, run: node verify/example.ts']
      : answers.appId
        ? ['Run: node verify/example.ts']
        : ['Run: node verify/example.ts', 'To test your own app, put its Revyl app id in verify.config.ts in place of the Settings bundle id.'];
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
