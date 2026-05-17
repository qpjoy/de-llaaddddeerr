#!/usr/bin/env node
/**
 * Build helper: emit `dist/plugin.manifest.json` with its `version` field
 * forced to match `package.json#version`. Prevents the "I bumped package
 * but forgot the manifest → marketplace shows the old version" footgun.
 *
 * Run after `tsc`:
 *   pnpm build  →  tsc && node scripts/sync-manifest.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'src/plugin.manifest.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  // eslint-disable-next-line no-console
  console.warn(
    `[sync-manifest] forcing manifest.version ${manifest.version} → ${pkg.version} (from package.json)`
  );
  manifest.version = pkg.version;
  // Also keep src/ in sync so the next commit isn't tempted to drift.
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
// eslint-disable-next-line no-console
console.log(`[sync-manifest] wrote dist/plugin.manifest.json @ ${manifest.version}`);
