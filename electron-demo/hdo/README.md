# electron-demo/hdo

Local Electron consumer app for current HDO development. It links the local
marketplace and HDO packages so UI/server-install changes can be tested before
publishing.

## Dependencies

```bash
pnpm install
```

Installed QPJoy packages:

| Package | Purpose |
| --- | --- |
| `@qpjoy/electron-market` | Local marketplace host and admin UI |
| `@qpjoy/electron-plugin-sdk` | Local plugin protocol/types used by the market runtime |
| `@qpjoy/electron-plugin-tunnel` | Published tunnel seed plugin, installed offline on first app start |
| `@qpjoy/electron-plugin-hdo` | Local HDO plugin for client/server panels |
| `@qpjoy/electron-core-wireguard` | Local WireGuard config layer used by HDO |

The tunnel package depends on platform-specific optional engine packages. On
Windows x64, `pnpm install` should also install
`@qpjoy/electron-plugin-tunnel-engine-win32-x64`, so the app does not need to
download every macOS/Linux/Windows engine.

`@qpjoy/electron-plugin-notyet` and other plugins are installed through the
marketplace UI at runtime. They are not bundled into this demo app.

## Development

```bash
pnpm dev
```

Rebuild local packages after changing `electron-market` or `electron-plugin`:

```bash
pnpm build:local
```

The app seeds directly from `../../electron-plugin/packages/electron-plugin-hdo`
when running unpackaged. Packaged builds use `node_modules`, so run
`pnpm install` before `pnpm package` or `pnpm make:*`.

## Package On macOS

```bash
pnpm install
pnpm package
pnpm make:mac
```

Outputs are written below `out/`. Unsigned local builds may need quarantine
removed before opening:

```bash
xattr -cr "out/QPJoy HDO Demo-darwin-arm64/QPJoy HDO Demo.app"
open "out/QPJoy HDO Demo-darwin-arm64/QPJoy HDO Demo.app"
```

## Package On Windows

Copy this `electron-demo/hdo` directory together with the repo packages it links
to Windows, then run:

```powershell
pnpm install
pnpm make:win
```

Expected installer output:

```text
out\make\squirrel.windows\x64\QPJoy HDO Demo-0.1.0 Setup.exe
```

Do not copy `node_modules/` or `out/` between macOS and Windows. Native modules
such as `better-sqlite3` and Electron packaging tools must be installed on the
target OS.

## Notes

- `forge.config.cjs` keeps `asar: false` so the marketplace seed plugin can be
  installed from a real filesystem directory.
- `pnpm-lock.yaml` should be committed for reproducible npm installs.
- User data lives under:
  - macOS: `~/Library/Application Support/QPJoy HDO Demo/`
  - Windows: `%APPDATA%\QPJoy HDO Demo\`
  - Linux: `~/.config/QPJoy HDO Demo/`
