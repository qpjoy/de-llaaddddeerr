const { contextBridge, ipcRenderer } = require('electron');

const api = {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('mx-h2i:get-state'),
  saveConfig: (input) => ipcRenderer.invoke('mx-h2i:save-config', input),
  connectGuest: () => ipcRenderer.invoke('mx-h2i:connect-guest'),
  loginEmployee: (input) => ipcRenderer.invoke('mx-h2i:login-employee', input),
  startFeishuLogin: () => ipcRenderer.invoke('mx-h2i:start-feishu-login'),
  cancelFeishuLogin: () => ipcRenderer.invoke('mx-h2i:cancel-feishu-login'),
  disconnect: () => ipcRenderer.invoke('mx-h2i:disconnect'),
  installAppCenter: () => ipcRenderer.invoke('mx-h2i:install-appcenter'),
  enableH2o: () => ipcRenderer.invoke('mx-h2i:enable-h2o'),
  launchH2o: () => ipcRenderer.invoke('mx-h2i:launch-h2o'),
  stopH2o: () => ipcRenderer.invoke('mx-h2i:stop-h2o'),
  setH2oMode: (mode) => ipcRenderer.invoke('mx-h2i:set-h2o-mode', mode),
  updateH2oRuntime: (patch) => ipcRenderer.invoke('mx-h2i:update-h2o-runtime', patch),
  refreshH2oSubscription: (input) => ipcRenderer.invoke('mx-h2i:refresh-h2o-subscription', input),
  provisionH2oOversea: (input) => ipcRenderer.invoke('mx-h2i:provision-h2o-oversea', input),
  openH2oTestWindow: (input) => ipcRenderer.invoke('mx-h2i:open-h2o-test-window', input),
  checkUpdates: () => ipcRenderer.invoke('mx-h2i:check-updates'),
  applyUpdate: () => ipcRenderer.invoke('mx-h2i:apply-update'),
  installRelease: (releaseId) => ipcRenderer.invoke('mx-h2i:install-release', releaseId),
  showDownloadedInstaller: () => ipcRenderer.invoke('mx-h2i:show-downloaded-installer'),
  restartApp: () => ipcRenderer.invoke('mx-h2i:restart-app'),
  openRollbackInstaller: (rollbackId) => ipcRenderer.invoke('mx-h2i:open-rollback', rollbackId),
  refreshDiagnostics: () => ipcRenderer.invoke('mx-h2i:refresh-diagnostics'),
  openDiagnosticLogs: () => ipcRenderer.invoke('mx-h2i:open-diagnostic-logs'),
  exportDiagnostics: () => ipcRenderer.invoke('mx-h2i:export-diagnostics'),
  listStateBackups: () => ipcRenderer.invoke('mx-h2i:list-state-backups'),
  restoreStateBackup: (fileName) => ipcRenderer.invoke('mx-h2i:restore-state-backup', fileName),
  repairSystemNetwork: () => ipcRenderer.invoke('mx-h2i:repair-system-network'),
  openAdmin: () => ipcRenderer.invoke('mx-h2i:open-admin'),
  setWindowMode: (mode) => ipcRenderer.invoke('mx-h2i:set-window-mode', mode),
  startWindowDrag: (input) => ipcRenderer.invoke('mx-h2i:start-window-drag', input),
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
