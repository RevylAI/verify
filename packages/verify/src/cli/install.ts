import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { VerifyError } from '../errors.js';
import { PACKAGE_NAME } from '../version.js';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export async function packageHasVerify(cwd: string): Promise<boolean> {
  let raw: string;
  try { raw = await readFile(join(cwd, 'package.json'), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new VerifyError('CONFIG_INVALID', 'Could not read package.json.', { cause: error });
  }
  let manifest: unknown;
  try { manifest = JSON.parse(raw); } catch { throw new VerifyError('CONFIG_INVALID', 'package.json is not valid JSON.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new VerifyError('CONFIG_INVALID', 'package.json must contain an object.');
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => {
    const dependencies = (manifest as Record<string, unknown>)[field];
    return dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) && Object.hasOwn(dependencies, PACKAGE_NAME);
  });
}

export async function installVerify(cwd: string): Promise<void> {
  const manager = detectPackageManager(cwd);
  if (!existsSync(join(cwd, 'package.json'))) await writeFile(join(cwd, 'package.json'), '{\n  "private": true,\n  "type": "module"\n}\n', { flag: 'wx' });
  const args = manager === 'npm'
    ? ['install', '--save-dev', '--ignore-scripts']
    : manager === 'yarn'
    ? ['add', '--dev', '--mode=skip-builds']
    : ['add', '--dev', '--ignore-scripts'];
  args.push(PACKAGE_NAME);
  process.stdout.write(`Installing ${PACKAGE_NAME} with ${manager}...\n`);
  await new Promise<void>((resolve, reject) => {
    const env = Object.fromEntries(
      ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP'].flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    const child = spawn(manager, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32', timeout: 180_000, killSignal: 'SIGKILL' });
    const fail = () => reject(new VerifyError('CONFIG_INVALID', `Could not install ${PACKAGE_NAME} with ${manager}. Install it manually, then retry init --no-install.`));
    child.once('error', fail);
    child.once('exit', (code) => code === 0 ? resolve() : fail());
  });
}

function detectPackageManager(cwd: string): PackageManager {
  const lockfiles: Array<[string, PackageManager]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']];
  for (let directory = cwd; ; directory = dirname(directory)) {
    const managers = [...new Set(lockfiles.filter(([file]) => existsSync(join(directory, file))).map(([, manager]) => manager))];
    if (managers.length > 1) throw new VerifyError('CONFIG_INVALID', 'Found lockfiles for multiple package managers. Keep the project lockfile and retry init.');
    if (managers[0]) return managers[0];
    if (dirname(directory) === directory) return 'npm';
  }
}
