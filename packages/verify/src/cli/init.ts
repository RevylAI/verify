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
const EXAMPLE_TEST = join('tests', 'example.verify.ts');

export function validateInitAnswers(answers: InitAnswers): InitAnswers {
  if (!['web', 'ios', 'android'].includes(answers.platform)) {
    throw new VerifyError('INVALID_ARGUMENT', "--platform must be 'web', 'ios', or 'android'.");
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

/** Writes verify.config.ts and an example test, and keeps run output out of git. */
export async function initProject(cwd: string, answers: InitAnswers, options: { force?: boolean } = {}): Promise<InitResult> {
  validateInitAnswers(answers);
  const files: Array<[string, string]> = [
    [CONFIG_FILE, configTemplate(answers)],
    [EXAMPLE_TEST, testTemplate(answers.platform)],
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
    platform === 'web'
      ? `    {
      platform: 'web',
      app: {
        // The Revyl web app to test: open it in Revyl and copy its id.
        appId: ${app},
        // A public HTTPS URL, such as a preview deployment. Remove it to open the app's newest Revyl build.
        url: '${url ?? 'https://example.com'}',
      },
      viewport: { width: 1280, height: 800 },
    },`
      : `    {
      platform: '${platform}',
      app: {
        // The Revyl app to install: each run installs its newest build. Use buildId to pin one build.
        appId: ${app},
      },
    },`;
  return `import { defineConfig } from '@revyl/verify';

export default defineConfig({
  targets: [
${target}
  ],
});
`;
}

function testTemplate(platform: Platform): string {
  if (platform === 'web') {
    return `import { expect, test } from '@revyl/verify';

test('the home page loads', async ({ screen }) => {
  // On web, screen locators find elements with Revyl's AI grounding, so describe what a person sees.
  await expect(screen.getByText('Example Domain')).toBeVisible();
  await screen.getByRole('link', { name: 'More information' }).tap();
  await expect(screen.locate('a page about IANA-managed reserved domains')).toBeVisible();
});
`;
  }
  return `import { expect, test } from '@revyl/verify';

test('the app opens to its first screen', async ({ screen, agent }) => {
  // Exact checks read the app's native UI tree: replace this with text from your first screen.
  await expect(screen.getByRole('button').first()).toBeVisible();

  // Natural-language steps run Revyl's agent on the device.
  await agent.assert('The app has finished loading and no error message is shown');
});
`;
}
