import type { FastifyInstance } from 'fastify';

import {
  AuthError,
  issueDevCode,
  login,
  logout,
  refresh,
  register
} from '../../auth/service.js';
import { attachUser, requireAuth } from '../../auth/middleware.js';
import { toPublic } from '../../auth/types.js';
import { usersStore } from '../../data/index.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', attachUser);

  app.post('/api/v1/auth/register', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    if (!body.password) {
      reply.code(400);
      return { error: 'password required' };
    }
    try {
      const out = await register(
        {
          username: body.username,
          email: body.email,
          phone: body.phone,
          password: body.password,
          displayName: body.displayName,
          verificationCode: body.verificationCode
        },
        { ip: req.ip }
      );
      return out;
    } catch (err) {
      return rejectWith(reply, err);
    }
  });

  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { identifier?: string; password?: string };
    if (!body.identifier || !body.password) {
      reply.code(400);
      return { error: 'identifier and password required' };
    }
    try {
      const out = await login(body.identifier, body.password, { ip: req.ip });
      return out;
    } catch (err) {
      return rejectWith(reply, err);
    }
  });

  app.post('/api/v1/auth/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) {
      reply.code(400);
      return { error: 'refreshToken required' };
    }
    try {
      return await refresh(body.refreshToken, { ip: req.ip });
    } catch (err) {
      return rejectWith(reply, err);
    }
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    if (body.refreshToken) await logout(body.refreshToken, { ip: req.ip });
    reply.code(200);
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (req) => {
    return req.currentUser;
  });

  app.post('/api/v1/auth/code', async (req, reply) => {
    const body = (req.body ?? {}) as {
      channel?: 'email' | 'sms';
      destination?: string;
      purpose?: 'register' | 'login' | 'reset';
    };
    if (!body.channel || !body.destination || !body.purpose) {
      reply.code(400);
      return { error: 'channel, destination, purpose required' };
    }
    await issueDevCode({
      channel: body.channel,
      destination: body.destination,
      purpose: body.purpose
    });
    return {
      delivered: process.env.NODE_ENV === 'production' ? 'pending' : 'logged-to-server-console',
      hint:
        process.env.NODE_ENV === 'production'
          ? undefined
          : 'See server stdout for the code (real provider integration is deferred).'
    };
  });

  app.delete('/api/v1/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const u = req.currentUser!;
    await usersStore.setRole(u.id, 'banned');
    reply.code(200);
    return { ok: true };
  });

  app.get('/api/v1/auth/whoami', async (req) => {
    if (!req.currentUser) return null;
    const fresh = await usersStore.findById(req.currentUser.id);
    return fresh ? toPublic(fresh) : null;
  });
}

function rejectWith(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof AuthError) {
    reply.code(err.status);
    return { error: err.message };
  }
  reply.code(500);
  return { error: err instanceof Error ? err.message : String(err) };
}
