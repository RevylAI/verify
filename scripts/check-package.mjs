import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readReleasePackages } from './release-packages.mjs';

readReleasePackages();

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'SECURITY.md',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/main.js',
  'docs/README.md',
  'docs/end-to-end.md',
  'docs/agents.md',
  'docs/api.md',
  'docs/getting-started.md',
  'docs/llms.txt',
  'docs/computers.md',
  'docs/linux-computers-contract.md',
];

const directory = mkdtempSync(join(tmpdir(), 'verify-package-'));
let pack;
try {
  const scopedDirectory = join(directory, 'scoped');
  const aliasDirectory = join(directory, 'alias');
  mkdirSync(scopedDirectory);
  mkdirSync(aliasDirectory);
  [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--workspace', './packages/verify', '--pack-destination', scopedDirectory], { encoding: 'utf8' }));
  const archive = join(scopedDirectory, pack.filename);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  const readme = execFileSync('tar', ['-xOf', archive, 'package/README.md'], { encoding: 'utf8' });
  assert.ok(!readme.includes('verify-web-proof.png') && !readme.includes('Cropped from a passing TypeScript run'));
  assert.ok(readme.includes(`https://github.com/RevylAI/verify/tree/v${manifest.version}/packages/verify/docs/`));
  assert.ok(!readme.includes('](packages/') && !readme.includes('](docs/') && !readme.includes('href="packages/'));
  assert.ok(readme.includes(`](https://github.com/RevylAI/verify/blob/v${manifest.version}/LICENSE)`));
  assert.deepEqual(manifest.bin, { verify: './dist/cli/main.js', 'revyl-verify': './dist/cli/main.js' });
  assert.ok(execFileSync('tar', ['-xOf', archive, 'package/dist/cli/main.js'], { encoding: 'utf8' }).startsWith('#!/usr/bin/env node\n'));
  assert.ok(pack.files.find((file) => file.path === 'dist/cli/main.js').mode & 0o111);
  const [alias] = JSON.parse(execFileSync('npm', ['pack', '--json', '--workspace', './packages/revyl-verify', '--pack-destination', aliasDirectory], { encoding: 'utf8' }));
  assert.deepEqual(alias.files.map(({ path }) => path).sort(), ['LICENSE', 'README.md', 'cli.js', 'index.d.ts', 'index.js', 'package.json']);
  assert.ok(alias.files.find(({ path }) => path === 'cli.js').mode & 0o111);
  const aliasArchive = join(aliasDirectory, alias.filename);
  const aliasManifest = JSON.parse(execFileSync('tar', ['-xOf', aliasArchive, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(aliasManifest.version, manifest.version);
  assert.deepEqual(aliasManifest.dependencies, { [manifest.name]: manifest.version });
  assert.deepEqual(aliasManifest.bin, { 'revyl-verify': './cli.js' });
  for (const path of ['index.js', 'index.d.ts']) {
    assert.equal(execFileSync('tar', ['-xOf', aliasArchive, `package/${path}`], { encoding: 'utf8' }), "export * from '@revyl/verify';\n");
  }
  const consumer = join(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const env = { PATH: process.env.PATH, HOME: consumer, USERPROFILE: consumer };
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive, aliasArchive], { cwd: consumer, env, stdio: 'pipe', timeout: 120_000 });
  const scopedCli = join(consumer, 'node_modules/@revyl/verify/dist/cli/main.js');
  const aliasCli = join(consumer, 'node_modules/revyl-verify/cli.js');
  for (const args of [['--version'], ['--help'], ['whoami'], ['invalid-command']]) {
    const scopedResult = spawnSync(process.execPath, [scopedCli, ...args], { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 });
    const aliasResult = spawnSync(process.execPath, [aliasCli, ...args], { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(scopedResult.error);
    assert.ifError(aliasResult.error);
    assert.equal(aliasResult.status, scopedResult.status);
    assert.equal(aliasResult.stdout, scopedResult.stdout);
    assert.equal(aliasResult.stderr, scopedResult.stderr);
  }
  assert.equal(execFileSync('npx', ['--no-install', 'revyl-verify', '--version'], { cwd: consumer, env, encoding: 'utf8', timeout: 30_000 }).trim(), manifest.version);
  execFileSync('npx', ['--no-install', 'revyl-verify', 'init', '--platform', 'web'], { cwd: consumer, env, stdio: 'pipe', timeout: 30_000 });
  assert.ok(readFileSync(join(consumer, 'verify.config.ts'), 'utf8').includes('web'));
  const scopedProject = join(directory, 'scoped-project');
  mkdirSync(scopedProject);
  execFileSync(process.execPath, [scopedCli, 'init', '--platform', 'web'], { cwd: scopedProject, env, stdio: 'pipe', timeout: 30_000 });
  for (const file of ['verify.config.ts', 'verify/example.ts']) {
    assert.equal(readFileSync(join(consumer, file), 'utf8'), readFileSync(join(scopedProject, file), 'utf8'));
  }
  execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import * as alias from 'revyl-verify'; import * as scoped from '@revyl/verify'; assert.deepEqual(Object.keys(alias), Object.keys(scoped)); for (const key of Object.keys(scoped)) assert.equal(alias[key], scoped[key]);"], { cwd: consumer, env, stdio: 'pipe', timeout: 30_000 });
  writeFileSync(join(consumer, 'alias.ts'), "import { open, type TargetConfig } from 'revyl-verify';\nconst target: TargetConfig = { platform: 'mac' };\nvoid open; void target;\n");
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--allowImportingTsExtensions', '--typeRoots', resolve('node_modules/@types'), '--target', 'es2022', '--module', 'nodenext', 'alias.ts', 'verify.config.ts', 'verify/example.ts'], { cwd: consumer, env, stdio: 'inherit', timeout: 30_000 });
  console.log(`${alias.name}@${alias.version}: ${alias.files.length} files, ${alias.size} bytes packed; clean-install API, types and CLI parity passed`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
const files = new Set(pack.files.map((file) => file.path));
const missing = required.filter((path) => !files.has(path));
const unexpected = [...files].filter((path) => !required.includes(path) && !/^dist\/[a-z0-9/-]+\.(js|d\.ts)$/.test(path) && !/^docs\/[a-z-]+\.(md|txt)$/.test(path));
if (missing.length > 0 || unexpected.length > 0) {
  console.error(`Missing from the package: ${missing.join(', ') || 'none'}`);
  console.error(`Should not be in the package: ${unexpected.join(', ') || 'none'}`);
  process.exit(1);
}
console.log(`${pack.name}@${pack.version}: ${files.size} files, ${pack.size} bytes packed`);
