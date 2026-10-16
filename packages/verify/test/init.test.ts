import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initProject } from '../src/cli/init.js';
import { APP_ID } from './helpers/fake-revyl.js';

describe('initProject', () => {
  it('writes a web config, an example test, and ignores run output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await writeFile(join(dir, '.gitignore'), 'node_modules');
    const result = await initProject(dir, { platform: 'web', appId: APP_ID, url: 'https://shop.example.com' });
    expect(result).toEqual({ created: ['verify.config.ts', 'tests/example.verify.ts'], gitignoreUpdated: true });
    const config = await readFile(join(dir, 'verify.config.ts'), 'utf8');
    expect(config).toContain(`appId: '${APP_ID}'`);
    expect(config).toContain("url: 'https://shop.example.com'");
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.verify/\n');
    expect((await initProject(dir, { platform: 'web' }, { force: true })).gitignoreUpdated).toBe(false);
  });

  it('writes a mobile example that uses both exact locators and the agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await initProject(dir, { platform: 'ios' });
    expect(await readFile(join(dir, 'verify.config.ts'), 'utf8')).toContain("platform: 'ios'");
    const example = await readFile(join(dir, 'tests/example.verify.ts'), 'utf8');
    expect(example).toContain('agent.assert');
    expect(example).toContain('screen.getByRole');
  });

  it('never overwrites existing files without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await initProject(dir, { platform: 'android' });
    await expect(initProject(dir, { platform: 'android' })).rejects.toMatchObject({ message: expect.stringContaining('--force') });
  });

  it('validates answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await expect(initProject(dir, { platform: 'ios', url: 'https://x.com' })).rejects.toThrow('web targets only');
    await expect(initProject(dir, { platform: 'web', appId: 'nope' })).rejects.toThrow('UUID');
  });
});
