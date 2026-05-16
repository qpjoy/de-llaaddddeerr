# QPJoy Plugin Spec v1

A plugin is an npm package that the user installs through `@qpjoy/electron-market`.
This document defines the contract between a plugin and the host runtime.

## 1. Package layout

```
your-plugin/
├─ package.json              ← MUST contain a `qpjoyPlugin` field
└─ dist/
   ├─ plugin.manifest.json   ← MUST be the file referenced in qpjoyPlugin.manifest
   ├─ plugin.js              ← MUST be the entry referenced in qpjoyPlugin.entry
   └─ ...                    ← anything else your plugin needs
```

`package.json` excerpt:

```jsonc
{
  "name": "@vendor/cool-plugin",
  "version": "1.2.3",
  "main": "dist/index.js",
  "qpjoyPlugin": {
    "specVersion": 1,
    "entry": "dist/plugin.js",
    "manifest": "dist/plugin.manifest.json"
  }
}
```

Packages without `qpjoyPlugin` are rejected by the marketplace at install time.

## 2. Manifest schema

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable reverse-DNS id (`vendor.plugin-name`). Distinct from the npm name. |
| `name` | yes | Human-readable. Shown in the admin UI. |
| `version` | yes | Must match `package.json#version`. |
| `engines.electronPlugin` | yes | semver against the host runtime. |
| `engines.electron` | no | semver against electron. |
| `permissions` | yes | See PERMISSIONS.md. May be empty. |
| `activationEvents` | yes | At least one. `onStartup` is the default. |
| `contributes.adminPanel` | no | Register a URL card in the host admin UI. |
| `contributes.settings.schema` | no | Path to a JSON schema describing the settings shape. |
| `contributes.commands` | no | Command palette entries. |

## 3. Entry contract

The entry module must `export default` a `PluginModule`:

```ts
import { definePlugin } from '@qpjoy/plugin-sdk';

export default definePlugin({
  async activate(ctx) {
    // boot your subsystem here
    return async () => {
      // disposer (optional)
    };
  }
});
```

`activate` receives a `PluginContext`. Anything beyond the published surface
of `@qpjoy/plugin-sdk` is **not** part of the contract and may break across
host versions.

## 4. Lifecycle

```
installed ──grant──▶ awaitingGrant ──activate──▶ active ──deactivate──▶ installed
       │                                  │
       └──────────── uninstall ◀──────────┘                (also from any state)
                                          │
                                          └──── crash ──▶ errored
```

- `onStartup` plugins are activated automatically when the host boots.
- A plugin in `awaitingGrant` cannot activate until all permissions in its
  manifest are present in the user's grant list.
- `errored` plugins are left in place so the user can read logs; the next
  successful `activate` call clears the error.

## 5. Versioning & compatibility

- The host enforces `engines.electronPlugin` via semver. Incompatible plugins
  are listed but cannot be activated.
- Manifest schema changes bump `specVersion`. v1 hosts ignore v2 plugins.

## 6. Storage

Each plugin gets:

- `userData/plugins/<id>@<version>/` — installation, owned by the store.
- `userData/plugin-data/<id>/` — sandbox for runtime data. The plugin gets a
  path to this via `ctx.userDataDir`. Other dirs require `fs:any`.

## 7. Inter-plugin RPC

```ts
// Plugin A:
ctx.expose({ status: () => ({ ok: true }) });

// Plugin B (needs `ipc:cross` granted, A needs it too):
const s = await ctx.call('vendor.plugin-a', 'status');
```

There is no implicit discovery — both sides must agree on plugin id and
method names.

## 8. Out-of-process isolation (future)

v1 runs plugins in-process. v2 will offer optional isolation via
`utilityProcess` or a `vm`-context sandbox; the same `PluginContext` will
work in both modes. Plugins that opt in early can set
`engines.runtime: 'isolated'` in the manifest — the v1 host ignores it.

## 9. Self-hosting (the host is also a plugin)

`@qpjoy/electron-market` declares `qpjoyPlugin.self: true` so its manifest
gets registered in the same table as everything else. This means the same
admin UI lists "Plugin Host" alongside user-installed plugins, and the same
upgrade flow applies — just with a special branch that does not deactivate
itself in place.
