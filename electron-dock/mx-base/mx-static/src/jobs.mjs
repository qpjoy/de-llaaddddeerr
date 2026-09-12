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
    this.maxQueued = maxQueued; this.leaseMs = leaseMs; this.maxAttempts = maxAttempts
    this.db.exec('PRAGMA busy_timeout=5000;')
    if (!readOnly) this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, scope TEXT NOT NULL,
        source_hash TEXT NOT NULL, url TEXT, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
        lease_until INTEGER, owner TEXT, result TEXT, error TEXT, error_status INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_source ON jobs(project,source_hash)
        WHERE state IN ('queued','running');
      CREATE INDEX IF NOT EXISTS claim_jobs ON jobs(state,available_at,lease_until);
      CREATE INDEX IF NOT EXISTS project_jobs ON jobs(project,updated_at);
      CREATE INDEX IF NOT EXISTS source_jobs ON jobs(project,source_hash,updated_at);
    `)
  }
  decode(row) { return row ? { ...row, result: row.result ? JSON.parse(row.result) : null } : null }
  get(id, project) { return this.decode(this.db.prepare('SELECT * FROM jobs WHERE id=? AND project=?').get(id, project)) }
  pending(project, sourceHash) {
    return this.decode(this.db.prepare("SELECT * FROM jobs WHERE project=? AND source_hash=? AND state IN ('queued','running')").get(project, sourceHash))
  }
  enqueue(project, scope, sourceHash, url) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let row = this.pending(project, sourceHash)
      if (!row) {
        const count = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('queued','running')").get().n
        if (count >= this.maxQueued) throw Object.assign(new Error('queue_full'), { status: 429, code: 'queue_full' })
        const now = Date.now(), id = randomUUID()
        this.db.prepare("INSERT INTO jobs(id,project,scope,source_hash,url,state,available_at,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)").run(id, project, scope, sourceHash, url, now, now, now)
        row = this.get(id, project)
      }
      this.db.exec('COMMIT') // synchronous=FULL: ACK only after durable acceptance.
      return row
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  latest(project, sourceHash) {
    return this.decode(this.db.prepare('SELECT * FROM jobs WHERE project=? AND source_hash=? ORDER BY updated_at DESC,rowid DESC LIMIT 1').get(project, sourceHash))
  }
  ready(project, sourceHash) {
    return this.decode(this.db.prepare("SELECT * FROM jobs WHERE project=? AND source_hash=? AND state='ready' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(project, sourceHash))
  }
  renew(job) {
    return this.db.prepare("UPDATE jobs SET lease_until=? WHERE id=? AND state='running' AND owner=?").run(Date.now() + this.leaseMs, job.id, job.owner).changes === 1
  }
  claim() {
    const now = Date.now(), owner = randomUUID()
    // Expired leases survive a kill -9/reboot and can be taken over. Every
    // completion is fenced by the lease owner, including failed/requeued work.
    this.db.prepare("UPDATE jobs SET state='failed', error='attempts_exhausted', owner=NULL, lease_until=NULL, updated_at=? WHERE state='running' AND lease_until<=? AND attempts>=?").run(now, now, this.maxAttempts)
    return this.decode(this.db.prepare(`UPDATE jobs SET state='running', owner=?, lease_until=?, attempts=attempts+1, updated_at=?
      WHERE id=(SELECT id FROM jobs WHERE (state='queued' AND available_at<=?) OR (state='running' AND lease_until<=? AND attempts<?)
      ORDER BY created_at LIMIT 1) RETURNING *`).get(owner, now + this.leaseMs, now, now, now, this.maxAttempts))
  }
  complete(job, result) {
    return this.db.prepare("UPDATE jobs SET state='ready',result=?,url=NULL,error=NULL,owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='running' AND owner=?")
      .run(JSON.stringify(result), Date.now(), job.id, job.owner).changes === 1
  }
  fail(job, error, { retryable = true, aborted = false, status = 502 } = {}) {
    const retry = aborted || (retryable && job.attempts < this.maxAttempts)
    return this.db.prepare('UPDATE jobs SET state=?,error=?,error_status=?,owner=NULL,lease_until=NULL,available_at=?,updated_at=?,attempts=attempts-? WHERE id=? AND owner=?')
      .run(retry ? 'queued' : 'failed', String(error).slice(0, 100), status, Date.now() + (aborted ? 0 : Math.min(30000, 1000 * 2 ** job.attempts)), Date.now(), aborted ? 1 : 0, job.id, job.owner)
  }
  retry(id, project) {
    const job = this.get(id, project)
    if (!job || job.state !== 'failed' || !job.url) return null
    const pending = this.pending(project, job.source_hash)
    if (pending) return pending
    // enqueue() enforces capacity; keep the failed evidence as history.
    return this.enqueue(project, job.scope, job.source_hash, job.url)
  }
  list(project) {
    const counts = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM jobs WHERE project=? GROUP BY state').all(project).map(r => [r.state, r.n]))
    const jobs = this.db.prepare('SELECT id,state,attempts,error,created_at,updated_at FROM jobs WHERE project=? ORDER BY updated_at DESC LIMIT 100').all(project)
    return { counts, jobs }
  }
  close() { this.db.close() }
}
