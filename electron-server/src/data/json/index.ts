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
  HdoDnsRecordRow,
  HdoDeviceMeshStateRow,
  HdoDevicePluginStateRow,
  HdoDeviceRow,
  HdoDeviceStatus,
  HdoDeviceTaskKind,
  HdoDeviceTaskRow,
  HdoDeviceTaskStatus,
  HdoMeshGroupRow,
  HdoMeshMembershipRole,
  HdoMeshMembershipRow,
  HdoMeshMembershipStatus,
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
  TunnelAccountRow,
  TunnelAccountStatus,
  TunnelNodeRow,
  TunnelNodeStatus,
  TunnelPolicyRow,
  TunnelRoutingMode,
  TunnelRuntimeMode,
  TunnelStore,
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
  meshGroups: HdoMeshGroupRow[];
  memberships: HdoMeshMembershipRow[];
  nodes: HdoNodeRow[];
  devices: HdoDeviceRow[];
  deviceMeshStates: HdoDeviceMeshStateRow[];
  services: HdoServiceRow[];
  dnsRecords: HdoDnsRecordRow[];
  profiles: HdoProfileRow[];
  rateLimits: HdoRateLimitRow[];
  artifacts: HdoSubscriptionArtifactRow[];
  pluginStates: HdoDevicePluginStateRow[];
  deviceTasks: HdoDeviceTaskRow[];
}
interface TunnelFile {
  nodes: TunnelNodeRow[];
  policies: TunnelPolicyRow[];
  accounts: TunnelAccountRow[];
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
    meshGroups: [],
    memberships: [],
    nodes: [],
    devices: [],
    deviceMeshStates: [],
    services: [],
    dnsRecords: [],
    profiles: [],
    rateLimits: [],
    artifacts: [],
    pluginStates: [],
    deviceTasks: []
  };
}

function readHdo(): HdoFile {
  const file = readJson<Partial<HdoFile>>('hdo.json', emptyHdoFile());
  return {
    ...emptyHdoFile(),
    ...file,
    state: file.state ?? { generation: 1, updatedAt: nowIso() },
    meshGroups: file.meshGroups ?? [],
    memberships: file.memberships ?? [],
    nodes: file.nodes ?? [],
    devices: file.devices ?? [],
    deviceMeshStates: file.deviceMeshStates ?? [],
    services: file.services ?? [],
    dnsRecords: file.dnsRecords ?? [],
    profiles: file.profiles ?? [],
    rateLimits: file.rateLimits ?? [],
    artifacts: file.artifacts ?? [],
    pluginStates: file.pluginStates ?? [],
    deviceTasks: file.deviceTasks ?? []
  };
}

function writeHdo(file: HdoFile): void {
  writeJson('hdo.json', file);
}

function emptyTunnelFile(): TunnelFile {
  return {
    nodes: [],
    policies: [],
    accounts: []
  };
}

function readTunnel(): TunnelFile {
  const file = readJson<Partial<TunnelFile>>('tunnel.json', emptyTunnelFile());
  return {
    ...emptyTunnelFile(),
    ...file,
    nodes: file.nodes ?? [],
    policies: file.policies ?? [],
    accounts: file.accounts ?? []
  };
}

function writeTunnel(file: TunnelFile): void {
  writeJson('tunnel.json', file);
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
  async listMeshGroups() {
    return readHdo().meshGroups;
  },
  async upsertMeshGroup(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id
      ? file.meshGroups.findIndex((row) => row.id === input.id)
      : file.meshGroups.findIndex((row) => row.slug === input.slug);
    if (idx >= 0) {
      const existing = file.meshGroups[idx];
      file.meshGroups[idx] = {
        ...existing,
        name: input.name,
        slug: input.slug,
        description: input.description === undefined ? existing.description : input.description,
        defaultProfileId:
          input.defaultProfileId === undefined ? existing.defaultProfileId : input.defaultProfileId,
        enabled: input.enabled ?? existing.enabled,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.meshGroups[idx];
    }
    const row: HdoMeshGroupRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      defaultProfileId: input.defaultProfileId ?? null,
      enabled: input.enabled ?? true,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.meshGroups.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
  },
  async listMeshMemberships(meshGroupId) {
    const rows = readHdo().memberships;
    return meshGroupId ? rows.filter((row) => row.meshGroupId === meshGroupId) : rows;
  },
  async upsertMeshMembership(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id
      ? file.memberships.findIndex((row) => row.id === input.id)
      : file.memberships.findIndex(
          (row) => row.meshGroupId === input.meshGroupId && row.userId === input.userId
        );
    if (idx >= 0) {
      const existing = file.memberships[idx];
      file.memberships[idx] = {
        ...existing,
        meshGroupId: input.meshGroupId,
        userId: input.userId,
        role: input.role ?? existing.role,
        status: input.status ?? existing.status,
        profileId: input.profileId === undefined ? existing.profileId : input.profileId,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.memberships[idx];
    }
    const row: HdoMeshMembershipRow = {
      id: input.id ?? randomUUID(),
      meshGroupId: input.meshGroupId,
      userId: input.userId,
      role: input.role ?? 'member',
      status: input.status ?? 'active',
      profileId: input.profileId ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.memberships.push(row);
    bumpHdoGeneration(file);
    writeHdo(file);
    return row;
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
  async listAllDevices() {
    return readHdo().devices;
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
  async listDeviceMeshStates(filter = {}) {
    return readHdo().deviceMeshStates.filter(
      (row) =>
        (!filter.meshGroupId || row.meshGroupId === filter.meshGroupId) &&
        (!filter.deviceId || row.deviceId === filter.deviceId) &&
        (!filter.userId || row.userId === filter.userId)
    );
  },
  async upsertDeviceMeshState(input) {
    const file = readHdo();
    const now = nowIso();
    const idx = input.id
      ? file.deviceMeshStates.findIndex((row) => row.id === input.id)
      : file.deviceMeshStates.findIndex(
          (row) => row.meshGroupId === input.meshGroupId && row.deviceId === input.deviceId
        );
    if (idx >= 0) {
      const existing = file.deviceMeshStates[idx];
      file.deviceMeshStates[idx] = {
        ...existing,
        meshGroupId: input.meshGroupId,
        deviceId: input.deviceId,
        userId: input.userId,
        status: input.status ?? existing.status,
        note: input.note === undefined ? existing.note : input.note,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        lastSeenAt: input.lastSeenAt === undefined ? existing.lastSeenAt : input.lastSeenAt,
        createdByUserId: input.createdByUserId ?? existing.createdByUserId,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.deviceMeshStates[idx];
    }
    const row: HdoDeviceMeshStateRow = {
      id: input.id ?? randomUUID(),
      meshGroupId: input.meshGroupId,
      deviceId: input.deviceId,
      userId: input.userId,
      status: input.status ?? 'active',
      note: input.note ?? null,
      metadata: input.metadata ?? null,
      lastSeenAt: input.lastSeenAt ?? now,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.deviceMeshStates.push(row);
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
  async listDnsRecords() {
    return readHdo().dnsRecords;
  },
  async upsertDnsRecord(input) {
    const file = readHdo();
    const now = nowIso();
    const domain = input.domain.trim().toLowerCase();
    const idx = input.id
      ? file.dnsRecords.findIndex((row) => row.id === input.id)
      : file.dnsRecords.findIndex((row) => row.domain === domain);
    if (idx >= 0) {
      const existing = file.dnsRecords[idx];
      file.dnsRecords[idx] = {
        ...existing,
        domain,
        targetHost: input.targetHost,
        enabled: input.enabled ?? existing.enabled,
        note: input.note === undefined ? existing.note : input.note,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      bumpHdoGeneration(file);
      writeHdo(file);
      return file.dnsRecords[idx];
    }

    const row: HdoDnsRecordRow = {
      id: input.id ?? randomUUID(),
      domain,
      targetHost: input.targetHost,
      enabled: input.enabled ?? true,
      note: input.note ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.dnsRecords.push(row);
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
  },
  async listDevicePluginStates(deviceId) {
    const rows = readHdo().pluginStates;
    return deviceId ? rows.filter((row) => row.deviceId === deviceId) : rows;
  },
  async upsertDevicePluginStates(deviceId, plugins) {
    const file = readHdo();
    const now = nowIso();
    const out: HdoDevicePluginStateRow[] = [];
    for (const plugin of plugins) {
      const idx = file.pluginStates.findIndex(
        (row) => row.deviceId === deviceId && row.pluginId === plugin.pluginId
      );
      if (idx >= 0) {
        const existing = file.pluginStates[idx];
        file.pluginStates[idx] = {
          ...existing,
          npm: plugin.npm === undefined ? existing.npm : plugin.npm,
          name: plugin.name === undefined ? existing.name : plugin.name,
          version: plugin.version === undefined ? existing.version : plugin.version,
          state: plugin.state,
          manifest: plugin.manifest === undefined ? existing.manifest : plugin.manifest,
          health: plugin.health === undefined ? existing.health : plugin.health,
          lastSeenAt: now,
          updatedAt: now
        };
        out.push(file.pluginStates[idx]);
      } else {
        const row: HdoDevicePluginStateRow = {
          id: randomUUID(),
          deviceId,
          pluginId: plugin.pluginId,
          npm: plugin.npm ?? null,
          name: plugin.name ?? null,
          version: plugin.version ?? null,
          state: plugin.state,
          manifest: plugin.manifest ?? null,
          health: plugin.health ?? null,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now
        };
        file.pluginStates.push(row);
        out.push(row);
      }
    }
    writeHdo(file);
    return out;
  },
  async listDeviceTasks(filter = {}) {
    let rows = readHdo().deviceTasks;
    if (filter.userId) rows = rows.filter((row) => row.userId === filter.userId);
    if (filter.deviceId) rows = rows.filter((row) => row.deviceId === filter.deviceId);
    if (filter.status) rows = rows.filter((row) => row.status === filter.status);
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async createDeviceTask(input) {
    const file = readHdo();
    const now = nowIso();
    const row: HdoDeviceTaskRow = {
      id: randomUUID(),
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      pluginId: input.pluginId ?? null,
      kind: input.kind,
      status: input.status ?? 'pending',
      payload: input.payload ?? null,
      result: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    file.deviceTasks.push(row);
    writeHdo(file);
    return row;
  },
  async claimDeviceTask(id, input) {
    const file = readHdo();
    const idx = file.deviceTasks.findIndex((row) => row.id === id);
    if (idx === -1 || file.deviceTasks[idx].status !== 'pending') return null;
    const existing = file.deviceTasks[idx];
    const now = nowIso();
    file.deviceTasks[idx] = {
      ...existing,
      deviceId: existing.deviceId ?? input.deviceId ?? null,
      status: 'claimed',
      result: input.result ?? existing.result,
      updatedAt: now,
      completedAt: null
    };
    writeHdo(file);
    return file.deviceTasks[idx];
  },
  async completeDeviceTask(id, input) {
    const file = readHdo();
    const idx = file.deviceTasks.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    file.deviceTasks[idx] = {
      ...file.deviceTasks[idx],
      status: input.status,
      result: input.result ?? null,
      updatedAt: nowIso(),
      completedAt: ['done', 'failed', 'cancelled'].includes(input.status) ? nowIso() : null
    };
    writeHdo(file);
    return file.deviceTasks[idx];
  }
};

const tunnel: TunnelStore = {
  async listNodes() {
    return readTunnel().nodes.sort((a, b) => a.name.localeCompare(b.name));
  },
  async findNode(id) {
    return readTunnel().nodes.find((row) => row.id === id) ?? null;
  },
  async upsertNode(input) {
    const file = readTunnel();
    const now = nowIso();
    const idx = input.id
      ? file.nodes.findIndex((row) => row.id === input.id)
      : file.nodes.findIndex((row) => row.name === input.name);
    if (idx >= 0) {
      const existing = file.nodes[idx];
      const desiredRevision = input.desiredRevision ?? existing.desiredRevision + 1;
      file.nodes[idx] = {
        ...existing,
        name: input.name,
        publicHost: input.publicHost,
        runnerUrl: input.runnerUrl === undefined ? existing.runnerUrl : input.runnerUrl,
        runnerToken: input.runnerToken === undefined ? existing.runnerToken : input.runnerToken,
        status: input.status ?? existing.status,
        serverPorts: input.serverPorts === undefined ? existing.serverPorts : input.serverPorts,
        subscriptionBaseUrl:
          input.subscriptionBaseUrl === undefined ? existing.subscriptionBaseUrl : input.subscriptionBaseUrl,
        desiredRevision,
        appliedRevision: input.appliedRevision === undefined ? existing.appliedRevision : input.appliedRevision,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      writeTunnel(file);
      return file.nodes[idx];
    }
    const row: TunnelNodeRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      publicHost: input.publicHost,
      runnerUrl: input.runnerUrl ?? null,
      runnerToken: input.runnerToken ?? null,
      status: input.status ?? 'pending',
      serverPorts: input.serverPorts ?? null,
      subscriptionBaseUrl: input.subscriptionBaseUrl ?? null,
      desiredRevision: input.desiredRevision ?? 1,
      appliedRevision: input.appliedRevision ?? null,
      metadata: input.metadata ?? null,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now
    };
    file.nodes.push(row);
    writeTunnel(file);
    return row;
  },
  async setNodeAppliedRevision(id, input) {
    const file = readTunnel();
    const idx = file.nodes.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    const now = nowIso();
    file.nodes[idx] = {
      ...file.nodes[idx],
      appliedRevision: input.appliedRevision,
      status: input.status ?? 'online',
      metadata: input.metadata === undefined ? file.nodes[idx].metadata : input.metadata,
      lastSeenAt: now,
      updatedAt: now
    };
    writeTunnel(file);
    return file.nodes[idx];
  },
  async listPolicies() {
    return readTunnel().policies.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  },
  async ensureDefaultPolicy() {
    const existing = readTunnel().policies.find((row) => row.isDefault);
    if (existing) return existing;
    return this.upsertPolicy({
      name: 'default-cn-direct',
      routingMode: 'cn-direct',
      runtimeMode: 'app-global',
      enabled: true,
      isDefault: true,
      rules: {
        description: 'CN/direct, foreign traffic through Oversea Hysteria2.',
        autoStart: true,
        autoUpdate: true
      }
    });
  },
  async upsertPolicy(input) {
    const file = readTunnel();
    const now = nowIso();
    const idx = input.id
      ? file.policies.findIndex((row) => row.id === input.id)
      : file.policies.findIndex((row) => row.name === input.name);
    if (input.isDefault) {
      file.policies = file.policies.map((row) => ({ ...row, isDefault: false }));
    }
    if (idx >= 0) {
      const existing = file.policies[idx];
      file.policies[idx] = {
        ...existing,
        name: input.name,
        routingMode: input.routingMode ?? existing.routingMode,
        runtimeMode: input.runtimeMode ?? existing.runtimeMode,
        enabled: input.enabled ?? existing.enabled,
        isDefault: input.isDefault ?? existing.isDefault,
        rules: input.rules === undefined ? existing.rules : input.rules,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      writeTunnel(file);
      return file.policies[idx];
    }
    const row: TunnelPolicyRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      routingMode: input.routingMode ?? 'cn-direct',
      runtimeMode: input.runtimeMode ?? 'app-global',
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? file.policies.length === 0,
      rules: input.rules ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    if (row.isDefault) file.policies = file.policies.map((item) => ({ ...item, isDefault: false }));
    file.policies.push(row);
    writeTunnel(file);
    return row;
  },
  async listAccounts(filter = {}) {
    let rows = readTunnel().accounts;
    if (filter.userId) rows = rows.filter((row) => row.userId === filter.userId);
    if (filter.nodeId) rows = rows.filter((row) => row.nodeId === filter.nodeId);
    if (filter.status) rows = rows.filter((row) => row.status === filter.status);
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async findAccount(id) {
    return readTunnel().accounts.find((row) => row.id === id) ?? null;
  },
  async findAccountBySubscriptionToken(token) {
    return readTunnel().accounts.find((row) => row.subscriptionToken === token) ?? null;
  },
  async upsertAccount(input) {
    const file = readTunnel();
    const now = nowIso();
    const idx = input.id
      ? file.accounts.findIndex((row) => row.id === input.id)
      : file.accounts.findIndex((row) => row.userId === input.userId && row.username === input.username);
    if (idx >= 0) {
      const existing = file.accounts[idx];
      const desiredRevision = input.desiredRevision ?? existing.desiredRevision + 1;
      file.accounts[idx] = {
        ...existing,
        userId: input.userId,
        nodeId: input.nodeId === undefined ? existing.nodeId : input.nodeId,
        policyId: input.policyId === undefined ? existing.policyId : input.policyId,
        username: input.username,
        status: input.status ?? existing.status,
        authToken: input.authToken ?? existing.authToken,
        subscriptionToken: input.subscriptionToken ?? existing.subscriptionToken,
        downRate: input.downRate === undefined ? existing.downRate : input.downRate,
        upRate: input.upRate === undefined ? existing.upRate : input.upRate,
        desiredRevision,
        appliedRevision: input.appliedRevision === undefined ? existing.appliedRevision : input.appliedRevision,
        metadata: input.metadata === undefined ? existing.metadata : input.metadata,
        updatedAt: now
      };
      writeTunnel(file);
      return file.accounts[idx];
    }
    const row: TunnelAccountRow = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      nodeId: input.nodeId ?? null,
      policyId: input.policyId ?? null,
      username: input.username,
      status: input.status ?? 'active',
      authToken: input.authToken ?? randomUUID().replace(/-/g, ''),
      subscriptionToken: input.subscriptionToken ?? randomUUID().replace(/-/g, ''),
      downRate: input.downRate ?? null,
      upRate: input.upRate ?? null,
      desiredRevision: input.desiredRevision ?? 1,
      appliedRevision: input.appliedRevision ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now
    };
    file.accounts.push(row);
    writeTunnel(file);
    return row;
  },
  async setAccountAppliedRevision(id, appliedRevision) {
    const file = readTunnel();
    const idx = file.accounts.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    file.accounts[idx] = {
      ...file.accounts[idx],
      appliedRevision,
      updatedAt: nowIso()
    };
    writeTunnel(file);
    return file.accounts[idx];
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
  tunnel,
  backend: 'json',
  async close() {
    // nothing to close
  }
};
