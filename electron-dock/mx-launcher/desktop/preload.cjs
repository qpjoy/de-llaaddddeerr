const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mxLauncher', {
  getConfig: () => ipcRenderer.invoke('launcher:get-config'),
  saveConfig: (input) => ipcRenderer.invoke('launcher:save-config', input),
  getProducts: () => ipcRenderer.invoke('launcher:get-products'),
  getStatus: () => ipcRenderer.invoke('launcher:get-status'),
  launchProduct: (input) => ipcRenderer.invoke('launcher:launch-product', input),
  disconnect: () => ipcRenderer.invoke('launcher:disconnect'),
  openAdmin: (serverBaseUrl) => ipcRenderer.invoke('launcher:open-admin', serverBaseUrl)
});
