import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../src/config.js';
import { APP_ID } from './helpers/fake-revyl.js';

const file = '/project/verify.config.ts';

describe('validateConfig', () => {
  it('fills defaults and names targets after their platform', () => {
    const config = validateConfig({ targets: [{ platform: 'android', app: { appId: APP_ID } }] }, file);
    expect(config.targets[0]).toMatchObject({ name: 'android', platform: 'android', startTimeout: 600_000, idleTimeoutSeconds: 600 });
    expect(config).toMatchObject({
      rootDir: '/project',
      tests: ['tests/**/*.verify.{ts,mts,js,mjs}'],
      workers: 1,
      reuseSessions: true,
      outputDir: '/project/.verify',
      reporters: ['list', 'json'],
    });
  });

  it('accepts a web target with a public URL, viewport, and test sign-in', () => {
    const config = validateConfig(
      {
        targets: [
          {
            platform: 'web',
            name: 'web-preview',
            app: { appId: APP_ID, url: 'https://preview.example.com/app', branch: 'main' },
            viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
            signIn: { path: '/__test/sign-in', secret: 'TEST_SIGN_IN_TOKEN', persona: 'admin' },
          },
        ],
      },
      file,
    );
    expect(config.targets[0]).toMatchObject({ name: 'web-preview', signIn: { secret: 'TEST_SIGN_IN_TOKEN' } });
  });

  it.each([
    [{ targets: [] }, 'targets must list at least one target'],
    [{ targets: [{ platform: 'web', app: { appId: APP_ID, url: 'http://localhost:3000' } }] }, 'Revyl cannot reach localhost'],
    [{ targets: [{ platform: 'web', app: { appId: 'abc' } }] }, 'must be a Revyl id'],
    [{ targets: [{ platform: 'ios', app: {} }] }, 'needs appId, buildId, or artifactUrl'],
    [{ targets: [{ platform: 'ios', app: { appId: APP_ID, buildId: APP_ID } }] }, 'only one of appId, buildId, or artifactUrl'],
    [{ targets: [{ platform: 'ios', app: { bundleId: 'com.x' }, colour: 'red' }] }, 'colour is not a known option'],
    [{ targets: [{ platform: 'ios', app: { bundleId: 'a' } }, { platform: 'ios', app: { bundleId: 'b' } }] }, 'two targets named "ios"'],
    [{ targets: [{ platform: 'tv', app: {} }] }, "must be 'web', 'ios', or 'android'"],
    [{ targets: [{ platform: 'ios', app: { bundleId: 'a' } }], workers: 0 }, 'workers must be an integer from 1 to 64'],
  ])('rejects %j', (raw, message) => {
    expect(() => validateConfig(raw, file)).toThrow(message);
  });
});

describe('loadConfig', () => {
  it('loads a TypeScript config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-config-'));
    await writeFile(
      join(dir, 'verify.config.ts'),
      `const retries: number = 2;\nexport default { retries, targets: [{ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }] };\n`,
    );
    const config = await loadConfig(dir);
    expect(config.retries).toBe(2);
    expect(config.targets[0]?.platform).toBe('ios');
  });

  it('points at init when there is no config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-config-'));
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND', message: expect.stringContaining('init') });
  });
});
