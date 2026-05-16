# Permissions

Permissions are declared in the plugin manifest and explicitly granted by the
user before activation. The runtime intercepts dangerous APIs and throws
`PermissionDeniedError` for anything that wasn't granted.

## Catalogue

| Permission | What it allows | Granted automatically? |
| --- | --- | --- |
| `fs:userData` | Read/write inside `userData/plugin-data/<id>/`. | yes, on grant of any permission set |
| `fs:any` | Arbitrary filesystem paths. | no — explicit confirm |
| `net:listen:<port>` | Bind a TCP server on a single port. | yes if port is unused by another active plugin |
| `net:listen:<lo>-<hi>` | Bind any port in a range. | no — explicit |
| `net:fetch:<host>` | Outgoing HTTP(S) to a host. | yes for hosts declared in manifest |
| `net:fetch:*` | Outgoing HTTP(S) to anywhere. | no |
| `system:proxy` | Modify electron session proxy / system proxy. | no — explicit (only one plugin may hold this at a time) |
| `system:exec:<bin>` | Spawn a specific binary. | no — explicit; bin must match |
| `system:exec:*` | Spawn anything. | never auto |
| `ipc:<channel>` | Register/emit a specific IPC channel (auto-prefixed `plugin/<id>/`). | yes |
| `ipc:cross` | Call other plugins via `ctx.call`. | no — explicit |
| `ui:adminPanel` | Show a card in the host's admin UI. | yes if `contributes.adminPanel` present |

## Decision flow

```
install ─▶ scan manifest ─▶ show "X requests these permissions" dialog
   │
   ├── user grants all   ─▶ state = installed   (ready to activate)
   ├── user grants subset ─▶ state = awaitingGrant (activation blocked)
   └── user denies      ─▶ uninstall offered
```

## Runtime enforcement (where each permission is checked)

| Permission | Enforcement point |
| --- | --- |
| `fs:userData` | `ctx.userDataDir` is the only path the host hands out; the host does not provide a generic `fs` proxy. Plugins that import `fs` directly bypass this — see Hardening below. |
| `fs:any` | Reserved for the v2 sandbox. v1 documents it but does not enforce. |
| `net:listen:*` | Static check at activation against the port the plugin requests; the host owns `http.createServer` wrappers in the SDK. |
| `net:fetch:*` | `ctx.fetch` parses the URL's host and calls `gate.require('net:fetch:<host>')`. |
| `system:proxy` | `ctx.host.applyProxy` and any session-proxy helper exposed by the SDK. |
| `system:exec:<bin>` | `ctx.spawn(bin, …)` — the bin string is checked against the granted permission literally. |
| `ipc:<channel>` | The SDK wraps `ipcMain.handle` so channels are namespaced. |
| `ipc:cross` | Checked on **both** caller and callee inside `PluginRuntime.call`. |

## Hardening notes (v1 → v2)

In v1 plugins run in the host process. A malicious plugin that imports
`node:fs` directly can circumvent the permission gate. This is acceptable
because v1 is for first-party + audited plugins distributed through the
verified marketplace. v2 hardens this by running each plugin inside a
`utilityProcess` with a curated module resolver — the same `PluginContext`
keeps working; only `require()` is restricted.

## How a verified plugin is reviewed

Before flipping `verified: true` in the marketplace index:

1. Manifest permissions match what the source code actually uses.
2. `system:exec:*` and `fs:any` are never present on a verified plugin.
3. README has a "Permissions" section that explains each one in user terms.
4. No `postinstall` script — the store always installs with `--ignore-scripts`,
   but verified plugins should not ship one at all.
5. Published tarball matches the source git tag (reproducible build).
6. `THIRD_PARTY_NOTICES.md` is present and lists every shipped binary or
   bundled library license.
