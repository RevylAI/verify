#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const manifest = createRequire(import.meta.url).resolve('@revyl/verify/package.json');
await import(new URL('./dist/cli/main.js', pathToFileURL(manifest)).href);
