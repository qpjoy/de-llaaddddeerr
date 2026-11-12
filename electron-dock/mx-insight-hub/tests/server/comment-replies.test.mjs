import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { StrategySearchRoutingStore, assertCommentRouteEnabled, strategyRouteProviders } from '../../server/external-platforms/strategy-search-routing.mjs'
import { createCommentRouter } from '../../server/external-platforms/comment-routing.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { COMMENT_PROVIDER_CATALOG, COMMENT_TARGET_PLATFORMS, defaultCommentRoute, commentRoutePlatforms } from '../../server/contracts/comment-routes.mjs'
import { COMMENT_REPLIES_PATH, COMMENT_REPLIES_VERSION, COMMENT_REPLY_PROVIDER_RECIPES, normalizeCommentRepliesRequest,
  buildCommentRepliesDispatch, instagramMediaId, commentReplyRecipe } from '../../server/contracts/comment-replies.mjs'
import { projectCommentReplyPage } from '../../server/contracts/comment-reply-projection.mjs'
import { POST_COMMENT_PROVIDER_RECIPES, POST_COMMENTS_RECIPES, normalizePostCommentsRequest, buildPostCommentsDispatch,
  bilibiliAid, bilibiliBvid, postCommentRecipe } from '../../server/contracts/post-comments.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { servicePriceDefinition } from '../../server/contracts/service-pricing.mjs'

const capturedAt = '2026-11-07T00:00:00.000Z'
const PEPPER = 'comment-replies-offline-long-pepper', SECRET = 'synthetic-replies-provider-key'
const DOUYIN_VIDEO = '7290000000000000000', DOUYIN_COMMENT = '7300000000000000001'

test('every target platform has comments and replies, and deployment defaults match migration 181', () => {
  for (const platform of COMMENT_TARGET_PLATFORMS) {
    assert(POST_COMMENT_PROVIDER_RECIPES[platform], `${platform} comments`)
    assert(COMMENT_REPLY_PROVIDER_RECIPES[platform], `${platform} replies`)
  }
  const sql = ['181_comment_strategy_routes', '188_threads_strategy_routes'].map(name => readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')).join('\n')
  const seeded = [...sql.matchAll(/\('(post-comments|comment-replies)','([a-z]+)','(fixed|priority)','([a-z]+)',(NULL|'[a-z]+')/gu)]
    .map(([, id, platform, mode, primary, fallback]) => `${id}/${platform}:${mode}:${primary}:${fallback === 'NULL' ? null : fallback.slice(1, -1)}`)
  const expected = ['post-comments', 'comment-replies'].flatMap(id => commentRoutePlatforms(id).map(platform => {
    const route = defaultCommentRoute(id, platform)
    return `${id}/${platform}:${route.mode}:${route.primaryProvider}:${route.fallbackProvider}`
  }))
  assert.deepEqual(seeded.sort(), expected.sort())
  // Main suppliers first; JustOne is the guarantee wherever it has a parser.
  assert.deepEqual(defaultCommentRoute('post-comments', 'douyin'), { mode: 'priority', primaryProvider: 'tikhub', fallbackProvider: 'justone' })
  assert.deepEqual(defaultCommentRoute('post-comments', 'bilibili'), { mode: 'fixed', primaryProvider: 'justone', fallbackProvider: null },
    'TikHub Bilibili comments returned 3 rows of 240,390 on page 1; JustOne stays the default')
  assert.equal(postCommentRecipe('bilibili', 'tikhub').available, true)
  for (const platform of COMMENT_TARGET_PLATFORMS) assert.equal(commentReplyRecipe(platform).available, true, `${platform} replies calibrated`)
})

test('reply requests normalize per-platform identities and accept the replyRef returned with a comment', () => {
  const douyin = normalizeCommentRepliesRequest({ platform: '抖音', replyRef: { commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO } })
  assert.deepEqual(douyin.fingerprintBody, { platform: 'douyin', commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO, count: 20, includeRaw: false })
  assert.equal(douyin.provider, 'tikhub')
  assert.deepEqual(buildCommentRepliesDispatch(douyin).upstreamQuery, { item_id: DOUYIN_VIDEO, comment_id: DOUYIN_COMMENT, cursor: 0, count: 20 })
  assert.throws(() => normalizeCommentRepliesRequest({ platform: 'douyin', commentId: DOUYIN_COMMENT }), /contentId/u)
  assert.throws(() => normalizeCommentRepliesRequest({ platform: 'douyin', commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO, replyRef: { commentId: '1' } }),
    { code: 'invalid_comment_replies_request' })
  const twitter = normalizeCommentRepliesRequest({ platform: 'x', commentId: '1888' })
  assert.equal(twitter.contentId, null, 'Twitter replies need only the comment tweet')
  assert.deepEqual(buildCommentRepliesDispatch(twitter).upstreamQuery, { tweet_id: '1888' })
  const zhihu = normalizeCommentRepliesRequest({ platform: 'zhihu', comment_id: 11223344, count: 5 })
  assert.deepEqual(buildCommentRepliesDispatch(zhihu).upstreamQuery, { comment_id: '11223344', order_by: 'score', limit: '20', offset: '' }, 'documented supplier defaults')
  const bilibili = normalizeCommentRepliesRequest({ platform: 'bilibili', commentId: '99', url: 'https://www.bilibili.com/video/BV17x411w7KC/' })
  assert.equal(bilibili.contentId, '170001', 'BV and AV name the same video identity')
  assert.deepEqual(buildCommentRepliesDispatch(bilibili).upstreamQuery, { bv_id: 'BV17x411w7KC', rpid: '99', pn: 1 })
  assert.throws(() => normalizeCommentRepliesRequest({ platform: 'xiaohongshu', commentId: '123', contentId: 'a'.repeat(24) }), /Xiaohongshu comment ID/u)
  assert.throws(() => normalizeCommentRepliesRequest({ platform: 'reddit', commentId: 'abc', contentId: 'post1' }), /no hidden replies/u)
  const reddit = normalizeCommentRepliesRequest({ platform: 'reddit', replyRef: { platform: 'reddit', commentId: 't1_abc', contentId: 't3_post1', cursor: 'commenttree:abc,::0:ex:' } })
  assert.equal(buildCommentRepliesDispatch(reddit).upstreamQuery.cursor, 'commenttree:abc,::0:ex:')
  assert.throws(() => normalizeCommentRepliesRequest({ platform: 'douyin', commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO, cursor: 'raw' }), { code: 'invalid_cursor' })
  assert.throws(() => normalizeCommentRepliesRequest({ platform: 'youtube', commentId: '1' }), { code: 'platform_operation_unsupported' })
  assert.equal(instagramMediaId('B'), '1')
  assert.equal(bilibiliBvid(170001), 'BV17x411w7KC')
  assert.equal(bilibiliAid('BV1xx411c7mQ'), '1')

})

test('reply parsers keep the requested root, the direct parent and supplier pagination', () => {
  const step = (platform, request, continuation = null) => ({ provider: 'tikhub', commentReplies: {
    request: { platform, includeRaw: false, ...request }, continuation } })
  const douyinRow = (cid, target = '0') => ({ cid, text: `回复 ${cid}`, create_time: 1793577600, digg_count: 2, reply_comment_total: 0,
    aweme_id: DOUYIN_VIDEO, reply_id: DOUYIN_COMMENT, reply_to_reply_id: target, user: { uid: `u${cid}`, nickname: '作者', avatar_thumb: { url_list: ['https://example.invalid/a.png'] } } })
  const douyin = projectCommentReplyPage({ code: 200, data: { status_code: 0, comments: [douyinRow('7400000000000000001'), douyinRow('7400000000000000002', '7400000000000000001')], cursor: 2, has_more: 1 } },
    step('douyin', { commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO }), { capturedAt })
  assert.deepEqual(douyin.projected.acquiredItems.map(row => [row.commentId, row.parentCommentId, row.rootCommentId, row.type]), [
    ['7400000000000000001', DOUYIN_COMMENT, DOUYIN_COMMENT, 'reply'], ['7400000000000000002', '7400000000000000001', DOUYIN_COMMENT, 'reply']])
  assert.deepEqual(douyin.projected.providerPage.nextParams, { cursor: 2 })
  assert.equal(douyin.records.length, 2)
  assert.throws(() => projectCommentReplyPage({ code: 200, data: { status_code: 0, comments: [{ ...douyinRow('1'), reply_id: '999' }] } },
    step('douyin', { commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO }), { capturedAt }), { code: 'invalid_upstream_contract' })

  const zhihuRow = (id, target) => ({ id, content: `子评论 ${id}`, created_time: 1793577600, like_count: 1, child_comment_count: 0,
    reply_root_comment_id: '500', reply_comment_id: target, author: { id: 'a', name: '知友', avatar_url: 'https://example.invalid/z.png' } })
  const zhihu = projectCommentReplyPage({ code: 200, params: { comment_id: '500' }, data: { data: [zhihuRow('501', '500'), zhihuRow('502', '501')],
    paging: { is_end: false, next: 'https://www.zhihu.com/api/v4/comment_v5/comment/500/child_comment?offset=abc&limit=20' } } },
  step('zhihu', { commentId: '500', contentId: null }), { capturedAt })
  assert.deepEqual(zhihu.projected.acquiredItems.map(row => row.parentCommentId), ['500', '501'])
  assert.deepEqual(zhihu.projected.providerPage.nextParams, { offset: 'abc' })
  assert.deepEqual(zhihu.records, [], 'canonical comment records need the post')
  assert.throws(() => projectCommentReplyPage({ code: 200, data: { data: [], paging: { is_end: false, next: 'https://www.zhihu.com/api/v4/comment_v5/answers/1/root_comment?offset=x' } } },
    step('zhihu', { commentId: '500' }), { capturedAt }), { code: 'invalid_upstream_contract' })

  const tweet = (id, conversation = '100') => ({ id, conversation_id: conversation, text: `reply ${id}`, created_at: 'Thu Jan 16 13:49:31 +0000 2025',
    likes: 1, replies: 0, author: { rest_id: '42', name: 'Replier', screen_name: 'replier' } })
  const twitter = projectCommentReplyPage({ code: 200, data: { ...tweet('200'), thread: [tweet('200'), tweet('201'), tweet('100')], cursor: 'next' } },
    step('twitter', { commentId: '200', contentId: null }), { capturedAt })
  assert.deepEqual(twitter.projected.acquiredItems.map(row => [row.commentId, row.contentId, row.rootCommentId]), [['201', '100', '200']])
  assert.throws(() => projectCommentReplyPage({ code: 200, data: { ...tweet('200'), thread: [] } }, step('twitter', { commentId: '200', contentId: '999' }), { capturedAt }),
    { code: 'invalid_upstream_contract' }, 'a supplied post must be the conversation of the comment')

  const weiboRow = id => ({ idstr: id, rootidstr: '600', created_at: 'Mon Nov 03 09:44:56 +0800 2025', text_raw: `楼中楼 ${id}`, like_counts: 0,
    total_number: 0, user: { idstr: '77', screen_name: '微博用户' } })
  const weibo = projectCommentReplyPage({ code: 200, params: { id: '600' }, data: { data: [weiboRow('601')], max_id: '' } },
    step('weibo', { commentId: '600', contentId: null }), { capturedAt })
  assert.deepEqual(weibo.projected.acquiredItems.map(row => row.rootCommentId), ['600'])
  assert.equal(weibo.projected.providerPage.hasMore, false)
})

test('TikHub Douyin comments and JustOne guarantees are selectable recipes with supplier-specific parameters', () => {
  const douyin = normalizePostCommentsRequest({ platform: 'douyin', contentId: DOUYIN_VIDEO }, { provider: 'tikhub' })
  assert.equal(douyin.provider, 'tikhub')
  assert.deepEqual(buildPostCommentsDispatch(douyin).upstreamQuery, { aweme_id: DOUYIN_VIDEO, cursor: 0, count: 20 })
  const step = { provider: 'tikhub', postComments: { request: douyin, continuation: null } }
  const page = projectPostCommentPage({ code: 200, data: { status_code: 0, comments: [{ cid: '1', text: '评论', create_time: 1793577600,
    aweme_id: DOUYIN_VIDEO, digg_count: 3, reply_comment_total: 4, user: { uid: '9', nickname: '作者' } }], cursor: 20, has_more: 1 } }, step, { capturedAt })
  assert.equal(page.projected.acquiredItems[0].replyCount, 4)
  assert.deepEqual(page.projected.providerPage.nextParams, { cursor: 20 })
  const emptyEnd = projectPostCommentPage({ code: 200, data: { status_code: 0, comments: null, cursor: 0, has_more: 0 } }, step, { capturedAt })
  assert.equal(emptyEnd.projected.providerPage.hasMore, false)
  const twitter = normalizePostCommentsRequest({ platform: 'twitter', contentId: '123' }, { provider: 'justone' })
  assert.deepEqual(buildPostCommentsDispatch(twitter).upstreamQuery, { tweetId: '123', cursor: '' })
  assert.equal(normalizePostCommentsRequest({ platform: 'twitter', contentId: '123' }).provider, POST_COMMENTS_RECIPES.twitter.provider)
  assert.throws(() => normalizePostCommentsRequest({ platform: 'instagram', contentId: 'abc' }, { provider: 'justone' }), { code: 'strategy_search_route_unavailable' })
  assert.equal(normalizePostCommentsRequest({ platform: 'bilibili', contentId: 'BV17x411w7KC' }).postId, '170001')
  assert.equal(normalizePostCommentsRequest({ platform: 'bilibili', url: 'https://www.bilibili.com/video/BV17x411w7KC' }).postId, '170001')
})

test('comment routes are editable per platform, default when unsaved, and pause only new purchases', async () => {
  const store = new StrategySearchRoutingStore()
  assert.deepEqual(strategyRouteProviders('post-comments', 'twitter'), ['tikhub', 'justone'])
  assert.deepEqual(strategyRouteProviders('comment-replies', 'reddit'), ['tikhub'])
  assert.deepEqual(strategyRouteProviders('search', 'reddit'), [])
  const route = await store.get('post-comments', 'kuaishou')
  assert.deepEqual([route.mode, route.primaryProvider, route.fallbackProvider], ['priority', 'tikhub', 'justone'])
  await assert.rejects(store.update('comment-replies', 'douyin', { mode: 'priority', primaryProvider: 'tikhub', fallbackProvider: 'justone',
    expectedRevision: 1, reason: 'no JustOne reply parser' }), { code: 'invalid_strategy_search_route' })
  const paused = await store.update('comment-replies', 'douyin', { mode: 'paused', primaryProvider: 'tikhub', fallbackProvider: null,
    expectedRevision: 1, reason: 'Pause replies for maintenance' })
  assert.equal(paused.revision, 2)
  await assert.rejects(assertCommentRouteEnabled(store, { routeInterface: 'comment-replies', platform: 'douyin' }), { code: 'comment_acquisition_paused' })
  await assertCommentRouteEnabled(store, { routeInterface: 'post-comments', platform: 'douyin' })
  await assertCommentRouteEnabled(store, { platform: 'douyin' })
})

test('the router pins cursors, falls back only when the primary is not ready, and keeps paused requests on the primary', async () => {
  const store = new StrategySearchRoutingStore()
  const readiness = { tikhub: false, justone: true }
  const gateway = provider => ({ providerKey: provider, apiKeyPepper: PEPPER,
    async nativeReadiness({ operationKeys }) { return Object.fromEntries(operationKeys.map(key => [key, readiness[provider]])) } })
  const gateways = { twitter: { tikhub: gateway('tikhub'), justone: gateway('justone') } }
  let pinned = null
  const route = createCommentRouter({ interfaceId: 'post-comments', gateways, policyStore: store, recipeFor: postCommentRecipe,
    platformFor: body => body.platform, cursorProvider: () => pinned, invoke: (selected, context, input) => ({ provider: selected.providerKey, routing: input.routing }) })
  const context = { consumer: { id: 'consumer' }, apiKey: { id: 'key' } }
  assert.deepEqual(await route(context, { body: { platform: 'twitter' } }), { provider: 'justone', routing: { interface: 'post-comments', provider: 'justone', reason: 'fallback' } })
  readiness.tikhub = true
  assert.equal((await route(context, { body: { platform: 'twitter' } })).provider, 'tikhub')
  readiness.tikhub = false; pinned = 'tikhub'
  assert.equal((await route(context, { body: { platform: 'twitter' } })).provider, 'tikhub', 'a cursor never changes supplier')
  pinned = 'baseline'
  assert.equal((await route(context, { body: { platform: 'twitter' } })).provider, POST_COMMENTS_RECIPES.twitter.provider)
  pinned = null
  await store.update('post-comments', 'twitter', { mode: 'paused', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 1, reason: 'pause' })
  assert.equal((await route(context, { body: { platform: 'twitter' } })).provider, 'tikhub', 'replay stays readable while paused')
})

async function repliesHarness(payload) {
  const store = new MemoryStore(), calls = []
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: { async legacySearch() { throw new Error('Night-All must never be called') } } })
  const tenant = await service.createTenant({ name: 'Offline replies' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Replies caller' })
  await store.setPlatformGrant(consumer.id, 'douyin', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'douyin', maxRequests: 10000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic replies key', platforms: ['douyin'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true,
    timeoutMs: 100, freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.key === COMMENT_REPLY_PROVIDER_RECIPES.douyin.tikhub.key)
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Synthetic replies regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-07T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } }, { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: SECRET, timeoutMs: 100, fetchImpl: async url => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) })
    return Response.json(payload(calls.length))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'douyin' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  const route = createCommentRouter({ interfaceId: 'comment-replies', gateways: { douyin: { tikhub: gateway } },
    policyStore: gateway.strategySearchRoutingStore, recipeFor: commentReplyRecipe, platformFor: body => body.platform,
    cursorProvider: () => null, invoke: (selected, current, input) => selected.commentReplies(current, { ...input, path: COMMENT_REPLIES_PATH }) })
  return { context, calls, platformStore, invoke: (body, idempotencyKey) => route(context, { body, idempotencyKey }) }
}

test('Douyin replies run through Hub delivery: one purchase, replay, cursor and canonical ingest', async () => {
  const row = cid => ({ cid, text: `回复 ${cid}`, create_time: 1793577600, digg_count: 1, reply_comment_total: 0, aweme_id: DOUYIN_VIDEO,
    reply_id: DOUYIN_COMMENT, reply_to_reply_id: '0', user: { uid: `u${cid}`, nickname: '作者' } })
  const h = await repliesHarness(call => ({ code: 200, data: { status_code: 0, comments: call === 1 ? [row('7400000000000000001'), row('7400000000000000002')] : [row('7400000000000000003')],
    cursor: call * 2, has_more: call === 1 ? 1 : 0 } }))
  const body = { platform: 'douyin', commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO, count: 2 }
  const first = await h.invoke(body, 'replies-first-page')
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.contractVersion, COMMENT_REPLIES_VERSION)
  assert.deepEqual(first.body.data.items.map(item => item.commentId), ['7400000000000000001', '7400000000000000002'])
  assert.equal(first.body.data.commentId, DOUYIN_COMMENT)
  assert.equal(first.body.data.page.paginationStatus, 'continuable')
  assert.deepEqual(h.calls.map(call => call.path), ['/api/v1/douyin/app/v3/fetch_video_comment_replies'])
  assert.deepEqual(h.calls[0].params, { item_id: DOUYIN_VIDEO, comment_id: DOUYIN_COMMENT, cursor: '0', count: '20' })
  const replay = await h.invoke(body, 'replies-first-page')
  assert.equal(replay.replay, true)
  assert.equal(h.calls.length, 1, 'an exact replay never purchases again')
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'replies-second-page')
  assert.deepEqual(second.body.data.items.map(item => item.commentId), ['7400000000000000003'])
  assert.deepEqual(h.calls.map(call => call.params.cursor), ['0', '2'])
  assert.equal(second.body.data.page.hasMore, false)
  await assert.rejects(h.invoke({ ...body, count: 3, cursor: first.body.data.page.nextCursor }, 'replies-foreign-cursor'), { code: 'invalid_cursor' })
  const ingest = h.platformStore.ingestJobs?.at?.(-1)?.payload || h.platformStore.queuedIngest?.at?.(-1)
  if (ingest) assert.equal(classifyExternalPlatformIngest(ingest).hubRaw, true)
  assert.equal(classifyExternalPlatformIngest({ kind: 'external-platform-result', datasetId: 'social.comments.v1', platform: 'douyin',
    providerKey: 'tikhub', records: [] }).hubRaw, true)
})

test('replies share the comment grant and meter', () => {
  assert.deepEqual(servicePriceDefinition(COMMENT_REPLIES_PATH).capabilities, ['social.comments.list'])
  assert.equal(servicePriceDefinition(COMMENT_REPLIES_PATH).meterKey, 'social.comments.list')
  assert.deepEqual(Object.keys(COMMENT_PROVIDER_CATALOG), ['post-comments', 'comment-replies'])
})

test('every field a comment or reply parser emits is documented in the public field registry', async () => {
  const { COMMENT_ITEM_FIELDS } = await import('../../shared/comment-fields.mjs')
  const documented = new Set(COMMENT_ITEM_FIELDS.map(field => field.name))
  const rows = []
  const replyStep = (platform, request) => ({ provider: 'tikhub', commentReplies: { request: { platform, includeRaw: true, ...request }, continuation: null } })
  rows.push(...projectCommentReplyPage({ code: 200, data: { status_code: 0, comments: [{ cid: '1', text: 't', create_time: 1793577600, aweme_id: DOUYIN_VIDEO,
    reply_id: DOUYIN_COMMENT, reply_to_reply_id: '0', user: { uid: '9', nickname: 'n' } }], has_more: 0 } },
  replyStep('douyin', { commentId: DOUYIN_COMMENT, contentId: DOUYIN_VIDEO }), { capturedAt }).projected.acquiredItems)
  rows.push(...projectCommentReplyPage({ code: 200, data: { id: '200', conversation_id: '100', text: 'root', created_at: 'Thu Jan 16 13:49:31 +0000 2025',
    author: { rest_id: '1', name: 'a' }, thread: [{ id: '201', conversation_id: '100', text: 'r', created_at: 'Thu Jan 16 13:49:31 +0000 2025', likes: 1, replies: 0,
      retweets: 0, views: '3', author: { rest_id: '2', name: 'b', screen_name: 'b' } }] } }, replyStep('twitter', { commentId: '200', contentId: null }), { capturedAt }).projected.acquiredItems)
  const douyin = normalizePostCommentsRequest({ platform: 'douyin', contentId: DOUYIN_VIDEO, includeRaw: true }, { provider: 'tikhub' })
  rows.push(...projectPostCommentPage({ code: 200, data: { status_code: 0, comments: [{ cid: '2', text: 'c', create_time: 1793577600, aweme_id: DOUYIN_VIDEO,
    user: { uid: '9' } }], has_more: 0 } }, { provider: 'tikhub', postComments: { request: douyin, continuation: null } }, { capturedAt }).projected.acquiredItems)
  const undocumented = [...new Set(rows.flatMap(row => Object.keys(row)))].filter(name => !documented.has(name))
  assert.deepEqual(undocumented, [])
})

// Anonymized shapes of the live TikHub pages captured on 2026-11-07.
const replyStep = (platform, request, continuation = null) => ({ provider: 'tikhub', commentReplies: {
  request: normalizeCommentRepliesRequest({ platform, ...request }, { provider: 'tikhub' }), continuation } })
const commentStep = (platform, contentId, continuation = null) => ({ provider: 'tikhub', postComments: {
  request: normalizePostCommentsRequest({ platform, contentId }, { provider: 'tikhub' }), continuation } })

test('live-calibrated reply pages: Kuaishou, Bilibili, Instagram (both shapes), Xiaohongshu', () => {
  const ks = projectCommentReplyPage({ code: 200, params: { photo_id: 'ksPhoto1', root_comment_id: '1193254712948' }, data: { result: 1, pcursor: 'no_more',
    subComments: [{ comment_id: 1193284448083, content: '回复', timestamp: 1794056648470, time: '2026-11-07 21:04', author_id: 5649192663, author_name: '作者',
      headurl: 'http://example.invalid/a.jpg', likedCount: 0, reply_to: 2109545562, replyToUserName: '被回复', photo_id: 214897110556 }] } },
  replyStep('kuaishou', { commentId: '1193254712948', contentId: 'ksPhoto1' }), { capturedAt })
  assert.deepEqual(ks.projected.acquiredItems.map(row => [row.commentId, row.rootCommentId, row.parentRelationship, row.replyToUser.id]),
    [['1193284448083', '1193254712948', 'unknown', '2109545562']])
  assert.equal(ks.projected.providerPage.hasMore, false)

  const bili = row => ({ rpid: Number(row.id), rpid_str: row.id, root: 3760801399, root_str: '3760801399', parent_str: row.parent, like: 5, rcount: 0,
    ctime: 1611752781, member: { mid: '1', uname: 'u', avatar: 'https://example.invalid/b.jpg' }, content: { message: '回复' } })
  const b = projectCommentReplyPage({ code: 200, data: { code: 0, data: { page: { num: 1, size: 2, count: 5 }, root: { rpid_str: '3760801399' },
    replies: [bili({ id: '4012538137', parent: '3760801399' }), bili({ id: '4022775726', parent: '4012538137' })] } } },
  replyStep('bilibili', { commentId: '3760801399', contentId: '80433022' }), { capturedAt })
  assert.deepEqual(b.projected.acquiredItems.map(row => row.parentCommentId), ['3760801399', '4012538137'])
  assert.deepEqual(b.projected.providerPage.nextParams, { pn: 2 })

  const igUser = { pk: '10208543319', id: '10208543319', username: 'u', profile_pic_url: 'https://example.invalid/i.jpg' }
  const ig1 = projectCommentReplyPage({ code: 200, data: { status: 'ok', child_comment_count: 3, has_more_head_child_comments: true, has_more_tail_child_comments: false,
    next_min_child_cursor: 'AQHnext', child_comments: [{ pk: '18165209956493692', text: 'r1', created_at_utc: 1793750825, comment_like_count: 12,
      parent_comment_id: '17901411441672617', media_id: '4021909625883988150', user: igUser }] } },
  replyStep('instagram', { commentId: '17901411441672617', contentId: 'DfQsX7pihC2' }), { capturedAt })
  assert.equal(ig1.projected.acquiredItems[0].parentCommentId, '17901411441672617')
  assert.deepEqual(ig1.projected.providerPage.nextParams, { min_id: 'AQHnext' })
  const ig2 = projectCommentReplyPage({ code: 200, data: { count: 2, next_min_id: null, comments: [{ pk: '17929909383423123', id: '17929909383423123', text: 'r2',
    created_at: '2026-11-04T05:57:36Z', like_count: 0, reply_count: 0, user: { pk: '197437644', username: 'g', profile_pic_url: 'https://example.invalid/g.jpg' } }] } },
  replyStep('instagram', { commentId: '17901411441672617', contentId: 'DfQsX7pihC2' }, { min_id: 'AQHnext' }), { capturedAt })
  assert.deepEqual([ig2.projected.acquiredItems[0].publishedAt, ig2.projected.providerPage.hasMore], ['2026-11-04T05:57:36.000Z', false])

  const xhs = projectCommentReplyPage({ code: 200, data: { code: 0, data: { has_more: false, page_context: '{}', comments: [{ id: 'b'.repeat(24), content: '子评论',
    time: 1793070796, like_count: '2', user: { userid: 'u1', nickname: 'n', images: 'https://example.invalid/x.jpg' }, target_comment: { id: 'c'.repeat(24) } }] } } },
  replyStep('xiaohongshu', { commentId: 'a'.repeat(24), contentId: 'd'.repeat(24) }), { capturedAt })
  assert.deepEqual([xhs.projected.acquiredItems[0].parentCommentId, xhs.projected.acquiredItems[0].author.id, Boolean(xhs.projected.acquiredItems[0].publishedAt)], ['c'.repeat(24), 'u1', true])
})

test('live-calibrated comment fixes: Weibo root IDs, Reddit load-more continuation, Xiaohongshu packed cursor, Bilibili TikHub list', () => {
  const weiboRow = { idstr: '5362607335672789', mid: '5362607335672789', rootid: 5362607335672789, rootidstr: '5362607335672789',
    created_at: 'Sat Nov 07 13:18:04 +0800 2026', text_raw: '评论', like_counts: 9, total_number: 0, user: { idstr: '7731349548', screen_name: 'u' } }
  const weibo = projectPostCommentPage({ code: 200, params: { id: '5362606287356626' }, data: { ok: 1, data: [weiboRow], max_id: 139995412781247, total_number: 416 } },
    commentStep('weibo', '5362606287356626'), { capturedAt })
  assert.deepEqual([weibo.projected.acquiredItems.length, weibo.projected.providerPage.nextParams], [1, { max_id: '139995412781247' }],
    'a first-level comment whose rootid is itself is valid')

  const tree = (id, parentId = null, depth = 0) => ({ childCount: 0, depth, parentId, more: null, node: { __typename: 'Comment', id, content: { markdown: 'm' },
    createdAt: '2026-11-07T00:00:00.000Z', score: 1, authorInfo: { id: 't2_a', name: 'a' } } })
  const forest = trees => ({ code: 200, data: { postInfoById: { id: 't3_1xq60mg', commentForest: { pageInfo: { hasNextPage: true }, trees } } } })
  const placeholder = (cursor, parentId = null, depth = 0) => ({ childCount: 3, depth, parentId, node: null, more: { count: 3, cursor } })
  const reddit = projectPostCommentPage(forest([tree('t1_a'), { ...tree('t1_b'), childCount: 2 }, placeholder('commenttree:hidden', 't1_b', 1), placeholder('commenttree:next')]),
    commentStep('reddit', 't3_1xq60mg'), { capturedAt })
  assert.deepEqual(reddit.projected.providerPage.nextParams, { cursor: 'commenttree:next' })
  assert.equal(reddit.projected.acquiredItems.find(row => row.commentId === 't1_b').replyCursor, 'commenttree:hidden')
  const page2 = buildPostCommentsDispatch(normalizePostCommentsRequest({ platform: 'reddit', contentId: 't3_1xq60mg' }, { provider: 'tikhub' }), { providerCursor: { cursor: 'commenttree:next' } })
  assert.equal(page2.endpointPath, '/api/v1/reddit/app/fetch_comment_replies')
  assert.deepEqual([page2.upstreamQuery.post_id, page2.upstreamQuery.cursor, page2.operationKey], ['t3_1xq60mg', 'commenttree:next', 'native.t.api_e0a2654e9c191a80'])

  const xhsRow = { id: 'e'.repeat(24), content: '评论', time: 1793070796, like_count: 1, sub_comment_count: 0, note_id: 'f'.repeat(24),
    user: { userid: 'u2', nickname: 'n2', images: 'https://example.invalid/y.jpg' } }
  const xhs = projectPostCommentPage({ code: 200, data: { code: 0, data: { has_more: true, comments: [xhsRow],
    cursor: JSON.stringify({ contextId: 'ctx', cursor: '6abc732b000000000b0346bd', index: 2, pageArea: 'ALL' }) } } }, commentStep('xiaohongshu', 'f'.repeat(24)), { capturedAt })
  assert.deepEqual(xhs.projected.providerPage.nextParams, { cursor: '6abc732b000000000b0346bd', index: '2', pageArea: 'ALL' })
  assert.deepEqual([xhs.projected.acquiredItems[0].author.id, Boolean(xhs.projected.acquiredItems[0].publishedAt)], ['u2', true])

  const bili = projectPostCommentPage({ code: 200, data: { code: 0, data: { page: { num: 1, size: 20, count: 240390 }, replies: [{ rpid_str: '1', root: 0,
    like: 1, rcount: 2267, ctime: 1611752781, member: { mid: '2', uname: 'u' }, content: { message: 'c' } }] } } }, commentStep('bilibili', 'BV1GJ411x7h7'), { capturedAt })
  assert.equal(bili.projected.acquiredItems[0].replyCount, 2267)
  assert.equal(bili.projected.providerPage.nextParams, null, 'a short page never proves page 2')
})
