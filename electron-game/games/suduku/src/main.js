"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { SudukuDatabase } = require("./database");
const { LocalScoreSync } = require("./sync");

let database;
let syncService;

function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 860,
    minHeight: 680,
    title: "Suduku",
    backgroundColor: "#f8f5ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function registerIpc() {
  ipcMain.handle("suduku:get-player", () => {
    return {
      player: database.getPlayer(),
      suggestedName: database.getSuggestedPlayerName(),
      syncConfigured: syncService.isConfigured()
    };
  });

  ipcMain.handle("suduku:set-local-player", (_event, name) => {
    return database.setLocalPlayer(name);
  });

  ipcMain.handle("suduku:save-score", async (_event, score) => {
    const saved = database.saveScore(score);
    const sync = await syncService.syncNow();
    return {
      saved,
      sync
    };
  });

  ipcMain.handle("suduku:get-leaderboard", async (_event, mode) => {
    return {
      source: "sqlite",
      rows: await syncService.getRemoteLeaderboard(mode)
    };
  });

  ipcMain.handle("suduku:sync-now", async () => {
    return syncService.syncNow();
  });
}

app.whenReady().then(() => {
  database = new SudukuDatabase({ userDataDir: app.getPath("userData") });
  syncService = new LocalScoreSync(database);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
