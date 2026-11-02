import assert from 'node:assert/strict'
import test from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
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

async function fixture({ adapter, externalPostComments } = {}) {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Post comments tenant' })
  const consumer = await store.createConsumer({
    tenantId: tenant.id, name: 'Post comments consumer', businessId: 'data-hub:strategy:weibo:评论',
  })
  await store.replaceGrants(consumer.id, ['weibo'])
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'weibo', maxRequests: 10, windowSeconds: 3600, maxPageSize: 100 })
  const service = new HubService({ store, apiKeyPepper: 'post-comments-test', adapter, externalPostComments })
  const issued = await service.createApiKey({ consumerId: consumer.id, name: 'Post comments key', platforms: ['weibo'], capabilities: [] })
  return { service, store, context: await service.authenticate(issued.secret) }
}

test('new comment aliases are dispatched through the Hub callback without Night-All', async () => {
  const calls = []
  const h = await fixture({ adapter: { async legacySearch() { throw new Error('Night-All must not be called') } },
    externalPostComments: async (context, input) => { calls.push(input); return { status: 200, body: { data: { items: [] } } } } })
  const body = { platform: 'weibo', postId: 'p1', count: 20 }
  for (const path of ['/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments']) {
    assert.equal((await h.service.nightAllCompatibilitySearch(h.context, {
      operation: 'post-comments', path, idempotencyKey: 'post-comments-new', body,
    })).status, 200)
  }
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body, body)
})

test('missing Hub comments executor fails closed instead of falling back to Night-All', async () => {
  let calls = 0
  const h = await fixture({ adapter: { async legacySearch() { calls++; throw new Error('must not dispatch') } } })
  await assert.rejects(h.service.postComments(h.context, { body: { platform: 'weibo', postId: 'p1' },
    idempotencyKey: 'comments-unavailable' }), { code: 'post_comments_unavailable' })
  assert.equal(calls, 0)
})

test('legacy comment receipts replay immutable results and preserve unknown/reserved states without new dispatch', async () => {
  let nativeCalls = 0
  const h = await fixture({ adapter: { async legacySearch() { throw new Error('Night-All must not be called') } },
    externalPostComments: async () => { nativeCalls++; throw new Error('native must not be called') } })
  const path = '/api/v1/night-all/search/post-comments', body = { platform: 'weibo', postId: 'p1', count: 20 }
  const { fingerprint } = nightAllCompatibilityRequestFingerprint({ path, body,
    businessId: h.context.consumer.businessId, canonicalizePlatform: canonicalize })
  const reserved = await h.store.reserve({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: 'legacy-comment-receipt', fingerprint, tenantId: h.context.tenant.id,
    consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id, platform: 'weibo', meterKey: 'post-comments',
    acquisitionRequest: { method: 'POST', path, body }, unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60000), windowStart: new Date(Date.now() - 3600000), maxRequests: 10 })
  const saved = h.store.requests.get(reserved.request.id)
  const input = { path: '/api/v1/data/social/post-comments', body, idempotencyKey: 'legacy-comment-receipt' }
  saved.status = 'unknown'
  await assert.rejects(h.service.postComments(h.context, input), { code: 'request_outcome_unknown' })
  saved.status = 'reserved'
  await assert.rejects(h.service.postComments(h.context, input), { code: 'request_in_progress' })
  saved.status = 'released'; saved.responseStatus = 404
  saved.responseBody = { error: { code: 'night_all_rejected' }, requestId: saved.id }
  const snapshot = structuredClone(saved)
  const replay = await h.service.postComments(h.context, input)
  assert.equal(replay.replay, true); assert.equal(replay.status, 404)
  assert.deepEqual(replay.body, snapshot.responseBody)
  assert.deepEqual(saved, snapshot)
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Another legacy key', platforms: ['weibo'], capabilities: [] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.service.postComments(otherContext, input), { code: 'idempotency_conflict' })
  assert.deepEqual(saved, snapshot)
  await assert.rejects(h.service.postComments(h.context, { ...input, body: { ...body, postId: 'different' } }), { code: 'idempotency_conflict' })
  saved.responseBody = null
  await assert.rejects(h.service.postComments(h.context, input), { code: 'comments_restart_required' })
  assert.equal(nativeCalls, 0)
})
