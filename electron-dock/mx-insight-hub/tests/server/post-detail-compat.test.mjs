import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { normalizeNightAllPostDetailRequest } from '../../server/contracts/night-all-post-detail.mjs'
import { nightAllCompatibilityRequestFingerprint } from '../../server/acquisitions/request-verification.mjs'

const canonicalize = value => String(value || '').trim().toLowerCase()

test('post-detail compatibility normalizes identifiers and rejects provider controls', () => {
  const normalized = normalizeNightAllPostDetailRequest({
    platform: 'twitter', postId: 123, count: '1', includeRaw: false,
  }, { businessId: 'agent:a:data_query:search_post_detail:twitter', canonicalizePlatform: canonicalize })
  assert.equal(normalized.platform, 'twitter')
  assert.equal(normalized.upstreamBody.postId, '123')
  assert.equal(normalized.upstreamBody.includeRaw, undefined)
  assert.throws(
    () => normalizeNightAllPostDetailRequest({ platform: 'twitter', postId: 'p1', provider: 'rapidapi' }, {
      businessId: 'agent:a:data_query:search_post_detail:twitter', canonicalizePlatform: canonicalize,
    }),
    error => error.code === 'unsupported_fields',
  )
})

test('post-detail aliases remain reproducible in acquisition verification', () => {
  const body = { platform: 'twitter', contentId: 'p1', count: 1 }
  const first = nightAllCompatibilityRequestFingerprint({
    path: '/api/v1/search/post-detail', body, businessId: 'agent:a:data_query:search_post_detail:twitter', canonicalizePlatform: canonicalize,
  })
  const alias = nightAllCompatibilityRequestFingerprint({
    path: '/api/v1/night-all/search/post-detail', body, businessId: 'agent:a:data_query:search_post_detail:twitter', canonicalizePlatform: canonicalize,
  })
  assert.equal(first.canonicalPath, '/api/v1/night-all/search/post-detail')
  assert.equal(first.fingerprint, alias.fingerprint)
})

test('post-detail compatibility uses the Hub reservation and forwards the old Night-All route', async () => {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Post detail tenant' })
  const consumer = await store.createConsumer({
    tenantId: tenant.id,
    name: 'Post detail consumer',
    businessId: 'agent:a:data_query:search_post_detail:twitter',
  })
  await store.replaceGrants(consumer.id, ['twitter'])
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'twitter', maxRequests: 10, windowSeconds: 3600, maxPageSize: 100 })

  let forwarded
  const payload = {
    data: {
      raw_info: JSON.stringify([{ user_id: 'u1', username: 'author' }]),
      raw_data: JSON.stringify([{ content_id: 'p1', text: '完整正文', published_at: '2026-01-01T00:00:00Z', author_id: 'u1', images: ['https://img'], videos: [{ url: 'https://video', cover: 'https://cover' }] }]),
      page: { page: 1, pageSize: 1, returnedCount: 1, hasMore: false, nextCursor: null },
      meta: { resultCount: 1 },
    },
  }
  const service = new HubService({
    store,
    apiKeyPepper: 'post-detail-test',
    adapter: {
      async legacySearch(input) {
        forwarded = input
        return { payload: structuredClone(payload), raw: structuredClone(payload) }
      },
    },
  })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'Post detail key', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(issued.secret)
  const result = await service.nightAllCompatibilitySearch(context, {
    operation: 'post-detail',
    path: '/api/v1/search/post-detail',
    idempotencyKey: 'post-detail-compat-1',
    body: { platform: 'twitter', contentId: 'p1', count: 1 },
  })
  assert.equal(result.status, 200)
  assert.equal(forwarded.operation, 'post-detail')
  assert.equal(forwarded.body.contentId, 'p1')
  assert.equal(JSON.parse(result.body.data.raw_data)[0].text, '完整正文')
})

test('Night-All adapter sends post-detail to the historical endpoint', async () => {
  let pathname
  const adapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async (url) => {
      pathname = new URL(url).pathname
      return new Response(JSON.stringify({ data: { raw_info: '[]', raw_data: '[]', page: {}, meta: {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  await adapter.legacySearch({ operation: 'post-detail', body: { platform: 'twitter', postId: 'p1' }, businessId: 'agent' })
  assert.equal(pathname, '/api/v1/search/post-detail')
})

test('legacy Xiaohongshu post-detail keeps a valid compatibility meter without changing /data/post', async () => {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'XHS post detail tenant' })
  const consumer = await store.createConsumer({
    tenantId: tenant.id,
    name: 'XHS post detail consumer',
    businessId: 'agent:xhs:data_query:search_post_detail:xiaohongshu',
  })
  await store.replaceGrants(consumer.id, ['xiaohongshu'])
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'xiaohongshu', maxRequests: 10, windowSeconds: 3600, maxPageSize: 100 })
  const payload = {
    data: {
      raw_info: '[]',
      raw_data: JSON.stringify([{ contentId: 'note-1', text: '历史详情' }]),
      page: { page: 1, pageSize: 1, returnedCount: 1, hasMore: false, nextCursor: null },
      meta: { resultCount: 1 },
    },
  }
  let forwarded
  const service = new HubService({
    store,
    apiKeyPepper: 'xhs-post-detail-test',
    adapter: { async legacySearch(input) { forwarded = input; return { payload, raw: payload } } },
  })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'XHS key', platforms: ['xiaohongshu'], capabilities: [] })
  const context = await service.authenticate(issued.secret)
  const result = await service.nightAllCompatibilitySearch(context, {
    operation: 'post-detail',
    path: '/api/v1/search/post-detail',
    idempotencyKey: 'xhs-post-detail-1',
    body: { platform: 'xiaohongshu', noteId: 'note-1', count: 1 },
  })
  assert.equal(result.status, 200)
  assert.equal(forwarded.operation, 'post-detail')
  assert.equal(JSON.parse(result.body.data.raw_data)[0].text, '历史详情')
})
