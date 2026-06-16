/**
 * MX HDO desktop client that embeds the marketplace host.
 *
 * What it does:
 *   1. Bootstraps `@qpjoy/electron-market`, seeding published tunnel plus the
 *      current local HDO plugin. NotYet and any other plugin installs via the
 *      marketplace UI like a real user.
 *   2. Opens a main BrowserWindow with a simple HDO connection page.
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
const { execFile } = require('node:child_process');
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const { loadProjectEnv } = require('./env.cjs');
const { createSystemDomainProxyManager } = require('./systemDomainProxy.cjs');

loadProjectEnv({ appDir: path.resolve(__dirname, '..') });

let createElectronMarket;
try {
  ({ createElectronMarket } = require('@qpjoy/electron-market'));
} catch (err) {
  console.error('\n[hdo] failed to require @qpjoy/electron-market:');
  console.error(`  ${err.message}\n`);
  console.error('Run `pnpm install` from electron-demo/hdo/.\n');
  process.exit(1);
}

const TUNNEL_ID = 'qpjoy.electron-tunnel';
const HDO_ID = 'qpjoy.electron-plugin-hdo';
const UPDATE_RESTART_REQUIRED_META = 'updates.restartRequired';
const FAST_RELAY_MODE = 'mesh-h2i';
const CLIENT_SETTINGS_FILE = 'hdo-client-settings.json';
const DEFAULT_SYSTEM_PAC_ENABLED = true;

let mainWindow = null;
let host = null;
let electronLauncherModulePromise = null;
let isClosing = false;
let hdoEventUnsubscribe = null;
let systemDomainProxy = null;
let systemDomainProxyApplyInFlight = null;
let systemPacEnabled = DEFAULT_SYSTEM_PAC_ENABLED;
const childWindows = new Set();

app.setAppUserModelId('dev.qpjoy.hdo');

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

function missingHdoSeedRuntimeFiles(packageDir) {
  if (process.platform !== 'win32') return [];
  const required = [
    path.join('resources', 'wireguard', 'win32-x64', 'wireguard.exe'),
    path.join('resources', 'wireguard', 'win32-x64', 'wg.exe'),
    path.join('dist', 'vendor', 'electron-core-wireguard', 'dist', 'index.js')
  ];
  const missing = required.filter((relative) => !fs.existsSync(path.join(packageDir, relative)));
  const corePath = path.join(packageDir, 'dist', 'vendor', 'electron-core-wireguard', 'dist', 'index.js');
  if (fs.existsSync(corePath)) {
    try {
      const core = fs.readFileSync(corePath, 'utf8');
      if (!core.includes('-Verb RunAs')) missing.push('dist/vendor/electron-core-wireguard/dist/index.js:<uac-script>');
    } catch {
      missing.push('dist/vendor/electron-core-wireguard/dist/index.js:<readable>');
    }
  }
  return missing;
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
      console.warn('[hdo] removed incomplete seed install:', {
        id,
        installPath,
        missingDependencies
      });
      continue;
    }
    const installed = safeRealpath(installedPackageDir);
    const missingRuntimeFiles = id === HDO_ID ? missingHdoSeedRuntimeFiles(installedPackageDir) : [];
    if (missingRuntimeFiles.length > 0) {
      fs.rmSync(installPath, { recursive: true, force: true });
      console.warn('[hdo] removed HDO seed install with missing runtime files:', {
        id,
        installPath,
        missingRuntimeFiles
      });
      continue;
    }
    if (!expected) continue;
    if (!installed || installed === expected) continue;
    const installRoot = safeRealpath(installPath);
    const ownedCopy = installRoot && (installed === installRoot || installed.startsWith(installRoot + path.sep));
    if (ownedCopy) continue;
    fs.rmSync(installPath, { recursive: true, force: true });
    console.warn('[hdo] removed stale seed install:', {
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
    console.warn('[hdo] failed to refresh marketplace self record:', err);
  }
}

function preparePackagedSeeds() {
  pruneStaleSeedInstall(TUNNEL_ID, '@qpjoy/electron-plugin-tunnel', tunnelSeedDir());
  pruneStaleSeedInstall(HDO_ID, '@qpjoy/electron-plugin-hdo', hdoSeedDir());
  refreshMarketplaceSelfRecord();
}

function readJsonMeta(key) {
  try {
    const raw = host?.registry?.marketplaceDb().getMeta(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#f5f7fb',
    title: 'MX HDO',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow.once('closed', () => {
    mainWindow = null;
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

function trackChildWindow(window) {
  childWindows.add(window);
  window.once('closed', () => {
    childWindows.delete(window);
  });
  return window;
}

async function hdoExposed() {
  if (!host) throw new Error('market host is not ready');
  await host.ready;
  let exposed = host.runtime.getExposed(HDO_ID);
  if (!exposed) {
    await host.runtime.activate(HDO_ID);
    exposed = host.runtime.getExposed(HDO_ID);
  }
  if (!exposed) throw new Error('HDO plugin is not active');
  ensureHdoEventSubscription(exposed);
  return exposed;
}

async function hdoCall(method, ...args) {
  const exposed = await hdoExposed();
  const fn = exposed[method];
  if (typeof fn !== 'function') throw new Error(`HDO plugin did not expose ${method}`);
  return fn(...args);
}

function systemDomainProxyStatus() {
  if (!systemDomainProxy) {
    return {
      supported: false,
      applied: false,
      platform: process.platform,
      enabled: systemPacEnabled,
      reason: 'system-domain-proxy-not-ready'
    };
  }
  return {
    ...systemDomainProxy.status(),
    enabled: systemPacEnabled
  };
}

async function verifiedSystemDomainProxyStatus() {
  if (!systemDomainProxy) return systemDomainProxyStatus();
  if (typeof systemDomainProxy.statusVerified !== 'function') return systemDomainProxyStatus();
  return {
    ...await systemDomainProxy.statusVerified(),
    enabled: systemPacEnabled
  };
}

function shouldEnsureSystemDomainProxy(snapshot, current = systemDomainProxyStatus()) {
  if (systemPacEnabled !== true) return false;
  if (!snapshot?.wireGuardStatus || snapshot.wireGuardStatus.active !== true) return false;
  const configured = snapshot.settings && snapshot.settings.domainProxy;
  if (
    current.applied === true &&
    configured &&
    typeof configured === 'object' &&
    typeof configured.pacUrl === 'string' &&
    current.pacUrl === configured.pacUrl
  ) {
    return false;
  }
  return true;
}

async function probeHdoNetwork(snapshot) {
  if (!snapshot?.wireGuardStatus || snapshot.wireGuardStatus.active !== true) {
    return { ok: false, skipped: true, reason: 'wireguard-inactive' };
  }
  const manifest = snapshot.settings && snapshot.settings.lastManifest;
  const domestic = manifest && manifest.wireGuard && manifest.wireGuard.domestic;
  const target = typeof domestic?.overlayIp === 'string' && domestic.overlayIp
    ? domestic.overlayIp
    : '100.88.0.1';
  try {
    const result = await pingHost(target, 2200, 3);
    return {
      ok: true,
      target,
      method: 'ping',
      stdout: result.stdout.trim()
    };
  } catch (err) {
    return {
      ok: false,
      target,
      method: 'ping',
      error: err instanceof Error ? err.message : String(err),
      stdout: typeof err.stdout === 'string' ? err.stdout.trim() : '',
      stderr: typeof err.stderr === 'string' ? err.stderr.trim() : ''
    };
  }
}

function pingHost(host, timeoutMs, count = 1) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'ping.exe' : '/sbin/ping';
  const args = platform === 'win32'
    ? ['-n', String(count), '-w', String(timeoutMs), host]
    : (platform === 'darwin'
        ? ['-c', String(count), '-W', String(timeoutMs), host]
        : ['-c', String(count), '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]);
  return execFileText(command, args, (timeoutMs + 500) * count);
}

function execFileText(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function electronLauncherModule() {
  if (!electronLauncherModulePromise) {
    electronLauncherModulePromise = import('@qpjoy/electron-launcher');
  }
  return electronLauncherModulePromise;
}

function h2oLauncherProduct(launcherModule) {
  return launcherModule.defineLauncherProduct({
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
}

async function launcherRoutePlanProbe(rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const baseUrl = typeof payload.serverUrl === 'string' && payload.serverUrl.trim()
    ? payload.serverUrl.trim().replace(/\/+$/, '')
    : defaultHdoServerUrl();
  if (!baseUrl) {
    return {
      ok: false,
      skipped: true,
      reason: 'launcher-server-url-missing'
    };
  }
  try {
    const launcherModule = await electronLauncherModule();
    const product = h2oLauncherProduct(launcherModule);
    const launcher = launcherModule.createElectronLauncher({
      baseUrl,
      productId: typeof payload.productId === 'string' && payload.productId.trim() ? payload.productId.trim() : product.productId,
      mode: product.mode,
      installId: typeof payload.installId === 'string' ? payload.installId : undefined,
      deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : undefined,
      siteId: typeof payload.siteId === 'string' ? payload.siteId : undefined,
      publicKey: typeof payload.publicKey === 'string' ? payload.publicKey : undefined,
      fetchImpl: timeoutFetch(2500)
    });
    const userId = typeof payload.userId === 'string' && payload.userId.trim() ? payload.userId.trim() : null;
    const session = typeof launcher.connectNetwork === 'function'
      ? await launcher.connectNetwork({
          userId,
          identityKind: userId ? 'user' : 'anonymous',
          deviceLabel: 'HDO Demo',
          requestId: `hdo-demo-launcher-connect-${Date.now()}`
        })
      : null;
    const routePlan = session?.routePlan || await launcher.createRoutePlan({
      userId: typeof payload.userId === 'string' ? payload.userId : null,
      requestId: `hdo-demo-launcher-plan-${Date.now()}`
    });
    let launcherWireGuardPeer = null;
    if (session) {
      try {
        launcherWireGuardPeer = await hdoCall('prepareLauncherNetworkPeer', { session });
      } catch (err) {
        launcherWireGuardPeer = {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
    return {
      ok: true,
      product,
      networkSession: session ? publicLauncherNetworkSession(session) : null,
      launcherWireGuardPeer: publicLauncherWireGuardPeerPrepare(launcherWireGuardPeer),
      routePlan: publicLauncherRoutePlan(routePlan)
    };
  } catch (err) {
    return {
      ok: false,
      baseUrl,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function timeoutFetch(timeoutMs) {
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function publicLauncherRoutePlan(routePlan) {
  return {
    productId: routePlan.productId,
    launcherMode: routePlan.launcherMode,
    identityKind: routePlan.identityKind,
    leaseIp: routePlan.leaseIp,
    serviceVip: routePlan.serviceVip,
    internalControlIp: routePlan.internalControlIp,
    domesticGatewayIp: routePlan.domesticGatewayIp,
    domesticRelayEndpoint: routePlan.domesticRelayEndpoint || null,
    domesticRelayPublicKeyReady: Boolean(routePlan.domesticRelayPublicKey),
    domesticSiteId: routePlan.domesticSiteId,
    overseaSiteId: routePlan.overseaSiteId,
    dnsServer: routePlan.dnsServer,
    routeCidrs: routePlan.routeCidrs,
    updatePolicy: routePlan.updatePolicy,
    rateLimitProfile: routePlan.rateLimitProfile,
    dnsPolicyId: routePlan.dnsPolicyId,
    licensePolicyId: routePlan.licensePolicyId,
    snapshotId: routePlan.snapshotId,
    refreshKey: routePlan.refreshKey
  };
}

function publicLauncherWireGuardPeerPrepare(result) {
  const row = objectValue(result);
  if (!row) return null;
  const peer = objectValue(row.peer);
  return {
    ok: row.ok === true,
    message: typeof row.message === 'string' ? row.message : null,
    error: typeof row.error === 'string' ? row.error : null,
    launcherNetwork: objectValue(row.launcherNetwork),
    routeProbe: objectValue(row.routeProbe),
    peer: peer ? {
      publicKey: typeof peer.publicKey === 'string' ? peer.publicKey : null,
      overlayIp: typeof peer.overlayIp === 'string' ? peer.overlayIp : null,
      address: typeof peer.address === 'string' ? peer.address : null,
      allowedIps: Array.isArray(peer.allowedIps) ? peer.allowedIps : null,
      dns: Array.isArray(peer.dns) ? peer.dns : null,
      dnsDomains: Array.isArray(peer.dnsDomains) ? peer.dnsDomains : null,
      domesticRelayEndpoint: typeof peer.domesticRelayEndpoint === 'string' ? peer.domesticRelayEndpoint : null,
      domesticRelayPublicKeyReady: Boolean(peer.domesticRelayPublicKey),
      configReady: Boolean(peer.configPath),
      canUseDefaultMesh: peer.canUseDefaultMesh === true,
      lastError: typeof peer.lastError === 'string' ? peer.lastError : null,
      updatedAt: typeof peer.updatedAt === 'string' ? peer.updatedAt : null
    } : null
  };
}

async function connectH2oLauncherNetwork(rawPayload, identityKind) {
  const payload = objectValue(rawPayload) || {};
  const baseUrl = typeof payload.serverUrl === 'string' && payload.serverUrl.trim()
    ? payload.serverUrl.trim().replace(/\/+$/, '')
    : defaultHdoServerUrl();
  if (!baseUrl) {
    return {
      ok: false,
      source: 'launcher-network',
      mode: identityKind === 'user' ? 'account' : 'anonymous',
      reason: 'launcher-server-url-missing',
      message: 'Launcher server URL is missing.'
    };
  }

  let auth = null;
  if (identityKind === 'user') {
    const identifier = stringValue(payload.identifier);
    const password = stringValue(payload.password);
    if (identifier || password) {
      if (!identifier || !password) throw new Error('账号和密码必须一起填写，或先在插件市场登录');
      auth = await hdoCall('login', { serverUrl: baseUrl, identifier, password });
    }
  }

  const snapshot = await hdoCall('snapshot').catch(() => null);
  const settings = objectValue(snapshot?.settings) || {};
  const anonymous = objectValue(settings.anonymous) || {};
  const peer = objectValue(settings.wireGuardPeer) || {};
  const session = objectValue(snapshot?.session) || {};
  const user = objectValue(auth?.user) || objectValue(session.user) || {};
  const installId =
    stringValue(payload.installId) ||
    stringValue(anonymous.installId) ||
    stringValue(settings.installId) ||
    stringValue(settings.deviceId) ||
    `hdo-demo-${randomUUID()}`;
  const deviceId =
    stringValue(payload.deviceId) ||
    stringValue(settings.deviceId) ||
    `hdo-device-${installId}`;
  const userId = identityKind === 'user'
    ? stringValue(payload.userId) || stringValue(user.id) || stringValue(user.userId) || stringValue(settings.sessionUserId)
    : null;
  const launcherModule = await electronLauncherModule();
  const product = h2oLauncherProduct(launcherModule);
  const launcher = launcherModule.createElectronLauncher({
    baseUrl,
    productId: product.productId,
    mode: product.mode,
    installId,
    deviceId,
    siteId: stringValue(payload.siteId) || stringValue(settings.siteId) || undefined,
    privateKey: stringValue(peer.privateKey) || undefined,
    fetchImpl: timeoutFetch(5000)
  });
  const networkSession = await launcher.connectNetwork({
    identityKind,
    userId,
    deviceLabel: identityKind === 'user' ? 'MX HDO Account' : 'MX HDO Anonymous',
    platform: process.platform,
    requestId: `hdo-demo-launcher-${identityKind}-${Date.now()}`
  });
  const prepared = await hdoCall('prepareLauncherNetworkPeer', {
    session: networkSession,
    deviceLabel: 'MX HDO',
    platform: process.platform
  });
  const preparedPublic = publicLauncherWireGuardPeerPrepare(prepared);
  let connected = null;
  let latestSnapshot = null;
  if (prepared && typeof prepared === 'object' && prepared.ok === true && payload.autoConnect !== false) {
    connected = await hdoCall('connectWireGuardPeer', {
      action: 'restart',
      skipIfActive: false,
      fallbackToAppManaged: false,
      skipDnsRepair: systemPacEnabled === true
    }).catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }));
    latestSnapshot = await hdoCall('snapshot').catch(() => null);
  }
  return {
    ok: preparedPublic?.ok === true,
    source: 'launcher-network',
    mode: identityKind === 'user' ? 'account' : 'anonymous',
    message: preparedPublic?.ok === true
      ? '已通过 Launcher Network 准备 H2O WireGuard 配置。'
      : preparedPublic?.message || preparedPublic?.error || 'Launcher Network 配置生成失败。',
    auth,
    networkSession: publicLauncherNetworkSession(networkSession),
    routePlan: publicLauncherRoutePlan(networkSession.routePlan),
    prepared: preparedPublic,
    connected,
    wireGuardStatus: latestSnapshot?.wireGuardStatus || null,
    peer: preparedPublic?.peer || null,
    domainProxy: null
  };
}

async function connectH2oWithLauncherFallback(rawPayload, identityKind, legacyConnect) {
  const launcherResult = await connectH2oLauncherNetwork(rawPayload, identityKind).catch((err) => ({
    ok: false,
    source: 'launcher-network',
    mode: identityKind === 'user' ? 'account' : 'anonymous',
    error: err instanceof Error ? err.message : String(err)
  }));
  if (launcherResult.ok === true || launcherResult.connected) return launcherResult;
  const launcherNetworkAttempt = await rememberLauncherNetworkAttempt(launcherResult);
  const legacyResult = await legacyConnect();
  return {
    ...legacyResult,
    source: 'legacy-hdo-manifest',
    launcherNetworkAttempt
  };
}

async function rememberLauncherNetworkAttempt(result) {
  const attempt = publicLauncherNetworkAttempt(result);
  if (!attempt) return null;
  const next = {
    ...attempt,
    fallback: 'legacy-hdo-manifest',
    updatedAt: new Date().toISOString()
  };
  await hdoCall('updateSettings', { lastLauncherNetworkAttempt: next }).catch(() => null);
  return next;
}

function publicLauncherNetworkAttempt(result) {
  const row = objectValue(result);
  if (!row) return null;
  return {
    ok: row.ok === true,
    source: stringValue(row.source),
    mode: stringValue(row.mode),
    reason: stringValue(row.reason),
    message: stringValue(row.message),
    error: stringValue(row.error),
    prepared: publicLauncherWireGuardPeerPrepare(row.prepared) || objectValue(row.prepared),
    routePlan: objectValue(row.routePlan),
    updatedAt: stringValue(row.updatedAt)
  };
}

function publicLauncherNetworkSession(session) {
  return {
    wireGuard: {
      publicKey: session.wireGuard?.publicKey || null,
      privateKeyReady: Boolean(session.wireGuard?.privateKey),
      source: session.wireGuard?.source || null
    },
    lease: session.lease ? {
      leaseId: session.lease.leaseId,
      productId: session.lease.productId,
      launcherMode: session.lease.launcherMode,
      identityKind: session.lease.identityKind,
      leaseIp: session.lease.leaseIp,
      serviceVip: session.lease.serviceVip,
      internalControlIp: session.lease.internalControlIp,
      domesticGatewayIp: session.lease.domesticGatewayIp,
      domesticSiteId: session.lease.domesticSiteId,
      status: session.lease.status
    } : null,
    routePlan: publicLauncherRoutePlan(session.routePlan)
  };
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAnonymousHdoSnapshot(snapshot) {
  const settings = snapshot?.settings || {};
  const peer = settings.wireGuardPeer || {};
  if (peer.launcherNetwork && peer.launcherNetwork.identityKind === 'anonymous') return true;
  if (settings.anonymous && settings.anonymous.mode === 'anonymous') return true;
  if (String(settings.deviceId || '').startsWith('hdo-anon-')) return true;
  return String(peer.overlayIp || '').startsWith('100.91.');
}

async function accountNetworkSwitchHint() {
  const snapshot = await hdoCall('snapshot').catch(() => null);
  return {
    fromAnonymous: isAnonymousHdoSnapshot(snapshot),
    privilegedPreStop: false,
    reason: 'account-connect-restarts-wireguard'
  };
}

async function anonymousNetworkSwitchHint() {
  const snapshot = await hdoCall('snapshot').catch(() => null);
  const settings = snapshot?.settings || {};
  const peer = settings.wireGuardPeer || {};
  return {
    fromAccount: Boolean(peer.overlayIp) && !isAnonymousHdoSnapshot(snapshot),
    privilegedPreStop: false,
    reason: 'anonymous-connect-restarts-wireguard'
  };
}

async function safelyApplySystemDomainProxy(domainProxy, reason = 'manual') {
  if (!systemDomainProxy) return systemDomainProxyStatus();
  if (isClosing) {
    return {
      supported: process.platform === 'darwin' || process.platform === 'win32',
      applied: false,
      platform: process.platform,
      enabled: systemPacEnabled,
      reason: 'app-closing',
      skipped: true
    };
  }
  if (systemPacEnabled !== true) {
    const disabled = await systemDomainProxy.disable('system-pac-disabled').catch((err) => ({
      supported: process.platform === 'darwin' || process.platform === 'win32',
      applied: false,
      platform: process.platform,
      reason: 'system-pac-disabled',
      error: err instanceof Error ? err.message : String(err)
    }));
    return {
      ...disabled,
      enabled: false,
      skipped: true
    };
  }
  try {
    const applied = await systemDomainProxy.apply(domainProxy);
    const dnsPriority = applied.applied === true
      ? await ensureHdoDnsPriority(`system-domain-proxy-${reason}`)
      : null;
    return {
      ...applied,
      dnsPriority,
      enabled: true
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('[hdo] failed to apply system domain proxy:', { reason, error });
    return {
      supported: process.platform === 'darwin' || process.platform === 'win32',
      applied: false,
      platform: process.platform,
      enabled: systemPacEnabled,
      reason,
      error
    };
  }
}

async function ensureHdoDnsPriority(reason = 'manual') {
  if (process.platform !== 'win32' || isClosing) {
    return {
      ok: true,
      skipped: true,
      reason: process.platform !== 'win32' ? 'non-windows-platform' : 'app-closing'
    };
  }
  try {
    return await hdoCall('ensureWireGuardDnsPriority');
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('[hdo] failed to ensure DNS priority:', { reason, error });
    return {
      ok: false,
      reason,
      error
    };
  }
}

async function safelyDisableSystemDomainProxy(reason = 'manual') {
  if (!systemDomainProxy) return systemDomainProxyStatus();
  try {
    const inFlight = systemDomainProxyApplyInFlight;
    if (inFlight) await inFlight.catch(() => undefined);
    return {
      ...await systemDomainProxy.disable(reason),
      enabled: systemPacEnabled
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('[hdo] failed to disable system domain proxy:', { reason, error });
    return {
      supported: process.platform === 'darwin' || process.platform === 'win32',
      applied: true,
      platform: process.platform,
      enabled: systemPacEnabled,
      reason,
      error
    };
  }
}

async function ensureSystemDomainProxyFromManifest(reason = 'status') {
  if (systemDomainProxyApplyInFlight) return systemDomainProxyApplyInFlight;
  systemDomainProxyApplyInFlight = (async () => {
    const domainProxy = await hdoCall('applyDomainProxyFromManifest');
    const system = await safelyApplySystemDomainProxy(domainProxy, reason);
    return { domainProxy, systemDomainProxy: system };
  })().finally(() => {
    systemDomainProxyApplyInFlight = null;
  });
  return systemDomainProxyApplyInFlight;
}

function ensureHdoEventSubscription(exposed) {
  if (hdoEventUnsubscribe || !exposed || typeof exposed.onEvent !== 'function') return;
  hdoEventUnsubscribe = exposed.onEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('demo:hdo-event', event);
    }
    for (const window of childWindows) {
      if (!window.isDestroyed()) window.webContents.send('demo:hdo-event', event);
    }
  });
}

function defaultHdoServerUrl() {
  return (
    process.env.QPJOY_HDO_SERVER ||
    process.env.QPJOY_DEMO_HDO_SERVER ||
    process.env.QPJOY_MARKET_SERVER ||
    packagedServerBaseUrl() ||
    ''
  );
}

function packagedServerBaseUrl() {
  try {
    const configPath = path.join(app.getAppPath(), 'qpjoy-hdo.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const value = typeof config.serverBaseUrl === 'string' ? config.serverBaseUrl.trim() : '';
    return value ? value.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

function clientSettingsPath() {
  return path.join(app.getPath('userData'), CLIENT_SETTINGS_FILE);
}

function readClientSettings() {
  try {
    return JSON.parse(fs.readFileSync(clientSettingsPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function readSystemPacEnabled() {
  const settings = readClientSettings();
  return typeof settings.systemPacEnabled === 'boolean'
    ? settings.systemPacEnabled
    : DEFAULT_SYSTEM_PAC_ENABLED;
}

function writeClientSettings(patch) {
  const next = {
    ...readClientSettings(),
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(clientSettingsPath()), { recursive: true });
  fs.writeFileSync(clientSettingsPath(), JSON.stringify(next, null, 2));
  return next;
}

function normalizeTestUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error('URL is required');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are supported');
  }
  return parsed.toString();
}

async function closeAppResources() {
  if (hdoEventUnsubscribe) {
    hdoEventUnsubscribe();
    hdoEventUnsubscribe = null;
  }
  try {
    if (host) {
      const current = host;
      try {
        await current.close();
      } finally {
        if (host === current) host = null;
      }
    }
  } finally {
    await safelyDisableSystemDomainProxy('app-quit-after-host-close');
  }
}

async function quitGracefully(exitCode = 0) {
  if (isClosing) return;
  isClosing = true;
  try {
    await closeAppResources();
  } catch (err) {
    console.warn('[hdo] host close error:', err);
  } finally {
    app.exit(exitCode);
  }
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
      systemDomainProxy = createSystemDomainProxyManager({
        userDataDir: app.getPath('userData'),
        log: console
      });
      systemPacEnabled = readSystemPacEnabled();
      await systemDomainProxy.restoreStale?.('app-startup').catch((err) => {
        console.warn('[hdo] failed to restore stale system domain proxy:', err);
      });

      host = createElectronMarket(
        { app, ipcMain, session: session.defaultSession },
        {
          adminPort: 23455,
          serverBaseUrl: defaultHdoServerUrl() || null,
          // Sync runs every 10 min once a server URL is configured. In a
          // fresh packaged build the host runs offline and the SettingsPage lets
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
          const w = trackChildWindow(new BrowserWindow({
            width: 1100, height: 760, backgroundColor: '#f3f5f7',
            autoHideMenuBar: true,
            webPreferences: { contextIsolation: true, sandbox: true }
          }));
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

      ipcMain.handle('demo:hdo-status', async () => {
        const snapshot = await hdoCall('snapshot');
        let systemDomainProxyState = await verifiedSystemDomainProxyStatus();
        if (shouldEnsureSystemDomainProxy(snapshot, systemDomainProxyState)) {
          try {
            const ensured = await ensureSystemDomainProxyFromManifest('wireguard-active');
            systemDomainProxyState = ensured.systemDomainProxy || await verifiedSystemDomainProxyStatus();
          } catch (err) {
            console.warn('[hdo] failed to ensure system domain proxy:', err);
            systemDomainProxyState = await verifiedSystemDomainProxyStatus();
          }
        }
        const hdoNetworkProbe = await probeHdoNetwork(snapshot);
        return {
          defaultServerUrl: defaultHdoServerUrl(),
          auth: host.auth ? host.auth.state() : null,
          updates: {
            restartRequired: readJsonMeta(UPDATE_RESTART_REQUIRED_META)
          },
          systemDomainProxy: systemDomainProxyState,
          systemPacEnabled,
          hdoNetworkProbe,
          hdo: snapshot
        };
      });

      ipcMain.handle('demo:launcher-route-plan', async (_e, payload) => launcherRoutePlanProbe(payload));

      ipcMain.handle('demo:set-system-pac-enabled', async (_e, enabled) => {
        systemPacEnabled = enabled === true;
        writeClientSettings({ systemPacEnabled });
        if (!systemPacEnabled) {
          return {
            ok: true,
            systemPacEnabled,
            systemDomainProxy: await safelyDisableSystemDomainProxy('system-pac-toggle-off')
          };
        }
        const snapshot = await hdoCall('snapshot').catch(() => null);
        let systemDomainProxyState = await verifiedSystemDomainProxyStatus();
        if (shouldEnsureSystemDomainProxy(snapshot, systemDomainProxyState)) {
          try {
            const ensured = await ensureSystemDomainProxyFromManifest('system-pac-toggle-on');
            systemDomainProxyState = ensured.systemDomainProxy || await verifiedSystemDomainProxyStatus();
          } catch (err) {
            console.warn('[hdo] failed to apply system PAC after enabling:', err);
            systemDomainProxyState = await verifiedSystemDomainProxyStatus();
          }
        }
        return {
          ok: true,
          systemPacEnabled,
          systemDomainProxy: systemDomainProxyState
        };
      });

      ipcMain.handle('demo:hdo-anonymous-connect', async (_e, payload) => {
        const legacyConnect = () => hdoCall('anonymousConnect', {
          ...(payload && typeof payload === 'object' ? payload : {}),
          relayMode: FAST_RELAY_MODE,
          appId: 'qpjoy-hdo',
          deviceLabel: 'MX HDO',
          skipDnsRepair: systemPacEnabled === true
        });
        const result = await connectH2oWithLauncherFallback(payload, 'anonymous', legacyConnect);
        const autoConnect = !payload || typeof payload !== 'object' || payload.autoConnect !== false;
        if (result && typeof result === 'object' && result.ok !== false && autoConnect && result.domainProxy) {
          return {
            ...result,
            systemDomainProxy: await safelyApplySystemDomainProxy(result.domainProxy, 'anonymous-connect')
          };
        }
        return result;
      });

      ipcMain.handle('demo:hdo-switch-anonymous', async (_e, payload) => {
        const networkSwitch = await anonymousNetworkSwitchHint();
        const switchPayload = {
          ...(payload && typeof payload === 'object' ? payload : {}),
          autoConnect: true
        };
        const legacyConnect = () => hdoCall('anonymousConnect', {
          ...switchPayload,
          relayMode: FAST_RELAY_MODE,
          appId: 'qpjoy-hdo',
          deviceLabel: 'MX HDO',
          skipDnsRepair: systemPacEnabled === true
        });
        const result = await connectH2oWithLauncherFallback(switchPayload, 'anonymous', legacyConnect);
        if (result && typeof result === 'object' && result.ok !== false && result.domainProxy) {
          return {
            ...result,
            networkSwitch,
            systemDomainProxy: await safelyApplySystemDomainProxy(result.domainProxy, 'anonymous-switch')
          };
        }
        return { ...result, networkSwitch };
      });

      ipcMain.handle('demo:hdo-account-connect', async (_e, payload) => {
        const accountSwitch = await accountNetworkSwitchHint();
        const legacyConnect = () => hdoCall('accountConnect', {
          ...(payload && typeof payload === 'object' ? payload : {}),
          relayMode: FAST_RELAY_MODE,
          skipDnsRepair: systemPacEnabled === true
        });
        const result = await connectH2oWithLauncherFallback(payload, 'user', legacyConnect);
        const autoConnect = !payload || typeof payload !== 'object' || payload.autoConnect !== false;
        if (result && typeof result === 'object' && result.ok !== false && autoConnect && result.domainProxy) {
          return {
            ...result,
            accountSwitch,
            systemDomainProxy: await safelyApplySystemDomainProxy(result.domainProxy, 'account-connect')
          };
        }
        return { ...result, accountSwitch };
      });

      ipcMain.handle('demo:hdo-update-settings', async (_e, patch) => {
        return hdoCall('updateSettings', {
          ...(patch && typeof patch === 'object' ? patch : {}),
          relayMode: FAST_RELAY_MODE
        });
      });

      ipcMain.handle('demo:hdo-open-test-url', async (_e, value) => {
        const url = normalizeTestUrl(value);
        const domainProxy = await hdoCall('applyDomainProxyFromManifest').catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        }));
        const systemDomainProxyResult = await safelyApplySystemDomainProxy(domainProxy, 'open-test-url');
        await session.defaultSession.forceReloadProxyConfig?.().catch(() => undefined);
        const w = trackChildWindow(new BrowserWindow({
          width: 1000,
          height: 720,
          backgroundColor: '#101827',
          autoHideMenuBar: true,
          title: 'HDO Internal Access',
          webPreferences: {
            session: session.defaultSession,
            contextIsolation: true,
            sandbox: true
          }
        }));
        await w.loadURL(url);
        return { ok: true, url, domainProxy, systemDomainProxy: systemDomainProxyResult };
      });

      ipcMain.handle('demo:hdo-stop', async () => {
        const stopped = await hdoCall('connectWireGuardPeer', { action: 'down' });
        const systemDomainProxyResult = await safelyDisableSystemDomainProxy('hdo-stop');
        return { ...stopped, systemDomainProxy: systemDomainProxyResult };
      });

      ipcMain.handle('demo:hdo-repair-dns', async () => {
        const repaired = await hdoCall('repairWireGuardRoutes');
        let systemDomainProxyState = await verifiedSystemDomainProxyStatus();
        if (repaired && typeof repaired === 'object' && repaired.ok !== false) {
          try {
            const ensured = await ensureSystemDomainProxyFromManifest('repair-dns');
            systemDomainProxyState = ensured.systemDomainProxy || systemDomainProxyState;
          } catch (err) {
            console.warn('[hdo] failed to ensure system domain proxy after DNS repair:', err);
          }
        }
        return { ...repaired, systemDomainProxy: systemDomainProxyState };
      });

      ipcMain.handle('demo:check-updates', async () => {
        if (!host.updateAgent) {
          return {
            outcome: 'skipped',
            error: 'release server is not configured'
          };
        }
        return host.updateAgent.run('manual');
      });

      createMainWindow();
    })
    .catch((err) => {
      console.error('[hdo] startup failed:', err);
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
  event.preventDefault();
  void quitGracefully(0);
});

process.once('SIGINT', () => {
  void quitGracefully(130);
});

process.once('SIGTERM', () => {
  void quitGracefully(143);
});
