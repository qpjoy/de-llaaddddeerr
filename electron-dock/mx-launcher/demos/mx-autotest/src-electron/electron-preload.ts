import { contextBridge, ipcRenderer } from 'electron';

const api = Object.freeze({
  getRuntime: () => ipcRenderer.invoke('mx-autotest:get-runtime'),
  connectInternal: () => ipcRenderer.invoke('mx-autotest:connect-internal'),
  login: (input: { account: string; password: string }) => ipcRenderer.invoke('mx-autotest:login', input),
  logout: () => ipcRenderer.invoke('mx-autotest:logout'),
  disconnect: () => ipcRenderer.invoke('mx-autotest:disconnect'),
  getPlatformSnapshot: () => ipcRenderer.invoke('mx-autotest:get-platform-snapshot'),
  runTask: (input: { taskId: string; caseFilter?: string }) => (
    ipcRenderer.invoke('mx-autotest:run-task', input)
  ),
  onRuntime: (listener: (state: unknown) => void) => {
    if (typeof listener !== 'function') return () => undefined;
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on('mx-autotest:runtime', wrapped);
    return () => ipcRenderer.removeListener('mx-autotest:runtime', wrapped);
  }
});

contextBridge.exposeInMainWorld('mxAutotest', api);
