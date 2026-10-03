import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { AdapterPayload } from 'oidc-provider';
import { createUserCenterUserCredential, resolveUserCenterUserForLogin, verifyUserCenterCredential } from '../store/domain.js';
import type { UserCenterUser, UserCenterUserCredential } from '../types.js';

const dummy = createUserCenterUserCredential('identity-timing-placeholder', 'not-a-login-password');
const bootstrap = new Set(['usr_demo_admin', 'usr_demo_user']);
export interface IdentityAccounts {
  account(id: string): Promise<UserCenterUser | undefined>;
  authenticate(login: string, password: string): Promise<UserCenterUser | undefined>;
  allowAttempt(ip: string, login: string): Promise<boolean>;
  allowRegistrationAttempt?(ip: string, login: string): Promise<boolean>;
}

/** Separate pool and tables. Existing user/credential records are read-only:
 * Launcher remains their only writer, including password changes and bans. */
export class IdentityRepository implements IdentityAccounts {
  private db: DataSource;
  constructor(url: string, private environment: string, private scope: string, private rateKey: string) {
    this.db = new DataSource({ type: 'postgres', url, synchronize: false,
      extra: { max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 } });
  }
  async initialize() {
    await this.db.initialize();
    await this.db.transaction(async manager => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext('mx-identity-schema-v1'))");
      await manager.query(`CREATE TABLE IF NOT EXISTS mx_identity_records (
        scope text NOT NULL, kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
        expires_at timestamptz NOT NULL, consumed bigint,
        PRIMARY KEY (scope,kind,id))`);
      await manager.query('CREATE INDEX IF NOT EXISTS mx_identity_expiry ON mx_identity_records (scope,expires_at)');
      for (const field of ['grantId', 'uid', 'userCode']) {
        await manager.query(`CREATE INDEX IF NOT EXISTS mx_identity_${field.toLowerCase()} ON mx_identity_records (scope,kind,(data->>'${field}'))`);
      }
    });
  }
  async close() { if (this.db.isInitialized) await this.db.destroy(); }
  async ready() { await this.db.query('SELECT 1'); }
  async cleanup() { await this.db.query('DELETE FROM mx_identity_records WHERE scope=$1 AND expires_at <= now()', [this.scope]); }
  adapter(kind: string) {
    const query = (sql: string, values: unknown[]) => this.db.query(sql, values);
    const scope = this.scope;
    const find = async (field: 'id' | 'uid' | 'userCode', value: string): Promise<AdapterPayload | undefined> => {
      const column = field === 'id' ? 'id' : `data->>'${field}'`;
      const rows = await query(`SELECT data,consumed FROM mx_identity_records WHERE scope=$1 AND kind=$2 AND ${column}=$3 AND expires_at>now()`, [scope, kind, value]);
      if (rows.length !== 1) return undefined;
      return { ...rows[0].data, ...(rows[0].consumed ? { consumed: Number(rows[0].consumed) } : {}) };
    };
    return {
      async upsert(id: string, data: AdapterPayload, expiresIn: number) {
        if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Identity record requires a bounded lifetime');
        await query(`INSERT INTO mx_identity_records (scope,kind,id,data,expires_at) VALUES ($1,$2,$3,$4,now()+$5*interval '1 second')
          ON CONFLICT (scope,kind,id) DO UPDATE SET data=EXCLUDED.data,expires_at=EXCLUDED.expires_at`, [scope, kind, id, data, expiresIn]);
      },
      find: (id: string) => find('id', id),
      findByUid: (uid: string) => find('uid', uid),
      findByUserCode: (code: string) => find('userCode', code),
      async consume(id: string) {
        const rows = await query(`WITH consumed_record AS (UPDATE mx_identity_records SET consumed=extract(epoch FROM now())::bigint
          WHERE scope=$1 AND kind=$2 AND id=$3 AND consumed IS NULL AND expires_at>now() RETURNING id) SELECT id FROM consumed_record`, [scope, kind, id]);
        // A racing code redemption must not mint a second token.
        if (rows.length !== 1) throw new Error('Identity record already consumed or expired');
      },
      async destroy(id: string) { await query('DELETE FROM mx_identity_records WHERE scope=$1 AND kind=$2 AND id=$3', [scope, kind, id]); },
      // The provider invokes this once per token model. An Interaction may
      // carry the old grant while switching accounts and must survive logout.
      async revokeByGrantId(id: string) { await query("DELETE FROM mx_identity_records WHERE scope=$1 AND kind=$2 AND data->>'grantId'=$3", [scope, kind, id]); }
    };
  }
  async account(id: string) {
    const rows = await this.db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user' AND id=$2", [this.environment, id]);
    const user = rows[0]?.data as UserCenterUser | undefined;
    return user?.status === 'active' && !bootstrap.has(user.userId) ? user : undefined;
  }
  async authenticate(login: string, password: string) {
    const rows = await this.db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user'", [this.environment]);
    const user = resolveUserCenterUserForLogin(rows.map((row: { data: UserCenterUser }) => row.data), login);
    const credentials = user ? await this.db.query("SELECT data FROM mx_platform_records WHERE environment=$1 AND kind='iam-user-credential' AND id=$2", [this.environment, user.userId]) : [];
    const credential = credentials[0]?.data as UserCenterUserCredential | undefined;
    const verified = verifyUserCenterCredential(password, credential ?? dummy);
    return verified && credential && user?.status === 'active' && !bootstrap.has(user.userId) ? user : undefined;
  }
  async allowAttempt(ip: string, login: string) {
    const window = Math.floor(Date.now() / 300_000);
    for (const [key, limit] of [[`ip:${ip}`, 30], [`login:${login}`, 8]] as const) {
      const id = createHmac('sha256', this.rateKey).update(`${window}:${key}`).digest('hex');
      const rows = await this.db.query(`INSERT INTO mx_identity_records (scope,kind,id,data,expires_at)
        VALUES ($1,'RateLimit',$2,'{"count":1}',now()+interval '10 minutes')
        ON CONFLICT (scope,kind,id) DO UPDATE SET data=jsonb_build_object('count',(mx_identity_records.data->>'count')::int+1)
        RETURNING (data->>'count')::int AS count`, [this.scope, id]);
      if (rows[0].count > limit) return false;
    }
    return true;
  }
  async allowRegistrationAttempt(ip: string, login: string) {
    // Independent budgets: signup cannot consume existing password login limits.
    return this.allowAttempt(`signup:${ip}`, `signup:${login.trim().toLowerCase()}`);
  }
}
