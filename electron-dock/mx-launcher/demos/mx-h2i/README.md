# MX-H2I Electron Demo

MX-H2I is the new H-side VPN product shell. It runs as a Launcher standalone
Electron app and owns one local network, auth, update, and permission channel.
The Launcher foundation itself is modeled as a reusable plugin/socket layer:
MX-H2I is the active standalone owner, while Luopan is reserved as a future
peer standalone owner that can consume the same foundation capabilities.
AppCenter and H2O are shown as Launcher embed apps with
`networkScope: broker-session`: they reuse the selected standalone broker
channel instead of receiving separate WireGuard peer lease IPs.

## Run

From `electron-dock/mx-launcher`:

```sh
pnpm --filter @qpjoy/mx-h2i-demo dev
```

## Test AppCenter And H2O

1. Start MX-H2I:

   ```sh
   pnpm --filter @qpjoy/mx-h2i-demo dev
   ```

2. Connect as guest or employee. The standalone channel must be connected
   before AppCenter can install embed apps.

3. Click `AppCenter -> Install/Enter`. AppCenter opens as a user-facing
   desktop app center: browse recommended apps, search by app name, select H2O,
   then install or open it. Operational details stay hidden by default.
   Installing AppCenter and running `Check Updates` both try to sync
   `/internal/v1/app-center/apps` from Internal; sync success or failure is
   written to the AppCenter debug log.

4. Click `Debug` in AppCenter only when developing or troubleshooting. The
   debug drawer shows `packageName`, `installedVersion`, `latestVersion`,
   `networkScope`, permissions, entrypoints, local install path, and recent
   install/runtime logs. Normal users only see install/open status and any
   visible error message.

5. Install H2O from AppCenter. H2O means **Home To Oversea**: it is the
   built-in AppCenter network plugin direction, similar to a Clash-style user
   surface, but it inherits network/user/permission state from MX-H2I instead
   of owning WireGuard itself. In development MX-H2I resolves
   `entrypoints.dev: workspace:demos/mx-app-h2o`, reads the local H2O package
   version, and records the install cache on `runtime.apps.h2o`. Built-in
   AppCenter records use `builtin://appcenter`; future registry/tarball records
   are installed into the AppCenter cache directory under Electron `userData`.

6. Start the H2O embed app demo:

   ```sh
   pnpm --filter @qpjoy/electron-launcher-app-h2o dev
   ```

   The package is `@qpjoy/electron-launcher-app-h2o` and uses
   `launcherMode: embed`, `standaloneChannelProductId: mx-h2i`, and
   `networkScope: broker-session`. Its `runtimeContractVersion` is `0.1`, and
   it never creates an independent WireGuard peer.

7. H2O defaults to a user-facing Home To Oversea UI. Click `Debug` inside H2O
   to inspect broker session, socket path, package metadata, local IP,
   capability bridge, contract version, and inherited MX-H2I channel state.

8. To test the denied embed path, run H2O with the dev broker disabled:

   ```sh
   MX_H2O_BROKER_MODE=off pnpm --filter @qpjoy/electron-launcher-app-h2o dev
   ```

For production, Internal admin should register the same AppCenter app record
with `packageName: @qpjoy/electron-launcher-app-h2o`, the latest release
version, access policy, permissions, and entrypoints. AppCenter reads that
catalog record, compares it with local installed cache, installs or updates the
npm package, then opens the app through MX-H2I broker-session.

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

Bootstrap resolution can be selected with `MX_H2I_BOOTSTRAP_RESOLVE_MODE`:
`env-first`, `dns-first`, `env-only`, or `dns-only`. Use the V2 bootstrap host
`http://h2i.mxinfo-inc.cn:18090` when V1 HDO and V2 H2I DNS coexist. The current
Domestic public host is `116.62.51.154`; older `121.43.253.179` / `121.43.254.179`
runtime settings are treated as stale defaults. The bootstrap phase may use
`MX_H2I_HOST_RESOLVE=h2i.mxinfo-inc.cn=116.62.51.154`
to bypass public DNS, or `MX_H2I_BOOTSTRAP_DNS_SERVERS=223.5.5.5,119.29.29.29`
to resolve the bootstrap domain through an explicit resolver before dialing the
resolved IP with the original Host header. `MX_H2I_BOOTSTRAP_DNS_SERVERS` must
point at a DNS resolver, not merely at the A record returned for the bootstrap
host. If the Domestic public host is used as the direct bootstrap endpoint,
prefer Host Resolve/env mode and leave `MX_H2I_BOOTSTRAP_DNS_SERVERS` empty
unless that host also serves DNS on port 53. The connected WireGuard phase
still relies on the launcher route plan and split DNS.

When `dns-first` is selected, MX-H2I retries the bootstrap DNS resolver three
times. If DNS still fails, the connection warns the user and temporarily falls
back to Host Resolve/env mode when configured, then to the system default
network path, so the launcher can continue toward the HDI/WireGuard phase.
The system path is intended to coexist with Clash/mihomo system proxy and TUN
mode. Fake-IP or proxy TUN routes are not treated as H2I proof; the connected
phase still requires the MX-H2I WireGuard route and Internal healthz.

After WireGuard is ready, MX-H2I installs a standalone-owned system PAC that
points Internal domains at the shared local edge `127.0.0.1:2053`. The same
port serves `/proxy.pac` and an HTTP/CONNECT proxy. Matched domains are resolved
through the route plan DNS server, then routed by WireGuard `AllowedIPs`; other
traffic falls back to the previous system proxy such as Clash/mihomo. Multiple
MX-H2I standalone instances can reuse the same local edge port. DNS resolution
prefers the Internal fixed IP `10.88.88.88`; Domestic `10.88.0.1` is kept only
as a relay/cache fallback. Override the port with `MX_H2I_LOCAL_EDGE_PORT` only
for diagnostics or collision tests.

Startup does not restore stale macOS PAC/split DNS state by default, because
that repair requires an administrator prompt before the user has chosen to
connect. Reconnect or disconnect performs the explicit repair path. Set
`MX_H2I_RESTORE_SYSTEM_PROXY_ON_STARTUP=1` only for break-glass cleanup runs.

On macOS, the WireGuard runtime prefers a product-owned LaunchDaemon
(`com.qpjoy.mx-h2i.wireguard.*`) after the user approves connect. This mirrors
the V1 HDO keep-alive path: launchd keeps the tunnel alive across lock, unlock,
and sleep/resume, while the app process only probes and reports health.

The Electron entry is intentionally light for the reservation phase:

- `src/main.cjs` owns the window, local runtime state, persisted endpoint
  settings, and IPC contracts.
- `src/preload.cjs` exposes a small safe API to the renderer.
- `src/renderer.js` renders guest connect, employee login, AppCenter install,
  H2O enablement, endpoint injection, and gray update states.
- `electron-builder.config.cjs` is ready for macOS, Windows, and Linux output.
