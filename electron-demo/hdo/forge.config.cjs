/**
 * Forge config for `electron-demo/hdo` — local Marketplace consumer used to
 * validate current HDO changes and packaged flow on macOS + Windows.
 *
 * Why `asar: false`: same reasoning as `electron-test`'s config — the
 * marketplace seed pipeline calls `fs.symlink(<tunnel-dir>, ...)` and
 * symlink targets must be OS-readable, not inside an asar mount. With asar
 * off, every file (incl. better-sqlite3.node and tunnel's runtime deps)
 * sits on the real filesystem and require resolution + symlinks just work.
 */
const { spawnSync } = require('node:child_process');
const { rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { loadProjectEnv } = require('./src/env.cjs');
const NodeZipMaker = require('./scripts/node-zip-maker.cjs');

loadProjectEnv({ appDir: __dirname });

const isWindowsHost = process.platform === 'win32';
const isMacHost = process.platform === 'darwin';
const isForgeStart = process.argv.some(
  (arg) => arg === 'start' || /(?:^|[/\\])electron-forge-start(?:\.js)?$/.test(arg)
);
// Set FORGE_INCLUDE_SQUIRREL=1 to include the Squirrel maker. It is opt-in
// because electron-winstaller/Squirrel can fail while releasifying large
// asar=false pnpm apps with SharpCompress errors such as:
// "WriteEntryTo or OpenEntryStream can only be called once."
// FORGE_FORCE_SQUIRREL is kept as a backward-compatible alias for CI jobs.
const wantsSquirrel = Boolean(process.env.FORGE_INCLUDE_SQUIRREL || process.env.FORGE_FORCE_SQUIRREL);
const wantsDmg = Boolean(process.env.FORGE_INCLUDE_DMG);

function canCreateDmg() {
  if (!isMacHost) return false;
  if (isForgeStart) return false;
  if (process.env.FORGE_SKIP_DMG) return false;
  if (wantsDmg) return true;

  const probePath = join(tmpdir(), `qpjoy-hdiutil-probe-${process.pid}.dmg`);
  const result = spawnSync('hdiutil', ['create', probePath, '-ov', '-size', '1m'], {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    timeout: 5000
  });
  rmSync(probePath, { force: true });

  if (result.status === 0) return true;
  const message =
    result.error?.code === 'ETIMEDOUT'
      ? 'timed out after 5s'
      : (result.stderr || result.stdout || result.error?.message || 'unknown error').trim();
  console.warn(`[forge] skipping dmg maker because hdiutil create failed: ${message}`);
  console.warn('[forge] zip output will still be produced. Set FORGE_INCLUDE_DMG=1 to force dmg creation.');
  return false;
}

const includeDmg = canCreateDmg();
const packagedServerBaseUrl = (
  process.env.QPJOY_HDO_SERVER ||
  process.env.QPJOY_MARKET_SERVER ||
  ''
).trim().replace(/\/+$/, '');

const makers = [
  // ── macOS ────────────────────────────────────────────────────────
  { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  ...(includeDmg ? [{ name: '@electron-forge/maker-dmg', platforms: ['darwin'] }] : []),

  // ── Windows ──────────────────────────────────────────────────────
  // The .zip target is the default Windows artifact. Use a local Node maker
  // instead of @electron-forge/maker-zip because Forge's zip maker shells out
  // to powershell.exe on Windows, which is not reliably available in every
  // packaging terminal/PATH.
  ...(process.env.FORGE_SKIP_ZIP
    ? []
    : [new NodeZipMaker({}, ['win32'])])
];

// The Squirrel .exe installer maker links against `electron-winstaller`.
// Keep it opt-in; this app ships many unpacked resources so Squirrel can hit
// SharpCompress/NuGet extraction bugs even on native Windows hosts.
if (wantsSquirrel) {
  makers.push({
    name: '@electron-forge/maker-squirrel',
    platforms: ['win32'],
    config: {
      name: 'mx-hdo',
      authors: 'QPJoy',
      description: 'MX HDO desktop client',
      noDelta: true
    }
  });
}

module.exports = {
  packagerConfig: {
    name: 'MX HDO',
    executableName: 'mx-hdo',
    asar: false,
    appBundleId: 'dev.qpjoy.hdo',
    win32metadata: {
      CompanyName: 'QPJoy',
      ProductName: 'MX HDO'
    }
  },
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      writeFileSync(
        join(buildPath, 'qpjoy-hdo.config.json'),
        JSON.stringify({ serverBaseUrl: packagedServerBaseUrl }, null, 2)
      );
    }
  },
  rebuildConfig: {},
  makers
};
