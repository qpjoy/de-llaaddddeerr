# Luopan Quasar Electron Demo

> Taking over Luopan for real product development? Start with
> [HANDOFF.md](HANDOFF.md) — registered network values, hard boundaries,
> npm/local dev modes, and acceptance criteria live there.

Luopan is a business Electron app demo for MX Launcher. It uses Quasar/Vue for
the application shell and consumes `@qpjoy/electron-launcher` from Electron main
through a small preload IPC boundary.

The demo is intentionally not a copy of MX-H2I. MX-H2I is a VPN product and one
Launcher standalone owner; Luopan represents a future standalone business app
that owns its own ProductNetwork, lease/IP segment, and WireGuard profile when
it is registered from the Admin `Luopan` onboarding template.

## Run

From `electron-dock/mx-launcher`:

```sh
pnpm --filter @qpjoy/luopan-demo dev
```

or:

```sh
pnpm luopan:dev
```

The default server is `http://10.88.88.88:18090`. Override it with:

```sh
LUOPAN_LAUNCHER_BASE_URL=http://192.168.1.4:18090 pnpm --filter @qpjoy/luopan-demo dev
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

Service VIP route proof is local data-plane evidence, not an ICMP contract. A
VIP such as `10.88.100.3` may reject `ping` while the route is still correct.
However, route proof alone is not enough to mark Luopan as network-ready: the
demo also checks `http://10.88.100.3:18090/healthz` (or the materialized
service VIP port from the route plan). If the `/32` route is present but HTTP
health times out, the runtime stays `service-unreachable` /
`data-plane-pending` until Domestic relay / Internal service-peer
materialization publishes Luopan behind its product VIP.

Use `Request lease` to verify the control-plane entitlement path. Then use
`Apply data plane` to sync the Domestic peer, install the product-specific
WireGuard profile, and wait for route proof. The default standalone route scope
is product-local: Luopan installs its lease CIDR and service VIP `/32`, but does
not install shared foundation routes such as `10.88.0.1`, `10.88.88.88`, or
`10.88.0.0/16`. If Luopan needs Internal control while MX-H2I is disconnected,
that access must come from product-scoped service materialization: the AppCenter
Save App flow assigns Luopan a channel VIP such as `10.88.100.3`, and the server
materializes control, DNS, proxy, permission, user, release, and gray-test
services behind that VIP. A product-neutral `launcher-foundation` shared plane
is only a legacy/fallback pattern, not the normal standalone product dependency.
`LUOPAN_DATA_PLANE_MODE=reuse` is only for embed/reuse smoke tests. The demo
keeps the WireGuard private key in memory only; after an app restart, request a
fresh lease before applying the data plane again. A production app should persist
key material in the OS credential store.
