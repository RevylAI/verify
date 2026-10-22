import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineConfig, loadConfig, validateConfig, validateTarget, type ComputerTargetConfig } from '../src/config.js';
import { APP_ID } from './helpers/fake-revyl.js';

const file = '/project/verify.config.ts';

describe('validateConfig', () => {
  it('names targets after their keys and fills defaults', () => {
    const config = validateConfig({ targets: { pixel: { platform: 'android', app: { appId: APP_ID } } } }, file);
    expect(config.targets.pixel).toMatchObject({ name: 'pixel', platform: 'android', startTimeout: 600_000, idleTimeoutSeconds: 600 });
    expect(config.stepTimeout).toBe(180_000);
  });

  it('accepts a web target with a public URL, viewport, and test sign-in', () => {
    const config = validateConfig(
      {
        targets: {
          'web-preview': {
            platform: 'web',
            app: { appId: APP_ID, url: 'https://preview.example.com/app', branch: 'main' },
            viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
            signIn: { path: '/__test/sign-in', secret: 'TEST_SIGN_IN_TOKEN', persona: 'admin' },
          },
        },
        stepTimeout: 60_000,
      },
      file,
    );
    expect(config.targets['web-preview']).toMatchObject({ name: 'web-preview', signIn: { secret: 'TEST_SIGN_IN_TOKEN' } });
    expect(config.stepTimeout).toBe(60_000);
  });

  it.each([
    [{ targets: {} }, 'targets must name at least one target'],
    [{ targets: [{ platform: 'web' }] }, 'targets must be an object'],
    [{ targets: { web: { platform: 'web', app: { appId: APP_ID, url: 'http://localhost:3000' } } } }, 'Revyl cannot reach localhost'],
    [{ targets: { web: { platform: 'web', app: { appId: 'abc' } } } }, 'must be a Revyl id'],
    [{ targets: { ios: { platform: 'ios', app: {} } } }, 'takes exactly one of appId, buildId, or artifactUrl'],
    [{ targets: { ios: { platform: 'ios', app: { appId: APP_ID, bundleId: 'com.x' } } } }, 'takes exactly one of'],
    [{ targets: { ios: { platform: 'ios', app: { bundleId: 'com.x' }, colour: 'red' } } }, 'colour is not a known option'],
    [{ targets: { 'my phone': { platform: 'ios', app: { bundleId: 'a' } } } }, 'must be named with'],
    [{ targets: { tv: { platform: 'tv', app: {} } } }, "must be 'web', 'ios', 'android', 'mac', or 'linux'"],
    [{ targets: { ios: { platform: 'ios', app: { bundleId: 'a' } } }, retries: 2 }, 'retries is not a known option'],
  ])('rejects %j', (raw, message) => {
    expect(() => validateConfig(raw, file)).toThrow(message);
  });
});

describe('validateTarget', () => {
  it('accepts typed Mac and Linux targets without an app', () => {
    const linux: ComputerTargetConfig = { platform: 'linux' };
    const config = defineConfig({ targets: { linux, mac: { platform: 'mac' } } });
    expect(validateConfig(config, file).targets.linux).toMatchObject({ platform: 'linux', name: 'linux' });
    expect(validateTarget({ platform: 'mac' })).toMatchObject({ platform: 'mac' });
    expect(() => validateTarget({ platform: 'mac', app: {} })).toThrow('not a known option');
  });
  it('names an inline target after its platform and reports problems as argument errors', () => {
    expect(validateTarget({ platform: 'ios', app: { bundleId: 'com.apple.Preferences' } }).name).toBe('ios');
    expect(() => validateTarget({ platform: 'ios', app: {} })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('loadConfig', () => {
  it('loads the nearest TypeScript config at or above the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-config-'));
    await writeFile(
      join(dir, 'verify.config.ts'),
      `const stepTimeout: number = 90_000;\nexport default { stepTimeout, targets: { ios: { platform: 'ios', app: { bundleId: 'com.apple.Preferences' } } } };\n`,
    );
    await mkdir(join(dir, 'scripts', 'deep'), { recursive: true });
    const config = await loadConfig(join(dir, 'scripts', 'deep'));
    expect(config.stepTimeout).toBe(90_000);
    expect(config.targets.ios?.platform).toBe('ios');
  });

  it('points at init when there is no config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-config-'));
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND', message: expect.stringContaining('init') });
  });
});
