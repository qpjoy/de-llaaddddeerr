import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { POST_COMMENTS_PATH, POST_COMMENTS_RECIPES, POST_COMMENTS_VERSION, normalizePostCommentsRequest } from '../../server/contracts/post-comments.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { canonicalJson } from '../../server/ingest/normalizers.mjs'

const VIDEO = 'dQw4w9WgXcQ', OTHER = '9bZkp7q19f0'
const PEPPER = 'post-comments-offline-long-pepper', SECRET = 'synthetic-comments-provider-key'
const comments = (ids, continuation_token = null) => ({ code: 200, data: {
  comments: ids.map(id => ({ comment_id: id, content: `完整评论 ${id}`, published_time: '2 days ago',
    like_count: '0', reply_count: '3', author: { channel_id: 'UC' + 'a'.repeat(22), display_name: '作者' } })), continuation_token,
} })
const TWITTER_POST = '2117082385997250767'
const twitterComment = (id, conversationId = TWITTER_POST) => ({ id, conversation_id: conversationId,
  text: `完整评论 ${id}\n第二行`, display_text: '展示文本', created_at: 'Thu Jan 16 13:49:31 +0000 2025',
  likes: 3, replies: 1, retweets: 2, bookmarks: 0, quotes: 0, views: '17',
  author: { rest_id: '1027932752308563968', name: 'Comment author', screen_name: 'commenter' } })
const twitterComments = (rows, cursor = null, conversationId = TWITTER_POST) => ({ code: 200, data: {
  ...twitterComment(TWITTER_POST, conversationId), text: '原帖正文', replies: rows.length, thread: rows, cursor,
} })
const REDDIT_POST = 't3_post123'
const redditTree = (id, nodeOverrides = {}, treeOverrides = {}) => ({ childCount: 0, depth: 0, more: null, parentId: null,
  node: { __typename: 'Comment', id: `t1_${id}`, content: { markdown: `完整 Reddit 评论 ${id}\n第二行 **保留 Markdown**` },
    createdAt: '2026-11-02T00:00:00.000Z', score: -2, isScoreHidden: false, isRemoved: false,
    authorInfo: { id: `t2_author${id}`, name: `作者 ${id}`, iconSmall: { url: 'https://example.invalid/avatar' } },
    permalink: `/r/test/comments/post123/title/${id}/`, ...nodeOverrides }, ...treeOverrides })
const redditComments = (trees, pageInfo = { commentCount: trees.length, hasNextPage: false }) => ({ code: 200,
  data: { postInfoById: { id: REDDIT_POST, title: '原帖，不作为评论', commentForest: { pageInfo, trees } } } })
const KUAISHOU_POST = 'fixturePhoto123'
const kuaishouComment = (index, overrides = {}) => ({ comment_id: 112233445566 + index,
  author_id: 22334455 + index, author_name: `快手作者 ${index}`, headurl: 'https://example.invalid/avatar.png',
  content: `  完整快手评论 ${index}😀\n保留空白  `, timestamp: 1793602800000, time: '刚刚',
  likedCount: index, subCommentCount: 8, photo_id: 9007199254740992,
  user_id: 9007199254740992, reply_to: 9007199254740992, ...overrides })
const kuaishouComments = (rootComments, pcursor = 'no_more') => ({ code: 200, params: { photo_id: KUAISHOU_POST },
  data: { result: 1, rootComments, pcursor, subCommentsMap: {
    '112233445566': { pcursor: 'private-reply-preview-cursor', subComments: [
      kuaishouComment(900, { content: '回复预览一' }), kuaishouComment(901, { content: '回复预览二' }),
    ] },
  } } })

async function harness({ payload = () => comments(['c1']), granted = true, controlsEnabled = true, platform = 'youtube' } = {}) {
  const calls = [], store = new MemoryStore(), provider = POST_COMMENTS_RECIPES[platform].provider
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { throw new Error('Night-All must never be called') },
  } })
  const tenant = await service.createTenant({ name: 'Offline comments' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Comments caller' })
  await store.setPlatformGrant(consumer.id, platform, true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform, maxRequests: 10000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic comments key', platforms: [platform],
    capabilities: granted ? ['social.comments.list'] : [] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true,
    timeoutMs: 100, freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3,
    maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === POST_COMMENTS_RECIPES[platform].provider && row.path === POST_COMMENTS_RECIPES[platform].path)
  if (controlsEnabled) await controls.updatePolicy(provider, endpoint.operation, {
    expectedRevision: 1, desiredState: 'active', reason: 'Synthetic post comments regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-02T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } },
  }, { runtime: { config, credentialConfigured: true } })
  const fetchImpl = async url => {
    const parsed = new URL(url), call = { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) }
    calls.push(call)
    const result = payload(call, calls.length)
    return result instanceof Response ? result : Response.json(result)
  }
  const adapter = provider === 'justone' ? new JustOneAdapter({ token: SECRET, timeoutMs: 100, fetchImpl })
    : new TikHubAdapter({ apiKey: SECRET, timeoutMs: 100, fetchImpl })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: provider, authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: provider,
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  service.externalPostComments = (current, input) => gateway.postComments(current, { ...input, platform,
    path: POST_COMMENTS_PATH })
  const invoke = (body = { platform, postId: VIDEO, count: 20 }, idempotencyKey = 'post-comments-native-first') =>
    service.postComments(context, { body, idempotencyKey, path: POST_COMMENTS_PATH })
  return { service, store, platformStore, gateway, context, calls, invoke, endpoint, controls, secret: key.secret }
}

test('public new and historical comment routes authenticate and share the same immutable native delivery', async t => {
  const h = await harness()
  const server = createServer(createApp({ service: h.service, store: h.store, listenerMode: 'public', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  let delivered
  for (const path of [POST_COMMENTS_PATH, '/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments']) {
    const response = await fetch(base + path, { method: 'POST', headers: {
      authorization: `Bearer ${h.secret}`, 'content-type': 'application/json', 'idempotency-key': 'public-comment-aliases',
    }, body: JSON.stringify({ platform: 'youtube', contentId: VIDEO, count: 20 }) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(response.headers.get('x-mx-insight-request-id'), body.requestId)
    if (delivered) { assert.deepEqual(body, delivered); assert.equal(response.headers.get('idempotent-replay'), 'true') }
    else delivered = body
  }
  assert.equal(h.calls.length, 1)
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Another authorized key',
    platforms: ['youtube'], capabilities: ['social.comments.list'] })
  const other = await fetch(base + POST_COMMENTS_PATH, { method: 'POST', headers: {
    authorization: `Bearer ${otherKey.secret}`, 'content-type': 'application/json', 'idempotency-key': 'public-comment-aliases',
  }, body: JSON.stringify({ platform: 'youtube', contentId: VIDEO, count: 20 }) })
  assert.equal(other.status, 409)
  assert.equal((await other.json()).error.code, 'idempotency_conflict')
  assert.equal(h.calls.length, 1)
})

test('Hub comments acquire complete canonical comments, archive full receipt and replay across route aliases', async () => {
  const h = await harness(), body = { platform: 'youtube', contentId: VIDEO, count: 20, includeRaw: false }
  const first = await h.invoke(body)
  assert.equal(first.status, 200)
  assert.equal(first.body.data.meta.implementation, 'hub')
  assert.equal(first.body.data.items[0].text, '完整评论 c1')
  assert.equal(first.body.data.items[0].postId, VIDEO)
  assert.equal(first.body.data.page.paginationStatus, 'exhausted')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].path, '/api/v1/youtube/web_v2/get_video_comments')
  assert.equal(h.calls[0].params.video_id, VIDEO)
  const receipt = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.equal(receipt.bodySha256, createHash('sha256').update(receipt.bodyBytes).digest('hex'))
  const job = h.platformStore.ingestJobs[0]
  assert.equal(job.payload.datasetId, 'social.comments.v1')
  assert.equal(job.payload.records[0].objectType, 'comment')
  assert.equal(job.payload.records[0].stableFields.attributes.parentExternalId, VIDEO)
  assert.equal(classifyExternalPlatformIngest(job.payload).hubRaw, true)
  assert.equal(h.store.requests.get(first.requestId).platform, 'youtube')
  for (const path of ['/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments']) {
    const replay = await h.service.nightAllCompatibilitySearch(h.context, { operation: 'post-comments', body, path,
      idempotencyKey: 'post-comments-native-first' })
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
  }
  assert.equal(h.calls.length, 1)
})

test('paid overflow drains before a further provider page and scoped cursor rejects changed post or count', async () => {
  const h = await harness({ payload: () => comments(['a', 'b', 'c', 'd', 'e']) })
  const body = { platform: 'youtube', postId: VIDEO, count: 2 }
  const first = await h.invoke(body)
  const second = await h.invoke({ ...body, params: { cursor: first.body.data.page.nextCursor } }, 'post-comments-page-two')
  const third = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'post-comments-page-three')
  assert.deepEqual([first, second, third].flatMap(row => row.body.data.items.map(item => item.commentId)), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(h.calls.length, 1)
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(third.body.data.page.hasMore, false)
  await assert.rejects(h.invoke({ ...body, postId: OTHER, cursor: first.body.data.page.nextCursor }, 'comments-wrong-post'), { code: 'invalid_cursor' })
  await assert.rejects(h.invoke({ ...body, count: 3, cursor: first.body.data.page.nextCursor }, 'comments-wrong-count'), { code: 'invalid_cursor' })
})

test('unknown pagination is explicit and never purchases an invented next page', async () => {
  const h = await harness({ payload: () => { const data = comments(['a']); delete data.data.continuation_token; return data } })
  const first = await h.invoke()
  assert.equal(first.body.data.page.hasMore, null)
  assert.equal(first.body.data.page.paginationStatus, 'unknown')
  assert.equal(first.body.data.page.nextCursor, null)
  assert.equal(h.calls.length, 1)
})

test('comments capability and reviewed procurement policy are enforced before HTTP', async () => {
  const denied = await harness({ granted: false })
  await assert.rejects(denied.invoke(), { code: 'capability_not_granted' })
  assert.equal(denied.calls.length, 0)
  const paused = await harness({ controlsEnabled: false })
  await assert.rejects(paused.invoke(), error => error.code?.startsWith('external_platform_operation_'))
  assert.equal(paused.calls.length, 0)
})

test('Twitter comments use the pinned TikHub recipe and exclude original-post context from canonical comments', async () => {
  const comment = twitterComment('2117082385997250768')
  const payload = twitterComments([twitterComment(TWITTER_POST), comment])
  const h = await harness({ platform: 'twitter', payload: () => payload })
  const result = await h.invoke({ platform: 'twitter', postId: TWITTER_POST, count: 20 })
  assert.equal(result.status, 200)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].path, '/api/v1/twitter/web/fetch_post_comments')
  assert.equal(h.calls[0].params.tweet_id, TWITTER_POST)
  assert.equal(h.calls[0].params.tweetId, undefined)
  assert.equal(result.body.data.items.length, 1)
  assert.equal(result.body.data.items[0].commentId, '2117082385997250768')
  assert.equal(result.body.data.items[0].postId, TWITTER_POST)
  assert.equal(result.body.data.items[0].text, comment.text)
  assert.equal(result.body.data.items[0].parentExternalId, null)
  assert.equal(result.body.data.items[0].parentRelationship, 'unknown')
  assert.equal(result.body.data.page.hasMore, null)
  assert.equal(result.body.data.page.paginationStatus, 'unknown')
  const job = h.platformStore.ingestJobs[0]
  assert.equal(job.payload.records.length, 1)
  assert.equal(job.payload.records[0].objectType, 'comment')
  assert.equal(job.payload.records[0].stableFields.connectorId, 'external-platform:tikhub')
  assert.equal(job.payload.records[0].stableFields.attributes.parentExternalId, null)
  assert.deepEqual(job.payload.records[0].rawItem, comment)
  assert.equal(classifyExternalPlatformIngest(job.payload).hubRaw, true)
  const archived = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.deepEqual(JSON.parse(archived.bodyBytes.toString('utf8')), payload)
  for (const body of [{ platform: 'twitter', contentId: TWITTER_POST, count: 20 },
    { platform: 'twitter', url: `https://x.com/account/status/${TWITTER_POST}`, count: 20 }]) {
    const replay = await h.invoke(body)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, result.body)
  }
  assert.equal(h.calls.length, 1)
})

test('Twitter comments keep the original rejection on replay and can recover under an explicit new request', async () => {
  const postId = TWITTER_POST
  const recovered = { code: 200, data: { id: postId, conversation_id: postId, replies: 2,
    thread: ['2120793900000000001', '2120793900000000002'].map(id => twitterComment(id, postId)), cursor: 'opaque' } }
  const h = await harness({ platform: 'twitter', payload: (_call, ordinal) => ordinal === 1 ? Response.json({
    detail: { code: 400, message: 'private provider diagnostic' },
  }, { status: 400 }) : recovered })
  const body = { platform: 'twitter', contentId: postId, count: 20 }
  const key = 'twitter-comments-rejected'
  let originalId
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(h.invoke(body, key), error => {
      assert.equal(error.status, 502)
      assert.equal(error.code, 'external_platform_rejected')
      assert.match(error.message, /data source rejected the post comments request/i)
      assert.deepEqual(error.details.upstream, { httpStatus: 400, businessCode: 400 })
      assert.equal(error.details.outcome, 'rejected')
      assert.equal(error.details.retryable, false)
      assert.ok(error.details.requestId)
      if (attempt === 0) originalId = error.details.requestId
      else assert.equal(error.details.requestId, originalId)
      assert.doesNotMatch(JSON.stringify(error.details), /private provider/)
      return true
    })
  }
  assert.deepEqual(h.calls, [{ path: '/api/v1/twitter/web/fetch_post_comments', params: { tweet_id: postId } }])
  assert.equal(h.platformStore.ingestJobs.length, 0)
  assert.equal(h.store.requests.size, 1)
  const freshKey = 'twitter-comments-explicit-new-query'
  const fresh = await h.invoke(body, freshKey)
  assert.equal(fresh.status, 200)
  assert.notEqual(fresh.requestId, originalId)
  assert.equal(fresh.body.data.items.length, 2)
  assert.equal(fresh.body.data.meta.providerCalls, 1)
  assert.equal((await h.invoke(body, freshKey)).requestId, fresh.requestId)
  await assert.rejects(h.invoke(body, key), { code: 'external_platform_rejected' })
  assert.equal(h.calls.length, 2)
  assert.equal(h.store.requests.size, 2)
})

test('Twitter keeps all 36 paid comments and drains overflow without automatic supplier continuation', async () => {
  const ids = Array.from({ length: 36 }, (_, index) => String(BigInt(TWITTER_POST) + BigInt(index + 1)))
  const h = await harness({ platform: 'twitter', payload: (_call, ordinal) => ordinal === 1
    ? twitterComments(ids.map(id => twitterComment(id)), 'provider-page-two')
    : twitterComments([twitterComment('2117082385997250999')], 'provider-page-three') })
  const body = { platform: 'twitter', contentId: TWITTER_POST, count: 20 }
  const first = await h.invoke(body, 'twitter-overflow-first')
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.page.hasMore, true)
  assert.equal(first.body.data.page.paginationStatus, 'continuable')
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.length, 36)
  const second = await h.invoke({ ...body, params: { cursor: first.body.data.page.nextCursor } }, 'twitter-overflow-second')
  assert.equal(second.body.data.items.length, 16)
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.page.hasMore, null)
  assert.equal(second.body.data.page.paginationStatus, 'unknown')
  assert.equal(second.body.data.page.continuationAvailable, true)
  assert.match(second.body.data.page.nextCursor, /^mxds1\./u)
  assert.equal(h.calls.length, 1)
  assert.deepEqual([first, second].flatMap(result => result.body.data.items.map(row => row.commentId)), ids)
  const third = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'twitter-overflow-third')
  assert.equal(third.body.data.items.length, 1)
  assert.equal(third.body.data.page.hasMore, null)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].params.cursor, 'provider-page-two')
  const replay = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'twitter-overflow-third')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, third.body)
  assert.equal(h.calls.length, 2)
})

test('Twitter empty thread with a cursor remains unknown and never automatically buys another page', async () => {
  const h = await harness({ platform: 'twitter', payload: () => twitterComments([], 'empty-provider-cursor', '2117082385997250001') })
  const result = await h.invoke({ platform: 'twitter', postId: TWITTER_POST, count: 100 }, 'twitter-empty-thread')
  assert.deepEqual(result.body.data.items, [])
  assert.equal(result.body.data.page.hasMore, null)
  assert.equal(result.body.data.page.paginationStatus, 'unknown')
  assert.equal(result.body.data.page.continuationAvailable, true)
  assert.match(result.body.data.page.nextCursor, /^mxds1\./u)
  assert.equal(h.calls.length, 1)
  assert.equal(result.body.data.meta.providerCalls, 1)
})

test('historical signed JustOne Twitter cursors replay exact receipts but cannot start a TikHub purchase', async () => {
  const h = await harness({ platform: 'twitter', payload: () => { throw new Error('historical cursor must not dispatch') } })
  const request = normalizePostCommentsRequest({ platform: 'twitter', postId: TWITTER_POST, count: 20 })
  const { initialParams, cursor: _cursor, page: _page, ...identity } = request.fingerprintBody
  const legacyScopeHash = createHash('sha256').update(JSON.stringify({ version: POST_COMMENTS_VERSION, ...identity })).digest('hex')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}:post-comments`)
  const cursor = codec.encode({ version: POST_COMMENTS_VERSION, scopeHash: legacyScopeHash,
    previousDeliveryId: '906701b6-8201-4e2a-a622-403c78d11047', page: 2, expiresAt: Date.now() + 60000 })
  const body = { platform: 'twitter', postId: TWITTER_POST, count: 20, cursor }
  const fingerprint = createHash('sha256').update(canonicalJson({ method: 'POST', path: POST_COMMENTS_PATH,
    body: { ...identity, initialParams: initialParams ?? null, cursor } })).digest('hex')
  const historicalId = '2047a446-f277-4fda-b5c6-0b5886951d50', key = 'historical-justone-twitter-cursor'
  const reserved = await h.store.reserve({ requestId: historicalId, idempotencyKey: key, fingerprint,
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
    platform: 'twitter', meterKey: 'social.comments.list', unitsReserved: 1,
    acquisitionRequest: { method: 'POST', path: POST_COMMENTS_PATH, body },
    leaseExpiresAt: new Date(Date.now() + 60000), windowStart: new Date(Date.now() - 3600000), maxRequests: 10000 })
  assert.equal(reserved.kind, 'reserved')
  const historicalBody = { contractVersion: POST_COMMENTS_VERSION, requestId: historicalId,
    data: { platform: 'twitter', postId: TWITTER_POST, items: [{ commentId: '2117082385997250700', text: '已交付的历史正文' }],
      page: { page: 2, hasMore: true, nextCursor: cursor }, meta: { implementation: 'hub', providerCalls: 1 } } }
  await h.store.commitRequest(historicalId, { responseStatus: 200, responseBody: historicalBody,
    unitsActual: 1, upstreamLatencyMs: 3, deliverySourceMode: 'live' })
  const saved = structuredClone(h.store.requests.get(historicalId))
  const historicalCharge = structuredClone(h.store.customerCharges.get(historicalId))

  const replay = await h.invoke(body, key)
  assert.equal(replay.status, 200)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, historicalBody)
  assert.deepEqual(h.store.requests.get(historicalId), saved)
  assert.deepEqual(h.store.customerCharges.get(historicalId), historicalCharge)
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.calls.size, 0)

  const newKey = 'historical-cursor-new-request'
  await assert.rejects(h.invoke(body, newKey), { code: 'invalid_cursor' })
  const rejected = await h.store.getUsageRequestByIdempotencyKey(h.context.consumer.id, newKey)
  assert.equal(rejected.status, 'released')
  assert.equal(rejected.errorCode, 'external_platform_pre_dispatch_failed')
  const rejectedCharge = h.store.customerCharges.get(rejected.id)
  assert.ok(!rejectedCharge || rejectedCharge.status === 'released')
  assert.equal(rejectedCharge?.chargedMinor ?? 0, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.calls.size, 0)
  assert.equal(h.platformStore.ingestJobs.length, 0)

  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Other historical-cursor caller',
    platforms: ['twitter'], capabilities: ['social.comments.list'] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.service.postComments(otherContext, { body, idempotencyKey: key, path: POST_COMMENTS_PATH }),
    { code: 'invalid_cursor' }, 'a cursor signed for another API Key is rejected before reservation')
  assert.deepEqual(h.store.requests.get(historicalId), saved)
  assert.deepEqual(h.store.customerCharges.get(historicalId), historicalCharge)
  assert.equal(h.calls.length, 0)
})

test('legacy continuation imports only validated parameters and returned continuation is Hub-scoped', async () => {
  const h = await harness({ payload: () => comments(['a'], 'next-token') })
  const body = { platform: 'youtube', postId: VIDEO, count: 1, cursor: 'prior-provider-token', page: 2 }
  const first = await h.invoke(body)
  assert.equal(h.calls[0].params.continuation_token, 'prior-provider-token')
  assert.equal(first.body.data.page.page, 1)
  assert(first.body.data.warnings.some(row => row.code === 'imported_continuation'))
  assert.match(first.body.data.page.nextCursor, /^mxds1\./u)
  assert.throws(() => normalizePostCommentsRequest({ ...body, params: { endpoint: '/arbitrary' } }), /./)
  await assert.rejects(h.invoke({ platform: 'youtube', postId: VIDEO, cursor: 'mxnc1.old-cursor' }, 'old-cursor-rejected'), { code: 'invalid_cursor' })
})

test('runtime wires dedicated comment stores to the platform and leaves legacy Night-All unused', async t => {
  const { createRuntime } = await import('../../server/index.mjs')
  const { loadConfig } = await import('../../server/config.mjs')
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: PEPPER, MX_INSIGHT_TIKHUB_API_KEY: SECRET,
    MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE: '1000', MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST: '10' }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  const { service, store } = runtime
  const tenant = await service.createTenant({ name: 'Runtime comment test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Runtime caller' })
  await store.setPlatformGrant(consumer.id, 'youtube', true)
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Runtime comment key', platforms: ['youtube'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const gateway = runtime.postCommentsGateways.youtube
  assert.equal(gateway.platformStore.authorizationPlatform, 'youtube')
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === 'tikhub' && row.path === POST_COMMENTS_RECIPES.youtube.path)
  await runtime.externalPlatformControlStore.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1,
    desiredState: 'active', reason: 'Synthetic runtime regression', priceBook: { currency: 'USD',
      pricingAsOf: '2026-11-02T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } }, { runtime: { config: gateway.config, credentialConfigured: true } })
  let calls = 0
  gateway.adapter = new TikHubAdapter({ apiKey: SECRET, fetchImpl: async () => { calls++; return Response.json(comments(['runtime'])) } })
  runtime.adapter.legacySearch = async () => { throw new Error('Night-All must never be called') }
  const body = { platform: 'youtube', postId: VIDEO, count: 20 }
  const first = await service.nightAllCompatibilitySearch(context, { operation: 'post-comments', body,
    path: '/api/v1/night-all/search/post-comments', idempotencyKey: 'runtime-post-comments' })
  assert.equal(first.status, 200)
  assert.equal(calls, 1)
  assert.equal(store.requests.get(first.requestId).platform, 'youtube')
  assert.equal(store.requests.get(first.requestId).acquisitionRequest.path, POST_COMMENTS_PATH)
  assert.equal(gateway.platformStore.calls.size, 1)
  assert.equal(gateway.platformStore.ingestJobs[0].payload.records[0].objectType, 'comment')
})

for (const platform of ['instagram', 'xiaohongshu']) test(`${platform} native comments preserve full paid pages and canonical comment records`, async () => {
  const postId = platform === 'xiaohongshu' ? '6'.repeat(24) : 'C9_TestPost'
  const h = await harness({ platform, payload: () => platform === 'instagram'
    ? { code: 200, data: { status: 'ok', comments: ['a', 'b'].map(pk => ({ pk, text: `完整评论 ${pk}`,
      created_at: 1700000000, comment_like_count: 0, child_comment_count: 1,
      user: { pk: '9007199254740993', username: 'commenter' } })), has_more_comments: false, next_min_id: null } }
    : { code: 200, data: { code: 0, success: true, data: { comments: ['a', 'b'].map(id => ({ id, note_id: postId,
      content: `完整评论 ${id}`, create_time: 1700000000, like_count: 0, sub_comment_count: 1,
      user_info: { user_id: 'user-1', nickname: 'commenter' } })), has_more: false } } } })
  const body = { platform, postId, count: 1 }
  const first = await h.invoke(body)
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, `${platform}-buffer-page-two`)
  assert.equal(h.calls.length, 1)
  assert.deepEqual([first, second].flatMap(result => result.body.data.items.map(item => item.commentId)), ['a', 'b'])
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.page.paginationStatus, 'exhausted')
  const job = h.platformStore.ingestJobs[0]
  assert.equal(classifyExternalPlatformIngest(job.payload).hubRaw, true)
  for (const record of job.payload.records) {
    assert.equal(record.objectType, 'comment')
    assert.equal(record.stableFields.attributes.parentExternalId, postId)
  }
})

test('Reddit contentId requests use TikHub once, preserve full comment lineage and do not relabel scores as likes', async () => {
  const trees = [redditTree('a'), redditTree('b', { score: 98, isScoreHidden: true }), redditTree('c', { score: 0 })]
  const payload = redditComments(trees)
  const h = await harness({ platform: 'reddit', payload: () => payload })
  const body = { platform: 'reddit', contentId: 'post123', count: 100 }
  const first = await h.invoke(body, 'reddit-tikhub-terminal')
  assert.equal(first.status, 200)
  assert.equal(first.body.data.postId, REDDIT_POST)
  assert.equal(first.body.data.items.length, 3)
  assert.equal(first.body.data.page.hasMore, false)
  assert.equal(first.body.data.page.paginationStatus, 'exhausted')
  assert.equal(first.body.data.page.nextCursor, null)
  assert.equal(first.body.data.meta.providerCalls, 1)
  assert.equal(h.calls.length, 1, 'count=100 must not buy another page after the verified terminal response')
  assert.equal(h.calls[0].path, '/api/v1/reddit/app/fetch_post_comments')
  assert.equal(h.calls[0].params.post_id, REDDIT_POST)
  assert.equal(h.calls[0].params.need_format, 'false')
  assert.equal(h.calls[0].params.postId, undefined)
  assert.deepEqual(first.body.data.items.map(row => row.metrics.score), [-2, null, 0])
  for (const [index, row] of first.body.data.items.entries()) {
    assert.equal(row.commentId, trees[index].node.id)
    assert.equal(row.content, trees[index].node.content.markdown)
    assert.equal(row.author_id, trees[index].node.authorInfo.id)
    assert.equal(row.publishedAt, '2026-11-02T00:00:00.000Z')
    assert.equal(row.like_count, null)
    assert.equal(row.metrics.likes, null)
    assert.equal(row.parentExternalId, null)
    assert.equal(row.parentRelationship, 'unknown')
    assert.equal(row.raw, undefined)
  }
  const archive = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.deepEqual(JSON.parse(archive.bodyBytes.toString('utf8')), payload)
  assert.equal(archive.bodySha256, createHash('sha256').update(archive.bodyBytes).digest('hex'))
  const job = h.platformStore.ingestJobs[0]
  assert.equal(job.payload.providerKey, 'tikhub')
  assert.equal(job.payload.platform, 'reddit')
  assert.equal(job.payload.datasetId, 'social.comments.v1')
  assert.equal(classifyExternalPlatformIngest(job.payload).hubRaw, true)
  assert.equal(job.payload.records.length, 3)
  for (const [index, record] of job.payload.records.entries()) {
    assert.equal(record.objectType, 'comment')
    assert.equal(record.stableFields.connectorId, 'external-platform:tikhub')
    assert.equal(record.stableFields.attributes.rootExternalId, REDDIT_POST)
    assert.equal(record.stableFields.attributes.parentExternalId, null)
    assert.equal(record.stableFields.attributes.parentRelationship, 'unknown')
    assert.equal(record.body, trees[index].node.content.markdown)
    assert.deepEqual(record.rawItem, trees[index])
    assert.equal(record.rawPayloadSha256, createHash('sha256').update(canonicalJson(trees[index])).digest('hex'))
    assert.equal(record.metrics.score ?? null, [-2, null, 0][index])
    assert.equal(record.stableFields.metrics.score ?? null, [-2, null, 0][index])
    assert.equal(record.metrics.likes ?? null, null)
  }
  const saved = structuredClone(h.store.requests.get(first.requestId))
  const charge = structuredClone(h.store.customerCharges.get(first.requestId))
  const replay = await h.invoke({ platform: 'reddit', postId: REDDIT_POST, count: 100 }, 'reddit-tikhub-terminal')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, first.body)
  assert.deepEqual(h.store.requests.get(first.requestId), saved)
  assert.deepEqual(h.store.customerCharges.get(first.requestId), charge)
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
})

test('Reddit keeps all 25 paid comments and serves the five-row overflow without another provider request', async () => {
  const trees = Array.from({ length: 25 }, (_, index) => redditTree(`c${index}`))
  const h = await harness({ platform: 'reddit', payload: () => redditComments(trees) })
  const body = { platform: 'reddit', contentId: 'post123', count: 20 }
  const first = await h.invoke(body, 'reddit-overflow-first')
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.page.hasMore, true)
  assert.equal(first.body.data.page.paginationStatus, 'continuable')
  assert.match(first.body.data.page.nextCursor, /^mxds1\./u)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.length, 25)
  const second = await h.invoke({ ...body, params: { cursor: first.body.data.page.nextCursor } }, 'reddit-overflow-second')
  assert.equal(second.body.data.items.length, 5)
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.page.hasMore, false)
  assert.equal(second.body.data.page.paginationStatus, 'exhausted')
  assert.equal(second.body.data.page.nextCursor, null)
  assert.equal(h.calls.length, 1)
  assert.deepEqual([first, second].flatMap(row => row.body.data.items.map(item => item.commentId)), trees.map(tree => tree.node.id))
  const replay = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'reddit-overflow-second')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, second.body)
  assert.equal(h.calls.length, 1)
})

test('Reddit unknown page state and reply placeholders never become invented post cursors or automatic purchases', async () => {
  for (const payload of [
    redditComments([redditTree('a')], { commentCount: 1 }),
    redditComments([redditTree('a')], { commentCount: 1, hasNextPage: true, endCursor: 'unverified-page-token' }),
    redditComments([redditTree('a'), { childCount: 0, depth: 0, node: null, parentId: null, more: { cursor: 'reply-endpoint-token' } }]),
  ]) {
    const h = await harness({ platform: 'reddit', payload: () => payload })
    const result = await h.invoke({ platform: 'reddit', postId: REDDIT_POST, count: 100 }, 'reddit-unknown-pagination')
    assert.equal(result.body.data.items.length, 1)
    assert.equal(result.body.data.page.hasMore, null)
    assert.equal(result.body.data.page.paginationStatus, 'unknown')
    assert.equal(result.body.data.page.nextCursor, null)
    assert.equal(result.body.data.meta.providerCalls, 1)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].params.after, '')
    assert.equal(JSON.stringify(result.body).includes('unverified-page-token'), false)
    assert.equal(JSON.stringify(result.body).includes('reply-endpoint-token'), false)
  }
})

async function saveHistoricalRedditReceipt(h, { body, cursor = null, initialParams = {}, key, requestId }) {
  const identity = { platform: 'reddit', postId: REDDIT_POST, count: 20, includeRaw: false, options: {} }
  const fingerprint = createHash('sha256').update(canonicalJson({ method: 'POST', path: POST_COMMENTS_PATH,
    body: { ...identity, initialParams, cursor } })).digest('hex')
  const reserved = await h.store.reserve({ requestId, idempotencyKey: key, fingerprint,
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
    platform: 'reddit', meterKey: 'social.comments.list', unitsReserved: 1,
    acquisitionRequest: { method: 'POST', path: POST_COMMENTS_PATH, body },
    leaseExpiresAt: new Date(Date.now() + 60000), windowStart: new Date(Date.now() - 3600000), maxRequests: 10000 })
  assert.equal(reserved.kind, 'reserved')
  const responseBody = { contractVersion: POST_COMMENTS_VERSION, requestId,
    data: { platform: 'reddit', postId: REDDIT_POST, items: [{ commentId: 't1_old', text: '原 JustOne 已交付正文' }],
      page: { page: 2, hasMore: true, nextCursor: cursor }, meta: { implementation: 'hub', providerCalls: 1 } } }
  await h.store.commitRequest(requestId, { responseStatus: 200, responseBody,
    unitsActual: 1, upstreamLatencyMs: 3, deliverySourceMode: 'live' })
  return { responseBody, saved: structuredClone(h.store.requests.get(requestId)), charge: structuredClone(h.store.customerCharges.get(requestId)) }
}

test('historical JustOne Reddit signed cursors replay their exact receipt but cannot buy TikHub data under a new key', async () => {
  const h = await harness({ platform: 'reddit', payload: () => { throw new Error('old JustOne cursor must not dispatch') } })
  const identity = { platform: 'reddit', postId: REDDIT_POST, count: 20, includeRaw: false, options: {} }
  const legacyScopeHash = createHash('sha256').update(JSON.stringify({ version: POST_COMMENTS_VERSION, ...identity })).digest('hex')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}:post-comments`)
  const cursor = codec.encode({ version: POST_COMMENTS_VERSION, scopeHash: legacyScopeHash,
    previousDeliveryId: '906701b6-8201-4e2a-a622-403c78d11047', page: 2, expiresAt: Date.now() - 60000 })
  const body = { platform: 'reddit', postId: REDDIT_POST, count: 20, cursor }
  const key = 'historical-justone-reddit-signed', requestId = '2047a446-f277-4fda-b5c6-0b5886951d51'
  const historical = await saveHistoricalRedditReceipt(h, { body, cursor, key, requestId })
  const replay = await h.invoke(body, key)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, historical.responseBody)
  assert.deepEqual(h.store.requests.get(requestId), historical.saved)
  assert.deepEqual(h.store.customerCharges.get(requestId), historical.charge)
  await assert.rejects(h.invoke(body, 'historical-reddit-signed-new-key'), { code: 'invalid_cursor' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.calls.size, 0)
  assert.equal(h.platformStore.ingestJobs.length, 0)
  const rejected = await h.store.getUsageRequestByIdempotencyKey(h.context.consumer.id, 'historical-reddit-signed-new-key')
  assert.equal(rejected.status, 'released')
  assert.equal(h.store.customerCharges.get(rejected.id)?.chargedMinor ?? 0, 0)
})

test('historical JustOne Reddit raw cursor forms retain their original fingerprints only for receipt replay', async () => {
  for (const form of ['body', 'params']) {
    const h = await harness({ platform: 'reddit', payload: () => { throw new Error('legacy provider cursor must not dispatch') } })
    const token = 'old-justone-private-cursor'
    const body = { platform: 'reddit', postId: REDDIT_POST, count: 20,
      ...(form === 'body' ? { cursor: token } : { params: { cursor: token } }) }
    const key = `historical-reddit-raw-${form}`, requestId = '2047a446-f277-4fda-b5c6-0b5886951d52'
    const historical = await saveHistoricalRedditReceipt(h, { body, cursor: form === 'body' ? token : null,
      initialParams: { cursor: token }, key, requestId })
    const replay = await h.invoke(body, key)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, historical.responseBody)
    assert.deepEqual(h.store.requests.get(requestId), historical.saved)
    assert.deepEqual(h.store.customerCharges.get(requestId), historical.charge)
    await assert.rejects(h.invoke(body, `historical-reddit-raw-${form}-new`), { code: 'invalid_cursor' })
    assert.equal(h.calls.length, 0)
    assert.equal(h.platformStore.calls.size, 0)
    assert.equal(h.platformStore.ingestJobs.length, 0)
  }
})

test('real runtime entry preserves a saved JustOne Reddit raw-cursor receipt through its routing normalizer', async t => {
  const { createRuntime } = await import('../../server/index.mjs')
  const { loadConfig } = await import('../../server/config.mjs')
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: PEPPER, MX_INSIGHT_TIKHUB_API_KEY: SECRET,
    MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE: '1000', MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST: '10' }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  const { service, store } = runtime
  const tenant = await service.createTenant({ name: 'Runtime Reddit replay test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Runtime Reddit replay caller' })
  await store.setPlatformGrant(consumer.id, 'reddit', true)
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Runtime Reddit replay key',
    platforms: ['reddit'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const gateway = runtime.postCommentsGateways.reddit
  assert.equal(gateway.providerKey, 'tikhub')
  assert.equal(gateway.platformStore.authorizationPlatform, 'reddit')
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === 'tikhub' && row.path === POST_COMMENTS_RECIPES.reddit.path)
  await runtime.externalPlatformControlStore.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1,
    desiredState: 'active', reason: 'Synthetic runtime Reddit replay regression', priceBook: { currency: 'USD',
      pricingAsOf: '2026-11-02T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } }, { runtime: { config: gateway.config, credentialConfigured: true } })
  let calls = 0
  gateway.adapter = new TikHubAdapter({ apiKey: SECRET, fetchImpl: async () => { calls++; throw new Error('historical replay must not purchase') } })
  runtime.adapter.legacySearch = async () => { throw new Error('historical replay must not call Night-All') }
  const token = 'private-old-justone-cursor'
  const body = { platform: 'reddit', contentId: 'post123', count: 20, params: { cursor: token } }
  const requestId = '2047a446-f277-4fda-b5c6-0b5886951d53', idempotencyKey = 'runtime-reddit-old-cursor'
  const historical = await saveHistoricalRedditReceipt({ store, context }, { body, cursor: null,
    initialParams: { cursor: token }, key: idempotencyKey, requestId })
  const replay = await service.postComments(context, { body, idempotencyKey, path: POST_COMMENTS_PATH })
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, historical.responseBody)
  const legacyAlias = await service.nightAllCompatibilitySearch(context, { operation: 'post-comments', body,
    idempotencyKey, path: '/api/v1/search/post-comments' })
  assert.equal(legacyAlias.replay, true)
  assert.deepEqual(legacyAlias.body, historical.responseBody)
  await assert.rejects(service.postComments(context, { body, idempotencyKey: 'runtime-reddit-old-cursor-new', path: POST_COMMENTS_PATH }),
    { code: 'invalid_cursor' })
  assert.deepEqual(store.requests.get(requestId), historical.saved)
  assert.deepEqual(store.customerCharges.get(requestId), historical.charge)
  assert.equal(calls, 0)
  assert.equal(gateway.platformStore.calls.size, 0)
  assert.equal(gateway.platformStore.ingestJobs.length, 0)
})

test('Kuaishou contentId comments use the verified TikHub App page and retain root identity, full raw lineage and previews', async () => {
  const roots = Array.from({ length: 11 }, (_, index) => kuaishouComment(index))
  roots[10] = kuaishouComment(10, { comment_id: '9007199254740993', author_id: '9007199254740995' })
  const payload = kuaishouComments(roots)
  const h = await harness({ platform: 'kuaishou', payload: () => payload })
  const body = { platform: 'kuaishou', contentId: KUAISHOU_POST, count: 100, includeRaw: false }
  const first = await h.invoke(body, 'kuaishou-tikhub-root-page')
  assert.equal(first.status, 200)
  assert.equal(h.gateway.providerKey, 'tikhub')
  assert.equal(h.calls.length, 1, 'count=100 must not automatically purchase a second App page')
  assert.deepEqual(h.calls[0], { path: '/api/v1/kuaishou/app/fetch_video_comment', params: { photo_id: KUAISHOU_POST } })
  assert.equal(first.body.data.items.length, 11, 'the two reply previews are not root comments')
  assert.equal(first.body.data.page.hasMore, null, 'no_more is not yet proven terminal for this App endpoint')
  assert.equal(first.body.data.page.paginationStatus, 'unknown')
  assert.equal(first.body.data.page.nextCursor, null)
  assert.equal(first.body.data.page.continuationAvailable, false)
  assert.equal(first.body.data.meta.providerCalls, 1)
  assert.equal(first.body.data.meta.repliesIncluded, false)
  assert.equal(first.body.data.meta.repliesFetched, false)
  for (const [index, row] of first.body.data.items.entries()) {
    assert.equal(row.commentId, String(roots[index].comment_id))
    assert.equal(row.postId, KUAISHOU_POST)
    assert.equal(row.contentId, KUAISHOU_POST)
    assert.equal(row.rootExternalId, KUAISHOU_POST)
    assert.equal(row.content, roots[index].content)
    assert.equal(row.author_id, String(roots[index].author_id))
    assert.equal(row.author_name, roots[index].author_name)
    assert.equal(row.publishedAt, '2026-11-02T07:00:00.000Z')
    assert.equal(row.like_count, index)
    assert.equal(row.reply_count, 8, 'preview length does not replace the supplied reply count')
    assert.equal(row.parentExternalId, KUAISHOU_POST)
    assert.equal(row.parentCommentId, null)
    assert.equal(row.parentRelationship, 'post')
    assert.equal(row.repliesIncluded, false)
    assert.equal(row.raw, undefined)
    assert.equal(Object.hasOwn(row, 'photo_id'), false)
  }
  const archive = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.deepEqual(JSON.parse(archive.bodyBytes.toString('utf8')), payload)
  assert.equal(archive.bodySha256, createHash('sha256').update(archive.bodyBytes).digest('hex'))
  const supplier = [...h.platformStore.calls.values()][0]
  assert.equal(h.platformStore.calls.size, 1)
  assert.equal(supplier.providerKey, 'tikhub')
  assert.equal(supplier.endpointKey, 'native.t.api_bc64c9d98dbf724c')
  assert.equal(supplier.billed, true)
  const job = h.platformStore.ingestJobs[0]
  assert.equal(job.payload.providerKey, 'tikhub')
  assert.equal(job.payload.platform, 'kuaishou')
  assert.equal(job.payload.datasetId, 'social.comments.v1')
  assert.equal(classifyExternalPlatformIngest(job.payload).hubRaw, true)
  assert.equal(job.payload.records.length, 11)
  for (const [index, record] of job.payload.records.entries()) {
    assert.equal(record.objectType, 'comment')
    assert.equal(record.stableFields.connectorId, 'external-platform:tikhub')
    assert.equal(record.stableFields.attributes.rootExternalId, KUAISHOU_POST)
    assert.equal(record.stableFields.attributes.parentExternalId, KUAISHOU_POST)
    assert.equal(record.stableFields.attributes.parentRelationship, 'post')
    assert.equal(record.body, roots[index].content)
    assert.deepEqual(record.rawItem, roots[index])
    assert.equal(record.rawItem.photo_id, 9007199254740992, 'unsafe internal photo metadata stays only in the retained raw record')
    assert.equal(record.rawPayloadSha256, createHash('sha256').update(canonicalJson(roots[index])).digest('hex'))
  }
  const saved = structuredClone(h.store.requests.get(first.requestId))
  const charge = structuredClone(h.store.customerCharges.get(first.requestId))
  const replay = await h.invoke({ platform: 'kuaishou', url: `https://www.kuaishou.com/short-video/${KUAISHOU_POST}`, count: 100 }, 'kuaishou-tikhub-root-page')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, first.body)
  assert.deepEqual(h.store.requests.get(first.requestId), saved)
  assert.deepEqual(h.store.customerCharges.get(first.requestId), charge)
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
})

test('Kuaishou preserves all 25 paid roots and drains five buffered comments without another provider purchase', async () => {
  const roots = Array.from({ length: 25 }, (_, index) => kuaishouComment(index))
  const h = await harness({ platform: 'kuaishou', payload: () => kuaishouComments(roots) })
  const body = { platform: 'kuaishou', contentId: KUAISHOU_POST, count: 20 }
  const first = await h.invoke(body, 'kuaishou-buffer-first')
  assert.equal(first.body.data.items.length, 20)
  assert.equal(first.body.data.page.hasMore, true)
  assert.equal(first.body.data.page.paginationStatus, 'continuable')
  assert.match(first.body.data.page.nextCursor, /^mxds1\./u)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.length, 25)
  const second = await h.invoke({ ...body, params: { cursor: first.body.data.page.nextCursor } }, 'kuaishou-buffer-second')
  assert.equal(second.body.data.items.length, 5)
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(second.body.data.page.hasMore, null)
  assert.equal(second.body.data.page.paginationStatus, 'unknown')
  assert.equal(second.body.data.page.nextCursor, null)
  assert.equal(second.body.data.page.continuationAvailable, false)
  assert.equal(h.calls.length, 1)
  assert.deepEqual([first, second].flatMap(result => result.body.data.items.map(row => row.commentId)), roots.map(row => String(row.comment_id)))
  const replay = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'kuaishou-buffer-second')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, second.body)
  assert.equal(h.calls.length, 1)
})

test('Kuaishou advancing App pcursor requires an explicit Hub-signed next request and keeps completeness unknown', async () => {
  const token = 'private-app-root-page-two'
  const h = await harness({ platform: 'kuaishou', payload: (_call, ordinal) => ordinal === 1
    ? kuaishouComments([kuaishouComment(0)], token) : kuaishouComments([kuaishouComment(1)], token) })
  const body = { platform: 'kuaishou', postId: KUAISHOU_POST, count: 100 }
  const first = await h.invoke(body, 'kuaishou-manual-first')
  assert.equal(first.body.data.items.length, 1)
  assert.equal(first.body.data.page.hasMore, null)
  assert.equal(first.body.data.page.paginationStatus, 'unknown')
  assert.equal(first.body.data.page.continuationAvailable, true)
  assert.match(first.body.data.page.nextCursor, /^mxds1\./u)
  assert.equal(JSON.stringify(first.body).includes(token), false)
  assert.equal(JSON.stringify(first.body).includes('private-reply-preview-cursor'), false)
  assert.equal(h.calls.length, 1, 'an advancing App cursor does not fill count=100 automatically')
  const second = await h.invoke({ ...body, params: { cursor: first.body.data.page.nextCursor } }, 'kuaishou-manual-second')
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].params.photo_id, KUAISHOU_POST)
  assert.equal(h.calls[1].params.pcursor, token)
  assert.equal(second.body.data.items[0].commentId, String(kuaishouComment(1).comment_id))
  assert.equal(second.body.data.page.hasMore, null)
  assert.equal(second.body.data.page.paginationStatus, 'unknown')
  assert.equal(second.body.data.page.nextCursor, null, 'a repeated provider token cannot create a third purchase')
  assert.equal(second.body.data.meta.providerCalls, 1)
  const replay = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'kuaishou-manual-second')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, second.body)
  assert.equal(h.calls.length, 2)
})

test('Kuaishou absent, empty and no_more App cursors remain unknown without automatic continuation', async () => {
  for (const pcursor of [undefined, null, '', 'no_more']) {
    const payload = kuaishouComments([kuaishouComment(0)]); payload.data.pcursor = pcursor
    const h = await harness({ platform: 'kuaishou', payload: () => payload })
    const result = await h.invoke({ platform: 'kuaishou', postId: KUAISHOU_POST, count: 100 }, 'kuaishou-no-next')
    assert.equal(result.body.data.items.length, 1)
    assert.equal(result.body.data.page.hasMore, null)
    assert.equal(result.body.data.page.paginationStatus, 'unknown')
    assert.equal(result.body.data.page.nextCursor, null)
    assert.equal(result.body.data.page.continuationAvailable, false)
    assert.equal(h.calls.length, 1)
  }
})

async function saveHistoricalKuaishouReceipt(h, { body, cursor = null, initialParams = {}, key, requestId, page = 2 }) {
  // Explicit pre-migration vectors, independent of today's normalizer.
  const identity = { platform: 'kuaishou', postId: KUAISHOU_POST, count: 20, includeRaw: false, options: {} }
  const fingerprint = createHash('sha256').update(canonicalJson({ method: 'POST', path: POST_COMMENTS_PATH,
    body: { ...identity, initialParams, cursor } })).digest('hex')
  const reserved = await h.store.reserve({ requestId, idempotencyKey: key, fingerprint,
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id,
    platform: 'kuaishou', meterKey: 'social.comments.list', unitsReserved: 1,
    acquisitionRequest: { method: 'POST', path: POST_COMMENTS_PATH, body },
    leaseExpiresAt: new Date(Date.now() + 60000), windowStart: new Date(Date.now() - 3600000), maxRequests: 10000 })
  assert.equal(reserved.kind, 'reserved')
  const responseBody = { contractVersion: POST_COMMENTS_VERSION, requestId,
    data: { platform: 'kuaishou', postId: KUAISHOU_POST, items: [{ commentId: '112233445500', text: '原 JustOne 快手已交付正文' }],
      page: { page, hasMore: true, nextCursor: cursor }, meta: { implementation: 'hub', providerCalls: 1 } } }
  await h.store.commitRequest(requestId, { responseStatus: 200, responseBody,
    unitsActual: 1, upstreamLatencyMs: 3, deliverySourceMode: 'live' })
  return { responseBody, saved: structuredClone(h.store.requests.get(requestId)), charge: structuredClone(h.store.customerCharges.get(requestId)) }
}

test('pre-migration Kuaishou first-page receipts remain immutable after TikHub takes over', async () => {
  const h = await harness({ platform: 'kuaishou', payload: () => { throw new Error('receipt replay must not purchase') } })
  const body = { platform: 'kuaishou', contentId: KUAISHOU_POST, count: 20 }
  const key = 'historical-kuaishou-first', requestId = '2047a446-f277-4fda-b5c6-0b5886951d60'
  const historical = await saveHistoricalKuaishouReceipt(h, { body, key, requestId, page: 1 })
  const replay = await h.invoke({ platform: 'kuaishou', postId: KUAISHOU_POST, count: 20 }, key)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, historical.responseBody)
  assert.deepEqual(h.store.requests.get(requestId), historical.saved)
  assert.deepEqual(h.store.customerCharges.get(requestId), historical.charge)
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.calls.size, 0)
  assert.equal(h.platformStore.ingestJobs.length, 0)
})

test('old expired Kuaishou signed cursors and ambiguous raw pcursors only replay exact historical receipts', async () => {
  for (const form of ['signed', 'body', 'params']) {
    const h = await harness({ platform: 'kuaishou', payload: () => { throw new Error('old cursor must not purchase TikHub data') } })
    const identity = { platform: 'kuaishou', postId: KUAISHOU_POST, count: 20, includeRaw: false, options: {} }
    const legacyScopeHash = createHash('sha256').update(JSON.stringify({ version: POST_COMMENTS_VERSION, ...identity })).digest('hex')
    const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}:post-comments`)
    const token = form === 'signed' ? codec.encode({ version: POST_COMMENTS_VERSION, scopeHash: legacyScopeHash,
      previousDeliveryId: '906701b6-8201-4e2a-a622-403c78d11047', page: 2, expiresAt: Date.now() - 60000 }) : 'ambiguous-justone-or-tikhub-pcursor'
    const body = { platform: 'kuaishou', postId: KUAISHOU_POST, count: 20,
      ...(form === 'params' ? { params: { pcursor: token } } : { cursor: token }) }
    const key = `historical-kuaishou-${form}`, requestId = '2047a446-f277-4fda-b5c6-0b5886951d61'
    const historical = await saveHistoricalKuaishouReceipt(h, { body, cursor: form === 'params' ? null : token,
      initialParams: form === 'signed' ? {} : { pcursor: token }, key, requestId })
    const replay = await h.invoke(body, key)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, historical.responseBody)
    assert.deepEqual(h.store.requests.get(requestId), historical.saved)
    assert.deepEqual(h.store.customerCharges.get(requestId), historical.charge)
    await assert.rejects(h.invoke(body, `${key}-new`), { code: 'invalid_cursor' })
    assert.equal(h.calls.length, 0)
    assert.equal(h.platformStore.calls.size, 0)
    assert.equal(h.platformStore.ingestJobs.length, 0)
    const rejected = await h.store.getUsageRequestByIdempotencyKey(h.context.consumer.id, `${key}-new`)
    assert.equal(rejected.status, 'released')
    assert.equal(h.store.customerCharges.get(rejected.id)?.chargedMinor ?? 0, 0)
  }
})

test('real runtime routes and aliases replay old Kuaishou raw pcursors without importing them into TikHub', async t => {
  const { createRuntime } = await import('../../server/index.mjs')
  const { loadConfig } = await import('../../server/config.mjs')
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: PEPPER, MX_INSIGHT_TIKHUB_API_KEY: SECRET,
    MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE: '1000', MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST: '10' }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  const { service, store } = runtime
  const tenant = await service.createTenant({ name: 'Runtime Kuaishou replay test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Runtime Kuaishou replay caller' })
  await store.setPlatformGrant(consumer.id, 'kuaishou', true)
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Runtime Kuaishou replay key',
    platforms: ['kuaishou'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const gateway = runtime.postCommentsGateways.kuaishou
  assert.equal(gateway.providerKey, 'tikhub')
  assert.equal(gateway.platformStore.authorizationPlatform, 'kuaishou')
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.key === 't.api_bc64c9d98dbf724c')
  await runtime.externalPlatformControlStore.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1,
    desiredState: 'active', reason: 'Synthetic runtime Kuaishou replay regression', priceBook: { currency: 'USD',
      pricingAsOf: '2026-11-02T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } }, { runtime: { config: gateway.config, credentialConfigured: true } })
  let calls = 0
  gateway.adapter = new TikHubAdapter({ apiKey: SECRET, fetchImpl: async () => { calls++; throw new Error('historical replay must not purchase') } })
  runtime.adapter.legacySearch = async () => { throw new Error('historical replay must not call Night-All') }
  const token = 'private-old-kuaishou-pcursor'
  const body = { platform: 'kuaishou', contentId: KUAISHOU_POST, count: 20, params: { pcursor: token } }
  const requestId = '2047a446-f277-4fda-b5c6-0b5886951d62', idempotencyKey = 'runtime-kuaishou-old-pcursor'
  const historical = await saveHistoricalKuaishouReceipt({ store, context }, { body,
    initialParams: { pcursor: token }, key: idempotencyKey, requestId })
  const replay = await service.postComments(context, { body, idempotencyKey, path: POST_COMMENTS_PATH })
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, historical.responseBody)
  for (const path of ['/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments']) {
    const alias = await service.nightAllCompatibilitySearch(context, { operation: 'post-comments', body, idempotencyKey, path })
    assert.equal(alias.replay, true)
    assert.deepEqual(alias.body, historical.responseBody)
  }
  await assert.rejects(service.postComments(context, { body, idempotencyKey: `${idempotencyKey}-new`, path: POST_COMMENTS_PATH }), { code: 'invalid_cursor' })
  assert.deepEqual(store.requests.get(requestId), historical.saved)
  assert.deepEqual(store.customerCharges.get(requestId), historical.charge)
  assert.equal(calls, 0)
  assert.equal(gateway.platformStore.calls.size, 0)
  assert.equal(gateway.platformStore.ingestJobs.length, 0)
})

const ZHIHU_ANSWER = '89226347214'
const zhihuComments = (start, size, nextOffset = null) => ({ code: 200, router: '/api/v1/zhihu/web/fetch_comment_v5',
  params: { answer_id: ZHIHU_ANSWER }, data: {
    data: Array.from({ length: size }, (_, index) => ({ id: String(11108372600 + start + index), type: 'comment',
      content: `<p>知乎评论 ${start + index}</p>`, created_time: 1739257701 + index, like_count: index, dislike_count: 0,
      child_comment_count: 0, author: { id: `author${start + index}`, name: `作者 ${start + index}` } })),
    paging: nextOffset ? { is_end: false, next: `https://www.zhihu.com/api/v4/comment_v5/answers/${ZHIHU_ANSWER}/root_comment?offset=${nextOffset}` }
      : { is_end: true } } })

test('Zhihu comments run through TikHub fetch_comment_v5 and still fill count across Zhihu pages', async () => {
  const h = await harness({ platform: 'zhihu', payload: (call, n) => n === 1
    ? zhihuComments(0, 20, '1739257701_11108372619_0') : zhihuComments(20, 20) })
  assert.equal(h.endpoint.provider, 'tikhub')
  const result = await h.invoke({ platform: 'zhihu', postId: ZHIHU_ANSWER, count: 40 }, 'zhihu-tikhub-fill')
  assert.equal(result.status, 200)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].path, '/api/v1/zhihu/web/fetch_comment_v5')
  assert.equal(h.calls[0].params.answer_id, ZHIHU_ANSWER)
  assert.equal(h.calls[0].params.answerId, undefined)
  assert.equal(h.calls[1].params.offset, '1739257701_11108372619_0')
  assert.equal(result.body.data.items.length, 40)
  assert.equal(result.body.data.items[0].commentId, '11108372600')
  assert.equal(result.body.data.page.paginationStatus, 'exhausted')
  assert.equal(result.body.data.page.hasMore, false)
  assert.equal(Object.hasOwn(result.body.data.page, 'continuationAvailable'), false, 'Zhihu keeps automatic fill, not one-page manual paging')
  assert.equal(result.body.data.meta.providerCalls, 2)
})

test('a cursor signed under the JustOne Zhihu recipe cannot resume through TikHub', async () => {
  const h = await harness({ platform: 'zhihu', payload: () => { throw new Error('historical cursor must not dispatch') } })
  const request = normalizePostCommentsRequest({ platform: 'zhihu', postId: ZHIHU_ANSWER, count: 20 })
  const { initialParams: _initialParams, cursor: _cursor, page: _page, ...identity } = request.fingerprintBody
  const legacyScopeHash = createHash('sha256').update(JSON.stringify({ version: POST_COMMENTS_VERSION, ...identity })).digest('hex')
  const codec = createDataSearchCursorCodec(PEPPER, `${h.context.consumer.id}:${h.context.apiKey.id}:post-comments`)
  const cursor = codec.encode({ version: POST_COMMENTS_VERSION, scopeHash: legacyScopeHash,
    previousDeliveryId: '906701b6-8201-4e2a-a622-403c78d11048', page: 2, expiresAt: Date.now() + 60000 })
  await assert.rejects(h.invoke({ platform: 'zhihu', postId: ZHIHU_ANSWER, count: 20, cursor }, 'zhihu-justone-cursor'),
    { code: 'invalid_cursor' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.platformStore.calls.size, 0)
})
