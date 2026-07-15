#!/usr/bin/env node
/**
 * Shared dev-mode switcher for MX Launcher demo apps (docs/19 §1.4).
 *
 * local:  workspace mode. Restores workspace: deps if the app was in npm mode,
 *         reinstalls at the workspace root, builds the launcher packages the
 *         app imports at runtime.
 * npm:    release mode. Rewrites workspace: deps to the published npm versions
 *         and installs the app standalone (--ignore-workspace), so the app
 *         builds exactly like an external consumer. This is the mandatory mode
 *         for packages that get distributed or registered in Release Center.
 * ensure: re-applies whatever mode the app is currently in (default local).
 *         Used by package/make scripts so they do not silently flip the mode.
 *
 * Usage (normally through each demo's scripts/dev-mode.mjs wrapper):
 *   node scripts/dev-mode.mjs <local|npm|ensure> --app demos/mx-h2i
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mxLauncherRoot = resolve(here, '..');
const repoRoot = resolve(mxLauncherRoot, '..', '..');

const APPS = {
  'demos/mx-h2i': {
    localFilters: [
      '@qpjoy/electron-core-mihomo',
      '@qpjoy/electron-plugin-tunnel',
      '@qpjoy/electron-core-wireguard',
      '@qpjoy/mx-launcher-core',
      '@qpjoy/mx-launcher-embed-sdk',
      '@qpjoy/mx-launcher-standalone',
      '@qpjoy/electron-launcher'
    ],
    requiredOutputs: [
      'electron-plugin/packages/electron-core-mihomo/dist/index.js',
      'electron-plugin/packages/electron-plugin-tunnel/dist/mihomo/MihomoManager.js',
      'electron-plugin/packages/electron-core-wireguard/dist/index.js',
      'electron-dock/mx-launcher/packages/launcher-core/dist/index.js',
      'electron-dock/mx-launcher/packages/launcher-embed-sdk/dist/index.js',
      'electron-dock/mx-launcher/packages/launcher-standalone/dist/index.js',
      'electron-dock/mx-launcher/packages/electron-launcher/dist/index.js',
      'electron-dock/mx-launcher/packages/electron-launcher/dist/standalone-data-plane.js',
      'electron-dock/mx-launcher/packages/electron-launcher/dist/wireguard.js'
    ]
  },
  'demos/luopan': {
    localFilters: [
      '@qpjoy/electron-core-mihomo',
      '@qpjoy/electron-plugin-tunnel',
      '@qpjoy/electron-core-wireguard',
      '@qpjoy/mx-launcher-core',
      '@qpjoy/mx-launcher-embed-sdk',
      '@qpjoy/mx-launcher-standalone',
      '@qpjoy/electron-launcher',
      '@qpjoy/ui-design-neon-void'
    ],
    requiredOutputs: [
      'electron-plugin/packages/electron-core-mihomo/dist/index.js',
      'electron-plugin/packages/electron-plugin-tunnel/dist/index.js',
      'electron-dock/mx-launcher/packages/electron-launcher/dist/index.js',
      'electron-dock/mx-launcher/ui-design/dist/index.js'
    ]
  }
};

// In npm mode the app gets its own pnpm-workspace.yaml (settings only, no
// `packages`), which makes it a standalone install root and carries the
// build-script approvals — pnpm 10+/11 no longer reads package.json `pnpm`.
const ONLY_BUILT_DEPENDENCIES = [
  '@parcel/watcher',
  'better-sqlite3',
  'electron',
  'electron-winstaller',
  'esbuild'
];

// Where workspace packages live, for resolving the npm version to pin.
const WORKSPACE_PACKAGE_DIRS = [
  'electron-dock/mx-launcher/packages/launcher-core',
  'electron-dock/mx-launcher/packages/launcher-embed-sdk',
  'electron-dock/mx-launcher/packages/launcher-standalone',
  'electron-dock/mx-launcher/packages/electron-launcher',
  'electron-dock/mx-launcher/ui-design',
  'electron-dock/mx-launcher/demos/mx-app-h2o',
  'electron-plugin/packages/electron-core-mihomo',
  'electron-plugin/packages/electron-core-wireguard',
  'electron-plugin/packages/electron-plugin-tunnel',
  ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].flatMap((platform) => [
    `electron-plugin/packages/tunnel-engines/${platform}`,
    `electron-plugin/packages/wireguard-engines/${platform}`
  ])
];

const args = process.argv.slice(2);
const mode = args.find((arg) => !arg.startsWith('-') && !isAppRef(arg));
const appIndex = args.indexOf('--app');
const appRef = appIndex >= 0 ? args[appIndex + 1] : args.find(isAppRef);

function isAppRef(value) {
  return typeof value === 'string' && value.startsWith('demos/');
}

if (!['local', 'npm', 'ensure'].includes(mode) || !APPS[appRef]) {
  console.error('usage: node scripts/dev-mode.mjs <local|npm|ensure> --app <demos/mx-h2i|demos/luopan>');
  process.exit(2);
}

const app = APPS[appRef];
const appDir = resolve(mxLauncherRoot, appRef);
const pkgPath = resolve(appDir, 'package.json');
const sentinelPath = resolve(appDir, '.dev-mode.json');

function shell(cmd, cwd) {
  console.log(`  $ ${cmd}    (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writePkg(pkg) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function readSentinel() {
  return existsSync(sentinelPath) ? readJson(sentinelPath) : { mode: 'local' };
}

function workspaceVersions() {
  const map = new Map();
  for (const dir of WORKSPACE_PACKAGE_DIRS) {
    const path = resolve(repoRoot, dir, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = readJson(path);
    map.set(pkg.name, pkg.version);
  }
  return map;
}

function publishedExactVersion(name, version) {
  try {
    const out = execSync(`npm view ${name}@${version} version`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out === version;
  } catch {
    return false;
  }
}

function switchToNpm() {
  const pkg = readJson(pkgPath);
  const versions = workspaceVersions();
  // Re-running npm mode must not wipe the original workspace: specs.
  const prior = readSentinel();
  const restore = prior.mode === 'npm' && prior.restore
    ? prior.restore
    : { dependencies: {}, optionalDependencies: {} };
  const missing = [];

  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (!String(spec).startsWith('workspace:')) continue;
      const version = versions.get(name);
      if (!version) {
        missing.push(`${name} (不在已知 workspace 包目录里)`);
        continue;
      }
      if (!publishedExactVersion(name, version)) {
        missing.push(`${name}@${version} (registry 上没有这个版本，先用 scripts/manage.sh prepare-mx-h2i 发布)`);
        continue;
      }
      restore[section][name] = spec;
      pkg[section][name] = `^${version}`;
      console.log(`  dep ${name}: ${spec} -> ^${version}`);
    }
  }
  if (missing.length > 0) {
    console.error('! npm 模式需要以下包先发布到 registry:');
    for (const item of missing) console.error(`  - ${item}`);
    process.exit(1);
  }

  writeFileSync(sentinelPath, JSON.stringify({ mode: 'npm', restore }, null, 2) + '\n');
  writePkg(pkg);
  // allowBuilds is the pnpm 11 approval setting; onlyBuiltDependencies keeps
  // pnpm 10 (the packageManager pin) working with the same file.
  writeFileSync(
    resolve(appDir, 'pnpm-workspace.yaml'),
    ['# generated by dev-mode npm: standalone install root + build approvals',
      'allowBuilds:',
      ...ONLY_BUILT_DEPENDENCIES.map((name) => `  "${name}": true`),
      'onlyBuiltDependencies:',
      ...ONLY_BUILT_DEPENDENCIES.map((name) => `  - "${name}"`),
      ''].join('\n')
  );

  rmSync(resolve(appDir, 'node_modules'), { recursive: true, force: true });
  shell('pnpm install --prefer-offline', appDir);
  console.log(`OK ${appRef} 现在使用已发布 npm 包（正式打包模式）。切回开发: dev-mode local`);
}

function switchToLocal() {
  const sentinel = readSentinel();
  if (sentinel.mode === 'npm') {
    const pkg = readJson(pkgPath);
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(sentinel.restore?.[section] ?? {})) {
        if (pkg[section]?.[name]) pkg[section][name] = spec;
      }
    }
    if (pkg.pnpm) {
      delete pkg.pnpm.onlyBuiltDependencies;
      if (Object.keys(pkg.pnpm).length === 0) delete pkg.pnpm;
    }
    writePkg(pkg);
    rmSync(resolve(appDir, 'node_modules'), { recursive: true, force: true });
    rmSync(resolve(appDir, 'pnpm-lock.yaml'), { force: true });
    rmSync(resolve(appDir, 'pnpm-workspace.yaml'), { force: true });
    writeFileSync(sentinelPath, JSON.stringify({ mode: 'local' }, null, 2) + '\n');
    shell('pnpm install --prefer-offline --frozen-lockfile=false', mxLauncherRoot);
  } else if (!existsSync(resolve(mxLauncherRoot, 'node_modules')) || !existsSync(resolve(appDir, 'node_modules'))) {
    shell('pnpm install --prefer-offline --frozen-lockfile=false', mxLauncherRoot);
  }

  for (const filter of app.localFilters) {
    shell(`pnpm --filter ${filter} build`, mxLauncherRoot);
  }

  const missing = app.requiredOutputs.filter((file) => !existsSync(resolve(repoRoot, file)));
  if (missing.length > 0) {
    console.error('! launcher build did not produce required runtime files:');
    for (const file of missing) console.error(`  - ${file}`);
    process.exit(1);
  }
  console.log(`OK ${appRef} local launcher packages ready`);
}

const effectiveMode = mode === 'ensure' ? readSentinel().mode : mode;
console.log(`-> dev-mode ${effectiveMode} for ${appRef}${mode === 'ensure' ? ' (ensure)' : ''}`);
if (effectiveMode === 'npm') {
  if (mode === 'ensure' && existsSync(resolve(appDir, 'node_modules'))) {
    console.log(`OK ${appRef} 保持 npm 模式（已安装）。`);
  } else {
    switchToNpm();
  }
} else {
  switchToLocal();
}
