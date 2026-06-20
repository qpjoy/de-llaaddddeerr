#!/usr/bin/env node
/**
 * Prepare MX-H2I for local development and packaging.
 *
 * V1 HDO switches between local tarballs and published npm packages. MX-H2I is
 * still inside the mx-launcher workspace, so the local mode only needs to build
 * the workspace packages that Electron imports at runtime.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const mxLauncherRoot = resolve(appDir, '..', '..');
const repoRoot = resolve(mxLauncherRoot, '..', '..');

const mode = process.argv[2] || 'local';
if (mode !== 'local') {
  console.error('usage: node scripts/dev-mode.mjs local');
  process.exit(2);
}

const requiredOutputs = [
  resolve(repoRoot, 'electron-plugin/packages/electron-core-wireguard/dist/index.js'),
  resolve(mxLauncherRoot, 'packages/launcher-core/dist/index.js'),
  resolve(mxLauncherRoot, 'packages/launcher-embed-sdk/dist/index.js'),
  resolve(mxLauncherRoot, 'packages/launcher-standalone/dist/index.js'),
  resolve(mxLauncherRoot, 'packages/electron-launcher/dist/index.js'),
  resolve(mxLauncherRoot, 'packages/electron-launcher/dist/wireguard.js')
];

function shell(cmd, cwd) {
  console.log(`  $ ${cmd}    (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function missingOutputs() {
  return requiredOutputs.filter((file) => !existsSync(file));
}

console.log('-> preparing MX-H2I local launcher packages');

if (!existsSync(resolve(mxLauncherRoot, 'node_modules')) || !existsSync(resolve(appDir, 'node_modules'))) {
  shell('pnpm install --prefer-offline --frozen-lockfile=false', mxLauncherRoot);
}

shell('pnpm --filter @qpjoy/electron-core-wireguard build', mxLauncherRoot);
shell('pnpm --filter @qpjoy/mx-launcher-core build', mxLauncherRoot);
shell('pnpm --filter @qpjoy/mx-launcher-embed-sdk build', mxLauncherRoot);
shell('pnpm --filter @qpjoy/mx-launcher-standalone build', mxLauncherRoot);
shell('pnpm --filter @qpjoy/electron-launcher build', mxLauncherRoot);

const missing = missingOutputs();
if (missing.length > 0) {
  console.error('! launcher build did not produce required runtime files:');
  for (const file of missing) console.error(`  - ${file}`);
  process.exit(1);
}

console.log('OK MX-H2I local launcher packages ready');
