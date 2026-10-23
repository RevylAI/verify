import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; version: string };
export const VERSION: string = manifest.version;
export const PACKAGE_NAME: string = manifest.name;
