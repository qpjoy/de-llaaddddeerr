#!/usr/bin/env node
/**
 * Thin wrapper around the shared MX Launcher dev-mode switcher.
 *
 *   node scripts/dev-mode.mjs local    # workspace packages (development)
 *   node scripts/dev-mode.mjs npm      # published npm packages (release builds)
 *   node scripts/dev-mode.mjs ensure   # re-apply the current mode
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, '..', '..', '..', 'scripts', 'dev-mode.mjs');
const mode = process.argv[2] || 'local';
const result = spawnSync(process.execPath, [shared, mode, '--app', 'demos/luopan'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
