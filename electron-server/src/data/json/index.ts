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
  GameHighScoreRow,
  GameScoresStore,
  HdoDeviceRow,
  HdoDeviceStatus,
  HdoNodeKind,
  HdoNodeRow,
  HdoNodeStatus,
  HdoProfileMode,
  HdoProfileRow,
  HdoRateLimitRow,
  HdoServiceProtocol,
  HdoServiceRow,
  HdoStore,
  HdoSubscriptionArtifactRow,
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
interface GameScoresFile { scores: GameHighScoreRow[]; }
interface HdoFile {
  state: { generation: number; updatedAt: string };
  nodes: HdoNodeRow[];
  devices: HdoDeviceRow[];
  services: HdoServiceRow[];
  profiles: HdoProfileRow[];
  rateLimits: HdoRateLimitRow[];
  artifacts: HdoSubscriptionArtifactRow[];
}

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

function nowIso(): string {
  return new Date().toISOString();
}

function emptyHdoFile(): HdoFile {
  return {
    state: { generation: 1, updatedAt: nowIso() },
    nodes: [],
    devices: [],
    services: [],
    profiles: [],
    rateLimits: [],
    artifacts: []
  };
}

function readHdo(): HdoFile {
  return readJson<HdoFile>('hdo.json', emptyHdoFile());
}

function writeHdo(file: HdoFile): void {
  writeJson('hdo.json', file);
}

function bumpHdoGeneration(file: HdoFile): number {
  file.state.generation += 1;
  file.state.updatedAt = nowIso();
  return file.state.generation;
}

function defaultHdoProfiles(): Array<{
  name: string;
  mode: HdoProfileMode;
  rules: Record<string, unknown>;
}> {
  return [
    {
      name: 'home-only',
      mode: 'home-only',
      rules: {
        description: 'Only route home overlay and configured home services through HDO.'
      }
    },
    {
      name: 'home-foreign',
      mode: 'home-foreign',
      rules: {
        description: 'Route home overlay plus foreign destinations through oversea egress.'
      }
    },
    {
      name: 'domestic-global',
      mode: 'domestic-global',
      rules: {
        description: 'Route client traffic to domestic entry, then apply server-side policy.'
      }
    }
  ];
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

const gameScores: GameScoresStore = {
  async submit(input) {
    const file = readJson<GameScoresFile>('game-scores.json', { scores: [] });
    const now = new Date().toISOString();
    const completedAt = input.completedAt || now;
    const score = Math.max(0, Math.floor(input.score));
    const elapsedSeconds = Math.max(0, Math.floor(input.elapsedSeconds));
    const existing = file.scores.find(
      (row) =>
        row.userId === input.userId &&
        row.gameId === input.gameId &&
        row.mode === input.mode
    );

    if (existing) {
      const isBetter =
        score > existing.bestScore ||
        (score === existing.bestScore && elapsedSeconds < existing.bestElapsedSeconds);
      existing.playerName = input.playerName;
      existing.pluginId = input.pluginId;
      existing.rounds += 1;
      existing.updatedAt = now;
      if (isBetter) {
        existing.bestScore = score;
        existing.bestElapsedSeconds = elapsedSeconds;
        existing.completedAt = completedAt;
        existing.metadata = input.metadata ?? null;
      }
      writeJson('game-scores.json', file);
      return existing;
    }

    const row: GameHighScoreRow = {
      userId: input.userId,
      playerName: input.playerName,
      gameId: input.gameId,
      pluginId: input.pluginId,
      mode: input.mode,
      bestScore: score,
      bestElapsedSeconds: elapsedSeconds,
      rounds: 1,
      completedAt,
      updatedAt: now,
      metadata: input.metadata ?? null
    };
    file.scores.push(row);
    writeJson('game-scores.json', file);
    return row;
  },
  async leaderboard(opts) {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100);
    return readJson<GameScoresFile>('game-scores.json', { scores: [] })
      .scores
      .filter((row) => row.gameId === opts.gameId && row.mode === opts.mode)
      .sort((a, b) => {
        if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
        if (a.bestElapsedSeconds !== b.bestElapsedSeconds) {
          return a.bestElapsedSeconds - b.bestElapsedSeconds;
        }
        return a.completedAt.localeCompare(b.completedAt);
      })
      .slice(0, limit)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }
};

const hdo: HdoStore = {
  async getGeneration() {
    return readHdo().state.generation;
  },
  async bumpGeneration() {
    const file = readHdo();
    const generation = bumpHdoGeneration(file);
    writeHdo(file);
    return generation;
  },
  async listNodes() {
    return readHdo().nodes;
  },
  async upsertNode(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id ? file.nodes.findIndex((row) => row.id === input.id) : -1;
    if (idx >= 0) {
      const existing = file.nodes[idx];
      file.nodes[idx] = {
        ...existing,
        name: input.name,
        kind: input.kind,
        publicHost: input.publicHost === undefined ? existing.publicHost : input.publicHost,
        overlayIp: input.overlayIp === undefined ? existing.overlayIp : input.overlayIp,
        status: input.status ?? existing.status,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.nodes[idx];
    }

    const row: HdoNodeRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      kind: input.kind,
      publicHost: input.publicHost ?? null,
      overlayIp: input.overlayIp ?? null,
      status: input.status ?? 'pending',
      metadata: input.metadata ?? null,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now
    };
    file.nodes.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
  },
  async setNodeHeartbeat(id, input = {}) {
    const file = readHdo();
    const idx = file.nodes.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    const now = nowIso();
    const existing = file.nodes[idx];
    file.nodes[idx] = {
      ...existing,
      status: input.status ?? 'online',
      metadata: input.metadata === undefined ? existing.metadata : input.metadata,
      lastSeenAt: now,
      updatedAt: now
    };
    writeHdo(file);
    return file.nodes[idx];
  },
  async listDevicesForUser(userId) {
    return readHdo().devices.filter((row) => row.userId === userId);
  },
  async findDevice(id) {
    return readHdo().devices.find((row) => row.id === id) ?? null;
  },
  async upsertDevice(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = file.devices.findIndex((row) => row.id === input.id);
    if (idx >= 0) {
      const existing = file.devices[idx];
      file.devices[idx] = {
        ...existing,
        userId: input.userId,
        label: input.label,
        platform: input.platform === undefined ? existing.platform : input.platform,
        publicKey: input.publicKey === undefined ? existing.publicKey : input.publicKey,
        overlayIp: input.overlayIp === undefined ? existing.overlayIp : input.overlayIp,
        status: input.status ?? existing.status,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        lastSeenAt: now,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.devices[idx];
    }

    const row: HdoDeviceRow = {
      id: input.id,
      userId: input.userId,
      label: input.label,
      platform: input.platform ?? null,
      publicKey: input.publicKey ?? null,
      overlayIp: input.overlayIp ?? null,
      status: input.status ?? 'online',
      metadata: input.metadata ?? null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    };
    file.devices.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
  },
  async listServices() {
    return readHdo().services;
  },
  async upsertService(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id
      ? file.services.findIndex((row) => row.id === input.id)
      : file.services.findIndex((row) => row.name === input.name);
    if (idx >= 0) {
      const existing = file.services[idx];
      file.services[idx] = {
        ...existing,
        name: input.name,
        nodeId: input.nodeId === undefined ? existing.nodeId : input.nodeId,
        targetHost: input.targetHost,
        targetPort: input.targetPort,
        protocol: input.protocol ?? existing.protocol,
        domains: input.domains ?? existing.domains,
        enabled: input.enabled ?? existing.enabled,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.services[idx];
    }

    const row: HdoServiceRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      nodeId: input.nodeId ?? null,
      targetHost: input.targetHost,
      targetPort: input.targetPort,
      protocol: input.protocol ?? 'tcp',
      domains: input.domains ?? [],
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.services.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
  },
  async listProfiles() {
    return readHdo().profiles;
  },
  async ensureDefaultProfiles() {
    const file = readHdo();
    const now = nowIso();
    let changed = false;
    for (const profile of defaultHdoProfiles()) {
      if (file.profiles.some((row) => row.name === profile.name)) continue;
      file.profiles.push({
        id: randomUUID(),
        name: profile.name,
        mode: profile.mode,
        enabled: true,
        rules: profile.rules,
        metadata: null,
        createdAt: now,
        updatedAt: now
      });
      changed = true;
    }
    if (changed) {
      bumpHdoGeneration(file);
      writeHdo(file);
    }
    return file.profiles;
  },
  async upsertProfile(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id
      ? file.profiles.findIndex((row) => row.id === input.id)
      : file.profiles.findIndex((row) => row.name === input.name);
    if (idx >= 0) {
      const existing = file.profiles[idx];
      file.profiles[idx] = {
        ...existing,
        name: input.name,
        mode: input.mode,
        enabled: input.enabled ?? existing.enabled,
        rules: input.rules === undefined ? existing.rules : input.rules,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.profiles[idx];
    }

    const row: HdoProfileRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      mode: input.mode,
      enabled: input.enabled ?? true,
      rules: input.rules ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.profiles.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
  },
  async listRateLimits() {
    return readHdo().rateLimits;
  },
  async upsertRateLimit(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id
      ? file.rateLimits.findIndex((row) => row.id === input.id)
      : file.rateLimits.findIndex(
          (row) => row.subjectType === input.subjectType && row.subjectId === input.subjectId
        );
    if (idx >= 0) {
      const existing = file.rateLimits[idx];
      file.rateLimits[idx] = {
        ...existing,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        downRate: input.downRate === undefined ? existing.downRate : input.downRate,
        downCeil: input.downCeil === undefined ? existing.downCeil : input.downCeil,
        upRate: input.upRate === undefined ? existing.upRate : input.upRate,
        upCeil: input.upCeil === undefined ? existing.upCeil : input.upCeil,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.rateLimits[idx];
    }

    const row: HdoRateLimitRow = {
      id: input.id ?? randomUUID(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      downRate: input.downRate ?? null,
      downCeil: input.downCeil ?? null,
      upRate: input.upRate ?? null,
      upCeil: input.upCeil ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.rateLimits.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
  },
  async latestArtifact(deviceId, kind) {
    return (
      readHdo()
        .artifacts
        .filter((row) => row.deviceId === deviceId && row.kind === kind)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    );
  },
  async saveArtifact(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = file.artifacts.findIndex(
      (row) => row.deviceId === input.deviceId && row.kind === input.kind
    );
    if (idx >= 0) {
      const existing = file.artifacts[idx];
      file.artifacts[idx] = {
        ...existing,
        generation: input.generation,
        checksum: input.checksum,
        content: input.content,
        contentType: input.contentType,
        expiresAt: input.expiresAt ?? null,
        updatedAt: now
      };
      writeHdo(file);
      return file.artifacts[idx];
    }

    const row: HdoSubscriptionArtifactRow = {
      id: randomUUID(),
      deviceId: input.deviceId,
      kind: input.kind,
      generation: input.generation,
      checksum: input.checksum,
      content: input.content,
      contentType: input.contentType,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.artifacts.push(row);
    writeHdo(file);
    return row;
  }
};

export const jsonStorage: Storage = {
  users,
  refresh,
  entitlements,
  codes,
  audit,
  gameScores,
  hdo,
  backend: 'json',
  async close() {
    // nothing to close
  }
};
