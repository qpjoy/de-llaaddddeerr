import type { IpcMain } from 'electron';

import type { MihomoManager } from '../mihomo/MihomoManager';

interface RegisterTunnelIpcOptions {
  afterSettingsChange?: () => Promise<void> | void;
}

async function changed(options?: RegisterTunnelIpcOptions): Promise<void> {
  await options?.afterSettingsChange?.();
}

async function runtimeChanged(manager: MihomoManager, options?: RegisterTunnelIpcOptions): Promise<void> {
  await manager.applyRuntimeConfigChange();
  await changed(options);
}

/**
 * Channel names this module owns. Kept in one place so the registration AND
 * the unregister-on-dispose paths can't drift.
 */
const TUNNEL_IPC_CHANNELS = [
  'tunnel:snapshot',
  'tunnel:create-subscription',
  'tunnel:edit-subscription',
  'tunnel:delete-subscription',
  'tunnel:set-active-subscription',
  'tunnel:update-subscription',
  'tunnel:update-active-subscription',
  'tunnel:set-mode',
  'tunnel:set-core-path',
  'tunnel:set-local-ports',
  'tunnel:install-tun',
  'tunnel:uninstall-tun',
  'tunnel:start',
  'tunnel:stop',
  'tunnel:restart',
  'tunnel:add-rule',
  'tunnel:remove-rule',
  'tunnel:add-preset',
  'tunnel:remove-preset'
] as const;

/**
 * Wire up the tunnel's IPC handlers. Returns a cleanup function that
 * removes every handler we registered — must be called from
 * `createElectronTunnel().close()` so that re-activating the plugin
 * (e.g. after an upgrade) doesn't trip Electron's "second handler" guard.
 */
export function registerTunnelIpc(
  ipcMain: IpcMain,
  manager: MihomoManager,
  options?: RegisterTunnelIpcOptions
): () => void {
  ipcMain.handle('tunnel:snapshot', () => manager.snapshot());

  ipcMain.handle('tunnel:create-subscription', async (_event, input) => {
    const subscription = await manager.createSubscription(input);
    if (subscription.active) {
      await runtimeChanged(manager, options);
    } else {
      await changed(options);
    }
    return subscription;
  });
  ipcMain.handle('tunnel:edit-subscription', async (_event, input) => {
    const subscription = await manager.editSubscription(input);
    if (subscription.active) {
      await runtimeChanged(manager, options);
    } else {
      await changed(options);
    }
    return subscription;
  });
  ipcMain.handle('tunnel:delete-subscription', async (_event, id: number) => {
    manager.deleteSubscription(id);
    await runtimeChanged(manager, options);
  });
  ipcMain.handle('tunnel:set-active-subscription', async (_event, id: number) => {
    const subscription = manager.setActiveSubscription(id);
    await runtimeChanged(manager, options);
    return subscription;
  });
  ipcMain.handle('tunnel:update-subscription', async (_event, id: number) => {
    const subscription = await manager.updateSubscription(id);
    if (subscription.active) {
      await runtimeChanged(manager, options);
    } else {
      await changed(options);
    }
    return subscription;
  });
  ipcMain.handle('tunnel:update-active-subscription', async () => {
    const subscription = await manager.updateActiveSubscription();
    await runtimeChanged(manager, options);
    return subscription;
  });
  ipcMain.handle('tunnel:set-mode', async (_event, mode) => {
    const changedMode = manager.setMode(mode);
    if (changedMode) {
      await runtimeChanged(manager, options);
    } else {
      await changed(options);
    }
  });
  ipcMain.handle('tunnel:set-core-path', async (_event, corePath: string) => {
    manager.setCorePath(corePath);
    await changed(options);
  });
  ipcMain.handle('tunnel:set-local-ports', async (_event, ports) => {
    await manager.setLocalPorts(ports);
    await changed(options);
  });
  ipcMain.handle('tunnel:install-tun', async () => {
    manager.installTunFeature();
    await runtimeChanged(manager, options);
  });
  ipcMain.handle('tunnel:uninstall-tun', async () => {
    manager.uninstallTunFeature();
    await runtimeChanged(manager, options);
  });
  ipcMain.handle('tunnel:start', async () => {
    await manager.start();
    await changed(options);
  });
  ipcMain.handle('tunnel:stop', async () => {
    await manager.stop();
    await changed(options);
  });
  ipcMain.handle('tunnel:restart', async () => {
    await manager.restart();
    await changed(options);
  });
  ipcMain.handle('tunnel:add-rule', async (_event, input) => {
    const rule = manager.addDomainRule(input.kind, input.domain);
    await runtimeChanged(manager, options);
    return rule;
  });
  ipcMain.handle('tunnel:remove-rule', async (_event, id: number) => {
    manager.removeDomainRule(id);
    await runtimeChanged(manager, options);
  });
  ipcMain.handle('tunnel:add-preset', async (_event, preset) => {
    const rules = manager.addPreset(preset);
    await runtimeChanged(manager, options);
    return rules;
  });
  ipcMain.handle('tunnel:remove-preset', async (_event, preset) => {
    const count = manager.removePreset(preset);
    await runtimeChanged(manager, options);
    return count;
  });

  return function disposeTunnelIpc(): void {
    for (const channel of TUNNEL_IPC_CHANNELS) {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        // already removed by another caller — fine
      }
    }
  };
}
