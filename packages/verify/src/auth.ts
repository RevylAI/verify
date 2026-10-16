import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VerifyError } from './errors.js';

export type CredentialSource = 'REVYL_API_KEY' | 'revyl-cli-login';

export interface Credentials {
  token: string;
  source: CredentialSource;
}

interface StoredRevylCredentials {
  api_key?: string;
  access_token?: string;
  expires_at?: string;
  local_auth_override?: boolean;
}

const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

export function revylCredentialsPath(home: string = homedir()): string {
  return join(home, '.revyl', 'credentials.json');
}

/**
 * Resolves the token Verify sends to Revyl, in the same order as the Revyl CLI:
 * REVYL_API_KEY first, unless a browser login in ~/.revyl/credentials.json was
 * marked to take precedence, then that login's access token or API key.
 */
export async function resolveCredentials(
  options: { env?: NodeJS.ProcessEnv; home?: string; nowMs?: number } = {},
): Promise<Credentials | undefined> {
  const env = options.env ?? process.env;
  const stored = await readStoredCredentials(revylCredentialsPath(options.home));
  const storedToken = stored ? usableStoredToken(stored, options.nowMs ?? Date.now()) : undefined;
  const envKey = env.REVYL_API_KEY?.trim();
  const envKeyUsable = envKey !== undefined && envKey !== '' && !envKey.startsWith('${');

  if (envKeyUsable && !(stored?.local_auth_override && storedToken)) {
    return { token: envKey, source: 'REVYL_API_KEY' };
  }
  if (storedToken) {
    return { token: storedToken, source: 'revyl-cli-login' };
  }
  return undefined;
}

export function missingCredentialsMessage(): string {
  return [
    'No Revyl credentials found.',
    'Set REVYL_API_KEY to an API key from https://app.revyl.ai (Settings → API keys),',
    "or sign in once with the Revyl CLI: 'revyl auth login'.",
  ].join(' ');
}

async function readStoredCredentials(path: string): Promise<StoredRevylCredentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new VerifyError('AUTH_MISSING', `Could not read ${path}: ${(error as Error).message}`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as StoredRevylCredentials;
  } catch (error) {
    throw new VerifyError(
      'AUTH_MISSING',
      `${path} is not valid JSON. Run 'revyl auth login' again or set REVYL_API_KEY.`,
      { cause: error },
    );
  }
}

function usableStoredToken(stored: StoredRevylCredentials, nowMs: number): string | undefined {
  if (stored.access_token && !isExpired(stored.expires_at, nowMs)) return stored.access_token;
  return stored.api_key || undefined;
}

function isExpired(expiresAt: string | undefined, nowMs: number): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isNaN(expiresAtMs) || nowMs + ACCESS_TOKEN_EXPIRY_MARGIN_MS > expiresAtMs;
}
