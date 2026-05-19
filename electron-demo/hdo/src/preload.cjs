// Bridges the demo landing page renderer to main-process IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qpjoyDemo', {
  /** Navigate the current window to the marketplace admin panel. */
  openMarket: () => ipcRenderer.invoke('demo:open-market', 'same-window'),
  /** Pop a new window for the marketplace admin panel. */
  openMarketInNewWindow: () => ipcRenderer.invoke('demo:open-market', 'new-window'),
  /** Return to this demo's landing page. */
  goHome: () => ipcRenderer.invoke('demo:go-home')
});
