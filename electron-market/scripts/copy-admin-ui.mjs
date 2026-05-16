#!/usr/bin/env node
/**
 * Copy `packages/admin-ui/dist/` into `packages/electron-market/dist/admin-ui/`
 * so that AdminServer can serve the built Quasar SPA from inside the host
 * package's published tarball.
 *
 * Idempotent. If admin-ui hasn't been built yet, we log a warning and exit
 * 0 — the host then falls back to the inline placeholder HTML at runtime
 * so it stays usable for smoke tests.
 */
import { existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const adminUiDist = resolve(here, '..', 'packages', 'admin-ui', 'dist');
const hostDist = resolve(here, '..', 'packages', 'electron-market', 'dist');
const target = resolve(hostDist, 'admin-ui');

if (!existsSync(adminUiDist)) {
  console.warn(`[copy-admin-ui] ${adminUiDist} not found — skipping.`);
  console.warn('[copy-admin-ui] Run `pnpm --filter @qpjoy/electron-market-admin-ui build` first to enable the Quasar panel.');
} else {
  mkdirSync(hostDist, { recursive: true });
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(adminUiDist, target, { recursive: true });
  console.log(`[copy-admin-ui] copied admin-ui/dist → ${target}`);
}

// Also copy the bundled marketplace seed so MarketplaceClient has something
// to serve when the remote index is unreachable.
import { copyFileSync } from 'node:fs';
const seedSrc = resolve(here, '..', 'registry', 'index.json');
const seedDst = resolve(hostDist, 'seed-index.json');
if (existsSync(seedSrc)) {
  mkdirSync(hostDist, { recursive: true });
  copyFileSync(seedSrc, seedDst);
  console.log(`[copy-admin-ui] copied registry/index.json → ${seedDst}`);
} else {
  console.warn(`[copy-admin-ui] ${seedSrc} not found — marketplace will be empty when offline.`);
}
