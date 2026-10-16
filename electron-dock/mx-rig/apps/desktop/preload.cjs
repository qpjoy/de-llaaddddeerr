const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld(
  'mxRig',
  Object.freeze({
    desktop: true,
    request: (action, body) => ipcRenderer.invoke('mx-rig:request', { action, body }),
    // Live frames of the page the Agent is driving. Data only, one way.
    onFrame: (callback) => {
      const listener = (_event, frame) => callback(frame)
      ipcRenderer.on('mx-rig:frame', listener)
      return () => ipcRenderer.off('mx-rig:frame', listener)
    },
    // The page asked for a file while a person has it.
    onChooser: (callback) => {
      const listener = (_event, info) => callback(info)
      ipcRenderer.on('mx-rig:chooser', listener)
      return () => ipcRenderer.off('mx-rig:chooser', listener)
    },
    // The test browser being fetched on first use: progress, then ready or not.
    onProvision: (callback) => {
      const listener = (_event, info) => callback(info)
      ipcRenderer.on('mx-rig:provision', listener)
      return () => ipcRenderer.off('mx-rig:provision', listener)
    },
    // Launcher mode (docs/25): this product's own network, as it changes.
    onNetwork: (callback) => {
      const listener = (_event, info) => callback(info)
      ipcRenderer.on('mx-rig:network', listener)
      return () => ipcRenderer.off('mx-rig:network', listener)
    },
    // …its overseas channel: state and texts, never the subscription or its port.
    onOversea: (callback) => {
      const listener = (_event, info) => callback(info)
      ipcRenderer.on('mx-rig:oversea', listener)
      return () => ipcRenderer.off('mx-rig:oversea', listener)
    },
    // …and its updates from Launcher's Release Center: a projection, no paths or URLs.
    onUpdate: (callback) => {
      const listener = (_event, info) => callback(info)
      ipcRenderer.on('mx-rig:update', listener)
      return () => ipcRenderer.off('mx-rig:update', listener)
    },
    // The page raised an alert / confirm / prompt while a person has it.
    onDialog: (callback) => {
      const listener = (_event, info) => callback(info)
      ipcRenderer.on('mx-rig:dialog', listener)
      return () => ipcRenderer.off('mx-rig:dialog', listener)
    }
  })
)
