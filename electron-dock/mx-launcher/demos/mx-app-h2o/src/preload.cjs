const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('h2o', {
  getState: () => ipcRenderer.invoke('h2o:get-state'),
  connectBroker: () => ipcRenderer.invoke('h2o:connect-broker'),
  refresh: () => ipcRenderer.invoke('h2o:refresh'),
  setMode: (mode) => ipcRenderer.invoke('h2o:set-mode', mode),
  startRuntime: () => ipcRenderer.invoke('h2o:start-runtime'),
  stopRuntime: () => ipcRenderer.invoke('h2o:stop-runtime'),
  installTun: () => ipcRenderer.invoke('h2o:install-tun'),
  uninstallTun: () => ipcRenderer.invoke('h2o:uninstall-tun'),
  setPorts: (input) => ipcRenderer.invoke('h2o:set-ports', input),
  addSubscription: (input) => ipcRenderer.invoke('h2o:add-subscription', input),
  setActiveSubscription: (subscriptionId) => ipcRenderer.invoke('h2o:set-active-subscription', subscriptionId),
  refreshSubscription: (subscriptionId) => ipcRenderer.invoke('h2o:refresh-subscription', subscriptionId),
  toggleRule: (ruleId) => ipcRenderer.invoke('h2o:toggle-rule', ruleId),
  requestBroker: (name, payload) => ipcRenderer.invoke('h2o:request-broker', name, payload),
  windowControl: (action) => ipcRenderer.invoke('h2o:window-control', action),
  onState: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('h2o:state', wrapped);
    return () => ipcRenderer.removeListener('h2o:state', wrapped);
  }
});
