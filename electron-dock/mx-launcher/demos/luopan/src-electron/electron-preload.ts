import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getRuntime: () => ipcRenderer.invoke('luopan:get-runtime'),
  saveConfig: (input: unknown) => ipcRenderer.invoke('luopan:save-config', input),
  login: (input: { account: string; password: string }) => ipcRenderer.invoke('luopan:login', input),
  logout: () => ipcRenderer.invoke('luopan:logout'),
  connectTestMode: () => ipcRenderer.invoke('luopan:connect-test-mode'),
  connectInternal: () => ipcRenderer.invoke('luopan:connect-internal'),
  applyDataPlane: () => ipcRenderer.invoke('luopan:apply-data-plane'),
  disconnectDataPlane: () => ipcRenderer.invoke('luopan:disconnect-data-plane'),
  refreshSnapshot: () => ipcRenderer.invoke('luopan:refresh-snapshot'),
  resetSession: () => ipcRenderer.invoke('luopan:reset-session'),
  checkUpdates: () => ipcRenderer.invoke('luopan:check-updates'),
  applyUpdate: () => ipcRenderer.invoke('luopan:apply-update'),
  openStagedInstaller: () => ipcRenderer.invoke('luopan:open-staged-installer'),
  rollbackUpdateSlot: (slot: 'config' | 'renderer') => ipcRenderer.invoke('luopan:rollback-update-slot', slot),
  openAdmin: () => ipcRenderer.invoke('luopan:open-admin'),
  openInternalEntry: () => ipcRenderer.invoke('luopan:open-internal-entry'),
  onRuntime: (listener: (state: unknown) => void) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('luopan:runtime', wrapped);
    return () => ipcRenderer.removeListener('luopan:runtime', wrapped);
  }
};

contextBridge.exposeInMainWorld('luopanLauncher', api);
