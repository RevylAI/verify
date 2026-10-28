import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { VerifyError } from './errors.js';
import type { ComputerPlatform, MobilePlatform } from './api/types.js';
import { PACKAGE_NAME } from './version.js';

export interface WebAppConfig {
  /** The Revyl web app this target belongs to. */
  appId: string;
  /** A public HTTPS URL to open, such as a preview deployment. Registered as a build each time a session opens. */
  url?: string;
  /** An exact Revyl build to open instead of a URL. */
  buildId?: string;
  /** Revyl branch to register the URL on, or to take the newest build from. */
  branch?: string;
}

export interface WebTargetConfig {
  platform: 'web';
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
  /** An app already on the device to launch instead of installing one, such as a system app. */
  bundleId?: string;
}

export interface MobileTargetConfig {
  platform: MobilePlatform;
  app: MobileAppConfig;
  device?: { model?: string; osVersion?: string };
  startTimeout?: number;
  idleTimeoutSeconds?: number;
}

/** A Revyl computer that runs commands and files instead of agent steps. See docs/computers.md. */
export interface ComputerTargetConfig {
  platform: ComputerPlatform;
  startTimeout?: number;
}

export type TargetConfig = WebTargetConfig | MobileTargetConfig | ComputerTargetConfig;

export type HostedTargetConfig = (Omit<WebTargetConfig, 'app'> | Omit<MobileTargetConfig, 'app' | 'device'>) & {
  app: { appId: string; buildId: string };
};

export interface VerifyConfig {
  /** Named targets that open() takes by name, such as open('web'). */
  targets: Record<string, TargetConfig>;
  /** Milliseconds one instruction or validation may run. Defaults to 180000. */
  stepTimeout?: number;
}

type Resolved<T> = T & { name: string; startTimeout: number };

export type ResolvedDeviceTarget = Resolved<(WebTargetConfig | MobileTargetConfig) & { idleTimeoutSeconds: number }>;
export type ResolvedComputerTarget = Resolved<ComputerTargetConfig & ({ platform: 'mac' } | { platform: 'linux' })>;
export type ResolvedTarget = ResolvedDeviceTarget | ResolvedComputerTarget;

export interface ResolvedConfig {
  configFile: string;
  targets: Record<string, ResolvedTarget>;
  stepTimeout: number;
}

export const CONFIG_FILE_NAMES = ['verify.config.ts', 'verify.config.mts', 'verify.config.js', 'verify.config.mjs'];
export const DEFAULT_STEP_TIMEOUT_MS = 180_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEB_URL = /^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/;
const TARGET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLATFORMS = ['web', 'ios', 'android', 'mac', 'linux'] as const;

export function defineConfig(config: VerifyConfig): VerifyConfig {
  return config;
}

/** The nearest verify.config file in the folder or any folder above it. */
export function findConfigFile(startDir: string): string | undefined {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

export async function loadConfig(cwd: string, explicitPath?: string): Promise<ResolvedConfig> {
  const configFile = explicitPath ? resolve(cwd, explicitPath) : findConfigFile(cwd);
  if (!configFile || !existsSync(configFile)) {
    throw new VerifyError(
      'CONFIG_NOT_FOUND',
      explicitPath
        ? `Config file not found: ${explicitPath}`
        : `No verify.config.ts in ${cwd} or any folder above it. Run 'npx ${PACKAGE_NAME} init' to create one, or pass a target object to open().`,
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
  const fail: Fail = (path, problem) => {
    throw new VerifyError('CONFIG_INVALID', `${configFile}: ${path} ${problem}`);
  };
  const config = asRecord(raw, 'the default export', fail);
  rejectUnknownKeys(config, ['targets', 'stepTimeout'], '', fail);
  const rawTargets = asRecord(config.targets, 'targets', fail);
  const names = Object.keys(rawTargets);
  if (names.length === 0) fail('targets', 'must name at least one target, such as { web: { platform: \'web\', ... } }.');
  const targets: Record<string, ResolvedTarget> = {};
  for (const name of names) {
    if (!TARGET_NAME.test(name)) fail(`targets.${name}`, 'must be named with 1-64 letters, digits, dots, dashes, or underscores.');
    targets[name] = parseTarget(rawTargets[name], name, `targets.${name}`, fail);
  }
  return {
    configFile,
    targets,
    stepTimeout: integer(config.stepTimeout, 'stepTimeout', 1_000, 3_600_000, DEFAULT_STEP_TIMEOUT_MS, fail),
  };
}

/** Validates a target passed straight to open(); it is named after its platform. */
export function validateTarget(raw: unknown): ResolvedTarget {
  const fail: Fail = (path, problem) => {
    throw new VerifyError('INVALID_ARGUMENT', `open(): ${path} ${problem}`);
  };
  const platform = asRecord(raw, 'target', fail).platform;
  return parseTarget(raw, typeof platform === 'string' ? platform : 'target', 'target', fail);
}

export function validateHostedTarget(raw: HostedTargetConfig): ResolvedDeviceTarget {
  const fail: Fail = (path, problem) => { throw new VerifyError('INVALID_ARGUMENT', `computer.open(): ${path} ${problem}`); };
  const target = parseTarget(raw, raw?.platform ?? 'target', 'target', fail, true);
  if (target.platform === 'mac' || target.platform === 'linux') fail('target.platform', 'must be web, ios, or android.');
  return target as ResolvedDeviceTarget;
}

type Fail = (path: string, problem: string) => never;

function parseTarget(raw: unknown, name: string, path: string, fail: Fail, hosted = false): ResolvedTarget {
  const target = asRecord(raw, path, fail);
  const platform = target.platform;
  if (typeof platform !== 'string' || !(PLATFORMS as readonly string[]).includes(platform)) {
    fail(`${path}.platform`, "must be 'web', 'ios', 'android', 'mac', or 'linux'.");
  }
  const startTimeout = integer(target.startTimeout, `${path}.startTimeout`, 10_000, 1_800_000, 600_000, fail);
  if (platform === 'mac' || platform === 'linux') {
    rejectUnknownKeys(target, ['platform', 'startTimeout'], path, fail);
    return { name, startTimeout, platform };
  }
  const common = {
    name,
    startTimeout,
    idleTimeoutSeconds: integer(target.idleTimeoutSeconds, `${path}.idleTimeoutSeconds`, 60, 3_600, 600, fail),
  };
  const app = asRecord(target.app, `${path}.app`, fail);
  if (hosted) {
    uuid(app.appId, `${path}.app.appId`, true, fail);
    uuid(app.buildId, `${path}.app.buildId`, true, fail);
    rejectUnknownKeys(app, ['appId', 'buildId'], `${path}.app`, fail);
    if (target.device !== undefined) fail(`${path}.device`, 'is fixed by the hosting computer.');
  }

  if (platform === 'web') {
    rejectUnknownKeys(target, ['platform', 'app', 'viewport', 'signIn', 'startTimeout', 'idleTimeoutSeconds'], path, fail);
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

  rejectUnknownKeys(target, ['platform', 'app', 'device', 'startTimeout', 'idleTimeoutSeconds'], path, fail);
  rejectUnknownKeys(app, ['appId', 'buildId', 'artifactUrl', 'bundleId'], `${path}.app`, fail);
  uuid(app.appId, `${path}.app.appId`, false, fail);
  uuid(app.buildId, `${path}.app.buildId`, false, fail);
  optionalString(app.bundleId, `${path}.app.bundleId`, 255, fail);
  if (app.artifactUrl !== undefined && (typeof app.artifactUrl !== 'string' || !/^https:\/\//.test(app.artifactUrl))) {
    fail(`${path}.app.artifactUrl`, 'must be an HTTPS URL.');
  }
  const sources = [app.appId, app.buildId, app.artifactUrl, app.bundleId].filter((value) => value !== undefined).length;
  if (!hosted && sources !== 1) {
    fail(`${path}.app`, 'takes exactly one of appId, buildId, or artifactUrl to install an app, or bundleId to open one already on the device.');
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
