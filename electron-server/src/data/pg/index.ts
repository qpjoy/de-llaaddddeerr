/**
 * Postgres backend. Mirrors the JSON backend; same interface, same behavior.
 */
import { createHash } from 'node:crypto';

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
  HdoArtifactKind,
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
  UsersStore
} from '../storage-types.js';
import { closePg, getPool } from './pool.js';

function hashToken(plain: string): string {
  return 'sha256:' + createHash('sha256').update(plain).digest('hex');
}

function rowToUser(r: Record<string, unknown>): UserRow {
  return {
    id: String(r.id),
    username: r.username ? String(r.username) : null,
    email: r.email ? String(r.email) : null,
    phone: r.phone ? String(r.phone) : null,
    passwordHash: String(r.password_hash),
    role: String(r.role) as Role,
    displayName: r.display_name ? String(r.display_name) : null,
    emailVerifiedAt: r.email_verified_at ? new Date(String(r.email_verified_at)).toISOString() : null,
    phoneVerifiedAt: r.phone_verified_at ? new Date(String(r.phone_verified_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

const users: UsersStore = {
  async list() {
    const { rows } = await getPool().query(`SELECT * FROM users ORDER BY created_at ASC`);
    return rows.map(rowToUser);
  },
  async findById(id) {
    const { rows } = await getPool().query(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ? rowToUser(rows[0]) : null;
  },
  async findByIdentifier(identifier) {
    const lower = identifier.toLowerCase();
    const { rows } = await getPool().query(
      `SELECT * FROM users
       WHERE lower(username) = $1 OR lower(email) = $1 OR phone = $2
       LIMIT 1`,
      [lower, identifier]
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  },
  async insert(input) {
    const { rows } = await getPool().query(
      `INSERT INTO users (username, email, phone, password_hash, role, display_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.username,
        input.email,
        input.phone,
        input.passwordHash,
        input.role,
        input.displayName
      ]
    );
    return rowToUser(rows[0]);
  },
  async update(id, patch) {
    // Build a dynamic SET clause for the fields actually supplied.
    const allowed: Array<[keyof typeof patch, string]> = [
      ['username', 'username'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['passwordHash', 'password_hash'],
      ['role', 'role'],
      ['displayName', 'display_name'],
      ['emailVerifiedAt', 'email_verified_at'],
      ['phoneVerifiedAt', 'phone_verified_at']
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, col] of allowed) {
      if (patch[k] !== undefined) {
        params.push(patch[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length === 0) return this.findById(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    const { rows } = await getPool().query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  },
  async setRole(id, role: Role) {
    return this.update(id, { role });
  },
  async count() {
    const { rows } = await getPool().query<{ count: string }>(`SELECT count(*) FROM users`);
    return Number(rows[0].count);
  }
};

const refresh: RefreshStore = {
  async insert(input) {
    const tokenHash = hashToken(input.plain);
    const { rows } = await getPool().query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, device_label, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.id, input.userId, tokenHash, input.deviceLabel ?? null, input.expiresAt.toISOString()]
    );
    const r = rows[0];
    return {
      id: String(r.id),
      userId: String(r.user_id),
      tokenHash: String(r.token_hash),
      deviceLabel: r.device_label ? String(r.device_label) : null,
      expiresAt: new Date(String(r.expires_at)).toISOString(),
      revokedAt: r.revoked_at ? new Date(String(r.revoked_at)).toISOString() : null,
      createdAt: new Date(String(r.created_at)).toISOString()
    };
  },
  async findByPlain(plain) {
    const hash = hashToken(plain);
    const { rows } = await getPool().query(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
      [hash]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      userId: String(r.user_id),
      tokenHash: String(r.token_hash),
      deviceLabel: r.device_label ? String(r.device_label) : null,
      expiresAt: new Date(String(r.expires_at)).toISOString(),
      revokedAt: r.revoked_at ? new Date(String(r.revoked_at)).toISOString() : null,
      createdAt: new Date(String(r.created_at)).toISOString()
    };
  },
  async revoke(id) {
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
  },
  async revokeAllForUser(userId) {
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  },
  async cleanup() {
    const { rowCount } = await getPool().query(
      `DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at IS NOT NULL`
    );
    return rowCount ?? 0;
  }
};

const entitlements: EntitlementsStore = {
  async forUser(userId) {
    const { rows } = await getPool().query(
      `SELECT * FROM entitlements
       WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [userId]
    );
    return rows.map(rowToEntitlement);
  },
  async forUserAndPlugin(userId, pluginId) {
    const { rows } = await getPool().query(
      `SELECT * FROM entitlements
       WHERE user_id = $1 AND plugin_id = $2
         AND (expires_at IS NULL OR expires_at > now())
       LIMIT 1`,
      [userId, pluginId]
    );
    return rows[0] ? rowToEntitlement(rows[0]) : null;
  },
  async grant(input) {
    const { rows } = await getPool().query(
      `INSERT INTO entitlements (user_id, plugin_id, kind, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, plugin_id) DO UPDATE
         SET kind = excluded.kind, expires_at = excluded.expires_at
       RETURNING *`,
      [input.userId, input.pluginId, input.kind, input.expiresAt ?? null]
    );
    return rowToEntitlement(rows[0]);
  }
};

function rowToEntitlement(r: Record<string, unknown>): EntitlementRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    pluginId: String(r.plugin_id),
    kind: String(r.kind) as EntitlementRow['kind'],
    grantedAt: new Date(String(r.granted_at)).toISOString(),
    expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null
  };
}

const codes: CodesStore = {
  async issue(input) {
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
    const { rows } = await getPool().query(
      `INSERT INTO verification_codes (channel, destination, code, purpose, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.channel, input.destination, input.code, input.purpose, expiresAt]
    );
    return rowToCode(rows[0]);
  },
  async consume(input) {
    const { rows } = await getPool().query(
      `UPDATE verification_codes
         SET consumed_at = now()
       WHERE channel = $1 AND destination = $2 AND code = $3 AND purpose = $4
         AND consumed_at IS NULL AND expires_at > now()
       RETURNING *`,
      [input.channel, input.destination, input.code, input.purpose]
    );
    return rows[0] ? rowToCode(rows[0]) : null;
  }
};

function rowToCode(r: Record<string, unknown>): VerificationCodeRow {
  return {
    id: String(r.id),
    channel: String(r.channel) as VerificationCodeRow['channel'],
    destination: String(r.destination),
    code: String(r.code),
    purpose: String(r.purpose) as VerificationCodeRow['purpose'],
    expiresAt: new Date(String(r.expires_at)).toISOString(),
    consumedAt: r.consumed_at ? new Date(String(r.consumed_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString()
  };
}

const audit: AuditStore = {
  async insert(input) {
    const { rows } = await getPool().query(
      `INSERT INTO audit_logs (actor_user_id, actor_ip, action, target_kind, target_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.actorUserId ?? null,
        input.actorIp ?? null,
        input.action,
        input.targetKind ?? null,
        input.targetId ?? null,
        input.meta ?? null
      ]
    );
    return rowToAudit(rows[0]);
  },
  async query(opts = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.actorUserId) {
      params.push(opts.actorUserId);
      where.push(`actor_user_id = $${params.length}`);
    }
    if (opts.action) {
      params.push(opts.action);
      where.push(`action = $${params.length}`);
    }
    if (opts.targetId) {
      params.push(opts.targetId);
      where.push(`target_id = $${params.length}`);
    }
    if (typeof opts.before === 'number') {
      params.push(opts.before);
      where.push(`id < $${params.length}`);
    }
    params.push(opts.limit ?? 100);
    const sql =
      `SELECT * FROM audit_logs` +
      (where.length ? ` WHERE ` + where.join(' AND ') : '') +
      ` ORDER BY id DESC LIMIT $${params.length}`;
    const { rows } = await getPool().query(sql, params);
    return rows.map(rowToAudit);
  }
};

const gameScores: GameScoresStore = {
  async submit(input) {
    const { rows } = await getPool().query(
      `INSERT INTO game_high_scores (
         game_id,
         plugin_id,
         mode,
         user_id,
         player_name,
         best_score,
         best_elapsed_seconds,
         rounds,
         metadata,
         completed_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, now())
       ON CONFLICT (game_id, mode, user_id) DO UPDATE SET
         plugin_id = excluded.plugin_id,
         player_name = excluded.player_name,
         rounds = game_high_scores.rounds + 1,
         best_score = CASE
           WHEN excluded.best_score > game_high_scores.best_score
             OR (
               excluded.best_score = game_high_scores.best_score
               AND excluded.best_elapsed_seconds < game_high_scores.best_elapsed_seconds
             )
           THEN excluded.best_score
           ELSE game_high_scores.best_score
         END,
         best_elapsed_seconds = CASE
           WHEN excluded.best_score > game_high_scores.best_score
             OR (
               excluded.best_score = game_high_scores.best_score
               AND excluded.best_elapsed_seconds < game_high_scores.best_elapsed_seconds
             )
           THEN excluded.best_elapsed_seconds
           ELSE game_high_scores.best_elapsed_seconds
         END,
         completed_at = CASE
           WHEN excluded.best_score > game_high_scores.best_score
             OR (
               excluded.best_score = game_high_scores.best_score
               AND excluded.best_elapsed_seconds < game_high_scores.best_elapsed_seconds
             )
           THEN excluded.completed_at
           ELSE game_high_scores.completed_at
         END,
         metadata = CASE
           WHEN excluded.best_score > game_high_scores.best_score
             OR (
               excluded.best_score = game_high_scores.best_score
               AND excluded.best_elapsed_seconds < game_high_scores.best_elapsed_seconds
             )
           THEN excluded.metadata
           ELSE game_high_scores.metadata
         END,
         updated_at = now()
       RETURNING *`,
      [
        input.gameId,
        input.pluginId,
        input.mode,
        input.userId,
        input.playerName,
        input.score,
        input.elapsedSeconds,
        input.metadata ?? null,
        input.completedAt
      ]
    );
    return rowToGameScore(rows[0]);
  },
  async leaderboard(opts) {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100);
    const { rows } = await getPool().query(
      `SELECT *
       FROM game_high_scores
       WHERE game_id = $1 AND mode = $2
       ORDER BY best_score DESC, best_elapsed_seconds ASC, completed_at ASC
       LIMIT $3`,
      [opts.gameId, opts.mode, limit]
    );
    return rows.map((row, index) => ({ ...rowToGameScore(row), rank: index + 1 }));
  }
};

function rowToGameScore(r: Record<string, unknown>): GameHighScoreRow {
  return {
    userId: String(r.user_id),
    playerName: String(r.player_name),
    gameId: String(r.game_id),
    pluginId: String(r.plugin_id),
    mode: String(r.mode),
    bestScore: Number(r.best_score),
    bestElapsedSeconds: Number(r.best_elapsed_seconds),
    rounds: Number(r.rounds),
    completedAt: new Date(String(r.completed_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
    metadata: (r.metadata as Record<string, unknown> | null) ?? null
  };
}

const hdo: HdoStore = {
  async getGeneration() {
    const { rows } = await getPool().query<{ generation: string }>(
      `SELECT generation FROM hdo_control_state WHERE id = 1`
    );
    return Number(rows[0]?.generation ?? 1);
  },
  async bumpGeneration() {
    const { rows } = await getPool().query<{ generation: string }>(
      `UPDATE hdo_control_state
         SET generation = generation + 1, updated_at = now()
       WHERE id = 1
       RETURNING generation`
    );
    return Number(rows[0].generation);
  },
  async listMeshGroups() {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_mesh_groups ORDER BY enabled DESC, name ASC`
    );
    return rows.map(rowToHdoMeshGroup);
  },
  async upsertMeshGroup(input) {
    const params = [
      input.name,
      input.slug,
      input.description ?? null,
      input.defaultProfileId ?? null,
      input.enabled ?? true,
      input.metadata ?? null
    ];
    const { rows } = input.id
      ? await getPool().query(
          `INSERT INTO hdo_mesh_groups (
             id, name, slug, description, default_profile_id, enabled, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             slug = excluded.slug,
             description = excluded.description,
             default_profile_id = excluded.default_profile_id,
             enabled = excluded.enabled,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          [input.id, ...params]
        )
      : await getPool().query(
          `INSERT INTO hdo_mesh_groups (
             name, slug, description, default_profile_id, enabled, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (slug) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             default_profile_id = excluded.default_profile_id,
             enabled = excluded.enabled,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          params
        );
    await hdo.bumpGeneration();
    return rowToHdoMeshGroup(rows[0]);
  },
  async listMeshMemberships(meshGroupId) {
    const { rows } = meshGroupId
      ? await getPool().query(
          `SELECT * FROM hdo_mesh_memberships
           WHERE mesh_group_id = $1
           ORDER BY updated_at DESC`,
          [meshGroupId]
        )
      : await getPool().query(
          `SELECT * FROM hdo_mesh_memberships ORDER BY updated_at DESC`
        );
    return rows.map(rowToHdoMeshMembership);
  },
  async upsertMeshMembership(input) {
    const params = [
      input.meshGroupId,
      input.userId,
      input.role ?? 'member',
      input.status ?? 'active',
      input.profileId ?? null,
      input.metadata ?? null
    ];
    const { rows } = input.id
      ? await getPool().query(
          `INSERT INTO hdo_mesh_memberships (
             id, mesh_group_id, user_id, role, status, profile_id, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             mesh_group_id = excluded.mesh_group_id,
             user_id = excluded.user_id,
             role = excluded.role,
             status = excluded.status,
             profile_id = excluded.profile_id,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          [input.id, ...params]
        )
      : await getPool().query(
          `INSERT INTO hdo_mesh_memberships (
             mesh_group_id, user_id, role, status, profile_id, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (mesh_group_id, user_id) DO UPDATE SET
             role = excluded.role,
             status = excluded.status,
             profile_id = excluded.profile_id,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          params
        );
    await hdo.bumpGeneration();
    return rowToHdoMeshMembership(rows[0]);
  },
  async listNodes() {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_nodes ORDER BY kind ASC, name ASC`
    );
    return rows.map(rowToHdoNode);
  },
  async upsertNode(input) {
    const { rows } = input.id
      ? await getPool().query(
          `INSERT INTO hdo_nodes (id, name, kind, public_host, overlay_ip, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             kind = excluded.kind,
             public_host = excluded.public_host,
             overlay_ip = excluded.overlay_ip,
             status = excluded.status,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          [
            input.id,
            input.name,
            input.kind,
            input.publicHost ?? null,
            input.overlayIp ?? null,
            input.status ?? 'pending',
            input.metadata ?? null
          ]
        )
      : await getPool().query(
          `INSERT INTO hdo_nodes (name, kind, public_host, overlay_ip, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            input.name,
            input.kind,
            input.publicHost ?? null,
            input.overlayIp ?? null,
            input.status ?? 'pending',
            input.metadata ?? null
          ]
        );
    await hdo.bumpGeneration();
    return rowToHdoNode(rows[0]);
  },
  async setNodeHeartbeat(id, input = {}) {
    const { rows } = await getPool().query(
      `UPDATE hdo_nodes
         SET status = $2,
             metadata = COALESCE($3::jsonb, metadata),
             last_seen_at = now(),
             updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.status ?? 'online', input.metadata ?? null]
    );
    return rows[0] ? rowToHdoNode(rows[0]) : null;
  },
  async listAllDevices() {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_devices ORDER BY updated_at DESC`
    );
    return rows.map(rowToHdoDevice);
  },
  async listDevicesForUser(userId) {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_devices WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId]
    );
    return rows.map(rowToHdoDevice);
  },
  async findDevice(id) {
    const { rows } = await getPool().query(`SELECT * FROM hdo_devices WHERE id = $1`, [id]);
    return rows[0] ? rowToHdoDevice(rows[0]) : null;
  },
  async upsertDevice(input) {
    const { rows } = await getPool().query(
      `INSERT INTO hdo_devices (
         id, user_id, label, platform, public_key, overlay_ip, status, metadata, last_seen_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (id) DO UPDATE SET
         user_id = excluded.user_id,
         label = excluded.label,
         platform = excluded.platform,
         public_key = excluded.public_key,
         overlay_ip = excluded.overlay_ip,
         status = excluded.status,
         metadata = excluded.metadata,
         last_seen_at = now(),
         updated_at = now()
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.label,
        input.platform ?? null,
        input.publicKey ?? null,
        input.overlayIp ?? null,
        input.status ?? 'online',
        input.metadata ?? null
      ]
    );
    await hdo.bumpGeneration();
    return rowToHdoDevice(rows[0]);
  },
  async listServices() {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_services ORDER BY enabled DESC, name ASC`
    );
    return rows.map(rowToHdoService);
  },
  async upsertService(input) {
    const params = [
      input.name,
      input.nodeId ?? null,
      input.targetHost,
      input.targetPort,
      input.protocol ?? 'tcp',
      input.domains ?? [],
      input.enabled ?? true,
      input.metadata ?? null
    ];
    const { rows } = input.id
      ? await getPool().query(
          `INSERT INTO hdo_services (
             id, name, node_id, target_host, target_port, protocol, domains, enabled, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             node_id = excluded.node_id,
             target_host = excluded.target_host,
             target_port = excluded.target_port,
             protocol = excluded.protocol,
             domains = excluded.domains,
             enabled = excluded.enabled,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          [input.id, ...params]
        )
      : await getPool().query(
          `INSERT INTO hdo_services (
             name, node_id, target_host, target_port, protocol, domains, enabled, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (name) DO UPDATE SET
             node_id = excluded.node_id,
             target_host = excluded.target_host,
             target_port = excluded.target_port,
             protocol = excluded.protocol,
             domains = excluded.domains,
             enabled = excluded.enabled,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          params
        );
    await hdo.bumpGeneration();
    return rowToHdoService(rows[0]);
  },
  async listProfiles() {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_profiles ORDER BY name ASC`
    );
    return rows.map(rowToHdoProfile);
  },
  async ensureDefaultProfiles() {
    let changed = false;
    for (const profile of defaultHdoProfiles()) {
      const result = await getPool().query(
        `INSERT INTO hdo_profiles (name, mode, enabled, rules, metadata)
         VALUES ($1, $2, true, $3, NULL)
         ON CONFLICT (name) DO NOTHING`,
        [profile.name, profile.mode, profile.rules]
      );
      if ((result.rowCount ?? 0) > 0) changed = true;
    }
    if (changed) await hdo.bumpGeneration();
    return this.listProfiles();
  },
  async upsertProfile(input) {
    const params = [
      input.name,
      input.mode,
      input.enabled ?? true,
      input.rules ?? null,
      input.metadata ?? null
    ];
    const { rows } = input.id
      ? await getPool().query(
          `INSERT INTO hdo_profiles (id, name, mode, enabled, rules, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             mode = excluded.mode,
             enabled = excluded.enabled,
             rules = excluded.rules,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          [input.id, ...params]
        )
      : await getPool().query(
          `INSERT INTO hdo_profiles (name, mode, enabled, rules, metadata)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET
             mode = excluded.mode,
             enabled = excluded.enabled,
             rules = excluded.rules,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          params
        );
    await hdo.bumpGeneration();
    return rowToHdoProfile(rows[0]);
  },
  async listRateLimits() {
    const { rows } = await getPool().query(
      `SELECT * FROM hdo_rate_limits ORDER BY subject_type ASC, subject_id ASC`
    );
    return rows.map(rowToHdoRateLimit);
  },
  async upsertRateLimit(input) {
    const params = [
      input.subjectType,
      input.subjectId,
      input.downRate ?? null,
      input.downCeil ?? null,
      input.upRate ?? null,
      input.upCeil ?? null,
      input.metadata ?? null
    ];
    const { rows } = input.id
      ? await getPool().query(
          `INSERT INTO hdo_rate_limits (
             id, subject_type, subject_id, down_rate, down_ceil, up_rate, up_ceil, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             subject_type = excluded.subject_type,
             subject_id = excluded.subject_id,
             down_rate = excluded.down_rate,
             down_ceil = excluded.down_ceil,
             up_rate = excluded.up_rate,
             up_ceil = excluded.up_ceil,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          [input.id, ...params]
        )
      : await getPool().query(
          `INSERT INTO hdo_rate_limits (
             subject_type, subject_id, down_rate, down_ceil, up_rate, up_ceil, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (subject_type, subject_id) DO UPDATE SET
             down_rate = excluded.down_rate,
             down_ceil = excluded.down_ceil,
             up_rate = excluded.up_rate,
             up_ceil = excluded.up_ceil,
             metadata = excluded.metadata,
             updated_at = now()
           RETURNING *`,
          params
        );
    await hdo.bumpGeneration();
    return rowToHdoRateLimit(rows[0]);
  },
  async latestArtifact(deviceId, kind) {
    const { rows } = await getPool().query(
      `SELECT *
       FROM hdo_subscription_artifacts
       WHERE device_id = $1 AND kind = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [deviceId, kind]
    );
    return rows[0] ? rowToHdoArtifact(rows[0]) : null;
  },
  async saveArtifact(input) {
    const { rows } = await getPool().query(
      `INSERT INTO hdo_subscription_artifacts (
         device_id, kind, generation, checksum, content, content_type, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (device_id, kind) DO UPDATE SET
         generation = excluded.generation,
         checksum = excluded.checksum,
         content = excluded.content,
         content_type = excluded.content_type,
         expires_at = excluded.expires_at,
         updated_at = now()
       RETURNING *`,
      [
        input.deviceId,
        input.kind,
        input.generation,
        input.checksum,
        input.content,
        input.contentType,
        input.expiresAt ?? null
      ]
    );
    return rowToHdoArtifact(rows[0]);
  },
  async listDevicePluginStates(deviceId) {
    const { rows } = deviceId
      ? await getPool().query(
          `SELECT * FROM hdo_device_plugin_states
           WHERE device_id = $1
           ORDER BY plugin_id ASC`,
          [deviceId]
        )
      : await getPool().query(
          `SELECT * FROM hdo_device_plugin_states ORDER BY updated_at DESC`
        );
    return rows.map(rowToHdoDevicePluginState);
  },
  async upsertDevicePluginStates(deviceId, plugins) {
    const out: HdoDevicePluginStateRow[] = [];
    for (const plugin of plugins) {
      const { rows } = await getPool().query(
        `INSERT INTO hdo_device_plugin_states (
           device_id, plugin_id, npm, name, version, state, manifest, health, last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (device_id, plugin_id) DO UPDATE SET
           npm = excluded.npm,
           name = excluded.name,
           version = excluded.version,
           state = excluded.state,
           manifest = excluded.manifest,
           health = excluded.health,
           last_seen_at = now(),
           updated_at = now()
         RETURNING *`,
        [
          deviceId,
          plugin.pluginId,
          plugin.npm ?? null,
          plugin.name ?? null,
          plugin.version ?? null,
          plugin.state,
          plugin.manifest ?? null,
          plugin.health ?? null
        ]
      );
      out.push(rowToHdoDevicePluginState(rows[0]));
    }
    return out;
  },
  async listDeviceTasks(filter = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.userId) {
      params.push(filter.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (filter.deviceId) {
      params.push(filter.deviceId);
      where.push(`device_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const sql = `SELECT * FROM hdo_device_tasks${
      where.length ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY created_at DESC`;
    const { rows } = await getPool().query(sql, params);
    return rows.map(rowToHdoDeviceTask);
  },
  async createDeviceTask(input) {
    const { rows } = await getPool().query(
      `INSERT INTO hdo_device_tasks (
         user_id, device_id, plugin_id, kind, status, payload, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.userId,
        input.deviceId ?? null,
        input.pluginId ?? null,
        input.kind,
        input.status ?? 'pending',
        input.payload ?? null,
        input.createdByUserId ?? null
      ]
    );
    return rowToHdoDeviceTask(rows[0]);
  },
  async claimDeviceTask(id, input) {
    const { rows } = await getPool().query(
      `UPDATE hdo_device_tasks
         SET status = 'claimed',
             device_id = COALESCE(device_id, $2),
             result = COALESCE($3::jsonb, result),
             updated_at = now(),
             completed_at = NULL
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, input.deviceId ?? null, input.result ?? null]
    );
    return rows[0] ? rowToHdoDeviceTask(rows[0]) : null;
  },
  async completeDeviceTask(id, input) {
    const { rows } = await getPool().query(
      `UPDATE hdo_device_tasks
         SET status = $2,
             result = $3,
             updated_at = now(),
             completed_at = CASE
               WHEN $2 IN ('done', 'failed', 'cancelled') THEN now()
               ELSE completed_at
             END
       WHERE id = $1
       RETURNING *`,
      [id, input.status, input.result ?? null]
    );
    return rows[0] ? rowToHdoDeviceTask(rows[0]) : null;
  }
};

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

function rowToHdoMeshGroup(r: Record<string, unknown>): HdoMeshGroupRow {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    description: r.description ? String(r.description) : null,
    defaultProfileId: r.default_profile_id ? String(r.default_profile_id) : null,
    enabled: Boolean(r.enabled),
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoMeshMembership(r: Record<string, unknown>): HdoMeshMembershipRow {
  return {
    id: String(r.id),
    meshGroupId: String(r.mesh_group_id),
    userId: String(r.user_id),
    role: String(r.role) as HdoMeshMembershipRole,
    status: String(r.status) as HdoMeshMembershipStatus,
    profileId: r.profile_id ? String(r.profile_id) : null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoNode(r: Record<string, unknown>): HdoNodeRow {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: String(r.kind) as HdoNodeKind,
    publicHost: r.public_host ? String(r.public_host) : null,
    overlayIp: r.overlay_ip ? String(r.overlay_ip) : null,
    status: String(r.status) as HdoNodeStatus,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    lastSeenAt: r.last_seen_at ? new Date(String(r.last_seen_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoDevice(r: Record<string, unknown>): HdoDeviceRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    label: String(r.label),
    platform: r.platform ? String(r.platform) : null,
    publicKey: r.public_key ? String(r.public_key) : null,
    overlayIp: r.overlay_ip ? String(r.overlay_ip) : null,
    status: String(r.status) as HdoDeviceStatus,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    lastSeenAt: r.last_seen_at ? new Date(String(r.last_seen_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoService(r: Record<string, unknown>): HdoServiceRow {
  return {
    id: String(r.id),
    name: String(r.name),
    nodeId: r.node_id ? String(r.node_id) : null,
    targetHost: String(r.target_host),
    targetPort: Number(r.target_port),
    protocol: String(r.protocol) as HdoServiceProtocol,
    domains: Array.isArray(r.domains) ? r.domains.map(String) : [],
    enabled: Boolean(r.enabled),
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoProfile(r: Record<string, unknown>): HdoProfileRow {
  return {
    id: String(r.id),
    name: String(r.name),
    mode: String(r.mode) as HdoProfileMode,
    enabled: Boolean(r.enabled),
    rules: (r.rules as Record<string, unknown> | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoRateLimit(r: Record<string, unknown>): HdoRateLimitRow {
  return {
    id: String(r.id),
    subjectType: String(r.subject_type) as HdoRateLimitRow['subjectType'],
    subjectId: String(r.subject_id),
    downRate: r.down_rate ? String(r.down_rate) : null,
    downCeil: r.down_ceil ? String(r.down_ceil) : null,
    upRate: r.up_rate ? String(r.up_rate) : null,
    upCeil: r.up_ceil ? String(r.up_ceil) : null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoArtifact(r: Record<string, unknown>): HdoSubscriptionArtifactRow {
  return {
    id: String(r.id),
    deviceId: String(r.device_id),
    kind: String(r.kind) as HdoArtifactKind,
    generation: Number(r.generation),
    checksum: String(r.checksum),
    content: String(r.content),
    contentType: String(r.content_type),
    expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoDevicePluginState(r: Record<string, unknown>): HdoDevicePluginStateRow {
  return {
    id: String(r.id),
    deviceId: String(r.device_id),
    pluginId: String(r.plugin_id),
    npm: r.npm ? String(r.npm) : null,
    name: r.name ? String(r.name) : null,
    version: r.version ? String(r.version) : null,
    state: String(r.state),
    manifest: (r.manifest as Record<string, unknown> | null) ?? null,
    health: (r.health as Record<string, unknown> | null) ?? null,
    lastSeenAt: new Date(String(r.last_seen_at)).toISOString(),
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  };
}

function rowToHdoDeviceTask(r: Record<string, unknown>): HdoDeviceTaskRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    deviceId: r.device_id ? String(r.device_id) : null,
    pluginId: r.plugin_id ? String(r.plugin_id) : null,
    kind: String(r.kind) as HdoDeviceTaskKind,
    status: String(r.status) as HdoDeviceTaskStatus,
    payload: (r.payload as Record<string, unknown> | null) ?? null,
    result: (r.result as Record<string, unknown> | null) ?? null,
    createdByUserId: r.created_by_user_id ? String(r.created_by_user_id) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
    completedAt: r.completed_at ? new Date(String(r.completed_at)).toISOString() : null
  };
}

function rowToAudit(r: Record<string, unknown>): AuditEntry {
  return {
    id: Number(r.id),
    actorUserId: r.actor_user_id ? String(r.actor_user_id) : null,
    actorIp: r.actor_ip ? String(r.actor_ip) : null,
    action: String(r.action),
    targetKind: r.target_kind ? String(r.target_kind) : null,
    targetId: r.target_id ? String(r.target_id) : null,
    meta: (r.meta as Record<string, unknown> | null) ?? null,
    createdAt: new Date(String(r.created_at)).toISOString()
  };
}

export const pgStorage: Storage = {
  users,
  refresh,
  entitlements,
  codes,
  audit,
  gameScores,
  hdo,
  backend: 'postgres',
  async close() {
    await closePg();
  }
};
