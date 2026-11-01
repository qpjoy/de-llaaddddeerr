import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { normalizeNightAllPostCommentsRequest } from '../../server/contracts/night-all-post-comments.mjs'
import { nightAllCompatibilityRequestFingerprint } from '../../server/acquisitions/request-verification.mjs'

const canonicalize = value => String(value || '').trim().toLowerCase()

test('post-comments normalizes optional post identifiers, bounded pages and continuation params', () => {
  const normalized = normalizeNightAllPostCommentsRequest({
    platform: 'weibo', contentId: 123, url: 'https://weibo.com/p/123', count: 100,
    page: '2', cursor: 'mxnc1.example', params: { search_id: 'next', sort: 'latest' }, includeRaw: false,
  }, { businessId: 'data-hub:strategy:weibo:评论', canonicalizePlatform: canonicalize })
  assert.equal(normalized.platform, 'weibo')
  assert.equal(normalized.pageSize, 100)
  assert.equal(normalized.upstreamBody.contentId, '123')
  assert.equal(normalized.upstreamBody.includeRaw, undefined)
  assert.throws(
    () => normalizeNightAllPostCommentsRequest({ platform: 'weibo', postId: 'p1', params: { provider: 'tikhub' } }, {
      businessId: 'data-hub:strategy:weibo:评论', canonicalizePlatform: canonicalize,
    }),
    error => error.code === 'unsupported_fields',
  )
  assert.throws(
    () => normalizeNightAllPostCommentsRequest({ platform: 'weibo', postId: 'p1', count: 101 }, { canonicalizePlatform: canonicalize }),
    error => error.code === 'invalid_request',
  )
})

test('post-comments aliases share one canonical acquisition identity', () => {
  const body = { platform: 'weibo', postId: 'p1', contentId: 'p1', count: 20 }
  const first = nightAllCompatibilityRequestFingerprint({
    path: '/api/v1/search/post-comments', body, businessId: 'data-hub:strategy:weibo:评论', canonicalizePlatform: canonicalize,
  })
  const alias = nightAllCompatibilityRequestFingerprint({
    path: '/api/v1/night-all/search/post-comments', body, businessId: 'data-hub:strategy:weibo:评论', canonicalizePlatform: canonicalize,
  })
  assert.equal(first.canonicalPath, '/api/v1/night-all/search/post-comments')
  assert.equal(first.fingerprint, alias.fingerprint)
})

async function fixture({ adapter } = {}) {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Post comments tenant' })
  const consumer = await store.createConsumer({
    tenantId: tenant.id, name: 'Post comments consumer', businessId: 'data-hub:strategy:weibo:评论',
  })
  await store.replaceGrants(consumer.id, ['weibo'])
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'weibo', maxRequests: 10, windowSeconds: 3600, maxPageSize: 100 })
  const service = new HubService({ store, apiKeyPepper: 'post-comments-test', adapter })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'Post comments key', platforms: ['weibo'], capabilities: [] })
  return { service, context: await service.authenticate(issued.secret) }
}

test('post-comments uses the Hub reservation and returns complete comment payload plus pagination', async () => {
  const calls = []
  const payload = {
    data: {
      raw_info: JSON.stringify([{ comment_id: 'c1', content_id: 'p1', user: { id: 'u1', name: '评论者' } }]),
      raw_data: JSON.stringify([{ comment_id: 'c1', content_id: 'p1', text: '评论正文', published_at: '2026-01-01T00:00:00Z', author: { id: 'u1' }, metrics: { likes: 3 } }]),
      page: { page: 1, pageSize: 20, returnedCount: 1, hasMore: true, nextCursor: 'provider-next' },
      meta: { resultCount: 1 },
    },
  }
  const h = await fixture({ adapter: { async legacySearch(input) { calls.push(input); return { payload: structuredClone(payload), raw: structuredClone(payload) } } } })
  const result = await h.service.nightAllCompatibilitySearch(h.context, {
    operation: 'post-comments', path: '/api/v1/search/post-comments', idempotencyKey: 'post-comments-first',
    body: { platform: 'weibo', postId: 'p1', contentId: 'p1', url: 'https://weibo.com/p/1', count: 100, page: 1, includeRaw: false },
  })
  assert.equal(result.status, 200)
  assert.equal(calls[0].operation, 'post-comments')
  assert.equal(JSON.parse(result.body.data.raw_data)[0].comment_id, 'c1')
  assert.equal(result.body.data.page.hasMore, true)
  assert.match(result.body.data.page.nextCursor, /^mxnc1\./u)
})

test('post-comments continuation forwards the wrapped cursor to Night-All', async () => {
  const calls = []
  const payload = page => ({ data: {
    raw_info: '[]', raw_data: JSON.stringify([{ comment_id: `c${page}`, content_id: 'p1', text: `评论${page}` }]),
    page: { page, pageSize: 20, returnedCount: 1, hasMore: page === 1, nextCursor: page === 1 ? 'provider-next' : null },
    meta: { resultCount: 1 },
  } })
  const h = await fixture({ adapter: { async legacySearch(input) { calls.push(input); return { payload: payload(calls.length), raw: payload(calls.length) } } } })
  const first = await h.service.nightAllCompatibilitySearch(h.context, {
    operation: 'post-comments', path: '/api/v1/search/post-comments', idempotencyKey: 'post-comments-page-1',
    body: { platform: 'weibo', postId: 'p1', count: 20 },
  })
  await h.service.nightAllCompatibilitySearch(h.context, {
    operation: 'post-comments', path: '/api/v1/search/post-comments', idempotencyKey: 'post-comments-page-2',
    body: { platform: 'weibo', postId: 'p1', count: 20, cursor: first.body.data.page.nextCursor },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].body.cursor, 'provider-next')
})

test('Night-All adapter sends post-comments to the historical endpoint', async () => {
  let pathname
  const adapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async url => {
      pathname = new URL(url).pathname
      return new Response(JSON.stringify({ data: { raw_info: '[]', raw_data: '[]', page: {}, meta: {} } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  await adapter.legacySearch({ operation: 'post-comments', body: { platform: 'weibo', postId: 'p1' }, businessId: 'agent' })
  assert.equal(pathname, '/api/v1/search/post-comments')
})
