import { RevylClient } from './api/client.js';
import { missingCredentialsMessage, resolveCredentials } from './auth.js';
import { DEFAULT_STEP_TIMEOUT_MS, loadConfig, validateTarget, type ResolvedTarget, type TargetConfig } from './config.js';
import { VerifyError } from './errors.js';
import { Session } from './session.js';

export interface OpenOptions {
  /** The config file to read target names from. Defaults to the nearest verify.config.ts at or above the current folder. */
  config?: string;
  /** Where progress lines go: the session link and each step's outcome. Defaults to stderr; false turns them off. */
  log?: false | ((line: string) => void);
}

/**
 * Starts a Revyl cloud browser or device and resolves once it is ready for steps.
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
  return Session.start(new RevylClient({ token: credentials.token }), resolved, { stepTimeout, log });
}
