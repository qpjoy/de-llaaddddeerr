import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Control data stays on local SSD, separately from object storage/NAS.
// Only the writer process mutates this DB; HTTP readers use readOnly handles.
export class MediaJobs {
  constructor(directory, { readOnly = false, maxQueued = 10000, leaseMs = 60000, maxAttempts = 5 } = {}) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1 || !Number.isInteger(leaseMs) || leaseMs < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid queue limits')
    if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o750 })
    this.db = new DatabaseSync(join(directory, 'jobs.sqlite'), { readOnly })
    this.statements = new Map()
    this.maxQueued = maxQueued; this.leaseMs = leaseMs; this.maxAttempts = maxAttempts
    this.db.exec('PRAGMA busy_timeout=5000;')
    if (!readOnly) this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, scope TEXT NOT NULL,
        source_hash TEXT NOT NULL, url TEXT, state TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'image',
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
        lease_until INTEGER, owner TEXT, result TEXT, error TEXT, error_status INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_source ON jobs(project,source_hash)
        WHERE state IN ('queued','running');
      CREATE INDEX IF NOT EXISTS project_jobs ON jobs(project,updated_at);
      CREATE INDEX IF NOT EXISTS project_state ON jobs(project,state);
      CREATE INDEX IF NOT EXISTS source_jobs ON jobs(project,source_hash,updated_at);
    `)
    if (!readOnly) {
      // v0.3 queues predate separate image/video pools. Upgrade before any
      // query or index references kind, preserving pending jobs and leases.
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const columns = this.db.prepare('PRAGMA table_info(jobs)').all()
        if (!columns.some(column => column.name === 'kind')) {
          this.db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'")
          const update = this.db.prepare("UPDATE jobs SET kind='video' WHERE id=?")
          for (const row of this.db.prepare('SELECT id,url FROM jobs WHERE url IS NOT NULL').iterate()) {
            if (/\.(mp4|m4v|mov|webm|mkv|m3u8|mpd|ts|avi|flv|ogv|mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(row.url.split(/[?#]/)[0])) update.run(row.id)
          }
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS claim_jobs_by_kind ON jobs(kind,state,available_at,lease_until); COMMIT;')
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
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
  setCapacity(maxQueued) { if (Number.isInteger(maxQueued) && maxQueued > 0) this.maxQueued = maxQueued }
  decode(row) { return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null }
  get(id, project) { return this.decode(this.sql('SELECT * FROM jobs WHERE id=? AND project=?').get(id, project)) }
  pending(project, sourceHash) {
    return this.decode(this.sql("SELECT * FROM jobs WHERE project=? AND source_hash=? AND state IN ('queued','running')").get(project, sourceHash))
  }
  enqueue(project, scope, sourceHash, url, kind='image') {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let row = this.pending(project, sourceHash)
      if (!row) {
        const count = this.sql("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").get().n
        if (count >= this.maxQueued) throw Object.assign(new Error('queue_full'), { status: 429, code: 'queue_full' })
        const now = Date.now(), id = randomUUID()
        this.sql("INSERT INTO jobs(id,project,scope,source_hash,url,kind,state,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)").run(id, project, scope, sourceHash, url, kind, now, now, now)
        row = this.get(id, project)
      }
      this.db.exec('COMMIT') // synchronous=FULL: ACK only after durable acceptance.
      return row
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  // A page of upstream results is one fsync, not one per media URL. Returns a
  // row per input, in order: an existing pending job, a new job, or a rejection.
  enqueueMany(project, items) {
    if (!Array.isArray(items) || !items.length) return []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      let room = this.maxQueued - this.sql("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").get().n
      const insert = this.sql("INSERT INTO jobs(id,project,scope,source_hash,url,kind,state,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)")
      const rows = items.map(({ scope, sourceHash, url, kind = 'image' }) => {
        // Sees rows inserted earlier in this transaction, so duplicates inside
        // one batch coalesce exactly like duplicates across requests.
        const existing = this.pending(project, sourceHash)
        if (existing) return existing
        if (room <= 0) return { error: 'queue_full', status: 429 }
        const id = randomUUID()
        insert.run(id, project, scope, sourceHash, url, kind, now, now, now)
        room--
        return this.get(id, project)
      })
      this.db.exec('COMMIT') // synchronous=FULL: one durable ACK for the batch.
      return rows
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  latest(project, sourceHash) {
    return this.decode(this.sql('SELECT * FROM jobs WHERE project=? AND source_hash=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(project, sourceHash))
  }
  ready(project, sourceHash) {
    return this.decode(this.sql("SELECT * FROM jobs WHERE project=? AND source_hash=? AND state='ready' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(project, sourceHash))
  }
  renew(job) {
    return this.sql("UPDATE jobs SET lease_until=? WHERE id=? AND state='running' AND owner=?").run(Date.now() + this.leaseMs, job.id, job.owner).changes === 1
  }
  claim(kind = null) {
    const now = Date.now(), owner = randomUUID()
    // Expired leases survive a kill -9/reboot and can be taken over. Every
    // completion is fenced by the lease owner, including failed/requeued work.
    this.sql("UPDATE jobs SET state='failed', error='attempts_exhausted', owner=NULL, lease_until=NULL, updated_at=? WHERE state='running' AND lease_until<=? AND attempts>=?").run(now, now, this.maxAttempts)
    const filter = kind ? 'kind=? AND ' : ''
    const args = kind ? [kind] : []
    return this.decode(this.sql(`UPDATE jobs SET state='running', owner=?, lease_until=?, attempts=attempts+1, updated_at=?
      WHERE id=(SELECT id FROM jobs WHERE ${filter}((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=? AND attempts<?))
      ORDER BY created_at LIMIT 1) RETURNING *`).get(owner, now + this.leaseMs, now, ...args, now, now, this.maxAttempts))
  }
  complete(job, result) {
    return this.sql("UPDATE jobs SET state='ready',result=?,url=NULL,error=NULL,owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='running' AND owner=?")
      .run(JSON.stringify(result), Date.now(), job.id, job.owner).changes === 1
  }
  fail(job, error, { retryable = true, aborted = false, status = 502 } = {}) {
    const retry = aborted || (retryable && job.attempts < this.maxAttempts)
    return this.sql('UPDATE jobs SET state=?,error=?,error_status=?,owner=NULL,lease_until=NULL,available_at=?,updated_at=?,attempts=attempts-? WHERE id=? AND owner=?')
      .run(retry ? 'queued' : 'failed', String(error).slice(0, 100), status, Date.now() + (aborted ? 0 : Math.min(30000, 1000 * 2 ** job.attempts)), Date.now(), aborted ? 1 : 0, job.id, job.owner)
  }
  retry(id, project) {
    const job = this.get(id, project)
    if (!job || job.state !== 'failed' || !job.url) return null
    const pending = this.pending(project, job.source_hash)
    if (pending) return pending
    // enqueue() enforces capacity; keep the failed evidence as history.
    return this.enqueue(project, job.scope, job.source_hash, job.url, job.kind)
  }
  list(project) {
    const counts = Object.fromEntries(this.sql('SELECT state,count(*) AS n FROM jobs WHERE project=? GROUP BY state').all(project).map(r => [r.state, r.n]))
    const jobs = this.sql('SELECT id,state,attempts,error,created_at,updated_at FROM jobs WHERE project=? ORDER BY updated_at DESC LIMIT 100').all(project)
    return { counts, jobs }
  }
  close() { this.statements.clear(); this.db.close() }
}
