# @qpjoy/electron-launcher

Product-facing npm entry for MX Launcher.

Applications install this package directly and point it at an MX Launcher
backend. The package hides the internal split between core, embed, and
standalone adapters.

```ts
import { createElectronLauncher, defineLauncherProduct } from '@qpjoy/electron-launcher';

export const product = defineLauncherProduct({
  productId: 'h2o',
  displayName: 'H2O',
  mode: 'embed',
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
  mode: product.mode
});

const session = await launcher.connectNetwork({
  identityKind: 'anonymous',
  deviceLabel: 'H2O Desktop'
});

// Persist session.wireGuard.privateKey in the product's secure storage, then
// apply session.routePlan through the product's WireGuard/runtime adapter.
const routePlan = session.routePlan;
```

`standalone` mode is for the full Launcher shell. `embed` mode is for product
apps that carry Launcher network capability inside the app.

## Runtime adapters

The package exposes optional runtime adapters as separate subpaths so products
can depend only on the capabilities they own:

| Subpath | Purpose |
| --- | --- |
| `@qpjoy/electron-launcher` | launcher client, product definition, standalone/embed SDK facade |
| `@qpjoy/electron-launcher/wireguard` | WireGuard profile rendering, route proof, and peer recovery |
| `@qpjoy/electron-launcher/system-domain-proxy` | standalone local PAC/proxy edge plus OS PAC apply/restore/verify |

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
the local edge is active, the package also installs owned `/etc/resolver/<domain>`
split-DNS files that point matched domains at `127.0.0.1:<pacPort>` so `ping`,
CLI tools, and non-PAC applications can resolve the same Internal names. Resolver
files carry an `MX_ELECTRON_LAUNCHER_RESOLVER` marker and are removed on
disconnect; existing non-MX resolver files are left untouched.

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
  dnsServers: ['10.88.88.88', '10.88.0.1'],
  fallbackProxy: '127.0.0.1:7890'
});

// Later, when the launcher channel disconnects:
await systemDomainProxy.disable('disconnect');
```
