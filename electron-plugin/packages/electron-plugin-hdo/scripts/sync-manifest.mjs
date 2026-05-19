#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'src/plugin.manifest.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(
    resolve(root, 'src/plugin.manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
}

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(
  resolve(root, 'dist/plugin.manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log(`[sync-manifest] wrote dist/plugin.manifest.json @ ${manifest.version}`);
