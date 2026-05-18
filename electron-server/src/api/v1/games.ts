import type { FastifyInstance } from 'fastify';

import { attachUser, requireAuth } from '../../auth/middleware.js';
import { auditStore, gameScoresStore } from '../../data/index.js';
import type { GameHighScoreRow } from '../../data/storage-types.js';

const SCORE_LIMITS: Record<string, Record<string, number>> = {
  suduku: {
    '7x7': 700,
    '9x9': 1200
  }
};

export async function gameRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);

  app.post<{ Params: { gameId: string } }>(
    '/api/v1/games/:gameId/scores',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        pluginId?: string;
        mode?: string;
        score?: number;
        elapsedSeconds?: number;
        completedAt?: string;
        metadata?: Record<string, unknown> | null;
      };
      const gameId = normalizeId(req.params.gameId);
      const mode = String(body.mode ?? '');
      const maxScore = SCORE_LIMITS[gameId]?.[mode];
      if (!gameId || !maxScore) {
        reply.code(400);
        return { error: 'unsupported game or mode' };
      }
      if (!body.pluginId || !isSafePluginId(body.pluginId)) {
        reply.code(400);
        return { error: 'valid pluginId required' };
      }

      const score = toNonNegativeInt(body.score);
      const elapsedSeconds = toNonNegativeInt(body.elapsedSeconds);
      if (score === null || elapsedSeconds === null || score > maxScore) {
        reply.code(400);
        return { error: 'valid score and elapsedSeconds required' };
      }

      const completedAt = parseCompletedAt(body.completedAt);
      if (!completedAt) {
        reply.code(400);
        return { error: 'completedAt must be an ISO timestamp' };
      }

      const user = req.currentUser!;
      const row = await gameScoresStore.submit({
        userId: user.id,
        playerName: user.displayName || user.username || user.email || user.phone || user.id,
        gameId,
        pluginId: body.pluginId,
        mode,
        score,
        elapsedSeconds,
        completedAt,
        metadata: body.metadata ?? null
      });

      await auditStore.insert({
        actorUserId: user.id,
        actorIp: req.ip,
        action: 'game.score.submit',
        targetKind: 'game',
        targetId: gameId,
        meta: {
          pluginId: body.pluginId,
          mode,
          score,
          elapsedSeconds,
          bestScore: row.bestScore
        }
      });

      return { ok: true, row: toLeaderboardRow(row) };
    }
  );

  app.get<{ Params: { gameId: string } }>(
    '/api/v1/games/:gameId/leaderboard',
    async (req, reply) => {
      const query = req.query as { mode?: string; limit?: string };
      const gameId = normalizeId(req.params.gameId);
      const mode = String(query.mode ?? '9x9');
      if (!gameId || !SCORE_LIMITS[gameId]?.[mode]) {
        reply.code(400);
        return { error: 'unsupported game or mode' };
      }
      const limit = Math.min(Math.max(1, Number(query.limit ?? 20) || 20), 100);
      const rows = await gameScoresStore.leaderboard({ gameId, mode, limit });
      return {
        source: 'remote-postgres',
        gameId,
        mode,
        rows: rows.map(toLeaderboardRow)
      };
    }
  );
}

function normalizeId(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : '';
}

function isSafePluginId(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function toNonNegativeInt(value: unknown): number | null {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return null;
  }
  return Math.floor(numberValue);
}

function parseCompletedAt(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return new Date().toISOString();
  }
  const time = new Date(String(value)).getTime();
  if (!Number.isFinite(time)) {
    return null;
  }
  return new Date(time).toISOString();
}

function toLeaderboardRow(row: GameHighScoreRow & { rank?: number }) {
  return {
    rank: row.rank,
    userId: row.userId,
    playerName: row.playerName,
    gameId: row.gameId,
    pluginId: row.pluginId,
    mode: row.mode,
    bestScore: row.bestScore,
    bestTime: row.bestElapsedSeconds,
    rounds: row.rounds,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt
  };
}

