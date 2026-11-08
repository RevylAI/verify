import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { trackSession, untrackSession } from './cleanup.js';
import { VerifyError, errorMessage } from './errors.js';
import { QUICK_TUNNEL_URL, exposeProvider, stopProcessGroup, type ExposeProviderName, type ExposedPort } from './tunnel.js';

export type { ExposeProviderName } from './tunnel.js';

export interface EnvironmentOptions {
  /** Shell command that starts the stack, run in its own process group. It may keep running or exit 0 once it has started things in the background. It gets the exposed URLs as environment variables. */
  start?: string;
  /** Shell command run on close, after the tunnels are gone and before the start command's process group is stopped. It gets the same URL variables as start. */
  stop?: string;
  /** Shell command run once every exposed name is ready, with the URLs in its environment. */
  seed?: string;
  /** A public URL for each local port, by the variable name it is published under. */
  expose: Record<string, number>;
  /** An HTTP path per exposed name that must answer 2xx or 3xx, on localhost and through the public URL, before environment() returns. A name without one waits for its port to accept connections and for its URL to reach it. */
  ready?: Record<string, string>;
  /** How ports get public URLs. Defaults to 'quick-tunnel', a Cloudflare quick tunnel per port. */
  provider?: ExposeProviderName;
  /** Working directory for start, stop, and seed. Defaults to the current folder. */
  cwd?: string;
  /** Environment variables added to start, stop, and seed. undefined removes an inherited one. */
  env?: Record<string, string | undefined>;
  /** Milliseconds for the stack to become ready on localhost and through every public URL. Defaults to 300000. */
  readyTimeoutMs?: number;
  /** Milliseconds the seed command may run. Defaults to 300000. */
  seedTimeoutMs?: number;
  /** Milliseconds the stop command may run. Defaults to 120000. */
  stopTimeoutMs?: number;
  /** Print each public URL. URLs are hidden by default because anyone who has one can reach the stack, and CI logs can be public. */
  showUrls?: boolean;
  /** Where progress lines and the commands' output go. Defaults to stderr; false turns them off. */
  log?: false | ((line: string) => void);
  /** Aborting it stops setup and tears down what was started. */
  signal?: AbortSignal;
}

/** A running stack with a public URL per exposed port. Close it after the run that uses the URLs has finished. */
export interface Environment extends AsyncDisposable {
  /** The public URL of each exposed name. */
  readonly urls: Readonly<Record<string, string>>;
  /** The same URLs as plain values, ready to pass to proof({ environment }). */
  readonly variables: Readonly<Record<string, string>>;
  readonly closed: boolean;
  /** Removes the public URLs, runs stop, and stops the start command's process group. Throws CLEANUP_FAILED when a step fails, after trying every step. Safe to call more than once. */
  close(): Promise<void>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_READY_TIMEOUT_MS = 300_000;
const DEFAULT_SEED_TIMEOUT_MS = 300_000;
const DEFAULT_STOP_TIMEOUT_MS = 120_000;
const START_GROUP_GRACE_MS = 10_000;
const COMMAND_GRACE_MS = 5_000;
const READY_POLL_MS = 1_000;
const READY_REQUEST_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_LINES = 40;
const TUNNEL_NOT_ROUTED = new Set([502, 530]);

interface StartedCommand {
  child: ChildProcess;
  exited: Promise<void>;
  tail: string[];
}

/**
 * Starts a stack on this machine and gives each listed port a public URL, so a Revyl run in the cloud can reach it.
 * Use it with await using, around the proof() call, so the URLs stay up until the run has settled.
 */
export async function environment(options: EnvironmentOptions): Promise<Environment> {
  const settings = validateOptions(options);
  const running = new RunningEnvironment(settings);
  trackSession(running);
  const abortSetup = () => running.abortSetup(options.signal?.reason);
  options.signal?.addEventListener('abort', abortSetup, { once: true });
  try {
    if (options.signal?.aborted) throw options.signal.reason;
    await running.setUp();
    return running;
  } catch (error) {
    await running.close().catch((cleanupError: unknown) => running.log(errorMessage(cleanupError)));
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortSetup);
  }
}

interface Settings {
  start?: string;
  stop?: string;
  seed?: string;
  expose: Array<{ name: string; port: number; readyPath?: string }>;
  provider: ExposeProviderName;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  readyTimeoutMs: number;
  seedTimeoutMs: number;
  stopTimeoutMs: number;
  showUrls: boolean;
  log?: (line: string) => void;
}

function validateOptions(options: EnvironmentOptions): Settings {
  if (!options || typeof options !== 'object') throw new VerifyError('INVALID_ARGUMENT', 'environment() takes an options object.');
  if (process.platform === 'win32') throw new VerifyError('INVALID_ARGUMENT', 'environment() runs on macOS and Linux runners.');
  for (const key of ['start', 'stop', 'seed'] as const) {
    const value = options[key];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) throw new VerifyError('INVALID_ARGUMENT', `environment(): ${key} must be a non-empty shell command.`);
  }
  const expose = Object.entries(options.expose ?? {});
  if (expose.length === 0) throw new VerifyError('INVALID_ARGUMENT', 'environment(): expose must name at least one port, as { NAME: port }.');
  const ready = options.ready ?? {};
  for (const name of Object.keys(ready)) {
    if (!(name in (options.expose ?? {}))) throw new VerifyError('INVALID_ARGUMENT', `environment(): ready.${name} has no matching expose.${name}.`);
  }
  const provider = options.provider ?? 'quick-tunnel';
  if (provider !== 'quick-tunnel') throw new VerifyError('INVALID_ARGUMENT', `environment(): provider must be 'quick-tunnel'.`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return {
    ...(options.start ? { start: options.start } : {}),
    ...(options.stop ? { stop: options.stop } : {}),
    ...(options.seed ? { seed: options.seed } : {}),
    expose: expose.map(([name, port]) => {
      if (!NAME.test(name)) throw new VerifyError('INVALID_ARGUMENT', `environment(): expose name ${JSON.stringify(name)} must be a valid environment variable name.`);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new VerifyError('INVALID_ARGUMENT', `environment(): expose.${name} must be a port from 1 to 65535.`);
      const readyPath = ready[name];
      if (readyPath !== undefined && (typeof readyPath !== 'string' || !readyPath.startsWith('/'))) throw new VerifyError('INVALID_ARGUMENT', `environment(): ready.${name} must be a path starting with /.`);
      return { name, port, ...(readyPath ? { readyPath } : {}) };
    }),
    provider,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    readyTimeoutMs: positiveMs(options.readyTimeoutMs, 'readyTimeoutMs', DEFAULT_READY_TIMEOUT_MS),
    seedTimeoutMs: positiveMs(options.seedTimeoutMs, 'seedTimeoutMs', DEFAULT_SEED_TIMEOUT_MS),
    stopTimeoutMs: positiveMs(options.stopTimeoutMs, 'stopTimeoutMs', DEFAULT_STOP_TIMEOUT_MS),
    showUrls: options.showUrls === true,
    ...(options.log === false ? {} : { log: options.log ?? ((line: string) => void process.stderr.write(`[verify] ${line}\n`)) }),
  };
}

function positiveMs(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new VerifyError('INVALID_ARGUMENT', `environment(): ${name} must be a positive number of milliseconds.`);
  return value;
}

class RunningEnvironment implements Environment {
  readonly target = 'environment';
  readonly closeBudgetMs: number;
  readonly urls: Record<string, string> = {};
  private readonly tunnels = new Map<string, ExposedPort>();
  private exposing: Array<Promise<unknown>> = [];
  private started?: StartedCommand;
  private readonly setup = new AbortController();
  private closePromise?: Promise<void>;

  constructor(private readonly settings: Settings) {
    this.closeBudgetMs = settings.stopTimeoutMs + COMMAND_GRACE_MS + START_GROUP_GRACE_MS + 15_000;
  }

  get variables(): Readonly<Record<string, string>> {
    return this.urls;
  }

  get closed(): boolean {
    return this.closePromise !== undefined;
  }

  log(line: string): void {
    this.settings.log?.(line);
  }

  abortSetup(reason: unknown): void {
    this.setup.abort(reason ?? new VerifyError('ENVIRONMENT_START_FAILED', 'Environment setup was aborted.'));
  }

  /** Runs setup until it finishes or is aborted, whichever comes first, so a stuck step can't hold off teardown. */
  async setUp(): Promise<void> {
    const signal = this.setup.signal;
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => undefined);
    await Promise.race([this.runSetup(signal), aborted]);
  }

  private async runSetup(signal: AbortSignal): Promise<void> {
    const { settings } = this;
    const provider = exposeProvider(settings.provider, (line) => this.log(line));
    this.exposing = settings.expose.map(async ({ name, port }) => this.tunnels.set(name, await provider.expose(port, signal)));
    const exposed = await Promise.allSettled(this.exposing);
    const failed = exposed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    for (const { name, port } of settings.expose) {
      const url = this.tunnels.get(name)!.url;
      this.urls[name] = url;
      if (process.env.GITHUB_ACTIONS === 'true' && !settings.showUrls) process.stdout.write(`::add-mask::${url}\n`);
      this.log(settings.showUrls ? `Exposed port ${port} as ${name}=${url}` : `Exposed port ${port} as ${name} through a quick tunnel. The URL is hidden; pass showUrls to print it.`);
    }
    if (settings.start) this.started = this.runCommand('start', settings.start, { ...settings.env, ...this.urls }, true);
    const deadline = Date.now() + settings.readyTimeoutMs;
    await Promise.all(settings.expose.map((entry) => this.waitUntilReady(entry, deadline, signal)));
    this.log(`Environment ready: ${settings.expose.map(({ name }) => name).join(', ')}.`);
    if (settings.seed) {
      const seed = this.runCommand('seed', settings.seed, { ...settings.env, ...this.urls }, false);
      const outcome = await this.finish(seed, settings.seedTimeoutMs, signal);
      if (outcome !== 0) throw new VerifyError('ENVIRONMENT_START_FAILED', `The seed command ${describeOutcome(outcome, settings.seedTimeoutMs)}. Its last output:\n${seed.tail.join('\n')}`);
    }
  }

  private async waitUntilReady(entry: Settings['expose'][number], deadline: number, signal: AbortSignal): Promise<void> {
    const tunnel = this.tunnels.get(entry.name)!;
    let local = false;
    let last: number | string = 'no response';
    while (true) {
      if (signal.aborted) throw signal.reason;
      const start = this.started?.child;
      if (start && start.exitCode !== null && start.exitCode !== 0) {
        throw new VerifyError('ENVIRONMENT_START_FAILED', `The start command exited with code ${start.exitCode} before ${entry.name} was ready. Its last output:\n${this.started!.tail.join('\n')}`);
      }
      if (start && start.signalCode !== null) {
        throw new VerifyError('ENVIRONMENT_START_FAILED', `The start command was killed by ${start.signalCode} before ${entry.name} was ready. Its last output:\n${this.started!.tail.join('\n')}`);
      }
      if (!tunnel.running) {
        throw new VerifyError('TUNNEL_FAILED', `The quick tunnel for ${entry.name} exited. cloudflared's last output:\n${tunnel.diagnostics()}`);
      }
      if (!local) {
        last = entry.readyPath ? await probeLocalHttp(entry.port, entry.readyPath) : await probeLocalPort(entry.port);
        local = entry.readyPath ? isOk(last) : last === 'open';
        if (local) last = 'no response';
      }
      if (local) {
        last = await tunnel.probe(entry.readyPath ?? '/');
        if (typeof last === 'number' && (entry.readyPath ? isOk(last) : !TUNNEL_NOT_ROUTED.has(last))) return;
      }
      if (Date.now() >= deadline) {
        const where = local ? 'through its public URL' : `on localhost:${entry.port}`;
        throw new VerifyError(
          'ENVIRONMENT_NOT_READY',
          `${entry.name} was not ready ${where} after ${Math.round(this.settings.readyTimeoutMs / 1000)} s: ${entry.readyPath ? `GET ${entry.readyPath}` : 'the port'} last answered ${typeof last === 'number' ? `HTTP ${last}` : last}.`,
        );
      }
      await delay(READY_POLL_MS, undefined, { signal }).catch(() => undefined);
    }
  }

  private runCommand(label: string, command: string, env: NodeJS.ProcessEnv, background: boolean): StartedCommand {
    const child = spawn(command, { shell: true, detached: true, cwd: this.settings.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.once('error', (error) => tail.push(`Could not run the ${label} command: ${errorMessage(error)}`));
    for (const stream of [child.stdout!, child.stderr!]) {
      createInterface({ input: stream }).on('line', (raw) => {
        const line = this.settings.showUrls ? raw : raw.replace(QUICK_TUNNEL_URL, '<tunnel url>');
        tail.push(line);
        if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
        this.log(`${label}: ${line}`);
      });
      if (background) (stream as unknown as { unref?: () => void }).unref?.();
    }
    if (background) child.unref();
    return { child, exited, tail };
  }

  /** Waits for a foreground command, killing its process group when it overruns. Returns its exit code, or 'timeout'. */
  private async finish(command: StartedCommand, timeoutMs: number, signal?: AbortSignal): Promise<number | 'timeout'> {
    const timedOut = delay(timeoutMs, 'timeout' as const, { ref: false });
    const aborted = signal ? new Promise<'aborted'>((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true })) : undefined;
    const outcome = await Promise.race([command.exited.then(() => 'exited' as const), timedOut, ...(aborted ? [aborted] : [])]);
    if (outcome !== 'exited') {
      await stopProcessGroup(command.child, COMMAND_GRACE_MS, 'command');
      if (outcome === 'aborted') throw signal!.reason;
      return 'timeout';
    }
    return command.child.exitCode ?? 128;
  }

  close(): Promise<void> {
    this.closePromise ??= this.tearDown();
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async tearDown(): Promise<void> {
    if (!this.setup.signal.aborted) this.abortSetup(new VerifyError('ENVIRONMENT_START_FAILED', 'The environment was closed during setup.'));
    const failures: string[] = [];
    await Promise.allSettled(this.exposing);
    const tunnels = [...this.tunnels.entries()];
    const stopped = await Promise.allSettled(tunnels.map(([, tunnel]) => tunnel.close()));
    stopped.forEach((result, index) => {
      if (result.status === 'rejected') failures.push(`the quick tunnel for ${tunnels[index]![0]}: ${errorMessage(result.reason)}`);
    });
    if (this.settings.stop && (this.started || !this.settings.start)) {
      try {
        const outcome = await this.finish(this.runCommand('stop', this.settings.stop, { ...this.settings.env, ...this.urls }, false), this.settings.stopTimeoutMs);
        if (outcome !== 0) failures.push(`the stop command ${describeOutcome(outcome, this.settings.stopTimeoutMs)}`);
      } catch (error) {
        failures.push(`the stop command: ${errorMessage(error)}`);
      }
    }
    if (this.started) {
      await stopProcessGroup(this.started.child, START_GROUP_GRACE_MS, 'the start command').catch((error: unknown) => failures.push(errorMessage(error)));
    }
    untrackSession(this);
    if (failures.length > 0) throw new VerifyError('CLEANUP_FAILED', `Environment cleanup failed: ${failures.join('; ')}. Check the runner for leftover processes before reusing it.`);
    this.log('Environment closed.');
  }
}

function describeOutcome(outcome: number | 'timeout', timeoutMs: number): string {
  return outcome === 'timeout' ? `ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped` : `exited with code ${outcome}`;
}

function isOk(status: number | string): boolean {
  return typeof status === 'number' && status >= 200 && status < 400;
}

async function probeLocalHttp(port: number, path: string): Promise<number | string> {
  try {
    const response = await fetch(`http://localhost:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(READY_REQUEST_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.status;
  } catch (error) {
    const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
    return cause?.code ?? (error as Error).name;
  }
}

function probeLocalPort(port: number): Promise<'open' | string> {
  return new Promise((resolve) => {
    const socket = connect({ host: 'localhost', port, timeout: READY_REQUEST_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve('open');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('TIMEOUT');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}
