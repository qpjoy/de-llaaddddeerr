/**
 * Forge config for `electron-demo/tunnel` — clean Marketplace consumer used
 * to validate the tunnel-only packaged flow on macOS + Windows.
 *
 * Why `asar: false`: same reasoning as `electron-test`'s config — the
 * marketplace seed pipeline calls `fs.symlink(<tunnel-dir>, ...)` and
 * symlink targets must be OS-readable, not inside an asar mount. With asar
 * off, every file (incl. better-sqlite3.node and tunnel's runtime deps)
 * sits on the real filesystem and require resolution + symlinks just work.
 */
const isWindowsHost = process.platform === 'win32';
// Set FORGE_FORCE_SQUIRREL=1 to include the Squirrel maker even on macOS/Linux
// (requires `mono` + `wine` to be installed; tested on the GitHub macos-latest
// runner with `brew install wine-stable mono`).
const wantsSquirrel = isWindowsHost || Boolean(process.env.FORGE_FORCE_SQUIRREL);

const makers = [
  // ── macOS ────────────────────────────────────────────────────────
  { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
  { name: '@electron-forge/maker-dmg', platforms: ['darwin'] },

  // ── Windows ──────────────────────────────────────────────────────
  // The .zip target shells out to `powershell.exe` for `Compress-Archive`
  // on Windows hosts. Some Windows installs (especially trimmed Server
  // SKUs, custom PATH setups, or hosts running through MINGW with a
  // pruned env) don't expose `powershell.exe` on the spawn lookup path,
  // and forge then bombs the whole `make` step. Set
  // `FORGE_INCLUDE_ZIP=1` to add it back. On macOS / Linux cross-builds
  // there's no powershell dependency, so we keep the zip target enabled
  // unconditionally there.
  ...(isWindowsHost && !process.env.FORGE_INCLUDE_ZIP
    ? []
    : [{ name: '@electron-forge/maker-zip', platforms: ['win32'] }])
];

// The Squirrel .exe installer maker links against `electron-winstaller`,
// which spawns mono+wine on non-Windows hosts. Push it onto the list only
// when the host supports it so cross-builds from macOS still emit the .zip
// target without aborting.
if (wantsSquirrel) {
  makers.push({
    name: '@electron-forge/maker-squirrel',
    platforms: ['win32'],
    config: {
      name: 'qpjoy-tunnel-demo',
      authors: 'QPJoy',
      description: 'QPJoy Tunnel demo app'
    }
  });
}

module.exports = {
  packagerConfig: {
    name: 'QPJoy Tunnel Demo',
    executableName: 'qpjoy-tunnel-demo',
    asar: false,
    appBundleId: 'dev.qpjoy.demo.tunnel',
    win32metadata: {
      CompanyName: 'QPJoy',
      ProductName: 'QPJoy Tunnel Demo'
    }
  },
  rebuildConfig: {},
  makers
};
