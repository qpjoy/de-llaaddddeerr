"use strict";

const { readFileSync } = require("node:fs");
const path = require("node:path");
const { GAME_ID } = require("./database");

function getPostgresUrl(env = process.env) {
  return env.QPJOY_GAME_POSTGRES_URL || env.DATABASE_URL || "";
}

function loadPg() {
  try {
    return require("pg");
  } catch {
    return null;
  }
}

class PostgresScoreSync {
  constructor(localDatabase, env = process.env) {
    this.localDatabase = localDatabase;
    this.env = env;
    this.schemaSql = readFileSync(path.join(__dirname, "..", "sql", "postgres.schema.sql"), "utf8");
  }

  isConfigured() {
    return Boolean(getPostgresUrl(this.env));
  }

  async syncNow() {
    const url = getPostgresUrl(this.env);
    if (!url) {
      return {
        ok: false,
        reason: "postgres_not_configured",
        synced: 0
      };
    }

    const pg = loadPg();
    if (!pg) {
      return {
        ok: false,
        reason: "pg_dependency_missing",
        synced: 0
      };
    }

    const client = new pg.Client({ connectionString: url });
    const unsynced = this.localDatabase.getUnsyncedScores();

    try {
      await client.connect();
      await client.query(this.schemaSql);

      for (const score of unsynced) {
        await client.query(
          `
            insert into electron_game_players (id, display_name, source, updated_at)
            values ($1, $2, $3, now())
            on conflict(id) do update set
              display_name = excluded.display_name,
              updated_at = excluded.updated_at
          `,
          [score.playerId, score.playerName, "market_or_local"]
        );

        await client.query(
          `
            insert into electron_game_scores (
              id,
              game_id,
              player_id,
              player_name,
              mode,
              elapsed_seconds,
              score,
              completed_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            on conflict(id) do nothing
          `,
          [
            score.id,
            score.gameId,
            score.playerId,
            score.playerName,
            score.mode,
            score.elapsedSeconds,
            score.score,
            score.completedAt
          ]
        );
      }

      this.localDatabase.markScoresSynced(unsynced.map((score) => score.id));

      return {
        ok: true,
        synced: unsynced.length
      };
    } catch (error) {
      return {
        ok: false,
        reason: "postgres_unavailable",
        message: error.message,
        synced: 0
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  async getRemoteLeaderboard(mode = "9x9", limit = 20) {
    const url = getPostgresUrl(this.env);
    const pg = loadPg();

    if (!url || !pg) {
      return [];
    }

    const client = new pg.Client({ connectionString: url });

    try {
      await client.connect();
      await client.query(this.schemaSql);
      const result = await client.query(
        `
          select
            player_id as "playerId",
            player_name as "playerName",
            count(*)::int as rounds,
            sum(score)::int as "totalScore",
            min(elapsed_seconds)::int as "bestTime",
            max(completed_at) as "lastCompletedAt",
            rank() over (
              order by sum(score) desc, min(elapsed_seconds) asc, max(completed_at) asc
            )::int as rank
          from electron_game_scores
          where game_id = $1 and mode = $2
          group by player_id, player_name
          order by rank asc
          limit $3
        `,
        [GAME_ID, mode, limit]
      );

      return result.rows;
    } catch {
      return [];
    } finally {
      await client.end().catch(() => {});
    }
  }
}

module.exports = {
  PostgresScoreSync,
  getPostgresUrl
};
