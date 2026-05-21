/**
 * QPJoy Demo — minimal Electron app that embeds the marketplace host.
 *
 * What it does:
 *   1. Bootstraps `@qpjoy/electron-market`, seeding published tunnel plus the
 *      current local HDO plugin. NotYet and any other plugin installs via the
 *      marketplace UI like a real user.
 *   2. Opens a main BrowserWindow with a landing page (`src/index.html`)
 *      that has a single button → opens the marketplace admin panel at
 *      `http://127.0.0.1:23455` either in this same window (default) or
 *      a new window if the user prefers.
 *   3. Cleans up the host on app quit.
 *
 * Offline-friendly by design:
 *   - Marketplace server URL defaults to null in packaged builds (0.2.1+).
 *     Bundled seed-index drives the catalogue; sync is opt-in via the
 *     SettingsPage in the SPA.
 *   - Failing seeds / failing sync are logged into marketplace.db but
 *     never block startup.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');

let createElectronMarket;
try {
  ({ createElectronMarket } = require('@qpjoy/electron-market'));
} catch (err) {
  console.error('\n[electron-demo] failed to require @qpjoy/electron-market:');
  console.error(`  ${err.message}\n`);
  console.error('Run `pnpm install` from electron-demo/hdo/.\n');
  process.exit(1);
}

const TUNNEL_ID = 'qpjoy.electron-tunnel';
const HDO_ID = 'qpjoy.electron-plugin-hdo';

let mainWindow = null;
let host = null;
let isClosing = false;

app.setAppUserModelId('dev.qpjoy.demo.hdo');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/**
 * Where the tunnel package lives on disk. Same logical location in dev
 * (`electron-demo/hdo/node_modules/...`) and packaged
 * (`<.app>/Contents/Resources/app/node_modules/...`) — `app.getAppPath()`
 * resolves both correctly with `asar: false`.
 */
function tunnelSeedDir() {
  if (process.env.QPJOY_TUNNEL_SOURCE) {
    return path.resolve(process.env.QPJOY_TUNNEL_SOURCE);
  }
  return path.join(app.getAppPath(), 'node_modules', '@qpjoy', 'electron-plugin-tunnel');
}

function hdoSeedDir() {
  if (process.env.QPJOY_HDO_SOURCE) {
    return path.resolve(process.env.QPJOY_HDO_SOURCE);
  }
  const workspaceDir = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'electron-plugin',
    'packages',
    'electron-plugin-hdo'
  );
  try {
    if (!app.isPackaged && require('node:fs').existsSync(path.join(workspaceDir, 'package.json'))) {
      return workspaceDir;
    }
  } catch {
    // fall back to the installed package below
  }
  return path.join(app.getAppPath(), 'node_modules', '@qpjoy', 'electron-plugin-hdo');
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function pruneStaleSeedInstall(id, npm, expectedSourceDir) {
  const pluginsRoot = path.join(app.getPath('userData'), 'plugins');
  const expected = safeRealpath(expectedSourceDir);
  if (!expected || !fs.existsSync(pluginsRoot)) return;
  for (const name of fs.readdirSync(pluginsRoot)) {
    if (!name.startsWith(`${id}@`)) continue;
    const installPath = path.join(pluginsRoot, name);
    const installedPackageDir = path.join(installPath, 'node_modules', ...npm.split('/'));
    const installed = safeRealpath(installedPackageDir);
    if (!installed || installed === expected) continue;
    const installRoot = safeRealpath(installPath);
    const ownedCopy = installRoot && (installed === installRoot || installed.startsWith(installRoot + path.sep));
    if (ownedCopy) continue;
    fs.rmSync(installPath, { recursive: true, force: true });
    console.warn('[electron-demo] removed stale seed install:', {
      id,
      installPath,
      installed,
      expected
    });
  }
}

function refreshMarketplaceSelfRecord() {
  try {
    const { MarketplaceDB, resolveMarketplaceDbPath } = require('@qpjoy/marketplace-db');
    const db = MarketplaceDB.open(resolveMarketplaceDbPath(app.getPath('userData')));
    try {
      const marketPkgPath = require.resolve('@qpjoy/electron-market/package.json');
      const marketRoot = path.dirname(marketPkgPath);
      const pkg = JSON.parse(fs.readFileSync(marketPkgPath, 'utf8'));
      const manifestPath = path.join(marketRoot, 'dist', 'plugin.manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.version = pkg.version || manifest.version;
      manifest.activationEvents = [];
      db.bulkUpsertEntries([
        {
          id: manifest.id,
          npm: pkg.name || '@qpjoy/electron-market',
          name: manifest.name,
          description: manifest.description || null,
          latestVersion: manifest.version,
          manifestUrl: null,
          tarballUrl: null,
          homepage: manifest.homepage || pkg.homepage || null,
          author: manifest.author || null,
          category: 'host',
          verified: true,
          bootstrap: true,
          visibility: 'public',
          specVersion: 1,
          metadata: { self: true },
          source: 'seed',
          fetchedAt: null
        }
      ]);
      db.upsertInstalled({
        id: manifest.id,
        npm: pkg.name || '@qpjoy/electron-market',
        version: manifest.version,
        installPath: app.getAppPath(),
        installSource: 'standalone',
        manifest,
        grantedPermissions: manifest.permissions || [],
        state: 'installed',
        errorMessage: null,
        marketplaceEntryId: manifest.id
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[electron-demo] failed to refresh marketplace self record:', err);
  }
}

function preparePackagedSeeds() {
  pruneStaleSeedInstall(TUNNEL_ID, '@qpjoy/electron-plugin-tunnel', tunnelSeedDir());
  pruneStaleSeedInstall(HDO_ID, '@qpjoy/electron-plugin-hdo', hdoSeedDir());
  refreshMarketplaceSelfRecord();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0d111a',
    title: 'QPJoy HDO Demo',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // External links via host.openExternal — kept here for any landing-page
  // anchor that wants to open in the system browser instead of a new
  // Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

async function closeAppResources() {
  if (!host) return;
  const current = host;
  host = null;
  await current.close();
}

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (app.isReady()) createMainWindow();
  });

  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      preparePackagedSeeds();

      host = createElectronMarket(
        { app, ipcMain, session: session.defaultSession },
        {
          adminPort: 23455,
          // Sync runs every 10 min once a server URL is configured. In a
          // fresh demo build the host runs offline and the SettingsPage lets
          // the user point at their own server (local docker, prod, …).
          syncIntervalMs: 600_000,
          seedPlugins: [
            {
              id: TUNNEL_ID,
              npm: '@qpjoy/electron-plugin-tunnel',
              source: { type: 'local-dir', path: tunnelSeedDir() },
              autoGrant: 'manifest'
            },
            {
              id: HDO_ID,
              npm: '@qpjoy/electron-plugin-hdo',
              source: { type: 'local-dir', path: hdoSeedDir() },
              autoGrant: 'manifest'
            }
          ]
        }
      );

      await host.ready;

      // Lightweight renderer-facing IPC: lets the landing page open the
      // marketplace in this window OR a new window.
      ipcMain.handle('demo:open-market', (_e, mode) => {
        const url = 'http://127.0.0.1:23455';
        if (mode === 'new-window') {
          const w = new BrowserWindow({
            width: 1100, height: 760, backgroundColor: '#f3f5f7',
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, sandbox: true }
          });
          void w.loadURL(url);
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          void mainWindow.loadURL(url);
        }
      });

      ipcMain.handle('demo:go-home', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          void mainWindow.loadFile(path.join(__dirname, 'index.html'));
        }
      });

      createMainWindow();
    })
    .catch((err) => {
      console.error('[electron-demo] startup failed:', err);
      app.exit(1);
    });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!gotSingleInstanceLock) return;
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', async (event) => {
  if (isClosing) return;
  isClosing = true;
  event.preventDefault();
  try {
    await closeAppResources();
  } catch (err) {
    console.warn('[electron-demo] host close error:', err);
  } finally {
    app.exit(0);
  }
});
