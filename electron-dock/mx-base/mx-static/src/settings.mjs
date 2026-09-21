import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assertLocalStorage } from './mounts.mjs'

// Runtime overrides for the settings the schema marks live. Kept beside the
// other control data on local disk, in its own small database so changing a
// limit never contends with the queue or the archive outbox.
export class Settings {
  constructor(directory, { readOnly = false } = {}) {
    assertLocalStorage([directory], { controlPaths: [directory] })
    if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o750 })
    this.db = new DatabaseSync(join(directory, 'settings.sqlite'), { readOnly })
    this.statements = new Map()
    this.db.exec('PRAGMA busy_timeout=2000')
    if (!readOnly) {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`)
      // Take a write lock once so the WAL and shared-memory files exist before
      // a read-only replica on a read-only mount tries to attach to them.
      this.db.exec('BEGIN IMMEDIATE; COMMIT;')
    }
  }
  sql(text) {
    let statement = this.statements.get(text)
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement) }
    return statement
  }
  // Values round-trip as JSON so a stored boolean stays a boolean.
  //
  // Reading never throws. A read-only replica may reach the store before the
  // writer has created its WAL files, and on a read-only mount SQLite cannot
  // create them itself; the caller must keep serving on .env alone and pick
  // the overrides up on a later poll, not crash at startup.
  read() {
    const overrides = {}
    try {
      for (const row of this.sql('SELECT name,value FROM settings').all()) {
        try { overrides[row.name] = JSON.parse(row.value) } catch { /* skip a corrupt row */ }
      }
    } catch { this.statements.clear(); this.unavailable = true; return {} }
    this.unavailable = false
    return overrides
  }
  // Monotonic marker so other processes can notice a change without re-reading
  // and re-deriving everything on a timer.
  revision() {
    try { return this.sql('SELECT coalesce(max(updated_at),0) AS at,count(*) AS n FROM settings').get() }
    catch { this.statements.clear(); return { at: -1, n: -1 } }
  }
  write(changes) {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) this.sql('DELETE FROM settings WHERE name=?').run(name)
        else this.sql('INSERT INTO settings(name,value,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(name, JSON.stringify(value), now)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return this.read()
  }
  close() { this.statements.clear(); this.db.close() }
}
