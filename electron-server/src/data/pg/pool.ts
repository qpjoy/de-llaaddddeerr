/**
 * Postgres connection pool + boot-time migration runner. The migrator is
 * tiny on purpose: reads `db/migrations/*.sql` in version order, applies
 * any that aren't in `schema_migrations`, refuses re-application of files
 * whose checksum drifted.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '..', '..', '..', 'db', 'migrations');

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Postgres pool not initialized; call initPg(url) first.');
  return pool;
}

export async function initPg(connectionString: string): Promise<pg.Pool> {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 8),
    idleTimeoutMillis: 30_000
  });
  // Smoke-test the connection eagerly so misconfig fails at boot.
  const probe = await pool.connect();
  probe.release();
  await runMigrations(pool);
  return pool;
}

export async function closePg(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/* ────────────────────────────────────────────────────────────────────── */
/* Migrations                                                             */
/* ────────────────────────────────────────────────────────────────────── */

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  return files.map((file) => {
    const versionMatch = file.match(/^(\d+)_(.*)\.sql$/);
    if (!versionMatch) throw new Error(`bad migration filename: ${file}`);
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    return {
      version: Number(versionMatch[1]),
      name: versionMatch[2].replace(/_/g, ' '),
      sql,
      checksum: 'sha256:' + createHash('sha256').update(sql.trim()).digest('hex')
    };
  });
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{
      version: number;
      checksum: string;
    }>(`SELECT version, checksum FROM schema_migrations ORDER BY version ASC`);
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const migrations = loadMigrations();

    // Drift check first — refuse to run if any historical migration changed body.
    for (const m of migrations) {
      const known = applied.get(m.version);
      if (known && known !== m.checksum) {
        throw new Error(
          `Postgres migration ${m.version} (${m.name}) checksum drifted ` +
            `(file=${m.checksum} db=${known}). Refusing to migrate.`
        );
      }
    }

    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
          [m.version, m.name, m.checksum]
        );
        await client.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(`[pg] migration ${m.version} (${m.name}) applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}
