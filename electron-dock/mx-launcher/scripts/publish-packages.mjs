#!/usr/bin/env node
/**
 * Publish MX Launcher npm packages in topological order (docs/19 §1.2-1.3).
 *
 * Default is a dry run: builds every package, shows what would be published
 * and how workspace: deps get rewritten, and runs `pnpm publish --dry-run`.
 * Pass --publish to actually publish to the registry.
 *
 * Usage:
 *   node scripts/publish-packages.mjs             # dry run (safe)
 *   node scripts/publish-packages.mjs --publish   # real publish
 *   node scripts/publish-packages.mjs --publish --otp 123456
 *   node scripts/publish-packages.mjs --include-apps   # also L4 app packages
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, '..');

const args = process.argv.slice(2);
const doPublish = args.includes('--publish');
const includeApps = args.includes('--include-apps');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex >= 0 ? args[otpIndex + 1] : null;

// Topological order: launcher-core first, product facade last.
// L0/L1 (electron-plugin engines, wireguard, mihomo, tunnel) are released from
// the electron-plugin workspace and are not managed by this script.
const PACKAGES = [
  { name: '@qpjoy/mx-launcher-core', dir: 'packages/launcher-core' },
  { name: '@qpjoy/mx-launcher-embed-sdk', dir: 'packages/launcher-embed-sdk' },
  { name: '@qpjoy/mx-launcher-standalone', dir: 'packages/launcher-standalone' },
  { name: '@qpjoy/electron-launcher', dir: 'packages/electron-launcher' }
];

const APP_PACKAGES = [
  { name: '@qpjoy/electron-launcher-app-h2o', dir: 'demos/mx-app-h2o' }
];

const plan = includeApps ? [...PACKAGES, ...APP_PACKAGES] : PACKAGES;

// External workspace deps (released from the electron-plugin workspace) whose
// dist must exist before the launcher packages can typecheck.
const PREBUILD = ['@qpjoy/electron-core-wireguard'];

function shell(cmd, cwd) {
  console.log(`  $ ${cmd}    (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function readPkg(dir) {
  return JSON.parse(readFileSync(resolve(workspaceRoot, dir, 'package.json'), 'utf8'));
}

function publishedVersion(name) {
  try {
    return execSync(`npm view ${name} version`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || null;
  } catch {
    return null; // 404: never published
  }
}

const workspaceVersions = new Map(plan.map((entry) => [entry.name, readPkg(entry.dir).version]));

function rewrittenSpec(name, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('workspace:')) return spec;
  const version = workspaceVersions.get(name);
  const protocol = spec.slice('workspace:'.length);
  if (!version) return `${protocol === '*' ? '' : protocol}<workspace version>`;
  if (protocol === '*') return version; // exact pin
  if (protocol === '^' || protocol === '~') return `${protocol}${version}`;
  return protocol;
}

console.log(`mode: ${doPublish ? 'PUBLISH' : 'dry-run'}\n`);

for (const name of PREBUILD) {
  shell(`pnpm --filter ${name} build`, workspaceRoot);
}
console.log('');

let failed = false;
for (const entry of plan) {
  const pkg = readPkg(entry.dir);
  const remote = publishedVersion(pkg.name);
  const status = remote === null ? 'never published' : `registry has ${remote}`;
  console.log(`== ${pkg.name}@${pkg.version} (${status})`);

  if (pkg.private) {
    console.log('   !! package is private, skipping');
    continue;
  }
  if (remote === pkg.version) {
    console.log('   -- this exact version is already on the registry, skipping');
    continue;
  }
  for (const [depName, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (String(spec).startsWith('workspace:')) {
      const target = rewrittenSpec(depName, spec);
      console.log(`   dep ${depName}: ${spec} -> ${target}`);
      if (spec === 'workspace:*') {
        console.log('   !! workspace:* pins the exact version on publish; docs/19 requires workspace:^');
        failed = true;
      }
      if (!workspaceVersions.has(depName)) {
        // dep released from another workspace (e.g. electron-plugin); it must
        // already exist on the registry for consumers to install.
        const depRemote = publishedVersion(depName);
        if (depRemote === null) {
          console.log(`   !! external workspace dep ${depName} is not on the registry`);
          failed = true;
        } else {
          console.log(`      (external workspace dep, registry has ${depRemote})`);
        }
      }
    }
  }

  shell(`pnpm --filter ${pkg.name} build`, workspaceRoot);
  const publishCmd = [
    'pnpm publish',
    '--access public',
    '--no-git-checks',
    doPublish ? '' : '--dry-run',
    doPublish && otp ? `--otp ${otp}` : ''
  ].filter(Boolean).join(' ');
  if (failed && doPublish) {
    console.error('   !! aborting real publish because of the problems above');
    process.exit(1);
  }
  shell(publishCmd, resolve(workspaceRoot, entry.dir));
  console.log('');
}

if (failed) {
  console.error('dry run found problems (see !! lines above)');
  process.exit(1);
}
console.log(doPublish
  ? 'all packages published; verify with: npm view @qpjoy/electron-launcher version'
  : 'dry run complete; run with --publish to release');
