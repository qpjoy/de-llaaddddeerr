/**
 * Electron Forge configuration for `electron-test`.
 *
 * Packaging model:
 *
 *   - `asar: false`. Everything ships as real files under
 *     `.app/Contents/Resources/app/`. Why not asar:
 *
 *       1. The marketplace seed pipeline (`PluginStore.installFrom` for
 *          type='local-dir') calls `fs.symlink(<tunnel-dir>, …)`. Symlink
 *          targets must be OS-readable paths — asar mounts a *.asar file
 *          that the OS sees as a single byte blob, so a symlink with target
 *          inside `app.asar/…` is dangling at the OS level. Auto-unpack
 *          + careful unpackDir globbing can make it work but is fragile.
 *       2. Tunnel's runtime deps (`better-sqlite3`, `yaml`) would each have
 *          to be on the unpack list, or require resolution from the tunnel
 *          plugin would fail when walking up the node_modules chain.
 *       3. Native modules (better-sqlite3) need to be on the real FS for
 *          `dlopen`. Without asar this is automatic; with asar we'd lean
 *          on `@electron-forge/plugin-auto-unpack-natives`.
 *
 *     All three concerns vanish when `asar: false`. Cost: slightly slower
 *     startup + more files in the bundle. Worth it for plugin-host apps.
 *
 *   - `@electron/rebuild` (run by Forge's "Preparing native dependencies"
 *     step) recompiles `better-sqlite3` against Electron's NODE_MODULE_VERSION
 *     regardless of asar setting, so the embedded build is ABI-correct.
 */
module.exports = {
  packagerConfig: {
    name: 'QPJoy Tunnel NPM Test',
    executableName: 'qpjoy-tunnel-npm-test',
    asar: false
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          maintainer: 'QPJoy',
          homepage: 'https://qpjoy.local'
        }
      }
    }
  ]
  // `plugin-auto-unpack-natives` is irrelevant when asar is disabled — every
  // file (including .node modules) is already on the real filesystem.
};
