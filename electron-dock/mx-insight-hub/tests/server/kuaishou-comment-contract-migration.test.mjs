import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, POST_COMMENTS_PATH,
  POST_COMMENTS_RECIPES, POST_COMMENTS_VERSION } from '../../server/contracts/post-comments.mjs'
import { normalizePostCommentsDelivery, postCommentsDeliveryBody, postCommentsPlan } from '../../server/external-platforms/post-comments-workflow.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const pepper = 'kuaishou-comment-migration-offline-secret-32-bytes'
const context = { consumer: { id: '8172f085-d25f-497d-a220-1093cfad8029', businessId: 'fixture' },
  apiKey: { id: 'e138ac5f-b67d-4bb0-bf9f-b046d70dc54f' } }
const codec = createDataSearchCursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}:post-comments`)
const target = { platform: 'kuaishou', postId: 'fixturePhoto123', count: 20 }
// Released JustOne receipt bodies excluded the supplier recipe and defaults.
const identity = { platform: 'kuaishou', postId: 'fixturePhoto123', count: 20, includeRaw: false, options: {} }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const legacyScope = hash({ version: POST_COMMENTS_VERSION, ...identity })
const normalize = (body, historical = false, customCodec = codec) => normalizePostCommentsDelivery(body,
  { context, maxPageSize: 100, codec: customCodec, allowHistoricalProviderCursor: historical })
const signed = (scopeHash, extras = {}) => codec.encode({ version: POST_COMMENTS_VERSION, scopeHash, page: 2,
  previousDeliveryId: '906701b6-8201-4e2a-a622-403c78d11047', expiresAt: Date.now() + 60000, ...extras })
const preparePlan = body => postCommentsPlan({
  gateway: { operationControlStore: {}, apiKeyPepper: pepper, providerKey: 'tikhub' }, context,
  input: { platform: 'kuaishou', path: POST_COMMENTS_PATH, body }, dependencies: {},
})

test('new Kuaishou first pages pin the calibrated TikHub App contract without changing released identities', () => {
  const request = normalizePostCommentsRequest(target), dispatch = buildPostCommentsDispatch(request)
  assert.equal(POST_COMMENTS_RECIPES.kuaishou.key, 't.api_bc64c9d98dbf724c')
  assert.deepEqual(POST_COMMENTS_RECIPES.kuaishou.optionFields, [])
  assert.deepEqual(POST_COMMENTS_RECIPES.kuaishou.continuationFields, ['pcursor'])
  assert.equal(dispatch.provider, 'tikhub')
  assert.equal(dispatch.endpointPath, '/api/v1/kuaishou/app/fetch_video_comment')
  assert.deepEqual(dispatch.upstreamQuery, { photo_id: 'fixturePhoto123' })
  assert.deepEqual(request.fingerprintBody, { ...identity, initialParams: {} })
  assert.deepEqual(normalize(target).fingerprintBody, { ...identity, initialParams: {}, cursor: null })
  for (const body of [{ platform: 'kuaishou', contentId: 'fixturePhoto123' },
    { platform: 'kuaishou', url: 'https://www.kuaishou.com/short-video/fixturePhoto123' }]) {
    assert.deepEqual(normalizePostCommentsRequest(body).fingerprintBody, request.fingerprintBody)
  }
  for (const params of [{ photo_id: 'different' }, { videoId: 'different' }, { sort: 'hot' }, { cursor: 'raw' }]) {
    assert.throws(() => normalizePostCommentsRequest({ ...target, params }), { code: 'invalid_post_comments_request' })
  }
})

test('explicit empty pcursor is a first page with its unchanged old fingerprint', () => {
  const request = normalize({ ...target, params: { pcursor: '' } })
  assert.equal(request.page, 1)
  assert.equal(request.legacyProviderCursor, false)
  assert.equal(request.legacyKuaishouCursor, undefined)
  assert.deepEqual(request.fingerprintBody, { ...identity, initialParams: { pcursor: '' }, cursor: null })
  assert.deepEqual(buildPostCommentsDispatch(request).upstreamQuery, { photo_id: 'fixturePhoto123', pcursor: '' })
  assert.throws(() => normalize({ ...target, cursor: '' }), { code: 'invalid_post_comments_request' })
})

test('nonempty raw pcursor cannot establish its supplier and is unavailable to new acquisition', () => {
  const token = 'opaque+/=&token'
  for (const body of [{ ...target, cursor: token }, { ...target, params: { pcursor: token } },
    { ...target, cursor: token, params: { pcursor: token }, page: 3 }]) {
    assert.throws(() => normalize(body), { code: 'invalid_cursor' })
    assert.throws(() => normalizePostCommentsRequest(body), { code: 'invalid_cursor' })
  }
  // Internal continuation comes from a scoped Hub traversal, never from an
  // unbound public raw token; it must retain the exact opaque provider value.
  const first = normalize(target), cursor = signed(first.scopeHash)
  const page = normalize({ ...target, cursor })
  assert.equal(page.manualProviderPagination, true)
  assert.equal(page.legacyProviderCursor, false)
  assert.deepEqual(buildPostCommentsDispatch(page, { providerCursor: { pcursor: token } }).upstreamQuery,
    { photo_id: 'fixturePhoto123', pcursor: token })
})

test('legacy raw Kuaishou requests keep exact fingerprints under old parameter validation and cannot dispatch', () => {
  const token = 'old-justone+/=&pcursor'
  for (const [body, cursor] of [[{ ...target, cursor: token }, token],
    [{ ...target, params: { pcursor: token } }, null],
    [{ ...target, cursor: token, params: { pcursor: token }, page: 3 }, token]]) {
    const request = normalize(body, true)
    const canonical = normalizePostCommentsRequest(body, { allowHistoricalKuaishouCursor: true })
    assert.equal(request.legacyKuaishouCursor, true)
    assert.equal(request.legacyProviderCursor, true)
    assert.deepEqual(request.fingerprintBody, { ...identity, initialParams: { pcursor: token }, cursor })
    assert.deepEqual(canonical.fingerprintBody, { ...identity, initialParams: { pcursor: token } })
    assert.throws(() => buildPostCommentsDispatch(canonical), { code: 'invalid_cursor' })
    assert.throws(() => buildPostCommentsDispatch(request), { code: 'invalid_cursor' })
    const prepared = preparePlan(body)
    assert.deepEqual(prepared.plan.normalize({ policy: { maxPageSize: 100 } }).fingerprintBody, request.fingerprintBody)
    assert.throws(() => prepared.plan.assemble({ delivery: {}, deadlineAt: Date.now() + 5000 }), { code: 'invalid_cursor' })
  }
  // Both reviewed pcursor schemas are string-only; generic scalar acceptance
  // must not broaden the identities available to historical receipt lookup.
  assert.throws(() => normalize({ ...target, params: { pcursor: 123 } }, true), { code: 'invalid_parameter' })
})

test('new signed Kuaishou scope binds the TikHub App recipe and preserves receipt bodies', () => {
  const first = normalize(target)
  const expectedScope = hash({ version: POST_COMMENTS_VERSION, ...identity,
    recipe: { provider: 'tikhub', key: 't.api_bc64c9d98dbf724c' } })
  assert.equal(first.scopeHash, expectedScope)
  assert.notEqual(first.scopeHash, legacyScope)
  const cursor = signed(first.scopeHash), page = normalize({ ...target, cursor })
  assert.equal(page.page, 2)
  assert.equal(page.legacyProviderCursor, false)
  assert.deepEqual(page.fingerprintBody, { ...identity, initialParams: {}, cursor })
  assert.deepEqual(normalize({ ...target, params: { cursor } }).fingerprintBody, page.fingerprintBody)
  const decoded = codec.decode(first.encodeNext('906701b6-8201-4e2a-a622-403c78d11047'))
  assert.equal(decoded.scopeHash, expectedScope)
})

test('historical signed Kuaishou cursors including expired receipts are replay-only', () => {
  for (const expiresAt of [Date.now() + 60000, Date.now() - 60000]) {
    const cursor = signed(legacyScope, { expiresAt }), body = { ...target, cursor }
    assert.throws(() => normalize(body), { code: 'invalid_cursor' })
    const old = normalize(body, true)
    assert.equal(old.legacyProviderCursor, true)
    assert.deepEqual(old.fingerprintBody, { ...identity, initialParams: {}, cursor })
    assert.throws(() => buildPostCommentsDispatch(old), { code: 'invalid_cursor' })
    const prepared = preparePlan(body)
    prepared.plan.normalize({ policy: { maxPageSize: 100 } })
    assert.throws(() => prepared.plan.assemble({ delivery: {}, deadlineAt: Date.now() + 5000 }), { code: 'invalid_cursor' })
  }
  assert.throws(() => normalize({ ...target, cursor: signed(normalize(target).scopeHash, { expiresAt: Date.now() - 1000 }) }, true), { code: 'invalid_cursor' })
})

test('mixed, foreign, wrong-supplier, cross-Key and mismatched Kuaishou cursors stay rejected', () => {
  const current = normalize(target), cursor = signed(current.scopeHash)
  for (const body of [{ ...target, cursor, params: { pcursor: 'raw' } },
    { ...target, cursor, params: { pcursor: '' } },
    { ...target, cursor, params: { cursor: 'raw' } },
    { ...target, cursor: 'raw', params: { pcursor: 'different' } }]) {
    assert.throws(() => normalize(body, true))
  }
  for (const params of [{ pcursor: 'mxds1.foreign' }, { pcursor: 'mxds2.foreign' }]) {
    assert.throws(() => normalize({ ...target, params }, true), { code: 'invalid_cursor' })
  }
  const webScope = hash({ version: POST_COMMENTS_VERSION, ...identity,
    recipe: { provider: 'tikhub', key: 't.api_3cb972ba91c8fe44' } })
  assert.throws(() => normalize({ ...target, cursor: signed(webScope) }, true), { code: 'invalid_cursor' })
  assert.throws(() => normalize({ ...target, cursor, count: 10 }), { code: 'invalid_cursor' })
  assert.throws(() => normalize({ ...target, cursor, page: 3 }), { code: 'invalid_cursor' })
  assert.throws(() => normalize({ ...target, cursor }, true, createDataSearchCursorCodec(pepper, 'other-Key')), { code: 'invalid_cursor' })
})

test('manual Kuaishou delivery keeps unproven no_more distinct from paid buffer overflow', () => {
  const request = normalize(target), deliveryId = '906701b6-8201-4e2a-a622-403c78d11047'
  const body = (job, warnings) => postCommentsDeliveryBody(request, { rowsByJob: [[{ commentId: '123' }]],
    state: { jobs: [{ upstreamPages: 1, duplicateCount: 0, ...job }] }, calls: 1, warnings, deliveryId })
  const overflow = body({ buffer: {}, done: false }, [])
  assert.equal(overflow.data.page.hasMore, true)
  assert.equal(overflow.data.page.continuationAvailable, true)
  const unknown = body({ buffer: null, done: true }, [{ code: 'pagination_completeness_unknown' }])
  assert.equal(unknown.data.page.hasMore, null)
  assert.equal(unknown.data.page.continuationAvailable, false)
  assert.equal(unknown.data.page.nextCursor, null)
  assert.equal(unknown.data.page.paginationStatus, 'unknown')
  const advancing = body({ buffer: null, done: false }, [{ code: 'pagination_completeness_unknown' }])
  assert.equal(advancing.data.page.hasMore, null)
  assert.equal(advancing.data.page.continuationAvailable, true)
  assert.equal(advancing.data.page.paginationStatus, 'unknown')
})

test('Twitter, Reddit and unmigrated platform continuation contracts remain unchanged', () => {
  for (const [body, key, token] of [
    [{ platform: 'twitter', postId: '2117082385997250767', params: { cursor: 'twitter-token' } }, 'cursor', 'twitter-token'],
    [{ platform: 'reddit', postId: 'post123', params: { after: 'reddit-token' } }, 'after', 'reddit-token'],
  ]) {
    const request = normalize(body)
    assert.equal(request.manualProviderPagination, true)
    assert.equal(request.legacyProviderCursor, false)
    assert.equal(buildPostCommentsDispatch(request).upstreamQuery[key], token)
  }
  const weibo = normalize({ platform: 'weibo', postId: '123', params: { maxId: 'next' } })
  assert.equal(weibo.manualProviderPagination, false)
  const { initialParams, cursor, ...weiboIdentity } = weibo.fingerprintBody
  assert.equal(weibo.scopeHash, hash({ version: POST_COMMENTS_VERSION, ...weiboIdentity }))
})
