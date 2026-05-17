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

function loadSqlite() {
  try {
    return require("better-sqlite3");
  } catch (error) {
    error.message = `better-sqlite3 is required for local score storage: ${error.message}`;
    throw error;
  }
}

class SudukuDatabase {
  constructor(userDataPath, env = process.env) {
    const Database = loadSqlite();
    this.db = new Database(path.join(userDataPath, "suduku.sqlite"));
    this.env = env;
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      create table if not exists players (
        id text primary key,
        display_name text not null,
        source text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists scores (
        id text primary key,
        game_id text not null,
        player_id text not null,
        player_name text not null,
        mode text not null,
        elapsed_seconds integer not null,
        score integer not null,
        completed_at text not null,
        synced_at text
      );

      create index if not exists scores_game_mode_idx on scores (game_id, mode);
      create index if not exists scores_player_idx on scores (player_id);
      create index if not exists scores_unsynced_idx on scores (synced_at) where synced_at is null;
    `);
  }

  getPlayer() {
    const marketPlayer = this.getMarketPlayer();
    if (marketPlayer) {
      return this.upsertPlayer(marketPlayer);
    }

    const existing = this.db
      .prepare("select id, display_name as displayName, source from players order by updated_at desc limit 1")
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
        insert into players (id, display_name, source, created_at, updated_at)
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
    const user = context.user;

    if (!user || (!user.id && !user.displayName)) {
      return null;
    }

    return {
      id: `market:${user.id || user.displayName}`,
      displayName: user.displayName || user.id,
      source: user.source || "market"
    };
  }

  saveScore(scoreInput) {
    const player = this.getPlayer();
    if (!player) {
      throw new Error("Cannot save a score before player identity is set");
    }

    const row = {
      id: randomUUID(),
      gameId: GAME_ID,
      playerId: player.id,
      playerName: player.displayName,
      mode: scoreInput.mode,
      elapsedSeconds: Number(scoreInput.elapsedSeconds),
      score: Number(scoreInput.score),
      completedAt: new Date().toISOString()
    };

    this.db
      .prepare(`
        insert into scores (
          id,
          game_id,
          player_id,
          player_name,
          mode,
          elapsed_seconds,
          score,
          completed_at,
          synced_at
        ) values (
          @id,
          @gameId,
          @playerId,
          @playerName,
          @mode,
          @elapsedSeconds,
          @score,
          @completedAt,
          null
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
          player_id as playerId,
          player_name as playerName,
          mode,
          elapsed_seconds as elapsedSeconds,
          score,
          completed_at as completedAt
        from scores
        where synced_at is null
        order by completed_at asc
        limit ?
      `)
      .all(limit);
  }

  markScoresSynced(ids) {
    if (!ids.length) {
      return;
    }

    const now = new Date().toISOString();
    const update = this.db.prepare("update scores set synced_at = ? where id = ?");
    const transaction = this.db.transaction((scoreIds) => {
      for (const id of scoreIds) {
        update.run(now, id);
      }
    });
    transaction(ids);
  }

  getLocalLeaderboard(mode = "9x9", limit = 20) {
    return this.db
      .prepare(`
        select
          player_id as playerId,
          player_name as playerName,
          count(*) as rounds,
          sum(score) as totalScore,
          min(elapsed_seconds) as bestTime,
          max(completed_at) as lastCompletedAt
        from scores
        where game_id = ? and mode = ?
        group by player_id, player_name
        order by totalScore desc, bestTime asc, lastCompletedAt asc
        limit ?
      `)
      .all(GAME_ID, mode, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));
  }
}

module.exports = {
  GAME_ID,
  SudukuDatabase
};
