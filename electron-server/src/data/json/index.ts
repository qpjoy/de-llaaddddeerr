/**
 * JSON-file backend. Each table maps to one file under `data/auth/`.
 *
 * Internals are sync but the public methods are async to match the
 * `Storage` interface (so the route layer is identical for both backends).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  EntitlementRow,
  RefreshTokenRow,
  Role,
  UserRow,
  VerificationCodeRow
} from '../../auth/types.js';
import type {
  AuditEntry,
  AuditStore,
  CodesStore,
  EntitlementsStore,
  RefreshStore,
  Storage,
  UsersStore
} from '../storage-types.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..', 'data', 'auth');
mkdirSync(ROOT, { recursive: true });

interface UsersFile { users: UserRow[]; }
interface RefreshFile { tokens: RefreshTokenRow[]; }
interface EntitlementsFile { entitlements: EntitlementRow[]; }
interface CodesFile { codes: VerificationCodeRow[]; }
interface AuditFile { nextId: number; entries: AuditEntry[]; }

function readJson<T>(name: string, fallback: T): T {
  const path = join(ROOT, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[json-storage] bad JSON at ${path}:`, err);
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  const path = join(ROOT, name);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

function hashToken(plain: string): string {
  return 'sha256:' + createHash('sha256').update(plain).digest('hex');
}

/* ────────────────────────────────────────────────────────────────────── */

const users: UsersStore = {
  async list() {
    return readJson<UsersFile>('users.json', { users: [] }).users;
  },
  async findById(id) {
    return (await this.list()).find((u) => u.id === id) ?? null;
  },
  async findByIdentifier(identifier) {
    const lower = identifier.toLowerCase();
    return (
      (await this.list()).find(
        (u) =>
          u.username?.toLowerCase() === lower ||
          u.email?.toLowerCase() === lower ||
          u.phone === identifier
      ) ?? null
    );
  },
  async insert(input) {
    const all = await this.list();
    const now = new Date().toISOString();
    const user: UserRow = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      ...input
    };
    all.push(user);
    writeJson('users.json', { users: all } satisfies UsersFile);
    return user;
  },
  async update(id, patch) {
    const all = await this.list();
    const idx = all.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    const merged: UserRow = {
      ...all[idx],
      ...patch,
      id: all[idx].id,
      createdAt: all[idx].createdAt,
      updatedAt: new Date().toISOString()
    };
    all[idx] = merged;
    writeJson('users.json', { users: all } satisfies UsersFile);
    return merged;
  },
  async setRole(id, role: Role) {
    return this.update(id, { role });
  },
  async count() {
    return (await this.list()).length;
  }
};

const refresh: RefreshStore = {
  async insert(input) {
    const all = readJson<RefreshFile>('refresh.json', { tokens: [] }).tokens;
    const row: RefreshTokenRow = {
      id: input.id,
      userId: input.userId,
      tokenHash: hashToken(input.plain),
      deviceLabel: input.deviceLabel ?? null,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
      createdAt: new Date().toISOString()
    };
    all.push(row);
    writeJson('refresh.json', { tokens: all } satisfies RefreshFile);
    return row;
  },
  async findByPlain(plain) {
    const hash = hashToken(plain);
    return (
      readJson<RefreshFile>('refresh.json', { tokens: [] }).tokens.find(
        (t) => t.tokenHash === hash
      ) ?? null
    );
  },
  async revoke(id) {
    const all = readJson<RefreshFile>('refresh.json', { tokens: [] }).tokens;
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) return;
    all[idx] = { ...all[idx], revokedAt: new Date().toISOString() };
    writeJson('refresh.json', { tokens: all } satisfies RefreshFile);
  },
  async revokeAllForUser(userId) {
    const all = readJson<RefreshFile>('refresh.json', { tokens: [] }).tokens;
    const now = new Date().toISOString();
    for (const t of all) if (t.userId === userId && !t.revokedAt) t.revokedAt = now;
    writeJson('refresh.json', { tokens: all } satisfies RefreshFile);
  },
  async cleanup() {
    const all = readJson<RefreshFile>('refresh.json', { tokens: [] }).tokens;
    const now = Date.now();
    const kept = all.filter(
      (t) => !t.revokedAt && new Date(t.expiresAt).getTime() > now
    );
    if (kept.length !== all.length) {
      writeJson('refresh.json', { tokens: kept } satisfies RefreshFile);
    }
    return all.length - kept.length;
  }
};

const entitlements: EntitlementsStore = {
  async forUser(userId) {
    const now = Date.now();
    return readJson<EntitlementsFile>('entitlements.json', { entitlements: [] }).entitlements.filter(
      (e) => e.userId === userId && (!e.expiresAt || new Date(e.expiresAt).getTime() > now)
    );
  },
  async forUserAndPlugin(userId, pluginId) {
    return (
      (await this.forUser(userId)).find((e) => e.pluginId === pluginId) ?? null
    );
  },
  async grant(input) {
    const all = readJson<EntitlementsFile>('entitlements.json', { entitlements: [] }).entitlements;
    const existing = all.find(
      (e) => e.userId === input.userId && e.pluginId === input.pluginId
    );
    if (existing) {
      existing.kind = input.kind;
      existing.expiresAt = input.expiresAt ?? null;
      writeJson('entitlements.json', { entitlements: all } satisfies EntitlementsFile);
      return existing;
    }
    const row: EntitlementRow = {
      id: randomUUID(),
      userId: input.userId,
      pluginId: input.pluginId,
      kind: input.kind,
      grantedAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null
    };
    all.push(row);
    writeJson('entitlements.json', { entitlements: all } satisfies EntitlementsFile);
    return row;
  }
};

const codes: CodesStore = {
  async issue(input) {
    const all = readJson<CodesFile>('codes.json', { codes: [] }).codes;
    const row: VerificationCodeRow = {
      id: randomUUID(),
      channel: input.channel,
      destination: input.destination,
      code: input.code,
      purpose: input.purpose,
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      consumedAt: null,
      createdAt: new Date().toISOString()
    };
    all.push(row);
    writeJson('codes.json', { codes: all } satisfies CodesFile);
    return row;
  },
  async consume(input) {
    const all = readJson<CodesFile>('codes.json', { codes: [] }).codes;
    const now = Date.now();
    const match = all.find(
      (c) =>
        c.channel === input.channel &&
        c.destination === input.destination &&
        c.code === input.code &&
        c.purpose === input.purpose &&
        !c.consumedAt &&
        new Date(c.expiresAt).getTime() > now
    );
    if (!match) return null;
    match.consumedAt = new Date().toISOString();
    writeJson('codes.json', { codes: all } satisfies CodesFile);
    return match;
  }
};

const audit: AuditStore = {
  async insert(input) {
    const file = readJson<AuditFile>('audit.json', { nextId: 1, entries: [] });
    const entry: AuditEntry = {
      id: file.nextId,
      actorUserId: input.actorUserId ?? null,
      actorIp: input.actorIp ?? null,
      action: input.action,
      targetKind: input.targetKind ?? null,
      targetId: input.targetId ?? null,
      meta: input.meta ?? null,
      createdAt: new Date().toISOString()
    };
    file.entries.push(entry);
    file.nextId = file.nextId + 1;
    // Cap file size — keep the most recent 5000.
    if (file.entries.length > 5000) {
      file.entries = file.entries.slice(file.entries.length - 5000);
    }
    writeJson('audit.json', file);
    return entry;
  },
  async query(opts = {}) {
    let rows = readJson<AuditFile>('audit.json', { nextId: 1, entries: [] }).entries;
    if (opts.actorUserId) rows = rows.filter((r) => r.actorUserId === opts.actorUserId);
    if (opts.action) rows = rows.filter((r) => r.action === opts.action);
    if (opts.targetId) rows = rows.filter((r) => r.targetId === opts.targetId);
    rows = rows.sort((a, b) => b.id - a.id);
    if (typeof opts.before === 'number') rows = rows.filter((r) => r.id < opts.before!);
    return rows.slice(0, opts.limit ?? 100);
  }
};

export const jsonStorage: Storage = {
  users,
  refresh,
  entitlements,
  codes,
  audit,
  backend: 'json',
  async close() {
    // nothing to close
  }
};
