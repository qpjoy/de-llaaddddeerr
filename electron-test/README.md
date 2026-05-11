# QPJoy Electron Tunnel NPM Test

This is a standalone native Electron Forge project for testing the published
`@qpjoy/electron-tunnel` npm package. It deliberately does not use Quasar or the
local workspace package link.

## Run

Publish `@qpjoy/electron-tunnel` first, then:

```bash
cd electron-test
pnpm install
pnpm dev
```

This project includes a local `.npmrc` with `node-linker=hoisted`, because
Electron Forge requires hoisted pnpm dependencies. Its `pnpm-workspace.yaml`
allows pnpm to run the `electron` and native dependency build scripts that
download Electron and rebuild SQLite.

The app opens a small host window with only rule and test controls. Runtime
configuration lives in the package browser admin:

```text
http://127.0.0.1:23456
admin/admin
```

Use the browser admin to configure subscriptions, switch App / global / virtual
NIC modes, install or uninstall TUN, and start or stop the runtime. The host test
window only exercises the APIs a normal Electron app may choose to expose itself:
domain rules and opening a test browser window with the current tunnel config.

## Package

```bash
pnpm package
pnpm make
```

Electron Forge copies the engine resources from the npm package into the app via
`forge.config.cjs`:

```js
extraResource: [
  'node_modules/@qpjoy/electron-tunnel/resources/engine'
]
```

When packaged, the test app passes `process.resourcesPath + '/engine'` to the
SDK as `bundledEngineDir`.

## Local Pre-Publish Smoke Test

If the npm package has not been published yet, create a tarball from the SDK
package and install that tarball here:

```bash
cd ../electron/packages/electron-mihomo-tunnel
npm_config_cache=/private/tmp/qpjoy-npm-cache npm pack
cd ../../../electron-test
pnpm add ../electron/packages/electron-mihomo-tunnel/qpjoy-electron-tunnel-0.1.1.tgz
pnpm dev
```
