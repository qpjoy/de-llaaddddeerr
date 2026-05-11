import { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, session, shell } from 'electron';
import path from 'path';
import os, { type NetworkInterfaceInfo } from 'os';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

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

function resolvePreloadPath(): string {
  const override = process.env.QUASAR_ELECTRON_PRELOAD;
  const candidates = [
    override ? path.resolve(currentDir, override) : '',
    path.resolve(currentDir, 'preload/electron-preload.cjs'),
    path.resolve(currentDir, 'electron-preload.cjs'),
    path.resolve(currentDir, 'electron-preload.js')
  ].filter(Boolean);

  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) {
    return existing;
  }

  console.warn(`[QPJoy Tunnel] Electron preload not found, tried: ${candidates.join(', ')}`);
  return candidates[0] ?? path.resolve(currentDir, 'preload/electron-preload.cjs');
}

function resolveBundledCoreDir(): string {
  const candidates = [
    path.resolve(process.resourcesPath, 'mihomo'),
    path.resolve(currentDir, 'resources/mihomo'),
    path.resolve(currentDir, '../resources/mihomo'),
    path.resolve(currentDir, '../../resources/mihomo'),
    path.resolve(currentDir, '../../../resources/mihomo'),
    path.resolve(currentDir, '../../../../resources/mihomo')
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

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
      preload: resolvePreloadPath()
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function friendlyLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('ERR_PROXY_CONNECTION_FAILED')) {
    return '本地代理连接失败，请确认 mihomo 已启动，并且代理端口没有被其他应用占用。';
  }
  if (message.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
    return '隧道连接失败，请检查当前节点是否可用，以及 App 模式白名单是否允许该域名。';
  }
  if (message.includes('ERR_CONNECTION_CLOSED')) {
    return '连接被关闭。App 模式下海外域名必须在白名单内；如果已添加白名单，请稍等 core 重载后再试。';
  }
  if (message.includes('ERR_NAME_NOT_RESOLVED')) {
    return '域名解析失败，请检查 DNS 配置或当前网络。';
  }
  if (message.includes('ERR_CONNECTION_TIMED_OUT')) {
    return '连接超时，请检查当前网络或节点状态。';
  }

  return '测试窗口加载失败，请查看日志确认节点和规则状态。';
}

async function showTestErrorPage(window: BrowserWindow, targetUrl: string, message: string): Promise<void> {
  const html = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>QPJoy Tunnel 测试失败</title>',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f5f7fb;color:#111827;}',
    'main{max-width:720px;margin:72px auto;padding:32px;background:#fff;border:1px solid #d9e0ea;border-radius:8px;}',
    'h1{margin:0 0 16px;font-size:28px;}',
    'p{font-size:16px;line-height:1.7;color:#4b5563;}',
    'code{display:block;margin-top:18px;padding:14px;background:#f3f4f6;border-radius:6px;color:#111827;word-break:break-all;}',
    '</style>',
    '<main>',
    '<h1>测试失败</h1>',
    `<p>${escapeHtml(message)}</p>`,
    `<code>${escapeHtml(targetUrl)}</code>`,
    '</main>'
  ].join('');

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
  const targetUrl = normalizeUrl(rawUrl);
  const status = tunnelManager?.status();
  if (!status?.running) {
    throw new Error('mihomo 未运行，请先在首页启动后再打开测试窗口。');
  }

  await applyProxyForCurrentMode();

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

  try {
    await testWindow.loadURL(targetUrl);
  } catch (error) {
    const message = friendlyLoadError(error);
    await showTestErrorPage(testWindow, targetUrl, message);
    throw new Error(message);
  }
}

app.whenReady().then(async () => {
  const platform = os.platform();
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Unsupported platform for this tunnel MVP: ${platform}`);
  }

  tunnelManager = new MihomoManager({
    userDataPath: app.getPath('userData'),
    bundledCoreDir: resolveBundledCoreDir(),
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
