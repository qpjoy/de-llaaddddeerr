import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once, EventEmitter } from 'node:events'
import { createStaticService } from '../src/service.mjs'
import { ArchiveWorker } from '../src/archive-worker.mjs'
import { ArchiveCatalog } from '../src/archive-catalog.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')
const token = 't'.repeat(32), headers = { authorization: `Bearer ${token}` }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'static-batch-')), local = join(root, 'local'), state = join(root, 'state'), nas = join(root, 'nas')
  await mkdir(local); await mkdir(state); await mkdir(nas)
  await writeFile(join(nas, '.mx-static-volume-id'), 'nas-01')
  const server = createStaticService({ root: local, stateDir: state, projects: { test: { read: token, write: token } }, signingKey: token, minFreeBytes: 0, cacheOptions: { ttlMs: 0 } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`, catalog = new ArchiveCatalog(state)
  const workers = []
  t.after(async () => {
    for (const worker of workers) await worker.stop()
    await server.shutdown(); await new Promise(r => { server.close(r); server.closeAllConnections() })
    catalog.close(); await rm(root, { recursive: true, force: true })
  })
  let spawns = 0
  return {
    root, local, state, nas, url, catalog,
    spawned: () => spawns,
    // Unique bytes per call: identical content is deduplicated into one inode,
    // which would make "corrupt one object" corrupt all of its twins.
    upload: (body = Buffer.concat([png, Buffer.from(randomUUID())])) =>
      fetch(url + '/static/v1/projects/test/upload', { method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body })
        .then(async r => { assert.equal(r.status, 201); return { ...await r.json(), body } }),
    worker: (options = {}) => {
      const worker = new ArchiveWorker({ stateDir: state, localRoot: local, nasRoot: nas, volumeId: 'nas-01',
        requireNfs: false, probeIntervalMs: 20, spawnImpl: (...args) => { spawns++; return spawn(...args) }, ...options })
      workers.push(worker)
      return worker
    },
  }
}
async function until(worker, predicate, label = 'archive transition') {
  for (let i = 0; i < 600; i++) { worker.tick(); if (predicate()) return; await new Promise(r => setTimeout(r, 20)) }
  throw Error('timed out waiting for ' + label)
}

test('a batch of objects mirrors through a single child process', async t => {
  const f = await fixture(t)
  const uploaded = []
  for (let i = 0; i < 12; i++) uploaded.push(await f.upload())
  const worker = f.worker({ concurrency: 6 })
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => uploaded.every(m => f.catalog.get(m.key).mirrored === 1), 'all objects mirrored')
  for (const meta of uploaded) {
    assert.equal(f.catalog.get(meta.key).state, 'ready')
    assert.deepEqual(await readFile(join(f.nas, 'objects', meta.key)), meta.body)
  }
  // The D-state guard is the point of the single child: concurrency lives
  // inside it, never as more processes.
  assert.ok(f.spawned() <= 4, `expected a handful of children, saw ${f.spawned()}`)
  assert.equal(f.catalog.backend().health, 'online')
})

test('one unarchivable object does not stall or fail the rest of its batch', async t => {
  const f = await fixture(t)
  const good = [], bad = await f.upload()
  for (let i = 0; i < 5; i++) good.push(await f.upload())
  // Corrupt the local bytes so this object's copy fails its source checksum.
  await writeFile(join(f.local, 'objects', bad.key), Buffer.concat([bad.body, Buffer.from('tamper')]))
  const worker = f.worker({ concurrency: 4 })
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => good.every(m => f.catalog.get(m.key).mirrored === 1), 'good objects mirrored')
  const failed = f.catalog.get(bad.key)
  assert.equal(failed.mirrored, 0)
  assert.equal(failed.state, 'queued', 'the bad object is requeued with its own backoff')
  assert.match(failed.error, /checksum|size/)
  assert.ok(failed.next_at > Date.now(), 'and is not retried immediately')
  assert.equal(f.catalog.backend().health, 'online', 'one bad object must not put the backend in backoff')
})

test('objects the child never reported are requeued, never marked mirrored', async t => {
  const f = await fixture(t)
  const uploaded = []
  for (let i = 0; i < 6; i++) uploaded.push(await f.upload())
  // A child that reports nothing and is killed by the idle deadline.
  const worker = f.worker({ concurrency: 6, timeoutMs: 40, spawnImpl: () => {
    const fake = new EventEmitter()
    fake.stderr = new EventEmitter()
    fake.kill = () => { setImmediate(() => fake.emit('exit', null)); return true }
    return fake
  } })
  f.catalog.setEnabled(true, 'nas-01')
  worker.tick()
  await until(worker, () => uploaded.every(m => f.catalog.get(m.key).state === 'queued'), 'all claimed rows released')
  for (const meta of uploaded) {
    const row = f.catalog.get(meta.key)
    assert.equal(row.mirrored, 0)
    assert.equal(row.owner, null)
  }
  assert.equal(f.catalog.backend().health, 'stalled')
})

test('verify=never skips the far-side read-back but eviction still verifies it', async t => {
  const f = await fixture(t)
  const meta = await f.upload()
  const worker = f.worker({ concurrency: 2, verify: 'never' })
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => f.catalog.get(meta.key).mirrored === 1, 'mirrored')
  assert.deepEqual(await readFile(join(f.nas, 'objects', meta.key)), meta.body)
  assert.equal(f.catalog.backend().health, 'online', 'an archived object already proves the backend is up')

  // Damage the NAS copy behind our back, then ask to release the local one.
  await writeFile(join(f.nas, 'objects', meta.key), Buffer.concat([meta.body, Buffer.from('rot')]))
  worker.tick() // Eviction requires a live backend; keep the heartbeat fresh.
  const evict = await fetch(f.url + '/static/v1/projects/test/storage/evict',
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ key: meta.key }) })
  assert.equal(evict.status, 202)
  await until(worker, () => f.catalog.get(meta.key).error !== null, 'eviction refused')
  assert.equal(f.catalog.get(meta.key).local, 1, 'the local copy must survive an unverifiable NAS copy')
  assert.ok((await stat(join(f.local, 'objects', meta.key))).size > 0)
  assert.match(f.catalog.get(meta.key).error, /checksum|size/)
})

test('a long batch keeps its leases alive while it reports progress', async t => {
  const f = await fixture(t)
  const meta = await f.upload()
  const worker = f.worker({ concurrency: 1, leaseMs: 120, renewEveryMs: 10, timeoutMs: 10_000,
    spawnImpl: () => {
      const fake = new EventEmitter(); fake.stderr = new EventEmitter(); fake.kill = () => true
      return fake
    } })
  f.catalog.setEnabled(true, 'nas-01')
  worker.tick()
  const claimed = f.catalog.get(meta.key)
  assert.equal(claimed.state, 'running')
  const beat = setInterval(() => worker.child.emit('message', { progress: true }), 15)
  try {
    await new Promise(r => setTimeout(r, 300)) // well past the 120 ms lease
    const held = f.catalog.get(meta.key)
    assert.equal(held.state, 'running')
    assert.equal(held.owner, claimed.owner, 'the lease was renewed, not re-claimed by someone else')
    assert.ok(held.lease_until > Date.now(), 'and is still in the future')
  } finally { clearInterval(beat); worker.child.emit('exit', 1) }
})

test('a refused storage transition says which precondition failed', async t => {
  const f = await fixture(t)
  const meta = await f.upload()
  const post = (action, key) => fetch(`${f.url}/static/v1/projects/test/storage/${action}`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
  const reason = async (...args) => (await (await post(...args)).json()).error.code

  assert.equal(await reason('evict', meta.key), 'not_yet_archived')
  assert.equal(await reason('restore', meta.key), 'not_yet_archived')
  assert.equal(await reason('evict', `test/2026/09/12/${'0'.repeat(8)}-0000-0000-0000-000000000000`), 'archive_key_unknown')

  const spare = await f.upload()
  const worker = f.worker({ concurrency: 2 })
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => [meta, spare].every(m => f.catalog.get(m.key).mirrored === 1), 'both mirrored')
  worker.tick()
  assert.equal((await post('evict', meta.key)).status, 202)
  // A transition is already queued for that key, so a second ask is busy.
  assert.equal(await reason('evict', meta.key), 'archive_busy')

  // With the archive detached, releasing another local copy must refuse and say so.
  f.catalog.setEnabled(false)
  assert.equal(await reason('evict', spare.key), 'archive_backend_detached')
})
