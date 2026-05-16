// Overlay-window preload. Bridges the ball renderer to the main-process
// overlay manager via a tiny, validated API surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notyetBall', {
  // Cover window control.
  openChat: () => ipcRenderer.invoke('notyet:open-chat'),
  closeChat: () => ipcRenderer.invoke('notyet:close-chat'),
  hideBall: () => ipcRenderer.invoke('notyet:hide-ball'),

  // State sync.
  queryState: () => ipcRenderer.invoke('notyet:query-state'),
  onCoverState: (handler) => {
    const listener = (_ev, payload) => handler(payload);
    ipcRenderer.on('notyet:cover-state', listener);
    return () => ipcRenderer.off('notyet:cover-state', listener);
  },

  // Hot-rect reporting: tell main where the orbit currently is (in window
  // coordinates) so its cursor-polling can decide capture vs passthrough.
  // Fire-and-forget — no return value.
  setHotRect: (rect) => ipcRenderer.send('notyet:set-hot-rect',
    rect && typeof rect === 'object' ? rect : null),
  // Lock capture mode during a drag — main process keeps the overlay in
  // capturing state until we say otherwise (so the cursor can leave the hot
  // rect mid-drag without breaking the gesture).
  setDrag: (dragging) => ipcRenderer.send('notyet:set-drag', Boolean(dragging)),

  // Per-window ball position. The main process derives the window key from
  // sender.webContents and persists into the plugin's `userDataDir`.
  loadPosition: () => ipcRenderer.invoke('notyet:load-position'),
  savePosition: (pos) => ipcRenderer.invoke('notyet:save-position', pos)
});
