import { assertLocalStorage } from './mounts.mjs'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

// Entire control plane remains local, including during an NFS kernel I/O hang.
export class ArchiveCatalog {
  constructor(directory, { readOnly = false } = {}) {
    assertLocalStorage([directory],{controlPaths:[directory]})
    this.db = new DatabaseSync(join(directory, 'archive.sqlite'), { readOnly })
    this.db.exec('PRAGMA busy_timeout=1000')
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS objects (
        key TEXT PRIMARY KEY, project TEXT NOT NULL, meta TEXT NOT NULL,
        local INTEGER NOT NULL DEFAULT 1, mirrored INTEGER NOT NULL DEFAULT 0,
        action TEXT NOT NULL DEFAULT 'sync', state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        owner TEXT, lease_until INTEGER, error TEXT, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS archive_pending ON objects(state,next_at);
      CREATE TABLE IF NOT EXISTS backend (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
        volume_id TEXT, health TEXT NOT NULL DEFAULT 'detached', heartbeat INTEGER, error TEXT);
      INSERT OR IGNORE INTO backend(id) VALUES(1);`)
  }
  register(meta) {
    this.db.prepare('INSERT OR IGNORE INTO objects(key,project,meta,updated_at) VALUES(?,?,?,?)').run(meta.key,meta.project,JSON.stringify(meta),Date.now())
  }
  get(key) { const row = this.db.prepare('SELECT * FROM objects WHERE key=?').get(key); return row ? { ...row, meta: JSON.parse(row.meta) } : null }
  setEnabled(enabled, volumeId) {
    const current = this.db.prepare('SELECT * FROM backend WHERE id=1').get()
    if (enabled && (!volumeId || (current.volume_id && current.volume_id !== volumeId))) throw Error('NAS identity differs; migrate/verify existing archive before changing volume ID')
    this.db.prepare('UPDATE backend SET enabled=?,volume_id=COALESCE(volume_id,?),health=?,error=NULL WHERE id=1').run(enabled ? 1 : 0, volumeId || null, enabled ? 'starting' : 'detached')
    if (enabled) this.db.prepare("UPDATE objects SET next_at=0 WHERE state='queued'").run()
  }
  backend() {
    const row = this.db.prepare('SELECT * FROM backend WHERE id=1').get()
    return { ...row, health: !row.enabled ? 'detached' : (!row.heartbeat || Date.now()-row.heartbeat>10000) ? 'offline' : row.health }
  }
  heartbeat(health,error=null) { this.db.prepare('UPDATE backend SET health=?,heartbeat=?,error=? WHERE id=1').run(health,Date.now(),error) }
  request(key, action) {
    const row = this.get(key)
    if (!row) return false
    if (action === 'sync' && !row.local) return false
    if (action === 'evict' && (!row.mirrored || !row.local || row.state !== 'ready' || this.backend().health !== 'online')) return false
    if (action === 'restore' && !row.mirrored) return false
    return this.db.prepare("UPDATE objects SET action=?,state='queued',next_at=0,owner=NULL,lease_until=NULL,updated_at=? WHERE key=? AND state!='running'").run(action,Date.now(),key).changes === 1
  }
  claim() {
    if (!this.backend().enabled) return null
    const now=Date.now(), owner=randomUUID()
    const row=this.db.prepare(`UPDATE objects SET state='running',owner=?,lease_until=?,attempts=attempts+1,updated_at=?
      WHERE key=(SELECT key FROM objects WHERE (state='queued' AND next_at<=?) OR (state='running' AND lease_until<=?)
      ORDER BY CASE action WHEN 'restore' THEN 0 ELSE 1 END,updated_at LIMIT 1) RETURNING *`).get(owner,now+60000,now,now,now)
    return row ? { ...row, meta:JSON.parse(row.meta) } : null
  }
  complete(job) {
    return this.db.prepare("UPDATE objects SET state='ready',local=?,mirrored=1,owner=NULL,lease_until=NULL,error=NULL,updated_at=? WHERE key=? AND owner=?")
      .run(job.action === 'evict' ? 0 : 1,Date.now(),job.key,job.owner).changes === 1
  }
  fail(job, error) {
    this.db.prepare("UPDATE objects SET state='queued',owner=NULL,lease_until=NULL,error=?,next_at=?,updated_at=? WHERE key=? AND owner=?")
      .run(String(error).slice(0,100),Date.now()+Math.min(300000,2000*2**Math.min(job.attempts,7)),Date.now(),job.key,job.owner)
  }
  status(project) {
    const rows=this.db.prepare('SELECT action,state,count(*) AS count,coalesce(sum(json_extract(meta,\'$.size\')),0) AS bytes FROM objects WHERE project=? GROUP BY action,state').all(project)
    return { backend:this.backend(), objects:rows, failures:this.db.prepare('SELECT key,action,attempts,error,next_at FROM objects WHERE project=? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 20').all(project) }
  }
  close() { this.db.close() }
}
