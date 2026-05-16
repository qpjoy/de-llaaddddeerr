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
  backend: 'postgres',
  async close() {
    await closePg();
  }
};
