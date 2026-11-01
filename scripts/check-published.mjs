import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readReleasePackages } from './release-packages.mjs';

async function publishedMetadata(name, version, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (response.status === 404) return false;
  assert.equal(response.status, 200, `npm version lookup failed with HTTP ${response.status}; refusing to assume the version is unpublished.`);
  const metadata = await response.json();
  assert.equal(metadata.name, name, 'npm returned unexpected package metadata.');
  assert.equal(metadata.version, version, 'npm returned unexpected version metadata.');
  return metadata;
}

export async function publishedVersionExists(name, version, fetchImpl = fetch) {
  return Boolean(await publishedMetadata(name, version, fetchImpl));
}

export async function publishedPackageMatches(name, version, archivePath, fetchImpl = fetch) {
  const metadata = await publishedMetadata(name, version, fetchImpl);
  if (!metadata) return false;
  const expectedIntegrity = `sha512-${createHash('sha512').update(await readFile(archivePath)).digest('base64')}`;
  assert.equal(metadata.dist?.integrity, expectedIntegrity, `${name}@${version} is already published with different bytes.`);
  return true;
}

export async function publishedPackageVersions(packages, archivePaths, fetchImpl = fetch) {
  const published = {};
  for (const { id, name, version } of packages) {
    published[id] = await publishedPackageMatches(name, version, archivePaths[id], fetchImpl);
  }
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.argv[2] ?? 'push';
  assert.ok(process.argv.length === 5 && ['push', 'workflow_dispatch'].includes(event), 'Expected push or workflow_dispatch followed by two archives.');
  const packages = readReleasePackages();
  const archivePaths = { scoped: process.argv[3], alias: process.argv[4] };
  const published = await publishedPackageVersions(packages, archivePaths);
  for (const { id, name, version } of packages) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${id}_published=${published[id]}\n`);
    console.log(`${name}@${version}: ${published[id] ? 'already published; skipping publication' : 'not published'}.`);
  }
}
