// Bridges the demo landing page renderer to main-process IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpjoyDemo', {
  /** Navigate the current window to the marketplace admin panel. */
  openMarket: () => ipcRenderer.invoke('demo:open-market', 'same-window'),
  /** Pop a new window for the marketplace admin panel. */
  openMarketInNewWindow: () => ipcRenderer.invoke('demo:open-market', 'new-window'),
  /** Return to this demo's landing page. */
  goHome: () => ipcRenderer.invoke('demo:go-home'),
  /** Read HDO plugin status without requiring a marketplace login. */
  hdoStatus: () => ipcRenderer.invoke('demo:hdo-status'),
  /** Enter the public anonymous relay flow. */
  hdoAnonymousConnect: (payload) => ipcRenderer.invoke('demo:hdo-anonymous-connect', payload),
  /** Open a URL inside Electron's default session so HDO domain proxy rules apply. */
  hdoOpenTestUrl: (url) => ipcRenderer.invoke('demo:hdo-open-test-url', url),
  /** Stop the current HDO WireGuard tunnel. */
  hdoStop: () => ipcRenderer.invoke('demo:hdo-stop')
});
