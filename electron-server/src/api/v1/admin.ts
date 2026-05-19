import type { FastifyInstance } from 'fastify';

import { attachUser, requireRole } from '../../auth/middleware.js';
import { auditStore, entitlementsStore, refreshStore, usersStore } from '../../data/index.js';
import { toPublic } from '../../auth/types.js';
import { getScheduler } from '../../jobs/scheduler.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);
  const adminOnly = { preHandler: requireRole('admin') };

  app.get('/api/v1/admin/users', adminOnly, async () => {
    const all = await usersStore.list();
    return all.map(toPublic);
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id/role',
    adminOnly,
    async (req, reply) => {
      const body = (req.body ?? {}) as { role?: 'user' | 'admin' | 'banned' };
      if (!body.role) {
        reply.code(400);
        return { error: 'role required' };
      }
      const u = await usersStore.setRole(req.params.id, body.role);
      if (!u) {
        reply.code(404);
        return { error: 'user not found' };
      }
      if (body.role === 'banned') await refreshStore.revokeAllForUser(u.id);
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'admin.users.set_role',
        targetKind: 'user',
        targetId: u.id,
        meta: { role: body.role }
      });
      return toPublic(u);
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id/entitlements',
    adminOnly,
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        pluginId?: string;
        kind?: 'free' | 'paid' | 'trial';
        expiresAt?: string | null;
      };
      if (!body.pluginId || !body.kind) {
        reply.code(400);
        return { error: 'pluginId and kind required' };
      }
      const u = await usersStore.findById(req.params.id);
      if (!u) {
        reply.code(404);
        return { error: 'user not found' };
      }
      const e = await entitlementsStore.grant({
        userId: u.id,
        pluginId: body.pluginId,
        kind: body.kind,
        expiresAt: body.expiresAt ?? null
      });
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'admin.entitlements.grant',
        targetKind: 'user',
        targetId: u.id,
        meta: { pluginId: body.pluginId, kind: body.kind, expiresAt: body.expiresAt ?? null }
      });
      return e;
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/admin/users/:id/entitlements',
    adminOnly,
    async (req, reply) => {
      const u = await usersStore.findById(req.params.id);
      if (!u) {
        reply.code(404);
        return { error: 'user not found' };
      }
      return entitlementsStore.forUser(u.id);
    }
  );

  app.get('/api/v1/admin/audit', adminOnly, async (req) => {
    const q = req.query as {
      limit?: string;
      before?: string;
      actorUserId?: string;
      action?: string;
      targetId?: string;
    };
    return auditStore.query({
      limit: q.limit ? Math.min(500, Number(q.limit)) : 100,
      before: q.before ? Number(q.before) : undefined,
      actorUserId: q.actorUserId,
      action: q.action,
      targetId: q.targetId
    });
  });

  // Scheduler status + manual trigger. Admin-only because a sync downloads
  // every published @qpjoy/electron-* tarball — heavyweight enough to keep
  // gated. The interval auto-runs anyway; this is the "just refresh now" hatch.
  app.get('/api/v1/admin/sync', adminOnly, async (_req, reply) => {
    const s = getScheduler();
    if (!s) {
      reply.code(503);
      return { error: 'scheduler not initialised' };
    }
    return s.status();
  });

  app.post('/api/v1/admin/sync', adminOnly, async (req, reply) => {
    const s = getScheduler();
    if (!s) {
      reply.code(503);
      return { error: 'scheduler not initialised' };
    }
    try {
      const report = await s.runNow(`admin:${req.currentUser?.id ?? 'unknown'}`);
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'admin.sync.manual',
        targetKind: 'marketplace',
        targetId: report.release,
        meta: {
          acceptedPlugins: report.acceptedPlugins,
          rejectedCount: report.rejected.length
        }
      });
      return report;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/v1/admin/sync/package', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = body.name?.trim();
    if (!name) {
      reply.code(400);
      return { error: 'name required' };
    }
    const s = getScheduler();
    if (!s) {
      reply.code(503);
      return { error: 'scheduler not initialised' };
    }
    try {
      const report = await s.runNow(`admin-package:${req.currentUser?.id ?? 'unknown'}`, {
        packages: [name]
      });
      await auditStore.insert({
        actorUserId: req.currentUser?.id ?? null,
        actorIp: req.ip,
        action: 'admin.sync.package',
        targetKind: 'npm_package',
        targetId: name,
        meta: {
          release: report.release,
          acceptedPlugins: report.acceptedPlugins,
          rejected: report.rejected
        }
      });
      return report;
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
