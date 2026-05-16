/**
 * Gated tarball download.
 *
 * Flow:
 *   1. Host calls `POST /api/v1/plugins/:id/download` with a Bearer token.
 *   2. We resolve the plugin, check visibility + entitlement (admins bypass).
 *   3. We return `{ tarballUrl, expiresAt, presigned }`. Today the URL is
 *      the public npm tarball; later it'll be a short-lived OSS-presigned
 *      URL (interface ready).
 *   4. Host downloads + installs from that URL.
 *
 * Audit-logged on success and on rejected attempts.
 */
import type { FastifyInstance } from 'fastify';

import { attachUser } from '../../auth/middleware.js';
import { auditStore, entitlementsStore } from '../../data/index.js';
import { storage } from '../../data/storage.js';

export async function downloadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);

  app.post<{ Params: { id: string } }>(
    '/api/v1/plugins/:id/download',
    async (req, reply) => {
      const plugin = storage.getPlugin(req.params.id);
      if (!plugin) {
        reply.code(404);
        return { error: 'plugin not found' };
      }

      const decision = await authorizeDownload(plugin, req.currentUser, req.ip);
      if (!decision.ok) {
        await auditStore.insert({
          actorUserId: req.currentUser?.id ?? null,
          actorIp: req.ip,
          action: 'plugin.download.deny',
          targetKind: 'plugin',
          targetId: plugin.id,
          meta: { reason: decision.reason }
        });
        reply.code(decision.status);
        return { error: decision.reason };
      }

      // Pick the version the caller asked for, default to latest. Body is
      // optional; we accept `{ version: '0.1.3' }`.
      const body = (req.body ?? {}) as { version?: string };
      const wanted =
        plugin.versions.find((v) => v.version === body.version) ??
        plugin.versions.find((v) => v.version === plugin.latestVersion) ??
        plugin.versions[0];

      const tarballUrl = wanted?.tarballUrl ?? plugin.tarballUrl ?? null;
      if (!tarballUrl) {
        reply.code(500);
        return { error: 'no tarball URL on file for this plugin' };
      }

      // Presigned URL TTL: short-lived in production. For the public npm
      // URL it doesn't matter, but we set the field so clients know how
      // long to trust the value.
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'plugin.download.grant',
        targetKind: 'plugin',
        targetId: plugin.id,
        meta: { version: wanted?.version, visibility: plugin.visibility }
      });

      return {
        pluginId: plugin.id,
        version: wanted?.version ?? plugin.latestVersion,
        tarballUrl,
        expiresAt,
        // True once we wire OSS/CDN signed URLs (interface ready, provider TBD).
        presigned: false,
        manifestChecksum: wanted?.manifestChecksum ?? null,
        tarballChecksum: wanted?.tarballChecksum ?? null
      };
    }
  );
}

interface AuthzOk {
  ok: true;
}
interface AuthzNo {
  ok: false;
  status: number;
  reason: string;
}

async function authorizeDownload(
  plugin: NonNullable<ReturnType<typeof storage.getPlugin>>,
  user: { id: string; role: 'user' | 'admin' | 'banned' } | null,
  _ip: string
): Promise<AuthzOk | AuthzNo> {
  switch (plugin.visibility) {
    case 'public':
      return { ok: true };

    case 'free':
      if (!user) return { ok: false, status: 401, reason: 'login required' };
      return { ok: true };

    case 'paid':
      if (!user) return { ok: false, status: 401, reason: 'login required' };
      if (user.role === 'admin') return { ok: true };
      {
        const e = await entitlementsStore.forUserAndPlugin(user.id, plugin.id);
        if (!e) return { ok: false, status: 402, reason: 'entitlement required' };
        return { ok: true };
      }

    case 'private':
      if (user?.role === 'admin') return { ok: true };
      return { ok: false, status: 404, reason: 'plugin not found' }; // hide existence

    default:
      return { ok: true };
  }
}
