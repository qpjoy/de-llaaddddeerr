# electron-demo/tunnel

Clean Electron consumer app for the pre-HDO tunnel flow. This project
intentionally uses published npm packages, matching what a third-party app
developer would install before the HDO mesh/core split.

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

## Development

```bash
pnpm dev
```

This demo should not depend on local `electron-core-*` packages. Keep it on the
published tunnel package unless intentionally testing a new tunnel release.

## Package On macOS

```bash
pnpm install
pnpm package
pnpm make:mac
```

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
