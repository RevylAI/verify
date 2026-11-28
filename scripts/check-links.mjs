// Release link gate: every http(s) link an agent is handed must answer 200 and must not pin an older release.
// Run with `npm run check:links` (Node.js 22 or later, no dependencies).
import { existsSync, readFileSync } from 'node:fs';

const FILES = [
  'skills/revyl-verify/SKILL.md',
  'README.md',
  'python/README.md',
  'go/README.md',
  'packages/verify/docs/llms.txt',
  'packages/verify/docs/README.md',
];
// Code blocks hold example values (API base URLs, placeholder hosts); a URL there is checked only on these hosts.
const PAGE_HOSTS_IN_CODE = new Set(['docs.revyl.com', 'github.com', 'raw.githubusercontent.com', 'www.npmjs.com', 'pypi.org']);
// docs.revyl.com guides that aren't published yet: checked through their copy in this checkout until they are.
const UNPROMOTED_GUIDES = ['mac-model-checks', 'apps-inside-an-inference-mac', 'persistent-computers'];
const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;

const versions = {
  npm: JSON.parse(readFileSync('packages/verify/package.json', 'utf8')).version,
  py: readFileSync('python/pyproject.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  go: readFileSync('go/client.go', 'utf8').match(/\bVersion\s*=\s*"([^"]+)"/)?.[1],
};
const SOURCES = { npm: 'packages/verify/package.json', py: 'python/pyproject.toml', go: 'the Version const in go/client.go' };
for (const [line, version] of Object.entries(versions)) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`Could not read the version from ${SOURCES[line]}.`);
}

const failures = [];
const notes = new Set();
const links = new Map();

for (const file of FILES) {
  const text = readFileSync(file, 'utf8');
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const code = codeRanges(text);
  for (const match of text.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) {
    const url = match[0].replace(/[.,;:!?*_]+$/, '');
    if (/[…{}$]/.test(url)) continue;
    const inCode = code.some(([start, end]) => match.index >= start && match.index < end);
    if (inCode && !PAGE_HOSTS_IN_CODE.has(new URL(url).hostname)) continue;
    if (!links.has(url)) links.set(url, []);
    links.get(url).push(`${file}:${lineOf(match.index)}`);
  }
  const pins = [
    [/@revyl\/verify@(\d+\.\d+\.\d+)/g, 'npm'],
    [/(?<![\w/@-])revyl-verify@(\d+\.\d+\.\d+)/g, 'npm'],
    [/\brevyl-verify==(\d+\.\d+\.\d+)/g, 'py'],
    [/github\.com\/RevylAI\/verify\/go@v(\d+\.\d+\.\d+)/g, 'go'],
  ];
  for (const [pattern, line] of pins) {
    for (const match of text.matchAll(pattern)) checkVersion(match[0], line, match[1], `${file}:${lineOf(match.index)}`);
  }
}

const queue = [...links.entries()];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let entry = queue.shift(); entry; entry = queue.shift()) await checkLink(...entry);
}));

for (const note of [...notes].sort()) console.log(`note: ${note}`);
if (failures.length > 0) {
  for (const failure of failures.sort()) console.error(`FAIL ${failure}`);
  console.error(`${failures.length} link problem(s).`);
  process.exit(1);
}
console.log(`${links.size} links in ${FILES.length} files answer 200 and pin no other release than npm ${versions.npm}, Python ${versions.py} and Go v${versions.go}.`);

async function checkLink(url, places) {
  const where = places.join(', ');
  const parsed = new URL(url);
  const tagged = parsed.hostname === 'github.com'
    ? parsed.pathname.match(/^\/RevylAI\/verify\/(?:blob|tree)\/((?:py\/|go\/)?v\d+\.\d+\.\d+)(\/.*)?$/)
    : parsed.hostname === 'raw.githubusercontent.com' ? parsed.pathname.match(/^\/RevylAI\/verify\/((?:py\/|go\/)?v\d+\.\d+\.\d+)(\/.*)?$/) : null;
  if (tagged) {
    const [, ref, path = '/'] = tagged;
    const line = ref.startsWith('py/') ? 'py' : ref.startsWith('go/') ? 'go' : 'npm';
    const version = ref.replace(/^(py\/|go\/)?v/, '');
    if (!checkVersion(url, line, version, where)) return;
    notes.add(`${ref} is the current ${line} release, tagged only when it ships, so links to it are checked against this checkout.`);
    checkLocal(url, decodeURIComponent(path.slice(1)), parsed.hash, where);
    return;
  }
  const guide = parsed.hostname === 'docs.revyl.com' ? parsed.pathname.match(/^\/verify\/guides\/([a-z-]+)$/)?.[1] : undefined;
  if (guide && UNPROMOTED_GUIDES.includes(guide)) {
    if (await status(url) === 200) {
      notes.add(`${url} is published now; remove "${guide}" from UNPROMOTED_GUIDES in scripts/check-links.mjs.`);
    } else {
      notes.add(`${url} isn't on docs.revyl.com yet, so it is checked through packages/verify/docs/guides/${guide}.md.`);
      checkLocal(url, `packages/verify/docs/guides/${guide}.md`, '', where);
    }
    return;
  }
  const onMain = parsed.hostname === 'github.com' ? parsed.pathname.match(/^\/RevylAI\/verify\/(?:blob|tree)\/main(\/.*)?$/) : null;
  if (onMain) {
    notes.add('Links to this repository\'s main branch are checked against this checkout, which becomes main when it merges.');
    checkLocal(url, decodeURIComponent((onMain[1] ?? '/').slice(1)), parsed.hash, where);
    return;
  }
  const npmPackage = parsed.hostname === 'www.npmjs.com' ? parsed.pathname.match(/^\/package\/((?:@[^/]+\/)?[^/]+)\/?$/)?.[1] : undefined;
  if (npmPackage) notes.add('www.npmjs.com refuses scripted requests, so npm package pages are checked through registry.npmjs.org.');
  const code = await status(npmPackage ? `https://registry.npmjs.org/${npmPackage.replace('/', '%2F')}` : url);
  if (code !== 200) failures.push(`${url} answered ${code} (${where})`);
}

function checkVersion(link, line, version, where) {
  const current = versions[line];
  const order = compare(version, current);
  if (order === 0) return true;
  failures.push(`${link} names ${version}, ${order < 0 ? 'older' : 'newer'} than ${current} in ${SOURCES[line]} (${where})`);
  return false;
}

function checkLocal(url, path, hash, where) {
  const file = path.replace(/\/$/, '') || '.';
  if (!existsSync(file)) {
    failures.push(`${url}: ${file} is not in this checkout (${where})`);
    return;
  }
  if (!hash || !file.endsWith('.md')) return;
  const anchor = decodeURIComponent(hash.slice(1));
  if (!headingAnchors(readFileSync(file, 'utf8')).has(anchor)) failures.push(`${url}: ${file} has no heading for #${anchor} (${where})`);
}

function headingAnchors(markdown) {
  const seen = new Map();
  const anchors = new Set();
  for (const [, heading] of markdown.replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1/gm, '').matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = heading.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

async function status(url) {
  let last = 'no answer';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'revyl-verify-check-links' } });
        await response.body?.cancel();
        if (response.status === 200) return 200;
        last = response.status;
      } catch (error) {
        last = error?.cause?.code ?? error?.name ?? 'a network error';
      }
    }
    if (typeof last === 'number' && last !== 429 && last < 500) return last;
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  return last;
}

function codeRanges(text) {
  const ranges = [...text.matchAll(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm)].map((match) => [match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/(`+)[^`\n][^\n]*?\1/g)) {
    if (!ranges.some(([start, end]) => match.index >= start && match.index < end)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function compare(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
