import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createStaticService } from '../src/service.mjs'
import { Settings } from '../src/settings.mjs'

const write = 'w'.repeat(32), read = 'r'.repeat(32), admin = 'a'.repeat(40)
const projects = { 'mx-insight-hub': { write, read } }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=', 'base64')
const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(2 * 1024 * 1024, 9)])

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-settings-'))
  const state = join(root, 'state')
  const store = new Settings(state)
  const servers = []
  t.after(async () => {
    for (const server of servers) { await server.shutdown(); await new Promise(r => { server.close(r); server.closeAllConnections() }) }
    store.close(); await rm(root, { recursive: true, force: true })
  })
  const start = async (extra = {}) => {
    const server = createStaticService({ root, stateDir: state, projects, signingKey: 's'.repeat(32), minFreeBytes: 0,
      settings: store, adminToken: admin, env: {}, loader: async () => ({ body: png, contentType: 'image/png' }), ...options, ...extra })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    servers.push(server)
    return `http://127.0.0.1:${server.address().port}`
  }
  return { root, state, store, start, url: await start() }
}
const settingsApi = (base, init, token = admin) => fetch(`${base}/static/v1/admin/settings`,
  { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init || {}).headers } })

test('a malformed .env never stops the service; it degrades and reports', async t => {
  const { url } = await setup(t, { env: {
    MX_STATIC_SLO_ASSET_QPS: 'ten', MX_STATIC_SLO_VIDEO_VIEWERS: '-3',
    MX_STATIC_NAS_VERIFY: 'maybe', MX_STATIC_MAX_LAG_MS: '1e99', MX_STATIC_CACHE_TTL_MS: '',
  } })
  assert.equal((await fetch(`${url}/static/health`)).status, 200)
  const body = await settingsApi(url).then(r => r.json())
  assert.equal(body.values.assetQps, 10, 'fell back to the default')
  assert.equal(body.values.videoViewers, 30)
  assert.equal(body.values.nasVerify, 'always')
  const warnings = body.warnings.join('\n')
  assert.match(warnings, /MX_STATIC_SLO_ASSET_QPS: expected a whole number/)
  assert.match(warnings, /MX_STATIC_SLO_VIDEO_VIEWERS: must be between/)
  assert.match(warnings, /MX_STATIC_NAS_VERIFY: expected one of/)
})

test('a live setting takes effect without a restart', async t => {
  const { url } = await setup(t)
  const upload = async (body, type) => (await fetch(`${url}/static/v1/projects/mx-insight-hub/upload`,
    { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': type }, body })).json()
  const video = await upload(mp4, 'video/mp4')
  const headers = { authorization: `Bearer ${read}` }

  const applied = await settingsApi(url, { method: 'PUT', body: JSON.stringify({ maxVideoStreams: 1 }) }).then(r => r.json())
  assert.deepEqual(applied.applied, { maxVideoStreams: 1 })
  assert.deepEqual(applied.rejected, {})

  const parked = await fetch(`${url}/static/files/${video.key}`, { headers })
  const reader = parked.body.getReader(); await reader.read()
  t.after(() => reader.cancel().catch(() => {}))
  const second = await fetch(`${url}/static/files/${video.key}`, { headers })
  assert.equal(second.status, 503)
  assert.equal((await second.json()).error.code, 'storage_stream_busy')

  // And raising it again is equally live.
  await settingsApi(url, { method: 'PUT', body: JSON.stringify({ maxVideoStreams: 8 }) })
  const third = await fetch(`${url}/static/files/${video.key}`, { headers })
  assert.equal(third.status, 200)
  await third.body.cancel()
})

test('settings that cannot be changed at runtime are refused with a reason', async t => {
  const { url } = await setup(t)
  const body = await settingsApi(url, { method: 'PUT', body: JSON.stringify({ maxBytes: 1024, nasVerify: 'never', nope: 1, assetQps: 'lots' }) }).then(r => r.json())
  assert.deepEqual(body.applied, {})
  assert.match(body.rejected.maxBytes, /not adjustable at runtime/)
  assert.match(body.rejected.nasVerify, /not adjustable at runtime/)
  assert.equal(body.rejected.nope, 'unknown setting')
  assert.match(body.rejected.assetQps, /expected a whole number/)
})

test('an override persists, is reported, and can be cleared', async t => {
  const { url, store } = await setup(t)
  await settingsApi(url, { method: 'PUT', body: JSON.stringify({ assetQps: 250 }) })
  assert.deepEqual(store.read(), { assetQps: 250 })
  let body = await settingsApi(url).then(r => r.json())
  assert.equal(body.values.assetQps, 250)
  assert.equal(body.overrides.assetQps, 250)
  assert.ok(body.limits.maxAssetStreams > 16, 'the derived permits moved with it')

  await settingsApi(url, { method: 'PUT', body: JSON.stringify({ assetQps: null }) })
  body = await settingsApi(url).then(r => r.json())
  assert.equal(body.values.assetQps, 10, 'cleared back to the environment/default layer')
  assert.deepEqual(body.overrides, {})
})

test('a change made by another process is picked up without a restart', async t => {
  const { url, store } = await setup(t)
  store.write({ maxVideoStreams: 3 }) // as a second container would
  for (let attempt = 0; attempt < 60; attempt++) {
    const body = await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
    if (body.live.videoStreams.limit === 3) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('the settings change was never observed')
})

test('the console and its API need the admin token, and vanish without one', async t => {
  const { url, start } = await setup(t)
  assert.equal((await settingsApi(url, {}, 'wrong'.repeat(8))).status, 401)
  assert.equal((await fetch(`${url}/static/v1/admin/settings`)).status, 401)
  const page = await fetch(`${url}/static/admin`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const html = await page.text()
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-[0-9a-f]{32}'/)
  assert.equal(html.includes(admin), false, 'the page must not embed the token')

  const closed = await start({ adminToken: '' })
  assert.equal((await fetch(`${closed}/static/admin`)).status, 404)
  assert.equal((await settingsApi(closed)).status, 404)
})

test('videos and images draw from separate download pools', async t => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const { url } = await setup(t, {
    env: { MX_STATIC_IMAGE_WORKERS: '1', MX_STATIC_VIDEO_WORKERS: '1' }, waitMs: 0,
    loader: async (_, { signal }) => {
      await Promise.race([gate, new Promise(r => signal.addEventListener('abort', r, { once: true }))])
      return { body: png, contentType: 'image/png' }
    },
  })
  t.after(() => release())
  const ingest = body => fetch(`${url}/static/v1/projects/mx-insight-hub/ingest/batch`,
    { method: 'POST', headers: { authorization: `Bearer ${write}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const { results } = await ingest({ items: [
    'https://cdn.example/a.jpg', 'https://cdn.example/b.png',
    'https://cdn.example/c.mp4', 'https://cdn.example/d.webm?token=x',
  ] }).then(r => r.json())
  assert.deepEqual(results.map(entry => entry.kind), ['image', 'image', 'video', 'video'])

  for (let attempt = 0; attempt < 60; attempt++) {
    const live = await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
    // One of each is in flight: the two queued videos never took the image slot.
    if (live.live.downloads.image.inUse === 1 && live.live.downloads.video.inUse === 1) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail('the two pools never ran side by side')
})

test('an unreadable settings store degrades to .env instead of stopping startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mx-settings-broken-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A store whose queries always fail, as a replica sees before the writer has
  // created the WAL files on a read-only mount.
  const broken = { read: () => { throw Object.assign(new Error('unable to open database file'), { code: 'SQLITE_CANTOPEN' }) },
    revision: () => { throw new Error('unable to open database file') } }
  const guarded = { read: () => { try { return broken.read() } catch { return {} } }, revision: () => { try { return broken.revision() } catch { return { at: -1, n: -1 } } } }
  const server = createStaticService({ root, projects, signingKey: 's'.repeat(32), minFreeBytes: 0,
    settings: guarded, env: { MX_STATIC_SLO_VIDEO_VIEWERS: '40' } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { await server.shutdown(); await new Promise(r => { server.close(r); server.closeAllConnections() }) })
  assert.equal((await fetch(`${url}/static/health`)).status, 200)
  const live = await fetch(`${url}/static/v1/projects/mx-insight-hub/capacity`, { headers: { authorization: `Bearer ${read}` } }).then(r => r.json())
  assert.equal(live.live.videoStreams.limit, 80, 'still derived from the environment')
})

test('Settings.read and .revision never throw on a broken store', async t => {
  const { Settings: Store } = await import('../src/settings.mjs')
  const root = await mkdtemp(join(tmpdir(), 'mx-settings-closed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new Store(root)
  store.db.close() // simulate the handle going away underneath us
  assert.deepEqual(store.read(), {})
  assert.deepEqual(store.revision(), { at: -1, n: -1 })
})
