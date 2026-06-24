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

Bootstrap resolution can be selected with `MX_H2I_BOOTSTRAP_RESOLVE_MODE`:
`env-first`, `dns-first`, `env-only`, or `dns-only`. The bootstrap phase may use
`MX_H2I_HOST_RESOLVE=api.mxinfo-inc.cn=<Domestic public IP>` to bypass public
DNS, or `MX_H2I_BOOTSTRAP_DNS_SERVERS=223.5.5.5,119.29.29.29` to resolve the
bootstrap domain through an explicit resolver before dialing the resolved IP
with the original Host header. The connected WireGuard phase still relies on
the launcher route plan and split DNS.

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

The Electron entry is intentionally light for the reservation phase:

- `src/main.cjs` owns the window, local runtime state, persisted endpoint
  settings, and IPC contracts.
- `src/preload.cjs` exposes a small safe API to the renderer.
- `src/renderer.js` renders guest connect, employee login, AppCenter install,
  H2O enablement, endpoint injection, and gray update states.
- `electron-builder.config.cjs` is ready for macOS, Windows, and Linux output.
