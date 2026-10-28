import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readReleasePackages } from './release-packages.mjs';

export function checkReleaseTag(version, tag) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'The package needs a release version.');
  assert.equal(tag, `v${version}`, 'The tag must exactly match the package version.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [{ version }] = readReleasePackages();
  checkReleaseTag(version, process.argv[2]);
  console.log(`Release tag matches package version ${version}.`);
}
