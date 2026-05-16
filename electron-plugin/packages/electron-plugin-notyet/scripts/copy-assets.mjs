#!/usr/bin/env node
/**
 * Post-tsc step: copies non-TS assets into dist/.
 *
 *   - src/plugin.manifest.json → dist/plugin.manifest.json
 *   - src/assets/*             → dist/assets/*
 *
 * Also performs a manifest version sync: the published `package.json#version`
 * is the source of truth, and `plugin.manifest.json#version` is rewritten to
 * match it. That way a `pnpm version patch` only has to touch package.json.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const distDir = resolve(root, 'dist');
const srcManifest = resolve(root, 'src', 'plugin.manifest.json');
const distManifest = resolve(distDir, 'plugin.manifest.json');
const srcAssets = resolve(root, 'src', 'assets');
const distAssets = resolve(distDir, 'assets');

mkdirSync(distDir, { recursive: true });

// 1. Sync manifest version with package.json, then write to dist.
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(srcManifest, 'utf8'));
const desired = pkg.version;
let updated = false;
if (manifest.version !== desired) {
  manifest.version = desired;
  updated = true;
}
writeFileSync(distManifest, JSON.stringify(manifest, null, 2) + '\n');
console.log(`[copy-assets] wrote dist/plugin.manifest.json @ ${desired}${updated ? ' (synced from package.json)' : ''}`);

// 2. Mirror src/assets/ into dist/assets/.
if (existsSync(distAssets)) rmSync(distAssets, { recursive: true, force: true });
if (existsSync(srcAssets)) {
  cpSync(srcAssets, distAssets, { recursive: true });
  console.log(`[copy-assets] copied src/assets → ${distAssets}`);
} else {
  console.warn(`[copy-assets] ${srcAssets} not found — overlay UI will not load.`);
}
