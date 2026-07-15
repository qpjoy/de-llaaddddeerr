# QPJoy Electron Tunnel

Reusable tunnel runtime for Electron apps on macOS, Windows, and Linux.

```bash
pnpm add @qpjoy/electron-plugin-tunnel
```

```ts
import { app, ipcMain, session } from 'electron';
import { createElectronTunnel } from '@qpjoy/electron-plugin-tunnel';

const tunnel = createElectronTunnel({ app, ipcMain, session: session.defaultSession }, {
  adminPort: 23456,
  controllerPort: 23457,
  mixedPort: 23458,
  dnsPort: 1053
});

app.whenReady().then(async () => {
  await tunnel.applyProxy();
});

app.on('before-quit', () => {
  tunnel.close();
});
```

Hosts that obtain a subscription through an authenticated control plane can
pass the returned YAML directly without placing bearer credentials in a URL:

```ts
await tunnel.manager.applyManagedConfig({
  subscription: { name: 'System Oversea', url: internalSubscriptionUrl },
  subscriptionContent: subscriptionYaml,
  mode: 'app-global',
  autoStart: true,
  source: 'launcher-oversea'
});
await tunnel.applyProxy();
await tunnel.openTestWindow('https://www.google.com');
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

The built-in DNS listener defaults to `:1053`. Virtual NIC mode uses
Mihomo TUN DNS hijack for app DNS traffic, so the tunnel does not need to bind
the system `:53` port or rely on another Clash instance.

The package also installs a CLI:

```bash
pnpm exec qpjoy-tunnel snippet
pnpm exec qpjoy-tunnel init --out src-electron/qpjoy-tunnel.ts
```

Tunnel engine binaries are split into platform-specific optional packages such
as `@qpjoy/electron-plugin-tunnel-engine-win32-x64`. npm/pnpm installs only the
package matching the current OS/CPU, so end users do not download every engine.

For `electron-builder`, package the installed engine resources if you do not
ship `node_modules` as part of the app bundle:

```ts
extraResources: [
  {
    from: 'node_modules/@qpjoy/electron-plugin-tunnel-engine-win32-x64/resources/engine',
    to: 'qpjoy-tunnel-engine',
    filter: ['**/*']
  }
]
```

Choose the engine package name for the platform you are building on. Apps that
package from the target OS with normal `npm install` / `pnpm install` usually
do not need this extra resource rule.

The platform engine packages redistribute third-party tunnel engine binaries.
See their package contents and `THIRD_PARTY_NOTICES.md` before publishing apps
that include those resources.
