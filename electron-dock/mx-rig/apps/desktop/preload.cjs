const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld(
  'mxRig',
  Object.freeze({
    desktop: true,
    request: (action, body) => ipcRenderer.invoke('mx-rig:request', { action, body })
  })
)
