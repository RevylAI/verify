import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageReadme } from './prepare-package.mjs';

test('npm README pins repository links and hero assets to the package version', () => {
  const markdown = '[Docs](packages/verify/docs/) [API](packages/verify/docs/api.md#open) ![Proof](docs/assets/verify-web-proof.png) <a href="packages/verify/docs/end-to-end.md">Evidence</a>';
  const result = packageReadme(markdown, '0.2.0');
  assert.ok(result.includes('https://github.com/RevylAI/verify/tree/v0.2.0/packages/verify/docs/'));
  assert.ok(result.includes('https://github.com/RevylAI/verify/blob/v0.2.0/packages/verify/docs/api.md#open'));
  assert.ok(result.includes('https://raw.githubusercontent.com/RevylAI/verify/v0.2.0/docs/assets/verify-web-proof.png'));
  assert.ok(result.includes('href="https://github.com/RevylAI/verify/blob/v0.2.0/packages/verify/docs/end-to-end.md"'));
  assert.ok(!result.includes('/main/'));
  assert.equal(packageReadme('[![License](https://img.shields.io/github/license/RevylAI/verify)](LICENSE)', '0.2.0'), '[![License](https://img.shields.io/github/license/RevylAI/verify)](https://github.com/RevylAI/verify/blob/v0.2.0/LICENSE)');
});

test('npm README preserves external badges, registry links and in-page anchors', () => {
  const markdown = '[![npm](https://img.shields.io/npm/v/@revyl/verify)](https://www.npmjs.com/package/@revyl/verify) [Start](#start)';
  assert.equal(packageReadme(markdown, '0.2.0'), markdown);
});
