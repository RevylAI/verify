import { RevylClient } from './api/client.js';
import { missingCredentialsMessage, resolveCredentials, type Credentials } from './auth.js';
import { signIn } from './cli/login.js';
import { DEFAULT_STEP_TIMEOUT_MS, loadConfig, validateTarget, type ResolvedTarget, type TargetConfig } from './config.js';
import { VerifyError } from './errors.js';
import { DeviceSession, type OpenedSession } from './session.js';
import { ComputerSession } from './computer-session.js';
import type { LocalAgent } from './agent/loop.js';
import { chooseAgent, type ModelOption } from './agent/providers.js';

export interface OpenOptions {
  /** The config file to read target names from. Defaults to the nearest verify.config.ts at or above the current folder. */
  config?: string;
  /** Where progress lines go: the session link and each step's outcome. Defaults to stderr; false turns them off. */
  log?: false | ((line: string) => void);
  backendUrl?: string;
  appUrl?: string;
  /** Runs every instruction and validation on your model, such as 'anthropic/claude-sonnet-5-5', instead of Revyl's agent. Browsers and devices only. */
  model?: ModelOption;
  /** Runs every instruction and validation on a custom agent from localAgent(). Pass model or agent, not both. */
  agent?: LocalAgent;
}

export interface AttachOptions extends Pick<OpenOptions, 'log' | 'backendUrl' | 'appUrl'> {
  stopOnClose?: boolean;
}

const signIns = new Map<string, Promise<Credentials>>();

async function credentialsForUse(options: Pick<OpenOptions, 'backendUrl' | 'appUrl'>): Promise<Credentials> {
  const credentials = await resolveCredentials();
  if (credentials) return credentials;
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.CI) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());
  const key = JSON.stringify([options.backendUrl, options.appUrl]);
  let pending = signIns.get(key);
  if (!pending) {
    pending = signIn(options).finally(() => signIns.delete(key));
    signIns.set(key, pending);
  }
  return pending;
}

export async function attach(computerId: string, options: AttachOptions = {}): Promise<ComputerSession> {
  if (typeof computerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(computerId)) throw new VerifyError('INVALID_ARGUMENT', 'attach() requires a computer session UUID.');
  if (options.stopOnClose !== undefined && typeof options.stopOnClose !== 'boolean') throw new VerifyError('INVALID_ARGUMENT', 'stopOnClose must be a boolean.');
  const credentials = await credentialsForUse(options);
  const log = options.log === false ? undefined : (options.log ?? ((line: string) => void process.stderr.write(`[verify] ${line}\n`)));
  return ComputerSession.attach(new RevylClient({ token: credentials.token, backendUrl: options.backendUrl }), computerId, { stepTimeout: DEFAULT_STEP_TIMEOUT_MS, log, appUrl: options.appUrl, stopOnClose: options.stopOnClose });
}

export async function currentComputer(options: AttachOptions = {}): Promise<ComputerSession> {
  const computerId = process.env.REVYL_COMPUTER_ID?.trim();
  if (!computerId) throw new VerifyError('COMPUTER_ID_MISSING', 'No current Revyl computer is available. Run this job on a revyl-macos runner.');
  return attach(computerId, { ...options, stopOnClose: options.stopOnClose === undefined ? false : options.stopOnClose });
}

/**
 * Starts a Revyl cloud browser, device, or computer. Mobile first-screen readiness is best-effort.
 * Pass a target name from verify.config.ts, such as open('web'), or a target object.
 */
export async function open(target: string | TargetConfig, options: OpenOptions = {}): Promise<OpenedSession> {
  let resolved: ResolvedTarget | undefined;
  let stepTimeout = DEFAULT_STEP_TIMEOUT_MS;
  if (typeof target === 'string') {
    const config = await loadConfig(process.cwd(), options.config);
    resolved = config.targets[target];
    if (!resolved) {
      throw new VerifyError(
        'INVALID_ARGUMENT',
        `open('${target}'): ${config.configFile} has no target named "${target}". Targets: ${Object.keys(config.targets).join(', ')}.`,
      );
    }
    stepTimeout = config.stepTimeout;
  } else {
    resolved = validateTarget(target);
  }
  const agent = chooseAgent(options, 'open()');
  if (agent && (resolved.platform === 'mac' || resolved.platform === 'linux')) {
    throw new VerifyError('NOT_AVAILABLE_ON_PLATFORM', 'Your own model runs steps on browsers and devices, not on computers.');
  }
  const credentials = await credentialsForUse(options);
  const log = options.log === false ? undefined : (options.log ?? ((line: string) => void process.stderr.write(`[verify] ${line}\n`)));
  const client = new RevylClient({ token: credentials.token, backendUrl: options.backendUrl });
  if (resolved.platform === 'mac' || resolved.platform === 'linux') return ComputerSession.start(client, resolved, { stepTimeout, log, appUrl: options.appUrl });
  return DeviceSession.start(client, resolved, { stepTimeout, log, appUrl: options.appUrl, ...(agent ? { agent } : {}) });
}
