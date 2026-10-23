import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Platform } from '../api/types.js';
import { VerifyError } from '../errors.js';

export interface InitAnswers {
  platform: Platform;
  appId?: string;
  url?: string;
}

export interface InitResult {
  created: string[];
  gitignoreUpdated: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG_FILE = 'verify.config.ts';
const EXAMPLE_SCRIPT = join('verify', 'example.ts');

export function validateInitAnswers(answers: InitAnswers): InitAnswers {
  if (!['web', 'ios', 'android', 'mac'].includes(answers.platform)) {
    throw new VerifyError('INVALID_ARGUMENT', "--platform must be 'web', 'ios', 'android', or 'mac'. Linux computers are not available yet.");
  }
  if (answers.platform === 'mac' && answers.appId !== undefined) {
    throw new VerifyError('INVALID_ARGUMENT', '--app-id does not apply to Mac computers.');
  }
  if (answers.appId !== undefined && !UUID.test(answers.appId)) {
    throw new VerifyError('INVALID_ARGUMENT', '--app-id must be a Revyl app id (a UUID).');
  }
  if (answers.url !== undefined) {
    if (answers.platform !== 'web') throw new VerifyError('INVALID_ARGUMENT', '--url applies to web targets only.');
    if (!/^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/.test(answers.url)) {
      throw new VerifyError('INVALID_ARGUMENT', '--url must be a public HTTPS URL without credentials, query, or fragment.');
    }
  }
  return answers;
}

export async function initProject(cwd: string, answers: InitAnswers, options: { force?: boolean } = {}): Promise<InitResult> {
  validateInitAnswers(answers);
  const files: Array<[string, string]> = [
    [CONFIG_FILE, configTemplate(answers)],
    [EXAMPLE_SCRIPT, scriptTemplate(answers.platform)],
  ];
  const existing = files.map(([path]) => path).filter((path) => existsSync(join(cwd, path)));
  if (existing.length > 0 && !options.force) {
    throw new VerifyError('INVALID_ARGUMENT', `${existing.join(' and ')} already exist. Re-run with --force to overwrite.`);
  }
  for (const [path, content] of files) {
    await mkdir(join(cwd, path, '..'), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  return { created: files.map(([path]) => relative(cwd, join(cwd, path))), gitignoreUpdated: await ignoreOutput(cwd) };
}

async function ignoreOutput(cwd: string): Promise<boolean> {
  const path = join(cwd, '.gitignore');
  const current = existsSync(path) ? await readFile(path, 'utf8') : '';
  if (current.split(/\r?\n/).some((line) => ['.verify', '.verify/', '/.verify', '/.verify/'].includes(line.trim()))) return false;
  await appendFile(path, `${current === '' || current.endsWith('\n') ? '' : '\n'}.verify/\n`);
  return true;
}

function configTemplate({ platform, appId, url }: InitAnswers): string {
  const app = appId ? `'${appId}'` : `process.env.REVYL_APP_ID ?? 'REPLACE_WITH_YOUR_REVYL_APP_ID'`;
  const target =
    platform === 'mac'
      ? `    mac: { platform: 'mac' },`
      : platform === 'web'
      ? `    web: {
      platform: 'web',
      app: {
        // The Revyl web app to open: copy its id from the app's page in Revyl.
        appId: ${app},
        // A public HTTPS URL, such as a preview deployment. Remove it to open the app's newest Revyl build.
        url: '${url ?? 'https://example.com'}',
      },
      viewport: { width: 1280, height: 800 },
    },`
      : `    ${platform}: {
      platform: '${platform}',
      app: {
        // The Revyl app to install: each session installs its newest build. Use buildId to pin one build.
        appId: ${app},
      },
    },`;
  return `import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: {
${target}
  },
});
`;
}

function scriptTemplate(platform: Platform): string {
  if (platform === 'mac') {
    return `// Mac computers are in early access; ask support@revyl.ai to enable your organization.
import assert from 'node:assert/strict';
import { open } from '@revyl/verify';

const session = await open('mac');
try {
  const result = await session.exec(['uname', '-s']);
  assert.equal(result.stdout.trim(), 'Darwin');
  await session.writeFile('hello.txt', 'Hello from Verify!\\n');
  assert.equal((await session.readFile('hello.txt')).toString('utf8'), 'Hello from Verify!\\n');
  assert.equal((await session.stat('hello.txt')).kind, 'file');
} finally {
  await session.close();
}
`;
  }
  const steps =
    platform === 'web'
      ? `await session.instruction('Follow the link on the page');
await session.validation('A page about domains reserved for documentation is shown');`
      : `// Describe what a person would do and see, for example:
// await session.instruction('Sign in as the demo user and open Settings');
await session.validation('The app has opened and shows its first screen without an error');`;
  return `import { open } from '@revyl/verify';

// Opens the "${platform}" target from verify.config.ts on Revyl and prints a link to watch it live.
// A failed instruction or validation throws, so this script exits non-zero, and Verify closes the session on the way out.
const session = await open('${platform}');
${steps}
await session.screenshot({ path: '.verify/example.png' });
await session.close();
`;
}
