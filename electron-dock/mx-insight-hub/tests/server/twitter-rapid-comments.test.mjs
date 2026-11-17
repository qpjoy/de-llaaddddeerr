import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRapidApiTwitterCommentPage } from '../../server/contracts/twitter-rapid-comment-page.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'
import { projectCommentReplyPage } from '../../server/contracts/comment-reply-projection.mjs'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, postCommentRecipe } from '../../server/contracts/post-comments.mjs'
import { normalizeCommentRepliesRequest, buildCommentRepliesDispatch, commentReplyRecipe } from '../../server/contracts/comment-replies.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { normalizePostCommentsDelivery, postCommentsDeliveryBody } from '../../server/external-platforms/post-comments-workflow.mjs'
import { normalizeCommentRepliesDelivery } from '../../server/external-platforms/comment-replies-workflow.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

// Synthetic cases derived from the supplier's official TweetDetail raw example,
// not a captured /replies response or evidence of paid/live calibration:
// https://www.twittrapi.com/docs/reference/tweet-tweetid
const capturedAt = '2026-11-17T00:00:00.000Z'
const tweet = (id, parent = '100', conversation = '100') => ({
  __typename: 'Tweet', rest_id: id,
  core: { user_results: { result: { __typename: 'User', rest_id: '42',
    legacy: { name: 'Example Author', screen_name: 'example', profile_image_url_https: 'https://example.com/avatar.jpg' } } } },
  legacy: { id_str: id, full_text: '  Complete reply\ntext  ', created_at: 'Sat Feb 07 04:39:56 +0000 2026',
    ...(conversation ? { conversation_id_str: conversation } : {}),
    ...(parent ? { in_reply_to_status_id_str: parent } : {}), favorite_count: 0, reply_count: 2 },
})
const content = result => ({ itemType: 'TimelineTweet', tweet_results: { result } })
const module = (...results) => ({ entryId: 'conversationthread-1', content: { entryType: 'TimelineTimelineModule',
  items: results.map((result, index) => ({ entryId: `conversationthread-1-tweet-${index}`, item: { itemContent: content(result) } })) } })
const flat = result => ({ entryId: `tweet-${result.rest_id}`, content: { itemContent: content(result) } })
const cursor = (value, type = 'Bottom') => ({ entryId: `cursor-${type}`, content: { entryType: 'TimelineTimelineCursor', cursorType: type, value } })
const page = (...entries) => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries }] } } })
const postStep = (includeRaw = false) => ({ provider: 'rapidapi', postComments: { request: { platform: 'twitter', postId: '100', includeRaw } } })
const replyStep = contentId => ({ provider: 'rapidapi', commentReplies: { request: { platform: 'twitter', commentId: '200', contentId, includeRaw: false } } })
const pepper = 'twitter-rapid-comments-offline-pagination', commentsPath = '/api/v1/data/social/post-comments'
const repliesPath = '/api/v1/data/social/comment-replies'

async function rapidHarness(response) {
  const calls = [], store = new MemoryStore(), service = new HubService({ store, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Offline Rapid comments' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Comments' })
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
  const endpoint = NATIVE_FORWARDING_ENDPOINTS.find(row => row.key === 'r.twitter_aio_tweet_replies')
  await controls.updatePolicy('rapidapi', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline regression',
    priceBook: { currency: 'USD', pricingAsOf: capturedAt, monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } },
  { runtime: { config, credentialConfigured: true } })
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-provider-key', timeoutMs: 100, fetchImpl: async url => {
    calls.push(String(url))
    return Response.json(response(new URL(url), calls.length))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'rapidapi',
    apiKeyPepper: pepper, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  service.externalPostComments = (current, input) => gateway.postComments(current, { ...input, platform: 'twitter', path: commentsPath })
  return { calls, context, service, platformStore,
    comments: (body, idempotencyKey) => service.postComments(context, { body, idempotencyKey, path: commentsPath }),
    replies: (body, idempotencyKey) => gateway.commentReplies(context, { body, idempotencyKey, platform: 'twitter', path: repliesPath }) }
}

test('RapidAPI comment recipes keep historical TikHub identities and pin the reviewed replies endpoint', () => {
  assert.equal(postCommentRecipe('twitter').provider, 'tikhub')
  assert.equal(commentReplyRecipe('twitter').provider, 'tikhub')
  assert.equal(postCommentRecipe('twitter', 'rapidapi').verification, 'derived')
  assert.equal(commentReplyRecipe('twitter', 'rapidapi').manualPagination, true)
  const request = normalizePostCommentsRequest({ platform: 'twitter', postId: '100', count: 100 }, { provider: 'rapidapi' })
  const step = buildPostCommentsDispatch(request)
  assert.equal(step.key, 'r.twitter_aio_tweet_replies')
  assert.equal(step.endpointPath, '/tweet/{tweetId}/replies')
  assert.deepEqual(step.upstreamQuery, { tweetId: '100', rankingMode: 'Relevance', includePromotedContent: false })
  const replies = normalizeCommentRepliesRequest({ platform: 'twitter', commentId: '200', count: 100 }, { provider: 'rapidapi' })
  assert.deepEqual(buildCommentRepliesDispatch(replies, { providerCursor: { cursor: 'next-page' } }).upstreamQuery,
    { tweetId: '200', rankingMode: 'Relevance', includePromotedContent: false, cursor: 'next-page' })
  assert.equal(Object.hasOwn(step.upstreamQuery, 'count'), false, 'supplier has no replies count parameter')
})

test('RapidAPI raw comments isolate reply modules and preserve visibility wrappers, long text and unknown metrics', () => {
  const first = tweet('201'), second = tweet('202', '201')
  first.quoted_status_result = { result: tweet('999') }
  second.note_tweet = { note_tweet_results: { result: { text: '  Complete long-form reply\nwith all whitespace  ' } } }
  const promoted = tweet('203')
  promoted.promotedMetadata = { advertiser: 'synthetic' }
  const payload = page(flat(tweet('100', null)), flat(tweet('90', null, '90')),
    { entryId: 'who-to-follow-1', content: { items: [{ item: { itemContent: content(tweet('998')) } }] } },
    module(first, { __typename: 'TweetWithVisibilityResults', tweet: second }, promoted), cursor('top', 'Top'), cursor('next'))
  const result = projectPostCommentPage(payload, postStep(true), { capturedAt })
  const [a, b] = result.projected.acquiredItems
  assert.deepEqual(result.projected.acquiredItems.map(row => row.commentId), ['201', '202'])
  assert.equal(a.content, first.legacy.full_text)
  assert.equal(b.content, second.note_tweet.note_tweet_results.result.text)
  assert.equal(a.like_count, 0)
  assert.equal(a.metrics.views, null)
  assert.equal(a.metrics.shares, null)
  assert.equal(a.metrics.bookmarks, null)
  assert.equal(a.metrics.quotes, null)
  assert.equal(a.parentExternalId, '100')
  assert.equal(a.parentCommentId, null)
  assert.equal(a.parentRelationship, 'post')
  assert.equal(b.parentCommentId, '201')
  assert.equal(b.parentRelationship, 'comment')
  assert.equal(a.publishedAt, '2026-02-07T04:39:56.000Z')
  assert.equal(a.author_id, '42')
  assert.equal(a.authorHandle, 'example')
  assert.deepEqual(a.raw, first)
  assert.equal(result.records[0].body, first.legacy.full_text)
  assert.equal(result.records[0].stableFields.connectorId, 'external-platform:rapidapi')
  assert.deepEqual(result.projected.providerPage, { hasMore: true, nextParams: { cursor: 'next' }, nextPage: null })
})

test('RapidAPI replies preserve direct parent evidence and derive the conversation post without inventing unknown relations', () => {
  const payload = page(module(tweet('100', null), tweet('200'), tweet('201', '200'), tweet('202', null)), cursor('next'))
  const result = projectCommentReplyPage(payload, replyStep(null), { capturedAt })
  assert.deepEqual(result.projected.acquiredItems.map(row => [row.commentId, row.contentId, row.rootCommentId]),
    [['201', '100', '200'], ['202', '100', '200']])
  const [known, unknown] = result.projected.acquiredItems
  assert.equal(known.parentCommentId, '200')
  assert.equal(known.parentRelationship, 'comment')
  assert.equal(unknown.parentExternalId, null)
  assert.equal(unknown.parentCommentId, null)
  assert.equal(unknown.parentRelationship, 'unknown')
  assert.equal(unknown.repliesIncluded, null)
  assert.equal(result.records.length, 2)
  assert.throws(() => projectCommentReplyPage(payload, replyStep('999'), { capturedAt }), { code: 'invalid_upstream_contract' })
  const unresolved = projectCommentReplyPage(page(module(tweet('201', null, null))), replyStep(null), { capturedAt })
  assert.equal(unresolved.projected.acquiredItems[0].contentId, null)
  assert.deepEqual(unresolved.records, [], 'unknown root stays delivered and archived, without invented canonical parent')
})

test('RapidAPI pagination uses only top-level Bottom, accepts replace entries and stops on repeated or empty pages', () => {
  const payload = page(module(tweet('201')), cursor('ignored', 'Top'))
  payload.data.threaded_conversation_with_injections_v2.instructions.push({ type: 'TimelineReplaceEntry', entry: cursor('replacement') })
  assert.deepEqual(parseRapidApiTwitterCommentPage(payload, '100').providerPage.nextParams, { cursor: 'replacement' })
  const repeated = parseRapidApiTwitterCommentPage(payload, '100', { cursor: 'replacement' }).providerPage
  assert.equal(repeated.nextParams, null)
  assert.equal(repeated.hasMore, false)
  assert.equal(repeated.stopReason, 'continuation_repeated')
  assert.equal(parseRapidApiTwitterCommentPage(page(cursor('orphaned')), '100').providerPage.nextParams, null)
  assert.equal(parseRapidApiTwitterCommentPage(page(module(tweet('201'))), '100').providerPage.hasMore, false)
  const withThreadCursor = module(tweet('201'))
  withThreadCursor.content.items.push({ item: { itemContent: { itemType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'inner' } } })
  assert.equal(parseRapidApiTwitterCommentPage(page(withThreadCursor), '100').providerPage.nextParams, null)
})

test('RapidAPI malformed/error responses fail as upstream contract errors with no alternate supplier projection', () => {
  for (const payload of [{}, { data: [] }, { errors: [{ message: 'denied' }], ...page() },
    page(module(tweet('201'), tweet('202', '999', '999'))),
    page(module({ __typename: 'Tweet', rest_id: '201', legacy: { full_text: 12 } })),
    page(module(tweet('201')), cursor('bad\0cursor'))]) {
    assert.throws(() => projectPostCommentPage(payload, postStep(), { capturedAt }), { code: 'invalid_upstream_contract' })
  }
})

test('unreviewed timeline instructions cannot silently discard comments or claim an exhausted page', () => {
  const unknown = { type: 'TimelineAddToModule', moduleEntryId: 'conversationthread-1',
    moduleItems: [{ item: { itemContent: content(tweet('202')) } }] }
  for (const prior of [[], [{ type: 'TimelineAddEntries', entries: [module(tweet('201')), cursor('next')] }]]) {
    const payload = { data: { threaded_conversation_with_injections_v2: { instructions: [...prior, unknown] } } }
    assert.throws(() => projectPostCommentPage(payload, postStep(), { capturedAt }), { code: 'invalid_upstream_contract' })
    assert.throws(() => projectCommentReplyPage(payload, replyStep('100'), { capturedAt }), { code: 'invalid_upstream_contract' })
  }
  for (const unsupported of [
    { type: 'TimelinePinEntry', entry: flat(tweet('201')) },
    { type: 'NewTimelineShape', entries: [module(tweet('201'))] },
    { type: 'TimelineClearCache', moduleItems: unknown.moduleItems },
  ]) {
    const payload = page()
    payload.data.threaded_conversation_with_injections_v2.instructions.push(unsupported)
    assert.throws(() => parseRapidApiTwitterCommentPage(payload, '100'), { code: 'invalid_upstream_contract' })
  }
  const documented = page(module(tweet('201')))
  documented.data.threaded_conversation_with_injections_v2.instructions.unshift({ type: 'TimelineClearCache' })
  assert.equal(parseRapidApiTwitterCommentPage(documented, '100').comments.length, 1)
})

test('unsupported paid response instructions remain archived and replay failure without buying another page', async () => {
  const payload = page(module(tweet('201')), cursor('next'))
  payload.data.threaded_conversation_with_injections_v2.instructions.push({ type: 'TimelineAddToModule',
    moduleEntryId: 'conversationthread-1', moduleItems: [{ item: { itemContent: content(tweet('202')) } }] })
  const h = await rapidHarness(() => payload)
  const body = { platform: 'twitter', postId: '100' }
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(h.comments(body, 'unsupported-instruction'), { code: 'external_platform_response_unusable' })
  }
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 0, 'partial parsed rows must not enter canonical data')
  const archives = [...h.platformStore.restrictedResponseArchives.values()]
  assert.equal(archives.length, 1)
  assert.deepEqual(JSON.parse(archives[0].bodyBytes.toString('utf8')), payload)
})

test('RapidAPI short and empty pages buy once, replay without another call and bind continuation to RapidAPI', async () => {
  for (const rows of [[], [tweet('201')]]) {
    const { calls, context, comments: invoke } = await rapidHarness(() => page(module(...rows), cursor('next-page')))
    const body = { platform: 'twitter', postId: '100', count: 100 }
    const first = await invoke(body, 'rapid-comments-first')
    assert.equal(calls.length, 1, 'short/empty supplier page cannot automatically purchase another')
    assert.equal(first.body.data.items.length, rows.length)
    const replay = await invoke(body, 'rapid-comments-first')
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
    assert.equal(calls.length, 1)
    const nextCursor = first.body.data.page.nextCursor
    if (!rows.length) {
      assert.equal(nextCursor, null, 'official cursor rules stop empty pages')
      continue
    }
    assert.match(nextCursor, /^mxds1\./u)
    const codec = createDataSearchCursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}:post-comments`)
    assert.equal(codec.decode(nextCursor).provider, 'rapidapi')
    assert.throws(() => normalizePostCommentsDelivery({ ...body, cursor: nextCursor },
      { context, maxPageSize: 100, codec, provider: 'tikhub' }), { code: 'invalid_cursor' })
    await invoke({ ...body, cursor: nextCursor }, 'rapid-comments-next')
    assert.equal(calls.length, 2, 'explicit next-page request buys only one additional page')
    assert.equal(new URL(calls[1]).searchParams.get('cursor'), 'next-page')
  }
})

test('RapidAPI replies to a reply-target comment accept its replyRef and keep standard raw aliases and manual pagination', async () => {
  const h = await rapidHarness((url, ordinal) => {
    if (ordinal === 1) { assert.equal(url.pathname, '/tweet/200/replies'); return page(module(tweet('201', '200'))) }
    assert.equal(url.pathname, '/tweet/201/replies')
    return page(module(tweet(ordinal === 2 ? '202' : '203', '201')), cursor(ordinal === 2 ? 'reply-next' : 'reply-last'))
  })
  const first = await h.comments({ platform: 'twitter', postId: '200' }, 'reply-target-comments')
  const comment = first.body.data.items[0]
  assert.equal(comment.postId, '200', 'post-comments keeps the requested target identity')
  assert.equal(comment.contentId, '200')
  assert.equal(comment.conversationId, '100')
  assert.deepEqual(comment.replyRef, { platform: 'twitter', commentId: '201', contentId: '100' })
  const body = { platform: 'twitter', replyRef: comment.replyRef, count: 100 }
  const replies = await h.replies(body, 'reply-target-replies')
  assert.equal(h.calls.length, 2, 'a short reply page buys only once')
  assert.equal(replies.body.data.contentId, '100')
  assert.equal(replies.body.data.items[0].rootCommentId, '201')
  assert.equal(replies.body.data.items[0].parentCommentId, '201')
  assert.equal(replies.body.data.items[0].contentId, '100')
  assert.equal(replies.body.data.items[0].type, 'reply')
  assert.equal(replies.body.data.items[0].objectType, 'comment')
  for (const response of [first, replies]) {
    const data = response.body.data
    assert.equal(typeof data.raw_info, 'string')
    assert.equal(typeof data.raw_data, 'string')
    assert.deepEqual(JSON.parse(data.raw_info), [])
    assert.deepEqual(JSON.parse(data.raw_data), data.items)
    assert.deepEqual(data.comments ?? data.replies, data.items)
    assert.equal(Object.hasOwn(data.items[0], 'raw'), false)
    assert.equal(data.items[0].metrics.views, null)
    assert.equal(data.items[0].like_count, 0)
  }
  const replay = await h.replies(body, 'reply-target-replies')
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, replies.body)
  assert.equal(h.calls.length, 2)
  const next = replies.body.data.page.nextCursor
  const codec = createDataSearchCursorCodec(pepper, `${h.context.consumer.id}:${h.context.apiKey.id}:comment-replies`)
  assert.equal(codec.decode(next).provider, 'rapidapi')
  assert.throws(() => normalizeCommentRepliesDelivery({ ...body, cursor: next },
    { context: h.context, maxPageSize: 100, codec, provider: 'tikhub' }), { code: 'invalid_cursor' })
  const continued = await h.replies({ ...body, cursor: next }, 'reply-target-replies-next')
  assert.equal(h.calls.length, 3)
  assert.equal(new URL(h.calls[2]).searchParams.get('cursor'), 'reply-next')
  assert.equal(continued.body.data.items[0].commentId, '203')
})

test('RapidAPI standard comment fields retain TikHub/JustOne delivery types without rewriting unknown counts or legacy root identities', () => {
  const raw = tweet('201', null)
  delete raw.legacy.reply_count
  const rapid = projectPostCommentPage(page(module(raw)), postStep(), { capturedAt }).projected.acquiredItems[0]
  const tikhub = projectPostCommentPage({ code: 200, data: { id: '100', conversation_id: '100', cursor: null, thread: [{
    id: '201', conversation_id: '100', text: raw.legacy.full_text, created_at: raw.legacy.created_at,
    author: { rest_id: '42', name: 'Example Author', screen_name: 'example' }, likes: 0,
  }] } }, { ...postStep(), provider: 'tikhub' }, { capturedAt }).projected.acquiredItems[0]
  const justone = projectPostCommentPage({ code: 0, data: { status: 'ok', next_cursor: null, timeline: [{
    type: 'tweet', tweet_id: '201', conversation_id: '100', in_reply_to_status_id_str: '100',
    text: raw.legacy.full_text, created_at: raw.legacy.created_at, favorites: 0,
    user_info: { rest_id: '42', name: 'Example Author', screen_name: 'example' },
  }] } }, { ...postStep(), provider: 'justone' }, { capturedAt }).projected.acquiredItems[0]
  const stable = ['id', 'externalId', 'commentId', 'content_id', 'postId', 'contentId', 'rootExternalId', 'platform',
    'objectType', 'type', 'content', 'text', 'full_text', 'author_id', 'author_name', 'authorHandle', 'publishedAt',
    'collected_at', 'likeCount', 'like_count', 'replyCount', 'reply_count', 'url', 'metrics']
  for (const previous of [tikhub, justone]) {
    for (const key of stable) assert.deepEqual(rapid[key], previous[key], key)
  }
  assert.equal(rapid.parentExternalId, null)
  assert.equal(rapid.parentRelationship, 'unknown')
  const request = { platform: 'twitter', postId: '200', page: 1, pageSize: 20, manualProviderPagination: true }
  const delivered = row => postCommentsDeliveryBody(request, { rowsByJob: [[row]],
    state: { jobs: [{ done: true, upstreamPages: 1 }] }, calls: 1, warnings: [], deliveryId: 'synthetic' }).data.items[0]
  assert.equal(delivered({ ...rapid, postId: '200', contentId: '200' }).replyRef.contentId, '100')
  assert.equal(delivered({ ...rapid, conversationId: null, postId: '200', contentId: '200' }).replyRef.contentId, '200',
    'the old fallback remains when the conversation root is unknown')
})
