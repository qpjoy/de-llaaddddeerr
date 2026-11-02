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
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { POST_COMMENTS_PATH, POST_COMMENTS_RECIPES, normalizePostCommentsRequest } from '../../server/contracts/post-comments.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'

const VIDEO = 'dQw4w9WgXcQ', OTHER = '9bZkp7q19f0'
const PEPPER = 'post-comments-offline-long-pepper', SECRET = 'synthetic-comments-provider-key'
const comments = (ids, continuation_token = null) => ({ code: 200, data: {
  comments: ids.map(id => ({ comment_id: id, content: `完整评论 ${id}`, published_time: '2 days ago',
    like_count: '0', reply_count: '3', author: { channel_id: 'UC' + 'a'.repeat(22), display_name: '作者' } })), continuation_token,
} })

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
    return Response.json(payload(call, calls.length))
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

test('Twitter comments use the pinned JustOne recipe and archive typed comments without Night-All', async t => {
  const postId = '2117082385997250767'
  const h = await harness({ platform: 'twitter', payload: () => ({ code: 0, message: 'success', recordTime: '2026-11-02T00:00:00Z', data: { status: 'ok',
    timeline: [{ type: 'tweet', tweet_id: '2117082385997250768', text: '完整评论',
      created_at: 'Thu Jan 16 13:49:31 +0000 2025', favorites: 3, replies: 1,
      conversation_id: postId, in_reply_to_status_id_str: postId,
      user_info: { rest_id: '1027932752308563968', name: 'Comment author', screen_name: 'commenter' } }],
    next_cursor: null } }) })
  t.after(() => h.gateway.adapter.close())
  const result = await h.invoke({ platform: 'twitter', postId, count: 20 })
  assert.equal(result.status, 200)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].path, '/api/twitter/get-post-comments/v1')
  assert.equal(h.calls[0].params.tweetId, postId)
  assert.equal(result.body.data.items[0].commentId, '2117082385997250768')
  assert.equal(result.body.data.items[0].postId, postId)
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].objectType, 'comment')
  assert.equal(classifyExternalPlatformIngest(h.platformStore.ingestJobs[0].payload).hubRaw, true)
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
