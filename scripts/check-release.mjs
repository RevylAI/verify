import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkReleaseTag(version, tag) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'The package needs a release version.');
  assert.equal(tag, `v${version}`, 'The tag must exactly match the package version.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL('../packages/verify/package.json', import.meta.url), 'utf8'));
  checkReleaseTag(version, process.argv[2]);
  console.log(`Release tag matches package version ${version}.`);
}
