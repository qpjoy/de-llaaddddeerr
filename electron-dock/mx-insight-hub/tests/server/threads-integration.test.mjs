import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter, RapidApiUpstreamError } from '../../server/adapters/rapidapi.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore, EXTERNAL_PLATFORM_OPERATION_CATALOG } from '../../server/external-platforms/control-store.mjs'
import { StrategySearchRoutingStore, assertCommentRouteEnabled, strategyRouteProviders } from '../../server/external-platforms/strategy-search-routing.mjs'
import { createCommentRouter } from '../../server/external-platforms/comment-routing.mjs'
import { threadsSearchCursorProvider } from '../../server/external-platforms/threads-search-workflow.mjs'
import { NATIVE_FORWARDING_ENDPOINTS, nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { THREADS_RAPIDAPI_ENDPOINTS, THREADS_RAPIDAPI_HOST } from '../../server/contracts/threads-rapidapi-endpoints.mjs'
import { threadsPostId, parseThreadsSearchPage, parseThreadsAccountPage, parseThreadsCommentPage } from '../../server/contracts/threads.mjs'
import { threadsSearchRecipe, buildThreadsSearchDispatch, projectThreadsSearchPage } from '../../server/contracts/threads-search.mjs'
import { contentSearchDataItem } from '../../server/contracts/tikhub-content-search.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch, projectHubSocialCompatResponse, threadsAccountRecipe } from '../../server/contracts/hub-social-compat.mjs'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, postCommentRecipe } from '../../server/contracts/post-comments.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'
import { normalizeCommentRepliesRequest, buildCommentRepliesDispatch } from '../../server/contracts/comment-replies.mjs'
import { projectCommentReplyPage } from '../../server/contracts/comment-reply-projection.mjs'
import { defaultCommentRoute } from '../../server/contracts/comment-routes.mjs'
import { normalizeDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { strategySearchCatalog } from '../../server/data/strategy-search-catalog.mjs'
import { strategyPolicyEditor, strategyPolicySummary, commentRouteUpdate } from '../../src/strategy-search-model.js'
import { STRATEGY_SEARCH_PLATFORMS, strategyAccountPlatforms } from '../../src/strategy-search-experience-model.js'
import { strategyCommentPlatforms } from '../../src/strategy-comments-model.js'

const samples = JSON.parse(readFileSync(new URL('../fixtures/threads-rapidapi-samples.json', import.meta.url), 'utf8'))
const capturedAt = '2026-11-11T00:00:00.000Z'
const PEPPER = 'threads-offline-long-pepper-value', SECRET = 'synthetic-threads-rapidapi-key'

test('Threads links decode to the numeric post ID without a paid lookup', () => {
  assert.equal(threadsPostId('C8O-JbtAKrp'), '3390920896561588969')
  assert.equal(threadsPostId('C56JDdzi0RJ'), '3349029093483693129')
  assert.equal(threadsPostId('3390920896561588969_290023231'), '3390920896561588969')
  assert.equal(threadsPostId('3390920896561588969'), '3390920896561588969')
  assert.equal(threadsPostId('not a code'), null)
  const request = normalizePostCommentsRequest({ platform: 'threads', url: 'https://www.threads.net/@someone/post/C8O-JbtAKrp' }, { provider: 'rapidapi' })
  assert.equal(request.postId, '3390920896561588969')
  assert.throws(() => normalizePostCommentsRequest({ platform: 'threads', url: 'https://example.com/@a/post/C8O-JbtAKrp' }, { provider: 'rapidapi' }), { code: 'invalid_post_comments_request' })
})

test('every RapidAPI read route is a reviewed, separately priced operation on its own host', () => {
  assert.equal(THREADS_RAPIDAPI_ENDPOINTS.length, 11)
  const operations = new Set(EXTERNAL_PLATFORM_OPERATION_CATALOG.rapidapi.map(row => row.operationKey))
  for (const row of THREADS_RAPIDAPI_ENDPOINTS) {
    assert.equal(nativeForwardingEndpoint(row.key), row)
    assert.equal(row.host, THREADS_RAPIDAPI_HOST)
    assert(operations.has(row.operation), row.operation)
  }
  assert.equal(new Set(NATIVE_FORWARDING_ENDPOINTS.map(row => row.key)).size, NATIVE_FORWARDING_ENDPOINTS.length)
})

test('search rows keep the standard item shape, with real zero and unknown metrics distinct', () => {
  const { rows, providerPage } = parseThreadsSearchPage(samples.searchRecent, { provider: 'rapidapi', capturedAt })
  assert.equal(rows.length, 2)
  const item = contentSearchDataItem(rows[0])
  assert.deepEqual(Object.keys(item), ['id', 'externalId', 'platform', 'contentType', 'url', 'title', 'text', 'publishedAt', 'collectedAt', 'author', 'metrics', 'media', 'source'])
  assert.deepEqual(item.metrics, { likes: 7, comments: 2, shares: 3, views: null, bookmarks: null })
  assert.equal(item.url, 'https://www.threads.com/@sample_author/post/DHJ6-NSogXR')
  assert.equal(item.publishedAt, new Date(1741902175000).toISOString())
  assert.deepEqual(item.author, { id: '33022838', name: 'sample_author', avatarUrl: 'https://example.invalid/avatar.jpg?sig=1' })
  assert.deepEqual(item.media.images, ['https://example.invalid/photo.webp'])
  const video = contentSearchDataItem(rows[1])
  assert.equal(video.text, 'fragment text')
  assert.equal(video.metrics.likes, 0)
  assert.deepEqual(video.media, { coverUrl: 'https://example.invalid/poster.jpg', images: [], videos: ['https://example.invalid/video.mp4'] })
  assert.deepEqual(providerPage, { hasMore: false, nextParams: null, nextPage: null })
})

test('an error inside an HTTP 200 body is never read as an empty page', () => {
  for (const body of [{ data: null, errors: [{ message: 'denied' }] }, { status: 'fail', message: 'blocked' }, { nothing: true }]) {
    assert.throws(() => parseThreadsSearchPage(body, { provider: 'rapidapi', capturedAt }), /invalid_threads_response/)
  }
})

test('TikHub envelopes share the parser and never claim a continuation', () => {
  const post = samples.searchRecent.data.searchResults.edges[0].node.thread.thread_items[0].post
  const { user, ...bare } = post
  const results = parseThreadsSearchPage({ code: 200, data: { results: [{ post: bare, user }] } }, { provider: 'tikhub', capturedAt })
  assert.equal(results.rows[0].content_id, post.pk)
  assert.equal(results.rows[0].author_id, user.pk)
  const page = parseThreadsAccountPage({ code: 200, data: { threads: [post], next_cursor: 'ignored', has_more: true } },
    { activityType: 'posts', ownerId: user.pk, provider: 'tikhub', capturedAt })
  assert.equal(page.rows.length, 1)
  assert.deepEqual(page.providerPage, { hasMore: false, nextParams: null, nextPage: null })
  const comment = { ...post, text_post_app_info: { ...post.text_post_app_info, is_reply: true } }
  const comments = parseThreadsCommentPage({ code: 200, data: { comments: [comment] } }, '1', { provider: 'tikhub' })
  assert.equal(comments.comments[0].values.commentId, post.pk)
})

const accountStep = (operation, body, provider = 'rapidapi', resolvedIdentity = null) => {
  const job = normalizeHubSocialCompatRequest(operation, { platform: 'threads', ...body }, { provider }).jobs[0]
  return buildHubSocialCompatDispatch(job, { pageSize: 20, resolvedIdentity })
}

test('accounts: usernames resolve by exact match; IDs skip the paid profile call', () => {
  const lookup = accountStep('crawl', { username: '@Sample_News' })
  assert.equal(lookup.key, 'r.threads_search_profiles')
  assert.deepEqual(lookup.upstreamQuery, { query: 'sample_news' })
  const resolved = projectHubSocialCompatResponse(samples.searchProfiles, lookup, { capturedAt })
  assert.equal(resolved.resolvedIdentity.value, '63625256886')
  const data = accountStep('crawl', { username: 'sample_news' }, 'rapidapi', resolved.resolvedIdentity)
  assert.equal(data.key, 'r.threads_user_posts')
  assert.deepEqual(data.upstreamQuery, { user_id: '63625256886' })
  assert.equal(accountStep('crawl', { userId: '63625256886' }).key, 'r.threads_user_posts')
  const ambiguous = { data: { xdt_api__v1__users__search_connection: { edges: [{ node: { pk: '1', username: 'other' } }] } } }
  assert.throws(() => projectHubSocialCompatResponse(ambiguous, lookup, { capturedAt }), { code: 'invalid_social_response' })
  const url = normalizeHubSocialCompatRequest('crawl', { platform: 'threads', url: 'https://www.threads.com/@Sample_News' }, { provider: 'rapidapi' })
  assert.deepEqual(url.jobs[0].identity, { kind: 'username', value: 'sample_news' })
  assert.throws(() => normalizeHubSocialCompatRequest('crawl', { platform: 'threads', userId: 'abc' }), { code: 'invalid_social_request' })
})

test('user-info returns the shared profile fields from both suppliers', () => {
  const step = accountStep('user-info', { userId: '63625256886' })
  assert.equal(step.key, 'r.threads_user_info')
  assert.deepEqual(step.upstreamQuery, { id: '63625256886' })
  const profile = projectHubSocialCompatResponse(samples.userInfo, step, { capturedAt }).profiles[0]
  assert.equal(profile.userId, '63625256886')
  assert.equal(profile.username, 'sample_news')
  assert.equal(profile.displayName, 'Sample News')
  assert.equal(profile.profileUrl, 'https://www.threads.com/@sample_news')
  assert.equal(profile.metrics.followers, 1083901)
  assert.equal(accountStep('user-info', { userId: '63625256886' }, 'tikhub').endpointPath, '/api/v1/threads/web/fetch_user_info_by_id')
  assert.equal(accountStep('user-info', { username: 'sample_news' }, 'tikhub').endpointPath, '/api/v1/threads/web/fetch_user_info')
  assert.throws(() => projectHubSocialCompatResponse({ data: { user: { pk: '999', username: 'someone' } } }, step, { capturedAt }), { code: 'invalid_social_response' })
})

test('account pages keep only the account content and expose the continuation', () => {
  const posts = accountStep('crawl', { userId: '60762270900' })
  const projected = projectHubSocialCompatResponse(samples.userPosts, posts, { capturedAt })
  assert.deepEqual(projected.acquiredItems.map(row => row.externalId), ['3423248872904765000'])
  const row = projected.acquiredItems[0]
  assert.equal(row.id, 'threads:3423248872904765000')
  assert.deepEqual(row.metrics, { likes: 10, comments: 4, shares: 5, views: null, bookmarks: null })
  assert.equal(row.objectType, 'post')
  assert.equal(projected.profiles[0].userId, '60762270900')
  assert.deepEqual(projected.providerPage.nextParams, { end_cursor: 'QVFDRlNSV0k3eDdPTm9CSHFreGRO' })
  const replies = accountStep('crawl', { userId: '60762270900', activityTypes: ['replies'] })
  assert.equal(replies.key, 'r.threads_user_replies')
  const answered = projectHubSocialCompatResponse(samples.userReplies, replies, { capturedAt })
  assert.deepEqual(answered.acquiredItems.map(row => row.externalId), ['3423248872904765395'], 'the post being answered belongs to another account')
  const repeated = buildHubSocialCompatDispatch(replies.socialCompat.job, { pageSize: 20, nextParams: { end_cursor: 'QVFDMWZWbkUzRTBm' } })
  assert.equal(projectHubSocialCompatResponse(samples.userReplies, repeated, { capturedAt }).providerPage.stopReason, 'repeated_cursor')
})

test('comments drop the post itself and carry a replyRef-ready identity', () => {
  const request = normalizePostCommentsRequest({ platform: 'threads', contentId: 'C8O-JbtAKrp' }, { provider: 'rapidapi' })
  const step = buildPostCommentsDispatch(request)
  assert.equal(step.key, 'r.threads_post_comments')
  assert.deepEqual(step.upstreamQuery, { post_id: '3390920896561588969' })
  const page = projectPostCommentPage(samples.postComments, step, { capturedAt })
  assert.deepEqual(page.projected.acquiredItems.map(row => row.commentId), ['3390930071274677885'])
  const row = page.projected.acquiredItems[0]
  assert.equal(row.contentId, '3390920896561588969')
  assert.equal(row.text, 'first level comment')
  assert.equal(row.likeCount, 3)
  assert.equal(row.replyCount, 1)
  assert.equal(row.author.handle, 'commenter')
  assert.deepEqual(page.projected.providerPage.nextParams, { end_cursor: 'GBxkb3dud2FyZF9tb3Jl' })
  assert.equal(page.records.length, 1)
})

test('replies reuse the comments endpoint and name the comment as their parent', () => {
  const request = normalizeCommentRepliesRequest({ platform: 'threads', commentId: '3390920896561588969', contentId: '3390920896561000000' }, { provider: 'rapidapi' })
  const step = buildCommentRepliesDispatch(request)
  assert.deepEqual(step.upstreamQuery, { post_id: '3390920896561588969' })
  const page = projectCommentReplyPage(samples.postComments, step, { capturedAt })
  assert.deepEqual(page.projected.acquiredItems.map(row => [row.commentId, row.rootCommentId, row.parentCommentId, row.type]),
    [['3390930071274677885', '3390920896561588969', '3390920896561588969', 'reply']])
})

test('every field the Threads comment parsers emit is documented', async () => {
  const { COMMENT_ITEM_FIELDS } = await import('../../shared/comment-fields.mjs')
  const documented = new Set(COMMENT_ITEM_FIELDS.map(field => field.name))
  const request = normalizePostCommentsRequest({ platform: 'threads', contentId: '3390920896561588969', includeRaw: true }, { provider: 'rapidapi' })
  const rows = projectPostCommentPage(samples.postComments, buildPostCommentsDispatch(request), { capturedAt }).projected.acquiredItems
  assert.deepEqual([...new Set(rows.flatMap(row => Object.keys(row)))].filter(name => !documented.has(name)), [])
})

test('routing defaults to RapidAPI first on all five interfaces, and each can be switched or paused', async () => {
  const store = new StrategySearchRoutingStore()
  for (const id of ['search', 'crawl', 'user-info', 'post-comments', 'comment-replies']) {
    assert.deepEqual([...strategyRouteProviders(id, 'threads')].sort(),
      id === 'search' ? ['rapidapi', 'rapidapi-threads-scraper', 'tikhub'] : ['rapidapi', 'tikhub'], id)
    const route = await store.get(id, 'threads')
    assert.deepEqual([route.mode, route.primaryProvider, route.fallbackProvider], ['priority', 'rapidapi', 'tikhub'], id)
  }
  assert.deepEqual(defaultCommentRoute('post-comments', 'threads'), { mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub' })
  const switched = await store.update('search', 'threads', { mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 1, reason: 'switch' })
  assert.equal(switched.primaryProvider, 'tikhub')
  await store.update('crawl', 'threads', { mode: 'paused', primaryProvider: 'rapidapi', fallbackProvider: null, expectedRevision: 1, reason: 'pause' })
  await assert.rejects(assertCommentRouteEnabled(store, { platform: 'threads', routeInterface: 'crawl' }), { code: 'threads_acquisition_paused' })
  await assertCommentRouteEnabled(store, { platform: 'threads', routeInterface: 'search' })
  await assert.rejects(store.update('search', 'threads', { mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null, expectedRevision: 2, reason: 'bad' }), { code: 'invalid_strategy_search_route' })
})

test('the admin catalog and product tiles expose Threads on every interface', async () => {
  const store = new StrategySearchRoutingStore()
  const commentPolicies = (await store.list()).filter(row => ['post-comments', 'comment-replies'].includes(row.interface) || row.platform === 'threads')
  const catalog = strategySearchCatalog({ commentPolicies })
  for (const id of ['search', 'crawl', 'user-info', 'post-comments', 'comment-replies']) {
    const row = catalog.interfaces.find(group => group.id === id).platforms.find(item => item.platform === 'threads')
    assert(row, id)
    assert.equal(strategyPolicyEditor(id, row), 'comment-route', id)
    assert.equal(strategyPolicySummary(id, row).editor, 'comment-route')
    assert.equal(commentRouteUpdate(row, { mode: 'paused', primaryProvider: 'rapidapi', reason: 'pause' }).mode, 'paused')
  }
  assert(STRATEGY_SEARCH_PLATFORMS.some(row => row.platform === 'threads'))
  assert(strategyAccountPlatforms(null, 'crawl').some(row => row.platform === 'threads'))
  assert(strategyCommentPlatforms(null, 'comment-replies').some(row => row.platform === 'threads'))
  assert.equal(normalizeDataSearchV2({ platform: 'threads', query: 'q', timeWindow: { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z', timezone: 'UTC', boundary: '[from,to)' } }).platform, 'threads')
})

test('adapter: fixed host and headers, gateway refusals are unbilled, the key is never echoed', async () => {
  const seen = []
  const adapter = new RapidApiAdapter({ apiKey: SECRET, timeoutMs: 100, fetchImpl: async (url, options) => {
    seen.push({ url: String(url), headers: options.headers })
    return Response.json({ data: { user: { pk: '1', username: 'a', note: `leak ${SECRET}` } } })
  } })
  const result = await adapter.forwardNative('r.threads_user_info', { params: { id: '1' } })
  assert.equal(seen[0].url, `https://${THREADS_RAPIDAPI_HOST}/api/user/info?id=1`)
  assert.equal(seen[0].headers['x-rapidapi-host'], THREADS_RAPIDAPI_HOST)
  assert.equal(JSON.stringify(result.publicBody).includes(SECRET), false)
  assert.equal(result.restrictedResponseArchive.httpStatus, 200)
  await assert.rejects(adapter.forwardNative('t.api_01fa5792e82a0605', { params: { query: 'q' } }), TypeError)
  const refused = new RapidApiAdapter({ apiKey: SECRET, timeoutMs: 100, fetchImpl: async () => new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }),
    { status: 403, headers: { 'content-type': 'application/json', 'x-rapidapi-proxy-response': 'true' } }) })
  await assert.rejects(refused.forwardNative('r.threads_user_info', { params: { id: '1' } }), error => {
    assert(error instanceof RapidApiUpstreamError)
    assert.deepEqual([error.evidence.outcome, error.evidence.billed, error.evidence.httpStatus, error.evidence.affectsCircuit], ['rejected', false, 403, false])
    return true
  })
})

async function searchHarness(payload) {
  const store = new MemoryStore(), calls = []
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: { async search() { throw new Error('Night-All must never be called') } } })
  const tenant = await service.createTenant({ name: 'Offline Threads' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Threads caller' })
  await store.setPlatformGrant(consumer.id, 'threads', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'threads', maxRequests: 10000, windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic Threads key', platforms: ['threads'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true,
    timeoutMs: 100, freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const endpoint = nativeForwardingEndpoint(threadsSearchRecipe('threads', 'rapidapi').key)
  await controls.updatePolicy('rapidapi', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Synthetic Threads regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-11T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 1 } } }, { runtime: { config, credentialConfigured: true } })
  const adapter = new RapidApiAdapter({ apiKey: SECRET, timeoutMs: 100, fetchImpl: async url => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) })
    return Response.json(payload(calls.length))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'rapidapi', authorizationPlatform: 'threads', providerCircuit: 'marketplace' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'rapidapi',
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  const route = createCommentRouter({ interfaceId: 'search', gateways: { threads: { rapidapi: gateway } }, policyStore: gateway.strategySearchRoutingStore,
    recipeFor: threadsSearchRecipe, platformFor: () => 'threads', cursorProvider: threadsSearchCursorProvider, bodyFor: input => input.normalized,
    invoke: (selected, current, input) => selected.searchThreads(current, input) })
  const search = (normalized, idempotencyKey) => route(context, { body: normalized, normalized, idempotencyKey,
    dataSearch: { resultType: 'stable', replayWindowMs: 3600000 } })
  return { context, calls, gateway, search, platformStore }
}

test('search runs through Hub delivery: one purchase, replay, signed cursor, then pause', async () => {
  const page = call => call === 1 ? { data: { searchResults: { edges: samples.searchRecent.data.searchResults.edges,
    page_info: { end_cursor: 'next-page', has_next_page: true } } }, status: 'ok' } : samples.searchRecent
  const h = await searchHarness(page)
  const body = { platform: 'threads', query: 'bitcoin', pageSize: 20 }
  const first = await h.search(body, 'threads-search-first')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data.contractVersion, 'night-all.data-search.v1')
  assert.equal(first.body.data.platform, 'threads')
  assert.equal(first.body.data.items.length, 2)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.deepEqual(h.calls, [{ path: '/api/search/recent', params: { query: 'bitcoin' } }], 'a short page buys no automatic continuation')
  const replay = await h.search(body, 'threads-search-first')
  assert.equal(replay.replay, true)
  assert.equal(h.calls.length, 1)
  const cursor = first.body.data.pageInfo.nextCursor
  assert.match(cursor, /^mxds1\./u)
  const second = await h.search({ ...body, cursor }, 'threads-search-second')
  assert.equal(second.status, 200, JSON.stringify(second.body))
  assert.deepEqual(h.calls[1].params, { query: 'bitcoin', end_cursor: 'next-page' })
  assert.equal(second.body.data.pageInfo.hasMore, false)
  await assert.rejects(h.search({ ...body, query: 'other', cursor }, 'threads-search-foreign'), { code: 'invalid_cursor' })
  await h.gateway.strategySearchRoutingStore.update('search', 'threads', { mode: 'paused', primaryProvider: 'rapidapi', fallbackProvider: null, expectedRevision: 1, reason: 'pause' })
  await assert.rejects(h.search({ ...body, query: 'paused' }, 'threads-search-paused'), { code: 'threads_acquisition_paused' })
  assert.equal(h.calls.length, 2, 'a paused route buys nothing')
})

test('search step and ingest accept both suppliers and nothing else', () => {
  const request = { provider: 'tikhub', query: 'bitcoin' }
  const step = buildThreadsSearchDispatch(request)
  assert.equal(step.endpointPath, '/api/v1/threads/web/search_posts')
  assert.equal(threadsSearchRecipe('twitter', 'tikhub'), null)
  const post = samples.searchRecent.data.searchResults.edges[0].node.thread.thread_items[0].post
  const projected = projectThreadsSearchPage({ code: 200, data: { results: [{ post }] } }, step, { capturedAt })
  assert.equal(projected.records[0].objectType, 'post')
  for (const providerKey of ['rapidapi', 'tikhub']) {
    assert.equal(classifyExternalPlatformIngest({ kind: 'external-platform-result', datasetId: 'night-all.search.v1', platform: 'threads', providerKey, records: [] }).hubRaw, true)
    assert.equal(classifyExternalPlatformIngest({ kind: 'external-platform-result', datasetId: 'social.comments.v1', platform: 'threads', providerKey, records: [] }).hubRaw, true)
  }
  assert.throws(() => classifyExternalPlatformIngest({ kind: 'external-platform-result', datasetId: 'night-all.search.v1', platform: 'threads', providerKey: 'justone', records: [] }))
  assert.equal(postCommentRecipe('threads', 'rapidapi').available, true)
  const account = normalizeHubSocialCompatRequest('crawl', { platform: 'threads', userId: '42' })
  assert.deepEqual(threadsAccountRecipe('threads', 'tikhub', account).operationKeys, ['native.t.api_67e96da77f8c4d36'])
})

test('a multi-page Threads cursor cycle stops with unknown completeness', async () => {
  const cursors = ['a', 'b', 'a']
  const h = await searchHarness(call => {
    const payload = structuredClone(samples.searchRecent)
    payload.data.searchResults.page_info = { end_cursor: cursors[call - 1], has_next_page: true }
    return payload
  })
  const input = { platform: 'threads', query: 'cycle', pageSize: 20 }
  let cursor, data
  for (let page = 1; page <= 3; page++) {
    const result = await h.search(cursor ? { ...input, cursor } : input, `threads-cycle-${page}`)
    assert.equal(result.status, 200)
    data = result.body.data
    cursor = data.pageInfo.nextCursor
    if (page < 3) assert.ok(cursor)
  }
  assert.equal(data.pageInfo.hasMore, null)
  assert.equal(cursor, null)
  assert.ok(data.warnings.some(row => row.code === 'repeated_cursor'))
  assert.equal(h.calls.length, 3)
})

test('a saved Threads search buffer with the old terminal-page hash drains once and reports missing pagination', async () => {
  const payload = structuredClone(samples.searchRecent)
  delete payload.data.searchResults.page_info
  const h = await searchHarness(() => payload)
  const body = { platform: 'threads', query: 'buffer', pageSize: 1 }
  const first = await h.search(body, 'threads-buffer-first')
  assert.equal(first.body.data.pageInfo.hasMore, true)
  const usage = h.platformStore.usageStore.requests.get(first.requestId)
  const manifest = usage.acquisitionRequest.socialSearch
  const call = manifest.sources[0]
  const step = buildThreadsSearchDispatch({ provider: 'rapidapi', query: body.query })
  const { projected } = projectThreadsSearchPage(payload, step, { capturedAt: call.capturedAt })
  projected.providerPage.hasMore = false
  manifest.state.jobs[0].buffer.projectionHash = createHash('sha256').update(JSON.stringify(projected)).digest('hex')
  const next = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const second = await h.search(next, 'threads-buffer-second')
  assert.equal(second.body.data.items.length, 1)
  assert.equal(second.body.data.pageInfo.hasMore, null)
  assert.equal(second.body.data.pageInfo.nextCursor, null)
  assert(second.body.data.warnings.some(row => row.code === 'pagination_completeness_unknown'))
  assert.equal(second.body.data.meta.providerCalls, 0)
  const replay = await h.search(next, 'threads-buffer-second')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, second.body)
  assert.equal(h.calls.length, 1)
})
