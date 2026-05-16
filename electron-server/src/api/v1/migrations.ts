import type { FastifyInstance } from 'fastify';

import { storage } from '../../data/storage.js';

export async function migrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/migrations', async (_req, reply) => {
    reply
      .code(200)
      .header('cache-control', 'public, max-age=60')
      .type('application/json');
    return storage.listMigrations().map((m) => ({
      version: m.version,
      name: m.name,
      checksum: m.checksum
    }));
  });

  app.get<{ Params: { version: string } }>(
    '/api/v1/migrations/:version',
    async (req, reply) => {
      const v = Number(req.params.version);
      if (!Number.isFinite(v) || v <= 0) {
        reply.code(400);
        return { error: 'invalid version' };
      }
      const m = storage.getMigration(v);
      if (!m) {
        reply.code(404);
        return { error: 'migration not found', version: v };
      }
      reply
        .code(200)
        .header('cache-control', 'public, max-age=300')
        .type('application/json');
      return m;
    }
  );
}
