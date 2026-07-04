const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const H2O_APP_ID = 'h2o';
const H2O_DISPLAY_NAME = 'H2O';
const H2O_FULL_NAME = 'Home To Oversea';
const H2O_PACKAGE_NAME = '@qpjoy/electron-launcher-app-h2o';
const H2O_DESCRIPTION = 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。';
const H2O_REQUIRED_CAPABILITIES = [
  'user.session',
  'network.status',
  'network.proxy',
  'network.dns.policy',
  'network.pac.policy',
  'app-center-runtime'
];
const H2O_MODES = ['app-rule', 'app-global', 'system-tun', 'direct'];

let mainWindow = null;
let launcher = null;

let runtime = {
  app: {
    appId: H2O_APP_ID,
    displayName: H2O_DISPLAY_NAME,
    fullName: H2O_FULL_NAME,
    description: H2O_DESCRIPTION,
    packageName: H2O_PACKAGE_NAME,
    version: app.getVersion(),
    launcherMode: 'embed',
    standaloneChannelProductId: 'mx-h2i',
    networkScope: 'broker-session',
    requiredCapabilities: H2O_REQUIRED_CAPABILITIES,
    manifest: null
  },
  broker: {
    state: 'idle',
    ok: false,
    message: 'Not connected',
    session: null,
    channel: null,
    missingCapabilities: []
  },
  policy: {
    mode: 'app-rule',
    pac: 'dynamic-split',
    dns: 'internal-first',
    proxyPort: 23458,
    profile: 'home-to-oversea'
  },
  engine: {
    running: false,
    status: 'stopped',
    mode: 'app-rule',
    tunInstalled: false,
    activeSubscriptionId: 'h2o-default',
    startedAt: null,
    adminUrl: 'http://127.0.0.1:23456',
    core: 'h2o-shim',
    coreVersion: '0.1.0'
  },
  ports: {
    admin: 23456,
    controller: 23457,
    mixed: 23458,
    dns: 1053
  },
  network: {
    localIp: null,
    routePolicy: 'guest limited',
    internalApi: 'pending',
    splitDns: 'pending',
    pac: 'pending'
  },
  subscriptions: [
    {
      id: 'h2o-default',
      name: 'Home To Oversea 默认策略',
      url: 'mx-h2i://managed/home-to-oversea',
      nodes: 6,
      latencyMs: 42,
      status: 'ready',
      lastUpdatedAt: new Date().toISOString()
    }
  ],
  rules: [
    { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '10.88.88.88', policy: 'internal-direct', enabled: true, source: 'builtin' },
    { id: 'appcenter', host: 'appcenter.mxinfo-inc.cn', target: 'mx-h2i broker', policy: 'broker-session', enabled: true, source: 'builtin' },
    { id: 'oversea-default', host: '*.oversea', target: 'system proxy', policy: 'home-to-oversea', enabled: true, source: 'managed' }
  ],
  metrics: {
    uploadBytes: 0,
    downloadBytes: 0,
    lastProxyAppliedAt: null
  },
  activity: [],
  updatedAt: new Date().toISOString()
};

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'H2O',
    backgroundColor: '#141417',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerIpc() {
  ipcMain.handle('h2o:get-state', async () => visibleRuntime());
  ipcMain.handle('h2o:window-control', (_event, action) => {
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
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
      return true;
    }
    return false;
  });
  ipcMain.handle('h2o:connect-broker', async () => {
    await connectBroker();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:refresh', async () => {
    await refreshBrokerNetwork();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:set-mode', async (_event, mode) => {
    const nextMode = normalizeH2oMode(mode);
    runtime.policy.mode = nextMode;
    runtime.engine.mode = nextMode;
    runtime.engine.status = nextMode === 'system-tun' && !runtime.engine.tunInstalled
      ? 'tun-required'
      : runtime.engine.running
        ? 'running'
        : 'ready';
    pushActivity('policy.mode', `Mode switched to ${modeLabel(nextMode)}`);
    if (runtime.engine.running) {
      await applyProxyPolicy('mode-switch');
    }
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:start-runtime', async () => {
    await startRuntime();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:stop-runtime', async () => {
    runtime.engine.running = false;
    runtime.engine.status = 'stopped';
    runtime.engine.startedAt = null;
    pushActivity('runtime.stop', 'H2O proxy runtime stopped.');
    await requestBroker('network.proxy', { mode: 'direct', reason: 'h2o-stop' });
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:install-tun', async () => {
    runtime.engine.tunInstalled = true;
    runtime.engine.status = runtime.engine.running ? 'running' : 'ready';
    pushActivity('tun.install', 'System TUN helper marked as installed for this demo runtime.');
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:uninstall-tun', async () => {
    runtime.engine.tunInstalled = false;
    if (runtime.policy.mode === 'system-tun') {
      runtime.policy.mode = 'app-rule';
      runtime.engine.mode = 'app-rule';
    }
    runtime.engine.status = runtime.engine.running ? 'running' : 'ready';
    pushActivity('tun.uninstall', 'System TUN helper removed; mode fell back to App rule.');
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:set-ports', async (_event, input) => {
    const next = input && typeof input === 'object' ? input : {};
    runtime.ports = {
      admin: normalizePort(next.admin, runtime.ports.admin),
      controller: normalizePort(next.controller, runtime.ports.controller),
      mixed: normalizePort(next.mixed, runtime.ports.mixed),
      dns: normalizePort(next.dns, runtime.ports.dns)
    };
    runtime.policy.proxyPort = runtime.ports.mixed;
    runtime.engine.adminUrl = `http://127.0.0.1:${runtime.ports.admin}`;
    pushActivity('ports.save', `Ports saved: mixed ${runtime.ports.mixed}, dns ${runtime.ports.dns}.`);
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:add-subscription', async (_event, input) => {
    const row = input && typeof input === 'object' ? input : {};
    const name = String(row.name || 'Managed subscription').trim().slice(0, 80) || 'Managed subscription';
    const url = String(row.url || 'mx-h2i://managed/custom').trim().slice(0, 240) || 'mx-h2i://managed/custom';
    const id = `sub-${Date.now().toString(36)}`;
    runtime.subscriptions = [
      { id, name, url, nodes: 3, latencyMs: 58, status: 'ready', lastUpdatedAt: new Date().toISOString() },
      ...runtime.subscriptions
    ].slice(0, 12);
    runtime.engine.activeSubscriptionId = id;
    pushActivity('subscription.add', `Subscription added: ${name}.`);
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:set-active-subscription', async (_event, subscriptionId) => {
    const id = String(subscriptionId || '');
    if (runtime.subscriptions.some((item) => item.id === id)) {
      runtime.engine.activeSubscriptionId = id;
      pushActivity('subscription.active', `Active subscription switched to ${activeSubscription()?.name || id}.`);
    }
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:refresh-subscription', async (_event, subscriptionId) => {
    const id = String(subscriptionId || runtime.engine.activeSubscriptionId || '');
    runtime.subscriptions = runtime.subscriptions.map((item) => item.id === id
      ? {
          ...item,
          latencyMs: 30 + Math.floor(Math.random() * 60),
          status: 'ready',
          lastUpdatedAt: new Date().toISOString()
        }
      : item);
    pushActivity('subscription.refresh', `Subscription refreshed: ${activeSubscription()?.name || id}.`);
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:toggle-rule', async (_event, ruleId) => {
    const id = String(ruleId || '');
    runtime.rules = runtime.rules.map((rule) => rule.id === id ? { ...rule, enabled: rule.enabled === false } : rule);
    const rule = runtime.rules.find((item) => item.id === id);
    if (rule) pushActivity('rule.toggle', `${rule.host} ${rule.enabled ? 'enabled' : 'disabled'}.`);
    broadcast();
    return visibleRuntime();
  });
  ipcMain.handle('h2o:request-broker', async (_event, name, payload) => {
    const result = await requestBroker(String(name || ''), payload);
    return { state: visibleRuntime(), result };
  });
}

async function connectBroker() {
  runtime.broker = {
    ...runtime.broker,
    state: 'discovering-broker',
    ok: false,
    message: 'Discovering MX-H2I broker channel...'
  };
  broadcast();
  try {
    const mod = await import('@qpjoy/electron-launcher');
    const manifest = typeof mod.createLauncherEmbedManifest === 'function'
      ? mod.createLauncherEmbedManifest({
          appId: H2O_APP_ID,
          productId: H2O_APP_ID,
          displayName: H2O_DISPLAY_NAME,
          description: H2O_DESCRIPTION,
          packageName: H2O_PACKAGE_NAME,
          category: 'network',
          appVersion: runtime.app.version,
          standaloneChannelProductId: runtime.app.standaloneChannelProductId,
          requiredCapabilities: H2O_REQUIRED_CAPABILITIES
        })
      : null;
    runtime.app = {
      ...runtime.app,
      manifest,
      requiredCapabilities: manifest?.requiredCapabilities || H2O_REQUIRED_CAPABILITIES
    };
    launcher = mod.createElectronLauncher({
      mode: 'embed',
      appId: runtime.app.appId,
      productId: runtime.app.appId,
      displayName: runtime.app.displayName,
      description: runtime.app.description,
      packageName: runtime.app.packageName,
      category: 'network',
      standaloneChannelProductId: runtime.app.standaloneChannelProductId,
      appVersion: runtime.app.version,
      requiredCapabilities: runtime.app.requiredCapabilities,
      channelRegistry: () => devChannelRegistry(mod),
      requestImpl: brokerRequest
    });
    if (launcher.manifest) {
      runtime.app.manifest = launcher.manifest;
    }
    const result = await launcher.connect({
      installId: 'h2o-dev-install',
      deviceId: 'h2o-dev-device',
      userId: 'developer'
    });
    runtime.broker = serializeBrokerResult(result);
    if (result.ok) {
      await refreshBrokerNetwork();
      pushActivity('broker.connected', result.message);
    } else {
      pushActivity('broker.blocked', result.message);
    }
  } catch (error) {
    runtime.broker = {
      state: 'blocked',
      ok: false,
      message: error && error.message ? error.message : String(error),
      session: null,
      channel: null,
      missingCapabilities: []
    };
    pushActivity('broker.error', runtime.broker.message);
  }
  broadcast();
}

async function refreshBrokerNetwork() {
  const status = await requestBroker('network.status', { reason: 'manual-refresh' });
  if (status && typeof status === 'object') {
    runtime.network = {
      ...runtime.network,
      ...status
    };
  }
  runtime.updatedAt = new Date().toISOString();
  broadcast();
}

async function requestBroker(name, payload) {
  if (!launcher || !runtime.broker.ok) {
    return brokerRequest(runtime.broker.session, name, payload);
  }
  try {
    return await launcher.request(name, payload);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    pushActivity('broker.request.failed', `${name}: ${message}`);
    return { ok: false, message };
  }
}

async function brokerRequest(_session, name, payload) {
  if (name === 'network.status') {
    return {
      ok: true,
      localIp: '10.89.100.12',
      routePolicy: runtime.network.routePolicy,
      internalApi: 'ready',
      splitDns: runtime.policy.dns,
      pac: runtime.policy.pac,
      profile: runtime.policy.profile,
      networkScope: runtime.app.networkScope,
      standaloneChannelProductId: runtime.app.standaloneChannelProductId
    };
  }
  if (name === 'network.proxy') {
    return {
      ok: true,
      mode: payload && payload.mode ? payload.mode : runtime.policy.mode,
      mixedPort: runtime.ports.mixed,
      dnsPort: runtime.ports.dns,
      profile: runtime.policy.profile,
      appliedAt: new Date().toISOString()
    };
  }
  if (name === 'network.dns.policy' || name === 'network.pac.policy') {
    return { ok: true, policy: name, appliedAt: new Date().toISOString() };
  }
  if (name === 'user.session') {
    return { ok: true, userId: 'developer', roles: ['mx-h2i-dev'] };
  }
  return { ok: true, name, echo: payload || null };
}

async function startRuntime() {
  const nextMode = normalizeH2oMode(runtime.policy.mode);
  runtime.policy.mode = nextMode;
  runtime.engine.mode = nextMode;
  if (nextMode === 'system-tun' && !runtime.engine.tunInstalled) {
    runtime.engine.running = false;
    runtime.engine.status = 'tun-required';
    pushActivity('runtime.blocked', 'System TUN mode requires installing the TUN helper first.', 'warning');
    broadcast();
    return;
  }
  runtime.engine.running = true;
  runtime.engine.status = 'running';
  runtime.engine.startedAt = runtime.engine.startedAt || new Date().toISOString();
  runtime.metrics.lastProxyAppliedAt = new Date().toISOString();
  runtime.metrics.downloadBytes += 1024 * (4 + Math.floor(Math.random() * 24));
  runtime.metrics.uploadBytes += 512 * (2 + Math.floor(Math.random() * 10));
  pushActivity('runtime.start', `H2O started in ${modeLabel(nextMode)} with ${activeSubscription()?.name || 'no subscription'}.`);
  await applyProxyPolicy('runtime-start');
  broadcast();
}

async function applyProxyPolicy(reason) {
  const result = await requestBroker('network.proxy', {
    mode: runtime.policy.mode,
    mixedPort: runtime.ports.mixed,
    dnsPort: runtime.ports.dns,
    profile: runtime.policy.profile,
    subscriptionId: runtime.engine.activeSubscriptionId,
    reason
  });
  runtime.metrics.lastProxyAppliedAt = new Date().toISOString();
  if (result?.ok === false) {
    runtime.engine.status = 'error';
    pushActivity('broker.proxy.failed', result.message || 'Broker rejected proxy policy.', 'error');
  } else {
    pushActivity('broker.proxy.applied', `Proxy policy applied by MX-H2I broker (${reason}).`);
  }
}

function activeSubscription() {
  return runtime.subscriptions.find((item) => item.id === runtime.engine.activeSubscriptionId) || runtime.subscriptions[0] || null;
}

function normalizeH2oMode(mode) {
  const value = String(mode || '').trim();
  if (value === 'rule') return 'app-rule';
  if (value === 'global') return 'app-global';
  if (value === 'tun') return 'system-tun';
  return H2O_MODES.includes(value) ? value : 'app-rule';
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function modeLabel(mode) {
  if (mode === 'app-global') return '全局模式';
  if (mode === 'system-tun') return '虚拟网卡';
  if (mode === 'direct') return '直连';
  return '规则模式';
}

function devChannelRegistry(mod) {
  if (process.env.MX_H2O_BROKER_MODE === 'off') return [];
  const now = new Date().toISOString();
  return [{
    productId: 'mx-h2i',
    instanceId: 'mx-h2i-dev-broker',
    pid: process.pid,
    socketPath: `${app.getPath('userData')}/mx-h2i-dev.sock`,
    brokerAbiVersion: mod.brokerAbiVersion || '1.0',
    protocolVersion: mod.launcherProtocolVersion || '1.0',
    capabilities: [
      ...H2O_REQUIRED_CAPABILITIES,
      'app-center-runtime',
      'observability.write'
    ].filter((capability, index, rows) => rows.indexOf(capability) === index),
    heartbeatAt: now,
    displayName: 'MX-H2I Dev Broker'
  }];
}

function serializeBrokerResult(result) {
  return {
    state: result.state,
    ok: result.ok,
    message: result.message,
    session: result.session ? {
      sessionId: result.session.sessionId,
      appId: result.session.appId,
      networkScope: result.session.networkScope,
      standaloneChannelProductId: result.session.standaloneChannelProductId,
      grantedCapabilities: result.session.grantedCapabilities,
      issuedAt: result.session.issuedAt
    } : null,
    channel: result.channel ? {
      productId: result.channel.productId,
      displayName: result.channel.displayName,
      socketPath: result.channel.socketPath,
      capabilities: result.channel.capabilities,
      heartbeatAt: result.channel.heartbeatAt
    } : null,
    missingCapabilities: result.missingCapabilities || []
  };
}

function pushActivity(type, message, level = 'info') {
  runtime.activity = [
    { type, message, level, at: new Date().toISOString() },
    ...runtime.activity
  ].slice(0, 12);
  runtime.updatedAt = new Date().toISOString();
}

function visibleRuntime() {
  return JSON.parse(JSON.stringify(runtime));
}

function broadcast() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('h2o:state', visibleRuntime());
}
