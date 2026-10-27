import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readReleasePackages } from './release-packages.mjs';

export async function publishedVersionExists(name, version, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (response.status === 404) return false;
  assert.equal(response.status, 200, `npm version lookup failed with HTTP ${response.status}; refusing to assume the version is unpublished.`);
  const metadata = await response.json();
  assert.equal(metadata.name, name, 'npm returned unexpected package metadata.');
  assert.equal(metadata.version, version, 'npm returned unexpected version metadata.');
  return true;
}

export function requireCiPublishing(published, enabled) {
  assert.ok(published || enabled === 'true', 'CI publication is disabled. A repository administrator must protect the npm environment and enable VERIFY_CI_PUBLISH_ENABLED, or publish the reviewed archive manually.');
}

export async function publishedPackageVersions(packages, fetchImpl = fetch) {
  const published = {};
  for (const { id, name, version } of packages) {
    published[id] = await publishedVersionExists(name, version, fetchImpl);
  }
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.argv[2] ?? 'push';
  assert.ok(process.argv.length <= 3 && ['push', 'workflow_dispatch'].includes(event), 'Expected push or workflow_dispatch.');
  const packages = readReleasePackages();
  const published = await publishedPackageVersions(packages);
  if (event === 'push') requireCiPublishing(Object.values(published).every(Boolean), process.env.VERIFY_CI_PUBLISH_ENABLED);
  for (const { id, name, version } of packages) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${id}_published=${published[id]}\n`);
    console.log(`${name}@${version}: ${published[id] ? 'already published; skipping publication' : 'not published'}.`);
  }
}
