import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'

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
