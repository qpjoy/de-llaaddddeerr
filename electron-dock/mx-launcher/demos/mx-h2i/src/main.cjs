const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, screen: electronScreen } = require('electron');

const APP_ID = 'dev.qpjoy.mx-h2i';
const STATE_FILE = 'mx-h2i-runtime.json';
const DEFAULT_CONFIG = {
  internalApiBaseUrl: 'http://10.88.88.88:18090',
  domesticRelayHost: '121.43.253.179',
  domesticRelayPort: 51280,
  sdkGatewayBaseUrl: 'http://10.88.88.88:18090/internal/v1/sdk',
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
  ipcMain.handle('mx-h2i:get-state', () => runtime);
  ipcMain.handle('mx-h2i:save-config', async (_event, input) => {
    runtime.config = normalizeConfig(input);
    runtime.launcherContract = await launcherContract(runtime.config);
    touchRuntime('config saved');
    await saveAndBroadcast();
    return runtime;
  });
  ipcMain.handle('mx-h2i:connect-guest', async () => {
    setConnecting('guest');
    await saveAndBroadcast();
    await delay(420);
    runtime.connection = connectedState({
      mode: 'guest',
      localIp: '10.89.120.24',
      routePolicy: 'guest limited',
      subject: 'anonymousPrincipal:h2i-demo'
    });
    runtime.identity = {
      kind: 'anonymous',
      displayName: 'Visitor',
      account: null,
      scopes: ['auth.read', 'network.hdi.status']
    };
    runtime.feedback = null;
    touchRuntime('guest connected');
    await saveAndBroadcast();
    return runtime;
  });
  ipcMain.handle('mx-h2i:login-employee', async (_event, input) => {
    const account = typeof input?.account === 'string' ? input.account.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!account || !password) {
      return {
        ...runtime,
        feedback: {
          tone: 'danger',
          message: '请输入员工账号和密码。'
        }
      };
    }
    setConnecting('employee');
    await saveAndBroadcast();
    await delay(520);
    const displayName = account.includes('@') ? account.split('@')[0] : account;
    runtime.connection = connectedState({
      mode: 'employee',
      localIp: '10.89.8.24',
      routePolicy: 'user full',
      subject: `user:${displayName}`
    });
    runtime.identity = {
      kind: 'user',
      displayName,
      account,
      scopes: ['auth.read', 'appcenter.read', 'network.hdi.status', 'network.proxy.app', 'network.dns.policy']
    };
    runtime.feedback = null;
    touchRuntime('employee connected');
    await saveAndBroadcast();
    return runtime;
  });
  ipcMain.handle('mx-h2i:disconnect', async () => {
    runtime.connection = idleConnection();
    runtime.feedback = {
      tone: 'info',
      message: '已断开 MX-H2I standalone channel。'
    };
    touchRuntime('disconnected');
    await saveAndBroadcast();
    return runtime;
  });
  ipcMain.handle('mx-h2i:install-appcenter', async () => {
    if (runtime.connection.state !== 'connected') {
      runtime.feedback = {
        tone: 'warning',
        message: 'AppCenter 需要先连接 MX-H2I channel。'
      };
      await saveAndBroadcast();
      return runtime;
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
    return runtime;
  });
  ipcMain.handle('mx-h2i:enable-h2o', async () => {
    if (!runtime.apps.appcenter.installed) {
      runtime.feedback = {
        tone: 'warning',
        message: '请先安装 AppCenter。'
      };
      await saveAndBroadcast();
      return runtime;
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
    return runtime;
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
    return runtime;
  });
  ipcMain.handle('mx-h2i:open-admin', async () => {
    const url = `${runtime.config.internalApiBaseUrl.replace(/\/+$/, '')}/admin/`;
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
  return {
    internalApiBaseUrl: stringValue(row.internalApiBaseUrl, DEFAULT_CONFIG.internalApiBaseUrl),
    domesticRelayHost: stringValue(row.domesticRelayHost, DEFAULT_CONFIG.domesticRelayHost),
    domesticRelayPort: Number.isInteger(domesticRelayPort) && domesticRelayPort > 0 ? domesticRelayPort : DEFAULT_CONFIG.domesticRelayPort,
    sdkGatewayBaseUrl: stringValue(row.sdkGatewayBaseUrl, DEFAULT_CONFIG.sdkGatewayBaseUrl),
    releaseChannel: stringValue(row.releaseChannel, DEFAULT_CONFIG.releaseChannel),
    rolloutGroup: stringValue(row.rolloutGroup, DEFAULT_CONFIG.rolloutGroup),
    useLocalEngineResources: row.useLocalEngineResources !== false,
    restartAfterCodeUpdate: row.restartAfterCodeUpdate !== false
  };
}

function normalizeConnection(input) {
  const row = input && typeof input === 'object' ? input : {};
  if (row.state === 'connected') {
    return connectedState({
      mode: row.mode === 'employee' ? 'employee' : 'guest',
      localIp: stringValue(row.localIp, '10.89.120.24'),
      routePolicy: stringValue(row.routePolicy, 'guest limited'),
      subject: stringValue(row.subject, 'anonymousPrincipal:h2i-demo'),
      connectedAt: typeof row.connectedAt === 'string' ? row.connectedAt : nowIso()
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
    baseUrl: config.internalApiBaseUrl,
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
    health: {
      wireGuard: 'idle',
      domesticRelay: 'idle',
      internalApi: 'idle',
      splitDns: 'idle',
      appBroker: 'idle'
    }
  };
}

function connectedState(input) {
  return {
    state: 'connected',
    mode: input.mode,
    localIp: input.localIp,
    routePolicy: input.routePolicy,
    subject: input.subject,
    connectedAt: input.connectedAt || nowIso(),
    health: {
      wireGuard: 'ready',
      domesticRelay: 'ready',
      internalApi: 'ready',
      splitDns: 'ready',
      appBroker: 'ready'
    }
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
  mainWindow.webContents.send('mx-h2i:state', runtime);
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

function nowIso() {
  return new Date().toISOString();
}

function stringValue(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function arrayValue(value, fallback) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
