# Luopan Quasar Electron Demo

> Taking over Luopan for real product development? Start with
> [HANDOFF.md](HANDOFF.md) — registered network values, hard boundaries,
> npm/local dev modes, and acceptance criteria live there. For CI publishing,
> use the scoped [Release Center developer API](../../docs/25-release-center-developer-api.md).

Luopan is a business Electron app demo for MX Launcher. It uses Quasar/Vue for
the application shell and consumes `@qpjoy/electron-launcher` from Electron main
through a small preload IPC boundary.

The demo is intentionally not a copy of MX-H2I. MX-H2I is a VPN product and one
Launcher standalone owner; Luopan represents a future standalone business app
that owns its own ProductNetwork, lease/IP segment, and WireGuard profile when
it is registered from the Admin `Luopan` onboarding template.

## Run as an independent standalone launcher

From `demos/luopan`:

```sh
cp .env.example .env
curl -fsS http://116.62.51.154:18090/bootstrap-healthz
curl -fsS http://116.62.51.154:18090/internal/v1/launcher-network/products/luopan
curl -fsS http://116.62.51.154:18090/internal/v1/app-center/apps/luopan
pnpm run setup
pnpm run dev
```

`predev`, `prebuild`, and `prepackage` automatically prepare an app-local
`better-sqlite3` build for the current Electron ABI. This copy lives under
`.electron-native/` and is packaged as an extra resource; it deliberately does
not rebuild the workspace's Node-native copy. If Electron is upgraded, the
fingerprint changes and the native copy is rebuilt on the next command.

The two URLs have different phases: `LUOPAN_BOOTSTRAP_URLS` is an ordered list
of LAN/public entrances reachable before WireGuard is up, while
`LUOPAN_LAUNCHER_BASE_URL` is the registered in-tunnel Luopan VIP and must stay
`http://10.88.100.3:18090`. Never set it to the MX-H2I compatibility addresses
`10.88.88.88` or `10.88.0.1`.

After the window opens, use **Connect Internal**. The demo probes the bootstrap
`/healthz`, enrolls the registered `luopan` ProductNetwork, obtains an anonymous
lease, syncs the Domestic peer, asks for OS authorization to install the
product-scoped WireGuard service, and finally proves the in-tunnel VIP
`/healthz`. `network-ready` is the successful terminal state. Then log in
through the in-tunnel VIP; the public bootstrap endpoint never receives an
account, password, or bearer token. If a user-range lease is required, use
**Disconnect → Connect Internal** once after login.

After login, the User Center panel can change the current user's password. It
verifies the current password through the same in-tunnel VIP, revokes every
active token for that user, clears the local identity/Oversea session, and
requires a new login.

During the V1-to-V2 transition, an operator may explicitly set
`LUOPAN_LEGACY_HDO_BASE_URL`. If V2 reports that an account is not active,
Luopan validates the credentials once against that legacy HDO API, imports the
identity through the in-tunnel User Center endpoint with the fixed `mx-user`
role and `luopan`/`h2o` app access, then retries the V2 password grant. V1
tokens are discarded. Remove the setting after all users are migrated; use
HTTPS when the legacy deployment supports it.

The current shell directly exercises network lease/WireGuard/VIP, User Center,
Oversea, and Release Center. When both a logged-in access token and
`network-ready` Internal path exist, Luopan automatically calls the shared
`ensure-subscription` client, waits until Internal reports the user's Oversea
runtime fully synchronized, stores the returned YAML through the shared tunnel
runtime, starts mihomo, and connects an isolated Electron test session to the
local mixed proxy. The login token is kept in memory and is never copied into
the subscription URL, SQLite record, renderer state, or `.env`.

The desktop app is only a Release Consumer. It checks and reports through the
existing product-VIP endpoints and must never contain a Publisher client secret.
Runtime checks bind `productId=luopan`. Luopan CI publishes on `channel=shadow`; full installers use
`componentId=luopan`, renderer updates use `componentId=luopan-renderer`, and
the current package targets are macOS DMG, Windows NSIS EXE, and Linux
AppImage. Artifact upload, targeted validation, gate approval, and full rollout
are documented in
[docs/25](../../docs/25-release-center-developer-api.md).

The embedded **Home to Oversea** panel provides subscription refresh,
start/stop, application-global/rule mode, subscription and rule inspection,
structured logs, a URL test window, and Google/YouTube/X/Telegram shortcuts.
It deliberately does not expose system TUN in this first version: the proxy is
scoped to the isolated Oversea test session, so it cannot capture Luopan's
Internal WireGuard route or replace the machine's system PAC. Log out or
disconnect Internal to stop the running proxy.

There is still no dedicated permission/grant test IPC or page. Also,
standalone readiness is proved with the VIP address; the
Luopan path records DNS ownership but currently suppresses WireGuard DNS, so
opening `luopan.mxinfo-inc.cn` is not part of this verified path yet.

The CONFIG panel is persisted in `<userData>/luopan-runtime.json`. Explicit
process/`.env` values take precedence, so this checked configuration also fixes
URLs saved by an older run. If operating without `.env`, correct the two values
in CONFIG. Do not delete the runtime merely to change URLs: doing so also
replaces installId/deviceId and breaks existing Release Center targeting and
evidence continuity.

Changing the VIP base URL or SDK mode in development invalidates the current
identity, subscription, browser session, and data plane before the new channel
can be used. Packaged builds force `http://10.88.100.3:18090` with SDK test mode
off, and login rechecks that the configured host equals the connected service
VIP and that its `/healthz` is reachable before sending a password.

A non-VIP `LUOPAN_LAUNCHER_BASE_URL` and `LUOPAN_SDK_TEST_MODE=1` are
development escape hatches only. The checked-in example uses the registered
production coordinates.

During development the demo consumes `@qpjoy/electron-launcher` 2.3.3 and
`@qpjoy/electron-plugin-tunnel` 0.1.19 through workspace dependencies. The
packaged/online mode must use published versions containing the same Oversea
ensure/inline-YAML/test-window contracts and the matching platform engine.

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
- `src/components/OverseaPanel.vue` is the embedded H2O-style control and test
  surface; it only consumes the narrow `luopan:*` preload API.
- `@qpjoy/electron-launcher` owns the authenticated Internal ensure contract;
  `@qpjoy/electron-plugin-tunnel` owns mihomo lifecycle and the isolated test
  session proxy. Luopan does not copy `mx-h2i/src/main.cjs`.

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
