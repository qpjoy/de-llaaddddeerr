#!/usr/bin/env node
/**
 * Switch electron-demo/hdo between local development packages and published
 * npm packages.
 *
 * local: used by `pnpm dev`; packs the current workspace HDO/market packages
 *        into .local-packs and installs from those tarballs.
 * npm:   used by package/make; installs published packages from npm so the
 *        demo behaves like a normal marketplace consumer app.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const PKG_PATH = resolve(APP_DIR, 'package.json');
const MODE_PATH = resolve(APP_DIR, '.dev-mode');
const PACKS_DIR = resolve(APP_DIR, '.local-packs');

const desired = process.argv[2];
if (desired !== 'local' && desired !== 'npm') {
  console.error('usage: node scripts/dev-mode.mjs <local|npm>');
  process.exit(2);
}

const WORKSPACE_PACKS = [
  { name: '@qpjoy/electron-plugin-sdk', dir: 'electron-market/packages/electron-plugin-sdk' },
  { name: '@qpjoy/marketplace-db', dir: 'electron-market/packages/marketplace-db' },
  { name: '@qpjoy/electron-market', dir: 'electron-market/packages/electron-market' },
  { name: '@qpjoy/electron-core-wireguard-engine-darwin-arm64', dir: 'electron-plugin/packages/wireguard-engines/darwin-arm64' },
  { name: '@qpjoy/electron-core-wireguard-engine-darwin-x64', dir: 'electron-plugin/packages/wireguard-engines/darwin-x64' },
  { name: '@qpjoy/electron-core-wireguard-engine-linux-arm64', dir: 'electron-plugin/packages/wireguard-engines/linux-arm64' },
  { name: '@qpjoy/electron-core-wireguard-engine-linux-x64', dir: 'electron-plugin/packages/wireguard-engines/linux-x64' },
  { name: '@qpjoy/electron-core-wireguard-engine-win32-x64', dir: 'electron-plugin/packages/wireguard-engines/win32-x64' },
  { name: '@qpjoy/electron-core-wireguard', dir: 'electron-plugin/packages/electron-core-wireguard' },
  { name: '@qpjoy/electron-plugin-hdo', dir: 'electron-plugin/packages/electron-plugin-hdo' }
];

const LOCAL_DIRECT_DEP_NAMES = [
  '@qpjoy/electron-market',
  '@qpjoy/electron-plugin-sdk',
  '@qpjoy/electron-plugin-hdo'
];

const FALLBACK_NPM_DEPENDENCIES = {
  '@qpjoy/electron-market': '^0.3.24',
  '@qpjoy/electron-plugin-hdo': '^0.1.23',
  '@qpjoy/electron-plugin-sdk': '^0.1.3',
  '@qpjoy/electron-plugin-tunnel': '^0.1.16',
  '@qpjoy/marketplace-db': '^0.1.1',
  '@qpjoy/electron-core-wireguard': '^0.1.15',
  '@qpjoy/electron-core-wireguard-engine-darwin-arm64': '^0.1.2',
  '@qpjoy/electron-core-wireguard-engine-darwin-x64': '^0.1.2',
  '@qpjoy/electron-core-wireguard-engine-linux-arm64': '^0.1.2',
  '@qpjoy/electron-core-wireguard-engine-linux-x64': '^0.1.2',
  '@qpjoy/electron-core-wireguard-engine-win32-x64': '^0.1.2'
};

const NPM_DIRECT_DEP_NAMES = [
  '@qpjoy/electron-market',
  '@qpjoy/electron-plugin-sdk',
  '@qpjoy/electron-plugin-hdo',
  '@qpjoy/electron-plugin-tunnel'
];

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const sentinel = existsSync(MODE_PATH) ? readFileSync(MODE_PATH, 'utf8').trim() : null;
const desiredNpmDeps = Object.fromEntries(
  Object.entries(FALLBACK_NPM_DEPENDENCIES).map(([name, fallback]) => [name, npmDependencySpec(name, fallback)])
);

function isFileSpec(value) {
  return typeof value === 'string' && /^(file:|\.\.?\/|\/)/.test(value);
}

function isNpmSpec(value) {
  return typeof value === 'string' && value.trim() !== '' && !isFileSpec(value);
}

function npmDependencySpec(name, fallback) {
  const declared = pkg.dependencies?.[name];
  return isNpmSpec(declared) ? declared : fallback;
}

function expectedVersionFromSpec(spec) {
  const match = String(spec || '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function installedPackageVersion(name) {
  try {
    const pkgJson = resolve(APP_DIR, 'node_modules', ...name.split('/'), 'package.json');
    return JSON.parse(readFileSync(pkgJson, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function npmDepsInstalled() {
  for (const name of NPM_DIRECT_DEP_NAMES) {
    const wanted = expectedVersionFromSpec(desiredNpmDeps[name]);
    const actual = installedPackageVersion(name);
    if (!actual) return false;
    if (wanted && actual !== wanted) return false;
  }
  return true;
}

function shell(cmd, cwd) {
  console.log(`  $ ${cmd}    (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function writePkg(next) {
  writeFileSync(PKG_PATH, JSON.stringify(next, null, 2) + '\n');
}

function reinstall(label) {
  console.log(`  -- reinstalling ${label}`);
  rmSync(resolve(APP_DIR, 'node_modules'), { recursive: true, force: true });
  rmSync(resolve(APP_DIR, 'pnpm-lock.yaml'), { force: true });
  shell('pnpm install --prefer-offline --frozen-lockfile=false', APP_DIR);
}

function buildWorkspaces() {
  shell('pnpm install --prefer-offline --frozen-lockfile=false', resolve(REPO_ROOT, 'electron-plugin'));
  shell('pnpm --filter @qpjoy/electron-core-wireguard build', resolve(REPO_ROOT, 'electron-plugin'));
  shell('pnpm --filter @qpjoy/electron-plugin-hdo build', resolve(REPO_ROOT, 'electron-plugin'));
  shell('pnpm install --prefer-offline --frozen-lockfile=false', resolve(REPO_ROOT, 'electron-market'));
  shell('pnpm -r build', resolve(REPO_ROOT, 'electron-market'));
}

function packAll() {
  rmSync(PACKS_DIR, { recursive: true, force: true });
  mkdirSync(PACKS_DIR, { recursive: true });

  for (const entry of WORKSPACE_PACKS) {
    shell(`pnpm pack --pack-destination "${PACKS_DIR}"`, resolve(REPO_ROOT, entry.dir));
  }

  const out = {};
  for (const file of readdirSync(PACKS_DIR)) {
    if (!file.endsWith('.tgz')) continue;
    const match = file.match(/^([a-z0-9-]+?)-([a-z0-9-]+?)-(\d.*)\.tgz$/);
    if (!match) continue;
    out[`@${match[1]}/${match[2]}`] = `./.local-packs/${file}`;
  }
  return out;
}

function removeQpjoyDepsExcept(allowed) {
  if (pkg.dependencies) {
    for (const key of Object.keys(pkg.dependencies)) {
      if (key.startsWith('@qpjoy/') && !allowed.has(key)) delete pkg.dependencies[key];
    }
  }
  if (pkg.pnpm?.overrides) {
    for (const key of Object.keys(pkg.pnpm.overrides)) {
      if (key.startsWith('@qpjoy/') && !allowed.has(key)) delete pkg.pnpm.overrides[key];
    }
    if (Object.keys(pkg.pnpm.overrides).length === 0) delete pkg.pnpm.overrides;
    if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
  }
}

function newestMtimeMs(root) {
  if (!existsSync(root)) return 0;
  const stat = statSync(root);
  if (stat.isFile()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of readdirSync(root)) {
    if (['node_modules', '.local-packs', '.turbo'].includes(name)) continue;
    newest = Math.max(newest, newestMtimeMs(resolve(root, name)));
  }
  return newest;
}

function localPacksAreFresh(tarballs) {
  const tarballTimes = new Map(tarballs.map((file) => [file, statSync(resolve(PACKS_DIR, file)).mtimeMs]));
  for (const entry of WORKSPACE_PACKS) {
    const prefix = entry.name.replace(/^@/, '').replace('/', '-');
    const tarball = tarballs.find((file) => file.startsWith(`${prefix}-`));
    if (!tarball) return false;
    if (newestMtimeMs(resolve(REPO_ROOT, entry.dir)) > (tarballTimes.get(tarball) ?? 0)) return false;
  }
  return true;
}

function existingLocalSetupIsValid() {
  if (sentinel !== 'local') return false;
  if (!existsSync(PACKS_DIR)) return false;
  const tarballs = readdirSync(PACKS_DIR).filter((file) => file.endsWith('.tgz'));
  for (const entry of WORKSPACE_PACKS) {
    const prefix = entry.name.replace(/^@/, '').replace('/', '-');
    if (!tarballs.some((file) => file.startsWith(`${prefix}-`))) return false;
  }
  for (const name of LOCAL_DIRECT_DEP_NAMES) {
    if (!isNpmSpec(pkg.dependencies?.[name])) return false;
  }
  if (pkg.dependencies?.['@qpjoy/electron-plugin-tunnel'] !== desiredNpmDeps['@qpjoy/electron-plugin-tunnel']) {
    return false;
  }
  for (const entry of WORKSPACE_PACKS) {
    const value = pkg.pnpm?.overrides?.[entry.name];
    if (typeof value !== 'string' || !value.startsWith('file:./.local-packs/')) return false;
  }
  if (!localPacksAreFresh(tarballs)) return false;
  return existsSync(resolve(APP_DIR, 'node_modules', '@qpjoy', 'electron-market'));
}

if (desired === 'npm') {
  const npmPackageShape =
    NPM_DIRECT_DEP_NAMES.every((name) => pkg.dependencies?.[name] === desiredNpmDeps[name]) &&
    !pkg.pnpm?.overrides;
  const alreadyNpm =
    npmPackageShape && npmDepsInstalled();

  if (alreadyNpm) {
    if (sentinel !== 'npm') writeFileSync(MODE_PATH, 'npm\n');
    console.log('OK already in npm mode');
    process.exit(0);
  }

  console.log('-> switching electron-demo/hdo to npm mode');
  removeQpjoyDepsExcept(new Set(NPM_DIRECT_DEP_NAMES));
  if (pkg.pnpm?.overrides) {
    for (const key of Object.keys(pkg.pnpm.overrides)) {
      if (key.startsWith('@qpjoy/')) delete pkg.pnpm.overrides[key];
    }
    if (Object.keys(pkg.pnpm.overrides).length === 0) delete pkg.pnpm.overrides;
    if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
  }
  pkg.dependencies = pkg.dependencies ?? {};
  for (const name of NPM_DIRECT_DEP_NAMES) {
    pkg.dependencies[name] = desiredNpmDeps[name];
  }
  writePkg(pkg);
  writeFileSync(MODE_PATH, 'npm\n');
  rmSync(PACKS_DIR, { recursive: true, force: true });
  reinstall('npm packages');
  console.log('OK npm mode ready');
  process.exit(0);
}

if (existingLocalSetupIsValid()) {
  console.log('OK already in local mode');
  process.exit(0);
}

console.log('-> switching electron-demo/hdo to local mode');
console.log('   -- building workspace packages');
buildWorkspaces();

console.log('   -- packing workspace packages');
const packMap = packAll();
for (const entry of WORKSPACE_PACKS) {
  if (!packMap[entry.name]) {
    console.error(`! pack failed for ${entry.name}`);
    process.exit(1);
  }
}

const allowed = new Set([
  ...LOCAL_DIRECT_DEP_NAMES,
  '@qpjoy/electron-plugin-tunnel',
  ...WORKSPACE_PACKS.map((entry) => entry.name)
]);
removeQpjoyDepsExcept(allowed);

pkg.dependencies = pkg.dependencies ?? {};
for (const name of LOCAL_DIRECT_DEP_NAMES) {
  pkg.dependencies[name] = desiredNpmDeps[name];
}
pkg.dependencies['@qpjoy/electron-plugin-tunnel'] = desiredNpmDeps['@qpjoy/electron-plugin-tunnel'];

pkg.pnpm = pkg.pnpm ?? {};
pkg.pnpm.overrides = pkg.pnpm.overrides ?? {};
for (const entry of WORKSPACE_PACKS) {
  pkg.pnpm.overrides[entry.name] = `file:${packMap[entry.name]}`;
}

writePkg(pkg);
writeFileSync(MODE_PATH, 'local\n');
reinstall('local tarballs');
console.log('OK local mode ready');
console.log('   `pnpm make:*` switches back to npm mode automatically.');
