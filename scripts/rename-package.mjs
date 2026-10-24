import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = new URL('../packages/verify/package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const requested = process.argv[2];
if (requested !== 'revyl-verify') throw new Error('Usage: npm run package:rename -- revyl-verify');
if (manifest.name === requested) {
  console.log('The fallback package name is already selected.');
} else {
  if (manifest.name !== '@revyl/verify') throw new Error('Unexpected current package name; review the manifest before renaming.');
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of paths) {
    if (path === 'package-lock.json' || path === 'scripts/rename-package.mjs' || path === 'scripts/release.test.mjs') continue;
    const absolute = new URL(path, new URL('../', import.meta.url));
    const content = readFileSync(absolute, 'utf8');
    if (content.includes(manifest.name)) writeFileSync(absolute, content.replaceAll(manifest.name, requested));
  }
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  console.log('Fallback selected. Review the diff and rerun build, typecheck, tests, and package checks.');
}
