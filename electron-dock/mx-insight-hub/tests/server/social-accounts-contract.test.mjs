import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SOCIAL_ACCOUNT_PLATFORMS,
  normalizeSocialAccountSearchRequest,
  normalizeSocialAccountSearchResponse,
  socialAccountEndpointKeys,
  socialAccountPlatform,
} from '../../server/contracts/social-accounts.mjs'

const DELIVERY_MODES = ['cache_only', 'cache_first', 'refresh', 'live_only']

function douyinEntry(overrides = {}) {
  return {
    data: {
      raw_data: JSON.stringify({
        user_info: {
          uid: '75186287359',
          sec_uid: 'MS4wLjABAAAACTS2',
          nickname: '示例账号',
          unique_id: 'example_id',
          follower_count: 18557,
          signature: '简介',
          is_verified: false,
          avatar_larger: { url_list: ['https://example.invalid/a.jpeg'] },
        },
        follower_info: { follower_count: 18557 },
        ...overrides,
      }),
    },
  }
}

test('each platform sends the parameter names its own endpoint requires', () => {
  assert.deepEqual(
    normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword: '示例' }).upstreamQuery,
    { keyword: '示例', page: '1' },
  )
  // Weibo is the one platform whose keyword parameter is not called keyword.
  assert.deepEqual(
    normalizeSocialAccountSearchRequest({ platform: 'weibo', keyword: '示例', page: 3 }).upstreamQuery,
    { query: '示例', page: '3' },
  )
  // Kuaishou pages by `page` but rejects a request without `cursor`.
  assert.deepEqual(
    normalizeSocialAccountSearchRequest({ platform: 'kuaishou', keyword: '示例' }).upstreamQuery,
    { keyword: '示例', cursor: '0', page: '1' },
  )
})

test('the request surface is closed and each platform binds its own provider', () => {
  assert.throws(
    () => normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword: 'x', token: 'leak' }),
    (error) => error.code === 'unsupported_request_field',
  )
  assert.throws(
    () => normalizeSocialAccountSearchRequest({ platform: 'bilibili', keyword: 'x' }),
    (error) => error.code === 'unsupported_platform',
  )
  assert.throws(
    () => normalizeSocialAccountSearchRequest({ platform: 'weibo', keyword: '   ' }),
    (error) => error.code === 'invalid_keyword',
  )
  assert.throws(
    () => normalizeSocialAccountSearchRequest({ platform: 'weibo', keyword: 'x', page: 0 }),
    (error) => error.code === 'invalid_page',
  )
  assert.equal(socialAccountPlatform('xiaohongshu').providerKey, 'justone')
  assert.equal(socialAccountPlatform('kuaishou').providerKey, 'tikhub')
  assert.deepEqual(socialAccountEndpointKeys('justone'), [
    'xiaohongshu.account-search.v1', 'douyin.account-search.v1',
  ])
  assert.deepEqual(socialAccountEndpointKeys('tikhub'), [
    'weibo.account-search.v1', 'kuaishou.account-search.v1',
  ])
})

test('delivery mode is validated but stays out of the request identity', () => {
  const a = normalizeSocialAccountSearchRequest(
    { platform: 'weibo', keyword: 'x', deliveryMode: 'live_only' }, { deliveryModes: DELIVERY_MODES },
  )
  const b = normalizeSocialAccountSearchRequest(
    { platform: 'weibo', keyword: 'x', deliveryMode: 'cache_only' }, { deliveryModes: DELIVERY_MODES },
  )
  assert.notEqual(a.deliveryMode, b.deliveryMode)
  assert.deepEqual(a.fingerprintBody, b.fingerprintBody)
  assert.throws(
    () => normalizeSocialAccountSearchRequest(
      { platform: 'weibo', keyword: 'x', deliveryMode: 'live' }, { deliveryModes: DELIVERY_MODES },
    ),
    (error) => error.code === 'invalid_delivery_mode',
  )
})

test('the two providers signal success with different codes and neither is read as the other', () => {
  const justone = normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword: 'x' })
  const tikhub = normalizeSocialAccountSearchRequest({ platform: 'weibo', keyword: 'x' })

  // JustOne: 0 succeeds, 200 does not.
  assert.equal(
    normalizeSocialAccountSearchResponse({ code: 0, data: { users: [] } }, justone).accounts.length, 0,
  )
  assert.throws(
    () => normalizeSocialAccountSearchResponse({ code: 200, data: { users: [] } }, justone),
    (error) => error.code === 'invalid_upstream_envelope',
  )

  // TikHub: 200 succeeds, 0 does not.
  assert.equal(
    normalizeSocialAccountSearchResponse({ code: 200, data: { parsed_data: { users: [] } } }, tikhub).accounts.length, 0,
  )
  assert.throws(
    () => normalizeSocialAccountSearchResponse({ code: 0, data: { parsed_data: { users: [] } } }, tikhub),
    (error) => error.code === 'invalid_upstream_envelope',
  )
})

test("Douyin's nested JSON string is parsed, and an unusable entry is dropped not fatal", () => {
  const request = normalizeSocialAccountSearchRequest({ platform: 'douyin', keyword: 'x' })
  const response = normalizeSocialAccountSearchResponse({
    code: 0,
    data: {
      business_data: [
        douyinEntry(),
        { data: { raw_data: 'not json at all' } },
        { data: { raw_data: JSON.stringify({ user_info: { nickname: '无 uid' } }) } },
        { data: {} },
      ],
    },
  }, request)

  assert.equal(response.accounts.length, 1)
  assert.equal(response.accounts[0].userId, '75186287359')
  assert.equal(response.accounts[0].secUid, 'MS4wLjABAAAACTS2')
  assert.equal(response.publicBody.data.page.discardedCount, 3)
})

test('verification and secondary-id fields are read under either observed name', () => {
  const douyin = normalizeSocialAccountSearchRequest({ platform: 'douyin', keyword: 'x' })
  const viaVerified = normalizeSocialAccountSearchResponse({
    code: 0,
    data: {
      business_data: [{
        data: {
          raw_data: JSON.stringify({
            user_info: { uid: '1', nickname: 'n', verified: true, is_verified: undefined },
          }),
        },
      }],
    },
  }, douyin)
  assert.equal(viaVerified.accounts[0].official, true)

  const kuaishou = normalizeSocialAccountSearchRequest({ platform: 'kuaishou', keyword: 'x' })
  const viaEid = normalizeSocialAccountSearchResponse({
    code: 200,
    data: { mixFeeds: [{ user: { user_id: '9', user_name: 'n', eid: 'EID-ONLY' } }] },
  }, kuaishou)
  assert.equal(viaEid.accounts[0].secUid, 'EID-ONLY')
})

test('a formatted follower count is reported as unknown rather than coerced to a number', () => {
  const request = normalizeSocialAccountSearchRequest({ platform: 'kuaishou', keyword: 'x' })
  const response = normalizeSocialAccountSearchResponse({
    code: 200,
    data: { mixFeeds: [{ user: { user_id: '1', user_name: 'n', fansCount: '1.2万' } }] },
  }, request)
  assert.equal(response.accounts[0].fans, null)
})

test('Xiaohongshu falls back to the rendered follower string only when it is exact', () => {
  const request = normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword: 'x' })
  const response = normalizeSocialAccountSearchResponse({
    code: 0,
    data: {
      users: [
        { id: 'a', name: 'n', sub_title: '粉丝 1164' },
        { id: 'b', name: 'n', sub_title: '粉丝 1.2万' },
        { id: 'c', name: 'n', fans: 7, sub_title: '粉丝 999' },
      ],
    },
  }, request)

  assert.equal(response.accounts[0].fans, 1164)
  // "1.2万" is a rendered figure; reconstructing it would invent precision.
  assert.equal(response.accounts[1].fans, null)
  // An exact count always wins over the rendered string.
  assert.equal(response.accounts[2].fans, 7)
})

test("Kuaishou's mixed feed repeats accounts, so identity de-duplication is applied", () => {
  const request = normalizeSocialAccountSearchRequest({ platform: 'kuaishou', keyword: 'x' })
  const response = normalizeSocialAccountSearchResponse({
    code: 200,
    data: {
      mixFeeds: [
        { user: { user_id: '1', user_name: '第一条内容' } },
        { user: { user_id: '1', user_name: '同一账号的另一条内容' } },
        { user: { user_id: '2', user_name: '另一个账号' } },
      ],
    },
  }, request)

  assert.deepEqual(response.accounts.map((account) => account.userId), ['1', '2'])
  assert.equal(response.publicBody.data.page.duplicateCount, 1)
})

test('an empty page is the end of results; a full page proves nothing', () => {
  for (const platform of SOCIAL_ACCOUNT_PLATFORMS) {
    const request = normalizeSocialAccountSearchRequest({ platform, keyword: 'x' })
    const descriptor = socialAccountPlatform(platform)
    const payload = {
      code: descriptor.envelope === 'tikhub' ? 200 : 0,
      ...emptyCollectionAt(descriptor.itemsPath),
    }

    const response = normalizeSocialAccountSearchResponse(payload, request)
    assert.equal(response.publicBody.data.page.hasMore, false, `${platform} empty page ends paging`)
    assert.equal(response.publicBody.data.page.nextPage, null)
  }
})

test('a non-empty page leaves continuation unstated rather than assuming another page', () => {
  const request = normalizeSocialAccountSearchRequest({ platform: 'xiaohongshu', keyword: 'x' })
  const response = normalizeSocialAccountSearchResponse(
    { code: 0, data: { users: [{ id: 'a', name: 'n' }] } }, request,
  )
  assert.equal(response.publicBody.data.page.hasMore, null)
  assert.equal(response.publicBody.data.page.nextPage, 2)
})

// Build `{ data: { users: [] } }` for an item path of ['data', 'users'].
function emptyCollectionAt(path) {
  const root = {}
  let node = root
  path.forEach((segment, index) => {
    if (index === path.length - 1) node[segment] = []
    else {
      node[segment] = {}
      node = node[segment]
    }
  })
  return root
}
