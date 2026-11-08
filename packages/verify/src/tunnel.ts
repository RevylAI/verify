import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { VerifyError, errorMessage } from './errors.js';

/** How environment() turns a local port into a URL. Only Cloudflare quick tunnels exist today. */
export type ExposeProviderName = 'quick-tunnel';

export interface ExposedPort {
  readonly url: string;
  /** Whether the process serving the URL is still running. */
  readonly running: boolean;
  /** The HTTP status the URL answers with right now, or the network error code. */
  probe(path: string): Promise<number | string>;
  /** Text to include when the URL fails: the provider's own recent output, with the URL removed. */
  diagnostics(): string;
  close(): Promise<void>;
}

export interface ExposeProvider {
  expose(port: number, signal: AbortSignal): Promise<ExposedPort>;
}

export const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
export const MIN_CLOUDFLARED_VERSION = '2026.10.2';
const PINNED_CLOUDFLARED_VERSION = '2026.10.7';
const PINNED_CLOUDFLARED: Record<string, { asset: string; assetSha256: string; binarySha256: string }> = {
  'linux-x64': {
    asset: 'cloudflared-linux-amd64',
    assetSha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
    binarySha256: '1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872',
  },
  'linux-arm64': {
    asset: 'cloudflared-linux-arm64',
    assetSha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775',
    binarySha256: '3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775',
  },
  'darwin-arm64': {
    asset: 'cloudflared-darwin-arm64.tgz',
    assetSha256: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd',
    binarySha256: '2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12',
  },
  'darwin-x64': {
    asset: 'cloudflared-darwin-amd64.tgz',
    assetSha256: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848',
    binarySha256: '5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86',
  },
};
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_MAX_BYTES = 150 * 1024 * 1024;
const TUNNEL_START_TIMEOUT_MS = 60_000;
const TUNNEL_STOP_GRACE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const LOG_TAIL_LINES = 20;
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000];

const execFileAsync = promisify(execFile);
let cloudflaredPath: Promise<string> | undefined;

export function exposeProvider(name: ExposeProviderName, log: (line: string) => void): ExposeProvider {
  switch (name) {
    case 'quick-tunnel':
      return { expose: (port, signal) => startQuickTunnel(port, signal, log) };
  }
}

async function startQuickTunnel(port: number, signal: AbortSignal, log: (line: string) => void): Promise<ExposedPort> {
  cloudflaredPath ??= resolveCloudflared(log).catch((error: unknown) => {
    cloudflaredPath = undefined;
    throw error;
  });
  const binary = await Promise.race([cloudflaredPath, abortion(signal)]);
  const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
  for (let attempt = 1; ; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    const tunnel = await spawnQuickTunnel(binary, port);
    try {
      await tunnel.started(deadline, signal);
      return tunnel;
    } catch (error) {
      await tunnel.close().catch(() => undefined);
      const backoffMs = RATE_LIMIT_BACKOFF_MS[attempt - 1];
      if (!tunnel.rateLimited()) throw error;
      if (backoffMs === undefined || Date.now() + backoffMs > deadline) {
        throw new VerifyError('TUNNEL_FAILED', 'Cloudflare refused to create a quick tunnel for port ' + port + ' (HTTP 429). Quick tunnels are rate-limited per network address, so wait a few minutes before trying again.', { cause: error });
      }
      log(`Cloudflare rate-limited the quick tunnel for port ${port}; trying again in ${backoffMs / 1000} s.`);
      await delay(backoffMs, undefined, { signal });
    }
  }
}

async function spawnQuickTunnel(binary: string, port: number): Promise<ExposedPort & { started(deadline: number, signal: AbortSignal): Promise<void>; rateLimited(): boolean }> {
  const configDir = await mkdtemp(join(tmpdir(), 'verify-tunnel-'));
  const configFile = join(configDir, 'config.yml');
  await writeFile(configFile, 'no-autoupdate: true\n');
  const child = spawn(
    binary,
    ['tunnel', '--no-autoupdate', '--config', configFile, '--metrics', '127.0.0.1:0', '--grace-period', '1s', '--url', `http://localhost:${port}`],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const tail: string[] = [];
  let url: string | undefined;
  let registered = false;
  let spawnError: Error | undefined;
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.once('error', (error) => (spawnError = error));
  void exited.then(() => rm(configDir, { recursive: true, force: true }));
  createInterface({ input: child.stderr! }).on('line', (line) => {
    url ??= line.match(QUICK_TUNNEL_URL)?.[0];
    if (/Registered tunnel connection/.test(line)) registered = true;
    if (/ INF /.test(line)) return;
    tail.push(line.replace(QUICK_TUNNEL_URL, '<tunnel url>'));
    if (tail.length > LOG_TAIL_LINES) tail.shift();
  });
  child.unref();
  (child.stderr as unknown as { unref?: () => void }).unref?.();
  const diagnostics = () => tail.join('\n') || '(nothing beyond informational lines)';
  return {
    get url() {
      return url ?? '';
    },
    get running() {
      return child.exitCode === null && child.signalCode === null;
    },
    probe: (path) => probeQuickTunnel(url ?? '', path),
    diagnostics,
    rateLimited: () => tail.some((line) => /\b429\b/.test(line)),
    close: () => stopProcessGroup(child, TUNNEL_STOP_GRACE_MS, 'cloudflared'),
    async started(deadline, signal) {
      while (!(url && registered)) {
        if (signal.aborted) throw signal.reason;
        if (spawnError) throw new VerifyError('TUNNEL_FAILED', `Could not run cloudflared: ${errorMessage(spawnError)}`, { cause: spawnError });
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new VerifyError('TUNNEL_FAILED', `cloudflared exited (${child.exitCode ?? child.signalCode}) before the quick tunnel for port ${port} was up. Its last output:\n${diagnostics()}`);
        }
        if (Date.now() > deadline) {
          throw new VerifyError('TUNNEL_FAILED', `The quick tunnel for port ${port} was not up after ${TUNNEL_START_TIMEOUT_MS / 1000} s. cloudflared's last output:\n${diagnostics()}`);
        }
        await delay(250);
      }
    },
  };
}

function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

let edgeAddress: Promise<string | undefined> | undefined;

/**
 * A new quick-tunnel hostname takes a few seconds to appear in DNS, and a lookup made before then is cached as
 * missing for up to a minute. Until the tunnel answers, the probe reaches Cloudflare's edge by the address of
 * trycloudflare.com and names the tunnel host in TLS and the Host header, so the tunnel host is never looked up early.
 */
async function probeQuickTunnel(url: string, path: string): Promise<number | string> {
  const host = new URL(url).hostname;
  edgeAddress ??= lookup('trycloudflare.com').then(
    (result) => result.address,
    () => undefined,
  );
  const address = await edgeAddress;
  return new Promise((resolve) => {
    const req = request(
      { host: address ?? host, servername: host, headers: { host }, path, method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 'NO_STATUS');
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    req.end();
  });
}

/** Signals a detached child's process group, then waits for every process in it to exit. Returns once the group is gone. */
export async function stopProcessGroup(child: ChildProcess, graceMs: number, label: string): Promise<void> {
  const pgid = child.pid;
  if (pgid === undefined) return;
  for (const [signal, waitMs] of [['SIGTERM', graceMs], ['SIGKILL', 2_000]] as const) {
    if (!processGroupAlive(pgid)) return;
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until && processGroupAlive(pgid)) await delay(100);
  }
  if (processGroupAlive(pgid)) throw new Error(`${label} (process group ${pgid}) was still running after SIGKILL`);
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function resolveCloudflared(log: (line: string) => void): Promise<string> {
  const installed = await cloudflaredVersion('cloudflared');
  if (installed && compareVersions(installed, MIN_CLOUDFLARED_VERSION) >= 0) return 'cloudflared';
  if (installed) log(`Ignoring cloudflared ${installed} on PATH: releases before ${MIN_CLOUDFLARED_VERSION} trust revoked certificates. Using the pinned ${PINNED_CLOUDFLARED_VERSION} instead.`);
  const pinned = PINNED_CLOUDFLARED[`${process.platform}-${process.arch}`];
  if (!pinned) {
    throw new VerifyError('TUNNEL_UNAVAILABLE', `cloudflared is not on PATH, and Verify has no pinned cloudflared for ${process.platform}-${process.arch}. Install cloudflared ${MIN_CLOUDFLARED_VERSION} or later.`);
  }
  const errors: string[] = [];
  for (const base of [process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), tmpdir()]) {
    const directory = join(base, 'revyl-verify', 'cloudflared', PINNED_CLOUDFLARED_VERSION);
    const binary = join(directory, 'cloudflared');
    try {
      if (await fileHasSha256(binary, pinned.binarySha256)) return binary;
      await mkdir(directory, { recursive: true });
      log(`cloudflared is not on PATH. Downloading cloudflared ${PINNED_CLOUDFLARED_VERSION} into ${directory}.`);
      await downloadCloudflared(pinned, directory, binary);
      return binary;
    } catch (error) {
      errors.push(`${directory}: ${errorMessage(error)}`);
    }
  }
  throw new VerifyError(
    'TUNNEL_UNAVAILABLE',
    `cloudflared is not on PATH, and downloading the pinned cloudflared ${PINNED_CLOUDFLARED_VERSION} failed (${errors.join('; ')}). Install cloudflared ${MIN_CLOUDFLARED_VERSION} or later on the runner.`,
  );
}

async function downloadCloudflared(pinned: { asset: string; assetSha256: string; binarySha256: string }, directory: string, binary: string): Promise<void> {
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${PINNED_CLOUDFLARED_VERSION}/${pinned.asset}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > DOWNLOAD_MAX_BYTES) throw new Error('the download is larger than expected');
  const asset = Buffer.from(await response.arrayBuffer());
  if (sha256(asset) !== pinned.assetSha256) throw new Error(`${pinned.asset} did not match its pinned sha256`);
  const staging = await mkdtemp(join(directory, '.download-'));
  try {
    const stagedBinary = join(staging, 'cloudflared');
    if (pinned.asset.endsWith('.tgz')) {
      const archive = join(staging, pinned.asset);
      await writeFile(archive, asset);
      await execFileAsync('tar', ['-xzf', archive, '-C', staging, 'cloudflared'], { timeout: 60_000 });
    } else {
      await writeFile(stagedBinary, asset);
    }
    if (!(await fileHasSha256(stagedBinary, pinned.binarySha256))) throw new Error('the extracted cloudflared did not match its pinned sha256');
    await chmod(stagedBinary, 0o755);
    await rename(stagedBinary, binary);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function fileHasSha256(path: string, expected: string): Promise<boolean> {
  try {
    await access(path);
  } catch {
    return false;
  }
  return sha256(await readFile(path)) === expected;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function cloudflaredVersion(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 10_000 });
    return stdout.match(/version (\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return undefined;
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
