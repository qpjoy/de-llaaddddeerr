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

## Package

```sh
pnpm --filter @qpjoy/mx-h2i-demo package
pnpm --filter @qpjoy/mx-h2i-demo make
```

The Electron entry is intentionally light for the reservation phase:

- `src/main.cjs` owns the window, local runtime state, persisted endpoint
  settings, and IPC contracts.
- `src/preload.cjs` exposes a small safe API to the renderer.
- `src/renderer.js` renders guest connect, employee login, AppCenter install,
  H2O enablement, endpoint injection, and gray update states.
- `electron-builder.config.cjs` is ready for macOS, Windows, and Linux output.
