import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));

export const VERSION: string = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }).version;
