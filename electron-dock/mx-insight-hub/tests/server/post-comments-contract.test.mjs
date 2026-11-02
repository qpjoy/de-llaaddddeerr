import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, POST_COMMENTS_RECIPES } from '../../server/contracts/post-comments.mjs'

const fixtures = { twitter: '2117082385997250767', reddit: '1q4aqti', kuaishou: '3xfake', instagram: 'fixtureCode',
  weibo: '5277757077719364', douyin: '7222964143060520251', tiktok: '7566514353940204807', zhihu: '89226347214',
  linkedin: '7267273010393358336', bilibili: '751305050', facebook: '943942181111136',
  xiaohongshu: '675d277d000000000600e655', youtube: 'dQw4w9WgXcQ' }

test('all thirteen platform recipes dispatch a minimal request with server-owned provider identity', () => {
  assert.equal(Object.keys(POST_COMMENTS_RECIPES).length, 13)
  for (const [platform, postId] of Object.entries(fixtures)) {
    const request = normalizePostCommentsRequest({ platform, postId })
    const dispatch = buildPostCommentsDispatch(request)
    assert.equal(request.count, 20)
    assert.equal(request.includeRaw, false)
    assert.equal(dispatch.platform, platform)
    assert.equal(dispatch.endpointPath, POST_COMMENTS_RECIPES[platform].path)
    assert.equal(dispatch.provider, POST_COMMENTS_RECIPES[platform].provider)
    assert.equal(dispatch.upstreamQuery[POST_COMMENTS_RECIPES[platform].idField], request.postId)
  }
})

test('postId, contentId and canonical URL resolve the same target and reject disagreements', () => {
  const postId = fixtures.twitter
  const expected = normalizePostCommentsRequest({ platform: 'twitter', postId }).fingerprintBody
  for (const body of [{ platform: 'x', contentId: postId }, { platform: 'twitter', url: `https://x.com/account/status/${postId}` },
    { platform: 'twitter', postId, contentId: postId, url: `https://twitter.com/account/status/${postId}` }]) {
    assert.deepEqual(normalizePostCommentsRequest(body).fingerprintBody, expected)
  }
  for (const body of [{ platform: 'twitter', postId, contentId: '123' },
    { platform: 'twitter', postId, url: 'https://x.com/account/status/123' },
    { platform: 'twitter', postId: Number(postId) }]) {
    assert.throws(() => normalizePostCommentsRequest(body), { code: 'invalid_post_comments_request' })
  }
})

test('count aliases share default 20 and limit 100 under the consumer page-size ceiling', () => {
  for (const alias of ['count', 'pageSize', 'limit']) {
    assert.equal(normalizePostCommentsRequest({ platform: 'weibo', postId: fixtures.weibo, [alias]: 100 }).count, 100)
    assert.throws(() => normalizePostCommentsRequest({ platform: 'weibo', postId: fixtures.weibo, [alias]: 101 }), { code: 'invalid_post_comments_request' })
  }
  assert.equal(normalizePostCommentsRequest({ platform: 'weibo', postId: fixtures.weibo }, { maxPageSize: 10 }).count, 10)
  assert.throws(() => normalizePostCommentsRequest({ platform: 'weibo', postId: fixtures.weibo, count: 20, pageSize: 10 }), { code: 'invalid_post_comments_request' })
})

test('legacy provider cursors map only to the fixed recipe continuation fields', () => {
  const request = normalizePostCommentsRequest({ platform: 'twitter', postId: fixtures.twitter, cursor: 'opaque+/=&token' })
  assert.equal(buildPostCommentsDispatch(request).upstreamQuery.cursor, 'opaque+/=&token')
  const xhs = normalizePostCommentsRequest({ platform: 'xiaohongshu', postId: fixtures.xiaohongshu,
    params: { cursor: 'next', index: 2, pageArea: 'ALL' } })
  assert.equal(buildPostCommentsDispatch(xhs).upstreamQuery.pageArea, 'ALL')
  assert.throws(() => normalizePostCommentsRequest({ platform: 'xiaohongshu', postId: fixtures.xiaohongshu, cursor: 'next' }), { code: 'invalid_post_comments_request' })
})

test('opaque Hub cursor supplied in params is an alias and cannot be mixed with raw continuation', () => {
  const cursor = 'mxds1.payload.signature'
  const common = { platform: 'twitter', postId: fixtures.twitter }
  const first = normalizePostCommentsRequest({ ...common, cursor })
  const second = normalizePostCommentsRequest({ ...common, params: { cursor } })
  assert.equal(first.cursor, second.cursor)
  assert.deepEqual(first.fingerprintBody, second.fingerprintBody)
  assert.deepEqual(first.initialParams, {})
  assert.throws(() => normalizePostCommentsRequest({ ...common, cursor, params: { cursor: 'raw-token' } }), { code: 'invalid_post_comments_request' })
  assert.throws(() => normalizePostCommentsRequest({ ...common, cursor: 'mxnc1.old.signature' }), { code: 'invalid_cursor' })
  for (const cursor of ['mxnc1.old.signature', 'mxec2.foreign.signature', 'mxds2.foreign.signature']) {
    assert.throws(() => normalizePostCommentsRequest({ ...common, params: { cursor } }), { code: 'invalid_cursor' })
    assert.throws(() => normalizePostCommentsRequest({ platform: 'instagram', postId: fixtures.instagram, params: { min_id: cursor } }), { code: 'invalid_cursor' })
  }
  assert.throws(() => normalizePostCommentsRequest({ platform: 'instagram', postId: fixtures.instagram,
    params: { min_id: 'mxds1.unsigned' } }), { code: 'invalid_cursor' })
})

test('explicit IDs accept platform share URLs without resolving them or admitting a foreign host', () => {
  for (const [platform, url] of [['weibo', 'https://weibo.com/123456/Mabc123'],
    ['bilibili', 'https://b23.tv/example'], ['douyin', 'https://v.douyin.com/example/'],
    ['xiaohongshu', 'https://xhslink.com/example']]) {
    const expected = normalizePostCommentsRequest({ platform, postId: fixtures[platform] })
    assert.deepEqual(normalizePostCommentsRequest({ platform, postId: fixtures[platform], url }).fingerprintBody, expected.fingerprintBody)
    assert.throws(() => normalizePostCommentsRequest({ platform, url }), { code: 'invalid_post_comments_request' })
    assert.throws(() => normalizePostCommentsRequest({ platform, postId: fixtures[platform], url: 'https://attacker.invalid/example' }), { code: 'invalid_post_comments_request' })
  }
})

test('Instagram numeric media IDs normalize losslessly to the same shortcode as a canonical URL', () => {
  const code = 'C-9VcYrWAAB', id = '3440000000000000001'
  const expected = normalizePostCommentsRequest({ platform: 'instagram', postId: code }).fingerprintBody
  for (const postId of [id, `${id}_123456789`]) {
    const request = normalizePostCommentsRequest({ platform: 'instagram', postId, url: `https://www.instagram.com/p/${code}/` })
    assert.deepEqual(request.fingerprintBody, expected)
    assert.equal(buildPostCommentsDispatch(request).upstreamQuery.code, code)
  }
  assert.throws(() => normalizePostCommentsRequest({ platform: 'instagram', postId: id,
    url: 'https://www.instagram.com/p/otherPost/' }), { code: 'invalid_post_comments_request' })
  for (const postId of ['18446744073709551616', Number(id)]) {
    assert.throws(() => normalizePostCommentsRequest({ platform: 'instagram', postId }), { code: 'invalid_post_comments_request' })
  }
})

test('LinkedIn activity URNs and canonical URLs have one identity without conflating other URN namespaces', () => {
  const postId = fixtures.linkedin
  const request = normalizePostCommentsRequest({ platform: 'linkedin', postId, postUrn: `urn:li:activity:${postId}`,
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${postId}/` })
  assert.equal(buildPostCommentsDispatch(request).upstreamQuery.postId, postId)
  assert.equal(buildPostCommentsDispatch(request).upstreamQuery.sortOrder, 'RELEVANCE')
  for (const namespace of ['share', 'ugcPost']) {
    assert.throws(() => normalizePostCommentsRequest({ platform: 'linkedin', postUrn: `urn:li:${namespace}:${postId}` }), { code: 'invalid_post_comments_request' })
  }
})

test('supplier selection, credential injection, reply expansion and business identity spoofing are rejected', () => {
  const common = { platform: 'twitter', postId: fixtures.twitter }
  for (const body of [{ ...common, provider: 'tikhub' }, { ...common, commentId: 'reply' },
    { ...common, params: { token: 'credential' } }, { ...common, params: { endpoint: '/custom' } },
    { ...common, businessId: 'wrong' }]) assert.throws(() => normalizePostCommentsRequest(body, { businessId: 'right' }), { code: 'invalid_post_comments_request' })
})

test('canonical URLs use platform hosts without automatic short-link or arbitrary-url requests', () => {
  const urls = { reddit: 'https://www.reddit.com/r/test/comments/1q4aqti/title/', instagram: 'https://www.instagram.com/p/fixtureCode/',
    bilibili: 'https://www.bilibili.com/video/av751305050/', youtube: 'https://youtu.be/dQw4w9WgXcQ',
    linkedin: 'https://www.linkedin.com/feed/update/urn:li:activity:7267273010393358336/',
    xiaohongshu: 'https://www.xiaohongshu.com/explore/675d277d000000000600e655' }
  for (const [platform, url] of Object.entries(urls)) {
    assert.equal(normalizePostCommentsRequest({ platform, url }).postId,
      normalizePostCommentsRequest({ platform, postId: fixtures[platform] }).postId)
  }
  for (const url of ['https://attacker.invalid/account/status/123', 'https://x.com@attacker.invalid/account/status/123',
    'http://127.0.0.1/status/123', 'https://t.co/short']) {
    assert.throws(() => normalizePostCommentsRequest({ platform: 'twitter', url }), { code: 'invalid_post_comments_request' })
  }
})
