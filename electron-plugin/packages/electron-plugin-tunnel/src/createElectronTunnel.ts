import { existsSync, readFileSync } from 'fs';
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
}

export interface ElectronTunnelHandle {
  manager: MihomoManager;
  admin: AdminServer;
  applyProxy: () => Promise<void>;
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

export function createElectronTunnel(host: CreateElectronTunnelHost, options: CreateElectronTunnelOptions = {}): ElectronTunnelHandle {
  const manager = new MihomoManager({
    ...options,
    userDataPath: options.userDataPath ?? host.app.getPath('userData'),
    bundledEngineDir: options.bundledEngineDir ?? defaultBundledEngineDir()
  });
  async function applyProxy(): Promise<void> {
    const status = manager.status();
    await applyElectronProxy(host.session, status.mode, status.ports);
  }

  async function openTestWindow(url: string): Promise<void> {
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

    win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      if (/^https?:\/\//i.test(childUrl)) {
        void win.loadURL(childUrl);
      }
      return { action: 'deny' };
    });

    await win.loadURL(url);
  }

  const admin = new AdminServer(manager, {
    afterSettingsChange: applyProxy,
    openTestWindow
  });

  if (options.startAdminServer !== false) {
    admin.start();
  }

  const disposeIpc = registerTunnelIpc(host.ipcMain, manager, {
    afterSettingsChange: applyProxy
  });

  // Self-register in the shared marketplace.db so the panel (when it shows
  // up later) knows the tunnel is here. Best-effort; failure is silent —
  // tunnel must keep working even if marketplace-db is missing.
  registerSelfInMarketplaceDb(host.app, options).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[electron-tunnel] marketplace-db self-register failed:', err);
  });

  return {
    manager,
    admin,
    applyProxy,
    status: () => manager.status(),
    close: async () => {
      // Order matters:
      //   1. Unregister IPC first so renderers stop sending fresh requests.
      //   2. Stop the admin HTTP server and AWAIT the port release.
      //   3. Tear down the mihomo child process.
      disposeIpc();
      await admin.stop();
      await manager.close();
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
