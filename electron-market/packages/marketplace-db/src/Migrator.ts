import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

import type { SchemaMigrationRow } from './types';

export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

export interface MigrationStatus {
  current: number;
  available: number;
  pending: Migration[];
  applied: SchemaMigrationRow[];
}

export interface ValidationReport {
  ok: boolean;
  issues: Array<{ version: number; reason: string }>;
}

/**
 * Forward / backward SQLite schema migrator.
 *
 * Design notes:
 *   - `schema_migrations` is auto-created on the first call so the migrator
 *     can boot a brand-new DB.
 *   - Each migration's `up` SQL is hashed (sha256) when applied; on later
 *     boots we re-hash the in-memory migration and compare with the stored
 *     checksum. Drift means "someone changed an old migration" — refuse
 *     to run (forcing the developer to fix it intentionally).
 *   - Remote migrations (from electron-server / CDN) can be appended at
 *     runtime via `register()` — the migrator treats them the same as
 *     bundled ones.
 *   - All migrations run inside a single SQLite transaction so a half-
 *     applied migration can't corrupt the schema.
 */
export class Migrator {
  private readonly migrations = new Map<number, Migration>();

  constructor(private readonly db: Database.Database, initial: Migration[] = []) {
    this.ensureTrackingTable();
    for (const m of initial) this.register(m);
  }

  /** Add a migration to the in-memory list. Idempotent on identical content. */
  register(migration: Migration): void {
    const existing = this.migrations.get(migration.version);
    if (existing) {
      if (existing.up !== migration.up) {
        throw new Error(
          `Migration ${migration.version} re-registered with a different body.`
        );
      }
      return;
    }
    this.migrations.set(migration.version, migration);
  }

  status(): MigrationStatus {
    const applied = this.appliedList();
    const current = applied.length > 0 ? Math.max(...applied.map((a) => a.version)) : 0;
    const all = this.sortedMigrations();
    const available = all.length > 0 ? all[all.length - 1].version : 0;
    const pending = all.filter((m) => m.version > current);
    return { current, available, pending, applied };
  }

  /**
   * Apply all pending migrations up to `target` (default: latest registered).
   * Returns the list of migrations actually applied this call.
   */
  up(target?: number): Migration[] {
    const validation = this.validate();
    if (!validation.ok) {
      const summary = validation.issues
        .map((i) => `v${i.version}: ${i.reason}`)
        .join('; ');
      throw new Error(`Cannot migrate — schema drift detected (${summary})`);
    }

    const all = this.sortedMigrations();
    const head = target ?? (all.length > 0 ? all[all.length - 1].version : 0);
    const { current } = this.status();
    const toApply = all.filter((m) => m.version > current && m.version <= head);
    if (toApply.length === 0) return [];

    const applyOne = this.db.transaction((m: Migration) => {
      this.db.exec(m.up);
      this.db
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)`
        )
        .run(m.version, m.name, checksum(m.up));
    });

    for (const m of toApply) applyOne(m);
    return toApply;
  }

  /**
   * Roll back to `target` (exclusive — keep `target` applied, drop everything
   * above). Dev-only escape hatch; never enable in production paths.
   */
  down(target: number): Migration[] {
    const applied = this.appliedList()
      .filter((row) => row.version > target)
      .sort((a, b) => b.version - a.version);
    if (applied.length === 0) return [];

    const rollbackOne = this.db.transaction((row: SchemaMigrationRow) => {
      const m = this.migrations.get(row.version);
      if (!m?.down) {
        throw new Error(`Migration ${row.version} has no down — cannot roll back.`);
      }
      this.db.exec(m.down);
      this.db.prepare(`DELETE FROM schema_migrations WHERE version = ?`).run(row.version);
    });

    const reverted: Migration[] = [];
    for (const row of applied) {
      const m = this.migrations.get(row.version);
      if (!m) {
        throw new Error(`Cannot roll back v${row.version}: migration not registered.`);
      }
      rollbackOne(row);
      reverted.push(m);
    }
    return reverted;
  }

  validate(): ValidationReport {
    const issues: Array<{ version: number; reason: string }> = [];
    for (const applied of this.appliedList()) {
      const m = this.migrations.get(applied.version);
      if (!m) {
        // Unknown migration in DB — likely a downgrade. Flag but don't
        // automatically fail; up() will guard separately by version range.
        issues.push({
          version: applied.version,
          reason: 'applied in DB but not registered in code (downgrade?)'
        });
        continue;
      }
      const expected = checksum(m.up);
      if (expected !== applied.checksum) {
        issues.push({
          version: applied.version,
          reason: `checksum mismatch (db=${applied.checksum} code=${expected})`
        });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  private appliedList(): SchemaMigrationRow[] {
    const rows = this.db
      .prepare(`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC`)
      .all() as Array<{
        version: number;
        name: string;
        checksum: string;
        applied_at: string;
      }>;
    return rows.map((r) => ({
      version: r.version,
      name: r.name,
      checksum: r.checksum,
      appliedAt: r.applied_at
    }));
  }

  private sortedMigrations(): Migration[] {
    return Array.from(this.migrations.values()).sort((a, b) => a.version - b.version);
  }

  private ensureTrackingTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}

function checksum(sql: string): string {
  return 'sha256:' + createHash('sha256').update(sql.trim()).digest('hex');
}
