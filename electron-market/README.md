# electron-market

The QPJoy plugin marketplace + host runtime, embedded inside your Electron
app's main process. Once the app depends on `@qpjoy/electron-market`, every
plugin (including `@qpjoy/electron-plugin-tunnel`) is installed / uninstalled /
permission-managed through the in-process admin panel on
`http://127.0.0.1:23455`.

> **Renamed** in 0.2.0: previously published as `@qpjoy/electron-plugin`.
> The old name was misleading — this is the marketplace host, not a plugin.
> The 0.1.x line is deprecated; new releases ship as `@qpjoy/electron-market`.
> `createElectronPluginHost` is kept as a deprecated alias for
> `createElectronMarket`, so migrating an existing app is a one-line
> package-name swap.

## Layout

```
packages/
├─ electron-market/   @qpjoy/electron-market             host runtime + admin server
├─ electron-plugin-sdk/        @qpjoy/electron-plugin-sdk                  types/helpers for plugin authors
├─ marketplace-db/    @qpjoy/marketplace-db              shared SQLite + migration layer
└─ admin-ui/          @qpjoy/electron-market-admin-ui    Vue + Quasar SPA served on 23455
docs/
├─ PLUGIN_SPEC.md            access standard (manifest, lifecycle, contracts)
├─ PERMISSIONS.md            permission catalogue + enforcement rules
└─ BOOTSTRAP_AND_INSTALL.md  three install paths + end-to-end walkthrough
registry/
└─ index.json                sample marketplace index (mirror of plugins.qpjoy.dev)
scripts/
├─ smoke-marketplace.mjs     runnable pipeline smoke test (no Electron needed)
└─ copy-admin-ui.mjs         copies admin-ui/dist into the host package at build time
```

## Three install paths

The same plugin (e.g. `@qpjoy/electron-plugin-tunnel`) can be installed in three
ways; the end-state on disk and in the registry is identical:

1. **Standalone** — `createElectronTunnel(...)` directly, no plugin host involved.
2. **Seed** — host bundles the package and calls `createElectronMarket`
   with `seedPlugins: [...]`; works offline.
3. **Marketplace** — user clicks "install" in the 23455 panel; needs network
   (which the seeded tunnel can be providing).

See `docs/BOOTSTRAP_AND_INSTALL.md` for the full walkthrough including the
bootstrap order when the network depends on the tunnel.

## Quick start (host side)

```ts
import { app, ipcMain, session } from 'electron';
import { createElectronMarket } from '@qpjoy/electron-market';

app.whenReady().then(() => {
  const host = createElectronMarket(
    { app, ipcMain, session: session.defaultSession },
    {
      adminPort: 23455,
      marketplaceUrl: 'https://plugins.qpjoy.dev/index.json',
      seedPlugins: [
        // Make sure the tunnel is present before any marketplace traffic.
        {
          id: 'qpjoy.electron-tunnel',
          npm: '@qpjoy/electron-plugin-tunnel',
          source: {
            type: 'local-dir',
            path: path.join(process.resourcesPath, 'seeds', 'electron-tunnel')
          },
          autoGrant: 'manifest'
        }
      ]
    }
  );
  app.on('before-quit', () => host.close());
});
```

That's the entire host integration. Everything else happens through
`http://127.0.0.1:23455`:

- browse the marketplace
- install / uninstall plugins
- grant or revoke permissions
- activate / deactivate
- read per-plugin logs

## Plugin author quick start

```ts
// dist/plugin.js
import { definePlugin } from '@qpjoy/electron-plugin-sdk';
import { createElectronTunnel } from '@qpjoy/electron-plugin-tunnel';

export default definePlugin({
  async activate(ctx) {
    const tunnel = createElectronTunnel(ctx.host, ctx.settings.get());
    ctx.onConfigChange((next) => tunnel.manager.updateSettings(next));
    ctx.expose({ status: () => tunnel.status() });
    return () => tunnel.close();
  }
});
```

Ship the package with a `qpjoyPlugin` block in `package.json` and a
`dist/plugin.manifest.json`. See `docs/PLUGIN_SPEC.md` for the full contract
and `docs/PERMISSIONS.md` for the permission catalogue.

## What's in / what's stubbed

| Concern | v1 status |
| --- | --- |
| SQLite registry + log table | done |
| Marketplace fetch + cache | done (JSON index) |
| Admin HTTP API | done |
| Admin SPA | Quasar + Vite build in `packages/admin-ui/`, copied into the host's `dist/admin-ui/` at build time. Placeholder HTML remains as a fallback. |
| Permission gate (declarative + runtime) | done |
| In-process plugin runtime | done |
| `utilityProcess` isolation | deferred to v2 (see PLUGIN_SPEC §8) |
| Code signing of plugin tarballs | deferred — the `verified` flag is index-only for now |
| Bearer-token auth on admin port | deferred — reuse pattern from `@qpjoy/electron-plugin-tunnel`'s AdminServer |
