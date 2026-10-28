import { RevylClient } from './api/client.js';
import { missingCredentialsMessage, resolveCredentials } from './auth.js';
import { DEFAULT_STEP_TIMEOUT_MS, loadConfig, validateTarget, type ResolvedTarget, type TargetConfig } from './config.js';
import { VerifyError } from './errors.js';
import { DeviceSession, type Session } from './session.js';
import { ComputerSession } from './computer-session.js';

export interface OpenOptions {
  /** The config file to read target names from. Defaults to the nearest verify.config.ts at or above the current folder. */
  config?: string;
  /** Where progress lines go: the session link and each step's outcome. Defaults to stderr; false turns them off. */
  log?: false | ((line: string) => void);
}

export async function attach(computerId: string, options: Pick<OpenOptions, 'log'> = {}): Promise<ComputerSession> {
  if (typeof computerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(computerId)) throw new VerifyError('INVALID_ARGUMENT', 'attach() requires a computer session UUID.');
  const credentials = await resolveCredentials();
  if (!credentials) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());
  const log = options.log === false ? undefined : (options.log ?? ((line: string) => void process.stderr.write(`[verify] ${line}\n`)));
  return ComputerSession.attach(new RevylClient({ token: credentials.token }), computerId, { stepTimeout: DEFAULT_STEP_TIMEOUT_MS, log });
}

/**
 * Starts a Revyl cloud browser, device, or computer. Mobile first-screen readiness is best-effort.
 * Pass a target name from verify.config.ts, such as open('web'), or a target object.
 */
export async function open(target: string | TargetConfig, options: OpenOptions = {}): Promise<Session> {
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
  const credentials = await resolveCredentials();
  if (!credentials) throw new VerifyError('AUTH_MISSING', missingCredentialsMessage());
  const log = options.log === false ? undefined : (options.log ?? ((line: string) => void process.stderr.write(`[verify] ${line}\n`)));
  const client = new RevylClient({ token: credentials.token });
  if (resolved.platform === 'mac' || resolved.platform === 'linux') return ComputerSession.start(client, resolved, { stepTimeout, log });
  return DeviceSession.start(client, resolved, { stepTimeout, log });
}
