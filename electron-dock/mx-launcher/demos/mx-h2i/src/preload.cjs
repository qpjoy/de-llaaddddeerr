const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('mx-h2i:get-state'),
  saveConfig: (input) => ipcRenderer.invoke('mx-h2i:save-config', input),
  connectGuest: () => ipcRenderer.invoke('mx-h2i:connect-guest'),
  loginEmployee: (input) => ipcRenderer.invoke('mx-h2i:login-employee', input),
  disconnect: () => ipcRenderer.invoke('mx-h2i:disconnect'),
  installAppCenter: () => ipcRenderer.invoke('mx-h2i:install-appcenter'),
  enableH2o: () => ipcRenderer.invoke('mx-h2i:enable-h2o'),
  launchH2o: () => ipcRenderer.invoke('mx-h2i:launch-h2o'),
  stopH2o: () => ipcRenderer.invoke('mx-h2i:stop-h2o'),
  setH2oMode: (mode) => ipcRenderer.invoke('mx-h2i:set-h2o-mode', mode),
  updateH2oRuntime: (patch) => ipcRenderer.invoke('mx-h2i:update-h2o-runtime', patch),
  checkUpdates: () => ipcRenderer.invoke('mx-h2i:check-updates'),
  applyUpdate: () => ipcRenderer.invoke('mx-h2i:apply-update'),
  restartApp: () => ipcRenderer.invoke('mx-h2i:restart-app'),
  openRollbackInstaller: (rollbackId) => ipcRenderer.invoke('mx-h2i:open-rollback', rollbackId),
  refreshDiagnostics: () => ipcRenderer.invoke('mx-h2i:refresh-diagnostics'),
  repairSystemNetwork: () => ipcRenderer.invoke('mx-h2i:repair-system-network'),
  openAdmin: () => ipcRenderer.invoke('mx-h2i:open-admin'),
  setWindowMode: (mode) => ipcRenderer.invoke('mx-h2i:set-window-mode', mode),
  moveWindowBy: (delta) => ipcRenderer.invoke('mx-h2i:move-window-by', delta),
  finishWindowDrag: (input) => ipcRenderer.invoke('mx-h2i:finish-window-drag', input),
  hideTopDockIfPending: () => ipcRenderer.invoke('mx-h2i:hide-top-dock-if-pending'),
  windowControl: (action) => ipcRenderer.invoke('mx-h2i:window-control', action),
  onState: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('mx-h2i:state', wrapped);
    return () => ipcRenderer.removeListener('mx-h2i:state', wrapped);
  }
};

contextBridge.exposeInMainWorld('mxH2i', api);
