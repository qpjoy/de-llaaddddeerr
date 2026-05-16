/**
 * Auth orchestration. Routes call into these functions; storage details are
 * hidden behind the backend-agnostic proxies in `data/index.ts`.
 *
 * Every call here is async so Postgres and JSON backends are interchangeable.
 */
import { auditStore, codesStore, refreshStore, usersStore } from '../data/index.js';
import { hashPassword, validatePassword, verifyPassword } from './passwords.js';
import { mintRefreshToken, signAccessToken, TTLs } from './jwt.js';
import {
  toPublic,
  type AuthTokens,
  type PublicUser,
  type Role,
  type UserRow
} from './types.js';

export class AuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface RegisterInput {
  username?: string;
  email?: string;
  phone?: string;
  password: string;
  displayName?: string;
  verificationCode?: string;
}

export async function register(
  input: RegisterInput,
  ctx: { ip?: string | null } = {}
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const identifiers = [input.username, input.email, input.phone].filter(Boolean) as string[];
  if (identifiers.length === 0) {
    throw new AuthError(400, 'one of username / email / phone is required');
  }
  const pw = validatePassword(input.password);
  if (!pw.ok) throw new AuthError(400, pw.reason!);

  // Uniqueness check across all identifier fields.
  for (const ident of identifiers) {
    if (await usersStore.findByIdentifier(ident)) {
      throw new AuthError(409, `identifier "${ident}" is already in use`);
    }
  }

  // Optional verification codes (consumed but not required in dev).
  const requireVerify = process.env.REQUIRE_VERIFICATION === '1';
  let emailVerifiedAt: string | null = null;
  let phoneVerifiedAt: string | null = null;

  if (input.email && requireVerify) {
    if (!input.verificationCode) throw new AuthError(400, 'email verification code required');
    const consumed = await codesStore.consume({
      channel: 'email',
      destination: input.email,
      code: input.verificationCode,
      purpose: 'register'
    });
    if (!consumed) throw new AuthError(400, 'invalid or expired verification code');
    emailVerifiedAt = new Date().toISOString();
  } else if (input.email && input.verificationCode) {
    const consumed = await codesStore.consume({
      channel: 'email',
      destination: input.email,
      code: input.verificationCode,
      purpose: 'register'
    });
    if (consumed) emailVerifiedAt = new Date().toISOString();
  }
  if (input.phone && requireVerify) {
    if (!input.verificationCode) throw new AuthError(400, 'phone verification code required');
    const consumed = await codesStore.consume({
      channel: 'sms',
      destination: input.phone,
      code: input.verificationCode,
      purpose: 'register'
    });
    if (!consumed) throw new AuthError(400, 'invalid or expired verification code');
    phoneVerifiedAt = new Date().toISOString();
  }

  const passwordHash = await hashPassword(input.password);
  const role = await bootstrapRoleFor();
  const row = await usersStore.insert({
    username: input.username ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    passwordHash,
    role,
    displayName: input.displayName ?? input.username ?? input.email ?? input.phone ?? null
  });

  if (emailVerifiedAt) await usersStore.update(row.id, { emailVerifiedAt });
  if (phoneVerifiedAt) await usersStore.update(row.id, { phoneVerifiedAt });

  const tokens = await issueTokens(row);
  await auditStore.insert({
    actorUserId: row.id,
    actorIp: ctx.ip ?? null,
    action: 'auth.register',
    targetKind: 'user',
    targetId: row.id,
    meta: { role }
  });

  return { user: toPublic((await usersStore.findById(row.id))!), tokens };
}

async function bootstrapRoleFor(): Promise<Role> {
  return (await usersStore.count()) === 0 ? 'admin' : 'user';
}

export async function login(
  identifier: string,
  password: string,
  ctx: { ip?: string | null } = {}
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const u = await usersStore.findByIdentifier(identifier);
  if (!u) throw new AuthError(401, 'invalid credentials');
  if (u.role === 'banned') throw new AuthError(403, 'account banned');
  const ok = await verifyPassword(password, u.passwordHash);
  if (!ok) {
    await auditStore.insert({
      actorUserId: u.id,
      actorIp: ctx.ip ?? null,
      action: 'auth.login.fail',
      targetKind: 'user',
      targetId: u.id,
      meta: { identifier }
    });
    throw new AuthError(401, 'invalid credentials');
  }
  const tokens = await issueTokens(u);
  await auditStore.insert({
    actorUserId: u.id,
    actorIp: ctx.ip ?? null,
    action: 'auth.login',
    targetKind: 'user',
    targetId: u.id,
    meta: null
  });
  return { user: toPublic(u), tokens };
}

export async function refresh(
  plainToken: string,
  ctx: { ip?: string | null } = {}
): Promise<AuthTokens> {
  const row = await refreshStore.findByPlain(plainToken);
  if (!row) throw new AuthError(401, 'invalid refresh token');
  if (row.revokedAt) throw new AuthError(401, 'refresh token revoked');
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    throw new AuthError(401, 'refresh token expired');
  }
  const user = await usersStore.findById(row.userId);
  if (!user || user.role === 'banned') throw new AuthError(403, 'user not available');

  await refreshStore.revoke(row.id);
  const tokens = await issueTokens(user);
  await auditStore.insert({
    actorUserId: user.id,
    actorIp: ctx.ip ?? null,
    action: 'auth.refresh',
    targetKind: 'user',
    targetId: user.id,
    meta: null
  });
  return tokens;
}

export async function logout(
  plainToken: string,
  ctx: { ip?: string | null } = {}
): Promise<void> {
  const row = await refreshStore.findByPlain(plainToken);
  if (row) {
    await refreshStore.revoke(row.id);
    await auditStore.insert({
      actorUserId: row.userId,
      actorIp: ctx.ip ?? null,
      action: 'auth.logout',
      targetKind: 'user',
      targetId: row.userId,
      meta: null
    });
  }
}

async function issueTokens(user: UserRow): Promise<AuthTokens> {
  const refreshT = mintRefreshToken();
  await refreshStore.insert({
    id: refreshT.id,
    userId: user.id,
    plain: refreshT.token,
    expiresAt: refreshT.expiresAt
  });
  const access = signAccessToken(user.id, user.role, refreshT.id);
  await refreshStore.cleanup();
  return {
    accessToken: access.token,
    refreshToken: refreshT.token,
    accessExpiresAt: access.expiresAt.toISOString(),
    refreshExpiresAt: refreshT.expiresAt.toISOString()
  };
}

export async function issueDevCode(input: {
  channel: 'email' | 'sms';
  destination: string;
  purpose: 'register' | 'login' | 'reset';
}): Promise<string> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await codesStore.issue({
    channel: input.channel,
    destination: input.destination,
    code,
    purpose: input.purpose,
    ttlSeconds: 10 * 60
  });
  // eslint-disable-next-line no-console
  console.log(
    `[auth] dev code (${input.channel} → ${input.destination}, ${input.purpose}): ${code}`
  );
  return code;
}

export const AUTH_CONSTANTS = TTLs;
