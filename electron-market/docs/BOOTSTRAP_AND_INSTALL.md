# Bootstrap & Install Walkthrough

This document walks the full lifecycle of `@qpjoy/electron-tunnel` going
through the marketplace, including the chicken-and-egg case where the
network itself depends on the tunnel.

## TL;DR — three install paths, same end state

| Path | When to use | API |
| --- | --- | --- |
| **A. Standalone** (no marketplace at all) | App that doesn't want a plugin system. | `createElectronTunnel({ app, ipcMain, session }, opts)` |
| **B. Seed** (offline, host bundles the package) | First-run with no network, or first-party plugin baked into the installer. | `createElectronMarket(..., { seedPlugins: [{ ..., source: { type: 'local-dir', path } }] })` |
| **C. Marketplace** (network, user-driven) | The normal case once the host is up and connected. | Admin UI on `http://127.0.0.1:23455` → "Install" |

Whichever path is taken, the on-disk layout is identical:

```
<userData>/plugins/qpjoy.electron-tunnel@0.1.3/node_modules/@qpjoy/electron-tunnel/
<userData>/plugin-data/qpjoy.electron-tunnel/
marketplace.db       ← record + permission grants + logs (under qpjoy-plugin-host/)
```

…and the activation flow runs through the same `PluginRuntime.activate(id)`.

## A. Standalone (unchanged from today)

Nothing about the plugin-host work breaks this. The package still publishes
the same `createElectronTunnel` named export from `@qpjoy/electron-tunnel`,
so apps that integrate the tunnel directly keep doing:

```ts
import { createElectronTunnel } from '@qpjoy/electron-tunnel';

const tunnel = createElectronTunnel(
  { app, ipcMain, session: session.defaultSession },
  { adminPort: 23456 }
);
```

The new plugin contract lives at `@qpjoy/electron-tunnel/plugin` (a separate
exports subpath) so standalone consumers never even pull it in.

## B. Seed install (offline, the bootstrap path)

When the user installs your Electron app, ship the tunnel inside the app
resources so the host can register it without needing the network. Two
shapes work:

### B.1 — Bundled directory (simplest)

Inside your app bundle, drop the tunnel package somewhere like
`Contents/Resources/seeds/electron-tunnel/`. The directory must look like
the contents of a published tarball (so `package.json` at its root,
`dist/plugin.js`, `dist/plugin.manifest.json`, `resources/engine/mihomo`).

```ts
import path from 'node:path';
import { app, ipcMain, session } from 'electron';
import { createElectronMarket } from '@qpjoy/electron-market';

const host = createElectronMarket(
  { app, ipcMain, session: session.defaultSession },
  {
    adminPort: 23455,
    seedPlugins: [
      {
        id: 'qpjoy.electron-tunnel',
        npm: '@qpjoy/electron-tunnel',
        source: {
          type: 'local-dir',
          path: app.isPackaged
            ? path.join(process.resourcesPath, 'seeds', 'electron-tunnel')
            : path.resolve(__dirname, '../../electron-plugin/packages/electron-mihomo-tunnel')
        },
        // First-party seed: pre-approve every permission its manifest asks for.
        autoGrant: 'manifest'
      }
    ]
  }
);
```

What `createElectronMarket` does on first launch:

1. Check the registry. No record for `qpjoy.electron-tunnel` → call
   `PluginStore.installFrom({ source: { type: 'local-dir', path } })`.
2. Stage in a temp dir, copy the seed into
   `node_modules/@qpjoy/electron-tunnel/`, read `plugin.manifest.json`,
   atomically rename into `<userData>/plugins/qpjoy.electron-tunnel@0.1.3/`.
3. Upsert into the registry with `awaitingGrant`, then immediately apply
   the `autoGrant: 'manifest'` list → state becomes `installed`.
4. `activateAllOnStartup` runs, sees `onStartup` in the manifest, calls
   `require(...dist/plugin.js).default.activate(ctx)` → tunnel boots on
   23456-23459, system proxy applied.

From there the network is up and the marketplace can do its job.

### B.2 — Bundled tarball

If you'd rather ship `electron-tunnel-0.1.3.tgz` instead of an exploded
directory, swap the source:

```ts
source: {
  type: 'tarball',
  path: path.join(process.resourcesPath, 'seeds', 'electron-tunnel-0.1.3.tgz')
}
```

This goes through `npm install --ignore-scripts <path-to-tgz>`, which works
fully offline because npm never contacts the registry for a local file.

## C. Marketplace install (the user-driven path)

Once the tunnel is up — whether via seed or because the user already had
working network — the marketplace runs the normal flow:

### C.1 — User clicks "Install" in the panel

```
GET  http://127.0.0.1:23455/                     → admin SPA
GET  http://127.0.0.1:23455/api/marketplace      → fetches plugins.qpjoy.dev/index.json
POST http://127.0.0.1:23455/api/plugins/install  { "id": "qpjoy.electron-tunnel", "version": "0.1.3" }
```

The server:

1. `MarketplaceClient.resolve(id)` finds the entry.
2. `PluginStore.install({ id, npm, version })` runs
   `npm install --ignore-scripts @qpjoy/electron-tunnel@0.1.3` inside a
   staging dir, reads the manifest, asserts `manifest.id === entry.id`,
   moves the dir into place, and writes the registry row in `awaitingGrant`.

### C.2 — User reviews permissions and grants

The panel reads `manifest.permissions` and pops a dialog listing each one.
On approval:

```
POST /api/plugins/qpjoy.electron-tunnel/grant
{ "permissions": ["fs:userData","net:listen:23456", ...] }
```

State flips to `installed`.

### C.3 — User activates

```
POST /api/plugins/qpjoy.electron-tunnel/activate
```

`PluginRuntime.activate(id)`:

1. Re-checks the permission diff (`PermissionGate.missing(...)`); throws if
   anything was revoked since grant.
2. `require()`s `dist/plugin.js` from the install path, expects a default
   export shaped like `PluginModule`.
3. Builds a `PluginContext` and calls `module.activate(ctx)`.
4. The tunnel adapter constructs `createElectronTunnel(ctx.host, ...)` and
   returns its disposer.
5. State → `active`; logs the boot info via `ctx.log.info`.

The 23456 panel is now reachable from the host admin UI as a `contributes.adminPanel` card.

### C.4 — User uninstalls

```
POST /api/plugins/qpjoy.electron-tunnel/deactivate   ← runs the disposer
POST /api/plugins/qpjoy.electron-tunnel/uninstall    ← rm -rf install dir + DB row
```

The `plugin-data/qpjoy.electron-tunnel/` directory is intentionally NOT
removed on uninstall — that's user data (subscriptions, rule lists). A
follow-up `?purgeData=true` query param can be added if you want the panel
to offer "remove all data" as a separate destructive step.

## Order of operations when both seed and marketplace are configured

```
createElectronMarket(host, opts) is called
        │
        ▼
queueMicrotask:
        │
        │   for seed of opts.seedPlugins:
        │       if registry has no record for seed.id:
        │           PluginStore.installFrom(seed.source)   ← offline-safe
        │           registry.grant(seed.id, seed.autoGrant)
        │
        ▼
runtime.activateAllOnStartup()
        │
        │   for record in registry.list() where state != disabled
        │                                 and manifest.activationEvents.includes('onStartup'):
        │       runtime.activate(record.id)
        │
        ▼
Tunnel is now active. Outbound network works.
        │
        ▼
AdminServer (23455) is listening; user opens it; marketplace fetches index;
user installs/uninstalls other plugins through path C above.
```

Failure of a seed install (e.g. the bundled tarball was moved) is logged
into `plugin_logs` and surfaced in the admin UI, but does **not** abort
host startup — the user can still hit `/api/plugins/install-local` from the
panel and point at a tarball they downloaded by hand.

## Idempotency rules

- Seeds run only when the registry has no row for that `id`. They do not
  upgrade in place. To force a re-seed, bump the bundled `version` and
  uninstall the old record first (or call `install-local` with the new
  tarball).
- A marketplace install over an existing record replaces the install dir
  but preserves `grantedPermissions` (so a version bump doesn't trigger a
  fresh consent dialog unless the manifest's permission list changed).

## What "going through the marketplace also needs network" means in practice

The marketplace itself does two network operations:

1. **Fetch `index.json`** — one tiny JSON GET, done via global `fetch`.
   Uses whatever network is available; if the tunnel is up, traffic goes
   through it because the host process's `session.defaultSession` is
   already proxied.
2. **Install a package** — `npm install <pkg>@<ver>` inside the staging
   dir. npm respects `http_proxy`/`https_proxy` envs, which the tunnel
   plugin sets when it activates (`applyElectronProxy`).

So as long as the tunnel was seeded first (path B), path C installs go
through it automatically. If you're in a totally air-gapped environment,
skip path C and use `/api/plugins/install-local` with a sneakernet tarball
— the rest of the flow (grant → activate) is identical.
