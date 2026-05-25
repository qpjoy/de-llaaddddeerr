/**
 * QPJoy marketplace server.
 *
 * Phase 5/6:
 *   - JSON-file or Postgres backend (chosen by `DATABASE_URL`)
 *   - Auth (JWT + bcrypt), audit log writes
 *   - Server admin SPA served at `/admin/*`
 *   - Paid plugin gated downloads under `/api/v1/plugins/:id/download`
 */
import Fastify from 'fastify';

import { versionRoutes } from './api/v1/version.js';
import { marketplaceRoutes } from './api/v1/marketplace.js';
import { pluginRoutes } from './api/v1/plugins.js';
import { migrationRoutes } from './api/v1/migrations.js';
import { authRoutes } from './api/v1/auth.js';
import { adminRoutes } from './api/v1/admin.js';
import { downloadRoutes } from './api/v1/download.js';
import { gameRoutes } from './api/v1/games.js';
import { hdoRoutes } from './api/v1/hdo.js';
import { tunnelRoutes } from './api/v1/tunnel.js';
import { spaRoutes } from './api/spa.js';
import { initStorage } from './data/index.js';
import { initScheduler } from './jobs/scheduler.js';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
  }
});

// CORS for the desktop host. We don't ship credentials; opening this up
// site-wide is fine until we add cookie auth (we use bearer tokens).
app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'content-type, authorization, if-none-match');
  reply.header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  return payload;
});

app.options('*', async (_req, reply) => {
  reply.code(204).send();
});

app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

// Storage backend (JSON or Postgres) must be ready before routes register;
// route handlers go through the proxies in `data/index.ts`.
await initStorage();

await app.register(versionRoutes);
await app.register(marketplaceRoutes);
await app.register(pluginRoutes);
await app.register(migrationRoutes);
await app.register(authRoutes);
await app.register(adminRoutes);
await app.register(gameRoutes);
await app.register(hdoRoutes);
await app.register(tunnelRoutes);
await app.register(downloadRoutes);
await app.register(spaRoutes);

// In-container npm sync scheduler (no system cron). Configure via:
//   SYNC_ENABLED=0|1   SYNC_ON_BOOT=0|1   SYNC_INTERVAL_MS=...   SYNC_JITTER_MS=...
const scheduler = initScheduler();
scheduler.start();

// Graceful stop so the timer is cleared in development and the audit-log
// commit isn't aborted mid-flight.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    scheduler.stop();
    app.close().finally(() => process.exit(0));
  });
}

app
  .listen({ port, host })
  .then((addr) => app.log.info(`electron-server listening at ${addr}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
