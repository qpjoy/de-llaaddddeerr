import type { FastifyReply, FastifyRequest } from 'fastify';

import { usersStore } from '../data/index.js';
import { verifyAccessToken } from './jwt.js';
import { toPublic, type PublicUser, type Role } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `attachUser`; null when unauthenticated. */
    currentUser: PublicUser | null;
  }
}

/**
 * Soft auth — parses the `Authorization: Bearer <jwt>` header if present and
 * attaches `req.currentUser`. Does NOT 401 on missing or invalid tokens;
 * routes decide whether they require auth via `requireAuth`/`requireRole`.
 */
export async function attachUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  req.currentUser = null;
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return;
  if (!header.startsWith('Bearer ')) return;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return;
  try {
    const claims = verifyAccessToken(token);
    const user = await usersStore.findById(claims.sub);
    if (user && user.role !== 'banned') {
      req.currentUser = toPublic(user);
    }
  } catch {
    // Don't leak the reason; routes that need auth will 401 themselves.
  }
}

/** Hard guard — throws 401 if no user attached. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.currentUser) {
    reply.code(401);
    throw new Error('authentication required');
  }
}

/** Hard guard — throws 403 unless the user has one of the listed roles. */
export function requireRole(...allowed: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.currentUser) {
      reply.code(401);
      throw new Error('authentication required');
    }
    if (!allowed.includes(req.currentUser.role)) {
      reply.code(403);
      throw new Error(`role ${req.currentUser.role} not allowed`);
    }
  };
}
