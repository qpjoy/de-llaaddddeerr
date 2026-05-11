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

Default admin backend:

```text
http://127.0.0.1:23456
admin/admin
```
