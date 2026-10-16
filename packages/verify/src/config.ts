import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import { VerifyError } from './errors.js';
import type { MobilePlatform } from './api/types.js';

export interface WebAppConfig {
  /** The Revyl web app this target belongs to. */
  appId: string;
  /** A public HTTPS URL to test, such as a preview deployment. Registered as a build on each run. */
  url?: string;
  /** An exact Revyl build to open instead of a URL. */
  buildId?: string;
  /** Revyl branch to register the URL on, or to take the newest build from. */
  branch?: string;
}

export interface WebTargetConfig {
  platform: 'web';
  name?: string;
  app: WebAppConfig;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  /** A test-only sign-in route Revyl opens before the session starts. See docs/web.md. */
  signIn?: { path: string; secret: string; persona?: string };
  startTimeout?: number;
  idleTimeoutSeconds?: number;
}

export interface MobileAppConfig {
  /** A Revyl app; the session installs its newest build. */
  appId?: string;
  /** An exact Revyl build to install. */
  buildId?: string;
  /** A downloadable .apk, .app.zip or .ipa to install. */
  artifactUrl?: string;
  /** The app to launch: required when nothing is installed, such as a system app. */
  bundleId?: string;
}

export interface MobileTargetConfig {
  platform: MobilePlatform;
  name?: string;
  app: MobileAppConfig;
  device?: { model?: string; osVersion?: string };
  startTimeout?: number;
  idleTimeoutSeconds?: number;
}

export type TargetConfig = WebTargetConfig | MobileTargetConfig;

export type ReporterName = 'list' | 'json';

export interface VerifyConfig {
  targets: TargetConfig[];
  tests?: string | string[];
  timeout?: number;
  actionTimeout?: number;
  assertionTimeout?: number;
  agentTimeout?: number;
  retries?: number;
  workers?: number;
  reuseSessions?: boolean;
  outputDir?: string;
  reporters?: ReporterName[];
}

export type ResolvedTarget = (WebTargetConfig | MobileTargetConfig) & {
  name: string;
  startTimeout: number;
  idleTimeoutSeconds: number;
};

export interface ResolvedConfig {
  rootDir: string;
  configFile: string;
  targets: ResolvedTarget[];
  tests: string[];
  timeout: number;
  actionTimeout: number;
  assertionTimeout: number;
  agentTimeout: number;
  retries: number;
  workers: number;
  reuseSessions: boolean;
  outputDir: string;
  reporters: ReporterName[];
}

export const CONFIG_FILE_NAMES = ['verify.config.ts', 'verify.config.mts', 'verify.config.js', 'verify.config.mjs'];
export const DEFAULT_TEST_GLOB = 'tests/**/*.verify.{ts,mts,js,mjs}';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB_URL = /^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/;
const TARGET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLATFORMS = ['web', 'ios', 'android'] as const;

export function defineConfig(config: VerifyConfig): VerifyConfig {
  return config;
}

export function findConfigFile(rootDir: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(rootDir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<ResolvedConfig> {
  const configFile = explicitPath ? resolve(cwd, explicitPath) : findConfigFile(cwd);
  if (!configFile || !existsSync(configFile)) {
    throw new VerifyError(
      'CONFIG_NOT_FOUND',
      explicitPath
        ? `Config file not found: ${explicitPath}`
        : `No verify.config.ts in ${cwd}. Run 'npx @revyl/verify init' to create one.`,
    );
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
  let loaded: unknown;
  try {
    loaded = await jiti.import(configFile, { default: true });
  } catch (error) {
    throw new VerifyError('CONFIG_INVALID', `Could not load ${configFile}: ${(error as Error).message}`, { cause: error });
  }
  return validateConfig(loaded, configFile);
}

export function validateConfig(raw: unknown, configFile: string): ResolvedConfig {
  const fail = (path: string, problem: string): never => {
    throw new VerifyError('CONFIG_INVALID', `${configFile}: ${path} ${problem}`);
  };
  const config = asRecord(raw, 'the default export', fail);
  rejectUnknownKeys(
    config,
    ['targets', 'tests', 'timeout', 'actionTimeout', 'assertionTimeout', 'agentTimeout', 'retries', 'workers', 'reuseSessions', 'outputDir', 'reporters'],
    '',
    fail,
  );
  if (!Array.isArray(config.targets) || config.targets.length === 0) fail('targets', 'must list at least one target.');
  const targets = (config.targets as unknown[]).map((target, index) => validateTarget(target, `targets[${index}]`, fail));
  const names = new Set<string>();
  for (const target of targets) {
    if (names.has(target.name)) fail('targets', `has two targets named "${target.name}"; give each a unique name.`);
    names.add(target.name);
  }

  const tests = config.tests === undefined ? [DEFAULT_TEST_GLOB] : Array.isArray(config.tests) ? config.tests : [config.tests];
  if (tests.length === 0 || tests.some((glob) => typeof glob !== 'string' || glob.trim() === '')) {
    fail('tests', 'must be a glob or a non-empty list of globs.');
  }
  const reporters = config.reporters ?? ['list', 'json'];
  if (!Array.isArray(reporters) || reporters.some((name) => name !== 'list' && name !== 'json')) {
    fail('reporters', "may contain only 'list' and 'json'.");
  }
  if (config.reuseSessions !== undefined && typeof config.reuseSessions !== 'boolean') fail('reuseSessions', 'must be a boolean.');
  if (config.outputDir !== undefined && (typeof config.outputDir !== 'string' || config.outputDir === '')) {
    fail('outputDir', 'must be a non-empty path.');
  }
  const rootDir = resolve(configFile, '..');
  return {
    rootDir,
    configFile,
    targets,
    tests: tests as string[],
    timeout: integer(config.timeout, 'timeout', 1_000, 3_600_000, 300_000, fail),
    actionTimeout: integer(config.actionTimeout, 'actionTimeout', 100, 600_000, 15_000, fail),
    assertionTimeout: integer(config.assertionTimeout, 'assertionTimeout', 100, 600_000, 10_000, fail),
    agentTimeout: integer(config.agentTimeout, 'agentTimeout', 1_000, 3_600_000, 180_000, fail),
    retries: integer(config.retries, 'retries', 0, 10, process.env.CI ? 1 : 0, fail),
    workers: integer(config.workers, 'workers', 1, 64, 1, fail),
    reuseSessions: (config.reuseSessions as boolean | undefined) ?? true,
    outputDir: resolve(rootDir, (config.outputDir as string | undefined) ?? '.verify'),
    reporters: reporters as ReporterName[],
  };
}

type Fail = (path: string, problem: string) => never;

function validateTarget(raw: unknown, path: string, fail: Fail): ResolvedTarget {
  const target = asRecord(raw, path, fail);
  const platform = target.platform;
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    fail(`${path}.platform`, "must be 'web', 'ios', or 'android'.");
  }
  const name = target.name ?? platform;
  if (typeof name !== 'string' || !TARGET_NAME.test(name)) {
    fail(`${path}.name`, 'must be 1-64 letters, digits, dots, dashes, or underscores.');
  }
  const common = {
    name: name as string,
    startTimeout: integer(target.startTimeout, `${path}.startTimeout`, 10_000, 1_800_000, 600_000, fail),
    idleTimeoutSeconds: integer(target.idleTimeoutSeconds, `${path}.idleTimeoutSeconds`, 60, 3_600, 600, fail),
  };
  const app = asRecord(target.app, `${path}.app`, fail);

  if (platform === 'web') {
    rejectUnknownKeys(target, ['platform', 'name', 'app', 'viewport', 'signIn', 'startTimeout', 'idleTimeoutSeconds'], path, fail);
    rejectUnknownKeys(app, ['appId', 'url', 'buildId', 'branch'], `${path}.app`, fail);
    uuid(app.appId, `${path}.app.appId`, true, fail);
    uuid(app.buildId, `${path}.app.buildId`, false, fail);
    if (app.url !== undefined && (typeof app.url !== 'string' || app.url.length > 2048 || !WEB_URL.test(app.url))) {
      fail(`${path}.app.url`, 'must be a public HTTPS URL without credentials, query, or fragment. Revyl cannot reach localhost.');
    }
    if (app.url !== undefined && app.buildId !== undefined) fail(`${path}.app`, 'takes url or buildId, not both.');
    optionalString(app.branch, `${path}.app.branch`, 255, fail);
    if (app.branch !== undefined && app.buildId !== undefined) fail(`${path}.app`, 'takes branch or buildId, not both.');
    let viewport: WebTargetConfig['viewport'];
    if (target.viewport !== undefined) {
      const raw = asRecord(target.viewport, `${path}.viewport`, fail);
      rejectUnknownKeys(raw, ['width', 'height', 'deviceScaleFactor'], `${path}.viewport`, fail);
      viewport = {
        width: integer(raw.width, `${path}.viewport.width`, 320, 3840, undefined, fail),
        height: integer(raw.height, `${path}.viewport.height`, 240, 2160, undefined, fail),
      };
      if (raw.deviceScaleFactor !== undefined) {
        const factor = raw.deviceScaleFactor;
        if (typeof factor !== 'number' || !(factor >= 1 && factor <= 3)) fail(`${path}.viewport.deviceScaleFactor`, 'must be from 1 to 3.');
        viewport.deviceScaleFactor = factor as number;
      }
    }
    let signIn: WebTargetConfig['signIn'];
    if (target.signIn !== undefined) {
      const raw = asRecord(target.signIn, `${path}.signIn`, fail);
      rejectUnknownKeys(raw, ['path', 'secret', 'persona'], `${path}.signIn`, fail);
      if (typeof raw.path !== 'string' || !/^\/(?!\/)[^?#\\\s]{0,511}$/.test(raw.path)) {
        fail(`${path}.signIn.path`, 'must be a path starting with one / and no query, fragment, or whitespace.');
      }
      if (typeof raw.secret !== 'string' || raw.secret.trim() === '') {
        fail(`${path}.signIn.secret`, 'must name an organization secret launch variable (its name, never its value).');
      }
      if (raw.persona !== undefined && (typeof raw.persona !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(raw.persona))) {
        fail(`${path}.signIn.persona`, 'must match [a-z0-9_-]{1,32}.');
      }
      signIn = { path: raw.path as string, secret: raw.secret as string, ...(raw.persona ? { persona: raw.persona as string } : {}) };
    }
    return {
      ...common,
      platform: 'web',
      app: {
        appId: app.appId as string,
        ...(app.url !== undefined ? { url: app.url as string } : {}),
        ...(app.buildId !== undefined ? { buildId: app.buildId as string } : {}),
        ...(app.branch !== undefined ? { branch: app.branch as string } : {}),
      },
      ...(viewport ? { viewport } : {}),
      ...(signIn ? { signIn } : {}),
    };
  }

  rejectUnknownKeys(target, ['platform', 'name', 'app', 'device', 'startTimeout', 'idleTimeoutSeconds'], path, fail);
  rejectUnknownKeys(app, ['appId', 'buildId', 'artifactUrl', 'bundleId'], `${path}.app`, fail);
  uuid(app.appId, `${path}.app.appId`, false, fail);
  uuid(app.buildId, `${path}.app.buildId`, false, fail);
  optionalString(app.bundleId, `${path}.app.bundleId`, 255, fail);
  if (app.artifactUrl !== undefined && (typeof app.artifactUrl !== 'string' || !/^https:\/\//.test(app.artifactUrl))) {
    fail(`${path}.app.artifactUrl`, 'must be an HTTPS URL.');
  }
  const installs = [app.appId, app.buildId, app.artifactUrl].filter((value) => value !== undefined).length;
  if (installs > 1) fail(`${path}.app`, 'takes only one of appId, buildId, or artifactUrl.');
  if (installs === 0 && app.bundleId === undefined) {
    fail(`${path}.app`, 'needs appId, buildId, or artifactUrl to install an app, or bundleId to open one already on the device.');
  }
  let device: MobileTargetConfig['device'];
  if (target.device !== undefined) {
    const raw = asRecord(target.device, `${path}.device`, fail);
    rejectUnknownKeys(raw, ['model', 'osVersion'], `${path}.device`, fail);
    optionalString(raw.model, `${path}.device.model`, 128, fail);
    optionalString(raw.osVersion, `${path}.device.osVersion`, 64, fail);
    device = {
      ...(raw.model !== undefined ? { model: raw.model as string } : {}),
      ...(raw.osVersion !== undefined ? { osVersion: raw.osVersion as string } : {}),
    };
  }
  return {
    ...common,
    platform: platform as MobilePlatform,
    app: {
      ...(app.appId !== undefined ? { appId: app.appId as string } : {}),
      ...(app.buildId !== undefined ? { buildId: app.buildId as string } : {}),
      ...(app.artifactUrl !== undefined ? { artifactUrl: app.artifactUrl as string } : {}),
      ...(app.bundleId !== undefined ? { bundleId: app.bundleId as string } : {}),
    },
    ...(device ? { device } : {}),
  };
}

function asRecord(raw: unknown, path: string, fail: Fail): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(path, 'must be an object.');
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: string[], path: string, fail: Fail): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, `is not a known option. Known: ${allowed.join(', ')}.`);
  }
}

function integer(raw: unknown, path: string, min: number, max: number, fallback: number | undefined, fail: Fail): number {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) fail(path, `must be an integer from ${min} to ${max}.`);
  return raw as number;
}

function uuid(raw: unknown, path: string, required: boolean, fail: Fail): void {
  if (raw === undefined && !required) return;
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    fail(path, `${required ? 'is required and ' : ''}must be a Revyl id (a UUID); copy it from the app's page in Revyl.`);
  }
}

function optionalString(raw: unknown, path: string, maxLength: number, fail: Fail): void {
  if (raw === undefined) return;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > maxLength) fail(path, `must be a non-empty string of at most ${maxLength} characters.`);
}
