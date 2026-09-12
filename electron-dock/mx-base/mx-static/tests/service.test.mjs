import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createStaticService } from '../src/service.mjs'
import { withStaticArchive } from '../../../mx-insight-hub/server/external-platforms/static-client.mjs'
const write = 'w'.repeat(32), read = 'r'.repeat(32)
const projects = { 'mx-insight-hub': { write, read }, other: { write: 'o'.repeat(32), read: 'p'.repeat(32) } }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-static-test-'))
  const servers = []
  t.after(async () => {
    for (const server of servers) { await server.shutdown(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
    await rm(root, { recursive: true, force: true })
  })
  const start = async (extra = {}) => {
    const server = createStaticService({ root, projects, signingKey: 's'.repeat(32), minFreeBytes: 0, ...options, ...extra })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    servers.push(server)
    return `http://127.0.0.1:${server.address().port}`
  }
  return { root, start, url: await start() }
}
const ingest = (base, body, token = write) => fetch(`${base}/static/v1/projects/mx-insight-hub/ingest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
test('archives exact bytes, survives a new process reader, enforces project auth, signed expiry and Range', async t => {
  let calls = 0
  const { url, start } = await setup(t, { loader: async () => { calls++; return { body: png, contentType: 'image/png' } } })
  const response = await ingest(url, { url: 'https://cdn.example/image', scope: 'tenant-a' })
  assert.equal(response.status, 200)
  const meta = await response.json()
  const reader = await start({ readOnly: true, loader: () => { throw Error('offline') } })
  assert.equal((await ingest(reader, { url: 'https://cdn.example/image' })).status, 405)
  assert.equal((await fetch(reader + '/static/files/' + meta.key)).status, 401)
  assert.equal((await fetch(reader + '/static/files/' + meta.key, { headers: { authorization: 'Bearer ' + projects.other.read } })).status, 401)
  const image = await fetch(reader + meta.previewUrl)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
  const partial = await fetch(reader + meta.previewUrl, { headers: { range: 'bytes=1-5' } })
  assert.equal(partial.status, 206)
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(1, 6))
  assert.equal((await fetch(reader + meta.previewUrl.replace(/expires=\d+/, 'expires=1'))).status, 401)
  assert.equal((await ingest(url, { url: 'https://cdn.example/image', scope: 'tenant-a', mode: 'cache_only' })).status, 200)
  assert.equal((await ingest(url, { url: 'https://cdn.example/image', scope: 'tenant-b', mode: 'cache_only' })).status, 404)
  assert.equal(calls, 1)
})
test('refresh falls back to disk and Hub consumes verified bytes through its existing loader', async t => {
  let offline = false
  const { url } = await setup(t, { queueOptions: { maxAttempts: 1 }, loader: async () => { if (offline) throw Error('offline'); return { body: png, contentType: 'image/png' } } })
  const loader = withStaticArchive(() => { throw Error('fallback must not run') }, { baseUrl: url, token: write })
  assert.deepEqual((await loader('https://cdn.example/one', { cacheScope: 'tenant' })).body, png)
  await ingest(url, { url: 'https://cdn.example/refresh' })
  offline = true
  const refreshed = await ingest(url, { url: 'https://cdn.example/refresh', mode: 'refresh' })
  assert.equal((await refreshed.json()).sourceMode, 'stored_fallback')
  assert.deepEqual((await loader('https://cdn.example/one', { cacheScope: 'tenant' })).body, png)
  await ingest(url, { url: 'https://cdn.example/two', mode: 'cache_only' }).then(r => assert.equal(r.status, 404))
})
test('upload supports multipart; rejects HTML, read token writes, oversized content and disk exhaustion', async t => {
  const { url, start } = await setup(t)
  const upload = (body, type, token = write) => fetch(`${url}/static/v1/projects/mx-insight-hub/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...(type ? { 'content-type': type } : {}) }, body })
  const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), '../../evil.png')
  assert.equal((await upload(form)).status, 201)
  assert.equal((await upload('<script>alert(1)</script>', 'image/png')).status, 415)
  assert.equal((await upload(png, 'image/png', read)).status, 401)
  const small = await start({ maxBytes: 8 })
  assert.equal((await fetch(`${small}/static/v1/projects/mx-insight-hub/upload`, { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': 'image/png' }, body: png })).status, 413)
  const full = await start({ minFreeBytes: Number.MAX_SAFE_INTEGER })
  assert.equal((await fetch(`${full}/static/v1/projects/mx-insight-hub/upload`, { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': 'image/png' }, body: png })).status, 507)
})
test('URL ingestion rejects SSRF before fetching', async t => {
  const { url } = await setup(t)
  for (const source of ['https://127.0.0.1/a', 'http://169.254.169.254/latest', 'https://[::1]/']) {
    assert.equal((await ingest(url, { url: source })).status, 422)
  }
})
test('16 concurrent images are durably queued, duplicate requests coalesce, pending cache_only is 202', async t => {
  let release; const gate = new Promise(resolve => { release = resolve })
  let calls = 0, active = 0, peak = 0
  const { url } = await setup(t, { waitMs: 0, maxConcurrency: 3, loader: async (_, { signal }) => {
    calls++; active++; peak = Math.max(peak, active)
    await Promise.race([gate, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
    active--; return { body: png, contentType: 'image/png' }
  } })
  t.after(() => release())
  const accepted = await Promise.all(Array.from({ length: 16 }, (_, i) => ingest(url, { url: `https://cdn.example/${i}` })))
  assert.ok(accepted.every(r => r.status === 202))
  const metas = await Promise.all(accepted.map(r => r.json()))
  const duplicate = await ingest(url, { url: 'https://cdn.example/0', mode: 'cache_only' })
  assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).id, metas[0].id)
  assert.equal(calls, 3); release()
  for (const meta of metas) {
    let status
    for (let i = 0; i < 100; i++) {
      status = await fetch(url + meta.statusUrl, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
      if (status.state === 'ready') break
      await new Promise(r => setTimeout(r, 10))
    }
    assert.equal(status.state, 'ready')
    assert.deepEqual(Buffer.from(await fetch(url + status.previewUrl).then(r => r.arrayBuffer())), png)
  }
  assert.equal(calls, 16); assert.equal(peak, 3)
  await Promise.all(Array.from({ length: 16 }, (_, i) => ingest(url, { url: `https://cdn.example/${i}` })))
  assert.equal(calls, 16)
})
test('RAM expiry reloads durable bytes without upstream and capacity rejection does not erase accepted jobs', async t => {
  let calls = 0
  const { url, start } = await setup(t, { cacheOptions: { ttlMs: 25 }, loader: async () => { calls++; return { body: png, contentType: 'image/png' } } })
  const meta = await ingest(url, { url: 'https://cdn.example/cache' }).then(r => r.json())
  await fetch(url + meta.previewUrl).then(r => r.arrayBuffer())
  assert.equal((await fetch(url + meta.previewUrl)).headers.get('x-mx-static-cache'), 'memory')
  await new Promise(r => setTimeout(r, 35))
  const disk = await fetch(url + meta.previewUrl)
  assert.equal(disk.headers.get('x-mx-static-cache'), 'disk')
  assert.deepEqual(Buffer.from(await disk.arrayBuffer()), png); assert.equal(calls, 1)
  const paused = await start({ workerEnabled: false, waitMs: 0, queueOptions: { maxQueued: 1 } })
  const one = await ingest(paused, { url: 'https://cdn.example/paused' }).then(r => r.json())
  assert.equal((await ingest(paused, { url: 'https://cdn.example/overflow' })).status, 429)
  assert.equal((await ingest(paused, { url: 'https://cdn.example/paused' }).then(r => r.json())).id, one.id)
})
test('response deadline is bounded while accepted background work survives', async t => {
  const { url } = await setup(t, { ioTimeoutMs: 25, loader: async () => {
    await new Promise(resolve=>setTimeout(resolve,100)); return {body:png,contentType:'image/png'}
  } })
  const response=await ingest(url,{url:'https://cdn.example/slow'})
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,'storage_io_timeout')
  assert.equal((await fetch(url+'/static/health')).status,200)
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal((await ingest(url,{url:'https://cdn.example/slow',mode:'cache_only'})).status,200)
})
