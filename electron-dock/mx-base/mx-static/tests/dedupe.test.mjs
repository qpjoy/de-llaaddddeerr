import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createStaticService } from '../src/service.mjs'
import { ArchiveWorker } from '../src/archive-worker.mjs'
import { ArchiveCatalog } from '../src/archive-catalog.mjs'

const token = 't'.repeat(32), headers = { authorization: `Bearer ${token}` }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')
const variant = () => Buffer.concat([png, Buffer.from(randomUUID())])

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mx-dedupe-')), local = join(root, 'local'), state = join(root, 'state'), nas = join(root, 'nas')
  await mkdir(local); await mkdir(state); await mkdir(nas)
  await writeFile(join(nas, '.mx-static-volume-id'), 'nas-01')
  const server = createStaticService({ root: local, stateDir: state, env: {}, minFreeBytes: 0,
    projects: { test: { read: token, write: token }, other: { read: 'o'.repeat(32), write: 'p'.repeat(32) } },
    signingKey: token, cacheOptions: { ttlMs: 0 } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`, catalog = new ArchiveCatalog(state)
  const workers = []
  t.after(async () => {
    for (const worker of workers) await worker.stop()
    await server.shutdown(); await new Promise(r => { server.close(r); server.closeAllConnections() })
    catalog.close(); await rm(root, { recursive: true, force: true })
  })
  return {
    local, state, nas, url, catalog,
    upload: (body, project = 'test', auth = token) => fetch(`${url}/static/v1/projects/${project}/upload`,
      { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'image/png' }, body })
      .then(async r => { assert.equal(r.status, 201, `upload failed: ${r.status}`); return r.json() }),
    remove: (key, project = 'test', auth = token) => fetch(`${url}/static/v1/projects/${project}/objects/${key}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${auth}` } }),
    storage: () => fetch(`${url}/static/v1/projects/test/storage`, { headers }).then(r => r.json()),
    worker: (options = {}) => {
      const worker = new ArchiveWorker({ stateDir: state, localRoot: local, nasRoot: nas, volumeId: 'nas-01',
        requireNfs: false, probeIntervalMs: 20, concurrency: 4, spawnImpl: spawn, ...options })
      workers.push(worker); return worker
    },
  }
}
const until = async (worker, predicate, label) => {
  for (let i = 0; i < 400; i++) { worker.tick(); if (predicate()) return; await new Promise(r => setTimeout(r, 20)) }
  throw Error('timed out waiting for ' + label)
}
const objectPath = (local, key) => join(local, 'objects', key)

test('identical bytes are stored once and referenced many times', async t => {
  const f = await fixture(t)
  const body = variant()
  const first = await f.upload(body)
  const second = await f.upload(body)
  const third = await f.upload(body, 'other', 'p'.repeat(32)) // a different project entirely
  assert.notEqual(first.key, second.key, 'each reference is its own key')
  assert.equal(first.sha256, second.sha256)

  const [a, b, c] = await Promise.all([first, second, third].map(m => stat(objectPath(f.local, m.key))))
  assert.equal(a.ino, b.ino, 'the same content is one inode, not two copies')
  assert.equal(a.ino, c.ino, 'deduplication crosses projects')
  assert.equal(a.nlink, 3, 'three references to one set of bytes')

  const storage = await f.storage()
  assert.equal(storage.content.references, 2, 'two references inside this project')
  assert.equal(storage.content.distinctObjects, 1)
  assert.equal(storage.content.savedBytes, body.length, 'the duplicate cost nothing')
})

test('different content is never merged', async t => {
  const f = await fixture(t)
  const one = await f.upload(variant()), two = await f.upload(variant())
  const [a, b] = await Promise.all([one, two].map(m => stat(objectPath(f.local, m.key))))
  assert.notEqual(a.ino, b.ino)
  assert.equal(a.nlink, 1)
  assert.equal((await f.storage()).content.distinctObjects, 2)
})

test('deleting a reference keeps the bytes until the last one goes', async t => {
  const f = await fixture(t)
  const body = variant()
  const first = await f.upload(body), second = await f.upload(body)

  const dropped = await f.remove(first.key)
  assert.equal(dropped.status, 200)
  assert.deepEqual(await dropped.json(), { key: first.key, references: 1, contentRemoved: false, archivedCopyQueuedForRemoval: false })
  await assert.rejects(stat(objectPath(f.local, first.key)), /ENOENT/, 'that key is gone')
  assert.equal((await fetch(`${f.url}/static/files/${first.key}`, { headers })).status, 404)

  // The surviving reference still reads the original bytes.
  const survivor = await fetch(`${f.url}/static/files/${second.key}`, { headers })
  assert.equal(survivor.status, 200)
  assert.deepEqual(Buffer.from(await survivor.arrayBuffer()), body)
  assert.equal((await stat(objectPath(f.local, second.key))).nlink, 1)

  const last = await f.remove(second.key)
  assert.deepEqual(await last.json(), { key: second.key, references: 0, contentRemoved: true, archivedCopyQueuedForRemoval: false })
  await assert.rejects(stat(objectPath(f.local, second.key)), /ENOENT/)
  const storage = await f.storage()
  assert.equal(storage.content.references, 0)
  assert.equal(storage.content.storedBytes, 0)
})

test('deletion is authorised, scoped to the project, and idempotent', async t => {
  const f = await fixture(t)
  const stored = await f.upload(variant())
  assert.equal((await f.remove(stored.key, 'test', 'r'.repeat(32))).status, 401, 'a read token cannot delete')
  assert.equal((await f.remove(stored.key, 'other', 'p'.repeat(32))).status, 404, 'another project cannot delete it')
  assert.equal((await f.remove('test/2026/09/13/07/aa/not-a-real-key')).status, 404)
  assert.equal((await f.remove(stored.key)).status, 200)
  assert.equal((await f.remove(stored.key)).status, 404, 'deleting twice is not an error state')
})

test('the NAS links identical content instead of transferring it again', async t => {
  const f = await fixture(t)
  const body = variant()
  const first = await f.upload(body), second = await f.upload(body)
  const worker = f.worker()
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => [first, second].every(m => f.catalog.get(m.key).mirrored === 1), 'both mirrored')

  const [a, b] = await Promise.all([first, second].map(m => stat(join(f.nas, 'objects', m.key))))
  assert.equal(a.ino, b.ino, 'the second key was linked on the NAS, not copied')
  assert.equal(a.nlink, 2)
  assert.deepEqual(await readFile(join(f.nas, 'objects', second.key)), body)
})

test('deleting a mirrored reference removes its remote path and spares its twin', async t => {
  const f = await fixture(t)
  const body = variant()
  const first = await f.upload(body), second = await f.upload(body)
  const worker = f.worker()
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => [first, second].every(m => f.catalog.get(m.key).mirrored === 1), 'both mirrored')

  const dropped = await f.remove(first.key).then(r => r.json())
  assert.equal(dropped.archivedCopyQueuedForRemoval, true)
  assert.equal(dropped.references, 1)
  await until(worker, () => f.catalog.status('test').pendingPurges === 0, 'purge drained')

  await assert.rejects(stat(join(f.nas, 'objects', first.key)), /ENOENT/, 'the deleted key left the NAS')
  assert.deepEqual(await readFile(join(f.nas, 'objects', second.key)), body, 'its twin is untouched')
  assert.equal((await stat(join(f.nas, 'objects', second.key))).nlink, 1)
})

test('reads record an access time, so eviction can find genuinely cold objects', async t => {
  const f = await fixture(t)
  const hot = await f.upload(variant()), cold = await f.upload(variant())
  const worker = f.worker()
  f.catalog.setEnabled(true, 'nas-01')
  await until(worker, () => [hot, cold].every(m => f.catalog.get(m.key).mirrored === 1), 'mirrored')

  // Backdate both, then read one of them.
  f.catalog.touch(hot.key, 1000); f.catalog.touch(cold.key, 1000)
  assert.equal((await fetch(`${f.url}/static/files/${hot.key}`, { headers })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await fetch(`${f.url}/static/v1/projects/test/storage/touch`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ keys: [hot.key] }),
  }).then(r => r.json())).touched, 1)

  const coldest = (await f.storage()).coldest
  assert.equal(coldest[0].key, cold.key, 'the unread object sorts first')
  assert.ok(coldest[0].last_read < f.catalog.get(hot.key).last_read)
  assert.equal(f.catalog.get(hot.key).last_read > 1000, true, 'the read moved its access time forward')
})
