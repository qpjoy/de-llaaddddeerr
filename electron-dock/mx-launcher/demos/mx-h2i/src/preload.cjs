const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('mx-h2i:get-state'),
  saveConfig: (input) => ipcRenderer.invoke('mx-h2i:save-config', input),
  connectGuest: () => ipcRenderer.invoke('mx-h2i:connect-guest'),
  loginEmployee: (input) => ipcRenderer.invoke('mx-h2i:login-employee', input),
  disconnect: () => ipcRenderer.invoke('mx-h2i:disconnect'),
  installAppCenter: () => ipcRenderer.invoke('mx-h2i:install-appcenter'),
  enableH2o: () => ipcRenderer.invoke('mx-h2i:enable-h2o'),
  checkUpdates: () => ipcRenderer.invoke('mx-h2i:check-updates'),
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
