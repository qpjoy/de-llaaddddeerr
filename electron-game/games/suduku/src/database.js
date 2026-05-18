"use strict";

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
  buildLocalPlayerName,
  normalizeDisplayName,
  readLaunchContext
} = require("./player");

const GAME_ID = "suduku";
const PLUGIN_ID = "qpjoy.electron-game-suduku";
const SCORE_LIMITS = {
  "7x7": { maxScore: 700 },
  "9x9": { maxScore: 1200 }
};

function loadSqlite() {
  try {
    return require("better-sqlite3");
  } catch (error) {
    error.message = `better-sqlite3 is required for local score storage: ${error.message}`;
    throw error;
  }
}

class SudukuDatabase {
  constructor(input, env = process.env) {
    const opts = typeof input === "string" ? { userDataDir: input } : (input || {});
    const marketplaceDb = opts.marketplaceDb;
    const sharedDb = marketplaceDb && typeof marketplaceDb.raw === "function"
      ? marketplaceDb.raw()
      : null;

    this.env = env;
    this.marketplaceDb = marketplaceDb || null;
    this.pluginId = opts.pluginId || PLUGIN_ID;
    this.marketplaceEntryId = opts.marketplaceEntryId || PLUGIN_ID;
    this.ownsDb = !sharedDb;

    if (sharedDb) {
      this.db = sharedDb;
    } else {
      const Database = loadSqlite();
      const userDataDir = opts.userDataDir || opts.userDataPath;
      if (!userDataDir) {
        throw new Error("SudukuDatabase requires userDataDir when marketplaceDb is unavailable");
      }
      this.db = new Database(path.join(userDataDir, "suduku.sqlite"));
      this.db.pragma("journal_mode = WAL");
    }

    this.migrate();
  }

  migrate() {
    this.db.exec(`
      create table if not exists electron_game_players (
        id text primary key,
        display_name text not null,
        source text not null,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );

      create table if not exists electron_game_scores (
        id text primary key,
        game_id text not null,
        plugin_id text not null,
        marketplace_entry_id text,
        player_id text not null,
        player_name text not null,
        mode text not null,
        elapsed_seconds integer not null,
        score integer not null,
        completed_at text not null,
        synced_at text,
        metadata_json text,
        created_at text not null default (datetime('now')),
        foreign key (plugin_id) references installed_plugins(id) on delete cascade,
        foreign key (marketplace_entry_id) references marketplace_entries(id) on delete set null,
        foreign key (player_id) references electron_game_players(id) on delete cascade
      );

      create index if not exists electron_game_scores_game_mode_idx
        on electron_game_scores (game_id, mode);
      create index if not exists electron_game_scores_plugin_idx
        on electron_game_scores (plugin_id);
      create index if not exists electron_game_scores_player_idx
        on electron_game_scores (player_id);
      create index if not exists electron_game_scores_unsynced_idx
        on electron_game_scores (synced_at)
        where synced_at is null;
    `);
    this.migrateLegacyTables();
  }

  migrateLegacyTables() {
    const hasLegacyPlayers = this.db
      .prepare("select name from sqlite_master where type = 'table' and name = 'players'")
      .get();
    const hasLegacyScores = this.db
      .prepare("select name from sqlite_master where type = 'table' and name = 'scores'")
      .get();

    if (hasLegacyPlayers) {
      this.db.exec(`
        insert or ignore into electron_game_players (id, display_name, source, created_at, updated_at)
        select id, display_name, source, created_at, updated_at from players;
      `);
    }

    if (hasLegacyScores) {
      this.db
        .prepare(`
          insert or ignore into electron_game_scores (
            id,
            game_id,
            plugin_id,
            marketplace_entry_id,
            player_id,
            player_name,
            mode,
            elapsed_seconds,
            score,
            completed_at,
            synced_at,
            metadata_json,
            created_at
          )
          select
            id,
            game_id,
            @pluginId,
            @marketplaceEntryId,
            player_id,
            player_name,
            mode,
            elapsed_seconds,
            score,
            completed_at,
            synced_at,
            null,
            completed_at
          from scores
        `)
        .run({
          pluginId: this.pluginId,
          marketplaceEntryId: this.marketplaceEntryId
        });
    }
  }

  getPlayer() {
    const marketPlayer = this.getMarketPlayer();
    if (marketPlayer) {
      return this.upsertPlayer(marketPlayer);
    }

    const existing = this.db
      .prepare(`
        select id, display_name as displayName, source
        from electron_game_players
        order by updated_at desc
        limit 1
      `)
      .get();

    if (existing) {
      return existing;
    }

    return null;
  }

  getSuggestedPlayerName() {
    const hostname = normalizeDisplayName(os.hostname().split(".")[0]);
    return buildLocalPlayerName(hostname || "Player");
  }

  setLocalPlayer(baseName) {
    const displayName = buildLocalPlayerName(baseName);
    return this.upsertPlayer({
      id: `local:${displayName.toLowerCase()}`,
      displayName,
      source: "local_prompt"
    });
  }

  upsertPlayer(player) {
    const now = new Date().toISOString();
    const record = {
      id: String(player.id),
      displayName: normalizeDisplayName(player.displayName) || "Player",
      source: player.source || "market"
    };

    this.db
      .prepare(`
        insert into electron_game_players (id, display_name, source, created_at, updated_at)
        values (@id, @displayName, @source, @now, @now)
        on conflict(id) do update set
          display_name = excluded.display_name,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run({ ...record, now });

    return record;
  }

  getMarketPlayer() {
    const context = readLaunchContext(this.env);
    const contextUser = context.user;
    const user = contextUser && (contextUser.id || contextUser.displayName)
      ? contextUser
      : this.getMarketplaceSessionUser();

    if (!user || (!user.id && !user.displayName)) {
      return null;
    }

    return {
      id: `market:${user.id || user.displayName}`,
      displayName: user.displayName || user.id,
      source: user.source || "market"
    };
  }

  getMarketplaceSessionUser() {
    if (!this.marketplaceDb || typeof this.marketplaceDb.getActiveSession !== "function") {
      return null;
    }

    const session = this.marketplaceDb.getActiveSession();
    const user = session && session.user && typeof session.user === "object"
      ? session.user
      : null;
    if (!user) {
      return null;
    }

    return {
      id: user.id || user.username || user.email || user.displayName,
      displayName: user.displayName || user.username || user.email || user.id,
      source: "market"
    };
  }

  saveScore(scoreInput) {
    const player = this.getPlayer();
    if (!player) {
      throw new Error("Cannot save a score before player identity is set");
    }
    const score = normalizeScoreInput(scoreInput);

    const row = {
      id: randomUUID(),
      gameId: GAME_ID,
      pluginId: this.pluginId,
      marketplaceEntryId: this.marketplaceEntryId,
      playerId: player.id,
      playerName: player.displayName,
      mode: score.mode,
      elapsedSeconds: score.elapsedSeconds,
      score: score.score,
      completedAt: new Date().toISOString(),
      metadataJson: scoreInput.metadata ? JSON.stringify(scoreInput.metadata) : null
    };

    this.db
      .prepare(`
        insert into electron_game_scores (
          id,
          game_id,
          plugin_id,
          marketplace_entry_id,
          player_id,
          player_name,
          mode,
          elapsed_seconds,
          score,
          completed_at,
          synced_at,
          metadata_json
        ) values (
          @id,
          @gameId,
          @pluginId,
          @marketplaceEntryId,
          @playerId,
          @playerName,
          @mode,
          @elapsedSeconds,
          @score,
          @completedAt,
          null,
          @metadataJson
        )
      `)
      .run(row);

    return row;
  }

  getUnsyncedScores(limit = 100) {
    return this.db
      .prepare(`
        select
          id,
          game_id as gameId,
          plugin_id as pluginId,
          player_id as playerId,
          player_name as playerName,
          mode,
          elapsed_seconds as elapsedSeconds,
          score,
          completed_at as completedAt
        from electron_game_scores
        where plugin_id = ? and game_id = ? and synced_at is null
        order by completed_at asc
        limit ?
      `)
      .all(this.pluginId, GAME_ID, limit);
  }

  markScoresSynced(ids) {
    if (!ids.length) {
      return;
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      update electron_game_scores
      set synced_at = ?
      where id = ? and plugin_id = ?
    `);
    const transaction = this.db.transaction((scoreIds) => {
      for (const id of scoreIds) {
        update.run(now, id, this.pluginId);
      }
    });
    transaction(ids);
  }

  getLocalLeaderboard(mode = "9x9", limit = 20) {
    return this.db
      .prepare(`
        with scoped as (
          select
            player_id,
            player_name,
            elapsed_seconds,
            score,
            completed_at
          from electron_game_scores
          where plugin_id = ? and game_id = ? and mode = ?
        ),
        ranked as (
          select
            player_id as playerId,
            player_name as playerName,
            score as bestScore,
            elapsed_seconds as bestTime,
            completed_at as bestCompletedAt,
            count(*) over (partition by player_id, player_name) as rounds,
            sum(score) over (partition by player_id, player_name) as totalScore,
            max(completed_at) over (partition by player_id, player_name) as lastCompletedAt,
            row_number() over (
              partition by player_id, player_name
              order by score desc, elapsed_seconds asc, completed_at asc
            ) as scoreRank
          from scoped
        )
        select
          playerId,
          playerName,
          rounds,
          totalScore,
          bestScore,
          bestTime,
          bestCompletedAt,
          lastCompletedAt
        from ranked
        where scoreRank = 1
        order by bestScore desc, bestTime asc, bestCompletedAt asc
        limit ?
      `)
      .all(this.pluginId, GAME_ID, mode, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));
  }

  close() {
    if (this.ownsDb && this.db && typeof this.db.close === "function") {
      this.db.close();
    }
  }
}

function normalizeScoreInput(scoreInput) {
  const input = scoreInput || {};
  const mode = String(input.mode || "");
  const limits = SCORE_LIMITS[mode];
  if (!limits) {
    throw new Error(`Unsupported Suduku mode: ${mode}`);
  }

  const elapsedSeconds = Math.max(0, Math.floor(Number(input.elapsedSeconds)));
  const score = Math.max(0, Math.min(limits.maxScore, Math.floor(Number(input.score))));
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(score)) {
    throw new Error("Score and elapsed time must be finite numbers");
  }

  return {
    mode,
    elapsedSeconds,
    score
  };
}

module.exports = {
  GAME_ID,
  PLUGIN_ID,
  SudukuDatabase
};
