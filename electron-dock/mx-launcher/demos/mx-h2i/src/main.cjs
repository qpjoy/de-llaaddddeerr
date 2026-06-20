const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen: electronScreen } = require('electron');

loadDotEnvFiles();

const APP_ID = 'dev.qpjoy.mx-h2i';
const STATE_FILE = 'mx-h2i-runtime.json';
const PRODUCT_ID = 'mx-h2i';
const REQUESTED_BY = 'mx-h2i-desktop';
const WIREGUARD_PROFILE_NAME = 'mx-h2i.conf';
const INTERNAL_PEER_IP = '10.88.88.88';
const LOCAL_INTERNAL_BASE_URLS = ['http://127.0.0.1:18090', 'http://localhost:18090'];
const DEFAULT_CONFIG = {
  bootstrapApiBaseUrl: defaultBootstrapApiBaseUrl(),
  internalApiBaseUrl: 'http://10.88.88.88:18090',
  domesticRelayHost: '121.43.253.179',
  domesticRelayPort: 51280,
  sdkGatewayBaseUrl: '',
  hostResolve: defaultHostResolve(),
  splitDnsDomains: nullableString(process.env.MX_H2I_SPLIT_DNS_DOMAINS)
    || nullableString(process.env.MX_H2I_DNS_DOMAINS)
    || '',
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
  registerIpc();
  createTray();
  createMainWindow();
  startTopRevealWatcher();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
      const baseUrl = await resolveBootstrapBaseUrl(runtime.config);
      await applyResolvedBootstrapBaseUrl(baseUrl);
      const auth = await authenticateUserViaGateway(baseUrl, account, password);
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
    const wireGuard = await stopWireGuardForRuntime();
    runtime.connection = idleConnection();
    runtime.auth = null;
    runtime.feedback = {
      tone: wireGuard?.ok === false ? 'warning' : 'info',
      message: wireGuard?.ok === false
        ? `已断开 launcher channel，但 WireGuard 停止失败：${wireGuard.message || wireGuard.error || 'unknown'}`
        : '已断开 MX-H2I standalone channel 和客户端 WireGuard；IP lease 会保留并在下次连接时续租。'
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
    splitDnsDomains: stringValue(row.splitDnsDomains, DEFAULT_CONFIG.splitDnsDomains),
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

function normalizeConnection(input) {
  const row = input && typeof input === 'object' ? input : {};
  if (row.state === 'connected' || row.state === 'lease-only' || row.state === 'tunnel-only') {
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
    allowedIps: arrayValue(row.allowedIps, []),
    message: nullableString(row.message),
    error: nullableString(row.error),
    updatedAt: nullableString(row.updatedAt) || nowIso()
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
    internalApi: row.internalApi && typeof row.internalApi === 'object' ? {
      ok: row.internalApi.ok === true,
      baseUrl: nullableString(row.internalApi.baseUrl),
      error: nullableString(row.internalApi.error)
    } : null,
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
    diagnostics: normalizeDiagnostics(input.diagnostics),
    health: normalizeHealth(input.health, leasedHealth())
  };
}

function setConnecting(mode) {
  runtime.connection = {
    ...idleConnection(),
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
  return context.launcher.connectNetwork({
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
}

async function launcherContext() {
  const baseUrl = await resolveBootstrapBaseUrl(runtime.config);
  await applyResolvedBootstrapBaseUrl(baseUrl);
  const installation = await ensureInstallation();
  const mod = await import('@qpjoy/electron-launcher');
  const launcher = mod.createElectronLauncher({
    baseUrl,
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
  return { baseUrl, installation, launcher };
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
  const lease = session.lease || {};
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
    message: `${options.feedback} 正在启动客户端 WireGuard。`
  };
  touchRuntime(options.mode === 'employee' ? 'employee lease ready' : 'guest lease ready');

  const wireGuardResult = await startWireGuardForSession({
    routePlan,
    privateKey,
    internalBaseUrl: overlayInternalBaseUrl
  });
  runtime.connection = {
    ...runtime.connection,
    state: wireGuardResult.state,
    health: wireGuardResult.health,
    wireGuard: wireGuardResult.wireGuard,
    diagnostics: wireGuardResult.diagnostics
  };
  runtime.feedback = {
    tone: wireGuardResult.ready ? 'success' : 'warning',
    message: wireGuardResult.ready
      ? `${options.feedback} 客户端 WireGuard 已连到 Domestic relay，并通过 overlay 探测 Internal。`
      : `${options.feedback} 已保留租约，但客户端 WireGuard 还未 ready：${wireGuardResult.message}`
  };
  touchRuntime(wireGuardResult.ready
    ? (options.mode === 'employee' ? 'employee wireguard connected' : 'guest wireguard connected')
    : 'wireguard lease only');
}

function applyConnectionError(label, err) {
  runtime.connection = idleConnection();
  runtime.auth = null;
  runtime.feedback = {
    tone: 'danger',
    message: `${label}：${errorMessage(err)}`
  };
  touchRuntime(`${label} failed`);
}

async function startWireGuardForSession(input) {
  const routePlan = normalizeRoutePlan(input.routePlan);
  const privateKey = nullableString(input.privateKey);
  if (!routePlan) return wireGuardFailure('launcher routePlan 缺失。');
  if (!privateKey) return wireGuardFailure('本机 WireGuard privateKey 缺失。');

  try {
    const mod = await import('@qpjoy/electron-launcher/wireguard');
    const internalBaseUrl = internalOverlayBaseUrl(routePlan, input.internalBaseUrl);
    const result = await mod.connectLauncherWireGuardPeer({
      ...wireGuardRuntimeOptions(),
      routePlan,
      privateKey,
      dnsDomains: splitDnsDomains(runtime.config),
      action: 'restart'
    });
    const status = result.status || {};
    const targetIp = internalTargetIp(routePlan, internalBaseUrl);
    const route = mod.probeLauncherWireGuardRoute({
      ...wireGuardRuntimeOptions(),
      targetIp,
      expectedInterfaceName: status.realInterfaceName || status.interfaceName || null
    });
    const internalApi = route.ok
      ? await probeInternalApiViaOverlay(internalBaseUrl)
      : {
          ok: false,
          baseUrl: normalizeBaseUrl(internalBaseUrl),
          error: `route to ${targetIp} is not on WireGuard (${route.interfaceName || route.error || 'unknown route'})`
        };
    const ready = result.ok === true && route.ok === true && internalApi.ok === true;
    const tunnelReady = result.ok === true;
    return {
      state: ready ? 'connected' : (tunnelReady ? 'tunnel-only' : 'lease-only'),
      ready,
      health: ready ? readyHealth() : {
        wireGuard: result.ok === true ? 'ready' : 'blocked',
        domesticRelay: result.ok === true ? 'ready' : 'pending',
        internalApi: internalApi.ok === true ? 'ready' : 'blocked',
        splitDns: route.ok === true ? 'ready' : 'pending',
        appBroker: 'ready'
      },
      wireGuard: summarizeWireGuardResult(result),
      diagnostics: {
        route,
        internalApi,
        updatedAt: nowIso()
      },
      message: ready ? 'ready' : wireGuardNotReadyMessage(result, route, internalApi)
    };
  } catch (err) {
    return wireGuardFailure(errorMessage(err));
  }
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
      allowedIps: [],
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
    allowedIps: arrayValue(peer.allowedIps, arrayValue(status.allowedIps, [])),
    message,
    error: result?.ok === true ? null : message,
    updatedAt: nowIso()
  };
}

function wireGuardNotReadyMessage(result, route, internalApi) {
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

async function authenticateUserViaGateway(baseUrl, account, password) {
  const tokenPayload = await requestJson(joinApiUrl(baseUrl, '/internal/v1/sdk/oauth/token'), {
    method: 'POST',
    timeoutMs: 5000,
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
  const candidates = uniqueValues([
    normalizeBaseUrl(process.env.MX_H2I_BOOTSTRAP_BASE_URL),
    normalizeBaseUrl(config.bootstrapApiBaseUrl),
    defaultBootstrapApiBaseUrl(),
    ...LOCAL_INTERNAL_BASE_URLS,
    normalizeBaseUrl(process.env.MX_H2I_INTERNAL_BASE_URL),
    normalizeBaseUrl(config.internalApiBaseUrl)
  ].filter(Boolean));
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await requestJson(joinApiUrl(candidate, '/healthz'), { timeoutMs: 900 });
      return candidate;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`无法连接 bootstrap API：${candidates.join(', ')}；${errorMessage(lastError)}`);
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
  const hostOverride = hostResolveOverride(url);
  if (hostOverride) return requestJsonWithHostOverride(hostOverride, options);
  if (typeof fetch !== 'function') throw new Error('当前 Electron 运行时没有 fetch。');
  const controller = new AbortController();
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body,
      signal: controller.signal
    });
    const text = await response.text();
    const payload = parseJsonPayload(text);
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      err.payload = payload;
      throw err;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function requestJsonWithHostOverride(override, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(override.url);
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
    const headers = {
      accept: 'application/json',
      host: override.hostHeader,
      ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {})
    };
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers,
      servername: override.servername,
      timeout
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const payload = parseJsonPayload(text);
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          const err = new Error(`HTTP ${response.statusCode}${response.statusMessage ? ` ${response.statusMessage}` : ''}`);
          err.payload = payload;
          reject(err);
          return;
        }
        resolve(payload);
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('请求超时。'));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
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
  const candidates = uniqueValues([
    path.join(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app', '.env') : null,
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null
  ].filter(Boolean));
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

function hostResolveOverride(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const resolveMap = parseHostResolve(runtime?.config?.hostResolve || DEFAULT_CONFIG.hostResolve);
  const mapped = resolveMap.get(parsed.hostname.toLowerCase());
  if (!mapped) return null;
  const target = new URL(parsed.toString());
  target.hostname = mapped.host;
  if (mapped.port) target.port = mapped.port;
  return {
    url: target.toString(),
    hostHeader: parsed.host,
    servername: parsed.hostname
  };
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

function arrayValue(value, fallback) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : fallback;
}

function normalizeBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return text || null;
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

function errorMessage(err) {
  if (!err) return 'unknown error';
  const payload = err.payload;
  if (payload && typeof payload === 'object') {
    if (typeof payload.message === 'string') return payload.message;
    if (Array.isArray(payload.message)) return payload.message.join(', ');
    if (typeof payload.error === 'string') return payload.error;
  }
  if (err.name === 'AbortError') return '请求超时。';
  return err.message || String(err);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
