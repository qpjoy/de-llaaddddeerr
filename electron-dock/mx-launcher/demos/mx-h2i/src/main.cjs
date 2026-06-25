const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const dnsPromises = require('node:dns').promises;
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen: electronScreen, powerMonitor, net: electronNet } = require('electron');

loadDotEnvFiles();

const APP_ID = 'dev.qpjoy.mx-h2i';
const STATE_FILE = 'mx-h2i-runtime.json';
const PRODUCT_ID = 'mx-h2i';
const REQUESTED_BY = 'mx-h2i-desktop';
const WIREGUARD_PROFILE_NAME = 'mx-h2i.conf';
const INTERNAL_PEER_IP = '10.88.88.88';
const LOCAL_INTERNAL_BASE_URLS = ['http://127.0.0.1:18090', 'http://localhost:18090'];
const BOOTSTRAP_DNS_RETRY_LIMIT = 3;
const BOOTSTRAP_DNS_RETRY_DELAY_MS = 350;
const DEFAULT_LOCAL_EDGE_PORT = 2053;
const DEFAULT_DOMESTIC_DNS_EDGE_PORT = 50053;
const DEFAULT_INTERNAL_GATEWAY_APP_PORT = 80;
const DEFAULT_SPLIT_DNS_DOMAINS = 'mxinfo-inc.cn internal.mx corp.mx h2i.mx';
const SYSTEM_DOMAIN_PROXY_REFRESH_MS = 30_000;
const DEFAULT_CONFIG = {
  bootstrapApiBaseUrl: defaultBootstrapApiBaseUrl(),
  internalApiBaseUrl: 'http://10.88.88.88:18090',
  domesticRelayHost: '121.43.253.179',
  domesticRelayPort: 51280,
  sdkGatewayBaseUrl: '',
  hostResolve: defaultHostResolve(),
  bootstrapResolveMode: defaultBootstrapResolveMode(),
  bootstrapDnsServers: defaultBootstrapDnsServers(),
  splitDnsDomains: nullableString(process.env.MX_H2I_SPLIT_DNS_DOMAINS)
    || nullableString(process.env.MX_H2I_DNS_DOMAINS)
    || DEFAULT_SPLIT_DNS_DOMAINS,
  routePathPreference: normalizeRoutePathPreference(process.env.MX_H2I_ROUTE_PATH || process.env.MX_H2I_PATH_PREFERENCE || 'auto'),
  releaseChannel: 'stable',
  rolloutGroup: 'staff-ring',
  useLocalEngineResources: true,
  restartAfterCodeUpdate: true
};

let mainWindow = null;
let runtime = null;
let tray = null;
let currentWindowMode = 'launcher';
let isTopHidden = false;
let isTopHideAnimating = false;
let topRevealTimer = null;
let lastVisibleBounds = null;
let isTopDocked = false;
let topDockHidePending = false;
let topAnimationTimer = null;
let needsRevealZoneReentry = false;
let topDockHoldUntil = 0;
let topDockLeaveStartedAt = 0;
let wireGuardRecoveryInterval = null;
let wireGuardRecoveryInFlight = null;
let wireGuardConnectInFlight = false;
let lastWireGuardRecoveryFailureAt = 0;
const wireGuardRecoveryTimers = [];
let systemDomainProxyManager = null;
let systemDomainProxyRefreshInterval = null;
let systemDomainProxyRefreshInFlight = false;
let lastSystemDomainProxySignature = null;

const TOP_DOCK_Y = 0;
const TOP_REVEAL_ZONE = 18;
const TOP_ANIMATION_STEPS = 24;
const TOP_REVEAL_HOLD_MS = 900;
const TOP_LEAVE_HIDE_MS = 180;

app.setAppUserModelId(APP_ID);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  showMainWindow();
});

app.whenReady().then(async () => {
  runtime = await loadRuntime();
  await initializeSystemDomainProxy();
  registerIpc();
  createTray();
  createMainWindow();
  startTopRevealWatcher();
  startWireGuardRecoveryWatcher();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopWireGuardRecoveryWatcher();
  void closeSystemDomainProxy();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    return;
  }
  showMainWindow();
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 462,
    height: 760,
    minWidth: 410,
    minHeight: 680,
    resizable: false,
    title: 'MX-H2I',
    backgroundColor: '#242734',
    frame: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.once('closed', () => {
    mainWindow = null;
  });
  mainWindow.center();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerIpc() {
  ipcMain.handle('mx-h2i:get-state', () => visibleRuntime());
  ipcMain.handle('mx-h2i:save-config', async (_event, input) => {
    runtime.config = normalizeConfig(input);
    runtime.launcherContract = await launcherContract(runtime.config);
    touchRuntime('config saved');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:connect-guest', async () => {
    setConnecting('guest');
    await saveAndBroadcast();
    try {
      const session = await connectLauncherNetwork({
        identityKind: 'anonymous',
        requestTag: 'guest'
      });
      await applyNetworkSession(session, {
        mode: 'guest',
        subject: `anonymous:${session.lease.installId}`,
        routePolicy: 'guest limited',
        identity: {
          kind: 'anonymous',
          displayName: 'Visitor',
          account: null,
          scopes: ['auth.read', 'network.hdi.status', 'network.proxy.app']
        },
        auth: null,
        feedback: '访客 lease 已由 Internal 下发，并保留 180 天未续租回收。'
      });
    } catch (err) {
      applyConnectionError('访客连接失败', err);
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:login-employee', async (_event, input) => {
    const account = typeof input?.account === 'string' ? input.account.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!account || !password) {
      runtime.feedback = {
        tone: 'danger',
        message: '请输入员工账号和密码。'
      };
      return visibleRuntime();
    }
    setConnecting('employee');
    await saveAndBroadcast();
    try {
      const bootstrap = await resolveBootstrapEndpoint(runtime.config);
      const baseUrl = bootstrap.baseUrl;
      await applyResolvedBootstrapEndpoint(bootstrap);
      const auth = await authenticateUserViaGateway(baseUrl, account, password, {
        bootstrapResolveMode: bootstrap.resolveMode
      });
      const session = await connectLauncherNetwork({
        identityKind: 'user',
        userId: auth.user.userId,
        requestTag: 'employee'
      });
      await applyNetworkSession(session, {
        mode: 'employee',
        subject: `user:${auth.user.userId}`,
        routePolicy: 'user full',
        identity: {
          kind: 'user',
          displayName: auth.user.displayName || displayNameFromAccount(account),
          account: auth.user.email || account,
          scopes: ['auth.read', 'appcenter.read', 'network.hdi.status', 'network.proxy.app', 'network.dns.policy']
        },
        auth,
        feedback: '员工账号已绑定 Internal User Center，并续租固定 user IP。'
      });
    } catch (err) {
      applyConnectionError('员工登录失败', err);
    }
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:disconnect', async () => {
    const systemDomainProxy = await disableSystemDomainProxyForRuntime('disconnect');
    const wireGuard = await stopWireGuardForRuntime();
    runtime.connection = idleConnection();
    runtime.auth = null;
    runtime.feedback = {
      tone: wireGuard?.ok === false || systemDomainProxy?.error ? 'warning' : 'info',
      message: wireGuard?.ok === false
        ? `已断开 launcher channel，但 WireGuard 停止失败：${wireGuard.message || wireGuard.error || 'unknown'}`
        : systemDomainProxy?.error
          ? `已断开 MX-H2I standalone channel；系统 PAC 恢复失败：${systemDomainProxy.error}`
          : '已断开 MX-H2I standalone channel、系统 PAC 和客户端 WireGuard；IP lease 会保留并在下次连接时续租。'
    };
    touchRuntime('disconnected');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:install-appcenter', async () => {
    if (runtime.connection.state !== 'connected') {
      runtime.feedback = {
        tone: 'warning',
        message: 'AppCenter 需要先连接 MX-H2I channel。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    runtime.apps.appcenter.installed = true;
    runtime.apps.appcenter.enabled = true;
    runtime.apps.appcenter.status = 'ready';
    runtime.apps.appcenter.lastAction = nowIso();
    runtime.feedback = {
      tone: 'success',
      message: 'AppCenter 已安装，正在复用 mx-h2i standalone channel。'
    };
    touchRuntime('appcenter installed');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:enable-h2o', async () => {
    if (!runtime.apps.appcenter.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 AppCenter。'
      };
      await saveAndBroadcast();
      return visibleRuntime();
    }
    runtime.apps.h2o.installed = true;
    runtime.apps.h2o.enabled = true;
    runtime.apps.h2o.status = 'enabled';
    runtime.apps.h2o.lastAction = nowIso();
    runtime.feedback = {
      tone: 'success',
      message: 'H2O 已启用，embed 运行时不会新建 WG peer。'
    };
    touchRuntime('h2o enabled');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:check-updates', async () => {
    runtime.update = {
      status: 'ready',
      currentVersion: app.getVersion(),
      latestVersion: '0.1.1',
      policy: 'launcher-managed',
      channel: runtime.config.releaseChannel,
      rolloutGroup: runtime.config.rolloutGroup,
      canSkip: true,
      lastCheckedAt: nowIso()
    };
    runtime.feedback = {
      tone: 'info',
      message: '灰度更新策略已读取。'
    };
    touchRuntime('update checked');
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:refresh-diagnostics', async () => {
    await recoverWireGuardForRuntime('manual-diagnostics');
    await refreshWireGuardDiagnostics();
    await saveAndBroadcast();
    return visibleRuntime();
  });
  ipcMain.handle('mx-h2i:open-admin', async () => {
    const baseUrl = runtime.connection?.state === 'connected'
      ? (runtime.connection.internalBaseUrl || runtime.config.internalApiBaseUrl)
      : (runtime.config.bootstrapApiBaseUrl || runtime.config.internalApiBaseUrl);
    const url = `${baseUrl.replace(/\/+$/, '')}/admin/`;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('mx-h2i:set-window-mode', (_event, mode) => {
    resizeWindowForMode(mode === 'appcenter' ? 'appcenter' : 'launcher');
    return true;
  });
  ipcMain.handle('mx-h2i:window-control', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (action === 'close') {
      mainWindow.close();
      return true;
    }
    if (action === 'minimize') {
      mainWindow.minimize();
      return true;
    }
    if (action === 'zoom') {
      if (mainWindow.isResizable()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
      } else {
        mainWindow.center();
      }
      return true;
    }
    return false;
  });
  ipcMain.handle('mx-h2i:move-window-by', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    const dx = Number(input?.dx);
    const dy = Number(input?.dy);
    const totalDy = Number(input?.totalDy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const bounds = mainWindow.getBounds();
    const nextBounds = {
      x: Math.round(bounds.x + dx),
      y: Math.round(bounds.y + dy),
      width: bounds.width,
      height: bounds.height
    };
    const display = electronScreen.getDisplayMatching(nextBounds);
    const releaseDock = isTopDocked && Number.isFinite(totalDy) && totalDy >= dockReleaseDistance(bounds, display);
    if (releaseDock) {
      isTopDocked = false;
      topDockHidePending = false;
      topDockHoldUntil = 0;
      topDockLeaveStartedAt = 0;
      nextBounds.y = Math.max(nextBounds.y, display.workArea.y + Math.round(totalDy));
    } else if (nextBounds.y <= display.workArea.y + dockActivationDistance(nextBounds, display)) {
      isTopDocked = true;
      topDockHidePending = false;
      nextBounds.y = display.workArea.y + TOP_DOCK_Y;
    } else if (!isTopDocked) {
      isTopDocked = false;
      topDockHidePending = false;
    }
    stopTopAnimation();
    mainWindow.setBounds({
      x: nextBounds.x,
      y: nextBounds.y,
      width: nextBounds.width,
      height: nextBounds.height
    }, false);
    lastVisibleBounds = mainWindow.getBounds();
    return {
      bounds: lastVisibleBounds,
      docked: isTopDocked
    };
  });
  ipcMain.handle('mx-h2i:finish-window-drag', (_event, input) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentWindowMode !== 'launcher' || isTopHidden) return false;
    const bounds = mainWindow.getBounds();
    const display = electronScreen.getDisplayMatching(bounds);
    const totalDy = Number(input?.totalDy);
    const releaseDock = isTopDocked && Number.isFinite(totalDy) && totalDy >= dockReleaseDistance(bounds, display);
    const shouldDock = !releaseDock && (isTopDocked || bounds.y <= display.workArea.y + dockActivationDistance(bounds, display));
    if (!shouldDock) {
      isTopDocked = false;
      topDockHidePending = false;
      topDockHoldUntil = 0;
      topDockLeaveStartedAt = 0;
      lastVisibleBounds = mainWindow.getBounds();
      return { docked: false, bounds: lastVisibleBounds };
    }
    return snapToTopEdge();
  });
  ipcMain.handle('mx-h2i:hide-top-dock-if-pending', () => {
    maybeHideTopDock();
    return true;
  });
}

function resizeWindowForMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  currentWindowMode = mode;
  isTopHidden = false;
  isTopDocked = false;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  if (mode === 'appcenter') {
    mainWindow.setResizable(true);
    mainWindow.setMinimumSize(980, 680);
    mainWindow.setSize(1240, 760, true);
  } else {
    mainWindow.setResizable(false);
    mainWindow.setMinimumSize(410, 680);
    mainWindow.setSize(462, 760, true);
  }
  mainWindow.center();
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip('MX-H2I');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 MX-H2I', click: () => showMainWindow() },
    { label: '收起到顶部', click: () => hideToTopEdge({ requireReentry: true }) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
}

function createTrayIcon() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <rect x="2" y="2" width="18" height="18" rx="5" fill="#2bf6d2"/>
      <path d="M6.2 7.3h2v3h5.6v-3h2v7.4h-2v-3H8.2v3h-2V7.3Z" fill="#071311"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
}

function snapToTopEdge() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = mainWindow.getBounds();
  const display = electronScreen.getDisplayMatching(bounds);
  isTopDocked = true;
  topDockHidePending = true;
  topDockHoldUntil = Date.now() + 260;
  topDockLeaveStartedAt = 0;
  const target = {
    x: bounds.x,
    y: display.workArea.y + TOP_DOCK_Y,
    width: bounds.width,
    height: bounds.height
  };
  animateWindow(bounds, target, 10, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    lastVisibleBounds = mainWindow.getBounds();
  });
  return { docked: true, bounds: target };
}

function hideToTopEdge(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (currentWindowMode !== 'launcher' || isTopHidden || isTopHideAnimating) return;
  isTopHideAnimating = true;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  const bounds = mainWindow.getBounds();
  const display = electronScreen.getDisplayMatching(bounds);
  lastVisibleBounds = { ...bounds };
  const targetY = display.workArea.y - bounds.height + TOP_REVEAL_ZONE;
  animateWindow(bounds, { ...bounds, y: targetY }, TOP_ANIMATION_STEPS, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    isTopHidden = true;
    isTopDocked = false;
    isTopHideAnimating = false;
    needsRevealZoneReentry = options.requireReentry !== false;
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  isTopHidden = false;
  isTopDocked = false;
  topDockHidePending = false;
  topDockHoldUntil = 0;
  topDockLeaveStartedAt = 0;
  needsRevealZoneReentry = false;
  const bounds = lastVisibleBounds || mainWindow.getBounds();
  const display = electronScreen.getDisplayMatching(bounds);
  const y = Math.max(bounds.y, display.workArea.y + dockActivationDistance(bounds, display) + 18);
  mainWindow.show();
  mainWindow.setBounds({ ...bounds, y }, false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function showFromTopEdge() {
  if (!mainWindow || mainWindow.isDestroyed() || !lastVisibleBounds) return;
  if (!isTopHidden || isTopHideAnimating) return;
  const bounds = lastVisibleBounds;
  const display = electronScreen.getDisplayMatching(bounds);
  const start = {
    ...bounds,
    y: display.workArea.y - bounds.height + TOP_REVEAL_ZONE
  };
  const target = {
    ...bounds,
    y: display.workArea.y + TOP_DOCK_Y
  };
  stopTopAnimation();
  mainWindow.setBounds(start, false);
  mainWindow.showInactive();
  isTopHidden = false;
  isTopDocked = true;
  topDockHidePending = true;
  topDockHoldUntil = Date.now() + TOP_REVEAL_HOLD_MS;
  topDockLeaveStartedAt = 0;
  animateWindow(start, target, TOP_ANIMATION_STEPS, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    lastVisibleBounds = mainWindow.getBounds();
  });
}

function startTopRevealWatcher() {
  if (topRevealTimer) clearInterval(topRevealTimer);
  topRevealTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const point = electronScreen.getCursorScreenPoint();
    if (topDockHidePending && !isTopHidden) {
      maybeHideTopDock(point);
      return;
    }
    if (!isTopHidden || !lastVisibleBounds) return;
    const display = electronScreen.getDisplayMatching(lastVisibleBounds);
    const withinX = point.x >= lastVisibleBounds.x && point.x <= lastVisibleBounds.x + lastVisibleBounds.width;
    const nearTop = point.y <= display.workArea.y + TOP_REVEAL_ZONE;
    if (needsRevealZoneReentry) {
      if (!withinX || !nearTop) needsRevealZoneReentry = false;
      return;
    }
    if (withinX && nearTop) showFromTopEdge();
  }, 160);
}

function startWireGuardRecoveryWatcher() {
  stopWireGuardRecoveryWatcher();
  scheduleWireGuardRecovery('app-ready', [2500, 12_000]);
  wireGuardRecoveryInterval = setInterval(() => {
    scheduleWireGuardRecovery('interval', [0]);
  }, 45_000);
  wireGuardRecoveryInterval.unref?.();
  powerMonitor?.on?.('resume', onPowerResume);
  powerMonitor?.on?.('unlock-screen', onUnlockScreen);
}

function stopWireGuardRecoveryWatcher() {
  if (wireGuardRecoveryInterval) clearInterval(wireGuardRecoveryInterval);
  wireGuardRecoveryInterval = null;
  while (wireGuardRecoveryTimers.length) {
    clearTimeout(wireGuardRecoveryTimers.pop());
  }
  powerMonitor?.off?.('resume', onPowerResume);
  powerMonitor?.off?.('unlock-screen', onUnlockScreen);
}

function onPowerResume() {
  scheduleWireGuardRecovery('power-resume', [2500, 12_000, 25_000]);
}

function onUnlockScreen() {
  scheduleWireGuardRecovery('unlock-screen', [1500, 10_000, 25_000]);
}

function scheduleWireGuardRecovery(reason, delays = [2500, 12_000, 25_000]) {
  for (const delay of delays) {
    const timer = setTimeout(() => {
      const index = wireGuardRecoveryTimers.indexOf(timer);
      if (index >= 0) wireGuardRecoveryTimers.splice(index, 1);
      void recoverWireGuardForRuntime(reason, { allowPrivileged: false }).catch(() => undefined);
    }, Math.max(0, delay));
    timer.unref?.();
    wireGuardRecoveryTimers.push(timer);
  }
}

async function initializeSystemDomainProxy() {
  try {
    const mod = await import('@qpjoy/electron-launcher/system-domain-proxy');
    systemDomainProxyManager = mod.createElectronLauncherSystemDomainProxy({
      userDataDir: app.getPath('userData'),
      pacPort: localEdgePort(),
      log: console
    });
    if (shouldRecoverWireGuardConnection(runtime?.connection)) {
      await ensureSystemDomainProxyForRuntime('app-startup');
    } else {
      await systemDomainProxyManager.restoreStale('app-startup');
    }
    startSystemDomainProxyRefreshWatcher();
  } catch (err) {
    console.warn('[mx-h2i] system domain proxy unavailable:', errorMessage(err));
    systemDomainProxyManager = null;
  }
}

async function ensureSystemDomainProxyForRuntime(reason = 'manual') {
  if (!systemDomainProxyManager) return null;
  if (runtime?.connection?.state !== 'connected') {
    return disableSystemDomainProxyForRuntime(`${reason}-not-connected`);
  }
  try {
    const reverseProxyRoutes = await systemPacReverseProxyRoutes();
    const domains = uniqueStrings([
      ...splitDnsDomains(runtime?.config),
      ...reverseProxyRoutes.map((route) => route.host).filter(Boolean)
    ]);
    if (domains.length === 0) {
      return disableSystemDomainProxyForRuntime(`${reason}-no-domains`);
    }
    return await systemDomainProxyManager.apply({
      enabled: true,
      domains,
      matchMode: 'proxy',
      proxy: localEdgeProxy(),
      pacPort: localEdgePort(),
      dnsServers: systemPacDnsServers(),
      dnsFallbackTarget: systemPacDnsFallbackTarget(),
      systemResolver: 'dynamic',
      reverseProxyRoutes,
      fallbackProxy: systemPacFallbackProxy()
    });
  } catch (err) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      error: errorMessage(err)
    };
  }
}

async function disableSystemDomainProxyForRuntime(reason = 'manual') {
  if (!systemDomainProxyManager) return null;
  lastSystemDomainProxySignature = null;
  try {
    return await systemDomainProxyManager.disable(reason);
  } catch (err) {
    return {
      supported: true,
      applied: false,
      platform: process.platform,
      reason,
      error: errorMessage(err)
    };
  }
}

async function closeSystemDomainProxy() {
  stopSystemDomainProxyRefreshWatcher();
  if (!systemDomainProxyManager) return;
  await systemDomainProxyManager.close?.().catch(() => undefined);
}

function startSystemDomainProxyRefreshWatcher() {
  if (systemDomainProxyRefreshInterval) return;
  systemDomainProxyRefreshInterval = setInterval(() => {
    void refreshSystemDomainProxyForRuntime('route-refresh').catch(() => undefined);
  }, SYSTEM_DOMAIN_PROXY_REFRESH_MS);
  systemDomainProxyRefreshInterval.unref?.();
}

function stopSystemDomainProxyRefreshWatcher() {
  if (systemDomainProxyRefreshInterval) clearInterval(systemDomainProxyRefreshInterval);
  systemDomainProxyRefreshInterval = null;
  systemDomainProxyRefreshInFlight = false;
}

async function refreshSystemDomainProxyForRuntime(reason = 'manual') {
  if (systemDomainProxyRefreshInFlight || !systemDomainProxyManager) return null;
  if (runtime?.connection?.state !== 'connected') return null;
  systemDomainProxyRefreshInFlight = true;
  try {
    const status = await ensureSystemDomainProxyForRuntime(reason);
    const signature = systemDomainProxyStatusSignature(status);
    if (signature && signature !== lastSystemDomainProxySignature) {
      lastSystemDomainProxySignature = signature;
      runtime.connection = {
        ...runtime.connection,
        diagnostics: {
          ...(runtime.connection.diagnostics || {}),
          systemDomainProxy: status
        }
      };
      touchRuntime(`system domain proxy refreshed: ${reason}`);
      await saveAndBroadcast();
    }
    return status;
  } finally {
    systemDomainProxyRefreshInFlight = false;
  }
}

function systemDomainProxyStatusSignature(status) {
  if (!status || typeof status !== 'object') return null;
  return JSON.stringify({
    applied: status.applied === true,
    pacUrl: nullableString(status.pacUrl),
    proxy: nullableString(status.proxy),
    fallbackProxy: nullableString(status.fallbackProxy),
    dnsFallbackTarget: nullableString(status.dnsFallbackTarget),
    systemResolverMode: nullableString(status.systemResolverMode),
    resolverPort: status.resolverPort || null,
    resolverApplied: status.resolverApplied === true,
    resolverError: nullableString(status.resolverError),
    resolverDomains: arrayValue(status.resolverDomains, []).map(String).sort(),
    domains: arrayValue(status.domains, []).map(String).sort(),
    dnsServers: arrayValue(status.dnsServers, []).map(String).sort(),
    reverseProxyRoutes: arrayValue(status.reverseProxyRoutes, [])
      .map((route) => ({
        host: nullableString(route?.host),
        dnsTarget: nullableString(route?.dnsTarget),
        targetUrl: nullableString(route?.targetUrl),
        tlsMode: nullableString(route?.tlsMode),
        enabled: route?.enabled !== false
      }))
      .sort((left, right) => String(left.host).localeCompare(String(right.host)))
  });
}

function systemPacFallbackProxy() {
  return nullableString(process.env.MX_H2I_SYSTEM_PAC_FALLBACK_PROXY)
    || nullableString(process.env.MX_H2I_CLASH_PROXY)
    || nullableString(process.env.MX_H2I_MIHOMO_PROXY)
    || null;
}

function localEdgePort() {
  const port = Number(
    nullableString(process.env.MX_H2I_LOCAL_EDGE_PORT)
    || nullableString(process.env.MX_H2I_SYSTEM_PAC_PORT)
    || DEFAULT_LOCAL_EDGE_PORT
  );
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_LOCAL_EDGE_PORT;
}

function localEdgeProxy() {
  return `127.0.0.1:${localEdgePort()}`;
}

function systemPacDnsServers() {
  return arrayValue([
    process.env.MX_H2I_LOCAL_EDGE_DNS_SERVER,
    process.env.MX_H2I_DOMESTIC_DNS_SERVER,
    process.env.MX_H2I_DOMESTIC_DNS_EDGE,
    domesticPublicDnsServer(),
    runtime?.connection?.routePlan?.dnsServer,
    domesticGatewayDnsServer(),
    runtime?.connection?.routePlan?.internalControlIp,
    runtime?.connection?.internalControlIp,
    INTERNAL_PEER_IP
  ], [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, rows) => rows.indexOf(item) === index);
}

function domesticPublicDnsServer() {
  const host = publicHostFromEndpoint(runtime?.connection?.domesticRelayEndpoint)
    || publicHostFromUrl(runtime?.config?.bootstrapApiBaseUrl)
    || publicHostFromUrl(DEFAULT_CONFIG.bootstrapApiBaseUrl);
  return host ? dnsEndpoint(host, DEFAULT_DOMESTIC_DNS_EDGE_PORT) : null;
}

function domesticGatewayDnsServer() {
  const host = nullableString(runtime?.connection?.routePlan?.domesticGatewayIp) || '10.88.0.1';
  return dnsEndpoint(host, DEFAULT_DOMESTIC_DNS_EDGE_PORT);
}

function dnsEndpoint(host, port) {
  const cleanHost = nullableString(host);
  if (!cleanHost) return null;
  return cleanHost.includes(':') && !cleanHost.startsWith('[')
    ? `[${cleanHost}]:${port}`
    : `${cleanHost}:${port}`;
}

function publicHostFromEndpoint(endpoint) {
  const text = nullableString(endpoint);
  if (!text) return null;
  try {
    return new URL(text.includes('://') ? text : `udp://${text}`).hostname || null;
  } catch {
    return text.split(':')[0] || null;
  }
}

function publicHostFromUrl(value) {
  const text = normalizeBaseUrl(value);
  if (!text) return null;
  try {
    const host = new URL(text).hostname;
    return host && host !== 'localhost' && net.isIP(host) !== 6 ? host : null;
  } catch {
    return null;
  }
}

function systemPacDnsFallbackTarget() {
  return nullableString(runtime?.connection?.routePlan?.internalControlIp)
    || nullableString(runtime?.connection?.internalControlIp)
    || INTERNAL_PEER_IP;
}

function systemPacGatewayTargetUrl() {
  const host = systemPacDnsFallbackTarget();
  const port = Number.parseInt(
    nullableString(process.env.MX_H2I_INTERNAL_GATEWAY_PORT)
      || nullableString(process.env.MX_H2I_GATEWAY_APP_PORT)
      || String(DEFAULT_INTERNAL_GATEWAY_APP_PORT),
    10
  );
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_INTERNAL_GATEWAY_APP_PORT;
  return `http://${host}:${safePort}`;
}

async function systemPacReverseProxyRoutes() {
  const baseUrl = normalizeBaseUrl(runtime?.connection?.internalBaseUrl)
    || internalOverlayBaseUrl(runtime?.connection?.routePlan, runtime?.config?.internalApiBaseUrl);
  try {
    const payload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/dns/reverse-proxy/routes'), {
      timeoutMs: 2200
    });
    return arrayValue(payload?.routes, [])
      .map((route) => normalizeSystemPacReverseProxyRoute(route))
      .filter(Boolean);
  } catch (err) {
    console.warn('[mx-h2i] reverse proxy routes unavailable for local edge:', errorMessage(err));
    return [];
  }
}

function normalizeSystemPacReverseProxyRoute(input) {
  const row = input && typeof input === 'object' ? input : {};
  const host = nullableString(row.host);
  if (!host || row.enabled === false) return null;
  const routeUpstream = nullableString(row.targetUrl);
  return {
    routeId: nullableString(row.routeId),
    host,
    dnsTarget: nullableString(row.dnsTarget),
    targetUrl: routeUpstream ? systemPacGatewayTargetUrl() : null,
    tlsMode: nullableString(row.tlsMode),
    authRequired: row.authRequired === true,
    enabled: true
  };
}

function isCursorInsideWindow(point = electronScreen.getCursorScreenPoint()) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = mainWindow.getBounds();
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function maybeHideTopDock(point = electronScreen.getCursorScreenPoint()) {
  if (!topDockHidePending || isTopHidden || isTopHideAnimating) return false;
  if (isCursorInsideWindow(point) || isCursorInTopHoldZone(point)) {
    topDockLeaveStartedAt = 0;
    return false;
  }
  const now = Date.now();
  if (now < topDockHoldUntil) return false;
  if (!topDockLeaveStartedAt) {
    topDockLeaveStartedAt = now;
    return false;
  }
  if (now - topDockLeaveStartedAt < TOP_LEAVE_HIDE_MS) return false;
  hideToTopEdge({ requireReentry: true });
  return true;
}

function isCursorInTopHoldZone(point) {
  if (!lastVisibleBounds) return false;
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : lastVisibleBounds;
  const display = electronScreen.getDisplayMatching(bounds);
  const withinX = point.x >= bounds.x && point.x <= bounds.x + bounds.width;
  const nearTop = point.y >= display.bounds.y - 2 && point.y <= bounds.y + TOP_REVEAL_ZONE;
  return withinX && nearTop;
}

function dockActivationDistance(bounds, display) {
  const base = Math.min(bounds.height, display.workArea.height) * 0.032;
  return clamp(Math.round(base), 16, 30);
}

function dockReleaseDistance(bounds, display) {
  const base = Math.min(bounds.height, display.workArea.height) * 0.09;
  return clamp(Math.round(base), 58, 92);
}

function animateWindow(from, to, steps, onDone) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopTopAnimation();
  let step = 0;
  topAnimationTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopTopAnimation();
      return;
    }
    step += 1;
    const t = easeOutCubic(step / steps);
    mainWindow.setBounds({
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      width: Math.round(from.width + (to.width - from.width) * t),
      height: Math.round(from.height + (to.height - from.height) * t)
    }, false);
    if (step >= steps) {
      stopTopAnimation();
      onDone?.();
    }
  }, 18);
}

function stopTopAnimation() {
  if (!topAnimationTimer) return;
  clearInterval(topAnimationTimer);
  topAnimationTimer = null;
}

function easeOutCubic(value) {
  const t = Math.min(1, Math.max(0, value));
  return 1 - Math.pow(1 - t, 3);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function loadRuntime() {
  try {
    const raw = await fs.readFile(runtimePath(), 'utf8');
    return await normalizeRuntime(JSON.parse(raw));
  } catch {
    return await normalizeRuntime({});
  }
}

async function normalizeRuntime(input) {
  const row = input && typeof input === 'object' ? input : {};
  const config = normalizeConfig(row.config);
  return {
    config,
    installation: normalizeInstallation(row.installation),
    auth: normalizeAuth(row.auth),
    connection: normalizeConnection(row.connection),
    identity: normalizeIdentity(row.identity),
    apps: normalizeApps(row.apps),
    update: normalizeUpdate(row.update, config),
    launcherContract: await launcherContract(config),
    feedback: null,
    activity: Array.isArray(row.activity) ? row.activity.slice(0, 8) : defaultActivity(),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : nowIso()
  };
}

function normalizeConfig(input) {
  const row = input && typeof input === 'object' ? input : {};
  const domesticRelayPort = Number(row.domesticRelayPort);
  const bootstrapApiBaseUrl = stringValue(row.bootstrapApiBaseUrl, DEFAULT_CONFIG.bootstrapApiBaseUrl);
  return {
    bootstrapApiBaseUrl,
    internalApiBaseUrl: stringValue(row.internalApiBaseUrl, DEFAULT_CONFIG.internalApiBaseUrl),
    domesticRelayHost: stringValue(row.domesticRelayHost, DEFAULT_CONFIG.domesticRelayHost),
    domesticRelayPort: Number.isInteger(domesticRelayPort) && domesticRelayPort > 0 ? domesticRelayPort : DEFAULT_CONFIG.domesticRelayPort,
    sdkGatewayBaseUrl: stringValue(row.sdkGatewayBaseUrl, DEFAULT_CONFIG.sdkGatewayBaseUrl || sdkGatewayBaseUrl(bootstrapApiBaseUrl)),
    hostResolve: stringValue(row.hostResolve, DEFAULT_CONFIG.hostResolve),
    bootstrapResolveMode: normalizeBootstrapResolveMode(row.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode),
    bootstrapDnsServers: stringValue(row.bootstrapDnsServers, DEFAULT_CONFIG.bootstrapDnsServers),
    splitDnsDomains: stringValue(row.splitDnsDomains, DEFAULT_CONFIG.splitDnsDomains),
    routePathPreference: normalizeRoutePathPreference(row.routePathPreference || DEFAULT_CONFIG.routePathPreference),
    releaseChannel: stringValue(row.releaseChannel, DEFAULT_CONFIG.releaseChannel),
    rolloutGroup: stringValue(row.rolloutGroup, DEFAULT_CONFIG.rolloutGroup),
    useLocalEngineResources: row.useLocalEngineResources !== false,
    restartAfterCodeUpdate: row.restartAfterCodeUpdate !== false
  };
}

function normalizeInstallation(input) {
  const row = input && typeof input === 'object' ? input : {};
  const keyPairRow = row.keyPair && typeof row.keyPair === 'object' ? row.keyPair : {};
  const privateKey = nullableString(row.privateKey) || nullableString(keyPairRow.privateKey);
  const publicKey = nullableString(row.publicKey) || nullableString(keyPairRow.publicKey);
  return {
    installId: nullableString(row.installId),
    deviceId: nullableString(row.deviceId),
    siteId: stringValue(row.siteId, 'domestic-main'),
    deviceLabel: stringValue(row.deviceLabel, 'MX-H2I Desktop'),
    keyPair: privateKey && publicKey ? { privateKey, publicKey } : null,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null
  };
}

function isRetainedConnectionState(state) {
  return [
    'connected',
    'lease-only',
    'tunnel-only',
    'server-unavailable',
    'network-unavailable',
    'forbidden'
  ].includes(state);
}

function normalizeConnection(input) {
  const row = input && typeof input === 'object' ? input : {};
  if (isRetainedConnectionState(row.state)) {
    return connectedState({
      state: row.state,
      mode: row.mode === 'employee' ? 'employee' : 'guest',
      localIp: stringValue(row.localIp, '10.89.120.24'),
      routePolicy: stringValue(row.routePolicy, 'guest limited'),
      subject: stringValue(row.subject, 'anonymousPrincipal:h2i-demo'),
      connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : nowIso(),
      leaseId: nullableString(row.leaseId),
      snapshotId: nullableString(row.snapshotId),
      productId: nullableString(row.productId),
      serviceVip: nullableString(row.serviceVip),
      internalBaseUrl: nullableString(row.internalBaseUrl),
      internalControlIp: nullableString(row.internalControlIp),
      domesticRelayEndpoint: nullableString(row.domesticRelayEndpoint),
      publicKey: nullableString(row.publicKey),
      allowedIps: arrayValue(row.allowedIps, []),
      routeCidrs: arrayValue(row.routeCidrs, []),
      routePlan: normalizeRoutePlan(row.routePlan),
      health: normalizeHealth(row.health, leasedHealth()),
      wireGuard: normalizeWireGuardSummary(row.wireGuard),
      domesticPeerSync: normalizeDomesticPeerSync(row.domesticPeerSync),
      diagnostics: normalizeDiagnostics(row.diagnostics)
    });
  }
  if (row.state === 'connecting') {
    return {
      ...idleConnection(),
      state: 'connecting',
      mode: row.mode === 'employee' ? 'employee' : 'guest'
    };
  }
  return idleConnection();
}

function retainableConnectionSnapshot(connection) {
  if (!connection || typeof connection !== 'object') return null;
  if (isRetainedConnectionState(connection.state)) return connection;
  if (connection.state === 'connecting' && (connection.leaseId || connection.localIp || connection.routePlan)) return connection;
  return null;
}

function normalizeIdentity(input) {
  const row = input && typeof input === 'object' ? input : {};
  if (row.kind === 'user') {
    return {
      kind: 'user',
      displayName: stringValue(row.displayName, 'employee'),
      account: stringValue(row.account, 'employee@qpjoy.local'),
      scopes: arrayValue(row.scopes, ['auth.read', 'appcenter.read'])
    };
  }
  return {
    kind: 'anonymous',
    displayName: 'Visitor',
    account: null,
    scopes: ['auth.read']
  };
}

function normalizeAuth(input) {
  const row = input && typeof input === 'object' ? input : {};
  const accessToken = nullableString(row.accessToken) || nullableString(row.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    tokenType: nullableString(row.tokenType) || nullableString(row.token_type) || 'Bearer',
    issuedTokenType: nullableString(row.issuedTokenType) || nullableString(row.issued_token_type) || 'urn:ietf:params:oauth:token-type:jwt',
    issuer: nullableString(row.issuer),
    audience: nullableString(row.audience),
    subject: nullableString(row.subject),
    expiresAt: nullableString(row.expiresAt) || nullableString(row.expires_at),
    scopes: arrayValue(row.scopes, typeof row.scope === 'string' ? row.scope.split(/\s+/) : [])
  };
}

function normalizeApps(input) {
  const row = input && typeof input === 'object' ? input : {};
  return {
    appcenter: normalizeApp(row.appcenter, {
      appId: 'appcenter',
      displayName: 'AppCenter',
      category: 'platform',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      serviceVip: '10.88.100.9',
      version: '0.1.0',
      updatePolicy: 'launcher-managed',
      permissions: ['auth.read', 'appcenter.read', 'permission.request']
    }),
    h2o: normalizeApp(row.h2o, {
      appId: 'h2o',
      displayName: 'H2O',
      category: 'network',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      serviceVip: '10.88.100.10',
      version: '0.1.0',
      updatePolicy: 'launcher-managed',
      permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy']
    })
  };
}

function normalizeApp(input, defaults) {
  const row = input && typeof input === 'object' ? input : {};
  const installed = row.installed === true;
  const enabled = row.enabled === true;
  return {
    ...defaults,
    installed,
    enabled,
    status: stringValue(row.status, enabled ? 'ready' : installed ? 'installed' : 'available'),
    lastAction: typeof row.lastAction === 'string' ? row.lastAction : null
  };
}

function normalizeUpdate(input, config) {
  const row = input && typeof input === 'object' ? input : {};
  return {
    status: stringValue(row.status, 'idle'),
    currentVersion: stringValue(row.currentVersion, app.getVersion()),
    latestVersion: stringValue(row.latestVersion, app.getVersion()),
    policy: 'launcher-managed',
    channel: config.releaseChannel,
    rolloutGroup: config.rolloutGroup,
    canSkip: row.canSkip === true,
    lastCheckedAt: typeof row.lastCheckedAt === 'string' ? row.lastCheckedAt : null
  };
}

async function launcherContract(config) {
  const fallback = {
    packageName: '@qpjoy/electron-launcher',
    available: false,
    product: {
      productId: 'mx-h2i',
      displayName: 'MX-H2I',
      mode: 'standalone'
    },
    foundation: foundationContract(),
    createOptions: launcherCreateOptions(config),
    embedDefaults: embedDefaults()
  };
  try {
    const mod = await import('@qpjoy/electron-launcher');
    const product = mod.defineLauncherProduct({
      productId: 'mx-h2i',
      displayName: 'MX-H2I',
      mode: 'standalone',
      appCenter: {
        visible: true,
        category: 'vpn'
      },
      release: {
        componentId: 'mx-h2i',
        channel: config.releaseChannel,
        rolloutGroup: config.rolloutGroup
      },
      launcherActions: {
        network: true,
        release: true,
        update: true,
        rollout: true,
        appCenter: true
      }
    });
    return {
      packageName: mod.ELECTRON_LAUNCHER_PACKAGE_NAME || fallback.packageName,
      available: true,
      product,
      foundation: foundationContract(),
      createOptions: launcherCreateOptions(config),
      embedDefaults: embedDefaults()
    };
  } catch (err) {
    return {
      ...fallback,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function launcherCreateOptions(config) {
  return {
    baseUrl: config.bootstrapApiBaseUrl || config.internalApiBaseUrl,
    productId: 'mx-h2i',
    mode: 'standalone',
    deviceLabel: 'MX-H2I Desktop'
  };
}

function embedDefaults() {
  return [
    {
      productId: 'appcenter',
      mode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      hostVersionRange: '^0.1.0',
      peerLease: 'shared'
    },
    {
      productId: 'h2o',
      mode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      hostVersionRange: '^0.1.0',
      peerLease: 'shared'
    }
  ];
}

function foundationContract() {
  return {
    runtimeName: 'Launcher Foundation',
    socketNamespace: '~/.qpjoy/mx-launcher/sockets/{standaloneChannelProductId}.sock',
    sharedCapabilities: ['auth', 'permission', 'release', 'network', 'observability'],
    standaloneOwners: [
      {
        productId: 'mx-h2i',
        displayName: 'MX-H2I',
        state: 'active',
        serviceVip: '10.88.100.1'
      },
      {
        productId: 'luopan',
        displayName: 'Luopan',
        state: 'reserved',
        serviceVip: '10.88.110.1'
      }
    ]
  };
}

function idleConnection() {
  return {
    state: 'idle',
    mode: 'guest',
    localIp: null,
    routePolicy: 'none',
    subject: null,
    connectedAt: null,
    leaseId: null,
    snapshotId: null,
    productId: null,
    serviceVip: null,
    internalBaseUrl: null,
    internalControlIp: null,
    domesticRelayEndpoint: null,
    publicKey: null,
    allowedIps: [],
    routeCidrs: [],
    routePlan: null,
    wireGuard: null,
    domesticPeerSync: null,
    diagnostics: null,
    health: idleHealth()
  };
}

function idleHealth() {
  return {
    wireGuard: 'idle',
    domesticRelay: 'idle',
    internalApi: 'idle',
    splitDns: 'idle',
    appBroker: 'idle'
  };
}

function leasedHealth() {
  return {
    wireGuard: 'lease',
    domesticRelay: 'pending',
    internalApi: 'pending',
    splitDns: 'pending',
    appBroker: 'ready'
  };
}

function readyHealth() {
  return {
    wireGuard: 'ready',
    domesticRelay: 'ready',
    internalApi: 'ready',
    splitDns: 'ready',
    appBroker: 'ready'
  };
}

function blockedHealth() {
  return {
    wireGuard: 'blocked',
    domesticRelay: 'pending',
    internalApi: 'blocked',
    splitDns: 'pending',
    appBroker: 'ready'
  };
}

function normalizeHealth(input, fallback) {
  const row = input && typeof input === 'object' ? input : {};
  return {
    wireGuard: stringValue(row.wireGuard, fallback.wireGuard),
    domesticRelay: stringValue(row.domesticRelay, fallback.domesticRelay),
    internalApi: stringValue(row.internalApi, fallback.internalApi),
    splitDns: stringValue(row.splitDns, fallback.splitDns),
    appBroker: stringValue(row.appBroker, fallback.appBroker)
  };
}

function normalizeWireGuardSummary(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    ok: row.ok === true,
    active: row.active === true,
    mode: nullableString(row.mode),
    interfaceName: nullableString(row.interfaceName),
    realInterfaceName: nullableString(row.realInterfaceName),
    configPath: nullableString(row.configPath),
    endpoint: nullableString(row.endpoint),
    path: nullableString(row.path),
    allowedIps: arrayValue(row.allowedIps, []),
    statusError: nullableString(row.statusError),
    serviceState: nullableString(row.serviceState),
    routeLogPath: nullableString(row.routeLogPath),
    routeLogTail: tailText(nullableString(row.routeLogTail), 1600),
    peers: Array.isArray(row.peers) ? row.peers : [],
    routes: Array.isArray(row.routes) ? row.routes : [],
    message: nullableString(row.message),
    error: nullableString(row.error),
    updatedAt: nullableString(row.updatedAt) || nowIso()
  };
}

function normalizeDomesticPeerSync(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const lease = row.lease && typeof row.lease === 'object' ? row.lease : null;
  const domesticRelay = row.domesticRelay && typeof row.domesticRelay === 'object' ? row.domesticRelay : null;
  const result = row.result && typeof row.result === 'object' ? row.result : null;
  return {
    status: nullableString(row.status) || 'unknown',
    execution: nullableString(row.execution),
    checkedAt: nullableString(row.checkedAt),
    failures: arrayValue(row.failures, []),
    error: nullableString(row.error),
    lease: lease ? {
      leaseId: nullableString(lease.leaseId),
      leaseIp: nullableString(lease.leaseIp),
      allowedIp: nullableString(lease.allowedIp),
      domesticSiteId: nullableString(lease.domesticSiteId)
    } : null,
    domesticRelay: domesticRelay ? {
      siteId: nullableString(domesticRelay.siteId),
      planId: nullableString(domesticRelay.planId),
      planStatus: nullableString(domesticRelay.planStatus),
      host: nullableString(domesticRelay.host),
      profileId: nullableString(domesticRelay.profileId),
      interfaceName: nullableString(domesticRelay.interfaceName),
      gatewayIp: nullableString(domesticRelay.gatewayIp)
    } : null,
    result: result ? {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: tailText(nullableString(result.stdout), 1600),
      stderr: tailText(nullableString(result.stderr), 1600)
    } : null
  };
}

function normalizeInternalDirectPeerSync(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const lease = row.lease && typeof row.lease === 'object' ? row.lease : null;
  const internalDirect = row.internalDirect && typeof row.internalDirect === 'object' ? row.internalDirect : null;
  const result = row.result && typeof row.result === 'object' ? row.result : null;
  return {
    status: nullableString(row.status) || 'unknown',
    execution: nullableString(row.execution),
    checkedAt: nullableString(row.checkedAt),
    message: nullableString(row.message),
    failures: arrayValue(row.failures, []),
    error: nullableString(row.error),
    lease: lease ? {
      leaseId: nullableString(lease.leaseId),
      leaseIp: nullableString(lease.leaseIp),
      allowedIp: nullableString(lease.allowedIp)
    } : null,
    internalDirect: internalDirect ? {
      siteId: nullableString(internalDirect.siteId),
      enabled: internalDirect.enabled === true,
      endpoint: nullableString(internalDirect.endpoint),
      listenPort: typeof internalDirect.listenPort === 'number' ? internalDirect.listenPort : null,
      internalServiceIp: nullableString(internalDirect.internalServiceIp),
      publicKeyStatus: nullableString(internalDirect.publicKeyStatus)
    } : null,
    result: result ? {
      status: nullableString(result.status),
      execution: nullableString(result.execution),
      changed: result.changed === true,
      configPath: nullableString(result.configPath),
      stderr: tailText(nullableString(result.stderr), 1600),
      stdout: tailText(nullableString(result.stdout), 1600)
    } : null
  };
}

function normalizeDiagnostics(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    route: row.route && typeof row.route === 'object' ? {
      ok: row.route.ok === true,
      targetIp: nullableString(row.route.targetIp),
      interfaceName: nullableString(row.route.interfaceName),
      gateway: nullableString(row.route.gateway),
      viaLoopback: row.route.viaLoopback === true,
      expectedInterfaceName: nullableString(row.route.expectedInterfaceName),
      error: nullableString(row.route.error)
    } : null,
    endpointRoute: row.endpointRoute && typeof row.endpointRoute === 'object' ? {
      ok: row.endpointRoute.ok === true,
      endpoint: nullableString(row.endpointRoute.endpoint),
      host: nullableString(row.endpointRoute.host),
      interfaceName: nullableString(row.endpointRoute.interfaceName),
      gateway: nullableString(row.endpointRoute.gateway),
      viaProxyTun: row.endpointRoute.viaProxyTun === true,
      error: nullableString(row.endpointRoute.error)
    } : null,
    internalApi: row.internalApi && typeof row.internalApi === 'object' ? {
      ok: row.internalApi.ok === true,
      baseUrl: nullableString(row.internalApi.baseUrl),
      error: nullableString(row.internalApi.error)
    } : null,
    internalDirectPeerSync: normalizeInternalDirectPeerSync(row.internalDirectPeerSync),
    domesticPeerSync: normalizeDomesticPeerSync(row.domesticPeerSync),
    domesticRelayDiagnostics: row.domesticRelayDiagnostics && typeof row.domesticRelayDiagnostics === 'object'
      ? row.domesticRelayDiagnostics
      : null,
    systemDomainProxy: row.systemDomainProxy && typeof row.systemDomainProxy === 'object'
      ? row.systemDomainProxy
      : null,
    updatedAt: nullableString(row.updatedAt) || nowIso()
  };
}

function connectedState(input) {
  return {
    state: input.state || 'connected',
    mode: input.mode,
    localIp: input.localIp,
    routePolicy: input.routePolicy,
    subject: input.subject,
    connectedAt: input.connectedAt || nowIso(),
    leaseId: input.leaseId || null,
    snapshotId: input.snapshotId || null,
    productId: input.productId || PRODUCT_ID,
    serviceVip: input.serviceVip || null,
    internalBaseUrl: input.internalBaseUrl || null,
    internalControlIp: input.internalControlIp || null,
    domesticRelayEndpoint: input.domesticRelayEndpoint || null,
    publicKey: input.publicKey || null,
    allowedIps: arrayValue(input.allowedIps, []),
    routeCidrs: arrayValue(input.routeCidrs, []),
    routePlan: normalizeRoutePlan(input.routePlan),
    wireGuard: normalizeWireGuardSummary(input.wireGuard),
    domesticPeerSync: normalizeDomesticPeerSync(input.domesticPeerSync),
    diagnostics: normalizeDiagnostics(input.diagnostics),
    health: normalizeHealth(input.health, leasedHealth())
  };
}

function setConnecting(mode) {
  const previous = retainableConnectionSnapshot(runtime.connection);
  runtime.connection = {
    ...(previous || idleConnection()),
    state: 'connecting',
    mode
  };
  runtime.feedback = {
    tone: 'info',
    message: mode === 'employee' ? '正在刷新员工 lease。' : '正在申请游客 relay lease。'
  };
  touchRuntime(mode === 'employee' ? 'employee connecting' : 'guest connecting');
}

async function connectLauncherNetwork(input) {
  const context = await launcherContext();
  const requestTag = stringValue(input.requestTag, 'connect');
  const session = await context.launcher.connectNetwork({
    identityKind: input.identityKind,
    userId: input.userId || undefined,
    installId: context.installation.installId,
    deviceId: context.installation.deviceId,
    siteId: context.installation.siteId,
    keyPair: context.installation.keyPair,
    privateKey: context.installation.keyPair.privateKey,
    publicKey: context.installation.keyPair.publicKey,
    deviceLabel: context.installation.deviceLabel,
    platform: process.platform,
    requestedBy: REQUESTED_BY,
    requestId: makeRequestId(requestTag)
  });
  return {
    ...session,
    bootstrapResolution: context.bootstrap
  };
}

async function launcherContext() {
  const bootstrap = await resolveBootstrapEndpoint(runtime.config);
  const baseUrl = bootstrap.baseUrl;
  await applyResolvedBootstrapEndpoint(bootstrap);
  const installation = await ensureInstallation();
  const mod = await import('@qpjoy/electron-launcher');
  const launcher = mod.createElectronLauncher({
    baseUrl,
    fetchImpl: launcherFetchForBootstrap(bootstrap.resolveMode),
    productId: PRODUCT_ID,
    mode: 'standalone',
    installId: installation.installId,
    deviceId: installation.deviceId,
    siteId: installation.siteId,
    keyPair: installation.keyPair,
    privateKey: installation.keyPair.privateKey,
    publicKey: installation.keyPair.publicKey,
    deviceLabel: installation.deviceLabel
  });
  await ensureMxH2iProduct(launcher);
  return { baseUrl, bootstrap, installation, launcher };
}

async function ensureInstallation() {
  const current = normalizeInstallation(runtime.installation);
  let keyPair = current.keyPair;
  if (!keyPair) {
    const mod = await import('@qpjoy/electron-launcher');
    keyPair = mod.createLauncherWireGuardKeyPair();
  }
  const now = nowIso();
  const installation = {
    installId: current.installId || `inst_mxh2i_${shortId()}`,
    deviceId: current.deviceId || `dev_mxh2i_${shortId()}`,
    siteId: current.siteId,
    deviceLabel: current.deviceLabel,
    keyPair,
    createdAt: current.createdAt || now,
    updatedAt: now
  };
  runtime.installation = installation;
  return installation;
}

async function ensureMxH2iProduct(launcher) {
  try {
    const product = await launcher.getProduct(PRODUCT_ID);
    if (product.enabled === false) throw new Error('MX-H2I 尚未在 Internal 后台启用。');
    return product;
  } catch (err) {
    if (err?.status && err.status !== 404) throw err;
    if (!err?.status && !/404/.test(err?.message || '')) throw err;
  }
  return launcher.upsertProduct(PRODUCT_ID, {
    productId: PRODUCT_ID,
    displayName: 'MX-H2I',
    mode: 'standalone',
    serviceVip: '10.88.100.1',
    userCidr: '10.89.0.0/16',
    anonymousCidr: '10.89.0.0/16',
    defaultDomesticSiteId: 'domestic-main',
    defaultOverseaSiteId: 'oversea-main',
    updatePolicy: 'launcher-managed',
    enabled: true,
    requestedBy: REQUESTED_BY,
    requestId: makeRequestId('product')
  });
}

async function applyNetworkSession(session, options) {
  wireGuardConnectInFlight = true;
  const lease = session.lease || {};
  const bootstrapResolution = normalizeBootstrapResolution(session.bootstrapResolution);
  const bootstrapResolveMode = bootstrapResolution?.resolveMode || runtime.config.bootstrapResolveMode;
  const feedback = bootstrapResolution?.fallback?.message
    ? `${options.feedback} ${bootstrapResolution.fallback.message}`
    : options.feedback;
  try {
    const routePlan = normalizeRoutePlan(session.routePlan);
    const wireGuard = session.wireGuard || {};
    const privateKey = nullableString(wireGuard.privateKey) || runtime.installation?.keyPair?.privateKey;
    const publicKey = nullableString(wireGuard.publicKey) || runtime.installation?.keyPair?.publicKey || lease.publicKey;
    const now = nowIso();
    runtime.installation = normalizeInstallation({
      ...runtime.installation,
      installId: lease.installId || runtime.installation?.installId,
      deviceId: lease.deviceId || runtime.installation?.deviceId,
      siteId: lease.siteId || runtime.installation?.siteId,
      privateKey,
      publicKey,
      updatedAt: now,
      createdAt: runtime.installation?.createdAt || now
    });
    const overlayInternalBaseUrl = internalOverlayBaseUrl(routePlan, runtime.config.internalApiBaseUrl);
    runtime.connection = connectedState({
      state: 'lease-only',
      mode: options.mode,
      localIp: routePlan?.leaseIp || lease.leaseIp,
      routePolicy: options.routePolicy,
      subject: options.subject,
      leaseId: lease.leaseId,
      snapshotId: routePlan?.snapshotId || session.snapshot?.snapshotId,
      productId: routePlan?.productId || lease.productId,
      serviceVip: routePlan?.serviceVip || lease.serviceVip,
      internalBaseUrl: overlayInternalBaseUrl,
      internalControlIp: routePlan?.internalControlIp || null,
      domesticRelayEndpoint: routePlan?.domesticRelayEndpoint || null,
      publicKey,
      allowedIps: routePlan?.allowedIps || [],
      routeCidrs: routePlan?.routeCidrs || [],
      routePlan,
      health: leasedHealth()
    });
    runtime.identity = options.identity;
    runtime.auth = normalizeAuth(options.auth);
    runtime.feedback = {
      tone: 'info',
      message: `${feedback} 正在启动客户端 WireGuard。`
    };
    touchRuntime(options.mode === 'employee' ? 'employee lease ready' : 'guest lease ready');

    const domesticPeerSync = await syncDomesticPeerForLease(lease, { bootstrapResolveMode });
    const internalDirectPeerSync = await syncInternalDirectPeerForLease(lease, routePlan, { bootstrapResolveMode });
    const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease(lease, { bootstrapResolveMode });
    const wireGuardResult = await startWireGuardForSession({
      routePlan,
      privateKey,
      internalBaseUrl: overlayInternalBaseUrl,
      internalDirectPeerSync,
      domesticPeerSync,
      domesticRelayDiagnostics
    });
    runtime.connection = {
      ...runtime.connection,
      state: wireGuardResult.state,
      health: wireGuardResult.health,
      wireGuard: wireGuardResult.wireGuard,
      domesticPeerSync,
      diagnostics: wireGuardResult.diagnostics
    };
    const systemDomainProxy = wireGuardResult.ready
      ? await ensureSystemDomainProxyForRuntime('post-connect')
      : await disableSystemDomainProxyForRuntime('wireguard-not-ready');
    if (systemDomainProxy) {
      runtime.connection = {
        ...runtime.connection,
        diagnostics: {
          ...(runtime.connection.diagnostics || {}),
          systemDomainProxy
        }
      };
    }
    const resolverFeedback = arrayValue(systemDomainProxy?.resolverDomains, []).length > 0 && systemDomainProxy?.resolverApplied
      ? ' 系统 dynamic split DNS 已接管命令行和其它非 PAC 应用的域名解析。'
      : systemDomainProxy?.resolverError
        ? ` 系统 split DNS 未启用：${systemDomainProxy.resolverError}`
        : '';
    const pacFeedback = systemDomainProxy?.applied
      ? ` 系统 PAC 已将 Internal 域名接入本机 ${localEdgeProxy()}，其它流量回落到原系统代理。${resolverFeedback}`
      : systemDomainProxy?.error
        ? ` 系统 PAC 未启用：${systemDomainProxy.error}`
        : '';
    runtime.feedback = {
      tone: wireGuardResult.ready ? 'success' : 'warning',
      message: wireGuardResult.ready
        ? `${feedback} 客户端 WireGuard 已通过 ${wireGuardPathLabel(wireGuardResult.path)} 探测 Internal。${pacFeedback}`
        : `${feedback} 已保留租约，但客户端 WireGuard 还未 ready：${wireGuardResult.message}`
    };
    touchRuntime(wireGuardResult.ready
      ? (options.mode === 'employee' ? 'employee wireguard connected' : 'guest wireguard connected')
      : 'wireguard lease only');
    if (!wireGuardResult.ready) {
      scheduleWireGuardRecovery('post-connect-probe', [1500, 4000, 9000]);
    }
  } finally {
    wireGuardConnectInFlight = false;
  }
}

function applyConnectionError(label, err) {
  const previous = retainableConnectionSnapshot(runtime.connection);
  const classified = classifyConnectionError(err);
  runtime.connection = {
    ...(previous || idleConnection()),
    state: classified.state,
    mode: previous?.mode || runtime.connection?.mode || 'guest'
  };
  runtime.auth = null;
  runtime.feedback = {
    tone: 'danger',
    message: `${label}：${classified.message}`
  };
  touchRuntime(`${label} failed`);
}

async function startWireGuardForSession(input) {
  const routePlan = normalizeRoutePlan(input.routePlan);
  const privateKey = nullableString(input.privateKey);
  const internalDirectPeerSync = normalizeInternalDirectPeerSync(input.internalDirectPeerSync);
  const domesticPeerSync = normalizeDomesticPeerSync(input.domesticPeerSync);
  const domesticRelayDiagnostics = input.domesticRelayDiagnostics || null;
  if (!routePlan) return wireGuardFailure('launcher routePlan 缺失。');
  if (!privateKey) return wireGuardFailure('本机 WireGuard privateKey 缺失。');

  try {
    const mod = await import('@qpjoy/electron-launcher/wireguard');
    const internalBaseUrl = internalOverlayBaseUrl(routePlan, input.internalBaseUrl);
    const configuredPreference = normalizeRoutePathPreference(runtime.config.routePathPreference);
    const pathPreference = effectiveWireGuardPathPreference(routePlan, internalDirectPeerSync, configuredPreference);
    let attempt = await connectAndProbeWireGuardPath(mod, {
      routePlan,
      privateKey,
      internalBaseUrl,
      pathPreference
    });
    const { result, route, endpointRoute, internalApi, ready } = attempt;
    const tunnelReady = result.ok === true;
    const domesticRelayReady = domesticRelayDiagnostics?.status === 'passed' || domesticPeerSync?.status === 'passed' || route.ok === true;
    return {
      state: ready ? 'connected' : (tunnelReady ? 'tunnel-only' : 'lease-only'),
      ready,
      health: ready ? readyHealth() : {
        wireGuard: result.ok === true ? 'ready' : 'blocked',
        domesticRelay: domesticRelayReady ? 'ready' : domesticPeerSync?.status === 'failed' || domesticPeerSync?.status === 'blocked' ? 'blocked' : 'pending',
        internalApi: internalApiHealthStatus(route, internalApi),
        splitDns: route.ok === true ? 'ready' : 'pending',
        appBroker: 'ready'
      },
      wireGuard: summarizeWireGuardResult(result),
      diagnostics: {
        route,
        endpointRoute,
        internalApi,
        internalDirectPeerSync,
        domesticPeerSync,
        domesticRelayDiagnostics,
        updatedAt: nowIso()
      },
      path: result.peer?.path || routePathFromPreference(attempt.pathPreference),
      message: ready ? 'ready' : wireGuardNotReadyMessage(result, route, internalApi, internalDirectPeerSync, domesticPeerSync, domesticRelayDiagnostics)
    };
  } catch (err) {
    return wireGuardFailure(errorMessage(err));
  }
}

async function connectAndProbeWireGuardPath(mod, input) {
  const result = await mod.connectLauncherWireGuardPeer({
    ...wireGuardRuntimeOptions(),
    routePlan: input.routePlan,
    privateKey: input.privateKey,
    dnsDomains: splitDnsDomains(runtime.config),
    pathPreference: input.pathPreference,
    action: 'restart'
  });
  const status = result.status || {};
  const targetIp = internalTargetIp(input.routePlan, input.internalBaseUrl);
  const endpointRoute = mod.probeLauncherWireGuardEndpoint({
    endpoint: result.peer?.endpoint || endpointForRoutePreference(input.routePlan, input.pathPreference)
  });
  const route = mod.probeLauncherWireGuardRoute({
    ...wireGuardRuntimeOptions(),
    targetIp,
    expectedInterfaceName: status.realInterfaceName || status.interfaceName || null,
    expectedInterfaceAddresses: status.addresses || []
  });
  const tunnelProofReady = result.ok === true || route.ok === true || wireGuardStatusCanUseInterfaceFallback(status);
  const routeReady = route.ok === true || routeProbeCanFallbackToInternalApi(route, tunnelProofReady);
  const internalApi = routeReady
    ? await probeInternalApiViaOverlay(input.internalBaseUrl)
    : internalApiProbeBlockedByRoute(input.internalBaseUrl, targetIp, route);
  return {
    pathPreference: input.pathPreference,
    result,
    route,
    endpointRoute,
    internalApi,
    ready: tunnelProofReady && routeReady && internalApi.ok === true
  };
}

async function probeWireGuardForConnection(input) {
  const connection = input.connection || {};
  const routePlan = normalizeRoutePlan(input.routePlan || connection.routePlan);
  const internalDirectPeerSync = normalizeInternalDirectPeerSync(input.internalDirectPeerSync || connection.diagnostics?.internalDirectPeerSync);
  const domesticPeerSync = normalizeDomesticPeerSync(input.domesticPeerSync || connection.domesticPeerSync);
  const domesticRelayDiagnostics = input.domesticRelayDiagnostics || connection.diagnostics?.domesticRelayDiagnostics || null;
  if (!routePlan) return wireGuardFailure('launcher routePlan 缺失。');

  try {
    const mod = await import('@qpjoy/electron-launcher/wireguard');
    const internalBaseUrl = internalOverlayBaseUrl(routePlan, input.internalBaseUrl || connection.internalBaseUrl);
    const status = mod.getLauncherWireGuardPeerStatus(wireGuardRuntimeOptions());
    const wireGuard = summarizeWireGuardStatus(status, connection);
    const targetIp = internalTargetIp(routePlan, internalBaseUrl);
    const endpointRoute = mod.probeLauncherWireGuardEndpoint({
      endpoint: wireGuard.endpoint || endpointForRoutePreference(routePlan, wireGuard.path)
    });
    const expectedInterfaceName = status?.realInterfaceName || status?.interfaceName || wireGuard.realInterfaceName || wireGuard.interfaceName || null;
    const route = mod.probeLauncherWireGuardRoute({
      ...wireGuardRuntimeOptions(),
      targetIp,
      expectedInterfaceName,
      expectedInterfaceAddresses: status?.addresses || []
    });
    const tunnelProofReady = status?.active === true || route.ok === true || wireGuardStatusCanUseInterfaceFallback(status);
    const routeReady = route.ok === true || routeProbeCanFallbackToInternalApi(route, tunnelProofReady);
    const internalApi = routeReady
      ? await probeInternalApiViaOverlay(internalBaseUrl)
      : internalApiProbeBlockedByRoute(internalBaseUrl, targetIp, route);
    const tunnelReady = tunnelProofReady;
    const ready = tunnelReady && routeReady && internalApi.ok === true;
    const domesticRelayReady = domesticRelayDiagnostics?.status === 'passed' || domesticPeerSync?.status === 'passed' || route.ok === true;
    const resultLike = {
      ok: tunnelReady,
      status,
      peer: {
        endpoint: connection.domesticRelayEndpoint,
        path: wireGuard.path,
        allowedIps: connection.routeCidrs,
        configPath: wireGuard.configPath
      },
      tunnel: {
        message: status?.error || wireGuard.message
      },
      message: status?.error || wireGuard.message
    };
    return {
      state: ready ? 'connected' : (tunnelReady ? 'tunnel-only' : 'lease-only'),
      ready,
      health: ready ? readyHealth() : {
        wireGuard: tunnelReady ? 'ready' : 'blocked',
        domesticRelay: domesticRelayReady ? 'ready' : domesticPeerSync?.status === 'failed' || domesticPeerSync?.status === 'blocked' ? 'blocked' : 'pending',
        internalApi: internalApiHealthStatus(route, internalApi),
        splitDns: route.ok === true ? 'ready' : 'pending',
        appBroker: 'ready'
      },
      wireGuard,
      diagnostics: {
      route,
      endpointRoute,
      internalApi,
      internalDirectPeerSync,
      domesticPeerSync,
      domesticRelayDiagnostics,
      updatedAt: nowIso()
      },
      message: ready ? 'ready' : wireGuardNotReadyMessage(resultLike, route, internalApi, internalDirectPeerSync, domesticPeerSync, domesticRelayDiagnostics)
    };
  } catch (err) {
    return wireGuardFailure(errorMessage(err));
  }
}

async function syncDomesticPeerForLease(lease, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  if (!leaseId) {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      failures: ['leaseId missing before Domestic peer sync']
    };
  }
  try {
    const payload = await requestJson(joinApiUrl(runtime.config.bootstrapApiBaseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-peer/sync`), {
      method: 'POST',
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('domestic-peer-sync')
      },
      timeoutMs: 18000,
      bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
    });
    return normalizeDomesticPeerSync(payload?.domesticPeerSync) || {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      failures: ['Domestic peer sync returned an empty payload']
    };
  } catch (err) {
    return {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      error: errorMessage(err),
      failures: [errorMessage(err)]
    };
  }
}

async function syncInternalDirectPeerForLease(lease, routePlan, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  const plan = normalizeRoutePlan(routePlan);
  if (!leaseId) {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      failures: ['leaseId missing before Internal direct peer sync']
    };
  }
  if (!routePlanHasDirect(plan) && runtime.config.routePathPreference !== 'direct') {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      message: 'H2I direct endpoint is not configured; using Domestic relay path.',
      failures: []
    };
  }
  try {
    const payload = await requestJson(joinApiUrl(runtime.config.bootstrapApiBaseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/internal-direct-peer/sync`), {
      method: 'POST',
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('internal-direct-peer-sync')
      },
      timeoutMs: 20000,
      bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
    });
    return normalizeInternalDirectPeerSync(payload?.internalDirectPeerSync) || {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      failures: ['Internal direct peer sync returned an empty payload']
    };
  } catch (err) {
    return {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      error: errorMessage(err),
      failures: [errorMessage(err)]
    };
  }
}

async function diagnoseDomesticRelayForLease(lease, options = {}) {
  const leaseId = nullableString(lease?.leaseId);
  if (!leaseId) {
    return {
      status: 'skipped',
      execution: 'not-started',
      checkedAt: nowIso(),
      failures: ['leaseId missing before Domestic relay diagnostics']
    };
  }
  try {
    const payload = await requestJson(joinApiUrl(runtime.config.bootstrapApiBaseUrl, `/internal/v1/launcher-network/leases/${encodeURIComponent(leaseId)}/domestic-relay/diagnostics`), {
      method: 'POST',
      body: {
        requestedBy: REQUESTED_BY,
        requestId: makeRequestId('domestic-relay-diagnostics')
      },
      timeoutMs: 22000,
      bootstrapResolveMode: options.bootstrapResolveMode || runtime.config.bootstrapResolveMode
    });
    return payload?.domesticRelayDiagnostics || {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      failures: ['Domestic relay diagnostics returned an empty payload']
    };
  } catch (err) {
    return {
      status: 'failed',
      execution: 'failed',
      checkedAt: nowIso(),
      error: errorMessage(err),
      failures: [errorMessage(err)]
    };
  }
}

async function refreshWireGuardDiagnostics() {
  const connection = runtime.connection || {};
  const routePlan = normalizeRoutePlan(connection.routePlan);
  if (!routePlan || !connection.leaseId) {
    runtime.feedback = { tone: 'warning', message: '当前没有可诊断的 launcher lease。' };
    return;
  }
  const domesticPeerSync = await syncDomesticPeerForLease({ leaseId: connection.leaseId });
  const internalDirectPeerSync = await syncInternalDirectPeerForLease({ leaseId: connection.leaseId }, routePlan);
  const domesticRelayDiagnostics = await diagnoseDomesticRelayForLease({ leaseId: connection.leaseId });
  const wireGuardResult = await probeWireGuardForConnection({
    connection,
    routePlan,
    internalBaseUrl: connection.internalBaseUrl,
    internalDirectPeerSync,
    domesticPeerSync,
    domesticRelayDiagnostics
  });
  runtime.connection = {
    ...connection,
    state: wireGuardResult.state,
    health: wireGuardResult.health,
    wireGuard: wireGuardResult.wireGuard,
    domesticPeerSync,
    diagnostics: wireGuardResult.diagnostics
  };
  runtime.feedback = {
    tone: wireGuardResult.ready ? 'success' : 'warning',
    message: wireGuardResult.ready ? 'WireGuard 诊断通过，Domestic 和 Internal overlay 可达。' : `WireGuard 仍未 ready：${wireGuardResult.message}`
  };
  touchRuntime('wireguard diagnostics refreshed');
}

async function recoverWireGuardForRuntime(reason = 'manual', options = {}) {
  if (!runtime || !shouldRecoverWireGuardConnection(runtime.connection)) {
    return { ok: true, skipped: true, reason: 'connection-not-desired' };
  }
  if (wireGuardConnectInFlight || runtime.connection?.state === 'connecting') {
    return { ok: true, skipped: true, reason: 'connect-in-flight' };
  }
  if (wireGuardRecoveryInFlight) return wireGuardRecoveryInFlight;
  const manual = String(reason || '').startsWith('manual');
  const allowPrivileged = options.allowPrivileged !== false;
  if (!manual && lastWireGuardRecoveryFailureAt && Date.now() - lastWireGuardRecoveryFailureAt < 5 * 60 * 1000) {
    return { ok: true, skipped: true, reason: 'failure-cooldown' };
  }
  wireGuardRecoveryInFlight = (async () => {
    const connection = runtime.connection || {};
    const routePlan = normalizeRoutePlan(connection.routePlan);
    if (!routePlan) return { ok: true, skipped: true, reason: 'missing-route-plan' };
    try {
      const mod = await import('@qpjoy/electron-launcher/wireguard');
      if (!allowPrivileged) {
        const wireGuardResult = await probeWireGuardForConnection({
          connection,
          routePlan,
          internalBaseUrl: connection.internalBaseUrl
        });
        const shouldPersistProbe = wireGuardResult.state !== connection.state || reason !== 'interval';
        if (shouldPersistProbe) {
          runtime.connection = {
            ...connection,
            state: wireGuardResult.state,
            health: wireGuardResult.health,
            wireGuard: wireGuardResult.wireGuard,
            diagnostics: {
              ...wireGuardResult.diagnostics,
              recovery: {
                ok: wireGuardResult.ready,
                action: 'probe-only',
                reason,
                message: wireGuardResult.ready ? 'ready' : wireGuardResult.message,
                missingRoutes: [],
                updatedAt: nowIso()
              }
            }
          };
          if (wireGuardResult.ready && reason !== 'interval') {
            runtime.feedback = {
              tone: 'success',
              message: `MX-H2I 已检测到 WireGuard ready（${reason}）。`
            };
          } else if (!wireGuardResult.ready && reason !== 'interval') {
            runtime.feedback = {
              tone: 'warning',
              message: `MX-H2I 检测到 WireGuard 未 ready：${wireGuardResult.message}。请点击连接或刷新诊断进行授权修复。`
            };
          }
          touchRuntime(`wireguard probed: ${reason}`);
          await saveAndBroadcast();
        }
        return {
          ok: true,
          skipped: true,
          reason: 'privileged-recovery-disabled',
          recoveryReason: reason,
          ready: wireGuardResult.ready
        };
      }
      const recovered = await mod.recoverLauncherWireGuardPeer({
        ...wireGuardRuntimeOptions(),
        reason
      });
      if (recovered?.skipped) return recovered;
      const wireGuardResult = await probeWireGuardForConnection({
        connection,
        routePlan,
        internalBaseUrl: connection.internalBaseUrl
      });
      runtime.connection = {
        ...connection,
        state: wireGuardResult.state,
        health: wireGuardResult.health,
        wireGuard: wireGuardResult.wireGuard,
        diagnostics: {
          ...wireGuardResult.diagnostics,
          recovery: {
            ok: recovered?.ok !== false,
            action: recovered?.action || recovered?.mode || 'recover',
            reason,
            message: nullableString(recovered?.message),
            missingRoutes: arrayValue(recovered?.missingRoutes, []),
            updatedAt: nowIso()
          }
        }
      };
      runtime.feedback = {
        tone: wireGuardResult.ready ? 'success' : 'warning',
        message: wireGuardResult.ready
          ? `MX-H2I 已恢复 WireGuard 路由（${reason}）。`
          : `MX-H2I 恢复后仍未 ready：${wireGuardResult.message}`
      };
      touchRuntime(`wireguard recovered: ${reason}`);
      await saveAndBroadcast();
      if (recovered?.ok === false || !wireGuardResult.ready) lastWireGuardRecoveryFailureAt = Date.now();
      else lastWireGuardRecoveryFailureAt = 0;
      return {
        ...recovered,
        ready: wireGuardResult.ready,
        route: wireGuardResult.diagnostics?.route || null,
        internalApi: wireGuardResult.diagnostics?.internalApi || null
      };
    } catch (err) {
      lastWireGuardRecoveryFailureAt = Date.now();
      if (manual) {
        runtime.feedback = {
          tone: 'warning',
          message: `MX-H2I 恢复 WireGuard 失败：${errorMessage(err)}`
        };
        touchRuntime(`wireguard recovery failed: ${reason}`);
        await saveAndBroadcast();
      }
      return { ok: false, reason, message: errorMessage(err) };
    } finally {
      wireGuardRecoveryInFlight = null;
    }
  })();
  return wireGuardRecoveryInFlight;
}

function shouldRecoverWireGuardConnection(connection) {
  const state = connection?.state;
  return (state === 'connected' || state === 'tunnel-only' || state === 'lease-only' || state === 'server-unavailable' || state === 'network-unavailable')
    && Boolean(normalizeRoutePlan(connection.routePlan));
}

async function stopWireGuardForRuntime() {
  try {
    const mod = await import('@qpjoy/electron-launcher/wireguard');
    return await mod.stopLauncherWireGuardPeer(wireGuardRuntimeOptions());
  } catch (err) {
    return {
      ok: false,
      message: errorMessage(err)
    };
  }
}

function wireGuardRuntimeOptions() {
  return {
    userDataDir: app.getPath('userData'),
    profileName: WIREGUARD_PROFILE_NAME,
    allowSystemFallback: false
  };
}

function effectiveWireGuardPathPreference(routePlan, _internalDirectPeerSync, configuredPreference) {
  const preference = normalizeRoutePathPreference(configuredPreference);
  if (preference === 'relay') return 'relay';
  if (preference === 'direct') return 'direct';
  if (preference === 'hybrid') return 'hybrid';
  return routePlanHasDirect(routePlan) ? 'direct' : 'relay';
}

function routePathFromPreference(preference) {
  const normalized = normalizeRoutePathPreference(preference);
  if (normalized === 'direct') return 'h2i-direct';
  if (normalized === 'hybrid' || normalized === 'auto') return 'h2i-hybrid';
  return 'hdi-relay';
}

function endpointForRoutePreference(routePlan, preference) {
  const plan = normalizeRoutePlan(routePlan);
  const normalized = normalizeRoutePathPreference(preference);
  if (normalized === 'relay') return plan?.domesticRelayEndpoint || null;
  return plan?.h2iDirectEndpoint || plan?.domesticRelayEndpoint || null;
}

function wireGuardPathLabel(path) {
  if (path === 'h2i-direct') return 'H2I direct';
  if (path === 'h2i-hybrid') return 'H2I hybrid';
  return 'Domestic relay';
}

function routePlanHasDirect(routePlan) {
  const plan = normalizeRoutePlan(routePlan);
  return plan?.h2iDirectEnabled === true
    && Boolean(plan.h2iDirectEndpoint)
    && Boolean(plan.h2iDirectPublicKey);
}

async function probeInternalApiViaOverlay(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return {
      ok: false,
      baseUrl: null,
      error: 'Internal API baseUrl 为空。'
    };
  }
  try {
    await requestJson(joinApiUrl(normalized, '/healthz'), { timeoutMs: 2200 });
    return {
      ok: true,
      baseUrl: normalized,
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      baseUrl: normalized,
      error: errorMessage(err)
    };
  }
}

function internalApiProbeBlockedByRoute(baseUrl, targetIp, route) {
  const routeLabel = route?.interfaceName || route?.error || 'unknown route';
  return {
    ok: false,
    baseUrl: normalizeBaseUrl(baseUrl),
    error: route?.viaLoopback
      ? `route to ${targetIp} is local loopback (${routeLabel}); same-host Internal/client test shadows H2I route proof`
      : `route to ${targetIp} is not on WireGuard (${routeLabel})`
  };
}

function routeProbeCanFallbackToInternalApi(route, tunnelReady) {
  if (!tunnelReady || route?.ok === true) return false;
  const error = `${route?.error || ''}\n${route?.raw || ''}`;
  return /operation not permitted|not permitted|permission denied|requires elevated access/i.test(error);
}

function wireGuardStatusCanUseInterfaceFallback(status) {
  const error = `${status?.error || ''}\n${status?.message || ''}`;
  if (!/wg show requires elevated access|requires elevated access/i.test(error)) return false;
  return Boolean(status?.ifconfig || status?.realInterfaceName || status?.interfaceName);
}

function internalApiHealthStatus(route, internalApi) {
  if (internalApi?.ok === true) return 'ready';
  if (route?.viaLoopback) return 'local-route';
  return 'blocked';
}

function wireGuardFailure(message) {
  return {
    state: 'lease-only',
    ready: false,
    health: blockedHealth(),
    wireGuard: {
      ok: false,
      active: false,
      mode: null,
      interfaceName: null,
      realInterfaceName: null,
    configPath: null,
    endpoint: null,
    path: null,
    allowedIps: [],
      statusError: null,
      serviceState: null,
      routeLogPath: null,
      routeLogTail: null,
      peers: [],
      routes: [],
      message,
      error: message,
      updatedAt: nowIso()
    },
    diagnostics: {
      route: null,
      internalApi: null,
      updatedAt: nowIso()
    },
    message
  };
}

function summarizeWireGuardResult(result) {
  const status = result?.status || {};
  const peer = result?.peer || {};
  const tunnel = result?.tunnel || {};
  const message = nullableString(result?.message) || nullableString(tunnel.message);
  return {
    ok: result?.ok === true,
    active: status.active === true,
    mode: nullableString(status.mode) || nullableString(result?.runtime?.method),
    interfaceName: nullableString(status.interfaceName),
    realInterfaceName: nullableString(status.realInterfaceName),
    configPath: nullableString(peer.configPath) || nullableString(tunnel.configPath),
    endpoint: nullableString(peer.endpoint),
    path: nullableString(peer.path),
    allowedIps: arrayValue(peer.allowedIps, arrayValue(status.allowedIps, [])),
    statusError: nullableString(status.error),
    serviceState: nullableString(status.serviceState),
    routeLogPath: nullableString(status.routeLogPath) || nullableString(tunnel.routeLogPath),
    routeLogTail: tailText(nullableString(status.routeLogTail) || nullableString(tunnel.routeLogTail), 1600),
    peers: Array.isArray(status.peers) ? status.peers : [],
    routes: Array.isArray(status.routes) ? status.routes : [],
    message,
    error: result?.ok === true ? null : message,
    updatedAt: nowIso()
  };
}

function summarizeWireGuardStatus(status, connection = {}) {
  const previous = connection?.wireGuard || {};
  const message = nullableString(status?.error) || nullableString(previous.message);
  return {
    ok: status?.ok !== false,
    active: status?.active === true,
    mode: nullableString(status?.mode) || nullableString(previous.mode),
    interfaceName: nullableString(status?.interfaceName) || nullableString(previous.interfaceName),
    realInterfaceName: nullableString(status?.realInterfaceName) || nullableString(previous.realInterfaceName),
    configPath: nullableString(status?.configPath) || nullableString(previous.configPath),
    endpoint: nullableString(previous.endpoint) || nullableString(connection?.domesticRelayEndpoint),
    path: nullableString(previous.path),
    allowedIps: arrayValue(status?.allowedIps, arrayValue(previous.allowedIps, arrayValue(connection?.routeCidrs, []))),
    statusError: nullableString(status?.error),
    serviceState: nullableString(status?.serviceState) || nullableString(previous.serviceState),
    routeLogPath: nullableString(status?.routeLogPath) || nullableString(previous.routeLogPath),
    routeLogTail: tailText(nullableString(status?.routeLogTail) || nullableString(previous.routeLogTail), 1600),
    peers: Array.isArray(status?.peers) ? status.peers : (Array.isArray(previous.peers) ? previous.peers : []),
    routes: Array.isArray(status?.routes) ? status.routes : (Array.isArray(previous.routes) ? previous.routes : []),
    message,
    error: status?.ok === false ? message : null,
    updatedAt: nowIso()
  };
}

function wireGuardNotReadyMessage(result, route, internalApi, internalDirectPeerSync, domesticPeerSync, domesticRelayDiagnostics) {
  const peerPath = nullableString(result?.peer?.path);
  if ((peerPath === 'h2i-direct' || peerPath === 'h2i-hybrid') && (internalDirectPeerSync?.status === 'failed' || internalDirectPeerSync?.status === 'blocked')) {
    const reason = internalDirectPeerSync.failures?.[0] || internalDirectPeerSync.error || internalDirectPeerSync.status;
    return `Internal direct peer 未同步：${reason}`;
  }
  if (domesticPeerSync?.status === 'failed' || domesticPeerSync?.status === 'blocked') {
    const reason = domesticPeerSync.failures?.[0] || domesticPeerSync.error || domesticPeerSync.status;
    return `Domestic relay peer 未同步：${reason}`;
  }
  if (domesticRelayDiagnostics?.status === 'failed' || domesticRelayDiagnostics?.status === 'blocked') {
    const reasons = Array.isArray(domesticRelayDiagnostics.blockedReasons)
      ? domesticRelayDiagnostics.blockedReasons
      : Array.isArray(domesticRelayDiagnostics.failures)
        ? domesticRelayDiagnostics.failures
        : [];
    return `Domestic relay 诊断未通过：${reasons[0] || domesticRelayDiagnostics.error || domesticRelayDiagnostics.status}`;
  }
  if (result?.ok !== true) return nullableString(result?.message) || nullableString(result?.tunnel?.message) || 'WireGuard tunnel 未启动。';
  if (route?.ok !== true) {
    if (route?.viaLoopback) return `到 ${route?.targetIp || INTERNAL_PEER_IP} 当前走 lo0，本机 Internal/客户端同机测试会覆盖 overlay 路由。`;
    if (route?.interfaceName && route?.expectedInterfaceName) {
      return `到 ${route.targetIp || INTERNAL_PEER_IP} 当前走 ${route.interfaceName}，期望 ${route.expectedInterfaceName}；可能被系统代理或其它 utun 规则抢先。`;
    }
    return `到 ${route?.targetIp || INTERNAL_PEER_IP} 的路由没有走 MX-H2I WireGuard。`;
  }
  if (internalApi?.ok !== true) return `Internal API overlay 探测失败：${internalApi?.error || 'unknown'}`;
  return 'WireGuard 未 ready。';
}

function internalOverlayBaseUrl(routePlan, fallbackBaseUrl) {
  const internalIp = nullableString(routePlan?.internalControlIp) || INTERNAL_PEER_IP;
  const port = portFromBaseUrl(routePlan?.internalBaseUrl) || portFromBaseUrl(fallbackBaseUrl) || '18090';
  return `http://${internalIp}:${port}`;
}

function internalTargetIp(routePlan, baseUrl) {
  const routePlanIp = nullableString(routePlan?.internalControlIp);
  if (routePlanIp) return routePlanIp;
  try {
    const hostname = new URL(normalizeBaseUrl(baseUrl) || '').hostname;
    return hostname || INTERNAL_PEER_IP;
  } catch {
    return INTERNAL_PEER_IP;
  }
}

function portFromBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return null;
  }
}

async function authenticateUserViaGateway(baseUrl, account, password, requestOptions = {}) {
  const tokenPayload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/sdk/oauth/token'), {
    method: 'POST',
    timeoutMs: 5000,
    bootstrapResolveMode: requestOptions.bootstrapResolveMode,
    body: {
      grant_type: 'password',
      username: account,
      password,
      audience: 'mx-sdk',
      scope: 'auth.read appcenter.read network.hdi.status network.proxy.app network.dns.policy',
      requestId: makeRequestId('oauth')
    }
  });
  const token = tokenPayload?.token || tokenPayload;
  const principal = token?.principal && typeof token.principal === 'object' ? token.principal : {};
  const userId = nullableString(principal.userId) || parseUserIdFromSubject(token?.subject);
  if (!userId) throw new Error('OAuth token 没有返回 user principal。');
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    issuedTokenType: token.issued_token_type,
    issuer: token.issuer,
    audience: token.audience,
    subject: token.subject,
    expiresAt: token.expires_at,
    scopes: typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : [],
    user: {
      userId,
      displayName: nullableString(principal.displayName) || displayNameFromAccount(account),
      email: account.includes('@') ? account : null
    }
  };
}

async function resolveBootstrapBaseUrl(config) {
  return (await resolveBootstrapEndpoint(config)).baseUrl;
}

async function resolveBootstrapEndpoint(config) {
  const requestedMode = normalizeBootstrapResolveMode(config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  const seeds = [
    normalizeBaseUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL),
    normalizeBaseUrl(config.bootstrapApiBaseUrl),
    defaultBootstrapApiBaseUrl(),
    normalizeBaseUrl(process.env.MX_H2I_PUBLIC_BASE_URL),
    normalizeBaseUrl(process.env.MX_H2I_INTERNAL_BASE_URL),
    normalizeBaseUrl(config.internalApiBaseUrl)
  ].filter(Boolean);
  const candidates = bootstrapBaseUrlCandidates(seeds);
  const failures = [];
  for (const candidate of candidates) {
    for (const resolveMode of bootstrapResolveAttempts(candidate, config)) {
      try {
        await probeBootstrapApiBaseUrl(candidate, { bootstrapResolveMode: resolveMode });
        return {
          baseUrl: candidate,
          resolveMode,
          fallback: bootstrapResolveFallback(requestedMode, resolveMode, failures)
        };
      } catch (err) {
        failures.push({
          candidate,
          resolveMode,
          error: err,
          override: hostResolveOverride(candidate, { bootstrapResolveMode: resolveMode })
        });
      }
    }
  }
  throw new Error(`无法连接 bootstrap API：${summarizeBootstrapProbeFailures(failures)}`);
}

function bootstrapResolveAttempts(candidate, config) {
  const mode = normalizeBootstrapResolveMode(config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  const hasHostOverride = Boolean(hostResolveOverride(candidate, { bootstrapResolveMode: 'env-only' }));
  if (mode === 'env-only') return ['env-only'];
  if (mode === 'dns-only') return ['dns-only'];
  if (mode === 'system-only') return ['system-only'];
  if (mode === 'dns-first') return uniqueValues([
    'dns-only',
    ...(hasHostOverride ? ['env-only'] : []),
    'system-only'
  ]);
  return uniqueValues([
    ...(hasHostOverride ? ['env-only'] : []),
    'system-only',
    'dns-only'
  ]);
}

function bootstrapBaseUrlCandidates(seeds) {
  const expanded = [];
  for (const seed of seeds) {
    const normalized = normalizeBaseUrl(seed);
    if (!normalized) continue;
    expanded.push(normalized);
    expanded.push(...bootstrapPortVariantUrls(normalized));
  }
  expanded.push(
    ...LOCAL_INTERNAL_BASE_URLS,
    ...LOCAL_INTERNAL_BASE_URLS.flatMap((baseUrl) => bootstrapPortVariantUrls(baseUrl))
  );
  return uniqueValues(expanded.map((value) => normalizeBaseUrl(value)).filter(Boolean));
}

function bootstrapPortVariantUrls(baseUrl) {
  let parsed;
  try {
    parsed = new URL(normalizeBaseUrl(baseUrl) || '');
  } catch {
    return [];
  }
  const protocol = parsed.protocol.replace(/:$/, '') === 'https' ? 'https' : 'http';
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  if (!host) return [];
  return bootstrapPortCandidates(parsed.port, protocol).map((port) => {
    const defaultPort = protocol === 'https' ? '443' : '80';
    return `${protocol}://${host}${String(port) === defaultPort ? '' : `:${port}`}`;
  });
}

function bootstrapPortCandidates(primaryPort, protocol) {
  return uniqueValues([
    ...parseBootstrapPortList(process.env.MX_H2I_BOOTSTRAP_PORTS),
    nullableString(process.env.MX_H2I_BOOTSTRAP_PORT),
    nullableString(primaryPort),
    '18090',
    '8088',
    protocol === 'https' ? '443' : '80'
  ].filter(Boolean))
    .map((port) => String(port).trim())
    .filter((port) => {
      const number = Number(port);
      return Number.isFinite(number) && number > 0 && number <= 65535;
    });
}

function parseBootstrapPortList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function bootstrapResolveFallback(requestedMode, resolveMode, failures) {
  if (requestedMode !== 'dns-first' || resolveMode === 'dns-only') return null;
  const dnsFailures = failures.filter((failure) => failure.resolveMode === 'dns-only' && isBootstrapDnsFailure(failure.error));
  if (!dnsFailures.length) return null;
  const retryCount = Math.max(
    BOOTSTRAP_DNS_RETRY_LIMIT,
    ...dnsFailures.map((failure) => Number(failure.error?.dnsRetryCount) || 0)
  );
  return {
    from: 'dns-first',
    to: resolveMode,
    retryCount,
    message: `Bootstrap DNS 连续 ${retryCount} 次未成功，已临时降级到 ${bootstrapResolveModeLabel(resolveMode)} 继续建立 HDI。`
  };
}

function isBootstrapDnsFailure(err) {
  if (!err) return false;
  if (err.code === 'MX_BOOTSTRAP_DNS_FAILED' || err.code === 'MX_BOOTSTRAP_DNS_TIMEOUT') return true;
  return isBootstrapDnsFailure(err.cause);
}

function bootstrapResolveModeLabel(mode) {
  if (mode === 'env-only' || mode === 'env-first') return 'Host Resolve/env-first';
  if (mode === 'system-only') return '系统默认网络/系统代理';
  if (mode === 'dns-only' || mode === 'dns-first') return 'Bootstrap DNS';
  return String(mode || '默认网络');
}

function summarizeBootstrapProbeFailures(failures) {
  const rows = failures.slice(0, 8).map((failure) => {
    const dialUrl = failure.override?.url || failure.error?.dialUrl;
    const resolved = dialUrl && dialUrl !== failure.candidate
      ? ` -> ${dialUrl}`
      : '';
    const mode = bootstrapResolveModeShortLabel(failure.resolveMode);
    return `[${mode}] ${failure.candidate}${resolved}: ${errorMessage(failure.error)}`;
  });
  const hidden = failures.length > rows.length ? `；另有 ${failures.length - rows.length} 个候选失败` : '';
  const hostResolveHint = bootstrapHostResolveHint(failures);
  return `${rows.join('；')}${hidden}${hostResolveHint}`;
}

function bootstrapResolveModeShortLabel(mode) {
  if (mode === 'env-only' || mode === 'env-first') return 'env';
  if (mode === 'system-only') return 'system';
  return 'dns';
}

function bootstrapHostResolveHint(failures) {
  const apiFailures = failures.filter((failure) => {
    try {
      return new URL(failure.candidate).hostname === 'api.mxinfo-inc.cn';
    } catch {
      return false;
    }
  });
  if (!apiFailures.length) return '';
  const hasOverride = apiFailures.some((failure) => failure.override);
  if (hasOverride) return '';
  return '；Host Resolve 未命中 api.mxinfo-inc.cn，请在 .env 或高级选项设置 MX_H2I_HOST_RESOLVE=api.mxinfo-inc.cn=<Domestic公网IP>';
}

async function probeBootstrapApiBaseUrl(baseUrl, options = {}) {
  let bootstrapHealthError = null;
  try {
    await assertHealthResponse(requestJson(joinApiUrl(baseUrl, '/bootstrap-healthz'), {
      timeoutMs: 1400,
      bootstrapResolveMode: options.bootstrapResolveMode
    }));
    return;
  } catch (err) {
    bootstrapHealthError = err;
    if (!shouldFallbackToLegacyHealthz(err)) throw err;
  }
  try {
    await assertHealthResponse(requestJson(joinApiUrl(baseUrl, '/healthz'), {
      timeoutMs: 900,
      bootstrapResolveMode: options.bootstrapResolveMode
    }));
  } catch (err) {
    err.bootstrapHealthError = bootstrapHealthError;
    throw err;
  }
}

async function assertHealthResponse(promise) {
  const payload = await promise;
  if (payload && typeof payload === 'object' && payload.ok === true) return payload;
  const err = new Error('healthz 没有返回 JSON ok=true。');
  err.code = 'MX_HEALTH_PAYLOAD_UNSUPPORTED';
  err.payload = payload;
  throw err;
}

function shouldFallbackToLegacyHealthz(err) {
  if (!err) return false;
  if (err.code === 'MX_HEALTH_PAYLOAD_UNSUPPORTED') return true;
  return /^HTTP (404|405|501)\b/.test(err.message || '');
}

async function applyResolvedBootstrapBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized || normalized === runtime.config.bootstrapApiBaseUrl) return;
  runtime.config = normalizeConfig({
    ...runtime.config,
    bootstrapApiBaseUrl: normalized,
    sdkGatewayBaseUrl: sdkGatewayBaseUrl(normalized)
  });
  runtime.launcherContract = await launcherContract(runtime.config);
}

async function applyResolvedBootstrapEndpoint(bootstrap) {
  const resolution = normalizeBootstrapResolution(bootstrap);
  if (!resolution?.baseUrl) return;
  await applyResolvedBootstrapBaseUrl(resolution.baseUrl);
  if (!resolution.fallback?.message) return;
  runtime.feedback = {
    tone: 'warning',
    message: resolution.fallback.message
  };
  touchRuntime('bootstrap dns fallback');
  await saveAndBroadcast();
}

function normalizeBootstrapResolution(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  const fallback = row.fallback && typeof row.fallback === 'object' ? row.fallback : null;
  return {
    baseUrl: normalizeBaseUrl(row.baseUrl),
    resolveMode: normalizeBootstrapResolveMode(row.resolveMode),
    fallback: fallback ? {
      from: normalizeBootstrapResolveMode(fallback.from),
      to: normalizeBootstrapResolveMode(fallback.to),
      retryCount: Number.isFinite(fallback.retryCount) ? fallback.retryCount : null,
      message: nullableString(fallback.message)
    } : null
  };
}

function normalizeRoutePlan(input) {
  const row = input && typeof input === 'object' ? input : null;
  if (!row) return null;
  return {
    productId: nullableString(row.productId) || PRODUCT_ID,
    launcherMode: nullableString(row.launcherMode) || 'standalone',
    identityKind: nullableString(row.identityKind) || 'anonymous',
    leaseIp: nullableString(row.leaseIp),
    leaseCidr: nullableString(row.leaseCidr),
    serviceVip: nullableString(row.serviceVip),
    internalControlIp: nullableString(row.internalControlIp),
    internalBaseUrl: nullableString(row.internalBaseUrl),
    domesticGatewayIp: nullableString(row.domesticGatewayIp),
    domesticRelayEndpoint: nullableString(row.domesticRelayEndpoint),
    domesticRelayPublicKey: nullableString(row.domesticRelayPublicKey),
    preferredPath: normalizeRoutePlanPath(row.preferredPath),
    h2iDirectEnabled: row.h2iDirectEnabled === true,
    h2iDirectEndpoint: nullableString(row.h2iDirectEndpoint),
    h2iDirectPublicKey: nullableString(row.h2iDirectPublicKey),
    h2iDirectAllowedIps: arrayValue(row.h2iDirectAllowedIps, []),
    domesticSiteId: nullableString(row.domesticSiteId),
    overseaSiteId: nullableString(row.overseaSiteId),
    dnsServer: nullableString(row.dnsServer),
    allowedIps: arrayValue(row.allowedIps, []),
    routeCidrs: arrayValue(row.routeCidrs, []),
    updatePolicy: nullableString(row.updatePolicy),
    rateLimitProfile: nullableString(row.rateLimitProfile),
    dnsPolicyId: nullableString(row.dnsPolicyId),
    licensePolicyId: nullableString(row.licensePolicyId),
    snapshotId: nullableString(row.snapshotId),
    snapshotDigest: nullableString(row.snapshotDigest),
    materialDigest: nullableString(row.materialDigest),
    secretUpdatedAt: nullableString(row.secretUpdatedAt),
    refreshKey: nullableString(row.refreshKey)
  };
}

async function requestJson(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  const hostOverride = await requestHostOverride(url, { bootstrapResolveMode: options.bootstrapResolveMode });
  if (hostOverride) return requestJsonWithHostOverride(hostOverride, options);
  if (resolveMode === 'system-only') return requestJsonWithSystemNetwork(url, options);
  const result = await requestTextWithFetch(url, options);
  const payload = parseJsonPayload(result.text);
  if (result.status < 200 || result.status >= 300) {
    const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
    err.payload = payload;
    throw err;
  }
  return payload;
}

function requestJsonWithHostOverride(override, options = {}) {
  return requestTextWithHostOverride(override, options).then((result) => {
    const payload = parseJsonPayload(result.text);
    if (result.status < 200 || result.status >= 300) {
      const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
      err.payload = payload;
      err.dialUrl = override.url;
      err.originalUrl = override.originalUrl;
      err.bootstrapResolveMode = override.resolveMode;
      throw err;
    }
    return payload;
  });
}

function requestJsonWithSystemNetwork(url, options = {}) {
  return requestTextWithSystemNetwork(url, options).then((result) => {
    const payload = parseJsonPayload(result.text);
    if (result.status < 200 || result.status >= 300) {
      const err = new Error(`HTTP ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
      err.payload = payload;
      err.originalUrl = url;
      err.bootstrapResolveMode = 'system-only';
      throw err;
    }
    return payload;
  });
}

function launcherFetchForBootstrap(resolveMode) {
  const mode = normalizeBootstrapResolveMode(resolveMode);
  return async (url, init = {}) => {
    const hostOverride = await requestHostOverride(String(url), { bootstrapResolveMode: mode });
    if (!hostOverride) {
      if (mode === 'system-only') {
        const result = await requestTextWithSystemNetwork(String(url), {
          method: init.method || 'GET',
          headers: init.headers,
          body: init.body,
          timeoutMs: 10000
        });
        return new Response(result.text, {
          status: result.status,
          statusText: result.statusText,
          headers: result.headers
        });
      }
      if (typeof fetch !== 'function') throw new Error('当前 Electron 运行时没有 fetch。');
      return fetch(url, init);
    }
    const result = await requestTextWithHostOverride(hostOverride, {
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body,
      timeoutMs: 10000
    });
    return new Response(result.text, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers
    });
  };
}

function requestTextWithHostOverride(override, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(override.url);
    const method = requestMethod(options.method);
    const body = requestBodyForMethod(method, options.body);
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const headers = {
      ...normalizeRequestHeaders(options.headers),
      accept: 'application/json',
      host: override.hostHeader,
      ...(override.originalHostHeader ? {
        'x-forwarded-host': override.originalHostHeader,
        'x-mx-bootstrap-host': override.originalHostHeader,
        'x-mx-bootstrap-domain': hostnameFromUrl(override.originalUrl || '')
      } : {})
    };
    if (body !== undefined) {
      if (!hasRequestHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      if (!hasRequestHeader(headers, 'content-length')) headers['content-length'] = String(Buffer.byteLength(body));
    }
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      servername: override.servername,
      timeout
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          text,
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers
        });
      });
    });
    request.on('timeout', () => {
      const err = new Error(`请求超时：${override.originalUrl || ''} -> ${override.url}`);
      err.code = 'MX_BOOTSTRAP_TIMEOUT';
      err.dialUrl = override.url;
      err.originalUrl = override.originalUrl;
      err.bootstrapResolveMode = override.resolveMode;
      request.destroy(err);
    });
    request.on('error', (err) => {
      err.dialUrl = err.dialUrl || override.url;
      err.originalUrl = err.originalUrl || override.originalUrl;
      err.bootstrapResolveMode = err.bootstrapResolveMode || override.resolveMode;
      reject(err);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function requestTextWithSystemNetwork(url, options = {}) {
  if (!electronNet?.request) return requestTextWithFetch(url, options, 'system-only');
  try {
    return await requestTextWithElectronNet(url, options);
  } catch (err) {
    if (!isElectronNetInvalidArgument(err)) throw err;
    return requestTextWithFetch(url, options, 'system-only');
  }
}

function requestTextWithElectronNet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const method = requestMethod(options.method);
    const body = requestBodyForMethod(method, options.body);
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const headers = {
      accept: 'application/json',
      ...normalizeRequestHeaders(options.headers)
    };
    if (body !== undefined) {
      if (!hasRequestHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
      if (!hasRequestHeader(headers, 'content-length')) headers['content-length'] = String(Buffer.byteLength(body));
    }
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const request = electronNet.request({
      method,
      url
    });
    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value);
    }
    timer = setTimeout(() => {
      const err = new Error(`请求超时：${url}`);
      err.code = 'MX_BOOTSTRAP_TIMEOUT';
      err.originalUrl = url;
      err.bootstrapResolveMode = 'system-only';
      request.abort();
      finish(reject, err);
    }, timeout);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        finish(resolve, {
          text: Buffer.concat(chunks).toString('utf8'),
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers || {}
        });
      });
    });
    request.on('error', (err) => {
      err.originalUrl = err.originalUrl || url;
      err.bootstrapResolveMode = err.bootstrapResolveMode || 'system-only';
      finish(reject, err);
    });
    try {
      if (body !== undefined) request.write(body);
      request.end();
    } catch (err) {
      err.originalUrl = err.originalUrl || url;
      err.bootstrapResolveMode = err.bootstrapResolveMode || 'system-only';
      finish(reject, err);
    }
  });
}

function isElectronNetInvalidArgument(err) {
  return /ERR_INVALID_ARGUMENT|invalid argument/i.test(`${err?.code || ''} ${err?.message || ''}`);
}

async function requestTextWithFetch(url, options = {}, resolveMode = null) {
  if (typeof fetch !== 'function') throw new Error('当前 Electron 运行时没有 fetch。');
  const controller = new AbortController();
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const method = requestMethod(options.method);
    const body = requestBodyForMethod(method, options.body);
    const headers = {
      accept: 'application/json',
      ...normalizeRequestHeaders(options.headers)
    };
    if (body !== undefined && !hasRequestHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal
    });
    return {
      text: await response.text(),
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    };
  } catch (err) {
    if (resolveMode) err.bootstrapResolveMode = err.bootstrapResolveMode || resolveMode;
    err.originalUrl = err.originalUrl || url;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function requestMethod(method) {
  return String(method || 'GET').toUpperCase();
}

function requestBodyForMethod(method, body) {
  if (body === undefined || body === null) {
    return method !== 'GET' && method !== 'HEAD' ? '{}' : undefined;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  return JSON.stringify(body);
}

function normalizeRequestHeaders(headers) {
  let entries = [];
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    entries = [...headers.entries()];
  } else if (Array.isArray(headers)) {
    entries = headers;
  } else if (typeof headers === 'object') {
    entries = Object.entries(headers);
  }
  return Object.fromEntries(entries
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => [
      String(key),
      Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value)
    ]));
}

function hasRequestHeader(headers, name) {
  const lowerName = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === lowerName);
}

function visibleRuntime(source = runtime) {
  return {
    ...source,
    installation: visibleInstallation(source.installation),
    auth: visibleAuth(source.auth)
  };
}

function visibleInstallation(input) {
  const installation = normalizeInstallation(input);
  return {
    installId: installation.installId,
    deviceId: installation.deviceId,
    siteId: installation.siteId,
    deviceLabel: installation.deviceLabel,
    publicKey: installation.keyPair?.publicKey || null,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt
  };
}

function visibleAuth(input) {
  const auth = normalizeAuth(input);
  if (!auth) return null;
  return {
    tokenType: auth.tokenType,
    issuedTokenType: auth.issuedTokenType,
    issuer: auth.issuer,
    audience: auth.audience,
    subject: auth.subject,
    expiresAt: auth.expiresAt,
    scopes: auth.scopes
  };
}

async function saveAndBroadcast() {
  await saveRuntime(runtime);
  broadcastState();
}

async function saveRuntime(next) {
  await fs.mkdir(path.dirname(runtimePath()), { recursive: true });
  await fs.writeFile(runtimePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mx-h2i:state', visibleRuntime());
}

function runtimePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function touchRuntime(label) {
  runtime.updatedAt = nowIso();
  runtime.activity = [
    {
      label,
      at: runtime.updatedAt
    },
    ...runtime.activity
  ].slice(0, 8);
}

function defaultActivity() {
  return [
    {
      label: 'runtime initialized',
      at: nowIso()
    }
  ];
}

function loadDotEnvFiles() {
  const bases = uniqueValues([
    process.cwd(),
    process.env.INIT_CWD,
    path.resolve(process.cwd(), 'demos', 'mx-h2i'),
    path.resolve(process.cwd(), 'electron-dock', 'mx-launcher', 'demos', 'mx-h2i'),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app') : null,
    process.resourcesPath || null
  ].filter(Boolean));
  const candidates = uniqueValues(bases.flatMap((base) => [
    path.join(base, '.env.local'),
    path.join(base, '.env')
  ]));
  for (const file of candidates) {
    loadDotEnvFile(file);
  }
}

function loadDotEnvFile(file) {
  try {
    if (!fsSync.existsSync(file)) return;
    const raw = fsSync.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      process.env[key] = unquoteEnvValue(match[2]);
    }
  } catch {
    // A missing or unreadable local .env should not prevent the desktop app from booting.
  }
}

function unquoteEnvValue(value) {
  const trimmed = String(value ?? '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function defaultBootstrapApiBaseUrl() {
  const explicit = normalizeBaseUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL)
    || normalizeBaseUrl(process.env.MX_H2I_PUBLIC_BASE_URL);
  if (explicit) return explicit;
  const host = nullableString(process.env.MX_H2I_BOOTSTRAP_HOST)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN);
  if (!host) return '';
  const protocol = stringValue(process.env.MX_H2I_BOOTSTRAP_PROTOCOL, 'http').replace(/:$/, '');
  const port = nullableString(process.env.MX_H2I_BOOTSTRAP_PORT) || '18090';
  return `${protocol}://${host}${port ? `:${port}` : ''}`;
}

function defaultHostResolve() {
  const explicit = nullableString(process.env.MX_H2I_HOST_RESOLVE)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_HOST_RESOLVE);
  if (explicit) return explicit;
  const host = nullableString(process.env.MX_H2I_BOOTSTRAP_HOST)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DOMAIN);
  const ip = nullableString(process.env.MX_H2I_BOOTSTRAP_RESOLVE_IP)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_IP);
  return host && ip ? `${host}=${ip}` : '';
}

function defaultBootstrapResolveMode() {
  return normalizeBootstrapResolveMode(
    process.env.MX_H2I_BOOTSTRAP_RESOLVE_MODE
      || process.env.MX_H2I_BOOTSTRAP_DNS_MODE
      || (defaultHostResolve() ? 'env-first' : 'dns-first')
  );
}

function defaultBootstrapDnsServers() {
  return nullableString(process.env.MX_H2I_BOOTSTRAP_DNS_SERVERS)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DNS_SERVER)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_RESOLVE_DNS)
    || nullableString(process.env.MX_H2I_BOOTSTRAP_DNS)
    || '';
}

function normalizeBootstrapResolveMode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['env', 'env-first', 'host', 'host-first', 'host-resolve', 'host-resolve-first'].includes(text)) {
    return 'env-first';
  }
  if (['dns', 'dns-first', 'public-dns', 'system-dns', 'provider-dns'].includes(text)) {
    return 'dns-first';
  }
  if (['env-only', 'host-only', 'host-resolve-only'].includes(text)) return 'env-only';
  if (['dns-only', 'public-dns-only', 'system-dns-only', 'provider-dns-only'].includes(text)) return 'dns-only';
  if (['system', 'system-only', 'system-proxy', 'default-network'].includes(text)) return 'system-only';
  return 'env-first';
}

function normalizeRoutePathPreference(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['direct', 'h2i', 'h2i-direct'].includes(text)) return 'direct';
  if (['hybrid', 'h2i-hybrid', 'mixed', 'mix'].includes(text)) return 'hybrid';
  if (['relay', 'hdi', 'hdi-relay', 'domestic', 'domestic-relay'].includes(text)) return 'relay';
  return 'auto';
}

function normalizeRoutePlanPath(value) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (text === 'h2i-direct' || text === 'direct') return 'h2i-direct';
  if (text === 'h2i-hybrid' || text === 'hybrid') return 'h2i-hybrid';
  return 'hdi-relay';
}

async function requestHostOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  if (resolveMode === 'system-only') return null;
  if (resolveMode === 'env-first' || resolveMode === 'env-only') {
    return hostResolveOverride(url, { bootstrapResolveMode: resolveMode });
  }
  if (resolveMode === 'dns-first' || resolveMode === 'dns-only') {
    return bootstrapDnsResolveOverride(url, { bootstrapResolveMode: resolveMode });
  }
  return null;
}

async function bootstrapDnsResolveOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(
    options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode
  );
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!shouldResolveBootstrapHost(parsed.hostname)) return null;
  const servers = bootstrapDnsServers();
  if (!servers.length) return null;
  const address = await resolveBootstrapHostname(parsed.hostname, servers, resolveMode);
  return buildHostOverride(parsed, { host: address, port: null }, resolveMode, {
    preserveOriginalHost: false,
    source: 'bootstrap-dns'
  });
}

function shouldResolveBootstrapHost(hostname) {
  const host = nullableString(hostname);
  if (!host) return false;
  if (host === 'localhost') return false;
  return net.isIP(host) === 0;
}

function bootstrapDnsServers() {
  return parseDnsServerList([
    runtime?.config?.bootstrapDnsServers,
    DEFAULT_CONFIG.bootstrapDnsServers
  ].filter(Boolean).join(','));
}

function parseDnsServerList(value) {
  return uniqueValues(String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean));
}

async function resolveBootstrapHostname(hostname, servers, resolveMode) {
  const resolver = new dnsPromises.Resolver();
  resolver.setServers(servers);
  const failures = [];
  for (let attempt = 1; attempt <= BOOTSTRAP_DNS_RETRY_LIMIT; attempt += 1) {
    try {
      const records = await withTimeout(
        resolver.resolve4(hostname),
        1600,
        `Bootstrap DNS timeout for ${hostname} via ${servers.join(',')}`
      );
      const address = records.find((record) => isIpv4(record));
      if (address) return address;
      throw new Error(`Bootstrap DNS did not return an A record for ${hostname}`);
    } catch (err) {
      failures.push(err);
      if (attempt < BOOTSTRAP_DNS_RETRY_LIMIT) {
        await delay(BOOTSTRAP_DNS_RETRY_DELAY_MS * attempt);
      }
    }
  }
  const last = failures[failures.length - 1];
  const wrapped = new Error(`Bootstrap DNS failed for ${hostname} via ${servers.join(',')} after ${failures.length} attempts: ${errorMessage(last)}`);
  wrapped.code = 'MX_BOOTSTRAP_DNS_FAILED';
  wrapped.bootstrapResolveMode = resolveMode;
  wrapped.dnsRetryCount = failures.length;
  wrapped.cause = last;
  throw wrapped;
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'MX_BOOTSTRAP_DNS_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function hostResolveOverride(url, options = {}) {
  const resolveMode = normalizeBootstrapResolveMode(options.bootstrapResolveMode || runtime?.config?.bootstrapResolveMode || DEFAULT_CONFIG.bootstrapResolveMode);
  if (resolveMode === 'dns-first' || resolveMode === 'dns-only' || resolveMode === 'system-only') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const resolveMap = parseHostResolve(effectiveHostResolve());
  const mapped = resolveMap.get(parsed.hostname.toLowerCase());
  if (!mapped) return null;
  return buildHostOverride(parsed, mapped, resolveMode, {
    preserveOriginalHost: false,
    source: 'host-resolve'
  });
}

function buildHostOverride(parsed, mapped, resolveMode, options = {}) {
  const target = new URL(parsed.toString());
  target.hostname = mapped.host;
  if (mapped.port) target.port = mapped.port;
  const useOriginalHostHeader = options.preserveOriginalHost === true || target.protocol === 'https:';
  return {
    originalUrl: parsed.toString(),
    url: target.toString(),
    hostHeader: useOriginalHostHeader ? parsed.host : target.host,
    originalHostHeader: parsed.host,
    resolveMode,
    source: options.source || 'host-resolve',
    servername: useOriginalHostHeader ? parsed.hostname : undefined
  };
}

function effectiveHostResolve() {
  return [
    runtime?.config?.hostResolve,
    DEFAULT_CONFIG.hostResolve
  ].filter(Boolean).join(',');
}

function parseHostResolve(value) {
  const map = new Map();
  const text = nullableString(value);
  if (!text) return map;
  for (const pair of text.split(/[,\n;]/)) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.includes('=') ? '=' : ':';
    const index = trimmed.indexOf(separator);
    if (index <= 0) continue;
    const host = trimmed.slice(0, index).trim().toLowerCase();
    const target = parseHostResolveTarget(trimmed.slice(index + 1).trim());
    if (host && target) map.set(host, target);
  }
  return map;
}

function parseHostResolveTarget(value) {
  const text = nullableString(value);
  if (!text) return null;
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close > 0) {
      return {
        host: text.slice(1, close),
        port: text.slice(close + 1).replace(/^:/, '') || null
      };
    }
  }
  const [host, port] = text.split(':');
  return {
    host,
    port: port || null
  };
}

function splitDnsDomains(config) {
  return arrayValue(String(config?.splitDnsDomains || '').split(/[,\s]+/), [])
    .map((domain) => domain.replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase())
    .filter(Boolean);
}

function uniqueStrings(items) {
  return [...new Set(arrayValue(items, [])
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean))];
}

function nowIso() {
  return new Date().toISOString();
}

function stringValue(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function nullableString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function tailText(value, maxLength) {
  const text = nullableString(value);
  if (!text) return null;
  const limit = Number.isFinite(maxLength) ? Math.max(80, Math.floor(maxLength)) : 1200;
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function arrayValue(value, fallback) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : fallback;
}

function normalizeBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return text || null;
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function joinApiUrl(baseUrl, pathName) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Internal API baseUrl 为空。');
  return `${base}${pathName.startsWith('/') ? pathName : `/${pathName}`}`;
}

function sdkGatewayBaseUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}/internal/v1/sdk` : '';
}

function uniqueValues(values) {
  return [...new Set(values)];
}

function displayNameFromAccount(account) {
  const text = account.trim();
  return text.includes('@') ? text.split('@')[0] : text;
}

function parseUserIdFromSubject(subject) {
  const text = nullableString(subject);
  if (!text) return null;
  return text.startsWith('user:') ? text.slice('user:'.length) : text;
}

function shortId() {
  return randomUUID().replace(/-/g, '');
}

function makeRequestId(prefix) {
  return `${prefix}-${Date.now()}-${shortId().slice(0, 8)}`;
}

function parseJsonPayload(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function classifyConnectionError(err) {
  const message = errorMessage(err);
  const status = Number(err?.status || err?.statusCode || err?.payload?.statusCode || 0);
  const lower = message.toLowerCase();
  if (status === 403 && isPublicIcpBlockedError(err)) {
    return {
      state: 'network-unavailable',
      message: `公网域名被备案/公网入口拦截（403），不是 Internal 权限拒绝。请保留 Bootstrap API 域名，并在高级选项 Host Resolve 设置 api.mxinfo-inc.cn=<正式 Domestic gateway IP>；客户端会连接该 IP，HTTP Host 使用 gateway IP，原始域名放在 X-Forwarded-Host/X-MX-Bootstrap-Host。原始错误：${message}`
    };
  }
  if (status === 403 || lower.includes('403 forbidden') || lower.includes('forbidden')) {
    return {
      state: 'forbidden',
      message: `Internal 已响应但拒绝请求（403）。请检查 launcher-network 产品、租约或当前 principal 权限；原始错误：${message}`
    };
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('enetunreach') || lower.includes('ehostunreach') || lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('timeout') || lower.includes('请求超时')) {
    return {
      state: 'network-unavailable',
      message: `网络或 bootstrap API 暂不可达，已保留本机租约并等待恢复；原始错误：${message}`
    };
  }
  if (status >= 500 || lower.includes('service unavailable') || lower.includes('bad gateway') || lower.includes('socket hang up')) {
    return {
      state: 'server-unavailable',
      message: `Internal 服务可能正在重启或部署中，已保留本机租约并等待恢复；原始错误：${message}`
    };
  }
  return {
    state: 'server-unavailable',
    message
  };
}

function isPublicIcpBlockedError(err) {
  const text = errorPayloadText(err).toLowerCase();
  return text.includes('non-compliance icp filing')
    || text.includes('beian')
    || text.includes('aliyun.com/beian')
    || text.includes('server: beaver');
}

function errorPayloadText(err) {
  const payload = err?.payload;
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    return Object.values(payload)
      .map((value) => Array.isArray(value) ? value.join(' ') : String(value || ''))
      .join(' ');
  }
  return '';
}

function errorMessage(err) {
  if (!err) return 'unknown error';
  const dial = err.originalUrl && err.dialUrl ? `${err.originalUrl} -> ${err.dialUrl}` : '';
  const mode = err.bootstrapResolveMode ? `resolve=${err.bootstrapResolveMode}` : '';
  const payload = err.payload;
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string') return payload.message;
    if (Array.isArray(payload.message)) return payload.message.join(', ');
    if (typeof payload.error === 'string') return payload.error;
  }
  if (typeof payload === 'string' && payload.trim()) {
    const compact = payload.replace(/\s+/g, ' ').trim();
    return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  }
  if (err.name === 'AbortError') return '请求超时。';
  if (err.cause && typeof err.cause === 'object') {
    const code = typeof err.cause.code === 'string' ? err.cause.code : '';
    const address = typeof err.cause.address === 'string' ? err.cause.address : '';
    const port = err.cause.port ? `:${err.cause.port}` : '';
    const causeMessage = typeof err.cause.message === 'string' ? err.cause.message : '';
    if (code || causeMessage) {
      return [dial, mode, err.message, code, address ? `${address}${port}` : '', causeMessage]
        .filter(Boolean)
        .join(' / ');
    }
  }
  if (typeof err.code === 'string') {
    const address = typeof err.address === 'string' ? err.address : '';
    const port = err.port ? `:${err.port}` : '';
    return [dial, mode, err.message, err.code, address ? `${address}${port}` : '']
      .filter(Boolean)
      .join(' / ');
  }
  return [dial, mode, err.message || String(err)].filter(Boolean).join(' / ');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
