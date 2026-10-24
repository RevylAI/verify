import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCredentials } from '../src/auth.js';

async function homeWith(credentials?: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'verify-auth-'));
  if (credentials) {
    await mkdir(join(home, '.revyl'));
    await writeFile(join(home, '.revyl', 'credentials.json'), JSON.stringify(credentials));
  }
  return home;
}

describe('resolveCredentials', () => {
  it('prefers REVYL_API_KEY over a stored login', async () => {
    const home = await homeWith({ api_key: 'stored' });
    expect(await resolveCredentials({ env: { REVYL_API_KEY: 'from-env' }, home })).toEqual({ token: 'from-env', source: 'REVYL_API_KEY' });
  });

  it('lets a stored login marked local_auth_override win, like the Revyl CLI', async () => {
    const home = await homeWith({ access_token: 'browser', local_auth_override: true });
    expect(await resolveCredentials({ env: { REVYL_API_KEY: 'from-env' }, home })).toEqual({ token: 'browser', source: 'revyl-cli-login' });
  });

  it('skips an expired access token and falls back to the stored API key', async () => {
    const home = await homeWith({ access_token: 'old', expires_at: '2020-01-01T00:00:00Z', api_key: 'stored-key' });
    expect(await resolveCredentials({ env: {}, home })).toEqual({ token: 'stored-key', source: 'revyl-cli-login' });
  });

  it('ignores an unexpanded placeholder and reports nothing when no login exists', async () => {
    const home = await homeWith();
    expect(await resolveCredentials({ env: { REVYL_API_KEY: '${{ secrets.REVYL_API_KEY }}' }, home })).toBeUndefined();
  });

  it('rejects a credentials file that is not JSON', async () => {
    const home = await homeWith();
    await mkdir(join(home, '.revyl'));
    await writeFile(join(home, '.revyl', 'credentials.json'), '{nope');
    await expect(resolveCredentials({ env: {}, home })).rejects.toMatchObject({ code: 'AUTH_MISSING' });
  });
});
