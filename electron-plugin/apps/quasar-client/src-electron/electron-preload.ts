import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tunnel', {
  snapshot: () => ipcRenderer.invoke('tunnel:snapshot'),
  createSubscription: (input: unknown) => ipcRenderer.invoke('tunnel:create-subscription', input),
  editSubscription: (input: unknown) => ipcRenderer.invoke('tunnel:edit-subscription', input),
  deleteSubscription: (id: number) => ipcRenderer.invoke('tunnel:delete-subscription', id),
  setActiveSubscription: (id: number) => ipcRenderer.invoke('tunnel:set-active-subscription', id),
  updateSubscription: (id: number) => ipcRenderer.invoke('tunnel:update-subscription', id),
  updateActiveSubscription: () => ipcRenderer.invoke('tunnel:update-active-subscription'),
  setMode: (mode: string) => ipcRenderer.invoke('tunnel:set-mode', mode),
  setCorePath: (corePath: string) => ipcRenderer.invoke('tunnel:set-core-path', corePath),
  setLocalPorts: (ports: unknown) => ipcRenderer.invoke('tunnel:set-local-ports', ports),
  installTun: () => ipcRenderer.invoke('tunnel:install-tun'),
  uninstallTun: () => ipcRenderer.invoke('tunnel:uninstall-tun'),
  start: () => ipcRenderer.invoke('tunnel:start'),
  stop: () => ipcRenderer.invoke('tunnel:stop'),
  restart: () => ipcRenderer.invoke('tunnel:restart'),
  openAdmin: () => ipcRenderer.invoke('tunnel:open-admin'),
  openTestWindow: (url: string) => ipcRenderer.invoke('tunnel:open-test-window', url),
  addRule: (input: unknown) => ipcRenderer.invoke('tunnel:add-rule', input),
  removeRule: (id: number) => ipcRenderer.invoke('tunnel:remove-rule', id),
  addPreset: (preset: string) => ipcRenderer.invoke('tunnel:add-preset', preset),
  removePreset: (preset: string) => ipcRenderer.invoke('tunnel:remove-preset', preset)
});
