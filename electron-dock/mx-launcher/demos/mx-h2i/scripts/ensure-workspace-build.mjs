#!/usr/bin/env node
/**
 * Rebuild the workspace packages MX-H2I loads from `dist/` when their sources are
 * newer than the compiled output.
 *
 * `pnpm dev` symlinks these packages straight into node_modules, so editing them
 * feels live -- but their package.json `main` points at `dist/`, so a TypeScript
 * edit has no effect until `tsc` runs. That gap is silent and costs real debugging
 * time: the app happily runs yesterday's compiled behaviour.
 *
 * Staleness is tracked with a stamp written only after a successful build, so a
 * warm start stays fast and a failed build can never look fresh.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

/** Packages whose runtime entry is compiled output rather than source. */
const PACKAGES = [
  '@qpjoy/electron-core-mihomo',
  '@qpjoy/electron-plugin-tunnel'
];

function packageDir(name) {
  // Resolve through the symlink pnpm created so this follows workspace mode.
  const linked = join(appRoot, 'node_modules', ...name.split('/'));
  return existsSync(linked) ? resolve(linked) : null;
}

function newestMtime(dir, seen = { at: 0 }) {
  if (!existsSync(dir)) return seen.at;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newestMtime(full, seen);
      continue;
    }
    const mtime = statSync(full).mtimeMs;
    if (mtime > seen.at) seen.at = mtime;
  }
  return seen.at;
}

/**
 * Record the source mtime that a SUCCESSFUL build covered.
 *
 * dist/ mtimes cannot be trusted for this: these packages do not set
 * `noEmitOnError`, so a failing `tsc` still writes output and bumps every
 * timestamp. Keying off dist/ would therefore mark a broken build as fresh and
 * silently launch the app against half-compiled code -- the exact failure this
 * script exists to prevent.
 */
function stampPath(dir) {
  return join(dir, 'dist', '.mx-workspace-build-stamp');
}

function stampedSrcMtime(dir) {
  const file = stampPath(dir);
  if (!existsSync(file)) return null;
  const value = Number.parseFloat(readFileSync(file, 'utf8').trim());
  return Number.isFinite(value) ? value : null;
}

function writeStamp(dir, srcAt) {
  try {
    writeFileSync(stampPath(dir), `${srcAt}\n`, 'utf8');
  } catch {
    // A missing stamp only costs one redundant rebuild next time.
  }
}

function staleReason(dir) {
  if (!existsSync(join(dir, 'dist'))) return 'dist/ is missing';
  const srcAt = newestMtime(join(dir, 'src'));
  if (!srcAt) return null;
  const stamped = stampedSrcMtime(dir);
  // No stamp yet: this is the first run against an existing dist/, so rebuild
  // once to establish a trustworthy baseline.
  if (stamped === null) return 'no successful-build stamp yet';
  return srcAt > stamped ? 'src/ changed since the last successful build' : null;
}

let rebuilt = 0;
let failed = 0;
for (const name of PACKAGES) {
  const dir = packageDir(name);
  if (!dir) {
    // npm mode (or not installed): the published tarball already ships dist/.
    console.log(`[workspace-build] ${name}: not a workspace link, skipping`);
    continue;
  }
  const reason = staleReason(dir);
  if (!reason) continue;
  console.log(`[workspace-build] ${name}: ${reason}, rebuilding`);
  // Snapshot before building so an edit made mid-build is not marked as covered.
  const srcAt = newestMtime(join(dir, 'src'));
  const result = spawnSync('pnpm', ['--filter', name, 'build'], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status === 0) {
    writeStamp(dir, srcAt);
    rebuilt += 1;
    continue;
  }
  failed += 1;
  console.error(`[workspace-build] ${name}: build failed (exit ${result.status ?? 'unknown'})`);
}

if (failed > 0) {
  console.error('[workspace-build] refusing to start: MX-H2I would load stale compiled output');
  process.exit(1);
}
console.log(rebuilt > 0
  ? `[workspace-build] rebuilt ${rebuilt} package(s)`
  : '[workspace-build] workspace packages are up to date');
