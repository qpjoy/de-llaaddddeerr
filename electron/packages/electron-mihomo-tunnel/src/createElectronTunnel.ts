import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { App, IpcMain, Session } from 'electron';

import { AdminServer } from './admin/AdminServer';
import { registerTunnelIpc } from './ipc/registerTunnelIpc';
import { MihomoManager } from './mihomo/MihomoManager';
import { applyElectronProxy } from './system/electronProxy';
import type { TunnelManagerOptions, TunnelStatus } from './types';

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
  close: () => void;
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
  const admin = new AdminServer(manager);

  async function applyProxy(): Promise<void> {
    const status = manager.status();
    await applyElectronProxy(host.session, status.mode, status.ports);
  }

  if (options.startAdminServer !== false) {
    admin.start();
  }

  registerTunnelIpc(host.ipcMain, manager, {
    afterSettingsChange: applyProxy
  });

  return {
    manager,
    admin,
    applyProxy,
    status: () => manager.status(),
    close: () => {
      admin.stop();
      manager.close();
    }
  };
}
