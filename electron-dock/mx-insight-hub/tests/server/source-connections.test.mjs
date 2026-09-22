import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { sourceConnectionSnapshot } from '../../server/data/source-connections.mjs'
import { SOURCE_CATALOG_SEED } from '../../server/data/source-catalog-seed.mjs'
import { PUBLIC_OPINION_DATASET_ID } from '../../server/data/public-opinion.mjs'

test('inventory separates content, account, commerce and multi-source stored routes without changing catalog authority', () => {
  const entries = structuredClone(SOURCE_CATALOG_SEED)
  const before = structuredClone(entries)
  const snapshot = sourceConnectionSnapshot(entries, [])
  assert.deepEqual(entries, before)
  assert.equal(new Set(snapshot.routes.map(row => row.id)).size, snapshot.routes.length)
  const xhs = snapshot.routes.filter(row => row.catalogKeys.includes('source-catalog-0004'))
  assert.ok(xhs.some(row => row.mode === 'compatibility'))
  assert.ok(xhs.some(row => row.operation === 'social.posts.search' && row.sourceLabel === 'T 平台'))
  assert.ok(xhs.some(row => row.operation === 'social.accounts.search'))
  const shops = snapshot.routes.filter(row => row.catalogKeys.includes('source-catalog-0064'))
  assert.ok(shops.some(row => row.operation === 'ecommerce.products.search'))
  assert.ok(shops.every(row => row.operation !== 'social.posts.search'))
  const telegram = snapshot.routes.filter(row => row.platform === 'telegram')
  assert.equal(telegram.length, 2)
  assert.equal(new Set(telegram.flatMap(row => row.sourceKeys)).size, 4)
  assert.ok(telegram.every(row => row.mode === 'stored'))
  assert.deepEqual(snapshot.routes.find(row => row.id === 'public-opinion').datasets, [PUBLIC_OPINION_DATASET_ID])
  assert.ok(!snapshot.routes.some(row => row.catalogKeys.includes('source-catalog-0019')), 'news category must not invent Phoenix coverage')
  assert.equal(snapshot.routes.find(row => row.id === 'ip-risk').keywordSearch, false)
  assert.equal(snapshot.routes.find(row => row.id === 'enterprise').keywordSearch, false)
  assert.ok(snapshot.routes.every(row => row.runtimeStatus === 'not_checked'))
})

test('runtime inputs include new saved-record categories but never connection credentials or invented health', () => {
  const sources = [
    { sourceKey: 'telegram-monitor-messages', status: 'paused', connection: { password: 'source-secret', host: 'private-host' } },
    { sourceKey: 'night-all-saved-records-science', status: 'active', connection: { token: 'secret-token' } },
  ]
  const snapshot = sourceConnectionSnapshot(SOURCE_CATALOG_SEED, sources)
  const telegram = snapshot.routes.find(row => row.id === 'telegram-monitor')
  assert.deepEqual(telegram.inputs, [
    { key: 'telegram-monitor-chats', registered: false, status: 'not_registered' },
    { key: 'telegram-monitor-messages', registered: true, status: 'paused' },
  ])
  const science = snapshot.routes.find(row => row.id === 'saved-science')
  assert.equal(science.sourceProviderLabel, 'Night-All-A')
  assert.equal(science.inputs[0].registered, true)
  assert.equal(science.runtimeStatus, 'not_checked')
  assert.equal(snapshot.summary.registeredInputs, 2)
  assert.doesNotMatch(JSON.stringify(snapshot), /source-secret|private-host|secret-token|connection"|tikhub/iu)
  const renamed = SOURCE_CATALOG_SEED.map(row => row.sourceKey === 'source-catalog-0004' ? { ...row, canonicalName: '新名称', archivedAt: '2026-09-22' } : row)
  const next = sourceConnectionSnapshot(renamed, sources)
  assert.equal(next.routes.find(row => row.id === 'xiaohongshu-posts').platformLabel, '新名称')
  assert.equal(next.summary.catalogEntries, snapshot.summary.catalogEntries - 1)
})

test('connection inventory is Admin-token-only, local-read-only and independent of provider readiness', async t => {
  const store = new MemoryStore()
  const original = await store.listSourceCatalogEntries({ includeArchived: true })
  let upstreamCalls = 0
  const forbidden = async () => { upstreamCalls++; throw new Error('upstream must not run') }
  const app = createApp({ store, service: {}, adapter: { capabilities: forbidden, search: forbidden },
    externalPlatformAdmin: { overview: forbidden }, adminToken: 'inventory-admin',
    identity: { enabled: true, resolve: async () => ({ kind: 'launcher', platformAdmin: true }) },
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const path = '/internal/v1/admin/source-connections'
  assert.equal((await fetch(base + path)).status, 401)
  assert.equal((await fetch(base + path, { headers: { authorization: 'Bearer launcher-session' } })).status, 403)
  const headers = { 'x-mx-insight-admin-token': 'inventory-admin' }
  const response = await fetch(base + path, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const body = await response.json()
  assert.ok(body.data.routes.length > 0)
  assert.equal((await fetch(base + path + '?provider=tikhub', { headers })).status, 400)
  assert.equal(upstreamCalls, 0)
  assert.deepEqual(await store.listSourceCatalogEntries({ includeArchived: true }), original)
})
