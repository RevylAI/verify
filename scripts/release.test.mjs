import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReleaseTag } from './check-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('release tags must match the package version exactly', () => {
  checkReleaseTag('0.1.0', 'v0.1.0');
  for (const tag of ['v0.2.0', '0.1.0', 'v0.1.0-extra', undefined]) {
    assert.throws(() => checkReleaseTag('0.1.0', tag));
  }
});

test('one fallback command updates manifests, docs, and the generated npm lockfile', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-rename-'));
  try {
    for (const dir of ['scripts', 'packages/verify', 'examples/example']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*', 'examples/*'] }));
    writeFileSync(join(root, 'packages/verify/package.json'), JSON.stringify({ name: '@revyl/verify', version: '0.1.0' }));
    writeFileSync(join(root, 'examples/example/package.json'), JSON.stringify({ name: 'example', private: true, dependencies: { '@revyl/verify': '0.1.0' } }));
    writeFileSync(join(root, 'README.md'), 'npm install @revyl/verify');
    copyFileSync(new URL('./rename-package.mjs', import.meta.url), join(root, 'scripts/rename-package.mjs'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', 'package.json', 'packages/verify/package.json', 'examples/example/package.json', 'README.md', 'scripts/rename-package.mjs'], { cwd: root });
    execFileSync(process.execPath, ['scripts/rename-package.mjs', 'revyl-verify'], { cwd: root, stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(join(root, 'packages/verify/package.json'))).name, 'revyl-verify');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'npm install revyl-verify');
    assert.equal(JSON.parse(readFileSync(join(root, 'examples/example/package.json'))).dependencies['revyl-verify'], '0.1.0');
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
    assert.equal(lock.packages['packages/verify'].name, 'revyl-verify');
    assert.equal(lock.packages['node_modules/revyl-verify'].link, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
