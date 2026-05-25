/**
 * QPJoy Demo — minimal Electron app that embeds the marketplace host.
 *
 * What it does:
 *   1. Bootstraps `@qpjoy/electron-market`, seeding ONLY tunnel from the
 *      published npm package. This preserves the pre-HDO smoke-test app.
 *   2. Opens a main BrowserWindow with a landing page (`src/index.html`)
 *      that can run as client-only, or log in to a D backend and apply the
 *      returned managed tunnel config to the local plugin.
 *   3. Exposes a tiny host-app IPC surface that simulates another Electron
 *      client driving tunnel mode changes through the marketplace/plugin.
 *   4. Cleans up the host on app quit.
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
  console.error('Run `pnpm install` from electron-demo/tunnel/.\n');
  process.exit(1);
}

const TUNNEL_ID = 'qpjoy.electron-tunnel';
const MARKET_ADMIN_URL = 'http://127.0.0.1:23455';
const TUNNEL_ADMIN_URL = 'http://127.0.0.1:23456';
const VALID_TUNNEL_MODES = new Set(['app-rule', 'app-global', 'system-tun']);
let mainWindow = null;
let host = null;
let isClosing = false;

app.setAppUserModelId('dev.qpjoy.demo.tunnel');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/**
 * Where the tunnel package lives on disk. Same logical location in dev
 * (`electron-demo/tunnel/node_modules/...`) and packaged
 * (`<.app>/Contents/Resources/app/node_modules/...`) — `app.getAppPath()`
 * resolves both correctly with `asar: false`.
 */
function tunnelSeedDir() {
  if (process.env.QPJOY_TUNNEL_SOURCE) {
    return path.resolve(process.env.QPJOY_TUNNEL_SOURCE);
  }
  return path.join(app.getAppPath(), 'node_modules', '@qpjoy', 'electron-plugin-tunnel');
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function missingPackageDependencies(packageDir) {
  const realPackageDir = safeRealpath(packageDir);
  if (!realPackageDir) return ['<package>'];
  try {
    const pkgJson = path.join(realPackageDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const dependencies = Object.keys(pkg.dependencies || {});
    const missing = [];
    for (const dep of dependencies) {
      try {
        require.resolve(dep, { paths: [realPackageDir] });
      } catch {
        missing.push(dep);
      }
    }
    return missing;
  } catch {
    return ['<package.json>'];
  }
}

function pruneStaleSeedInstall(id, npm, expectedSourceDir) {
  const pluginsRoot = path.join(app.getPath('userData'), 'plugins');
  const expected = safeRealpath(expectedSourceDir);
  if (!fs.existsSync(pluginsRoot)) return;
  for (const name of fs.readdirSync(pluginsRoot)) {
    if (!name.startsWith(`${id}@`)) continue;
    const installPath = path.join(pluginsRoot, name);
    const installedPackageDir = path.join(installPath, 'node_modules', ...npm.split('/'));
    const missingDependencies = missingPackageDependencies(installedPackageDir);
    if (missingDependencies.length > 0) {
      fs.rmSync(installPath, { recursive: true, force: true });
      console.warn('[electron-demo] removed incomplete seed install:', {
        id,
        installPath,
        missingDependencies
      });
      continue;
    }
    const installed = safeRealpath(installedPackageDir);
    if (!expected) continue;
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
        state: 'active',
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
  refreshMarketplaceSelfRecord();
}

function normalizeBaseUrl(input) {
  const value = String(input ?? '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('请填写后端服务器 URL');
  if (!/^https?:\/\//i.test(value)) throw new Error('后端服务器 URL 必须以 http:// 或 https:// 开头');
  return value;
}

function normalizeMode(mode) {
  const value = String(mode ?? '').trim();
  if (!VALID_TUNNEL_MODES.has(value)) {
    throw new Error(`不支持的 tunnel 模式: ${value}`);
  }
  return value;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

async function readJsonResponse(res) {
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const detail = typeof body === 'object' && body ? (body.error || body.message) : body;
    throw new Error(detail ? `${res.status} ${res.statusText}: ${detail}` : `${res.status} ${res.statusText}`);
  }
  return body;
}

async function requestJson(url, init = {}) {
  const headers = {
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {})
  };
  const res = await fetch(url, { ...init, headers });
  return readJsonResponse(res);
}

function exposedTunnelApi() {
  if (!host || !host.runtime || typeof host.runtime.getExposed !== 'function') return null;
  return host.runtime.getExposed(TUNNEL_ID);
}

async function tunnelAdminLogin() {
  const body = await requestJson(`${TUNNEL_ADMIN_URL}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin' })
  });
  const token = body && typeof body.token === 'string' ? body.token : '';
  if (!token) throw new Error('Tunnel AdminServer 未返回登录 token');
  return token;
}

async function tunnelAdminRequest(pathname, token, init = {}) {
  return requestJson(`${TUNNEL_ADMIN_URL}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    }
  });
}

async function getTunnelSnapshotViaAdmin() {
  const token = await tunnelAdminLogin();
  return tunnelAdminRequest('/api/snapshot', token);
}

function toManagedTunnelConfig(config) {
  const account = config?.account ?? {};
  const policy = config?.policy ?? {};
  const rules = policy.rules ?? {};
  const subscriptionUrl = account.subscriptionUrl || account.subscription?.url;
  if (!subscriptionUrl) {
    throw new Error('后端没有返回 subscriptionUrl，请先在 D 后台给该用户发放 Tunnel');
  }
  return {
    subscription: {
      name: account.username ? `QPJoy ${account.username}` : 'QPJoy Managed Tunnel',
      url: subscriptionUrl
    },
    mode: normalizeMode(policy.runtimeMode ?? rules.runtimeMode ?? 'app-rule'),
    autoStart: rules.autoStart !== false,
    allowSystemTunPrivilege: false,
    autoUpdate: rules.autoUpdate !== false,
    rules: {
      allowlist: stringList(rules.allowlist),
      blocklist: stringList(rules.blocklist)
    },
    source: 'electron-demo'
  };
}

async function applyManagedConfigViaAdmin(managed) {
  const token = await tunnelAdminLogin();
  const snapshot = await tunnelAdminRequest('/api/snapshot', token);
  const subscriptions = Array.isArray(snapshot?.subscriptions) ? snapshot.subscriptions : [];
  let subscription = subscriptions.find((row) => row.url === managed.subscription.url)
    ?? subscriptions.find((row) => row.name === managed.subscription.name)
    ?? snapshot?.status?.activeSubscription
    ?? null;

  if (subscription?.id) {
    subscription = await tunnelAdminRequest(`/api/subscriptions/${subscription.id}`, token, {
      method: 'PUT',
      body: JSON.stringify(managed.subscription)
    });
  } else {
    subscription = await tunnelAdminRequest('/api/subscriptions', token, {
      method: 'POST',
      body: JSON.stringify(managed.subscription)
    });
  }

  if (subscription?.id && !subscription.active) {
    subscription = await tunnelAdminRequest(`/api/subscriptions/${subscription.id}/active`, token, {
      method: 'POST'
    });
  }

  const latest = await tunnelAdminRequest('/api/snapshot', token);
  const existingRules = Array.isArray(latest?.rules) ? latest.rules : [];
  for (const [kind, domains] of [
    ['block', managed.rules.blocklist],
    ['allow', managed.rules.allowlist]
  ]) {
    for (const domain of domains) {
      const exists = existingRules.some((rule) => rule.kind === kind && rule.domain === domain);
      if (!exists) {
        await tunnelAdminRequest('/api/rules', token, {
          method: 'POST',
          body: JSON.stringify({ kind, domain })
        });
      }
    }
  }

  if (managed.mode === 'system-tun') {
    await tunnelAdminRequest('/api/tun/install', token, { method: 'POST' });
  }
  await tunnelAdminRequest('/api/mode', token, {
    method: 'POST',
    body: JSON.stringify({ mode: managed.mode })
  });
  if (managed.autoStart && managed.mode !== 'system-tun') {
    await tunnelAdminRequest('/api/core/start', token, { method: 'POST' });
  }

  return {
    status: await tunnelAdminRequest('/api/snapshot', token),
    subscription,
    fallback: 'admin-http'
  };
}

async function applyManagedConfigToTunnel(config) {
  const managed = toManagedTunnelConfig(config);
  const api = exposedTunnelApi();
  if (api && typeof api.applyManagedConfig === 'function') {
    const result = await api.applyManagedConfig(managed);
    return { managed, result, fallback: null };
  }
  const result = await applyManagedConfigViaAdmin(managed);
  return { managed, result, fallback: 'admin-http' };
}

async function setTunnelMode(mode) {
  const nextMode = normalizeMode(mode);
  const api = exposedTunnelApi();
  if (api && typeof api.setMode === 'function') {
    if (nextMode === 'system-tun' && typeof api.installTun === 'function') {
      await api.installTun();
    }
    await api.setMode(nextMode);
    if (typeof api.applyProxy === 'function') await api.applyProxy();
    return typeof api.status === 'function' ? api.status() : { mode: nextMode };
  }

  const token = await tunnelAdminLogin();
  if (nextMode === 'system-tun') {
    await tunnelAdminRequest('/api/tun/install', token, { method: 'POST' });
  }
  await tunnelAdminRequest('/api/mode', token, {
    method: 'POST',
    body: JSON.stringify({ mode: nextMode })
  });
  return tunnelAdminRequest('/api/snapshot', token);
}

async function updateMarketServer(url) {
  const nextUrl = url ? normalizeBaseUrl(url) : null;
  return requestJson(`${MARKET_ADMIN_URL}/api/settings/market-server`, {
    method: 'PUT',
    body: JSON.stringify({ url: nextUrl })
  });
}

async function fetchMarketServerStatus() {
  return requestJson(`${MARKET_ADMIN_URL}/api/settings/market-server`);
}

async function fetchBackendTunnelConfig(input) {
  const baseUrl = normalizeBaseUrl(input?.serverUrl);
  const identifier = String(input?.identifier ?? '').trim();
  const password = String(input?.password ?? '');
  if (!identifier) throw new Error('请填写登录用户名或邮箱');
  if (!password) throw new Error('请填写登录密码');

  const auth = await requestJson(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ identifier, password })
  });
  const token = auth?.tokens?.accessToken ?? auth?.accessToken ?? auth?.token;
  if (!token) throw new Error('后端登录成功但没有返回 accessToken');

  const config = await requestJson(`${baseUrl}/api/v1/tunnel/me/config`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return { baseUrl, token, user: auth?.user ?? null, config };
}

async function demoStatus() {
  const api = exposedTunnelApi();
  let tunnel = null;
  if (api && typeof api.status === 'function') {
    tunnel = await api.status();
  } else {
    try {
      const snapshot = await getTunnelSnapshotViaAdmin();
      tunnel = snapshot?.status ?? null;
    } catch {
      tunnel = null;
    }
  }

  let marketServer = null;
  try {
    marketServer = await fetchMarketServerStatus();
  } catch {
    marketServer = null;
  }

  return {
    marketAdminUrl: MARKET_ADMIN_URL,
    tunnelAdminUrl: TUNNEL_ADMIN_URL,
    tunnelAvailable: Boolean(tunnel),
    tunnel,
    marketServer
  };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0d111a',
    title: 'QPJoy Tunnel Demo',
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
            }
          ]
        }
      );

      await host.ready;
      if (!app.isPackaged && process.env.QPJOY_DEMO_RESEED_TUNNEL !== '0' && typeof host.reseed === 'function') {
        await host.reseed(TUNNEL_ID).catch((err) => {
          console.warn('[electron-demo] dev reseed tunnel failed:', err);
        });
      }

      // Lightweight renderer-facing IPC: lets the landing page open the
      // marketplace in this window OR a new window.
      ipcMain.handle('demo:open-market', (_e, mode) => {
        const url = MARKET_ADMIN_URL;
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

      ipcMain.handle('demo:status', () => demoStatus());

      ipcMain.handle('demo:set-market-server', (_e, input) => updateMarketServer(input?.serverUrl));

      ipcMain.handle('demo:apply-backend-config', async (_e, input) => {
        const backend = await fetchBackendTunnelConfig(input);
        const applied = await applyManagedConfigToTunnel(backend.config);
        let marketServer = null;
        try {
          marketServer = await updateMarketServer(backend.baseUrl);
        } catch (err) {
          marketServer = { ok: false, warning: err instanceof Error ? err.message : String(err) };
        }
        return {
          baseUrl: backend.baseUrl,
          user: backend.user,
          account: backend.config?.account ?? null,
          policy: backend.config?.policy ?? null,
          applied,
          marketServer
        };
      });

      ipcMain.handle('demo:set-tunnel-mode', (_e, mode) => setTunnelMode(mode));

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
