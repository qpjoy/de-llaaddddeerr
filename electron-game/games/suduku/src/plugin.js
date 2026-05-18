"use strict";

const path = require("node:path");
const { BrowserWindow } = require("electron");
const { SudukuDatabase } = require("./database");
const { LocalScoreSync } = require("./sync");

const CHANNELS = [
  "suduku:get-player",
  "suduku:set-local-player",
  "suduku:save-score",
  "suduku:get-leaderboard",
  "suduku:sync-now"
];

function createSudukuWindow(ctx) {
  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 860,
    minHeight: 680,
    title: "Suduku",
    backgroundColor: "#f8f5ef",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      session: ctx.host.session,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return window;
}

module.exports = {
  activate(ctx) {
    if (!ctx.host.marketplaceDb || typeof ctx.host.marketplaceDb.raw !== "function") {
      throw new Error(
        "Suduku requires @qpjoy/electron-market >=0.3.14 so game scores can use the shared marketplace SQLite database. Please upgrade the market host, then reinstall or upgrade Suduku."
      );
    }

    const database = new SudukuDatabase({
      marketplaceDb: ctx.host.marketplaceDb,
      userDataDir: ctx.userDataDir
    });
    const syncService = new LocalScoreSync(database, {
      marketplaceDb: ctx.host.marketplaceDb,
      fetch: ctx.fetch
    });
    const ipcMain = ctx.host.ipcMain;
    let gameWindow = null;

    function launch() {
      if (gameWindow && !gameWindow.isDestroyed()) {
        gameWindow.show();
        gameWindow.focus();
        return { ok: true, reused: true };
      }

      gameWindow = createSudukuWindow(ctx);
      gameWindow.on("closed", () => {
        gameWindow = null;
      });
      return { ok: true, reused: false };
    }

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
      return syncService.getLeaderboard(mode);
    });

    ipcMain.handle("suduku:sync-now", async () => {
      return syncService.syncNow();
    });

    ctx.expose({
      launch,
      status: () => ({
        ready: true,
        syncConfigured: syncService.isConfigured()
      })
    });

    ctx.log.info("Suduku game plugin activated");

    return () => {
      for (const channel of CHANNELS) {
        ipcMain.removeHandler(channel);
      }
      if (gameWindow && !gameWindow.isDestroyed()) {
        gameWindow.close();
      }
      gameWindow = null;
      database.close();
      ctx.log.info("Suduku game plugin deactivated");
    };
  }
};
