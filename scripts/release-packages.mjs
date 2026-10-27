import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export function checkPackageVersions(scoped, alias) {
  assert.equal(scoped.name, '@revyl/verify');
  assert.equal(alias.name, 'revyl-verify');
  assert.equal(alias.version, scoped.version, 'Both npm packages must have the same version.');
  assert.equal(alias.dependencies?.[scoped.name], scoped.version, 'The alias must depend on the exact scoped version.');
}

export function readReleasePackages() {
  const scoped = JSON.parse(readFileSync(new URL('../packages/verify/package.json', import.meta.url), 'utf8'));
  const alias = JSON.parse(readFileSync(new URL('../packages/revyl-verify/package.json', import.meta.url), 'utf8'));
  checkPackageVersions(scoped, alias);
  return [
    { id: 'scoped', name: scoped.name, version: scoped.version },
    { id: 'alias', name: alias.name, version: alias.version },
  ];
}
