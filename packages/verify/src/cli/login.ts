import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appUrl, RevylClient } from '../api/client.js';
import { missingCredentialsMessage, resolveCredentials, type Credentials } from '../auth.js';
import { isVerifyError, VerifyError } from '../errors.js';

const AUTH_PATH = '/api/v1/entity/users/cli-device-authorizations';

export async function signIn(options: { force?: boolean; backendUrl?: string; appUrl?: string } = {}): Promise<Credentials> {
  const existing = options.force ? undefined : await resolveCredentials();
  if (existing) return existing;
  if (!process.stdin.isTTY || !process.stderr.isTTY || process.env.CI) throw new VerifyError('AUTH_MISSING', `${missingCredentialsMessage()} Set the REVYL_API_KEY secret for non-interactive runs.`);
  const backendUrl = new RevylClient({ token: '', backendUrl: options.backendUrl }).backendUrl;
  const viewerOrigin = new URL(appUrl(options.appUrl)).origin;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
  try {
    const authorization = await post(backendUrl, AUTH_PATH, { client_instance_id: await clientInstanceId(), device_label: hostname().trim().replace(/\s+/g, ' ').slice(0, 80) || 'Revyl CLI' }, signal);
    const deviceCode = requiredString(authorization, 'device_code');
    const userCode = requiredString(authorization, 'user_code');
    const rawUrl = requiredString(authorization, 'verification_uri_complete');
    let url: URL;
    try { url = new URL(rawUrl); } catch { throw invalidResponse(); }
    if (url.origin !== viewerOrigin || url.pathname !== '/cli/device' || url.username || url.password) throw invalidResponse();
    const expiresIn = authorization.expires_in;
    const firstInterval = authorization.interval;
    if (!Number.isInteger(expiresIn) || typeof expiresIn !== 'number' || expiresIn <= 0 || !Number.isInteger(firstInterval) || typeof firstInterval !== 'number' || firstInterval < 0) throw invalidResponse();
    const deadline = Date.now() + Math.min(expiresIn * 1000, 600_000);
    let intervalMs = firstInterval > 0 ? firstInterval * 1000 : 5000;
    process.stderr.write(`Open this URL to approve, then confirm the code below:\n${url.href}\nCode: ${userCode}\nWaiting for approval (Ctrl+C to cancel)...\n`);
    openBrowser(url.href);
    while (Date.now() < deadline) {
      await delay(Math.min(intervalMs, deadline - Date.now()), undefined, { signal });
      if (Date.now() >= deadline) break;
      const credential = await post(backendUrl, `${AUTH_PATH}/credentials`, { device_code: deviceCode }, signal);
      if (credential.state === 'pending') {
        intervalMs = Math.min(intervalMs * 1.5, 15_000);
        continue;
      }
      if (credential.state === 'denied') throw new VerifyError('AUTH_REJECTED', 'The Revyl login request was denied. Run your script again to sign in, or use revyl auth login.');
      if (credential.state !== 'approved') throw invalidResponse();
      const token = requiredString(credential, 'api_key_token');
      const who = await new RevylClient({ token, backendUrl }).whoAmI();
      const concurrent = await resolveCredentials();
      if (concurrent) {
        try {
          await new RevylClient({ token: concurrent.token, backendUrl }).whoAmI();
          return concurrent;
        } catch (error) {
          if (!isVerifyError(error) || error.code !== 'AUTH_REJECTED') throw error;
        }
      }
      const keyId = optionalString(credential, 'api_key_id');
      const stored = {
        ...(keyId ? { api_key: token, api_key_id: keyId, auth_method: 'browser_api_key' } : { access_token: token, expires_at: tokenExpiry(token), auth_method: 'browser' }),
        ...(who.email || optionalString(credential, 'email') ? { email: who.email || optionalString(credential, 'email') } : {}),
        ...(who.org_id || optionalString(credential, 'org_id') ? { org_id: who.org_id || optionalString(credential, 'org_id') } : {}),
        ...(who.user_id || optionalString(credential, 'user_id') ? { user_id: who.user_id || optionalString(credential, 'user_id') } : {}),
        ...(process.env.REVYL_API_KEY?.trim() ? { local_auth_override: true } : {}),
      };
      await writePrivateState('credentials.json', stored);
      return { token, source: 'revyl-cli-login' };
    }
    throw new VerifyError('AUTH_MISSING', 'The Revyl login request expired. Run your script again to sign in, or use revyl auth login.');
  } catch (error) {
    if (signal.aborted) throw new VerifyError('AUTH_MISSING', 'Revyl sign-in was cancelled or timed out. Run your script again to sign in, or use revyl auth login.');
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

async function post(backendUrl: string, path: string, body: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(new URL(path, backendUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  } catch {
    throw new VerifyError('AUTH_MISSING', 'Could not reach Revyl to sign in. Run your script again, use revyl auth login, or set REVYL_API_KEY.');
  }
  if (response.status === 404) throw new VerifyError('AUTH_MISSING', 'The Revyl login request is unavailable or expired. Run your script again, or use revyl auth login.');
  if (!response.ok) throw new VerifyError('AUTH_REJECTED', `Revyl sign-in failed (HTTP ${response.status}). Run your script again, use revyl auth login, or set REVYL_API_KEY.`);
  let value: unknown;
  try { value = await response.json(); } catch { throw invalidResponse(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const text = optionalString(value, key);
  if (!text) throw invalidResponse();
  return text;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const text = value[key];
  if (text === null || text === undefined) return undefined;
  if (typeof text !== 'string' || text.length > 8192 || /[\x00-\x1f\x7f]/.test(text)) throw invalidResponse();
  return text || undefined;
}

function invalidResponse(): VerifyError {
  return new VerifyError('AUTH_REJECTED', 'Revyl returned an invalid sign-in response. Run your script again, use revyl auth login, or set REVYL_API_KEY.');
}

function tokenExpiry(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > 0) return new Date(Math.trunc(payload.exp) * 1000).toISOString();
  } catch {}
  return new Date(Date.now() + 30 * 60_000).toISOString();
}

async function clientInstanceId(): Promise<string> {
  const path = join(homedir(), '.revyl', 'client-identity.json');
  try {
    const identity: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (identity && typeof identity === 'object' && 'client_instance_id' in identity && typeof identity.client_instance_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(identity.client_instance_id)) return identity.client_instance_id;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new VerifyError('AUTH_MISSING', 'Could not read the Revyl client identity. Check ~/.revyl permissions.');
  }
  const id = randomBytes(16).toString('hex');
  await writePrivateState('client-identity.json', { client_instance_id: id });
  return id;
}

async function writePrivateState(name: string, value: object): Promise<void> {
  const directory = join(homedir(), '.revyl');
  const destination = join(directory, name);
  const temporary = join(directory, `.${name}.${randomBytes(16).toString('hex')}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error();
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    try {
      if (!(await lstat(destination)).isFile()) throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, destination);
  } catch {
    throw new VerifyError('AUTH_MISSING', 'Could not save Revyl sign-in state. Use a writable, owner-only ~/.revyl directory.');
  } finally { await rm(temporary, { force: true }); }
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', timeout: 10_000 });
  child.once('error', () => process.stderr.write('Open the URL above in your browser to finish signing in.\n'));
  child.unref();
}
