import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { TikHubAdapter, TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest, NATIVE_FORWARDING_VERSION } from '../../server/contracts/native-forwarding.mjs'
import { normalizeRawSearch } from '../../server/contracts/raw-search.mjs'
import { projectInstagramSearch } from '../../server/contracts/instagram-search.mjs'
import { createRawSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import legacyInventory from '../../server/data/night-all-provider-inventory.json' with { type: 'json' }
import officialContracts from '../../server/data/provider-official-contracts.json' with { type: 'json' }

// Anonymous shape fixtures only. The flat profile was observed in paid request
// f4362d8b-26e9-41d2-ba25-faa48fcc7567. Terminal comment/reply shapes were
// observed in d24f7dcf-7508-427e-b273-ac18ab161ca6 and
// a0484ff9-fbf8-4113-8314-bed04e317cd2. Nested profile/continuation fixtures
// exercise documented alternatives, not live pagination evidence.
const profile = {
  pk: '9007199254740993', id: '9007199254740993', username: 'fixture_account',
  full_name: '账号示例', follower_count: 12, following_count: 0, media_count: 3,
  is_private: false, is_verified: false, biography: '完整简介\n第二行',
  profile_pic_url: 'https://example.invalid/avatar.jpg',
  profile_pic_url_hd: 'https://example.invalid/avatar-hd.jpg',
  external_url: null, category: 'Creator', edge_followed_by: { count: 12 },
  edge_follow: { count: 0 }, edge_owner_to_timeline_media: { count: 3 },
  _rid: 'fixture-profile-response',
}

async function replay({ key, params, data, path, expectedQuery }) {
  let calls = 0
  const wire = ` {"code":200,"message":"ok","data":${JSON.stringify(data)}}\n`
  const adapter = new TikHubAdapter({ apiKey: 'instagram-fixture-secret', fetchImpl: async (url, options) => {
    calls++
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    const parsed = new URL(url)
    assert.equal(parsed.pathname, path)
    assert.equal(parsed.hash, '', 'hashtags and cursor characters remain query data, never a URL fragment')
    assert.deepEqual(Object.fromEntries(parsed.searchParams), expectedQuery)
    return new Response(wire, { headers: { 'content-type': 'application/json' } })
  } })
  const result = await adapter.forwardNative(key, { deliveryMode: 'live_only', params })
  assert.equal(calls, 1, 'even a response with continuation must not buy the next page')
  assert.deepEqual(result.publicBody.data, data)
  assert.equal(result.publicBody.meta.projection, 'native')
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.records, [])
  assert.equal(result.restrictedResponseArchive.bodyText, wire)
  assert.equal(result.restrictedResponseArchive.bodySha256, createHash('sha256').update(wire).digest('hex'))
}

const instagramSearchKey = 't.instagram_v3_general_search'
const instagramSearchPath = '/api/v1/instagram/v3/general_search'

test('Instagram legacy general-search identity retains the exact official four-parameter contract', () => {
  const endpoint = nativeForwardingEndpoint(instagramSearchKey)
  const official = officialContracts.endpoints.find(row => row.provider === 'tikhub' && row.method === 'GET' && row.path === instagramSearchPath)
  const contract = parameters => parameters.map(({ name, required, type, ...rest }) => ({ name, required, type,
    ...(Object.hasOwn(rest, 'default') ? { default: rest.default } : {}) }))
  const expected = [
    { name: 'query', required: true, type: 'string' },
    { name: 'next_max_id', required: false, type: 'string' },
    { name: 'rank_token', required: false, type: 'string' },
    { name: 'enable_metadata', required: false, type: 'boolean', default: true },
  ]
  assert.deepEqual(contract(official.parameters), expected)
  assert.deepEqual(contract(endpoint.parameters), expected)
  const request = normalizeNativeForwardingRequest(instagramSearchKey, { params: { query: 'justin' } })
  assert.equal(endpoint.key, instagramSearchKey)
  assert.equal(endpoint.operation, `native.${instagramSearchKey}`)
  assert.equal(endpoint.endpointKey, `native.${instagramSearchKey}`)
  assert.equal(request.endpointPath, instagramSearchPath)
  assert.equal(request.method, 'GET')
  assert.equal(request.endpointVersion, legacyInventory.version)
  assert.equal(request.contractVersion, NATIVE_FORWARDING_VERSION)
  assert.deepEqual(request.upstreamQuery, { query: 'justin' }, 'the documented default must not be injected into legacy request identity')
  assert.deepEqual(request.fingerprintBody, { contractVersion: NATIVE_FORWARDING_VERSION, key: instagramSearchKey,
    params: { query: 'justin' }, deliveryMode: 'live_only' })
})

test('Instagram official metadata does not change accepted legacy scalar fingerprints or GET semantics', async () => {
  // Legacy normalization precedes idempotency lookup. Tightening it here would
  // block exact historical replay; published metadata does not rewrite receipts.
  for (const params of [{ query: 123, enable_metadata: 'true' },
    { query: 'justin', enable_metadata: 'false' },
    { query: true, next_max_id: 123, rank_token: false, enable_metadata: 0 }]) {
    const request = normalizeNativeForwardingRequest(instagramSearchKey, { params })
    assert.deepEqual(request.upstreamQuery, params)
    assert.deepEqual(request.fingerprintBody, { contractVersion: NATIVE_FORWARDING_VERSION, key: instagramSearchKey,
      params, deliveryMode: 'live_only' })
    assert.equal(request.endpointVersion, legacyInventory.version)
    await replay({ key: instagramSearchKey, params, path: instagramSearchPath,
      expectedQuery: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
      data: { status: 'ok', items: [], has_more: false } })
  }
})

test('Instagram GET encodes documented and multilingual keywords plus both opaque cursors without inserting metadata defaults', async () => {
  const cursors = { next_max_id: 'next+/==&page=2#tail', rank_token: 'rank 中文+/=&token' }
  for (const query of ['justin', '#fashion', '#fashion/中文&+/ 空格']) {
    for (const metadata of [undefined, false, true]) {
      const params = { query, ...cursors, ...(metadata === undefined ? {} : { enable_metadata: metadata }) }
      const request = normalizeNativeForwardingRequest(instagramSearchKey, { params })
      assert.deepEqual(request.fingerprintBody.params, params)
      await replay({ key: instagramSearchKey, params, path: instagramSearchPath,
        expectedQuery: { query, ...cursors, ...(metadata === undefined ? {} : { enable_metadata: String(metadata) }) },
        data: { status: 'ok', items: [], has_more: false } })
    }
  }
})

test('a generic Swagger code-200 data string remains native evidence and is not a valid standard Instagram search', async () => {
  let calls = 0
  const wire = ' {"code":200,"message":"ok","data":"string"}\n'
  const adapter = new TikHubAdapter({ apiKey: 'instagram-fixture-secret', fetchImpl: async () => {
    calls++
    return new Response(wire, { headers: { 'content-type': 'application/json' } })
  } })
  const result = await adapter.forwardNative(instagramSearchKey, { params: { query: 'justin' } })
  assert.equal(result.publicBody.data, 'string')
  assert.equal(result.restrictedResponseArchive.bodyText, wire)
  assert.throws(() => projectInstagramSearch(result, { query: 'justin', page: 1, pageSize: 20 }), /invalid_instagram_search_shape/)
  assert.equal(calls, 1)
})

for (const continuation of [false, true]) {
  test(`Instagram general search ${continuation ? 'continuation' : 'first page'} preserves HTTP 400 evidence without projection or retry`, async () => {
    const codec = createRawSearchCursorCodec('instagram-offline-cursor-secret', 'fixture-consumer:fixture-key')
    const normalized = { platform: 'instagram', pageSize: 20,
      upstreamBody: { keyword: ' 测试 & fixture ', pageSize: 20 } }
    const first = normalizeRawSearch(normalized, codec)
    const providerCursor = { next_max_id: 'next+/==&page=2', rank_token: 'rank+/==&opaque=1' }
    const request = continuation ? normalizeRawSearch({ ...normalized, upstreamBody: {
      ...normalized.upstreamBody, cursor: first.encodeNext({ page: 2, providerCursor }),
    } }, codec) : first
    const requestId = '11111111-2222-4333-8444-555555555555'
    // Synthetic rejection, not a claim about the incident's uninspected body.
    const payload = { detail: { code: 400, request_id: requestId, message: 'Fixture request rejected.' } }
    const wire = ` ${JSON.stringify(payload)}\n`
    let calls = 0
    const adapter = new TikHubAdapter({ apiKey: 'instagram-fixture-secret', fetchImpl: async (url, options) => {
      calls++
      assert.equal(options.method, 'GET')
      assert.equal(options.body, undefined)
      const parsed = new URL(url)
      assert.equal(parsed.pathname, '/api/v1/instagram/v3/general_search')
      assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        query: '测试 & fixture', enable_metadata: 'true', ...(continuation ? providerCursor : {}),
      }, 'only contract parameters reach TikHub; count/pageSize and the Hub cursor stay local')
      return new Response(wire, { status: 400, headers: { 'content-type': 'application/json' } })
    } })
    await assert.rejects(() => adapter.forwardNative('t.instagram_v3_general_search', { params: request.upstreamQuery }), error => {
      assert.ok(error instanceof TikHubUpstreamError)
      assert.deepEqual(error.evidence, {
        outcome: 'rejected', httpStatus: 400, businessCode: 400, billed: null,
        errorCode: 'upstream_request_rejected', affectsCircuit: false, retryable: false,
      })
      assert.equal(error.responseArchive.contractState, 'provider_rejected')
      assert.equal(error.responseArchive.businessCode, 400)
      assert.equal(error.upstreamEvidence.requestId, requestId)
      assert.equal(error.archiveObjects[0].upstreamRequestId, requestId)
      assert.equal(error.restrictedResponseArchive.bodyText, wire)
      assert.deepEqual(error.restrictedResponseArchive.bodyBytes, Buffer.from(wire))
      assert.equal(error.restrictedResponseArchive.bodySha256, createHash('sha256').update(wire).digest('hex'))
      assert.deepEqual(error.restrictedResponseArchive.parsedPayload, payload)
      return true
    })
    assert.equal(calls, 1, 'a rejected paid attempt never automatically retries or advances pagination')
  })
}

for (const [shape, data] of [['flat live shape', profile], ['documented user wrapper', { user: profile }]]) {
  test(`Instagram profile preserves ${shape}, string IDs, null and independent counters`, async () => {
    await replay({ key: 't.instagram_v3_get_user_profile', params: { username: 'fixture_account' },
      data, path: '/api/v1/instagram/v3/get_user_profile', expectedQuery: { username: 'fixture_account' } })
  })
}

test('Instagram comments preserve JSON cursor bytes and comment identities without search projection or autopaging', async () => {
  const key = 't.api_4167d40172ce25ef'
  const cursor = '{"cached_comments_cursor":"next+/==&page=2","bifilter_token":"opaque\\token"}'
  const data = {
    comments: [{ pk: '18000000000000001', text: '评论😀\n第二行', created_at: 1791777600,
      comment_like_count: 0, child_comment_count: 2, user: { pk: '9007199254740993', username: 'fixture_account' } }],
    next_min_id: cursor, has_more_comments: true, comment_count: 21,
  }
  const first = normalizeNativeForwardingRequest(key, { params: { code: 'fixtureCode' } })
  assert.equal(first.upstreamQuery.sort_order, 'popular')
  assert.equal(Object.hasOwn(first.upstreamQuery, 'min_id'), false)
  // A supplied next_min_id is an opaque min_id parameter, never next_max_id or rank_token.
  await replay({ key, params: { code: 'fixtureCode', min_id: cursor, sort_order: 'newest' }, data,
    path: '/api/v1/instagram/v3/get_post_comments',
    expectedQuery: { code: 'fixtureCode', min_id: cursor, sort_order: 'newest' } })
  assert.throws(() => normalizeNativeForwardingRequest(key, { params: { code: 'fixtureCode', next_max_id: cursor } }), { status: 400 })
  assert.throws(() => normalizeNativeForwardingRequest(key, { params: { code: 'fixtureCode', sort_order: 'recent' } }), { status: 400 })
})

test('Instagram replies keep their separate child cursor and long string request IDs', async () => {
  const cursor = 'child+/cursor==&part=2'
  const params = { media_id: '3440000000000000001', comment_id: '18000000000000001', min_id: cursor }
  await replay({ key: 't.api_4896d158e6531d9a', params,
    path: '/api/v1/instagram/v3/get_comment_replies', expectedQuery: params,
    data: { child_comments: [], next_min_child_cursor: cursor, has_more_tail_child_comments: true } })
})

const terminalParent = {
  pk: '18000000000000001', strong_id__: '18000000000000001', media_id: '3440000000000000001',
  text: '父评论😀', created_at: 1791777600, created_at_utc: 1791777600,
  comment_like_count: 0, child_comment_count: 1, preview_child_comments: [],
  has_more_head_child_comments: true, has_more_tail_child_comments: false, num_head_child_comments: 1,
  user_id: 1234567890, user: { pk: 1234567890, id: '1234567890', pk_id: '1234567890',
    username: 'fixture_commenter', is_private: false, aigm_account_label_info: {} },
}

test('Instagram terminal comments retain counts, caption and pending child metadata with no next cursor', async () => {
  // comment_count need not equal the number of top-level comments. A parent
  // can require a separate reply request even when this comment page is final.
  await replay({ key: 't.api_4167d40172ce25ef', params: { code: 'fixtureCode', sort_order: 'popular' },
    path: '/api/v1/instagram/v3/get_post_comments', expectedQuery: { code: 'fixtureCode', sort_order: 'popular' },
    data: { comments: [terminalParent], comment_count: 2, caption: { pk: '18000000000000003', text: '原帖说明' },
      has_more_comments: false, has_more_headload_comments: false, fb_comments: [],
      has_more_headload_fb_comments: false, status: 'ok', _rid: 'fixture-comments' } })
})

test('Instagram terminal replies preserve parent relationships and independently typed user IDs', async () => {
  // The standalone parent object omits child-page metadata present in the
  // original comment list; do not merge these independent supplier objects.
  const parent = { pk: terminalParent.pk, media_id: terminalParent.media_id, text: terminalParent.text,
    created_at: terminalParent.created_at, comment_like_count: 0, user_id: terminalParent.user_id, user: terminalParent.user }
  const child = { pk: '18000000000000002', media_id: terminalParent.media_id,
    parent_comment_id: terminalParent.pk, replied_to_comment_id: terminalParent.pk,
    text: '回复😀\n第二行', created_at: 1791777700, created_at_utc: 1791777700,
    comment_like_count: 0, user_id: '1234567890', user: terminalParent.user }
  const params = { media_id: terminalParent.media_id, comment_id: terminalParent.pk }
  await replay({ key: 't.api_4896d158e6531d9a', params,
    path: '/api/v1/instagram/v3/get_comment_replies', expectedQuery: params,
    data: { child_comments: [child], child_comment_count: 1, parent_comment: parent,
      has_more_head_child_comments: false, has_more_tail_child_comments: false,
      is_ranked_replies: false, liked_by_media_owner_badge_enabled: true, status: 'ok', _rid: 'fixture-replies' } })
})
