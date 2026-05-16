/**
 * Auth wire types. Server-internal — never expose `passwordHash` over the API.
 */

export type Role = 'user' | 'admin' | 'banned';

export interface UserRow {
  id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  passwordHash: string;
  role: Role;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  /** When user proved control of email (verification flow). */
  emailVerifiedAt: string | null;
  /** Same for phone. */
  phoneVerifiedAt: string | null;
}

/** Safe shape returned by the API. */
export interface PublicUser {
  id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  displayName: string | null;
  role: Role;
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
}

export interface RefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  deviceLabel: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export type EntitlementKind = 'free' | 'paid' | 'trial';

export interface EntitlementRow {
  id: string;
  userId: string;
  pluginId: string;
  kind: EntitlementKind;
  grantedAt: string;
  expiresAt: string | null;
}

export interface VerificationCodeRow {
  id: string;
  channel: 'email' | 'sms';
  destination: string;
  code: string;
  purpose: 'register' | 'login' | 'reset';
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export function toPublic(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    phone: u.phone,
    displayName: u.displayName,
    role: u.role,
    emailVerified: Boolean(u.emailVerifiedAt),
    phoneVerified: Boolean(u.phoneVerifiedAt),
    createdAt: u.createdAt
  };
}
