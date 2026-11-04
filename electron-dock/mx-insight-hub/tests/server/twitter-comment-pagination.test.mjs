import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { POST_COMMENTS_PATH, POST_COMMENTS_VERSION, POST_COMMENTS_RECIPES, normalizePostCommentsRequest } from '../../server/contracts/post-comments.mjs'
import { normalizePostCommentsDelivery } from '../../server/external-platforms/post-comments-workflow.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const POST = '2117082385997250767', PEPPER = 'twitter-comment-manual-pagination-pepper'
const author = { rest_id: '2117082385997000000', name: 'Synthetic author', screen_name: 'synthetic' }
const comment = id => ({ id, conversation_id: POST, text: `Comment ${id}`, display_text: `Comment ${id}`,
  created_at: '2026-11-02T00:00:00Z', status: 'ok', likes: 3, replies: 1, retweets: 0,
  bookmarks: 0, quotes: 0, views: '12', author, media: null })
const payload = (ids, cursor = 'next-page') => ({ code: 200, data: {
  id: POST, conversation_id: POST, text: 'Requested post is context', created_at: '2026-11-01T00:00:00Z',
  status: 'ok', author, replies: ids.length, thread: ids.map(comment), cursor,
} })

async function harness(response) {
  const calls = [], store = new MemoryStore(), service = new HubService({ store, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Manual pagination regression' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Comment caller' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'twitter', maxRequests: 10000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic key', platforms: ['twitter'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true,
    timeoutMs: 100, freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3,
    maxRequestsPerMinute: 1000, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const recipe = POST_COMMENTS_RECIPES.twitter
  assert.equal(recipe.provider, 'tikhub')
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === recipe.provider && row.path === recipe.path)
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline pagination regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-02T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } },
  { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: 'synthetic-provider-key', timeoutMs: 100, fetchImpl: async url => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) })
    return Response.json(response(calls.at(-1), calls.length))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'twitter' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  service.externalPostComments = (current, input) => gateway.postComments(current, { ...input, platform: 'twitter', path: POST_COMMENTS_PATH })
  const invoke = (body, idempotencyKey = 'twitter-manual-page-one') => service.postComments(context, { body, idempotencyKey, path: POST_COMMENTS_PATH })
  return { calls, store, platformStore, context, invoke }
}

test('Twitter short and empty pages never auto-purchase their nonempty cursor', async () => {
  for (const ids of [[], ['2117082385997250768']]) {
    const h = await harness(() => payload(ids))
    const body = { platform: 'twitter', postId: POST, count: 100 }
    const first = await h.invoke(body)
    assert.equal(h.calls.length, 1)
    assert.equal(first.body.data.items.length, ids.length)
    assert.equal(first.body.data.page.hasMore, null)
    assert.equal(first.body.data.page.paginationStatus, 'unknown')
    assert.equal(first.body.data.page.continuationAvailable, true)
    assert.match(first.body.data.page.nextCursor, /^mxds1\./u)
    const replay = await h.invoke(body)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
    assert.equal(h.calls.length, 1)
  }
})

test('Twitter overflow is delivered entirely before an explicit next purchase', async () => {
  const ids = Array.from({ length: 36 }, (_, index) => String(BigInt(POST) + 1n + BigInt(index)))
  const h = await harness((call, ordinal) => ordinal === 1 ? payload(ids, 'paid-page-two')
    : payload(['2117082385997250999'], 'paid-page-three'))
  const body = { platform: 'twitter', postId: POST, count: 20 }
  const first = await h.invoke(body)
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.page.hasMore, true)
  assert.equal(first.body.data.page.paginationStatus, 'continuable')
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'twitter-overflow-page-two')
  assert.equal(second.body.data.items.length, 16)
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(h.calls.length, 1)
  assert.equal(second.body.data.page.hasMore, null)
  assert.equal(second.body.data.page.paginationStatus, 'unknown')
  assert.equal(second.body.data.page.continuationAvailable, true)
  assert.deepEqual([...first.body.data.items, ...second.body.data.items].map(row => row.commentId), ids)
  const third = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'twitter-explicit-page-three')
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].params.cursor, 'paid-page-two')
  assert.equal(third.body.data.meta.providerCalls, 1)
  assert.equal(third.body.data.items.length, 1)
  assert.equal(third.body.data.page.hasMore, null)
})

test('Twitter missing or repeated cursors remain unknown without an invented continuation', async () => {
  for (const cursor of [null, '']) {
    const h = await harness(() => payload([], cursor))
    const result = await h.invoke({ platform: 'twitter', postId: POST })
    assert.equal(h.calls.length, 1)
    assert.equal(result.body.data.page.hasMore, null)
    assert.equal(result.body.data.page.paginationStatus, 'unknown')
    assert.equal(result.body.data.page.continuationAvailable, false)
    assert.equal(result.body.data.page.nextCursor, null)
  }
  const h = await harness(() => payload([], 'same-token'))
  const body = { platform: 'twitter', postId: POST }
  const first = await h.invoke(body)
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'twitter-repeat-cursor')
  assert.equal(h.calls.length, 2)
  assert.equal(second.body.data.page.hasMore, null)
  assert.equal(second.body.data.page.paginationStatus, 'unknown')
  assert.equal(second.body.data.page.nextCursor, null)
})

test('Twitter manual continuation still ends at the bounded traversal limit', async () => {
  const h = await harness((call, ordinal) => payload([String(BigInt(POST) + BigInt(ordinal))], `cursor-${ordinal}`))
  const body = { platform: 'twitter', postId: POST, count: 1 }
  let result
  for (let page = 1; page <= 15; page++) {
    result = await h.invoke({ ...body, ...(result ? { cursor: result.body.data.page.nextCursor } : {}) }, `twitter-bounded-page-${page}`)
    assert.equal(h.calls.length, page)
    if (page < 15) assert.equal(result.body.data.page.continuationAvailable, true)
  }
  assert.equal(result.body.data.page.paginationStatus, 'limit_reached')
  assert.equal(result.body.data.page.hasMore, null)
  assert.equal(result.body.data.page.nextCursor, null)
  assert.equal(result.body.data.page.continuationAvailable, false)
  assert(result.body.data.warnings.some(row => row.code === 'upstream_page_limit_reached'))
})

test('Twitter supplier switch rejects old signed cursors without changing receipt fingerprints or other platforms', () => {
  const context = { consumer: { id: '15d2be12-24a4-4074-bd29-d6ec937104bb', businessId: 'synthetic' },
    apiKey: { id: 'b1d5b20a-4435-442a-90b8-56f4ca8dba5d' } }
  const codec = createDataSearchCursorCodec(PEPPER, `${context.consumer.id}:${context.apiKey.id}:post-comments`)
  const previousDeliveryId = '906701b6-8201-4e2a-a622-403c78d11047'
  for (const [platform, postId] of [['twitter', POST], ['youtube', 'dQw4w9WgXcQ']]) {
    const body = { platform, postId, count: 20 }
    const request = normalizePostCommentsRequest(body)
    const { initialParams, cursor, page, ...identity } = request.fingerprintBody
    const oldScope = createHash('sha256').update(JSON.stringify({ version: POST_COMMENTS_VERSION, ...identity })).digest('hex')
    const delivery = normalizePostCommentsDelivery(body, { context, maxPageSize: 100, codec })
    assert.deepEqual(delivery.fingerprintBody, { ...identity, initialParams: request.initialParams, cursor: null })
    const oldCursor = codec.encode({ version: POST_COMMENTS_VERSION, scopeHash: oldScope,
      previousDeliveryId, page: 2, expiresAt: Date.now() + 60000 })
    if (platform === 'twitter') {
      assert.notEqual(delivery.scopeHash, oldScope)
      assert.throws(() => normalizePostCommentsDelivery({ ...body, cursor: oldCursor }, { context, maxPageSize: 100, codec }), { code: 'invalid_cursor' })
      const replayIdentity = normalizePostCommentsDelivery({ ...body, cursor: oldCursor },
        { context, maxPageSize: 100, codec, allowHistoricalProviderCursor: true })
      assert.equal(replayIdentity.legacyProviderCursor, true)
      assert.deepEqual(replayIdentity.fingerprintBody, { ...identity, initialParams: request.initialParams, cursor: oldCursor })
      const next = normalizePostCommentsDelivery({ ...body, cursor: delivery.encodeNext(previousDeliveryId) }, { context, maxPageSize: 100, codec })
      assert.equal(next.page, 2)
      assert.equal(next.scopeHash, delivery.scopeHash)
    } else {
      assert.equal(delivery.scopeHash, oldScope)
      assert.equal(normalizePostCommentsDelivery({ ...body, cursor: oldCursor }, { context, maxPageSize: 100, codec }).page, 2)
    }
  }
})
