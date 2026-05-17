"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("suduku", {
  getPlayer: () => ipcRenderer.invoke("suduku:get-player"),
  setLocalPlayer: (name) => ipcRenderer.invoke("suduku:set-local-player", name),
  saveScore: (score) => ipcRenderer.invoke("suduku:save-score", score),
  getLeaderboard: (mode) => ipcRenderer.invoke("suduku:get-leaderboard", mode),
  syncNow: () => ipcRenderer.invoke("suduku:sync-now")
});
