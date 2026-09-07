#!/usr/bin/env node
/**
 * Thin wrapper around the shared MX Launcher demo dependency switcher.
 *
 *   local  — build and link the local workspace packages
 *   npm    — require the exact package versions to exist in the registry and
 *            install this app as a standalone release consumer
 *   ensure — re-apply the current mode
 *   status — report the current mode without changing files
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const shared = resolve(here, '..', '..', '..', 'scripts', 'dev-mode.mjs');
const requested = process.argv[2] || 'status';

if (requested === 'status') {
  const sentinel = resolve(appRoot, '.dev-mode.json');
  if (existsSync(sentinel)) {
    const state = JSON.parse(readFileSync(sentinel, 'utf8'));
    console.log(`MX AutoTest dependency mode: ${state.mode === 'npm' ? 'published npm' : 'local workspace'}`);
  } else {
    const pkg = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'));
    const local = Object.values(pkg.dependencies || {}).some((value) => String(value).startsWith('workspace:'));
    console.log(`MX AutoTest dependency mode: ${local ? 'local workspace' : 'published npm'}`);
  }
  process.exit(0);
}

if (!['local', 'npm', 'ensure'].includes(requested)) {
  console.error('usage: node scripts/dev-mode.mjs <local|npm|ensure|status>');
  process.exit(2);
}

const result = spawnSync(process.execPath, [shared, requested, '--app', 'demos/mx-autotest'], {
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
