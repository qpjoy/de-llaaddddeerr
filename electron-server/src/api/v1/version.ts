import type { FastifyInstance } from 'fastify';

import { storage } from '../../data/storage.js';

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/version.json', async (_req, reply) => {
    const v = storage.getVersion();
    if (!v) {
      // Server has never been synced; return a minimal stub so clients can
      // still see the server is alive (and decide to skip the marketplace
      // pull this round).
      reply.code(200).type('application/json');
      return {
        release: 'bootstrap',
        marketSpecVersion: 1,
        supportedSpecRange: '>=1 <=1',
        migrationsHead: 0,
        manifestEtag: '',
        publishedAt: new Date(0).toISOString(),
        minClientRelease: null,
        notes: 'Server data not yet seeded — run `pnpm sync:npm` to populate.'
      };
    }
    reply
      .code(200)
      .header('cache-control', 'public, max-age=30')
      .type('application/json');
    return v;
  });
}
