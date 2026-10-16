import { execFileSync } from 'node:child_process';

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/main.js',
  'docs/README.md',
  'docs/agents.md',
  'docs/getting-started.md',
  'docs/llms.txt',
];

const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--workspace', '@revyl/verify'], { encoding: 'utf8' }));
const files = new Set(pack.files.map((file) => file.path));
const missing = required.filter((path) => !files.has(path));
const unexpected = [...files].filter((path) => /^(src|test)\//.test(path) || path.endsWith('.tsbuildinfo'));
if (missing.length > 0 || unexpected.length > 0) {
  console.error(`Missing from the package: ${missing.join(', ') || 'none'}`);
  console.error(`Should not be in the package: ${unexpected.join(', ') || 'none'}`);
  process.exit(1);
}
console.log(`${pack.name}@${pack.version}: ${files.size} files, ${pack.size} bytes packed`);
