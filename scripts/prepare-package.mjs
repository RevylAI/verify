import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function packageReadme(markdown, version) {
  const source = `https://github.com/RevylAI/verify`;
  const destination = (path, image = false) => {
    if (/^(?:https?:|mailto:|#)/.test(path)) return path;
    const relative = path.replace(/^\.\//, '');
    return image
      ? `https://raw.githubusercontent.com/RevylAI/verify/v${version}/${relative}`
      : `${source}/${relative.endsWith('/') ? 'tree' : 'blob'}/v${version}/${relative}`;
  };
  return markdown
    .replace(/(!?)\[([^\]]*)\]\(([^)]+)\)/g, (_, image, label, path) => `${image}[${label}](${destination(path, Boolean(image))})`)
    .replace(/(href|src)="([^"]+)"/g, (_, attribute, path) => `${attribute}="${destination(path, attribute === 'src')}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const output = new URL('packages/verify/', root);
  const { version } = JSON.parse(readFileSync(new URL('package.json', output), 'utf8'));
  writeFileSync(new URL('README.md', output), packageReadme(readFileSync(new URL('README.md', root), 'utf8'), version));
  for (const file of ['LICENSE', 'CHANGELOG.md', 'SECURITY.md']) copyFileSync(new URL(file, root), new URL(file, output));
}
