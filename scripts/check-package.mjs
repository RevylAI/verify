import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--workspace', './packages/verify', '--pack-destination', directory], { encoding: 'utf8' }));
  const archive = join(directory, pack.filename);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  const readme = execFileSync('tar', ['-xOf', archive, 'package/README.md'], { encoding: 'utf8' });
  assert.ok(!readme.includes('verify-web-proof.png') && !readme.includes('Cropped from a passing TypeScript run'));
  assert.ok(readme.includes(`https://github.com/RevylAI/verify/tree/v${manifest.version}/packages/verify/docs/`));
  assert.ok(!readme.includes('](packages/') && !readme.includes('](docs/') && !readme.includes('href="packages/'));
  assert.ok(readme.includes(`](https://github.com/RevylAI/verify/blob/v${manifest.version}/LICENSE)`));
  assert.deepEqual(manifest.bin, { verify: './dist/cli/main.js', 'revyl-verify': './dist/cli/main.js' });
  assert.ok(execFileSync('tar', ['-xOf', archive, 'package/dist/cli/main.js'], { encoding: 'utf8' }).startsWith('#!/usr/bin/env node\n'));
  assert.ok(pack.files.find((file) => file.path === 'dist/cli/main.js').mode & 0o111);
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
