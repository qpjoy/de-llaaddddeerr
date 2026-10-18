import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

async function fixture() {
  const store = new MemoryStore()
  const searches = []
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'canonical-admission-test-pepper-with-enough-entropy',
    searchQueries: { async searchContent(query, options) {
      searches.push({ query, options })
      return { mode: 'postgres', items: [], total: 0, totalRelation: 'eq', hasMore: false }
    } } })
  const tenant = await service.createTenant({ name: 'Admission tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Admission consumer' })
  for (const [platform, maxRequests, windowSeconds, maxPageSize] of [
    ['telegram', 3, 120, 2], ['xiaohongshu', 8, 60, 5],
  ]) await service.putPlatformConfiguration(platform, {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests, windowSeconds, maxPageSize,
  })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Admission key', platforms: ['telegram', 'xiaohongshu'] })
  const context = await service.authenticate(key.secret)
  const request = (id, body = {}) => service.canonicalSearch(context, {
    body: { query: 'agent', pageSize: 1, ...body }, idempotencyKey: `admission-${id}`, path: '/api/v1/data/canonical/search',
  })
  return { store, service, consumer, key, searches, request }
}

test('canonical admission uses bounded current reads and keeps conservative quotas, replay and live policy changes', async () => {
  const { store, consumer, searches, request } = await fixture()
  const reads = {}
  for (const method of ['getPolicy', 'listPolicies', 'getConsumerPlan', 'getApiKeyPlatformEntitlement', 'listApiKeyPlatformEntitlements']) {
    const original = store[method].bind(store)
    store[method] = async (...args) => { reads[method] = (reads[method] || 0) + 1; return original(...args) }
  }
  const reservations = []
  const reserve = store.reserve.bind(store)
  store.reserve = async input => { reservations.push(input); return reserve(input) }
  const before = Date.now()
  const first = await request('one', { platform: 'xiaohongshu', pageSize: 2 })
  assert.equal(first.status, 200)
  assert.deepEqual(reads, { listPolicies: 1, listApiKeyPlatformEntitlements: 1, getConsumerPlan: 1 })
  assert.equal(reservations[0].maxRequests, 3)
  assert.deepEqual(reservations[0].authorizationPlatforms, ['telegram', 'xiaohongshu'])
  assert.deepEqual(reservations[0].apiKeyQuota, { maxRequests: 3, windowSeconds: 120 })
  assert.ok(+reservations[0].windowStart >= before - 120_000)
  assert.ok(+reservations[0].windowStart <= Date.now() - 120_000)
  assert.equal((await request('one', { platform: 'xiaohongshu', pageSize: 2 })).replay, true)
  assert.equal(searches.length, 1)
  await assert.rejects(request('too-wide', { platform: 'xiaohongshu', pageSize: 3 }), { code: 'page_size_exceeded' })
  // A subsequent request must observe a tightened policy, even with the same
  // authenticated context and an explicit, less restrictive platform filter.
  store.policies.get(`${consumer.id}:telegram`).maxPageSize = 1
  await assert.rejects(request('new-policy', { platform: 'xiaohongshu', pageSize: 2 }), { code: 'page_size_exceeded' })
  assert.equal(searches.length, 1)
  assert.equal(reads.getConsumerPlan, 4)
})

test('canonical admission keeps plan and key page limits with batched and legacy store interfaces', async t => {
  for (const batched of [true, false]) await t.test(batched ? 'batched' : 'legacy getters', async () => {
    const { store, key, searches, request } = await fixture()
    if (!batched) { store.listPolicies = undefined; store.listApiKeyPlatformEntitlements = undefined }
    const getPlan = store.getConsumerPlan.bind(store)
    store.getConsumerPlan = async id => {
      const plan = await getPlan(id)
      return { ...plan, limits: { ...plan?.limits, maxPageSize: 1 } }
    }
    await assert.rejects(request('plan-limit', { pageSize: 2 }), { code: 'page_size_exceeded' })
    store.getConsumerPlan = getPlan
    store.apiKeyPlatformEntitlements.get(key.id).find(row => row.platform === 'telegram').maxPageSize = 1
    await assert.rejects(request('key-limit', { pageSize: 2 }), { code: 'page_size_exceeded' })
    assert.equal((await request('valid')).status, 200)
    assert.equal(searches.length, 1)
  })
})

test('a grant revoked after canonical admission reads is still rejected before search or charge reservation', async () => {
  const { store, consumer, searches, request } = await fixture()
  const reserve = store.reserve.bind(store)
  store.reserve = async input => {
    store.grants.set(consumer.id, ['xiaohongshu'])
    return reserve(input)
  }
  await assert.rejects(request('revoked', { platform: 'xiaohongshu' }), { code: 'api_key_scope_not_granted' })
  assert.equal(searches.length, 0)
  assert.equal(store.requests.size, 0)
})
