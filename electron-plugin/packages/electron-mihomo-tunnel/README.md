# QPJoy Electron Tunnel

Reusable tunnel runtime for Electron apps on macOS and Linux.

```bash
pnpm add @qpjoy/electron-tunnel
```

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

The package starts a browser admin backend by default. Keep mode switching,
subscription management, local ports, start/stop, and TUN install/uninstall in
that admin UI so the host Electron app does not need tunnel-specific screens:

```text
http://127.0.0.1:23456
admin/admin
```

When the admin changes runtime settings, the SDK reapplies the Electron session
proxy automatically. If the admin switches to virtual NIC mode and TUN is
installed, the package can request the required system privilege from the host
app process.

The package also installs a CLI:

```bash
pnpm exec qpjoy-tunnel snippet
pnpm exec qpjoy-tunnel init --out src-electron/qpjoy-tunnel.ts
```

For `electron-builder`, package the bundled engine resources:

```ts
extraResources: [
  {
    from: 'node_modules/@qpjoy/electron-tunnel/resources/engine',
    to: 'qpjoy-tunnel-engine',
    filter: ['**/*']
  }
]
```

This package redistributes third-party tunnel engine binaries. See
`THIRD_PARTY_NOTICES.md` before publishing apps that include those resources.
