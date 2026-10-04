import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { USER_SESSION_TTL_SECONDS } from '../lib/session-lifetime.js';

const COOKIE = '__Host-mx_accounts';
type Entry = { id: string; seen: number };

/** Account hints only, never authentication proofs. Auth alone can read this host-only cookie. */
export function rememberedAccounts(keys: string[], issuer: string) {
  const aad = Buffer.from(`${COOKIE}:${issuer}`);
  const key = (secret: string) => createHash('sha256').update(`account-hints:${secret}`).digest();
  const read = (req: IncomingMessage): Entry[] => {
    const value = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)(?:;|$)`).exec(req.headers.cookie ?? '')?.[1];
    if (!value || value.length > 3500) return [];
    const sealed = Buffer.from(value, 'base64url');
    for (const secret of keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key(secret), sealed.subarray(0, 12));
        decipher.setAAD(aad); decipher.setAuthTag(sealed.subarray(12, 28));
        const entries: unknown = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString());
        if (!Array.isArray(entries)) return [];
        const now = Date.now() / 1000;
        return entries.filter((e): e is Entry => typeof e?.id === 'string' && e.id.length <= 128
          && Number.isFinite(e.seen) && e.seen <= now + 30 && e.seen > now - USER_SESSION_TTL_SECONDS).slice(0, 8);
      } catch { /* Key rotation and malformed cookies fail closed to an empty hint list. */ }
    }
    return [];
  };
  const write = (res: ServerResponse, entries: Entry[]) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(keys[0]), iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(entries.slice(0, 8))), cipher.final()]);
    const value = entries.length ? Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url') : '';
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [String(previous)] : []),
      `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${entries.length ? USER_SESSION_TTL_SECONDS : 0}`]);
  };
  return {
    read, write,
    reference: (id: string) => createHmac('sha256', keys[0]).update(`${issuer}:account:${id}`).digest('base64url')
  };
}
