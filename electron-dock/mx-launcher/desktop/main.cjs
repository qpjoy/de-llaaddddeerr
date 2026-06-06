const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');

const APP_ID = 'dev.qpjoy.mx-launcher';
const CONFIG_KEY = 'qpjoy.mxLauncher.config';

let mainWindow = null;
let config = {
  serverBaseUrl: '',
  productConfigs: {
    hdo: {
      defaultMode: 'visitor'
    }
  }
};

app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  config = await loadConfig();
  registerIpc();
  createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 620,
    minWidth: 420,
    minHeight: 520,
    title: 'MX Launcher',
    backgroundColor: '#f3f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function registerIpc() {
  ipcMain.handle('launcher:get-config', () => config);
  ipcMain.handle('launcher:save-config', async (_event, input) => {
    config = normalizeConfig(input);
    await saveConfig(config);
    return config;
  });
  ipcMain.handle('launcher:get-products', () => {
    return [
      {
        id: 'hdo',
        name: 'HDO',
        displayName: 'HDO',
        description: '访客 / 员工网络连接、DNS、路由和内网服务访问',
        status: 'not-installed',
        config: config.productConfigs.hdo
      }
    ];
  });
  ipcMain.handle('launcher:get-status', () => {
    return {
      connectionState: 'idle',
      localIp: null,
      service: {
        installed: false,
        version: null,
        healthy: false
      }
    };
  });
  ipcMain.handle('launcher:launch-product', async (_event, input) => {
    const productId = input && typeof input.productId === 'string' ? input.productId : '';
    if (productId !== 'hdo') {
      return {
        ok: false,
        productId,
        state: 'error',
        error: 'Unknown MX Launcher product.'
      };
    }
    return {
      ok: false,
      productId: 'hdo',
      state: 'not-installed',
      localIp: null,
      error: 'MX privileged service is not installed yet.'
    };
  });
  ipcMain.handle('launcher:disconnect', () => {
    return {
      connectionState: 'idle',
      localIp: null
    };
  });
  ipcMain.handle('launcher:open-admin', async (_event, serverBaseUrl) => {
    const base = typeof serverBaseUrl === 'string' ? serverBaseUrl.trim().replace(/\/+$/, '') : '';
    const url = base ? `${base}/admin/#/server/mx-launcher/hdo` : 'http://127.0.0.1:8080/admin/#/server/mx-launcher/hdo';
    await shell.openExternal(url);
    return true;
  });
}

async function loadConfig() {
  try {
    const raw = app.commandLine.getSwitchValue('mx-launcher-config');
    if (raw) return normalizeConfig(JSON.parse(raw));
  } catch {
    // keep default
  }
  try {
    const store = require('node:fs').readFileSync(configPath(), 'utf8');
    return normalizeConfig(JSON.parse(store));
  } catch {
    return normalizeConfig({});
  }
}

async function saveConfig(next) {
  const fs = require('node:fs/promises');
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function configPath() {
  return path.join(app.getPath('userData'), `${CONFIG_KEY}.json`);
}

function normalizeConfig(input) {
  const row = input && typeof input === 'object' ? input : {};
  const serverBaseUrl =
    typeof row.serverBaseUrl === 'string'
      ? row.serverBaseUrl.trim().replace(/\/+$/, '')
      : '';
  const productConfigs = row.productConfigs && typeof row.productConfigs === 'object'
    ? row.productConfigs
    : {};
  const hdoConfig = productConfigs.hdo && typeof productConfigs.hdo === 'object'
    ? productConfigs.hdo
    : {};
  return {
    serverBaseUrl,
    productConfigs: {
      hdo: {
        defaultMode: hdoConfig.defaultMode === 'employee' ? 'employee' : 'visitor'
      }
    }
  };
}
