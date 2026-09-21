import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaJobs } from '../src/jobs.mjs'
import { ArchiveCatalog } from '../src/archive-catalog.mjs'

test('v0.3 jobs survive upgrade, retain leases and enter the correct download pool', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'static-upgrade-jobs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // Schema from the v0.3 snapshot, including its existing claim_jobs index.
  const old = new DatabaseSync(join(dir, 'jobs.sqlite'))
  old.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, scope TEXT NOT NULL,
    source_hash TEXT NOT NULL, url TEXT, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
    lease_until INTEGER, owner TEXT, result TEXT, error TEXT, error_status INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX claim_jobs ON jobs(state,available_at,lease_until);`)
  const insert = old.prepare(`INSERT INTO jobs(id,project,scope,source_hash,url,state,
    available_at,owner,lease_until,created_at,updated_at) VALUES(?,'p','scope',?,?,?,0,?,?,1,1)`)
  insert.run('image', 'image-hash', 'https://cdn.example/a.png', 'queued', null, null)
  insert.run('video', 'video-hash', 'https://cdn.example/a.MP4?token=x', 'queued', null, null)
  insert.run('leased', 'leased-hash', 'https://cdn.example/a.mp3', 'running', 'old-owner', Date.now() + 60000)
  old.close()

  for (let attempt = 0; attempt < 2; attempt++) {
    const jobs = new MediaJobs(dir)
    try {
      assert.equal(jobs.get('image', 'p').kind, 'image')
      assert.equal(jobs.get('video', 'p').kind, 'video')
      assert.equal(jobs.get('leased', 'p').owner, 'old-owner')
      assert.equal(jobs.get('leased', 'p').state, 'running')
      assert.equal(jobs.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 3)
    } finally { jobs.close() }
  }
  const jobs = new MediaJobs(dir)
  try {
    assert.equal(jobs.claim('video').id, 'video')
    assert.equal(jobs.claim('image').id, 'image')
  } finally { jobs.close() }
})

test('v0.3 archive columns are backfilled before indexes without losing NAS identity or cold objects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'static-upgrade-archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const key = 'p/2026/09/12/00000000-0000-4000-8000-000000000001'
  const meta = { key, project: 'p', size: 1234, sha256: 'a'.repeat(64), contentType: 'video/mp4' }
  const old = new DatabaseSync(join(dir, 'archive.sqlite'))
  old.exec(`CREATE TABLE objects (
    key TEXT PRIMARY KEY, project TEXT NOT NULL, meta TEXT NOT NULL,
    local INTEGER NOT NULL DEFAULT 1, mirrored INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL DEFAULT 'sync', state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    owner TEXT, lease_until INTEGER, error TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE backend (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
      volume_id TEXT, health TEXT NOT NULL DEFAULT 'detached', heartbeat INTEGER, error TEXT);
    INSERT INTO backend(id,enabled,volume_id) VALUES(1,1,'existing-nas');`)
  old.prepare("INSERT INTO objects(key,project,meta,local,mirrored,action,state,updated_at) VALUES(?,'p',?,0,1,'evict','ready',123)")
    .run(key, JSON.stringify(meta))
  old.close()

  for (let attempt = 0; attempt < 2; attempt++) {
    const archive = new ArchiveCatalog(dir)
    try {
      const row = archive.db.prepare('SELECT * FROM objects WHERE key=?').get(key)
      assert.equal(row.size, meta.size)
      assert.equal(row.sha256, meta.sha256)
      assert.equal(row.last_read, 123)
      assert.equal(row.local, 0)
      assert.equal(row.mirrored, 1)
      assert.equal(archive.backend().volume_id, 'existing-nas')
      assert.equal(archive.backend().enabled, 1)
      assert.equal(archive.mirroredTwin(meta.sha256), key)
    } finally { archive.close() }
  }
  const reader = new ArchiveCatalog(dir, { readOnly: true })
  try { assert.equal(reader.get(key).meta.key, key) } finally { reader.close() }
})
