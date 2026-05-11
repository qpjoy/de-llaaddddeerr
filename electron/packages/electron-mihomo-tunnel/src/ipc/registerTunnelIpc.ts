import type { IpcMain } from 'electron';

import type { MihomoManager } from '../mihomo/MihomoManager';

interface RegisterTunnelIpcOptions {
  afterSettingsChange?: () => Promise<void> | void;
}

async function changed(options?: RegisterTunnelIpcOptions): Promise<void> {
  await options?.afterSettingsChange?.();
}

export function registerTunnelIpc(ipcMain: IpcMain, manager: MihomoManager, options?: RegisterTunnelIpcOptions): void {
  ipcMain.handle('tunnel:snapshot', () => manager.snapshot());

  ipcMain.handle('tunnel:create-subscription', (_event, input) => manager.createSubscription(input));
  ipcMain.handle('tunnel:set-active-subscription', (_event, id: number) => manager.setActiveSubscription(id));
  ipcMain.handle('tunnel:update-subscription', (_event, id: number) => manager.updateSubscription(id));
  ipcMain.handle('tunnel:update-active-subscription', () => manager.updateActiveSubscription());
  ipcMain.handle('tunnel:set-mode', async (_event, mode) => {
    manager.setMode(mode);
    await changed(options);
  });
  ipcMain.handle('tunnel:set-core-path', (_event, corePath: string) => manager.setCorePath(corePath));
  ipcMain.handle('tunnel:set-local-ports', async (_event, ports) => {
    await manager.setLocalPorts(ports);
    await changed(options);
  });
  ipcMain.handle('tunnel:install-tun', async () => {
    manager.installTunFeature();
    await changed(options);
  });
  ipcMain.handle('tunnel:uninstall-tun', async () => {
    manager.uninstallTunFeature();
    await changed(options);
  });
  ipcMain.handle('tunnel:start', () => manager.start());
  ipcMain.handle('tunnel:stop', () => manager.stop());
  ipcMain.handle('tunnel:restart', () => manager.restart());
  ipcMain.handle('tunnel:add-rule', (_event, input) => manager.addDomainRule(input.kind, input.domain));
  ipcMain.handle('tunnel:remove-rule', (_event, id: number) => manager.removeDomainRule(id));
  ipcMain.handle('tunnel:add-preset', (_event, preset) => manager.addPreset(preset));
}
