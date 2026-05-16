import type { FastifyInstance } from 'fastify';

import { storage } from '../../data/storage.js';

export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/v1/plugins/:id', async (req, reply) => {
    const p = storage.getPlugin(req.params.id);
    if (!p) {
      reply.code(404);
      return { error: 'plugin not found', id: req.params.id };
    }
    reply
      .code(200)
      .header('cache-control', 'public, max-age=60')
      .type('application/json');
    return p;
  });
}
