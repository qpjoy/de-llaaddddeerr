# QPJoy Electron Mihomo Tunnel

This folder contains the first Electron client MVP for the existing
`docker/hysteria2-mihomo-stack` server deployment.

## Shape

```text
electron/
  apps/quasar-client/              # Quasar Vue 3 Electron test app
  packages/electron-mihomo-tunnel/ # reusable Electron tunnel runtime
  packages/tunnel-cli/             # small integration helper
```

The tunnel runtime is not coupled to Quasar. A native Electron app can use the
same package from its main process and expose the same browser admin backend.

## Ports

- Admin browser backend: `http://127.0.0.1:23456`
- Mihomo external controller: `127.0.0.1:23457`
- Local mixed proxy: `127.0.0.1:23458`
- Local DNS listener: `127.0.0.1:23459`

The mixed/DNS ports are configurable in the Proxy page. The defaults avoid the
common Clash Verge `7890` mixed-port so both tools can be open at the same time.

Default admin login is `admin/admin`.

## Modes

- `system-tun`: enables mihomo TUN in the generated runtime config so the
  machine can route through the virtual interface when the core has enough
  privilege.
- `app-global`: Electron app traffic uses the local mixed proxy and the runtime
  config sends matched traffic to the proxy policy.
- `app-rule`: Electron app traffic uses the local mixed proxy; CN/local traffic
  is `DIRECT`. When no allowlist exists, remaining overseas traffic goes through
  the proxy policy. Once one or more allowlist rules exist, only allowlisted
  overseas domains go through the proxy policy and other overseas traffic is
  `REJECT`.

The first version supports saving multiple subscriptions and manually switching
the active one. Automatic failover across multiple subscriptions is intentionally
left for the next phase, because it requires merging and normalizing multiple
remote YAML files into one safe mihomo config.

## Development

Install dependencies from this folder:

```bash
cd electron
pnpm install
pnpm dev:quasar
```

Before starting mihomo from the UI in development, either provide a local core
path such as:

```text
/usr/local/bin/mihomo
```

or download a bundled core once:

```bash
pnpm core:install
```

Packaged Electron builds include anything under `electron/resources/mihomo`.
On first start the runtime copies the matching `mihomo.gz` or `mihomo`
executable into:

```text
<userData>/mihomo-tunnel/bin/mihomo
```

This makes end-user startup independent of network availability.

Then add a subscription URL like:

```text
http://download:password@YOUR_SERVER:3434/peer_user01.mihomo.yaml
```

The runtime strips Basic Auth credentials from the stored URL and keeps them in
SQLite fields, mirroring the existing shell client behavior.

## Reusing In Another Electron App

After building the package, a host Electron app can wire the runtime in its main
process:

```ts
import {
  AdminServer,
  MihomoManager,
  applyElectronProxy,
  registerTunnelIpc
} from '@qpjoy/electron-mihomo-tunnel';

const manager = new MihomoManager({
  userDataPath: app.getPath('userData'),
  adminPort: 23456,
  controllerPort: 23457
});

const admin = new AdminServer(manager);
admin.start();

registerTunnelIpc(ipcMain, manager, {
  afterSettingsChange: () => {
    const status = manager.status();
    return applyElectronProxy(session.defaultSession, status.mode, status.ports);
  }
});
```

You can also print this snippet with:

```bash
pnpm --filter @qpjoy/tunnel-cli build
node packages/tunnel-cli/dist/index.js snippet
```

## Local State

SQLite is stored below the Electron app user-data directory:

```text
<userData>/mihomo-tunnel/tunnel.sqlite
```

It currently tracks subscriptions, runtime settings, domain rules, core version
records, traffic snapshots, and event logs. The schema is intentionally ready for
future server-version rollout metadata.
