import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReleaseTag } from './check-release.mjs';
import { createHash } from 'node:crypto';
import { publishedVersionExists, publishedPackageVersions } from './check-published.mjs';
import { checkPackageVersions, readReleasePackages } from './release-packages.mjs';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('release tags must match the package version exactly', () => {
  checkReleaseTag('0.2.0', 'v0.2.0');
  for (const tag of ['v0.3.0', '0.2.0', 'v0.2.0-extra', undefined]) {
    assert.throws(() => checkReleaseTag('0.2.0', tag));
  }
});

test('publication lookup skips only the exact published package version', async () => {
  const archive = new URL('../package.json', import.meta.url);
  const integrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;
  const published = await publishedVersionExists('@revyl/verify', '0.2.0', archive, async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40revyl%2Fverify/0.2.0');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ name: '@revyl/verify', version: '0.2.0', dist: { integrity } });
  });
  assert.equal(published, true);
  assert.equal(await publishedVersionExists('@revyl/verify', '0.2.0', archive, async () => new Response(null, { status: 404 })), false);
});

test('release workflow uses npm trusted publishing without token configuration', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /id-token: write/);
  assert.ok(workflow.includes(`printf 'registry=https://registry.npmjs.org/\\n' > "$NPM_CONFIG_USERCONFIG"`));
  assert.match(workflow, /env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm publish/);
  assert.doesNotMatch(workflow, /(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*:|VERIFY_CI_PUBLISH_ENABLED|environment:/);
});

test('release workflow guards each package independently and publishes scoped first', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const dryRuns = [...workflow.matchAll(/      - name: Dry-run (scoped|alias) publication\n        if: (.+)\n        run: (.+)/g)];
  const publications = [...workflow.matchAll(/      - name: Publish (scoped package|alias) with provenance\n        if: (.+)\n        run: (.+)/g)];
  assert.equal(dryRuns.length, 2);
  assert.equal(publications.length, 2);
  assert.ok(workflow.indexOf('id: registry') < dryRuns[0].index);
  assert.ok(workflow.indexOf('- run: npm run check:package') < dryRuns[0].index);
  assert.equal(workflow.match(/run: node scripts\/check-published.mjs release-artifacts\/scoped\/\*\.tgz release-artifacts\/alias\/\*\.tgz/g).length, 2);
  assert.equal(publications[0][1], 'scoped package');
  assert.equal(publications[1][1], 'alias');
  for (const [index, id] of ['scoped', 'alias'].entries()) {
    assert.equal(dryRuns[index][3], `npm publish ./release-artifacts/${id}/*.tgz --dry-run --access public`);
    assert.equal(publications[index][3], `env -u NODE_AUTH_TOKEN -u NPM_TOKEN npm publish ./release-artifacts/${id}/*.tgz --provenance --access public`);
  }
  const publish = workflow.match(/  publish:\n    if: (.+)/);
  assert.ok(publish);
  for (const [event, scoped, alias, expectedJob] of [
    ['push', 'true', 'true', false],
    ['push', 'false', 'false', true],
    ['push', 'true', 'false', true],
    ['push', 'false', 'true', true],
    ['workflow_dispatch', 'false', 'false', false],
    ['workflow_dispatch', 'true', 'true', false],
  ]) {
    const outputs = { scoped_published: scoped, alias_published: alias };
    const context = {
      github: { event_name: event, ref: 'refs/tags/v0.2.0' },
      steps: { registry: { outputs } },
      needs: { validate: { outputs } },
      startsWith: (value, prefix) => value.startsWith(prefix),
    };
    for (const [index, published] of [scoped, alias].entries()) {
      assert.equal(runInNewContext(dryRuns[index][2], context), event === 'workflow_dispatch' || published === 'false');
      assert.equal(runInNewContext(publications[index][2], context), published === 'false');
    }
    assert.equal(runInNewContext(publish[1], context), expectedJob);
  }
});

test('publication lookup fails closed on registry and transport errors', async () => {
  const archive = new URL('../package.json', import.meta.url);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', archive, async () => new Response(null, { status })), /npm version lookup failed/);
  }
  for (const metadata of [{ name: 'another-package', version: '0.2.0' }, { name: '@revyl/verify', version: '0.1.0' }, {}]) {
    await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', archive, async () => Response.json(metadata)), /unexpected/);
  }
  await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', archive, async () => Response.json({ name: '@revyl/verify', version: '0.2.0', dist: { integrity: 'sha512-different' } })), /different bytes/);
  await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', archive, async () => new Response('invalid JSON')));
  await assert.rejects(publishedVersionExists('@revyl/verify', '0.2.0', archive, async () => { throw new Error('network unavailable'); }), /network unavailable/);
});

test('both packages and the alias dependency stay in exact version lockstep', () => {
  const [scoped, alias] = readReleasePackages();
  assert.equal(scoped.version, alias.version);
  const source = { name: '@revyl/verify', version: '0.2.0' };
  const target = { name: 'revyl-verify', version: '0.2.0', dependencies: { '@revyl/verify': '0.2.0' } };
  checkPackageVersions(source, target);
  assert.throws(() => checkPackageVersions(source, { ...target, version: '0.2.1' }), /same version/);
  for (const version of ['^0.2.0', '~0.2.0', '*', '0.2.1']) {
    assert.throws(() => checkPackageVersions(source, { ...target, dependencies: { '@revyl/verify': version } }), /exact scoped version/);
  }
});

test('registry checks each package for both-published and partial-release states', async () => {
  const packages = readReleasePackages();
  const archives = { scoped: new URL('../package.json', import.meta.url), alias: new URL('../package.json', import.meta.url) };
  const integrity = `sha512-${createHash('sha512').update(await readFile(archives.scoped)).digest('base64')}`;
  for (const scoped of [true, false]) {
    for (const alias of [true, false]) {
      const state = { scoped, alias };
      const requests = [];
      const result = await publishedPackageVersions(packages, archives, async (url) => {
        requests.push(url);
        const pkg = packages.find(({ name, version }) => url.endsWith(`/${encodeURIComponent(name)}/${version}`));
        assert.ok(pkg);
        return state[pkg.id] ? Response.json({ name: pkg.name, version: pkg.version, dist: { integrity } }) : new Response(null, { status: 404 });
      });
      assert.deepEqual(result, state);
      assert.equal(requests.length, 2);
    }
  }
  await assert.rejects(publishedPackageVersions(packages, archives, async (url) => url.includes('%40revyl')
    ? Response.json({ name: '@revyl/verify', version: packages[0].version, dist: { integrity } })
    : new Response(null, { status: 503 })), /HTTP 503/);
});
