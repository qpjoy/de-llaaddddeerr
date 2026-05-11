import { app, BrowserWindow, ipcMain, nativeTheme, session, shell } from 'electron';
import path from 'path';
import os from 'os';

import {
  AdminServer,
  MihomoManager,
  applyElectronProxy,
  registerTunnelIpc
} from '@qpjoy/electron-mihomo-tunnel';

let mainWindow: BrowserWindow | null = null;
let tunnelManager: MihomoManager | null = null;
let adminServer: AdminServer | null = null;

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
      preload: path.resolve(__dirname, process.env.QUASAR_ELECTRON_PRELOAD ?? 'electron-preload.js')
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

  tunnelManager.on('event', () => {
    void applyProxyForCurrentMode();
    mainWindow?.webContents.send('tunnel:event');
  });

  await applyProxyForCurrentMode();
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
  adminServer?.stop();
  tunnelManager?.close();
});
