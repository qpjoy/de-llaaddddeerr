/**
 * Async storage contracts. Two backends implement these:
 *   - `json/*`  — files under `data/auth/`. Default in dev.
 *   - `pg/*`    — Postgres. Activated by `DATABASE_URL`.
 *
 * Route + service code only sees these interfaces, so swapping backends
 * is invisible above this layer.
 */
import type {
  EntitlementKind,
  EntitlementRow,
  RefreshTokenRow,
  Role,
  UserRow,
  VerificationCodeRow
} from '../auth/types.js';

export interface UsersStore {
  list(): Promise<UserRow[]>;
  findById(id: string): Promise<UserRow | null>;
  findByIdentifier(identifier: string): Promise<UserRow | null>;
  insert(
    input: Omit<UserRow, 'id' | 'createdAt' | 'updatedAt' | 'emailVerifiedAt' | 'phoneVerifiedAt'>
  ): Promise<UserRow>;
  update(
    id: string,
    patch: Partial<Omit<UserRow, 'id' | 'createdAt'>>
  ): Promise<UserRow | null>;
  setRole(id: string, role: Role): Promise<UserRow | null>;
  /** Total count — used by the "first user becomes admin" rule. */
  count(): Promise<number>;
}

export interface RefreshStore {
  insert(input: {
    id: string;
    userId: string;
    plain: string;
    expiresAt: Date;
    deviceLabel?: string | null;
  }): Promise<RefreshTokenRow>;
  findByPlain(plain: string): Promise<RefreshTokenRow | null>;
  revoke(id: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
  /** GC; returns rows removed. */
  cleanup(): Promise<number>;
}

export interface EntitlementsStore {
  forUser(userId: string): Promise<EntitlementRow[]>;
  forUserAndPlugin(userId: string, pluginId: string): Promise<EntitlementRow | null>;
  grant(input: {
    userId: string;
    pluginId: string;
    kind: EntitlementKind;
    expiresAt?: string | null;
  }): Promise<EntitlementRow>;
}

export interface CodesStore {
  issue(input: {
    channel: 'email' | 'sms';
    destination: string;
    code: string;
    purpose: 'register' | 'login' | 'reset';
    ttlSeconds: number;
  }): Promise<VerificationCodeRow>;
  consume(input: {
    channel: 'email' | 'sms';
    destination: string;
    code: string;
    purpose: 'register' | 'login' | 'reset';
  }): Promise<VerificationCodeRow | null>;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Audit log                                                              */
/* ────────────────────────────────────────────────────────────────────── */

export interface AuditEntry {
  id: number;
  actorUserId: string | null;
  actorIp: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditStore {
  insert(input: {
    actorUserId?: string | null;
    actorIp?: string | null;
    action: string;
    targetKind?: string | null;
    targetId?: string | null;
    meta?: Record<string, unknown> | null;
  }): Promise<AuditEntry>;
  query(opts?: {
    limit?: number;
    before?: number;
    actorUserId?: string;
    action?: string;
    targetId?: string;
  }): Promise<AuditEntry[]>;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Bundle                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

export interface Storage {
  users: UsersStore;
  refresh: RefreshStore;
  entitlements: EntitlementsStore;
  codes: CodesStore;
  audit: AuditStore;
  backend: 'json' | 'postgres';
  /** Best-effort close; harmless when called multiple times. */
  close(): Promise<void>;
}
