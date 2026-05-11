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
  ipcMain.handle('tunnel:delete-subscription', async (_event, id: number) => {
    manager.deleteSubscription(id);
    await manager.applyRuntimeConfigChange();
  });
  ipcMain.handle('tunnel:set-active-subscription', async (_event, id: number) => {
    const subscription = manager.setActiveSubscription(id);
    await manager.applyRuntimeConfigChange();
    return subscription;
  });
  ipcMain.handle('tunnel:update-subscription', async (_event, id: number) => {
    const subscription = await manager.updateSubscription(id);
    if (subscription.active) {
      await manager.applyRuntimeConfigChange();
    }
    return subscription;
  });
  ipcMain.handle('tunnel:update-active-subscription', async () => {
    const subscription = await manager.updateActiveSubscription();
    await manager.applyRuntimeConfigChange();
    return subscription;
  });
  ipcMain.handle('tunnel:set-mode', async (_event, mode) => {
    manager.setMode(mode);
    await manager.applyRuntimeConfigChange();
    await changed(options);
  });
  ipcMain.handle('tunnel:set-core-path', (_event, corePath: string) => manager.setCorePath(corePath));
  ipcMain.handle('tunnel:set-local-ports', async (_event, ports) => {
    await manager.setLocalPorts(ports);
    await changed(options);
  });
  ipcMain.handle('tunnel:install-tun', async () => {
    manager.installTunFeature();
    await manager.applyRuntimeConfigChange();
    await changed(options);
  });
  ipcMain.handle('tunnel:uninstall-tun', async () => {
    manager.uninstallTunFeature();
    await manager.applyRuntimeConfigChange();
    await changed(options);
  });
  ipcMain.handle('tunnel:start', () => manager.start());
  ipcMain.handle('tunnel:stop', () => manager.stop());
  ipcMain.handle('tunnel:restart', () => manager.restart());
  ipcMain.handle('tunnel:add-rule', async (_event, input) => {
    const rule = manager.addDomainRule(input.kind, input.domain);
    await manager.applyRuntimeConfigChange();
    return rule;
  });
  ipcMain.handle('tunnel:remove-rule', async (_event, id: number) => {
    manager.removeDomainRule(id);
    await manager.applyRuntimeConfigChange();
  });
  ipcMain.handle('tunnel:add-preset', async (_event, preset) => {
    const rules = manager.addPreset(preset);
    await manager.applyRuntimeConfigChange();
    return rules;
  });
}
