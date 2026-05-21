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
/* Game high scores                                                       */
/* ────────────────────────────────────────────────────────────────────── */

export interface GameHighScoreRow {
  userId: string;
  playerName: string;
  gameId: string;
  pluginId: string;
  mode: string;
  bestScore: number;
  bestElapsedSeconds: number;
  rounds: number;
  completedAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}

export interface GameScoresStore {
  submit(input: {
    userId: string;
    playerName: string;
    gameId: string;
    pluginId: string;
    mode: string;
    score: number;
    elapsedSeconds: number;
    completedAt: string;
    metadata?: Record<string, unknown> | null;
  }): Promise<GameHighScoreRow>;
  leaderboard(opts: {
    gameId: string;
    mode: string;
    limit?: number;
  }): Promise<Array<GameHighScoreRow & { rank: number }>>;
}

/* ────────────────────────────────────────────────────────────────────── */
/* HDO control plane                                                      */
/* ────────────────────────────────────────────────────────────────────── */

export type HdoNodeKind = 'domestic' | 'home' | 'oversea';
export type HdoNodeStatus = 'pending' | 'online' | 'offline' | 'error';
export type HdoDeviceStatus = HdoNodeStatus;
export type HdoServiceProtocol = 'tcp' | 'udp' | 'http' | 'https';
export type HdoProfileMode = 'home-only' | 'home-foreign' | 'domestic-global';
export type HdoRateLimitSubjectType = 'user' | 'device' | 'profile' | 'node';
export type HdoArtifactKind = 'manifest' | 'mihomo-yaml' | 'wg-profile';
export type HdoMeshMembershipRole = 'member' | 'admin' | 'support';
export type HdoMeshMembershipStatus = 'active' | 'suspended' | 'revoked';
export type HdoDeviceMeshStateStatus = 'active' | 'disabled' | 'kicked';
export type HdoDeviceTaskKind =
  | 'install-plugin'
  | 'uninstall-plugin'
  | 'activate-plugin'
  | 'deactivate-plugin'
  | 'apply-hdo-profile'
  | 'notify';
export type HdoDeviceTaskStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface HdoMeshGroupRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  defaultProfileId: string | null;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoMeshMembershipRow {
  id: string;
  meshGroupId: string;
  userId: string;
  role: HdoMeshMembershipRole;
  status: HdoMeshMembershipStatus;
  profileId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoNodeRow {
  id: string;
  name: string;
  kind: HdoNodeKind;
  publicHost: string | null;
  overlayIp: string | null;
  status: HdoNodeStatus;
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDeviceRow {
  id: string;
  userId: string;
  label: string;
  platform: string | null;
  publicKey: string | null;
  overlayIp: string | null;
  status: HdoDeviceStatus;
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDeviceMeshStateRow {
  id: string;
  meshGroupId: string;
  deviceId: string;
  userId: string;
  status: HdoDeviceMeshStateStatus;
  note: string | null;
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoServiceRow {
  id: string;
  name: string;
  nodeId: string | null;
  targetHost: string;
  targetPort: number;
  protocol: HdoServiceProtocol;
  domains: string[];
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoProfileRow {
  id: string;
  name: string;
  mode: HdoProfileMode;
  enabled: boolean;
  rules: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoRateLimitRow {
  id: string;
  subjectType: HdoRateLimitSubjectType;
  subjectId: string;
  downRate: string | null;
  downCeil: string | null;
  upRate: string | null;
  upCeil: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoSubscriptionArtifactRow {
  id: string;
  deviceId: string;
  kind: HdoArtifactKind;
  generation: number;
  checksum: string;
  content: string;
  contentType: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDevicePluginStateRow {
  id: string;
  deviceId: string;
  pluginId: string;
  npm: string | null;
  name: string | null;
  version: string | null;
  state: string;
  manifest: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HdoDeviceTaskRow {
  id: string;
  userId: string;
  deviceId: string | null;
  pluginId: string | null;
  kind: HdoDeviceTaskKind;
  status: HdoDeviceTaskStatus;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface HdoStore {
  getGeneration(): Promise<number>;
  bumpGeneration(): Promise<number>;
  listMeshGroups(): Promise<HdoMeshGroupRow[]>;
  upsertMeshGroup(input: {
    id?: string;
    name: string;
    slug: string;
    description?: string | null;
    defaultProfileId?: string | null;
    enabled?: boolean;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoMeshGroupRow>;
  listMeshMemberships(meshGroupId?: string): Promise<HdoMeshMembershipRow[]>;
  upsertMeshMembership(input: {
    id?: string;
    meshGroupId: string;
    userId: string;
    role?: HdoMeshMembershipRole;
    status?: HdoMeshMembershipStatus;
    profileId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoMeshMembershipRow>;
  listNodes(): Promise<HdoNodeRow[]>;
  upsertNode(input: {
    id?: string;
    name: string;
    kind: HdoNodeKind;
    publicHost?: string | null;
    overlayIp?: string | null;
    status?: HdoNodeStatus;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoNodeRow>;
  setNodeHeartbeat(
    id: string,
    input?: { status?: HdoNodeStatus; metadata?: Record<string, unknown> | null }
  ): Promise<HdoNodeRow | null>;
  listAllDevices(): Promise<HdoDeviceRow[]>;
  listDevicesForUser(userId: string): Promise<HdoDeviceRow[]>;
  findDevice(id: string): Promise<HdoDeviceRow | null>;
  upsertDevice(input: {
    id: string;
    userId: string;
    label: string;
    platform?: string | null;
    publicKey?: string | null;
    overlayIp?: string | null;
    status?: HdoDeviceStatus;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoDeviceRow>;
  listDeviceMeshStates(filter?: {
    meshGroupId?: string;
    deviceId?: string;
    userId?: string;
  }): Promise<HdoDeviceMeshStateRow[]>;
  upsertDeviceMeshState(input: {
    id?: string;
    meshGroupId: string;
    deviceId: string;
    userId: string;
    status?: HdoDeviceMeshStateStatus;
    note?: string | null;
    metadata?: Record<string, unknown> | null;
    lastSeenAt?: string | null;
    createdByUserId?: string | null;
  }): Promise<HdoDeviceMeshStateRow>;
  listServices(): Promise<HdoServiceRow[]>;
  upsertService(input: {
    id?: string;
    name: string;
    nodeId?: string | null;
    targetHost: string;
    targetPort: number;
    protocol?: HdoServiceProtocol;
    domains?: string[];
    enabled?: boolean;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoServiceRow>;
  listProfiles(): Promise<HdoProfileRow[]>;
  ensureDefaultProfiles(): Promise<HdoProfileRow[]>;
  upsertProfile(input: {
    id?: string;
    name: string;
    mode: HdoProfileMode;
    enabled?: boolean;
    rules?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoProfileRow>;
  listRateLimits(): Promise<HdoRateLimitRow[]>;
  upsertRateLimit(input: {
    id?: string;
    subjectType: HdoRateLimitSubjectType;
    subjectId: string;
    downRate?: string | null;
    downCeil?: string | null;
    upRate?: string | null;
    upCeil?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<HdoRateLimitRow>;
  latestArtifact(
    deviceId: string,
    kind: HdoArtifactKind
  ): Promise<HdoSubscriptionArtifactRow | null>;
  saveArtifact(input: {
    deviceId: string;
    kind: HdoArtifactKind;
    generation: number;
    checksum: string;
    content: string;
    contentType: string;
    expiresAt?: string | null;
  }): Promise<HdoSubscriptionArtifactRow>;
  listDevicePluginStates(deviceId?: string): Promise<HdoDevicePluginStateRow[]>;
  upsertDevicePluginStates(
    deviceId: string,
    plugins: Array<{
      pluginId: string;
      npm?: string | null;
      name?: string | null;
      version?: string | null;
      state: string;
      manifest?: Record<string, unknown> | null;
      health?: Record<string, unknown> | null;
    }>
  ): Promise<HdoDevicePluginStateRow[]>;
  listDeviceTasks(filter?: {
    userId?: string;
    deviceId?: string;
    status?: HdoDeviceTaskStatus;
  }): Promise<HdoDeviceTaskRow[]>;
  createDeviceTask(input: {
    userId: string;
    deviceId?: string | null;
    pluginId?: string | null;
    kind: HdoDeviceTaskKind;
    status?: HdoDeviceTaskStatus;
    payload?: Record<string, unknown> | null;
    createdByUserId?: string | null;
  }): Promise<HdoDeviceTaskRow>;
  claimDeviceTask(
    id: string,
    input: { deviceId?: string | null; result?: Record<string, unknown> | null }
  ): Promise<HdoDeviceTaskRow | null>;
  completeDeviceTask(
    id: string,
    input: { status: HdoDeviceTaskStatus; result?: Record<string, unknown> | null }
  ): Promise<HdoDeviceTaskRow | null>;
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
  gameScores: GameScoresStore;
  hdo: HdoStore;
  backend: 'json' | 'postgres';
  /** Best-effort close; harmless when called multiple times. */
  close(): Promise<void>;
}
