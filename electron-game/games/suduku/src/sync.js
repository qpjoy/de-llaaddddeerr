"use strict";

class LocalScoreSync {
  constructor(localDatabase, env = process.env) {
    this.localDatabase = localDatabase;
    this.env = env;
  }

  isConfigured() {
    return true;
  }

  async syncNow() {
    return {
      ok: true,
      reason: "marketplace_sqlite",
      synced: 0
    };
  }

  async getRemoteLeaderboard(mode = "9x9", limit = 20) {
    return this.localDatabase.getLocalLeaderboard(mode, limit);
  }
}

module.exports = {
  LocalScoreSync
};
