import test from 'node:test'
import assert from 'node:assert/strict'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { aggregateSourceCatalog, normalizeAggregateRequest } from '../../server/data/aggregate-search.mjs'

async function fixture(t) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline aggregate fixture cannot dispatch network') })
  const store = new MemoryStore(), dispatches = [], reads = []
  const adapter = { search: async () => assert.fail('Migrated aggregate must not acquire through Night-All'), capabilities: async () => assert.fail('Discovery must not consult Night-All') }
  const service = new HubService({ store, adapter, apiKeyPepper: 'content-aggregate-fixture-pepper-at-least-32-characters',
    externalContentSearchCapabilities: async options => { reads.push(options); return { bilibili: { ready: true }, douyin: { ready: false } } },
    externalDataSearch: async (context, input) => {
      dispatches.push({ context, input })
      return { status: 200, requestId: `fixture-${input.normalized.platform}`, replay: false, body: { data: {
        items: [{ id: `${input.normalized.platform}-1`, platform: input.normalized.platform, title: '原生标题', text: '完整正文', metrics: { likes: 0 } }],
        pageInfo: { hasMore: false, nextCursor: null }, status: 'ok' } } }
    } })
  const tenant = await service.createTenant({ name: 'Direct aggregate fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Content-only caller' })
  for (const platform of ['bilibili', 'douyin']) await service.putPlatformConfiguration(platform, { tenantId: tenant.id, consumerId: consumer.id,
    enabled: true, maxRequests: 100, windowSeconds: 60, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Content-only key', platforms: ['bilibili', 'douyin'], capabilities: [] })
  t.after(async () => { await store.close(); assert.equal(network.mock.callCount(), 0) })
  return { store, service, context: await service.authenticate(key.secret), reads, dispatches, consumer }
}

test('Hub-only discovery adds only fixed migrated content platforms under existing platform grants', () => {
  const sources = aggregateSourceCatalog(['bilibili', 'douyin', 'kuaishou', 'zhihu', 'weibo', 'twitter'], [], [], 'hub_only')
  for (const platform of ['bilibili', 'douyin', 'kuaishou', 'zhihu']) {
    const row = sources.find(row => row.platform === platform)
    assert.equal(row.refresh, true)
    assert.deepEqual(row.routes.map(route => route.kind), ['hub_content'])
  }
  assert.equal(sources.find(row => row.platform === 'weibo').refresh, false)
  assert.equal(sources.find(row => row.platform === 'twitter').refresh, false, 'Twitter still needs its separate existing social capability')
  assert.doesNotMatch(JSON.stringify(sources), /tikhub|native\.|Night-All/)
  assert.throws(() => normalizeAggregateRequest({ query: 'fixture', execution: 'hub_only', platforms: ['facebook'] }, sources), { code: 'platform_not_granted' })
  const forged = [{ platform: 'weibo', stored: true, routes: [{ platform: 'weibo', kind: 'hub_content', operation: 'data.search', objectType: 'post' }] }]
  assert.throws(() => normalizeAggregateRequest({ query: 'fixture', execution: 'hub_only' }, forged), { code: 'invalid_request' })
})

test('aggregate preview reads only selected content metadata, preserves platform meters and performs no acquisition or reservation', async t => {
  const f = await fixture(t), before = f.store.requests.size
  const input = { query: '城市', execution: 'hub_only', platforms: ['bilibili', 'douyin'] }
  const preview = await f.service.aggregatePreview(f.context, input)
  assert.equal(preview.dispatches, 0)
  assert.equal(preview.parentChargeMinor, 0)
  assert.deepEqual(preview.items.map(row => [row.platform, row.meterKey, row.readiness]), [['bilibili', 'bilibili', 'ready'], ['douyin', 'douyin', 'unavailable']])
  assert.deepEqual(f.reads.map(row => row.platforms), [['bilibili', 'douyin']])
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.store.requests.size, before)
  assert.deepEqual(await f.store.listEffectiveCapabilityGrants(f.consumer.id, f.context.apiKey.id), [])
  await assert.rejects(f.service.aggregatePreview(f.context, { ...input, platforms: ['zhihu'] }), { code: 'platform_not_granted' })
  assert.equal(f.reads.length, 1, 'foreign platform is rejected before metadata reads')
  await f.service.aggregatePreview({ ...f.context, apiKey: { ...f.context.apiKey, environment: 'test' } }, input)
  assert.equal(f.reads.length, 1, 'Test key does not claim live readiness')
})

test('Hub-only aggregate refresh executes the existing direct standard boundary and preserves exact parent replay without native grants', async t => {
  const f = await fixture(t), input = { body: { query: '城市', execution: 'hub_only', platforms: ['bilibili', 'douyin'] },
    idempotencyKey: 'direct-content-aggregate', path: '/api/v1/data/aggregate/search' }
  const first = await f.service.aggregateSearch(f.context, input)
  assert.equal(first.status, 200)
  assert.deepEqual(f.dispatches.map(row => row.input.normalized.platform).sort(), ['bilibili', 'douyin'])
  assert(f.dispatches.every(row => row.input.dataSearch && row.input.body.platform === row.input.normalized.platform))
  assert.equal(first.body.data.items.length, 2)
  assert(first.body.data.sources.every(row => ['ok', 'empty'].includes(row.status)))
  assert.deepEqual(await f.store.listEffectiveCapabilityGrants(f.consumer.id, f.context.apiKey.id), [])
  const replay = await f.service.aggregateSearch(f.context, input)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, first.body)
  assert.equal(f.dispatches.length, 2)
})
