/**
 * electron-test main process.
 *
 * The tunnel is loaded as a plugin — it can be deactivated/uninstalled by
 * the user from the marketplace at any time. This file is therefore
 * defensive: every IPC handler that wraps the tunnel returns null when
 * the plugin isn't active, and the UI shows a clear "not active" state
 * instead of crashing the renderer.
 *
 *   http://127.0.0.1:23455  → plugin marketplace panel
 *   http://127.0.0.1:23456  → tunnel admin panel (only when active)
 */
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');

let createElectronPluginHost;
try {
  ({ createElectronPluginHost } = require('@qpjoy/electron-market'));
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('\n[electron-test] failed to require @qpjoy/electron-market:');
  console.error(`  ${err.message}\n`);
  console.error('Run `pnpm setup` from electron-test first — it builds the');
  console.error('marketplace host workspace and links the dists into this app.\n');
  process.exit(1);
}

const TUNNEL_ID = 'qpjoy.electron-tunnel';

let mainWindow = null;
let host = null;
let activeWatchInterval = null;
let lastEventDispose = null;
let lastActiveState = false;

/**
 * Where the tunnel package lives on disk — same npm-installed location in
 * both dev and packaged builds.
 *
 * `app.getAppPath()` resolves to:
 *   - dev (`pnpm dev`): `electron-test/`
 *   - packaged (asar:false): `<.app>/Contents/Resources/app/`
 *
 * Both are real filesystem directories, so PluginStore's `fs.symlink(...)`
 * works, and require-resolution from inside the symlinked plugin walks up
 * to find `better-sqlite3` / `yaml` etc. in the same `node_modules/` tree.
 *
 * Dev override: set QPJOY_TUNNEL_SOURCE=/path/to/local/tunnel to point at
 * a checked-out workspace copy when iterating on tunnel source itself.
 */
function tunnelSeedDir() {
  if (process.env.QPJOY_TUNNEL_SOURCE) {
    return path.resolve(process.env.QPJOY_TUNNEL_SOURCE);
  }
  return path.join(app.getAppPath(), 'node_modules', '@qpjoy', 'electron-plugin-tunnel');
}

/**
 * Returns the tunnel's exposed RPC surface, or `null` when the plugin
 * is not active. Callers must handle null gracefully — never throw on
 * the renderer's behalf, since the renderer polls these every few seconds.
 */
function tunnel() {
  return host?.runtime.getExposed(TUNNEL_ID) ?? null;
}

function isTunnelActive() {
  return Boolean(tunnel());
}

async function applyProxy() {
  const api = tunnel();
  // No tunnel = no proxy to apply. Electron's default session keeps direct
  // network access, which is the correct fallback.
  if (!api) return;
  await api.applyProxy();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 760,
    minHeight: 540,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function normalizeUrl(input) {
  const value = input.trim();
  if (!value) throw new Error('测试网址不能为空');
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function openTestWindow(rawUrl) {
  const targetUrl = normalizeUrl(rawUrl);
  const testWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    title: targetUrl,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await applyProxy();
  await testWindow.loadURL(targetUrl);
}

function registerAppIpc() {
  // Every wrapper returns null when tunnel is missing so the renderer can
  // render an "inactive" state instead of crashing on a thrown error.
  ipcMain.handle('tunnel-test:status', () => {
    const api = tunnel();
    return api ? api.status() : null;
  });
  ipcMain.handle('tunnel-test:snapshot', () => {
    const api = tunnel();
    return api ? api.snapshot() : null;
  });
  ipcMain.handle('tunnel-test:add-rule', (_e, input) => {
    const api = tunnel();
    return api ? api.addDomainRule(input.kind, input.domain) : null;
  });
  ipcMain.handle('tunnel-test:remove-rule', (_e, id) => {
    const api = tunnel();
    return api ? api.removeDomainRule(id) : null;
  });
  ipcMain.handle('tunnel-test:add-preset', (_e, preset) => {
    const api = tunnel();
    return api ? api.addPreset(preset) : null;
  });
  ipcMain.handle('tunnel-test:remove-preset', (_e, preset) => {
    const api = tunnel();
    return api ? api.removePreset(preset) : null;
  });
  ipcMain.handle('tunnel-test:open-test-window', (_e, url) => openTestWindow(url));
  ipcMain.handle('tunnel-test:open-admin', async () => {
    const api = tunnel();
    const url = api?.status?.()?.adminUrl ?? 'http://127.0.0.1:23456';
    await shell.openExternal(url);
  });
  ipcMain.handle('tunnel-test:open-plugin-market', async () => {
    await shell.openExternal('http://127.0.0.1:23455');
  });
  ipcMain.handle('tunnel-test:is-active', () => isTunnelActive());
}

/**
 * Hook tunnel's `event` emitter so live state changes flow into the
 * renderer. The exposed `onEvent` returns a disposer; we stash it and
 * re-wire whenever the plugin (re)activates so we don't double-subscribe
 * to a stale instance.
 */
function wireTunnelEventBridge() {
  if (lastEventDispose) {
    try {
      lastEventDispose();
    } catch {
      /* ignore */
    }
    lastEventDispose = null;
  }
  const api = tunnel();
  if (!api?.onEvent) return;
  lastEventDispose = api.onEvent(() =>
    mainWindow?.webContents.send('tunnel-test:event')
  );
}

/**
 * Poll the plugin host so we notice when tunnel transitions
 * active ↔ inactive (e.g. user clicked deactivate / uninstall / reseed
 * in the marketplace). The renderer subscribes to `tunnel-test:active-change`
 * and updates its UI accordingly.
 */
function startActiveWatcher() {
  if (activeWatchInterval) return;
  lastActiveState = isTunnelActive();
  wireTunnelEventBridge();
  activeWatchInterval = setInterval(() => {
    const active = isTunnelActive();
    if (active !== lastActiveState) {
      lastActiveState = active;
      mainWindow?.webContents.send('tunnel-test:active-change', active);
      if (active) {
        // Rebind event forwarder + reapply session proxy as the new
        // tunnel takes over.
        wireTunnelEventBridge();
        applyProxy().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[electron-test] applyProxy after activation failed:', err);
        });
      }
    }
  }, 1000);
}

app
  .whenReady()
  .then(async () => {
    // We deliberately don't pass `serverBaseUrl` — @qpjoy/electron-market
    // picks the right default for us based on app.isPackaged (local docker
    // during dev, production VPS in packaged builds). That's part of the
    // contract: end-user apps never need to know about the marketplace URL.
    host = createElectronPluginHost(
      { app, ipcMain, session: session.defaultSession },
      {
        adminPort: 23455,
        syncIntervalMs: 60_000,
        seedPlugins: [
          // Tunnel is the lone seed: it provides networking, so the
          // marketplace itself can't function before the tunnel exists.
          // Everything else (including NotYet) installs via the normal
          // marketplace pipeline from npm.
          {
            id: TUNNEL_ID,
            npm: '@qpjoy/electron-plugin-tunnel',
            source: { type: 'local-dir', path: tunnelSeedDir() },
            autoGrant: 'manifest'
          }
        ]
      }
    );

    await host.ready;

    registerAppIpc();
    startActiveWatcher();

    // applyProxy is best-effort: tunnel may not be active (user uninstalled
    // it, or seed marker says "previously removed"). The app boots either way.
    await applyProxy().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[electron-test] initial applyProxy skipped:', err.message);
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[QPJoy Tunnel NPM Test] startup failed:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (activeWatchInterval) clearInterval(activeWatchInterval);
  if (lastEventDispose) {
    try {
      lastEventDispose();
    } catch {
      /* ignore */
    }
  }
  await host?.close();
});
