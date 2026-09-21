import { assertLocalStorage } from './mounts.mjs'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Entire control plane remains local, including during an NFS kernel I/O hang.
export class ArchiveCatalog {
  constructor(directory, { readOnly = false } = {}) {
    assertLocalStorage([directory],{controlPaths:[directory]})
    this.db = new DatabaseSync(join(directory, 'archive.sqlite'), { readOnly })
    this.statements = new Map()
    this.db.exec('PRAGMA busy_timeout=1000')
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS objects (
        key TEXT PRIMARY KEY, project TEXT NOT NULL, meta TEXT NOT NULL,
        local INTEGER NOT NULL DEFAULT 1, mirrored INTEGER NOT NULL DEFAULT 0,
        action TEXT NOT NULL DEFAULT 'sync', state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        owner TEXT, lease_until INTEGER, error TEXT, updated_at INTEGER NOT NULL,
        size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
        last_read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS archive_pending ON objects(state,next_at);
      -- A deleted key still has bytes on the NAS. The row is gone, so the
      -- remote path to remove is remembered here until the archive clears it.
      CREATE TABLE IF NOT EXISTS purges (
        key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        owner TEXT, lease_until INTEGER, error TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS purge_pending ON purges(next_at);
      CREATE TABLE IF NOT EXISTS backend (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
        volume_id TEXT, health TEXT NOT NULL DEFAULT 'detached', heartbeat INTEGER, error TEXT);
      INSERT OR IGNORE INTO backend(id) VALUES(1);`)
    if (!readOnly) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const columns = new Set(this.sql('PRAGMA table_info(objects)').all().map(column => column.name))
        if (!columns.has('size')) {
          this.db.exec("ALTER TABLE objects ADD COLUMN size INTEGER NOT NULL DEFAULT 0")
          this.db.exec("UPDATE objects SET size=coalesce(json_extract(meta,'$.size'),0)")
        }
        if (!columns.has('sha256')) {
          this.db.exec("ALTER TABLE objects ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''")
          this.db.exec("UPDATE objects SET sha256=coalesce(json_extract(meta,'$.sha256'),'')")
        }
        if (!columns.has('last_read')) {
          this.db.exec('ALTER TABLE objects ADD COLUMN last_read INTEGER NOT NULL DEFAULT 0')
          // Unknown historical reads must not make every old object look cold.
          this.db.exec('UPDATE objects SET last_read=updated_at')
        }
        // These columns do not exist in v0.3; create indexes only after ALTER.
        this.db.exec(`CREATE INDEX IF NOT EXISTS archive_rollup ON objects(project,action,state,size);
          CREATE INDEX IF NOT EXISTS archive_content ON objects(sha256,local,mirrored);
          CREATE INDEX IF NOT EXISTS archive_cold ON objects(last_read); COMMIT;`)
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
      this.statements.clear() // Column set changed underneath any cached plan.
    }
  }
  // Every control-plane query runs synchronously on the event loop, and
  // recompiling the SQL each time roughly doubles what it costs. Statements
  // are immutable once prepared, so one cache per connection is enough.
  sql(text) {
    let statement = this.statements.get(text)
    if (!statement) { statement = this.db.prepare(text); this.statements.set(text, statement) }
    return statement
  }
  register(meta, { mirrored = 0 } = {}) {
    const now = Date.now()
    this.sql('INSERT OR IGNORE INTO objects(key,project,meta,size,sha256,mirrored,last_read,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(meta.key,meta.project,JSON.stringify(meta),meta.size,meta.sha256,mirrored,now,now)
  }
  // A reference is one key. Content is shared: the bytes live once and every
  // key that resolves to them is a link, exactly like a cloud drive.
  references(sha256) { return this.sql('SELECT count(*) AS n FROM objects WHERE sha256=?').get(sha256).n }
  // An existing local copy of the same content, to link against instead of
  // writing the same bytes a second time.
  localTwin(sha256, exceptKey = '') {
    return this.sql('SELECT key FROM objects WHERE sha256=? AND local=1 AND key<>? LIMIT 1').get(sha256, exceptKey)?.key || null
  }
  // Likewise on the NAS: a mirrored twin can be linked remotely instead of
  // pushing identical bytes across the network again.
  mirroredTwin(sha256, exceptKey = '') {
    return this.sql('SELECT key FROM objects WHERE sha256=? AND mirrored=1 AND key<>? LIMIT 1').get(sha256, exceptKey)?.key || null
  }
  touch(key, at = Date.now()) { this.sql('UPDATE objects SET last_read=? WHERE key=?').run(at, key) }
  // Read traffic is batched into one transaction: an fsync per served file
  // would put the access log on the critical path of every read.
  touchMany(entries) {
    if (!entries.length) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const update = this.sql('UPDATE objects SET last_read=? WHERE key=? AND last_read<?')
      let touched = 0
      for (const [key, at] of entries) touched += update.run(at, key, at).changes
      this.db.exec('COMMIT')
      return touched
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  // What eviction should actually target: archived, still local, and not read
  // for a while. Without this the cold/hot question can only be guessed at.
  coldest(project, { limit = 20, before = Date.now() } = {}) {
    return this.sql(`SELECT key,size,last_read,sha256 FROM objects
      WHERE project=? AND local=1 AND mirrored=1 AND state='ready' AND last_read<?
      ORDER BY last_read LIMIT ?`).all(project, before, limit)
  }
  // Removes one reference and reports what is left. The caller unlinks that
  // key's own paths; the bytes survive while any other key still points there.
  dropReference(key) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.get(key)
      if (!row) { this.db.exec('COMMIT'); return null }
      if (row.state === 'running') { this.db.exec('COMMIT'); return { row, busy: true } }
      this.sql('DELETE FROM objects WHERE key=?').run(key)
      // Every key owns its own remote path, so each deletion schedules its own
      // purge; the shared bytes go when the last remote link is removed.
      if (row.mirrored === 1) this.sql('INSERT OR IGNORE INTO purges(key,created_at) VALUES(?,?)').run(key, Date.now())
      const remaining = this.references(row.sha256)
      this.db.exec('COMMIT')
      return { row, remaining, mirrored: row.mirrored === 1 }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(key) { const row = this.sql('SELECT * FROM objects WHERE key=?').get(key); return row ? { ...row, meta: JSON.parse(row.meta) } : null }
  setEnabled(enabled, volumeId) {
    const current = this.sql('SELECT * FROM backend WHERE id=1').get()
    if (enabled && (!volumeId || (current.volume_id && current.volume_id !== volumeId))) throw Error('NAS identity differs; migrate/verify existing archive before changing volume ID')
    this.sql('UPDATE backend SET enabled=?,volume_id=COALESCE(volume_id,?),health=?,error=NULL WHERE id=1').run(enabled ? 1 : 0, volumeId || null, enabled ? 'starting' : 'detached')
    if (enabled) this.sql("UPDATE objects SET next_at=0 WHERE state='queued'").run()
  }
  backend() {
    const row = this.sql('SELECT * FROM backend WHERE id=1').get()
    return { ...row, health: !row.enabled ? 'detached' : (!row.heartbeat || Date.now()-row.heartbeat>10000) ? 'offline' : row.health }
  }
  heartbeat(health,error=null) { this.sql('UPDATE backend SET health=?,heartbeat=?,error=? WHERE id=1').run(health,Date.now(),error) }
  // Returns null when the transition was queued, otherwise why it was refused.
  // A bare 409 tells an operator nothing; every rejection here has a distinct,
  // actionable cause.
  request(key, action) {
    const row = this.get(key)
    if (!row) return 'archive_key_unknown'
    if (action === 'sync' && !row.local) return 'local_copy_missing'
    if (action === 'restore' && !row.mirrored) return 'not_yet_archived'
    if (action === 'evict') {
      if (!row.mirrored) return 'not_yet_archived'
      if (!row.local) return 'already_evicted'
      if (row.state !== 'ready') return 'archive_busy'
      const health = this.backend().health
      if (health !== 'online') return `archive_backend_${health}`
    }
    const queued = this.sql("UPDATE objects SET action=?,state='queued',next_at=0,owner=NULL,lease_until=NULL,updated_at=? WHERE key=? AND state!='running'").run(action,Date.now(),key).changes === 1
    return queued ? null : 'archive_busy'
  }
  // Each row gets its own owner, so leases stay fenced per object even though
  // one archive child now carries a batch of them.
  claimMany(limit=1) {
    if (!this.backend().enabled) return []
    const now=Date.now(), claimed=[]
    this.db.exec('BEGIN IMMEDIATE')
    try {
      while (claimed.length < limit) {
        const row=this.sql(`UPDATE objects SET state='running',owner=?,lease_until=?,attempts=attempts+1,updated_at=?
          WHERE key=(SELECT key FROM objects WHERE (state='queued' AND next_at<=?) OR (state='running' AND lease_until<=?)
          ORDER BY CASE action WHEN 'restore' THEN 0 ELSE 1 END,updated_at LIMIT 1) RETURNING *`).get(randomUUID(),now+60000,now,now,now)
        if (!row) break
        // Hand the child a twin to link against: identical content already on
        // the NAS is one LINK call instead of pushing the bytes again.
        const twin = row.action === 'sync' && row.sha256 ? this.mirroredTwin(row.sha256, row.key) : null
        claimed.push({ ...row, meta:JSON.parse(row.meta), twin })
      }
      this.db.exec('COMMIT')
      return claimed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  claim() { return this.claimMany(1)[0] || null }
  claimPurges(limit = 1) {
    if (!this.backend().enabled || limit < 1) return []
    const now = Date.now(), claimed = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      while (claimed.length < limit) {
        const row = this.sql(`UPDATE purges SET owner=?,lease_until=?,attempts=attempts+1
          WHERE key=(SELECT key FROM purges WHERE (owner IS NULL AND next_at<=?) OR lease_until<=? ORDER BY created_at LIMIT 1)
          RETURNING *`).get(randomUUID(), now + 60000, now, now)
        if (!row) break
        claimed.push({ ...row, action: 'purge', meta: { key: row.key } })
      }
      this.db.exec('COMMIT')
      return claimed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  completePurge(job) { return this.sql('DELETE FROM purges WHERE key=? AND owner=?').run(job.key, job.owner).changes === 1 }
  failPurge(job, error) {
    this.sql('UPDATE purges SET owner=NULL,lease_until=NULL,error=?,next_at=? WHERE key=? AND owner=?')
      .run(String(error).slice(0, 100), Date.now() + Math.min(300000, 2000 * 2 ** Math.min(job.attempts, 7)), job.key, job.owner)
  }
  // Leases stay short so a killed worker recovers in about a minute; a batch
  // that legitimately runs longer keeps them alive while it reports progress.
  renew(job,leaseMs=60000) {
    return this.sql("UPDATE objects SET lease_until=? WHERE key=? AND owner=? AND state='running'").run(Date.now()+leaseMs,job.key,job.owner).changes===1
  }
  complete(job) {
    return this.sql("UPDATE objects SET state='ready',local=?,mirrored=1,owner=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE key=? AND owner=?")
      .run(job.action === 'evict' ? 0 : 1,Date.now(),job.key,job.owner).changes === 1
  }
  fail(job, error) {
    this.sql("UPDATE objects SET state='queued',owner=NULL,lease_until=NULL,error=?,next_at=?,updated_at=? WHERE key=? AND owner=?")
      .run(String(error).slice(0,100),Date.now()+Math.min(300000,2000*2**Math.min(job.attempts,7)),Date.now(),job.key,job.owner)
  }
  status(project) {
    const rows=this.sql('SELECT action,state,count(*) AS count,coalesce(sum(size),0) AS bytes FROM objects WHERE project=? GROUP BY action,state').all(project)
    const content = this.sql(`SELECT count(*) AS refs, count(DISTINCT sha256) AS distinct_content,
      coalesce(sum(size),0) AS logical_bytes FROM objects WHERE project=?`).get(project)
    const stored = this.sql('SELECT coalesce(sum(size),0) AS n FROM (SELECT DISTINCT sha256,size FROM objects WHERE project=?)').get(project).n
    return { backend:this.backend(),
      content: { references: content.refs, distinctObjects: content.distinct_content,
        logicalBytes: content.logical_bytes, storedBytes: stored,
        savedBytes: content.logical_bytes - stored },
      pendingPurges: this.sql('SELECT count(*) AS n FROM purges').get().n,
      objects:rows, failures:this.sql('SELECT key,action,attempts,error,next_at FROM objects WHERE project=? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 20').all(project) }
  }
  close() { this.statements.clear(); this.db.close() }
}
