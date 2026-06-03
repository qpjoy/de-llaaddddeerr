# electron-demo/hdo

Electron consumer app for HDO delivery and packaging. It supports two
dependency layouts:

- `local`: used by `pnpm dev`; packs current workspace packages into
  `.local-packs/` so HDO and marketplace edits can be tested before publishing.
- `npm`: used by `pnpm package` / `pnpm make:*`; installs published packages
  from npm so packaged builds match the normal plugin-market user path.

## Dependencies

```bash
pnpm install
```

Installed QPJoy packages in npm mode:

| Package | Purpose |
| --- | --- |
| `@qpjoy/electron-market` | Published marketplace host and admin UI |
| `@qpjoy/electron-plugin-sdk` | Published plugin protocol/types used by the market runtime |
| `@qpjoy/electron-plugin-tunnel` | Published tunnel seed plugin, installed offline on first app start |
| `@qpjoy/electron-plugin-hdo` | Published HDO plugin for client/server panels |
| `@qpjoy/electron-core-wireguard` | Transitive WireGuard config layer used by HDO |

The tunnel package depends on platform-specific optional engine packages. On
Windows x64, `pnpm install` should also install
`@qpjoy/electron-plugin-tunnel-engine-win32-x64`, so the app does not need to
download every macOS/Linux/Windows engine.

`@qpjoy/electron-plugin-notyet` and other plugins are installed through the
marketplace UI at runtime. They are not bundled into this app.

## Development

```bash
pnpm dev
```

`pnpm dev` switches to local mode, builds the relevant workspace packages,
packs them to `.local-packs/`, reinstalls, and then starts Electron. Re-running
`pnpm dev` is fast until you reset the mode.

Repack local packages after changing `electron-market` or `electron-plugin`:

```bash
pnpm dev:reset
pnpm dev
```

To test the published npm flow during development:

```bash
pnpm dev:npm
```

Packaged builds always run npm mode first, so they use `node_modules` installed
from the registry rather than workspace file links.

## Package On macOS

```bash
pnpm install
cp .env.example .env
# edit .env, set QPJOY_HDO_SERVER
pnpm package
pnpm make:mac
```

Outputs are written below `out/`. Unsigned local builds may need quarantine
removed before opening:

```bash
xattr -cr "out/QPJoy HDO-darwin-arm64/QPJoy HDO.app"
open "out/QPJoy HDO-darwin-arm64/QPJoy HDO.app"
```

## Package On Windows

Copy only this `electron-demo/hdo` directory to Windows, then run:

```powershell
pnpm install
copy .env.example .env
# edit .env, set QPJOY_HDO_SERVER
pnpm make:win
```

`make:win` switches to npm mode before packaging. It should download
`@qpjoy/electron-market`, `@qpjoy/electron-plugin-hdo`,
`@qpjoy/electron-plugin-tunnel`, and their transitive runtime packages directly
from npm. Publish the HDO package version referenced in `package.json` before
running this on a clean Windows machine.

Expected installer output:

```text
out\make\squirrel.windows\x64\QPJoy HDO-0.1.0 Setup.exe
```

Do not copy `node_modules/` or `out/` between macOS and Windows. Native modules
such as `better-sqlite3` and Electron packaging tools must be installed on the
target OS.

## Notes

- `forge.config.cjs` keeps `asar: false` so the marketplace seed plugin can be
  installed from a real filesystem directory.
- App, market, and plugin releases are controlled by the release-plan API.
  For HDO app rollout, create a `game` target plan with `targetId=qpjoy-hdo`
  and the desired percentage or installId allowlist.
- `QPJOY_HDO_SERVER` can be set in `electron-demo/hdo/.env` or as a process
  env var. The `.env` value is written into `qpjoy-hdo.config.json` during
  packaging. Use the same base URL as `electron-server` so the app can sync
  market data, receive release plans, and report rollout status.
- When HDO is connected, the demo applies a system PAC URL for server-published
  service domains so external browsers can resolve those HDO domains without
  editing `hosts`. The previous macOS Auto Proxy URL or Windows WinINet PAC
  setting is stored under user data and restored when HDO stops or the app
  quits.
- `pnpm-lock.yaml` should be committed in npm mode for reproducible installs.
- `.dev-mode` and `.local-packs/` are local-only and ignored by git.
- User data lives under:
  - macOS: `~/Library/Application Support/QPJoy HDO/`
  - Windows: `%APPDATA%\QPJoy HDO\`
  - Linux: `~/.config/QPJoy HDO/`
