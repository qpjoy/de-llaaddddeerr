const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('h2o', {
  getState: () => ipcRenderer.invoke('h2o:get-state'),
  connectBroker: () => ipcRenderer.invoke('h2o:connect-broker'),
  refresh: () => ipcRenderer.invoke('h2o:refresh'),
  setMode: (mode) => ipcRenderer.invoke('h2o:set-mode', mode),
  requestBroker: (name, payload) => ipcRenderer.invoke('h2o:request-broker', name, payload),
  windowControl: (action) => ipcRenderer.invoke('h2o:window-control', action),
  onState: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('h2o:state', wrapped);
    return () => ipcRenderer.removeListener('h2o:state', wrapped);
  }
});
