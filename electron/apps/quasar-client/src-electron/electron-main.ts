import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, session, shell } from 'electron';
import path from 'path';
import os, { type NetworkInterfaceInfo } from 'os';
import { fileURLToPath } from 'url';

import {
  AdminServer,
  MihomoManager,
  applyElectronProxy,
  registerTunnelIpc
} from '@qpjoy/electron-mihomo-tunnel';

let mainWindow: BrowserWindow | null = null;
let tunnelManager: MihomoManager | null = null;
let adminServer: AdminServer | null = null;
let networkGuardTimer: NodeJS.Timeout | null = null;
let lastNetworkSignature = '';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

async function applyProxyForCurrentMode(): Promise<void> {
  if (!tunnelManager) {
    return;
  }
  const status = tunnelManager.status();
  await applyElectronProxy(session.defaultSession, status.mode, status.ports);
}

async function createWindow(): Promise<void> {
  nativeTheme.themeSource = 'light';

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.resolve(currentDir, process.env.QUASAR_ELECTRON_PRELOAD ?? 'electron-preload.js')
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:23456')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (process.env.DEV) {
    await mainWindow.loadURL(process.env.APP_URL ?? 'http://localhost:9000');
  } else {
    await mainWindow.loadFile('index.html');
  }
}

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error('测试网址不能为空');
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `https://${value}`;
}

function interfaceKey(name: string, item: NetworkInterfaceInfo): string {
  return [
    name,
    item.family,
    item.address,
    item.netmask,
    item.mac,
    item.internal ? 'internal' : 'external'
  ].join('/');
}

function networkSignature(): string {
  const rows: string[] = [];
  const interfaces = os.networkInterfaces();

  for (const [name, values] of Object.entries(interfaces)) {
    for (const item of values ?? []) {
      if (!item.internal) {
        rows.push(interfaceKey(name, item));
      }
    }
  }

  return rows.sort().join('|');
}

async function handleNetworkChange(reason: string): Promise<void> {
  if (!tunnelManager) {
    return;
  }

  await applyProxyForCurrentMode();
  await tunnelManager.handleNetworkChanged(reason);
  await applyProxyForCurrentMode();
  mainWindow?.webContents.send('tunnel:event');
}

function startNetworkGuard(): void {
  lastNetworkSignature = networkSignature();
  networkGuardTimer = setInterval(() => {
    const next = networkSignature();
    if (next !== lastNetworkSignature) {
      lastNetworkSignature = next;
      void handleNetworkChange('network interfaces changed');
    }
  }, 8000);

  powerMonitor.on('resume', () => {
    void handleNetworkChange('system resumed');
  });
}

function stopNetworkGuard(): void {
  if (networkGuardTimer) {
    clearInterval(networkGuardTimer);
    networkGuardTimer = null;
  }
}

async function openTestWindow(rawUrl: string): Promise<void> {
  await applyProxyForCurrentMode();

  const targetUrl = normalizeUrl(rawUrl);
  const testWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    title: targetUrl,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await testWindow.loadURL(targetUrl);
}

app.whenReady().then(async () => {
  const platform = os.platform();
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Unsupported platform for this tunnel MVP: ${platform}`);
  }

  tunnelManager = new MihomoManager({
    userDataPath: app.getPath('userData'),
    adminPort: 23456,
    controllerPort: 23457
  });
  adminServer = new AdminServer(tunnelManager);
  adminServer.start();
  registerTunnelIpc(ipcMain, tunnelManager, {
    afterSettingsChange: applyProxyForCurrentMode
  });
  ipcMain.handle('tunnel:open-admin', () => shell.openExternal(tunnelManager?.status().adminUrl ?? 'http://127.0.0.1:23456'));
  ipcMain.handle('tunnel:open-test-window', (_event, url: string) => openTestWindow(url));

  tunnelManager.on('event', () => {
    void applyProxyForCurrentMode();
    mainWindow?.webContents.send('tunnel:event');
  });

  await applyProxyForCurrentMode();
  startNetworkGuard();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
}).catch((error) => {
  console.error('[QPJoy Tunnel] Electron startup failed:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopNetworkGuard();
  adminServer?.stop();
  tunnelManager?.close();
});
