# electron-demo/tunnel

Clean Electron consumer app for the tunnel flow. It can run against the local
workspace packages during development, or switch back to published npm packages
for packaging so the output matches a third-party app.

## Dependencies

```bash
pnpm install
```

Installed QPJoy packages:

| Package | Purpose |
| --- | --- |
| `@qpjoy/electron-market` | Embeds the plugin marketplace host and admin UI |
| `@qpjoy/electron-plugin-sdk` | Public plugin protocol/types used by the market runtime |
| `@qpjoy/electron-plugin-tunnel` | Bundled seed plugin, installed offline on first app start |

The tunnel package depends on platform-specific optional engine packages. On
Windows x64, `pnpm install` should also install
`@qpjoy/electron-plugin-tunnel-engine-win32-x64`, so the app does not need to
download every macOS/Linux/Windows engine.

`@qpjoy/electron-plugin-hdo`, `@qpjoy/electron-plugin-notyet`, and other plugins are installed through the
marketplace UI at runtime. They are not bundled into this demo app.

## Development With Local Source

```bash
pnpm dev
```

`pnpm dev` first runs `node scripts/dev-mode.mjs local`, which builds the local
market/tunnel packages, packs them into `.local-packs/`, and installs the demo
from those tarballs. This mirrors `electron-demo/hdo` and avoids symlinking into
workspace `node_modules`, so native modules such as `better-sqlite3` resolve from
the demo app install.

To test the published npm path explicitly:

```bash
pnpm dev:npm
```

To reset the demo back to npm mode without launching Electron:

```bash
pnpm dev:reset
```

## Host App Tunnel Events

Consumer apps can keep their integration thin by exposing marketplace-level
Tunnel events from preload:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tunnel', {
  status: () => ipcRenderer.invoke('market:tunnel:status'),
  startApp: () => ipcRenderer.invoke('market:tunnel:start_app'),
  startGlobal: () => ipcRenderer.invoke('market:tunnel:start_global'),
  startTun: () => ipcRenderer.invoke('market:tunnel:start_tun'),
  stop: () => ipcRenderer.invoke('market:tunnel:stop')
});
```

`start_app` and `start_global` do not request OS privileges. `start_tun` is the
only event that can enter the virtual-network-adapter privilege flow.

## Package On macOS

```bash
pnpm install
pnpm package
pnpm make:mac
```

Packaging scripts run `node scripts/dev-mode.mjs npm` first, so release builds
use published npm packages instead of local workspace tarballs.

Outputs are written below `out/`. Unsigned local builds may need quarantine
removed before opening:

```bash
xattr -cr "out/QPJoy Tunnel Demo-darwin-arm64/QPJoy Tunnel Demo.app"
open "out/QPJoy Tunnel Demo-darwin-arm64/QPJoy Tunnel Demo.app"
```

## Package On Windows

Copy this `electron-demo/tunnel` directory to Windows, then run:

```powershell
pnpm install
pnpm make:win
```

Expected installer output:

```text
out\make\squirrel.windows\x64\QPJoy Tunnel Demo-0.1.0 Setup.exe
```

Do not copy `node_modules/` or `out/` between macOS and Windows. Native modules
such as `better-sqlite3` and Electron packaging tools must be installed on the
target OS.

## Notes

- `forge.config.cjs` keeps `asar: false` so the marketplace seed plugin can be
  installed from a real filesystem directory.
- `pnpm-lock.yaml` should be committed for reproducible npm installs.
- User data lives under:
  - macOS: `~/Library/Application Support/QPJoy Tunnel Demo/`
  - Windows: `%APPDATA%\QPJoy Tunnel Demo\`
  - Linux: `~/.config/QPJoy Tunnel Demo/`
