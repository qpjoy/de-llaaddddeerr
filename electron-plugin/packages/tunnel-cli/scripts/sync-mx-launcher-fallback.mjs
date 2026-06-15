#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../../..');
const mxLauncherRoot = resolve(repoRoot, 'electron-dock/mx-launcher');
const refreshScript = resolve(mxLauncherRoot, 'server/scripts/site-slot-refresh-tunnel-cli.mjs');
const args = process.argv.slice(2);
const tarball = optionValue('--from-tarball') || optionValue('--tarball') || latestPreviewTarball();

if (!tarball) {
  die('Missing @qpjoy/tunnel-cli tarball. Pass --from-tarball FILE or run pnpm pack first.');
}
if (!existsSync(tarball)) {
  die(`Tarball not found: ${tarball}`);
}
if (!existsSync(refreshScript)) {
  die(`MX Launcher refresh script not found: ${refreshScript}`);
}

const passThrough = [];
for (const name of ['--target-dir', '--temp-dir']) {
  const value = optionValue(name);
  if (value) passThrough.push(name, value);
}

execFileSync(process.execPath, [
  refreshScript,
  '--from-tarball',
  tarball,
  ...passThrough
], {
  cwd: mxLauncherRoot,
  stdio: 'inherit'
});

function optionValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) die(`Missing value for ${name}`);
  return resolve(value);
}

function latestPreviewTarball() {
  const previewDir = '/tmp/qpjoy-publish-preview';
  if (!existsSync(previewDir)) return null;
  const tarballs = readdirSync(previewDir)
    .filter((entry) => entry.endsWith('.tgz') && entry.includes('tunnel-cli'))
    .map((entry) => {
      const path = join(previewDir, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return tarballs[0]?.path ?? null;
}

function die(message) {
  console.error(message);
  process.exit(1);
}
