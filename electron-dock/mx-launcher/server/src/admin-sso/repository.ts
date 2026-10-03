import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

export type SsoKind = 'admin-sso-transaction' | 'admin-sso-session' | 'admin-sso-binding';
export type SsoRecord = Record<string, unknown>;
export interface SsoRepository {
  insert(kind: SsoKind, id: string, data: SsoRecord): Promise<boolean>;
  read(kind: SsoKind, id: string): Promise<SsoRecord | null>;
  take(kind: SsoKind, id: string): Promise<SsoRecord | null>;
  remove(kind: SsoKind, id: string): Promise<void>;
  touchSession(id: string): Promise<SsoRecord | null>;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function bindingKey(issuer: string, subject: string): string {
  return digest(JSON.stringify([issuer, subject]));
}

/** Uses existing durable records and their composite PK; no changes to account
 * records or credentials. Consume and idle renewal are atomic across replicas. */
export class PostgresSsoRepository implements SsoRepository {
  private db: DataSource;
  private ready?: Promise<DataSource>;
  constructor(databaseUrl: string, private environment: string) {
    this.db = new DataSource({ type: 'postgres', url: databaseUrl,
      extra: { max: 3, connectionTimeoutMillis: 5000, statement_timeout: 5000 }, synchronize: false });
  }
  private async query(sql: string, parameters: unknown[]): Promise<Array<{ data: SsoRecord }>> {
    if (!this.ready) this.ready = this.db.initialize().catch((error) => { this.ready = undefined; throw error; });
    return (await this.ready).query(sql, parameters);
  }
  async close(): Promise<void> { if (this.db.isInitialized) await this.db.destroy(); }
  async insert(kind: SsoKind, id: string, data: SsoRecord): Promise<boolean> {
    // Expired transient records contain no tokens and are opportunistically
    // collected; persistent bindings are never included in this deletion.
    if (kind !== 'admin-sso-binding') await this.query(`DELETE FROM mx_platform_records
      WHERE environment = $1 AND kind IN ('admin-sso-transaction','admin-sso-session')
      AND data->>'expiresAt' <= $2`, [this.environment, new Date().toISOString()]);
    const rows = await this.query(`INSERT INTO mx_platform_records (kind,id,environment,site_id,data)
      VALUES ($1,$2,$3,NULL,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data`,
    [kind, id, this.environment, JSON.stringify(data)]);
    return rows.length === 1;
  }
  async read(kind: SsoKind, id: string): Promise<SsoRecord | null> {
    return (await this.query('SELECT data FROM mx_platform_records WHERE kind=$1 AND id=$2 AND environment=$3',
      [kind, id, this.environment]))[0]?.data ?? null;
  }
  async take(kind: SsoKind, id: string): Promise<SsoRecord | null> {
    return (await this.query('WITH removed AS (DELETE FROM mx_platform_records WHERE kind=$1 AND id=$2 AND environment=$3 RETURNING data) SELECT data FROM removed',
      [kind, id, this.environment]))[0]?.data ?? null;
  }
  async remove(kind: SsoKind, id: string): Promise<void> { await this.take(kind, id); }
  async touchSession(id: string): Promise<SsoRecord | null> {
    return (await this.query(`WITH touched AS (UPDATE mx_platform_records SET updated_at=now()
      WHERE kind='admin-sso-session' AND id=$1 AND environment=$2
        AND (data->>'expiresAt')::timestamptz > now() RETURNING data) SELECT data FROM touched`, [id, this.environment]))[0]?.data ?? null;
  }
}
