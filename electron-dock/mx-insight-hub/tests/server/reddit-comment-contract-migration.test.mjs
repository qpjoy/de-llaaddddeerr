import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, POST_COMMENTS_PATH,
  POST_COMMENTS_RECIPES, POST_COMMENTS_VERSION } from '../../server/contracts/post-comments.mjs'
import { normalizePostCommentsDelivery, postCommentsDeliveryBody, postCommentsPlan } from '../../server/external-platforms/post-comments-workflow.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const pepper = 'reddit-comment-migration-offline-secret-32-bytes'
const context = { consumer: { id: '8172f085-d25f-497d-a220-1093cfad8029', businessId: 'fixture' },
  apiKey: { id: 'e138ac5f-b67d-4bb0-bf9f-b046d70dc54f' } }
const codec = createDataSearchCursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}:post-comments`)
const target = { platform: 'reddit', postId: 'post123', count: 20 }
// Released JustOne identity, before the supplier migration. Supplier defaults,
// recipe and provider have never belonged to this immutable receipt body.
const identity = { platform: 'reddit', postId: 't3_post123', count: 20, includeRaw: false, options: {} }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const legacyScope = hash({ version: POST_COMMENTS_VERSION, ...identity })
const normalize = (body, historical = false, customCodec = codec) => normalizePostCommentsDelivery(body,
  { context, maxPageSize: 100, codec: customCodec, allowHistoricalProviderCursor: historical })
const signed = (scopeHash, extras = {}) => codec.encode({ version: POST_COMMENTS_VERSION, scopeHash, page: 2,
  previousDeliveryId: '906701b6-8201-4e2a-a622-403c78d11047', expiresAt: Date.now() + 60000, ...extras })

test('new Reddit first pages pin TikHub and keep the released fingerprint without new defaults', () => {
  const request = normalizePostCommentsRequest(target), dispatch = buildPostCommentsDispatch(request)
  assert.equal(POST_COMMENTS_RECIPES.reddit.key, 't.api_c7f50cf300d63960')
  assert.deepEqual(POST_COMMENTS_RECIPES.reddit.optionFields, [])
  assert.deepEqual(POST_COMMENTS_RECIPES.reddit.continuationFields, ['after'])
  assert.equal(dispatch.provider, 'tikhub')
  assert.equal(dispatch.endpointPath, '/api/v1/reddit/app/fetch_post_comments')
  assert.equal(dispatch.upstreamQuery.post_id, 't3_post123')
  assert.equal(dispatch.upstreamQuery.need_format, false)
  assert.equal(dispatch.upstreamQuery.postId, undefined)
  assert.equal(dispatch.upstreamQuery.cursor, undefined)
  assert.deepEqual(request.fingerprintBody, { ...identity, initialParams: {} })
  assert.deepEqual(normalize(target).fingerprintBody, { ...identity, initialParams: {}, cursor: null })
  for (const body of [{ platform: 'reddit', contentId: 't3_post123', count: 20 },
    { platform: 'reddit', url: 'https://www.reddit.com/r/test/comments/post123/title/', count: 20 }]) {
    assert.deepEqual(normalizePostCommentsRequest(body).fingerprintBody, request.fingerprintBody)
  }
  for (const params of [{ need_format: true }, { sort_type: 'NEW' }, { language: 'en-US' }]) {
    assert.throws(() => normalizePostCommentsRequest({ ...target, params }), { code: 'invalid_post_comments_request' })
  }
})

test('new raw TikHub continuation requires explicit params.after and never translates legacy cursor', () => {
  const token = 'opaque+/=&after-token', request = normalize({ ...target, params: { after: token } })
  assert.deepEqual(request.initialParams, { after: token })
  assert.equal(request.importedContinuation, true)
  assert.equal(request.manualProviderPagination, true)
  assert.equal(request.legacyProviderCursor, false)
  assert.equal(buildPostCommentsDispatch(request).upstreamQuery.after, token)
  for (const body of [{ ...target, cursor: token }, { ...target, params: { cursor: token } }]) {
    assert.throws(() => normalize(body), { code: 'invalid_cursor' })
    assert.throws(() => normalizePostCommentsRequest(body), { code: 'invalid_cursor' })
  }
  assert.throws(() => buildPostCommentsDispatch(normalize(target), { providerCursor: { cursor: token } }), { code: 'unsupported_request_field' })
})

test('legacy raw cursor receipts retain exact identities using the old supplier parameter validation', () => {
  const token = 'old-justone+/=&cursor'
  for (const [body, expectedCursor, expectedInitial] of [
    [{ ...target, cursor: token }, token, { cursor: token }],
    [{ ...target, params: { cursor: token } }, null, { cursor: token }],
    [{ ...target, cursor: token, params: { cursor: token }, page: 3 }, token, { cursor: token }],
    [{ ...target, params: { cursor: '' } }, null, { cursor: '' }],
  ]) {
    const request = normalize(body, true)
    assert.equal(request.legacyRedditCursor, true)
    assert.equal(request.legacyProviderCursor, true)
    assert.deepEqual(request.fingerprintBody, { ...identity, initialParams: expectedInitial, cursor: expectedCursor })
    assert.deepEqual(normalizePostCommentsRequest(body, { allowHistoricalRedditCursor: true }).initialParams, expectedInitial)
    assert.throws(() => buildPostCommentsDispatch(request), { code: 'invalid_cursor' })
  }
  // JustOne's reviewed cursor schema was string-only, even though generic
  // params admit scalar numbers. Do not broaden historical replay identities.
  assert.throws(() => normalize({ ...target, params: { cursor: 123 } }, true), { code: 'invalid_parameter' })
})

test('new signed scope binds Reddit provider and key without changing receipt fingerprints', () => {
  const first = normalize(target)
  const expectedScope = hash({ version: POST_COMMENTS_VERSION, ...identity,
    recipe: { provider: 'tikhub', key: 't.api_c7f50cf300d63960' } })
  assert.equal(first.scopeHash, expectedScope)
  assert.notEqual(first.scopeHash, legacyScope)
  const cursor = signed(first.scopeHash)
  const page = normalize({ ...target, cursor })
  assert.equal(page.page, 2)
  assert.equal(page.legacyProviderCursor, false)
  assert.deepEqual(page.fingerprintBody, { ...identity, initialParams: {}, cursor })
  assert.deepEqual(normalize({ ...target, params: { cursor } }).fingerprintBody, page.fingerprintBody)
  const decoded = codec.decode(first.encodeNext('906701b6-8201-4e2a-a622-403c78d11047'))
  assert.equal(decoded.scopeHash, expectedScope)
})

test('historical signed scope is replay-only, including expired receipts, and never acquires', () => {
  for (const expiresAt of [Date.now() + 60000, Date.now() - 60000]) {
    const cursor = signed(legacyScope, { expiresAt }), body = { ...target, cursor }
    assert.throws(() => normalize(body), { code: 'invalid_cursor' })
    const old = normalize(body, true)
    assert.equal(old.legacyProviderCursor, true)
    assert.deepEqual(old.fingerprintBody, { ...identity, initialParams: {}, cursor })
    const prepared = postCommentsPlan({ gateway: { operationControlStore: {}, apiKeyPepper: pepper, providerKey: 'tikhub' },
      context, input: { platform: 'reddit', path: POST_COMMENTS_PATH, body }, dependencies: {} })
    prepared.plan.normalize({ policy: { maxPageSize: 100 } })
    assert.throws(() => prepared.plan.assemble({ delivery: {}, deadlineAt: Date.now() + 5000 }), { code: 'invalid_cursor' })
  }
  const current = normalize(target)
  assert.throws(() => normalize({ ...target, cursor: signed(current.scopeHash, { expiresAt: Date.now() - 1000 }) }, true), { code: 'invalid_cursor' })
})

test('old raw cursor bodies cannot reach assembly even when admitted for exact replay lookup', () => {
  for (const body of [{ ...target, cursor: 'old-provider' }, { ...target, params: { cursor: 'old-provider' } }]) {
    const prepared = postCommentsPlan({ gateway: { operationControlStore: {}, apiKeyPepper: pepper, providerKey: 'tikhub' },
      context, input: { platform: 'reddit', path: POST_COMMENTS_PATH, body }, dependencies: {} })
    const request = prepared.plan.normalize({ policy: { maxPageSize: 100 } })
    assert.equal(request.legacyProviderCursor, true)
    assert.throws(() => prepared.plan.assemble({ delivery: {}, deadlineAt: Date.now() + 5000 }), { code: 'invalid_cursor' })
  }
})

test('mixed, foreign, cross-Key and mismatched signed continuation stays rejected', () => {
  const current = normalize(target), cursor = signed(current.scopeHash)
  for (const body of [{ ...target, cursor, params: { after: 'new' } },
    { ...target, cursor: 'old', params: { after: 'new' } },
    { ...target, params: { cursor: 'old', after: 'new' } },
    { ...target, cursor, params: { cursor: 'old' } },
    { ...target, cursor: 'old', params: { cursor: 'different' } }]) {
    assert.throws(() => normalize(body, true))
  }
  for (const params of [{ after: 'mxds1.foreign' }, { cursor: 'mxds2.foreign' }]) {
    assert.throws(() => normalize({ ...target, params }, true), { code: 'invalid_cursor' })
  }
  assert.throws(() => normalize({ ...target, cursor, count: 10 }), { code: 'invalid_cursor' })
  assert.throws(() => normalize({ ...target, cursor, page: 3 }), { code: 'invalid_cursor' })
  assert.throws(() => normalize({ ...target, cursor }, true, createDataSearchCursorCodec(pepper, 'other-Key')), { code: 'invalid_cursor' })
})

test('manual Reddit delivery distinguishes paid overflow from unproven upstream continuation', () => {
  const request = normalize(target), deliveryId = '906701b6-8201-4e2a-a622-403c78d11047'
  const body = (job, warnings) => postCommentsDeliveryBody(request, { rowsByJob: [[{ commentId: 't1_c1' }]],
    state: { jobs: [{ upstreamPages: 1, duplicateCount: 0, ...job }] }, calls: 1, warnings, deliveryId })
  const overflow = body({ buffer: {}, done: false }, [])
  assert.equal(overflow.data.page.hasMore, true)
  assert.equal(overflow.data.page.continuationAvailable, true)
  const unknown = body({ buffer: null, done: true }, [{ code: 'pagination_completeness_unknown' }])
  assert.equal(unknown.data.page.hasMore, null)
  assert.equal(unknown.data.page.continuationAvailable, false)
  assert.equal(unknown.data.page.paginationStatus, 'unknown')
  assert.equal(body({ buffer: null, done: true }, []).data.page.hasMore, false)
})

test('Twitter migration and unrelated platform cursor scope remain unchanged', () => {
  const twitter = normalize({ platform: 'twitter', postId: '2117082385997250767', params: { cursor: 'current-twitter' } })
  assert.equal(twitter.manualProviderPagination, true)
  assert.equal(twitter.legacyProviderCursor, false)
  assert.equal(buildPostCommentsDispatch(twitter).upstreamQuery.cursor, 'current-twitter')
  const weibo = normalize({ platform: 'weibo', postId: '123', params: { maxId: 'next' } })
  assert.equal(weibo.manualProviderPagination, false)
  const { initialParams, cursor, ...weiboIdentity } = weibo.fingerprintBody
  assert.equal(weibo.scopeHash, hash({ version: POST_COMMENTS_VERSION, ...weiboIdentity }))
})
