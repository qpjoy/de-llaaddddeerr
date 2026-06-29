# Luopan Quasar Electron Demo

Luopan is a business Electron app demo for MX Launcher. It uses Quasar/Vue for
the application shell and consumes `@qpjoy/electron-launcher` from Electron main
through a small preload IPC boundary.

The demo is intentionally not a copy of MX-H2I. MX-H2I is the VPN product and
network owner. Luopan represents a future standalone business app that can be
created from the Admin `Luopan` onboarding template and can request a Launcher
Network lease when the app is registered.

## Run

From `electron-dock/mx-launcher`:

```sh
pnpm --filter @qpjoy/luopan-demo dev
```

or:

```sh
pnpm luopan:dev
```

The default server is `http://100.89.0.12:18090`. Override it with:

```sh
LUOPAN_LAUNCHER_BASE_URL=http://127.0.0.1:18090 pnpm --filter @qpjoy/luopan-demo dev
```

`LUOPAN_SDK_TEST_MODE=1` keeps the demo usable before Luopan is registered in
AppCenter. Turn it off to verify the real entitlement path:

```sh
LUOPAN_SDK_TEST_MODE=0 pnpm --filter @qpjoy/luopan-demo dev
```

During development the demo consumes `@qpjoy/electron-launcher` from
`electron-dock/mx-launcher/packages/electron-launcher` through the workspace
dependency. The packaged/online mode should switch to a published npm semver
version, so the same launcher package can be reused by MX-H2I, Luopan, and
future Electron apps without coupling them to this demo.

## Build

```sh
pnpm --filter @qpjoy/luopan-demo build
```

The build script uses Quasar's `--skip-pkg` mode. It verifies the renderer,
Electron main, and preload bundles, and writes `dist/electron/UnPackaged`
without running the final packaging install step. Use `pnpm --filter
@qpjoy/luopan-demo package` when the build host is ready for a full
electron-builder packaging run.

## Package Boundary

- `src-electron/electron-main.ts` owns Electron, launcher npm package calls,
  local install identity, and IPC.
- `src-electron/electron-preload.ts` exposes a renderer-safe API.
- `src/pages/ConsolePage.vue` is a Quasar/Vue business UI that never imports
  Node or launcher internals directly.

This shape is the intended compatibility contract for other Electron stacks:
Quasar, Vite, electron-builder, electron-forge, or a custom builder can keep the
same main/preload adapter and replace only the renderer framework.

## Network State

Luopan separates lease state from data-plane readiness. A successful lease means
the MX Launcher control plane has accepted the app and assigned addresses. The
runtime does not claim the local route is ready until the shared launcher package
proves the host route, service VIP, DNS relay, and endpoint are on the expected
WireGuard/direct path.

Use `Request lease` to verify the control-plane entitlement path. Then use
`Apply data plane` to sync the Domestic peer, install the product-specific
WireGuard profile, and wait for route proof. The demo keeps the WireGuard
private key in memory only; after an app restart, request a fresh lease before
applying the data plane again. A production app should persist key material in
the OS credential store.
