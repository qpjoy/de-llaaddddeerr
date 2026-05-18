"use strict";

const { GAME_ID, PLUGIN_ID } = require("./database");

const DEFAULT_DEV_SERVER = "http://127.0.0.1:8080";
const META_KEY_MARKET_SERVER = "settings.marketServer";

class LocalScoreSync {
  constructor(localDatabase, opts = {}, env = process.env) {
    this.localDatabase = localDatabase;
    this.marketplaceDb = opts.marketplaceDb || localDatabase.marketplaceDb || null;
    this.hasExplicitServerBaseUrl = Object.prototype.hasOwnProperty.call(opts, "serverBaseUrl");
    this.serverBaseUrl = this.hasExplicitServerBaseUrl ? opts.serverBaseUrl || null : null;
    this.useDevDefault = opts.useDevDefault ?? !this.hasExplicitServerBaseUrl;
    this.env = env;
    this.timeoutMs = opts.timeoutMs || 8000;
    this.fetch = opts.fetch || fetch;
  }

  hasRemoteServer() {
    return Boolean(this.resolveServerBaseUrl());
  }

  isConfigured() {
    return Boolean(this.hasRemoteServer() && this.getAccessToken());
  }

  getStatus() {
    return {
      serverConfigured: this.hasRemoteServer(),
      authenticated: Boolean(this.getAccessToken()),
      canSubmit: this.isConfigured(),
      pending: this.localDatabase.getUnsyncedScores(100).length,
      leaderboardSource: this.hasRemoteServer()
        ? "remote-postgres"
        : (this.localDatabase.ownsDb ? "local-sqlite" : "marketplace-sqlite")
    };
  }

  async syncNow() {
    if (!this.hasRemoteServer()) {
      return {
        ok: false,
        reason: "remote_not_configured",
        synced: 0
      };
    }
    if (!this.getAccessToken()) {
      return {
        ok: false,
        reason: "auth_required",
        synced: 0
      };
    }

    const pending = this.localDatabase.getUnsyncedScores(100);
    if (!pending.length) {
      return {
        ok: true,
        reason: "remote-postgres",
        synced: 0
      };
    }

    const syncedIds = [];
    try {
      for (const score of pending) {
        await this.submitScore(score);
        syncedIds.push(score.id);
      }
      this.localDatabase.markScoresSynced(syncedIds);
      return {
        ok: true,
        reason: "remote-postgres",
        synced: syncedIds.length
      };
    } catch (error) {
      this.localDatabase.markScoresSynced(syncedIds);
      return {
        ok: false,
        reason: "remote_sync_failed",
        synced: syncedIds.length,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getLeaderboard(mode = "9x9", limit = 20) {
    if (this.hasRemoteServer()) {
      try {
        const result = await this.requestJson(
          `/api/v1/games/${encodeURIComponent(GAME_ID)}/leaderboard?mode=${encodeURIComponent(mode)}&limit=${encodeURIComponent(String(limit))}`
        );
        return {
          source: "remote-postgres",
          rows: Array.isArray(result.rows) ? result.rows : []
        };
      } catch {
        return this.getLocalLeaderboard(mode, limit);
      }
    }

    return this.getLocalLeaderboard(mode, limit);
  }

  async getRemoteLeaderboard(mode = "9x9", limit = 20) {
    return (await this.getLeaderboard(mode, limit)).rows;
  }

  getLocalLeaderboard(mode, limit) {
    return {
      source: this.localDatabase.ownsDb ? "local-sqlite" : "marketplace-sqlite",
      rows: this.localDatabase.getLocalLeaderboard(mode, limit)
    };
  }

  async submitScore(score) {
    return this.requestJson(`/api/v1/games/${encodeURIComponent(score.gameId || GAME_ID)}/scores`, {
      method: "POST",
      body: JSON.stringify({
        pluginId: score.pluginId || PLUGIN_ID,
        mode: score.mode,
        score: score.score,
        elapsedSeconds: score.elapsedSeconds,
        completedAt: score.completedAt
      })
    });
  }

  async requestJson(path, init = {}, retried = false) {
    const baseUrl = this.resolveServerBaseUrl();
    if (!baseUrl) {
      throw new Error("remote server is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const accessToken = this.getAccessToken();
    if (accessToken) {
      headers.set("authorization", `Bearer ${accessToken}`);
    }

    try {
      const response = await this.fetch(baseUrl + path, {
        ...init,
        headers,
        signal: controller.signal
      });

      if (response.status === 401 && !retried && (await this.refreshTokens(baseUrl))) {
        clearTimeout(timer);
        return this.requestJson(path, init, true);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
      }

      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async refreshTokens(baseUrl) {
    const session = this.getSession();
    const refreshToken = this.env.QPJOY_GAME_REFRESH_TOKEN || session?.refreshToken;
    if (!refreshToken) {
      return false;
    }

    try {
      const response = await this.fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json"
        },
        body: JSON.stringify({ refreshToken })
      });
      if (!response.ok) {
        return false;
      }
      const tokens = await response.json();
      if (this.marketplaceDb && typeof this.marketplaceDb.setSession === "function" && session?.user) {
        this.marketplaceDb.setSession({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.accessExpiresAt,
          user: session.user
        });
      }
      this.env.QPJOY_GAME_ACCESS_TOKEN = tokens.accessToken;
      this.env.QPJOY_GAME_REFRESH_TOKEN = tokens.refreshToken;
      return true;
    } catch {
      return false;
    }
  }

  resolveServerBaseUrl() {
    const candidates = [
      this.serverBaseUrl,
      this.env.QPJOY_GAME_SERVER,
      this.env.QPJOY_MARKET_SERVER,
      this.getMarketServerOverride()
    ];
    if (this.useDevDefault) {
      candidates.push(DEFAULT_DEV_SERVER);
    }

    for (const candidate of candidates) {
      const normalized = normalizeBaseUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  getMarketServerOverride() {
    if (!this.marketplaceDb || typeof this.marketplaceDb.getMeta !== "function") {
      return null;
    }
    return this.marketplaceDb.getMeta(META_KEY_MARKET_SERVER);
  }

  getAccessToken() {
    return this.env.QPJOY_GAME_ACCESS_TOKEN || this.getSession()?.accessToken || null;
  }

  getSession() {
    if (!this.marketplaceDb || typeof this.marketplaceDb.getActiveSession !== "function") {
      return null;
    }
    return this.marketplaceDb.getActiveSession();
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "0" || raw === "false") {
    return null;
  }
  if (!/^https?:\/\//i.test(raw)) {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

module.exports = {
  LocalScoreSync
};
