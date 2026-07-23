# @qpjoy/electron-launcher

Product-facing npm entry for MX Launcher.

Applications install this package directly and point it at an MX Launcher
backend. The package hides the internal split between core, embed, and
standalone adapters.

For production SDK delivery, MX Launcher also supports role-specific packages:

| Package | Use when |
| --- | --- |
| `@qpjoy/mx-launcher-core` | sharing protocol, manifest, capability, release, and ABI contracts |
| `@qpjoy/mx-launcher-standalone` | building a capability owner such as MX-H2I or Luopan |
| `@qpjoy/mx-launcher-embed-sdk` | building an embed app such as AppCenter, H2O, or an AppCenter-managed app |
| `@qpjoy/electron-launcher` | using the unified Electron facade or existing compatibility exports |

Both delivery styles are supported. The role-specific split is preferred for
external teams because it keeps owner-only APIs out of embed apps. The unified
Electron package remains useful for monorepo demos, legacy products, and apps
that want a single import surface. Packages with the same major version must be
protocol-compatible; breaking protocol or broker ABI changes require a new
major version.

See the package design notes in `../README.md`, `../launcher-core/README.md`,
`../launcher-standalone/README.md`, and `../launcher-embed-sdk/README.md`.

```ts
import { createElectronLauncher, defineLauncherProduct } from '@qpjoy/electron-launcher';

export const product = defineLauncherProduct({
  productId: 'h2o',
  displayName: 'H2O',
  mode: 'embed',
  standaloneChannelProductId: 'mx-h2i',
  launcherActions: {
    network: true,
    release: true,
    update: true,
    rollout: true,
    appCenter: true
  }
});

const launcher = createElectronLauncher({
  baseUrl: 'http://127.0.0.1:18090',
  productId: product.productId,
  mode: product.mode,
  standaloneChannelProductId: product.standaloneChannelProductId,
  requiredCapabilities: ['user.session', 'network.proxy', 'network.status']
});

const connection = launcher.mode === 'embed'
  ? await launcher.connect()
  : null;

if (connection && !connection.ok) {
  console.warn(connection.state, connection.message);
}
```

`standalone` mode is for the full Launcher shell. `embed` mode is for product
apps hosted by a standalone broker session. Embed apps do not allocate their own
WireGuard peer lease or apply DNS/route state; call `launcher.connect()` and
request scoped capabilities from the selected standalone channel.

## Runtime adapters

The package exposes optional runtime adapters as separate subpaths so products
can depend only on the capabilities they own:

| Subpath | Purpose |
| --- | --- |
| `@qpjoy/electron-launcher` | launcher client, product definition, standalone/embed SDK facade |
| `@qpjoy/electron-launcher/wireguard` | WireGuard profile rendering, route proof, and peer recovery |
| `@qpjoy/electron-launcher/system-domain-proxy` | standalone local PAC/proxy edge plus OS PAC apply/restore/verify |
| `@qpjoy/electron-launcher/standalone-data-plane` | standalone WG apply/stop/diagnostics plus cross-process-safe ownership claims |
| `@qpjoy/electron-launcher/oversea` | logged-in user ensure-subscription exchange with inline YAML and no persisted bearer |

An Internal-ready standalone product can exchange its in-memory login token for
the current user's Oversea subscription. Only start a proxy runtime when
`ready` is true; `pending-runtime-sync` means Internal can render YAML but the
remote account has not yet passed synchronization.

```ts
import { ensureElectronLauncherUserOverseaSubscription } from '@qpjoy/electron-launcher/oversea';

const result = await ensureElectronLauncherUserOverseaSubscription({
  baseUrl: 'http://10.88.100.3:18090',
  userId,
  accessToken,
  requestedBy: 'luopan-oversea'
});

if (result.ready && result.subscription) {
  // Pass result.subscription.yaml directly to a trusted Electron main-process
  // runtime. Do not expose it to the renderer or put the token in its URL.
}
```

For standalone products, keep the state model split into two phases:

1. `connectNetwork()` proves the control plane accepted the app and issued a
   lease.
2. WireGuard/PAC/DNS apply and route proof prove the local data plane is ready.

Products should not display `connected` only because a lease exists. Use the
data-plane diagnostic before claiming traffic is ready. Ownership claim updates
are serialized by a stable per-state-file queue with unique per-process
candidate files, then committed with fsync + atomic rename. Ticket/token
arbitration elects one writer; live contention fails closed after a bounded
wait, while dead unique candidates can be removed without deleting a newer
owner:

```ts
import {
  applyElectronLauncherStandaloneDataPlane,
  diagnoseElectronLauncherStandaloneDataPlane
} from '@qpjoy/electron-launcher/standalone-data-plane';

const dataPlane = diagnoseElectronLauncherStandaloneDataPlane({
  routePlan: session.routePlan,
  leaseIp: session.lease.leaseIp,
  serviceVip: session.lease.serviceVip
});

if (!dataPlane.ok) {
  console.warn(dataPlane.state, dataPlane.message);
}

const applied = await applyElectronLauncherStandaloneDataPlane({
  userDataDir: app.getPath('userData'),
  profileName: `${product.productId}.conf`,
  routePlan: session.routePlan,
  privateKey: session.wireGuard.privateKey,
  dnsDomains: ['mxinfo-inc.cn'],
  ownerId: `${product.productId}:${installId}`,
  productId: product.productId,
  instanceId: installId,
  dnsHosts: ['luopan.mxinfo-inc.cn'],
  dnsZones: ['mxinfo-inc.cn'],
  failOnOwnershipConflicts: true
});
```

Inside the `electron-dock/mx-launcher` monorepo, demos depend on this package
with `workspace:*`, so local package changes are used by MX-H2I, Luopan, and
future launcher demos during development. Release builds should consume a
published semver version from npm, matching the V1 HDO local-vs-published
workflow.

System PAC is intended for Launcher standalone owners. For MX-H2I the local edge
listens on `127.0.0.1:2053` by default and serves both `/proxy.pac` and an
HTTP/CONNECT proxy on TCP, plus a UDP DNS relay on the same port. Internal
domains are resolved with the Internal IP from the route plan, `10.88.88.88` by
default, through the WireGuard AllowedIPs path. The Domestic gateway
`10.88.0.1` is only a fallback relay/cache target.

The application-hosted local edge is not a Windows cross-process broker.
A stable current-user lease queue makes every second PAC owner fail closed
before it starts an edge or mutates state/registry, even when it chooses another
edge port or state path. Each contender uses a unique candidate file so stale
recovery cannot unlink a newly acquired lease. The package never attaches an
owner to a server whose lifetime it cannot control.
The current Luopan demo does not install NRPT or PAC, so it can run next to
MX-H2I today. Before Luopan becomes another DNS/PAC owner, both products must
use one long-lived Launcher network broker that merges owner claims and keeps
the edge alive until the last owner exits.

On Windows, MX-H2I installs both the WireGuard NRPT rules and its local-edge
WinINet PAC by default. Exact and suffix Internal matches always return
`PROXY 127.0.0.1:2053`; the local edge then resolves and routes them through the
Internal data plane. `MX_H2I_WINDOWS_SYSTEM_PAC=0` is only a diagnostic/degraded
switch and cannot produce a fully ready connection.

MX-H2I owns only the WinINet `AutoConfigURL` value. It reads but does not write
`ProxyEnable`, `ProxyServer`, `ProxyOverride`, or `AutoDetect`, so a Clash
static system proxy remains available to non-PAC consumers while the MX PAC
wraps it for unmatched browser traffic.

Apply and restore compare all five captured WinINet values immediately before
writing and verify the result afterward. This detects ordinary Clash ownership
changes and fails closed, but Windows registry does not provide a
cross-vendor compare-and-set transaction: an uncooperative process can still
write in the narrow interval between MX's final read and write. A strict
two-writer guarantee therefore requires the long-lived broker (or cooperation
on the same lease); watcher reconciliation and readback are recovery controls,
not a mathematical replacement for that broker.

The Windows PAC preserves public traffic only when the previous owner can be
represented safely:

- no proxy owner, including Clash TUN mode, falls back to `DIRECT`;
- a readable, valid loopback PAC is wrapped behind MX-H2I's Internal rules;
- when no explicit PAC applies, a live loopback static proxy is reused as
  `PROXY <listener>; DIRECT`;
- WPAD/AutoDetect fails closed only when automatic configuration is the sole
  applicable owner and no representable live static/PAC continuation exists;
- unreadable or non-loopback PAC, an unrepresentable proxy, or a dead listener
  fails closed before registry mutation and is not browser-ready.

Windows ready requires all four live proofs: NRPT/system DNS resolves an
Internal namespace to its Internal target, WinINet reads back the MX-H2I PAC,
Electron Chromium `session.resolveProxy()` selects `127.0.0.1:2053`, and a real
CONNECT through that local edge succeeds. The normal five-second watcher path is
read-only. A newly observed external-owner signature may trigger one bounded
reconciliation and an `AutoConfigURL` write; later ticks for the same signature
remain read-only. Every 30 seconds, the continuation refresh may read a changed
Clash listener or same-URL PAC body, update the in-memory MX PAC, and notify
WinINet without rewriting registry values. Reconnect, manual repair, or another
owner-state change may start a new reconciliation.

Windows disconnect and normal exit use two phases. First, while `2053` remains
live, MX restores the external value captured by the most recent successful
negotiation only if it still owns `AutoConfigURL`; a value already installed by
another owner is preserved. Then WireGuard stops and owned NRPT cleanup is
verified. Only after both phases succeed may the local edge close. A failed
restore or cleanup aborts disconnect/exit and keeps a recoverable path alive.

On macOS, local PAC alone only covers proxy-aware traffic such as browsers. When
`systemResolver: 'dynamic'` is enabled, the package installs a runtime
SystemConfiguration supplemental DNS entry for matched domains and points it at
`127.0.0.1:<pacPort>`, so `ping`, CLI tools, and non-PAC applications resolve
the same Internal names without writing `/etc/hosts` or `/etc/resolver`. A file
resolver mode remains available as an explicit fallback and only manages files
with the `MX_ELECTRON_LAUNCHER_RESOLVER` marker.

```ts
import { createElectronLauncherSystemDomainProxy } from '@qpjoy/electron-launcher/system-domain-proxy';

const systemDomainProxy = createElectronLauncherSystemDomainProxy({
  userDataDir: app.getPath('userData'),
  pacPort: 2053
});

await systemDomainProxy.apply({
  enabled: true,
  domains: ['internal.mx', 'svc.cluster.local'],
  matchMode: 'proxy',
  proxy: '127.0.0.1:2053',
  pacPort: 2053,
  systemResolver: 'dynamic',
  dnsServers: ['10.88.88.88', '10.88.0.1'],
  fallbackProxy: '127.0.0.1:7890'
});

// Later, when the launcher channel disconnects:
await systemDomainProxy.disable('disconnect');
```
