import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import jwt, { type SignOptions } from 'jsonwebtoken';

import type { Role } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = resolve(here, '..', '..', 'data', '.jwt-secret');

const ACCESS_TTL_S = envSeconds('JWT_ACCESS_TTL_SECONDS', 7 * 24 * 60 * 60);
const REFRESH_TTL_S = envSeconds('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60);

let cachedSecret: string | null = null;

function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function loadSecret(): string {
  if (cachedSecret) return cachedSecret;
  if (process.env.JWT_SECRET) {
    cachedSecret = process.env.JWT_SECRET;
    return cachedSecret;
  }
  // Dev: persist a generated secret so restarts don't invalidate sessions.
  // For prod, always set JWT_SECRET in the environment.
  if (existsSync(SECRET_FILE)) {
    cachedSecret = readFileSync(SECRET_FILE, 'utf8').trim();
    return cachedSecret;
  }
  mkdirSync(dirname(SECRET_FILE), { recursive: true });
  const next = randomBytes(48).toString('hex');
  writeFileSync(SECRET_FILE, next, { mode: 0o600 });
  // eslint-disable-next-line no-console
  console.warn(
    `[auth] generated dev JWT secret at ${SECRET_FILE}. ` +
      'Set JWT_SECRET in production.'
  );
  cachedSecret = next;
  return cachedSecret;
}

export interface AccessClaims {
  sub: string;       // user id
  role: Role;
  jti: string;       // refresh token id this access was minted from (for revocation tracing)
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  /** Opaque random secret (NOT a JWT). Stored hashed in the refresh_tokens table. */
  refreshToken: string;
  refreshTokenId: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export function signAccessToken(userId: string, role: Role, refreshTokenId: string): {
  token: string;
  expiresAt: Date;
} {
  const secret = loadSecret();
  const opts: SignOptions = {
    algorithm: 'HS256',
    expiresIn: ACCESS_TTL_S,
    issuer: 'qpjoy-market',
    // Note: don't pass `jwtid` here; we set `jti` in the payload below so
    // jsonwebtoken doesn't refuse with "payload already has a jti".
    subject: userId
  };
  const token = jwt.sign({ role, jti: refreshTokenId }, secret, opts);
  return { token, expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000) };
}

export function verifyAccessToken(token: string): AccessClaims {
  const secret = loadSecret();
  const decoded = jwt.verify(token, secret, { issuer: 'qpjoy-market' }) as AccessClaims;
  return decoded;
}

export function mintRefreshToken(): { id: string; token: string; expiresAt: Date } {
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  return { id, token, expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000) };
}

export const TTLs = {
  accessSeconds: ACCESS_TTL_S,
  refreshSeconds: REFRESH_TTL_S
} as const;
