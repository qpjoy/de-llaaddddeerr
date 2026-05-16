# QPJoy Electron Tunnel

This folder contains the first Electron client MVP for the existing
`docker/hysteria2-mihomo-stack` server deployment.

## Shape

```text
electron/
  apps/quasar-client/              # Quasar Vue 3 Electron test app
  packages/electron-mihomo-tunnel/ # published as @qpjoy/electron-tunnel
  packages/tunnel-cli/             # legacy dev helper
```

The tunnel runtime is not coupled to Quasar. A native Electron app can use the
same package from its main process and expose the same browser admin backend.

## Ports

- Admin browser backend: `http://127.0.0.1:23456`
- Tunnel controller: `127.0.0.1:23457`
- Local mixed proxy: `127.0.0.1:23458`
- Local DNS listener: `127.0.0.1:23459`

The mixed/DNS ports are configurable in the Proxy page. The defaults avoid the
common Clash Verge `7890` mixed-port so both tools can be open at the same time.
Only one full-system TUN should be enabled at a time, though: Clash Verge TUN and
QPJoy `system-tun` both try to own default routes, DNS hijack, fake-ip routing,
and a `utun` interface on macOS. Keep Clash in app/proxy-only mode, or turn its
TUN off, when testing QPJoy virtual NIC mode.

Default admin login is `admin/admin`.

## Modes

- `system-tun`: enables the tunnel engine TUN in the generated runtime config so
  the machine can route through the virtual interface when the engine has enough
  privilege. On macOS the dev app asks for administrator approval and launches
  the engine with elevated privileges; Linux uses `pkexec` when available. Runtime
  config changes are hot reloaded so network changes and mode switches do not
  repeatedly ask for administrator approval. The next service-mode milestone will
  move this to a first-install-only privileged helper.
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
remote YAML files into one safe runtime config.

## Development

Install dependencies from this folder:

```bash
cd electron
pnpm install
pnpm dev:quasar
```

Download bundled tunnel engine resources once before packaging:

```bash
pnpm core:install
```

Packaged Electron builds include tunnel engine resources under
`electron/resources/mihomo` for the dev app and under
`packages/electron-mihomo-tunnel/resources/engine` for the npm package. On first
start the runtime installs the matching executable into the app user-data
directory:

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

Install the package in a host Electron app:

```bash
pnpm add @qpjoy/electron-tunnel
```

Then wire the runtime once in the Electron main process:

```ts
import { app, ipcMain, session } from 'electron';
import { createElectronTunnel } from '@qpjoy/electron-tunnel';

const tunnel = createElectronTunnel({ app, ipcMain, session: session.defaultSession }, {
  adminPort: 23456,
  controllerPort: 23457,
  mixedPort: 23458,
  dnsPort: 23459
});

app.whenReady().then(async () => {
  await tunnel.applyProxy();
});

app.on('before-quit', () => {
  tunnel.close();
});
```

The npm package also ships `qpjoy-tunnel`:

```bash
pnpm exec qpjoy-tunnel snippet
pnpm exec qpjoy-tunnel init --out src-electron/qpjoy-tunnel.ts
```

For `electron-builder`, include the packaged engine resources:

```ts
extraResources: [
  {
    from: 'node_modules/@qpjoy/electron-tunnel/resources/engine',
    to: 'qpjoy-tunnel-engine',
    filter: ['**/*']
  }
]
```

## Local State

SQLite is stored below the Electron app user-data directory:

```text
<userData>/mihomo-tunnel/tunnel.sqlite
```

It currently tracks subscriptions, runtime settings, domain rules, engine version
records, traffic snapshots, and event logs. The schema is intentionally ready for
future server-version rollout metadata.
