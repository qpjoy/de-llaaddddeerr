import { existsSync, readFileSync } from 'fs';
import { createConnection } from 'net';
import { join, resolve } from 'path';
import { BrowserWindow } from 'electron';
import type { App, IpcMain, Session } from 'electron';

import { AdminServer } from './admin/AdminServer';
import { registerTunnelIpc } from './ipc/registerTunnelIpc';
import { MihomoManager } from './mihomo/MihomoManager';
import { applyElectronProxy } from './system/electronProxy';
import type { TunnelManagerOptions, TunnelStatus } from './types';

const TUNNEL_PLUGIN_ID = 'qpjoy.electron-tunnel';

export interface CreateElectronTunnelHost {
  app: App;
  ipcMain: IpcMain;
  session: Session;
}

export interface CreateElectronTunnelOptions extends Partial<Omit<TunnelManagerOptions, 'userDataPath'>> {
  userDataPath?: string;
  startAdminServer?: boolean;
  registerIpc?: boolean;
  registerMarketplace?: boolean;
}

export interface ElectronTunnelHandle {
  manager: MihomoManager;
  admin: AdminServer;
  applyProxy: () => Promise<void>;
  openTestWindow: (url: string) => Promise<void>;
  status: () => TunnelStatus;
  /**
   * Async on purpose: the plugin host awaits this disposer during
   * `runtime.deactivate(...)` so the admin port + IPC handlers are fully
   * released before a fresh activate (upgrade / reseed) runs.
   */
  close: () => Promise<void>;
}

function defaultBundledEngineDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.cwd();
  const packageDir = typeof __dirname === 'undefined' ? process.cwd() : __dirname;
  const candidates = [
    join(resourcesPath, 'qpjoy-tunnel-engine'),
    join(resourcesPath, 'mihomo'),
    resolve(packageDir, '../resources/engine'),
    resolve(process.cwd(), 'resources/qpjoy-tunnel-engine'),
    resolve(process.cwd(), 'resources/mihomo')
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function waitForTcpPort(port: number, timeoutMs = 1200): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`timeout connecting to 127.0.0.1:${port}`));
    }, timeoutMs);

    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolvePromise();
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

function testErrorHtml(url: string, message: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>QPJoy Tunnel Test Error</title>',
    '<style>',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#0b1020;color:#eef2ff;}',
    '.wrap{max-width:820px;margin:72px auto;padding:32px;border:1px solid rgba(148,163,184,.28);border-radius:14px;background:rgba(15,23,42,.88);}',
    'h1{font-size:24px;margin:0 0 14px;}',
    'p{line-height:1.7;color:#cbd5e1;}',
    'code{display:block;white-space:pre-wrap;padding:14px;border-radius:10px;background:#111827;color:#fca5a5;}',
    '</style></head><body><main class="wrap">',
    '<h1>测试页面加载失败</h1>',
    `<p>目标地址：${escapeHtml(url)}</p>`,
    `<code>${escapeHtml(message)}</code>`,
    '</main></body></html>'
  ].join('');
}

export function createElectronTunnel(host: CreateElectronTunnelHost, options: CreateElectronTunnelOptions = {}): ElectronTunnelHandle {
  const manager = new MihomoManager({
    ...options,
    userDataPath: options.userDataPath ?? host.app.getPath('userData'),
    bundledEngineDir: options.bundledEngineDir ?? defaultBundledEngineDir()
  });
  const testWindows = new Set<BrowserWindow>();
  let closePromise: Promise<void> | null = null;
  let ipcDisposed = false;
  async function applyProxy(): Promise<void> {
    const status = manager.status();
    if (!status.running) {
      await host.session.setProxy({ mode: 'direct' });
      return;
    }
    await applyElectronProxy(host.session, status.mode, status.ports);
  }

  async function openTestWindow(url: string): Promise<void> {
    const status = manager.status();
    if (status.mode !== 'system-tun') {
      if (!status.running) {
        throw new Error('隧道核心未运行。请先启动 Tunnel，再打开测试窗口。');
      }
      try {
        await waitForTcpPort(status.ports.mixed);
      } catch {
        throw new Error(`本地代理 127.0.0.1:${status.ports.mixed} 不可连接。请重启 Tunnel，或检查 mihomo 是否成功监听 mixed-port。`);
      }
    }

    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 520,
      title: 'QPJoy Tunnel Test',
      autoHideMenuBar: true,
      webPreferences: {
        session: host.session,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    });
    testWindows.add(win);
    win.once('closed', () => testWindows.delete(win));

    win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      if (/^https?:\/\//i.test(childUrl)) {
        void win.loadURL(childUrl);
      }
      return { action: 'deny' };
    });

    try {
      await win.loadURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testErrorHtml(url, message))}`);
      throw err;
    }
  }

  const admin = new AdminServer(manager, {
    afterSettingsChange: applyProxy,
    openTestWindow
  });

  if (options.startAdminServer !== false) {
    admin.start();
  }

  const disposeIpc = options.registerIpc === false
    ? () => undefined
    : registerTunnelIpc(host.ipcMain, manager, {
        afterSettingsChange: applyProxy
      });

  // Self-register in the shared marketplace.db so the panel (when it shows
  // up later) knows the tunnel is here. Best-effort; failure is silent —
  // tunnel must keep working even if marketplace-db is missing.
  if (options.registerMarketplace !== false) {
    registerSelfInMarketplaceDb(host.app, options).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[electron-tunnel] marketplace-db self-register failed:', err);
    });
  }

  return {
    manager,
    admin,
    applyProxy,
    openTestWindow,
    status: () => manager.status(),
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const failures: unknown[] = [];
        if (!ipcDisposed) {
          try {
            disposeIpc();
            ipcDisposed = true;
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await host.session.setProxy({ mode: 'direct' });
        } catch (error) {
          failures.push(error);
        }
        for (const win of testWindows) {
          if (!win.isDestroyed()) win.destroy();
        }
        testWindows.clear();
        try {
          await admin.stop();
        } catch (error) {
          failures.push(error);
        }
        try {
          await manager.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) throw new AggregateError(failures, 'electron tunnel close failed');
      })().catch((error) => {
        closePromise = null;
        throw error;
      });
      return closePromise;
    }
  };
}

/**
 * Optional integration: if `@qpjoy/marketplace-db` is installed in the host
 * app, write a row for ourselves into `installed_plugins`. This is what
 * makes the "tunnel installed standalone, plugin host shows up later"
 * scenario work — the host finds our row already there and treats us like
 * any other installed plugin.
 *
 * When tunnel is loaded *via* the plugin host (i.e. through the plugin
 * adapter), the host has already upserted our row — `getInstalled()` is
 * non-null, so we leave it alone.
 */
/**
 * Structural shape of just the slice of `@qpjoy/marketplace-db` we need.
 * Declared locally so tunnel keeps compiling without the package on disk
 * (it's an optional integration).
 */
interface MarketplaceDbModuleLite {
  resolveMarketplaceDbPath(userDataPath: string): string;
  MarketplaceDB: {
    open(path: string): {
      getInstalled(id: string): unknown | null;
      upsertInstalled(input: Record<string, unknown>): void;
      close(): void;
    };
  };
}

async function registerSelfInMarketplaceDb(
  app: App,
  options: CreateElectronTunnelOptions
): Promise<void> {
  // Late require so a missing peer dep doesn't break standalone use. Use a
  // computed specifier + cast so tsc never tries to resolve types for it.
  const specifier = '@qpjoy/marketplace-db';
  let mod: MarketplaceDbModuleLite;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-var-requires
    mod = require(specifier) as MarketplaceDbModuleLite;
  } catch {
    return; // package not installed alongside tunnel — fine.
  }

  const userDataPath = options.userDataPath ?? app.getPath('userData');
  const dbPath = mod.resolveMarketplaceDbPath(userDataPath);

  const packageJson = readNearbyJson('package.json') as { version?: string } | null;
  const manifest = readNearbyJson('plugin.manifest.json', 'dist') as
    | { permissions?: string[] }
    | null;

  const db = mod.MarketplaceDB.open(dbPath);
  try {
    if (db.getInstalled(TUNNEL_PLUGIN_ID)) return; // host already registered us
    const version = packageJson?.version ?? '0.0.0';
    db.upsertInstalled({
      id: TUNNEL_PLUGIN_ID,
      npm: '@qpjoy/electron-plugin-tunnel',
      version,
      installPath: resolveTunnelPackageRoot(),
      installSource: 'standalone',
      manifest: {
        id: TUNNEL_PLUGIN_ID,
        name: 'QPJoy Tunnel',
        version,
        engines: { electronMarket: '>=0.2.0', electron: '>=28' },
        permissions: manifest?.permissions ?? [],
        activationEvents: ['onStartup'],
        contributes: { adminPanel: { url: 'http://127.0.0.1:23456', label: 'Tunnel' } }
      },
      // Standalone tunnel granted itself everything; the user implicitly
      // accepted by choosing to install it directly (not via marketplace).
      grantedPermissions: manifest?.permissions ?? [],
      state: 'active',
      errorMessage: null,
      marketplaceEntryId: TUNNEL_PLUGIN_ID
    });
  } finally {
    db.close();
  }
}

function readNearbyJson(name: string, sub?: string): unknown {
  const packageDir = typeof __dirname === 'undefined' ? process.cwd() : __dirname;
  const candidates = sub
    ? [resolve(packageDir, sub, name), resolve(packageDir, '..', sub, name)]
    : [resolve(packageDir, name), resolve(packageDir, '..', name)];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      // try next
    }
  }
  return null;
}

function resolveTunnelPackageRoot(): string {
  const packageDir = typeof __dirname === 'undefined' ? process.cwd() : __dirname;
  return resolve(packageDir, '..');
}
