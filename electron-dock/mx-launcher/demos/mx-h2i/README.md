# MX-H2I Electron Demo

MX-H2I is the new H-side VPN product shell. It runs as a Launcher standalone
Electron app and owns one local network, auth, update, and permission channel.
The Launcher foundation itself is modeled as a reusable plugin/socket layer:
MX-H2I is the active standalone owner, while Luopan is reserved as a future
peer standalone owner that can consume the same foundation capabilities.
AppCenter and H2O are shown as Launcher embed apps that reuse the selected
standalone channel instead of receiving separate WireGuard peers.

## Run

From `electron-dock/mx-launcher`:

```sh
pnpm --filter @qpjoy/mx-h2i-demo dev
```

`pnpm dev` follows the V1 HDO local-development flow: it prepares the local
Launcher workspace packages before starting Electron. This keeps
`@qpjoy/electron-launcher` usable from the workspace without publishing it to
npm first.

## Package

```sh
pnpm --filter @qpjoy/mx-h2i-demo build
pnpm --filter @qpjoy/mx-h2i-demo package
pnpm --filter @qpjoy/mx-h2i-demo make
```

The package and make scripts run the same local Launcher preparation step
before invoking electron-builder, so clean Windows workspaces do not start with
an empty `@qpjoy/electron-launcher/dist`.

Bootstrap DNS can be selected with `MX_H2I_BOOTSTRAP_RESOLVE_MODE`:
`env-first`, `dns-first`, `env-only`, or `dns-only`. The bootstrap phase may use
`MX_H2I_HOST_RESOLVE=api.mxinfo-inc.cn=<Domestic public IP>` to bypass public
DNS, while the connected WireGuard phase still relies on the launcher route
plan and split DNS.

The Electron entry is intentionally light for the reservation phase:

- `src/main.cjs` owns the window, local runtime state, persisted endpoint
  settings, and IPC contracts.
- `src/preload.cjs` exposes a small safe API to the renderer.
- `src/renderer.js` renders guest connect, employee login, AppCenter install,
  H2O enablement, endpoint injection, and gray update states.
- `electron-builder.config.cjs` is ready for macOS, Windows, and Linux output.
