#!/usr/bin/env node
/**
 * Switch electron-test between two dependency layouts:
 *
 *   local  (default for `pnpm dev`)
 *     Pack the workspace packages into local tarballs, install from those.
 *     `pnpm pack` rewrites `workspace:^` refs to real versions, so the
 *     resulting tarballs are self-contained. We use `pnpm.overrides` to
 *     pin transitive @qpjoy/* refs to those same local tarballs so an
 *     edit to e.g. marketplace-db source propagates through electron-market.
 *
 *   npm    (`pnpm dev:npm`)
 *     Install the @qpjoy/* packages from the npm registry by semver. No
 *     overrides. Use this to validate the published packages.
 *
 * The mode is recorded in `.dev-mode` (gitignored). Re-running the same
 * mode is a no-op so `pnpm dev` stays fast after the first time.
 *
 * To pick up changes you've just made to host / SDK / tunnel source:
 *   pnpm dev:reset && pnpm dev    # forces a re-pack
 *
 * (Or `rm .dev-mode && pnpm dev`.)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = resolve(here, '..');
const REPO_ROOT = resolve(TEST_DIR, '..');
const PKG_PATH = resolve(TEST_DIR, 'package.json');
const MODE_PATH = resolve(TEST_DIR, '.dev-mode');
const PACKS_DIR = resolve(TEST_DIR, '.local-packs');

const desired = process.argv[2];
if (desired !== 'local' && desired !== 'npm') {
  console.error('usage: node scripts/dev-mode.mjs <local|npm>');
  process.exit(2);
}

/**
 * Workspace packages that get packed for local mode. The names map to the
 * subdirectory under each workspace.
 */
/**
 * Workspace packages that electron-test installs directly. Only **host** +
 * **bootstrap seed** packages live here; non-bootstrap plugins (NotYet, etc.)
 * are installed by the marketplace at runtime from npm, not from the test
 * app's `node_modules/`.
 */
const WORKSPACE_PACKS = [
  { name: '@qpjoy/electron-plugin-sdk',      dir: 'electron-market/packages/electron-plugin-sdk' },
  { name: '@qpjoy/marketplace-db',  dir: 'electron-market/packages/marketplace-db' },
  { name: '@qpjoy/electron-market', dir: 'electron-market/packages/electron-market' },
  { name: '@qpjoy/electron-plugin-tunnel', dir: 'electron-plugin/packages/electron-plugin-tunnel' }
];

/** Versions used by npm mode. Bump in lockstep with what's on the registry. */
const NPM_VERSIONS = {
  '@qpjoy/electron-market': '^0.2.1',
  '@qpjoy/electron-plugin-tunnel': '^0.1.4',
  '@qpjoy/electron-plugin-sdk':      '^0.1.0',
  '@qpjoy/marketplace-db':  '^0.1.0'
};

/** Direct deps electron-test declares (subset — marketplace-db only via override). */
const DIRECT_DEP_NAMES = [
  '@qpjoy/electron-market',
  '@qpjoy/electron-plugin-tunnel',
  '@qpjoy/electron-plugin-sdk'
];

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const sentinel = existsSync(MODE_PATH) ? readFileSync(MODE_PATH, 'utf8').trim() : null;

/* ────────────────────────────────────────────────────────────────────── */

function shell(cmd, cwd) {
  console.log(`  $ ${cmd}    (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function buildWorkspaces() {
  // pnpm -r build in each workspace (electron-plugin/ and electron-market/) so the
  // tarballs we pack include up-to-date dists.
  shell('pnpm install --prefer-offline --frozen-lockfile=false', resolve(REPO_ROOT, 'electron-plugin'));
  shell('pnpm --filter @qpjoy/electron-plugin-tunnel build', resolve(REPO_ROOT, 'electron-plugin'));
  shell('pnpm install --prefer-offline --frozen-lockfile=false', resolve(REPO_ROOT, 'electron-market'));
  shell('pnpm -r build', resolve(REPO_ROOT, 'electron-market'));
}

/**
 * Pack each workspace package and collect the resulting tarballs.
 * `pnpm pack` rewrites `workspace:^` deps to real `^x.y.z` versions.
 * Returns a map of package name → relative tarball path under TEST_DIR.
 */
function packAll() {
  rmSync(PACKS_DIR, { recursive: true, force: true });
  mkdirSync(PACKS_DIR, { recursive: true });

  const out = {};
  for (const entry of WORKSPACE_PACKS) {
    shell(`pnpm pack --pack-destination "${PACKS_DIR}"`, resolve(REPO_ROOT, entry.dir));
  }
  // Read whatever tarballs landed.
  for (const file of readdirSync(PACKS_DIR)) {
    if (!file.endsWith('.tgz')) continue;
    // file looks like `qpjoy-electron-market-0.2.0.tgz`. Match scope+name+version.
    const m = file.match(/^([a-z0-9-]+?)-([a-z0-9-]+?)-(\d.*)\.tgz$/);
    if (!m) continue;
    const scope = '@' + m[1];
    const name = `${scope}/${m[2]}`;
    out[name] = './' + './.local-packs/' + file;
    // basename relative to TEST_DIR:
    out[name] = `./.local-packs/${file}`;
  }
  return out;
}

function writePkg(next) {
  writeFileSync(PKG_PATH, JSON.stringify(next, null, 2) + '\n');
}

function reinstall() {
  console.log('  ── reinstalling electron-test node_modules');
  rmSync(resolve(TEST_DIR, 'node_modules'), { recursive: true, force: true });
  rmSync(resolve(TEST_DIR, 'pnpm-lock.yaml'), { force: true });
  shell('pnpm install --prefer-offline', TEST_DIR);
}

/* ────────────────────────────────────────────────────────────────────── */

if (desired === 'npm') {
  // Detect no-op
  const alreadyNpm =
    DIRECT_DEP_NAMES.every((n) => pkg.dependencies?.[n] === NPM_VERSIONS[n]) &&
    !pkg.pnpm?.overrides &&
    sentinel === 'npm';

  if (alreadyNpm) {
    console.log('✓ already in "npm" mode — skipping reinstall');
    process.exit(0);
  }

  console.log('→ switching electron-test to "npm" mode');

  // Strip every `@qpjoy/*` dependency before reinstating the canonical set —
  // this catches renames (e.g. legacy `@qpjoy/electron-plugin` entries) that
  // a simple "set to NPM_VERSIONS[n]" would leave behind.
  if (pkg.dependencies) {
    for (const k of Object.keys(pkg.dependencies)) {
      if (k.startsWith('@qpjoy/')) delete pkg.dependencies[k];
    }
  }
  for (const n of DIRECT_DEP_NAMES) {
    pkg.dependencies = pkg.dependencies ?? {};
    pkg.dependencies[n] = NPM_VERSIONS[n];
  }
  // Drop any `@qpjoy/*` overrides left over from local mode.
  if (pkg.pnpm?.overrides) {
    for (const k of Object.keys(pkg.pnpm.overrides)) {
      if (k.startsWith('@qpjoy/')) delete pkg.pnpm.overrides[k];
    }
    if (Object.keys(pkg.pnpm.overrides).length === 0) delete pkg.pnpm.overrides;
    if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
  }
  writePkg(pkg);
  writeFileSync(MODE_PATH, 'npm\n');
  // Also blow away any leftover tarballs so we don't ship them in `pnpm package`.
  rmSync(PACKS_DIR, { recursive: true, force: true });
  reinstall();
  console.log('✓ "npm" mode ready');
  process.exit(0);
}

/* ─── local mode ───────────────────────────────────────────────────────── */

// No-op fast path: if we previously finished a local-mode setup and the
// tarballs are still on disk and package.json already points at them, just
// hand off to electron-forge. Source edits won't be picked up here — that's
// what `pnpm dev:reset` is for.
function existingLocalSetupIsValid() {
  if (sentinel !== 'local') return false;
  if (!existsSync(PACKS_DIR)) return false;
  const tarballs = readdirSync(PACKS_DIR).filter((f) => f.endsWith('.tgz'));
  // Need at least one tgz per workspace package.
  for (const entry of WORKSPACE_PACKS) {
    const scopeName = entry.name.replace(/^@/, '').replace('/', '-');
    if (!tarballs.some((f) => f.startsWith(scopeName + '-'))) return false;
  }
  // package.json must already point at file: refs for all direct deps,
  // and pnpm.overrides must be present.
  for (const n of DIRECT_DEP_NAMES) {
    const v = pkg.dependencies?.[n];
    if (typeof v !== 'string' || !v.startsWith('file:./.local-packs/')) return false;
  }
  if (!pkg.pnpm?.overrides) return false;
  for (const w of WORKSPACE_PACKS) {
    const v = pkg.pnpm.overrides[w.name];
    if (typeof v !== 'string' || !v.startsWith('file:./.local-packs/')) return false;
  }
  // node_modules must actually exist (otherwise electron-forge will fail).
  if (!existsSync(resolve(TEST_DIR, 'node_modules', '@qpjoy', 'electron-market'))) return false;
  return true;
}

if (existingLocalSetupIsValid()) {
  console.log('✓ already in "local" mode — skipping rebuild');
  console.log('  (run `pnpm dev:reset && pnpm dev` to re-pack after source edits)');
  process.exit(0);
}

console.log('→ switching electron-test to "local" mode');
console.log('  ── building workspace packages (this takes ~30–60s on a cold run)');
buildWorkspaces();

console.log('  ── packing workspace packages → .local-packs/');
const packMap = packAll();
for (const [name, p] of Object.entries(packMap)) {
  console.log(`     ${name.padEnd(28)} ${p}`);
}

// Verify we got all four.
for (const entry of WORKSPACE_PACKS) {
  if (!packMap[entry.name]) {
    console.error(`! pack failed for ${entry.name} (no matching tgz in .local-packs/)`);
    process.exit(1);
  }
}

// First, drop any stale `@qpjoy/*` entries that no longer belong (e.g. when
// a workspace package was renamed — `@qpjoy/electron-plugin` → `electron-market`).
// Without this the script keeps appending and pnpm install eventually fails
// because the orphan entry points at a tarball we never produced.
const ALL_QPJOY_DEPS = new Set([
  ...DIRECT_DEP_NAMES,
  ...WORKSPACE_PACKS.map((w) => w.name)
]);
if (pkg.dependencies) {
  for (const k of Object.keys(pkg.dependencies)) {
    if (k.startsWith('@qpjoy/') && !ALL_QPJOY_DEPS.has(k)) {
      delete pkg.dependencies[k];
    }
  }
}
if (pkg.pnpm?.overrides) {
  for (const k of Object.keys(pkg.pnpm.overrides)) {
    if (k.startsWith('@qpjoy/') && !ALL_QPJOY_DEPS.has(k)) {
      delete pkg.pnpm.overrides[k];
    }
  }
}

// Direct deps → tarballs.
for (const n of DIRECT_DEP_NAMES) {
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[n] = `file:${packMap[n]}`;
}
// Override transitive @qpjoy/marketplace-db (a dep of electron-market) to
// also resolve to the local tarball, so iterating on marketplace-db source
// is reflected without needing another publish.
pkg.pnpm = pkg.pnpm ?? {};
pkg.pnpm.overrides = pkg.pnpm.overrides ?? {};
for (const n of WORKSPACE_PACKS.map((w) => w.name)) {
  pkg.pnpm.overrides[n] = `file:${packMap[n]}`;
}

writePkg(pkg);
writeFileSync(MODE_PATH, 'local\n');
reinstall();
console.log('✓ "local" mode ready');
console.log('  Tip: `pnpm dev:reset` (or remove .dev-mode) to repack on next `pnpm dev`.');
console.log('  Tip: run `pnpm dev:npm` (or `pnpm dev:reset`) before committing so');
console.log('       package.json goes back to clean npm semver refs.');
