import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const NAME = '__Host-mx_auth_return';
const TTL = 1800;

/** Navigation hint only. It never resumes an interaction or proves an identity. */
export function interactionRecovery(keys: string[], issuer: string) {
  const sign = (value: string, key: string) => createHmac('sha256', key).update(`auth-return:${issuer}:${value}`).digest('base64url');
  return {
    write(res: ServerResponse, uid: string, clientId: string) {
      const value = Buffer.from(JSON.stringify({ uid, clientId, until: Date.now() + TTL * 1000 })).toString('base64url');
      const previous = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [String(previous)] : []),
        `${NAME}=${value}.${sign(value, keys[0])}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL}`]);
    },
    read(req: IncomingMessage, uid: string): string | undefined {
      const cookie = new RegExp(`(?:^|;\\s*)${NAME}=([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)(?:;|$)`).exec(req.headers.cookie ?? '');
      if (!cookie || cookie[1].length > 2048) return;
      const supplied = Buffer.from(cookie[2]);
      if (!keys.some(key => { const expected = Buffer.from(sign(cookie[1], key)); return supplied.length === expected.length && timingSafeEqual(supplied, expected); })) return;
      try {
        const value = JSON.parse(Buffer.from(cookie[1], 'base64url').toString());
        if (value.uid === uid && typeof value.clientId === 'string' && Number.isFinite(value.until)
          && value.until > Date.now() && value.until <= Date.now() + TTL * 1000) return value.clientId;
      } catch { /* Invalid hints must never choose a destination. */ }
    }
  };
}
