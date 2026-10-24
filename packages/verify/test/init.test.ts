import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initProject } from '../src/cli/init.js';
import { validateConfig } from '../src/config.js';
import { APP_ID } from './helpers/fake-revyl.js';
import { PACKAGE_NAME } from '../src/version.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

describe('initProject', () => {
  it('prints the staging-only Mac availability note exactly once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-cli-'));
    const jiti = pathToFileURL(createRequire(import.meta.url).resolve('jiti')).href;
    const entry = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import { createJiti } from ${JSON.stringify(jiti)}; process.argv = ['node', 'verify', 'init', '--platform', 'mac']; await createJiti(import.meta.url).import(${JSON.stringify(entry)});`], { cwd: dir, encoding: 'utf8' });
    expect(output.match(/Mac computers are not yet available in Revyl production/g)).toHaveLength(1);
    expect(output).toContain('only on Revyl staging for enabled organizations');
    expect(output).toContain('REVYL_BACKEND_URL');
    expect(output).toContain('computers.md#availability-and-errors');
  });
  it('writes a web config, an example script, and ignores screenshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await writeFile(join(dir, '.gitignore'), 'node_modules');
    const result = await initProject(dir, { platform: 'web', appId: APP_ID, url: 'https://shop.example.com' });
    expect(result).toEqual({ created: ['verify.config.ts', 'verify/example.ts'], gitignoreUpdated: true });
    const config = await readFile(join(dir, 'verify.config.ts'), 'utf8');
    expect(config).toContain(`from '${PACKAGE_NAME}'`);
    expect(config).toContain(`appId: '${APP_ID}'`);
    expect(config).toContain("url: 'https://shop.example.com'");
    const script = await readFile(join(dir, 'verify/example.ts'), 'utf8');
    expect(script).toContain("await open('web')");
    expect(script).toContain('session.instruction(');
    expect(script).toContain('session.validation(');
    expect(script).toContain('session.close()');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.verify/\n');
    expect((await initProject(dir, { platform: 'web' }, { force: true })).gitignoreUpdated).toBe(false);
  });

  it('writes a mobile config whose target matches the example script', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await initProject(dir, { platform: 'ios', appId: APP_ID });
    const source = await readFile(join(dir, 'verify.config.ts'), 'utf8');
    const config = validateConfig(
      new Function(`return ${source.slice(source.indexOf('defineConfig(') + 'defineConfig('.length, source.lastIndexOf(')'))}`)(),
      join(dir, 'verify.config.ts'),
    );
    expect(Object.keys(config.targets)).toEqual(['ios']);
    expect(await readFile(join(dir, 'verify/example.ts'), 'utf8')).toContain("await open('ios')");
  });

  it('never overwrites existing files without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await initProject(dir, { platform: 'android' });
    await expect(initProject(dir, { platform: 'android' })).rejects.toMatchObject({ message: expect.stringContaining('--force') });
  });

  it('writes a Mac config without an app and a shell/file script without agent steps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await initProject(dir, { platform: 'mac' });
    const source = await readFile(join(dir, 'verify.config.ts'), 'utf8');
    const config = validateConfig(
      new Function(`return ${source.slice(source.indexOf('defineConfig(') + 'defineConfig('.length, source.lastIndexOf(')'))}`)(),
      join(dir, 'verify.config.ts'),
    );
    expect(config.targets.mac).toMatchObject({ platform: 'mac' });
    expect(source).not.toContain('app');
    const script = await readFile(join(dir, 'verify/example.ts'), 'utf8');
    expect(script).toContain("await open('mac')");
    expect(script).toContain("session.exec(['uname', '-s'])");
    expect(script).toContain('session.writeFile(');
    expect(script).toContain('session.readFile(');
    expect(script).toContain('session.stat(');
    expect(script).toContain('finally');
    expect(script).toContain('session.close()');
    expect(script).not.toMatch(/instruction|validation|screenshot/);
  });

  it('validates answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-init-'));
    await expect(initProject(dir, { platform: 'ios', url: 'https://x.com' })).rejects.toThrow('web targets only');
    await expect(initProject(dir, { platform: 'web', appId: 'nope' })).rejects.toThrow('UUID');
    await expect(initProject(dir, { platform: 'mac', appId: APP_ID })).rejects.toThrow('--app-id does not apply');
    await expect(initProject(dir, { platform: 'mac', url: 'https://x.com' })).rejects.toThrow('web targets only');
    await expect(initProject(dir, { platform: 'linux' })).rejects.toThrow('Linux computers are not available');
  });
});
