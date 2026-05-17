/**
 * Serve the admin SPA from the server.
 *
 * The Vue bundle is the same one the desktop host ships. We point at
 * `SPA_DIST` (default `data/spa-dist`) — the user populates that dir via
 *
 *   ln -s ../../electron-market/packages/admin-ui/dist data/spa-dist
 *
 * or by copying after the admin-ui builds. Mounted under `/admin/`:
 *   - SPA fallback returns index.html for any non-asset path so vue-router
 *     hash mode keeps working from any deep link.
 *   - Static assets are cached briefly so reloads pick up redeploys.
 *
 * Auth happens client-side: the bundle calls the existing `/api/v1/auth/*`
 * endpoints with a Bearer token stored in localStorage (see the SPA's
 * `useAuth` composable in server mode).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import staticPlugin from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = resolve(here, '..', '..', 'data', 'spa-dist');

export async function spaRoutes(app: FastifyInstance): Promise<void> {
  const root = process.env.SPA_DIST
    ? resolve(process.env.SPA_DIST)
    : DEFAULT_DIST;
  const indexPath = resolve(root, 'index.html');

  if (!existsSync(root) || !existsSync(indexPath)) {
    app.log.warn(
      { spaDist: root, indexPath },
      '[spa] SPA dist is missing index.html — skipping /admin/* mount. ' +
        'Build admin-ui and copy its dist here to enable.'
    );
    return;
  }

  await app.register(staticPlugin, {
    root,
    prefix: '/admin/',
    decorateReply: false,
    wildcard: false,
    setHeaders(res, _path, stat) {
      if (stat.isFile()) res.setHeader('cache-control', 'public, max-age=60');
    }
  });

  // Cache the index for SPA fallback.
  const indexHtml = readFileSync(indexPath, 'utf8');

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/admin/')) {
      reply.code(200).type('text/html').send(indexHtml);
      return;
    }
    reply.code(404).send({ error: 'not found', path: req.url });
  });
}
