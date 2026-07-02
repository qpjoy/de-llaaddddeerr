const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;
let launcher = null;

let runtime = {
  app: {
    appId: 'h2o',
    displayName: 'H2O',
    packageName: '@qpjoy/electron-launcher-app-h2o',
    version: app.getVersion(),
    launcherMode: 'embed',
    standaloneChannelProductId: 'mx-h2i',
    networkScope: 'broker-session'
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
    mode: 'rule',
    pac: 'dynamic-split',
    dns: 'internal-first',
    proxyPort: 2053
  },
  network: {
    localIp: null,
    routePolicy: 'guest limited',
    internalApi: 'pending',
    splitDns: 'pending',
    pac: 'pending'
  },
  rules: [
    { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '10.88.88.88', policy: 'internal' },
    { id: 'appcenter', host: 'appcenter.mxinfo-inc.cn', target: 'mx-h2i broker', policy: 'broker-session' },
    { id: 'public-docs', host: 'docs.qpjoy.local', target: 'system proxy', policy: 'fallback' }
  ],
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
    runtime.policy.mode = ['rule', 'global', 'direct'].includes(mode) ? mode : 'rule';
    pushActivity('policy.mode', `Mode switched to ${runtime.policy.mode}`);
    await requestBroker('network.proxy', { mode: runtime.policy.mode });
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
    launcher = mod.createElectronLauncher({
      mode: 'embed',
      appId: runtime.app.appId,
      productId: runtime.app.appId,
      standaloneChannelProductId: runtime.app.standaloneChannelProductId,
      appVersion: runtime.app.version,
      requiredCapabilities: [
        'user.session',
        'network.status',
        'network.proxy',
        'network.dns.policy',
        'network.pac.policy',
        'app-center-runtime'
      ],
      channelRegistry: () => devChannelRegistry(mod),
      requestImpl: brokerRequest
    });
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
      networkScope: runtime.app.networkScope,
      standaloneChannelProductId: runtime.app.standaloneChannelProductId
    };
  }
  if (name === 'network.proxy') {
    return {
      ok: true,
      mode: payload && payload.mode ? payload.mode : runtime.policy.mode,
      mixedPort: runtime.policy.proxyPort,
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
      'user.session',
      'network.status',
      'network.proxy',
      'network.dns.policy',
      'network.pac.policy',
      'app-center-runtime',
      'observability.write'
    ],
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

function pushActivity(type, message) {
  runtime.activity = [
    { type, message, at: new Date().toISOString() },
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
