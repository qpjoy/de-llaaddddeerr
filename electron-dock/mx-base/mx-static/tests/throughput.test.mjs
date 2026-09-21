import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createStaticService } from '../src/service.mjs'

const write = 'w'.repeat(32), read = 'r'.repeat(32)
const projects = { 'mx-insight-hub': { write, read } }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-throughput-'))
  const servers = []
  t.after(async () => {
    for (const server of servers) { await server.shutdown(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
    await rm(root, { recursive: true, force: true })
  })
  const start = async (extra = {}) => {
    const server = createStaticService({ root, projects, signingKey: 's'.repeat(32), minFreeBytes: 0,
      loader: async () => ({ body: png, contentType: 'image/png' }), ...options, ...extra })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    servers.push(server)
    return `http://127.0.0.1:${server.address().port}`
  }
  return { root, start, url: await start() }
}
const api = (base, path, body, token = write) => fetch(`${base}/static/v1/projects/mx-insight-hub${path}`,
  { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const batch = (base, body, token) => api(base, '/ingest/batch', body, token)
const single = (base, body, token) => api(base, '/ingest', body, token)

test('one batch accepts a whole upstream page, coalescing duplicates inside it', async t => {
  const { url } = await setup(t, { workerEnabled: false })
  // 10 records x 6 media, with every URL sent twice, as a fan-out client would.
  const items = []
  for (let record = 0; record < 10; record++) for (let media = 0; media < 6; media++) items.push(`https://cdn.example/r${record}/m${media}.jpg`)
  const response = await batch(url, { scope: 'tenant-a', items: [...items, ...items] })
  assert.equal(response.status, 200)
  const { results } = await response.json()
  assert.equal(results.length, 120)
  const ids = results.map(entry => entry.id)
  assert.equal(ids.every(Boolean), true, 'every item got a durable job')
  assert.equal(new Set(ids).size, 60, 'duplicates inside the batch share one job')
  assert.deepEqual(ids.slice(0, 60), ids.slice(60), 'the repeat half maps onto the first half')
  const listed = await fetch(`${url}/static/v1/projects/mx-insight-hub/jobs`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
  assert.equal(listed.counts.queued, 60)
})

test('a batch coalesces with work already accepted one URL at a time', async t => {
  const { url } = await setup(t, { workerEnabled: false })
  const first = await single(url, { url: 'https://cdn.example/shared.jpg', scope: 's' }).then(r => r.json())
  const { results } = await batch(url, { scope: 's', items: ['https://cdn.example/shared.jpg', 'https://cdn.example/fresh.jpg'] }).then(r => r.json())
  assert.equal(results[0].id, first.id)
  assert.notEqual(results[1].id, first.id)
})

test('per-item failures do not fail the batch, and capacity is reported per item', async t => {
  const { url } = await setup(t, { workerEnabled: false, queueOptions: { maxQueued: 2 } })
  const { results } = await batch(url, { items: [
    'https://cdn.example/a.jpg', { url: 'https://cdn.example/b.jpg' }, 'https://cdn.example/c.jpg',
    { url: 42 }, { url: 'https://cdn.example/d.jpg', mode: 'cache_only' },
  ] }).then(r => r.json())
  assert.equal(results.length, 5)
  assert.equal(results[0].state, 'queued')
  assert.equal(results[1].state, 'queued')
  assert.deepEqual(results[2], { error: { code: 'queue_full' }, status: 429 })
  assert.deepEqual(results[3], { error: { code: 'invalid_request' }, status: 400 })
  assert.deepEqual(results[4], { error: { code: 'stored_media_not_found' }, status: 404 })
})

test('a batch returns stored results for URLs already archived', async t => {
  const { url } = await setup(t)
  const stored = await single(url, { url: 'https://cdn.example/known.jpg', scope: 't' }).then(r => r.json())
  assert.equal(stored.sourceMode, 'live')
  const { results } = await batch(url, { scope: 't', items: ['https://cdn.example/known.jpg'] }).then(r => r.json())
  assert.equal(results[0].sourceMode, 'stored_cache')
  assert.equal(results[0].key, stored.key)
})

test('batch input is bounded', async t => {
  const { url } = await setup(t, { workerEnabled: false, maxBatch: 3 })
  assert.equal((await batch(url, { items: ['a', 'b', 'c', 'd'].map(n => `https://cdn.example/${n}.jpg`) })).status, 400)
  assert.equal((await batch(url, { items: [] })).status, 400)
  assert.equal((await batch(url, {})).status, 400)
  assert.equal((await batch(url, { items: ['https://cdn.example/a.jpg'] }, read)).status, 401)
})

test('immutable objects are cacheable, but never past a signed link expiry', async t => {
  const { url } = await setup(t)
  const stored = await single(url, { url: 'https://cdn.example/photo.jpg' }).then(r => r.json())
  const bearer = await fetch(`${url}/static/files/${stored.key}`, { headers: { authorization: `Bearer ${read}` } })
  assert.match(bearer.headers.get('cache-control'), /^private, max-age=900, immutable$/)

  const signed = new URL(stored.previewUrl, url)
  const response = await fetch(signed)
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control'))[1])
  const remaining = Number(signed.searchParams.get('expires')) - Math.floor(Date.now() / 1000)
  assert.ok(maxAge <= remaining, `max-age ${maxAge} outlives the signature by ${maxAge - remaining}s`)
  assert.ok(maxAge > 0 && maxAge <= 900)
  assert.match(response.headers.get('cache-control'), /immutable/)
})

test('a long byte transfer does not consume the disk-read budget', async t => {
  // Larger than the body cache accepts, so it is served by streaming the file.
  const video = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(24 * 1024 * 1024, 9)])
  const { url } = await setup(t, { maxReads: 1, maxVideoStreams: 4 })
  const upload = async (body, type) => (await fetch(`${url}/static/v1/projects/mx-insight-hub/upload`,
    { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': type }, body })).json()
  const big = await upload(video, 'video/mp4')
  const small = await upload(png, 'image/png')
  const headers = { authorization: `Bearer ${read}` }

  const stream = await fetch(`${url}/static/files/${big.key}`, { headers })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  await reader.read() // In flight and deliberately left unconsumed.
  t.after(() => reader.cancel().catch(() => {}))

  // maxReads is 1: before the split, the parked video held that single permit.
  const alongside = await fetch(`${url}/static/files/${small.key}`, { headers })
  assert.equal(alongside.status, 200)
  assert.deepEqual(Buffer.from(await alongside.arrayBuffer()), png)
})

const bigPng = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024, 1)])
const bigMp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(2 * 1024 * 1024, 9)])
const park = async (t, url, key) => {
  const response = await fetch(`${url}/static/files/${key}`, { headers: { authorization: `Bearer ${read}` } })
  const reader = response.body.getReader()
  await reader.read()
  t.after(() => reader.cancel().catch(() => {}))
  return response
}

test('videos cannot exhaust the budget reserved for images and static assets', async t => {
  const { url } = await setup(t, { maxReads: 32, maxVideoStreams: 2, maxAssetStreams: 4 })
  const upload = async (body, type) => (await fetch(`${url}/static/v1/projects/mx-insight-hub/upload`,
    { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': type }, body })).json()
  const video = await upload(bigMp4, 'video/mp4')
  const image = await upload(bigPng, 'image/png')

  assert.equal((await park(t, url, video.key)).status, 200)
  assert.equal((await park(t, url, video.key)).status, 200)
  // The video class is now full ...
  const third = await fetch(`${url}/static/files/${video.key}`, { headers: { authorization: `Bearer ${read}` } })
  assert.equal(third.status, 503)
  assert.equal((await third.json()).error.code, 'storage_stream_busy')
  // ... and the asset class is untouched by it.
  const asset = await fetch(`${url}/static/files/${image.key}`, { headers: { authorization: `Bearer ${read}` } })
  assert.equal(asset.status, 200)
  assert.equal((await asset.arrayBuffer()).byteLength, bigPng.length)
})

test('under event-loop pressure video sheds first and assets still serve', async t => {
  const { url } = await setup(t, { maxLagMs: 5 })
  const upload = async (body, type) => (await fetch(`${url}/static/v1/projects/mx-insight-hub/upload`,
    { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': type }, body })).json()
  const video = await upload(bigMp4, 'video/mp4')
  const image = await upload(bigPng, 'image/png')
  const headers = { authorization: `Bearer ${read}` }

  const until = Date.now() + 500
  while (Date.now() < until) { /* deliberately stall the shared event loop */ }
  await new Promise(resolve => setTimeout(resolve, 60)) // let the lag gauge sample it

  const shed = await fetch(`${url}/static/files/${video.key}`, { headers })
  assert.equal(shed.status, 503)
  assert.equal((await shed.json()).error.code, 'storage_overloaded')
  assert.equal(shed.headers.get('retry-after'), '1')

  const asset = await fetch(`${url}/static/files/${image.key}`, { headers })
  assert.equal(asset.status, 200, 'the asset class is never shed on lag')
})

test('capacity reports the promise, the bandwidth it implies, and live usage', async t => {
  const { url } = await setup(t, { slo: { assetQps: 10, videoViewers: 30, videoBitrateKbps: 3000 } })
  const response = await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`, { headers: { authorization: `Bearer ${read}` } })
  assert.equal(response.status, 200)
  const plan = await response.json()
  assert.equal(plan.feasible, true)
  assert.equal(plan.slo.videoViewers, 30)
  assert.equal(plan.limits.maxVideoStreams, 60)
  assert.equal(plan.budget.videoMbps, 90)
  assert.equal(plan.live.videoStreams.limit, 60)
  assert.equal(plan.live.assetStreams.inUse, 0)
  assert.ok(Number.isFinite(plan.live.eventLoopLagMs))
  assert.equal((await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`)).status, 401)
})

test('an unachievable service level is reported instead of quietly accepted', async t => {
  const { url } = await setup(t, { slo: { videoViewers: 200, videoBitrateKbps: 8000, linkMbps: 1000 } })
  const plan = await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
  assert.equal(plan.feasible, false)
  assert.match(plan.warnings.join(' '), /^link:/)
  assert.ok(plan.budget.linkUtilisation > 1)
})

test('a synchronous ingest wakes on completion instead of polling for it', async t => {
  const { url } = await setup(t, { waitMs: 5000, loader: async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    return { body: png, contentType: 'image/png' }
  } })
  const started = Date.now()
  const response = await single(url, { url: 'https://cdn.example/quick.jpg' })
  const elapsed = Date.now() - started
  assert.equal(response.status, 200)
  assert.equal((await response.json()).sourceMode, 'live')
  // The safety poll is 250 ms; returning well inside it proves the waiter was
  // woken by the completion rather than by the next tick.
  assert.ok(elapsed < 220, `took ${elapsed} ms, which looks like a poll interval rather than a wake-up`)
})

test('a burst answered from memory is never shed for lack of a disk permit', async t => {
  // One disk permit in total: every one of these must still be served.
  const { url } = await setup(t, { maxReads: 1 })
  const stored = await single(url, { url: 'https://cdn.example/hot.jpg' }).then(r => r.json())
  const headers = { authorization: `Bearer ${read}` }
  await fetch(`${url}/static/files/${stored.key}`, { headers }).then(r => r.arrayBuffer()) // warm

  const responses = await Promise.all(Array.from({ length: 60 }, () => fetch(`${url}/static/files/${stored.key}`, { headers })))
  const statuses = responses.map(r => r.status)
  await Promise.all(responses.map(r => r.arrayBuffer()))
  assert.deepEqual([...new Set(statuses)], [200], `some cache hits were shed: ${statuses.filter(s => s !== 200).length}`)
  assert.equal(responses.every(r => r.headers.get('x-mx-static-cache') === 'memory'), true)
})

test('with an internal location configured, nginx is handed the transfer', async t => {
  const { url } = await setup(t, { accelRedirect: '/internal-objects', cacheOptions: { ttlMs: 0 } })
  const stored = await single(url, { url: 'https://cdn.example/delegated.jpg' }).then(r => r.json())
  const headers = { authorization: `Bearer ${read}` }

  const response = await fetch(`${url}/static/files/${stored.key}`, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-accel-redirect'), `/internal-objects/${stored.key}`)
  assert.equal(response.headers.get('x-mx-static-cache'), 'accel')
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal((await response.arrayBuffer()).byteLength, 0, 'this process sends no bytes')

  // Authorisation still happens here, and a cold object still goes through the
  // restore flow rather than being handed to nginx to 404 on.
  assert.equal((await fetch(`${url}/static/files/${stored.key}`)).status, 401)
  assert.equal((await fetch(`${url}/static/files/${stored.key}`, { headers, method: 'HEAD' })).headers.get('x-accel-redirect'), null)
})

test('capacity reports observed latency per class, not just limits', async t => {
  const { url } = await setup(t)
  const stored = await single(url, { url: 'https://cdn.example/measured.jpg' }).then(r => r.json())
  for (let i = 0; i < 5; i++) await fetch(`${url}/static/files/${stored.key}`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.arrayBuffer())
  const plan = await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
  assert.ok(plan.live.latencyMs.asset.count >= 5, 'asset reads were sampled')
  assert.ok(plan.live.latencyMs.ingest.count >= 1, 'ingest was sampled')
  for (const key of ['p50', 'p95', 'p99', 'max']) assert.equal(typeof plan.live.latencyMs.asset[key], 'number')
  assert.ok(plan.live.latencyMs.asset.p50 <= plan.live.latencyMs.asset.max)
  assert.deepEqual(plan.live.latencyMs.video, { count: 0 }, 'a class with no traffic reports no percentiles')
})
