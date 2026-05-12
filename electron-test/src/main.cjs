const path = require('node:path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const { createElectronTunnel } = require('@qpjoy/electron-tunnel');

let mainWindow = null;
let tunnel = null;

function bundledEngineDir() {
  if (!app.isPackaged) {
    return undefined;
  }
  return path.join(process.resourcesPath, 'engine');
}

async function applyProxy() {
  if (tunnel) {
    await tunnel.applyProxy();
  }
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
  if (!value) {
    throw new Error('测试网址不能为空');
  }
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function openTestWindow(rawUrl) {
  const targetUrl = normalizeUrl(rawUrl);
  const testWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    title: targetUrl,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await applyProxy();
  await testWindow.loadURL(targetUrl);
}

function registerAppIpc() {
  ipcMain.handle('tunnel-test:status', () => tunnel?.status() ?? null);
  ipcMain.handle('tunnel-test:snapshot', () => tunnel.manager.snapshot());
  ipcMain.handle('tunnel-test:add-rule', async (_event, input) => {
    const rule = tunnel.manager.addDomainRule(input.kind, input.domain);
    await tunnel.manager.applyRuntimeConfigChange();
    return rule;
  });
  ipcMain.handle('tunnel-test:remove-rule', async (_event, id) => {
    tunnel.manager.removeDomainRule(id);
    await tunnel.manager.applyRuntimeConfigChange();
  });
  ipcMain.handle('tunnel-test:add-preset', async (_event, preset) => {
    const rules = tunnel.manager.addPreset(preset);
    await tunnel.manager.applyRuntimeConfigChange();
    return rules;
  });
  ipcMain.handle('tunnel-test:remove-preset', async (_event, preset) => {
    const count = tunnel.manager.removePreset(preset);
    await tunnel.manager.applyRuntimeConfigChange();
    return count;
  });
  ipcMain.handle('tunnel-test:open-test-window', async (_event, url) => {
    await openTestWindow(url);
  });
  ipcMain.handle('tunnel-test:open-admin', async () => {
    const url = tunnel?.status().adminUrl ?? 'http://127.0.0.1:23456';
    await shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  tunnel = createElectronTunnel({
    app,
    ipcMain,
    session: session.defaultSession
  }, {
    bundledEngineDir: bundledEngineDir(),
    adminPort: 23456,
    controllerPort: 23457,
    mixedPort: 23458,
    dnsPort: 23459
  });

  tunnel.manager.on('event', () => {
    mainWindow?.webContents.send('tunnel-test:event');
  });

  registerAppIpc();
  await applyProxy();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error('[QPJoy Tunnel NPM Test] startup failed:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  tunnel?.close();
});
