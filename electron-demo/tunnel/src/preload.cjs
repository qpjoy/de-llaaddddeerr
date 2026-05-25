// Bridges the demo landing page renderer to main-process IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpjoyDemo', {
  /** Navigate the current window to the marketplace admin panel. */
  openMarket: () => ipcRenderer.invoke('demo:open-market', 'same-window'),
  /** Pop a new window for the marketplace admin panel. */
  openMarketInNewWindow: () => ipcRenderer.invoke('demo:open-market', 'new-window'),
  /** Return to this demo's landing page. */
  goHome: () => ipcRenderer.invoke('demo:go-home'),
  /** Read local marketplace/tunnel status for the landing page. */
  status: () => ipcRenderer.invoke('demo:status'),
  /** Persist the marketplace backend URL; effective for sync after restart. */
  setMarketServer: (input) => ipcRenderer.invoke('demo:set-market-server', input),
  /** Log in to D, fetch the user's managed tunnel profile, and apply it locally. */
  applyBackendConfig: (input) => ipcRenderer.invoke('demo:apply-backend-config', input),
  /** Let a consuming app drive tunnel mode directly through marketplace/plugin IPC. */
  setTunnelMode: (mode) => ipcRenderer.invoke('demo:set-tunnel-mode', mode)
});
