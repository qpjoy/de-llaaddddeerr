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
| `@qpjoy/electron-launcher/standalone-data-plane` | read-only standalone lease/data-plane route diagnostics |

For standalone products, keep the state model split into two phases:

1. `connectNetwork()` proves the control plane accepted the app and issued a
   lease.
2. WireGuard/PAC/DNS apply and route proof prove the local data plane is ready.

Products should not display `connected` only because a lease exists. Use the
read-only data-plane diagnostic before claiming traffic is ready:

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
`10.88.0.1` is only a fallback relay/cache target; all other domains fall back
to the previous system proxy when one is detected or provided. If another
standalone launcher already owns the same local edge port, a later instance
reuses it.

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
