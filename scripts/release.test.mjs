import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReleaseTag } from './check-release.mjs';
import { publishedVersionExists, requireCiPublishing } from './check-published.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

test('release tags must match the package version exactly', () => {
  checkReleaseTag('0.2.0', 'v0.2.0');
  for (const tag of ['v0.3.0', '0.2.0', 'v0.2.0-extra', undefined]) {
    assert.throws(() => checkReleaseTag('0.2.0', tag));
  }
});

test('publication lookup skips only the exact published package version', async () => {
  const published = await publishedVersionExists('@revyl/verify', '0.2.0', async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40revyl%2Fverify/0.2.0');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ name: '@revyl/verify', version: '0.2.0' });
  });
  assert.equal(published, true);
  assert.equal(await publishedVersionExists('@revyl/verify', '0.2.0', async () => new Response(null, { status: 404 })), false);
});

test('unpublished versions require explicit administrator opt-in to CI publication', () => {
  for (const enabled of [undefined, '', 'false', 'TRUE', '1']) {
    assert.throws(() => requireCiPublishing(false, enabled), /CI publication is disabled/);
    requireCiPublishing(true, enabled);
  }
  requireCiPublishing(false, 'true');
});

test('release workflow skips publication dry-run and publish for an already-published tag', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const dryRun = workflow.match(/      - name: Dry-run publication\n        if: (.+)\n        run: (.+)/);
  assert.ok(dryRun);
  assert.equal(dryRun[2], 'npm publish ./release-artifacts/*.tgz --dry-run --access public');
  assert.ok(workflow.indexOf('id: registry') < dryRun.index);
  assert.ok(workflow.indexOf('- run: npm run check:package') < dryRun.index);
  const publish = workflow.match(/  publish:\n    if: (.+)/);
  assert.ok(publish);
  for (const [event, published, enabled, expectedDryRun, expectedPublish] of [
    ['push', 'true', undefined, false, false],
    ['push', 'true', 'true', false, false],
    ['push', 'false', 'true', true, true],
    ['push', '', 'true', false, false],
    ['workflow_dispatch', '', undefined, true, false],
  ]) {
    const context = {
      github: { event_name: event, ref: 'refs/tags/v0.2.0' },
      steps: { registry: { outputs: { published } } },
      needs: { validate: { outputs: { published } } },
      vars: { VERIFY_CI_PUBLISH_ENABLED: enabled },
      startsWith: (value, prefix) => value.startsWith(prefix),
    };
    assert.equal(runInNewContext(dryRun[1], context), expectedDryRun, `${event}/${published}: dry-run`);
    assert.equal(runInNewContext(publish[1], context), expectedPublish, `${event}/${published}: publish`);
  }
});

test('publication lookup fails closed on registry and transport errors', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', async () => new Response(null, { status })), /npm version lookup failed/);
  }
  for (const metadata of [{ name: 'another-package', version: '0.2.0' }, { name: '@revyl/verify', version: '0.1.0' }, {}]) {
    await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', async () => Response.json(metadata)), /unexpected/);
  }
  await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', async () => new Response('invalid JSON')));
  await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', async () => { throw new Error('network unavailable'); }), /network unavailable/);
});

test('one fallback command updates manifests, docs, and the generated npm lockfile', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-rename-'));
  try {
    for (const dir of ['scripts', 'packages/verify', 'examples/example']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*', 'examples/*'] }));
    writeFileSync(join(root, 'packages/verify/package.json'), JSON.stringify({ name: '@revyl/verify', version: '0.2.0' }));
    writeFileSync(join(root, 'examples/example/package.json'), JSON.stringify({ name: 'example', private: true, dependencies: { '@revyl/verify': '0.2.0' } }));
    writeFileSync(join(root, 'README.md'), 'npm install @revyl/verify');
    copyFileSync(new URL('./rename-package.mjs', import.meta.url), join(root, 'scripts/rename-package.mjs'));
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', 'package.json', 'packages/verify/package.json', 'examples/example/package.json', 'README.md', 'scripts/rename-package.mjs'], { cwd: root });
    execFileSync(process.execPath, ['scripts/rename-package.mjs', 'revyl-verify'], { cwd: root, stdio: 'pipe' });
    assert.equal(JSON.parse(readFileSync(join(root, 'packages/verify/package.json'))).name, 'revyl-verify');
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), 'npm install revyl-verify');
    assert.equal(JSON.parse(readFileSync(join(root, 'examples/example/package.json'))).dependencies['revyl-verify'], '0.2.0');
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
    assert.equal(lock.packages['packages/verify'].name, 'revyl-verify');
    assert.equal(lock.packages['node_modules/revyl-verify'].link, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
