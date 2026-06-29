import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getRuntime: () => ipcRenderer.invoke('luopan:get-runtime'),
  saveConfig: (input: unknown) => ipcRenderer.invoke('luopan:save-config', input),
  connectTestMode: () => ipcRenderer.invoke('luopan:connect-test-mode'),
  applyDataPlane: () => ipcRenderer.invoke('luopan:apply-data-plane'),
  disconnectDataPlane: () => ipcRenderer.invoke('luopan:disconnect-data-plane'),
  refreshSnapshot: () => ipcRenderer.invoke('luopan:refresh-snapshot'),
  resetSession: () => ipcRenderer.invoke('luopan:reset-session'),
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
