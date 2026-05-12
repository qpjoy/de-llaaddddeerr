const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpjoyTunnelTest', {
  status: () => ipcRenderer.invoke('tunnel-test:status'),
  snapshot: () => ipcRenderer.invoke('tunnel-test:snapshot'),
  addRule: (input) => ipcRenderer.invoke('tunnel-test:add-rule', input),
  removeRule: (id) => ipcRenderer.invoke('tunnel-test:remove-rule', id),
  addPreset: (preset) => ipcRenderer.invoke('tunnel-test:add-preset', preset),
  removePreset: (preset) => ipcRenderer.invoke('tunnel-test:remove-preset', preset),
  openTestWindow: (url) => ipcRenderer.invoke('tunnel-test:open-test-window', url),
  openAdmin: () => ipcRenderer.invoke('tunnel-test:open-admin'),
  onEvent: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('tunnel-test:event', listener);
    return () => ipcRenderer.removeListener('tunnel-test:event', listener);
  }
});
