// Bridges the HDO renderer to main-process IPC.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  /** Navigate the current window to the marketplace admin panel. */
  openMarket: () => ipcRenderer.invoke('demo:open-market', 'same-window'),
  /** Pop a new window for the marketplace admin panel. */
  openMarketInNewWindow: () => ipcRenderer.invoke('demo:open-market', 'new-window'),
  /** Return to the HDO home page. */
  goHome: () => ipcRenderer.invoke('demo:go-home'),
  /** Read HDO plugin status without requiring a marketplace login. */
  hdoStatus: () => ipcRenderer.invoke('demo:hdo-status'),
  /** Enter the public anonymous relay flow. */
  hdoAnonymousConnect: (payload) => ipcRenderer.invoke('demo:hdo-anonymous-connect', payload),
  /** Switch the current HDO connection into the anonymous network. */
  hdoSwitchAnonymous: (payload) => ipcRenderer.invoke('demo:hdo-switch-anonymous', payload),
  /** Login with a marketplace account and connect with the account manifest. */
  hdoAccountConnect: (payload) => ipcRenderer.invoke('demo:hdo-account-connect', payload),
  /** Persist HDO plugin settings. */
  hdoUpdateSettings: (patch) => ipcRenderer.invoke('demo:hdo-update-settings', patch),
  /** Open a URL inside Electron's default session so HDO domain proxy rules apply. */
  hdoOpenTestUrl: (url) => ipcRenderer.invoke('demo:hdo-open-test-url', url),
  /** Stop the current HDO WireGuard tunnel. */
  hdoStop: () => ipcRenderer.invoke('demo:hdo-stop'),
  /** Re-apply HDO DNS/route priority rules for the active tunnel. */
  hdoRepairDns: () => ipcRenderer.invoke('demo:hdo-repair-dns'),
  /** Ask the embedded market host to check release policies now. */
  checkUpdates: () => ipcRenderer.invoke('demo:check-updates'),
  /** Subscribe to HDO state changes pushed by the plugin. */
  onHdoEvent: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('demo:hdo-event', wrapped);
    return () => ipcRenderer.removeListener('demo:hdo-event', wrapped);
  }
};

contextBridge.exposeInMainWorld('qpjoyHdo', api);
contextBridge.exposeInMainWorld('qpjoyDemo', api);
