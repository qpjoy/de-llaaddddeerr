import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Minimal complexity guard. We don't enforce special chars to keep the bar
 * low for early users; the real defense is hash + rate limits.
 */
export function validatePassword(plain: string): { ok: boolean; reason?: string } {
  if (typeof plain !== 'string') return { ok: false, reason: 'password required' };
  if (plain.length < 8) return { ok: false, reason: 'password too short (min 8)' };
  if (plain.length > 200) return { ok: false, reason: 'password too long (max 200)' };
  return { ok: true };
}
