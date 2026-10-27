import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(readFileSync(new URL('../packages/verify/package.json', import.meta.url), 'utf8'));
  const published = await publishedVersionExists(name, version);
  requireCiPublishing(published, process.env.VERIFY_CI_PUBLISH_ENABLED);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
  console.log(`${name}@${version}: ${published ? 'already published; skipping publication' : 'not published'}.`);
}
