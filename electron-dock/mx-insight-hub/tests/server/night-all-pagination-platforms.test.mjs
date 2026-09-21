import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  capNightAllCompatibilityTraversal,
  prepareNightAllCompatibilityTraversal,
} from '../../server/data/night-all-pagination.mjs'
import { createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'

// Synthetic Night-All normalized page fixtures, based on its curated endpoint
// contracts. These verify the Hub boundary, not live supplier availability.
const cases = [
  ['douyin', 'video search v1', {
    paginationMode: 'compound', nextCursor: '8',
    nextParams: { search_id: 'dy-search', backtrace: 'dy-backtrace' },
  }, { cursor: '8', params: { search_id: 'dy-search', backtrace: 'dy-backtrace' } }],
  ['douyin', 'general search v2', {
    paginationMode: 'compound', nextCursor: '10',
    nextParams: { search_id: 'dy-general', backtrace: 'dy-general-backtrace' },
  }, { cursor: '10', params: { search_id: 'dy-general', backtrace: 'dy-general-backtrace' } }],
  ['tiktok', 'web general search', {
    paginationMode: 'composite', nextCursor: 'tt-search', nextPage: 2,
    nextParams: { offset: 10, search_id: 'tt-search' },
  }, { page: 2, params: { offset: 10, search_id: 'tt-search' } }],
  ['zhihu', 'web article search v3', {
    paginationMode: 'composite', nextCursor: 'zh-search', nextPage: 2,
    nextParams: { offset: 10, search_hash_id: 'zh-search' },
  }, { page: 2, params: { offset: 10, search_hash_id: 'zh-search' } }],
  ['instagram', 'general search v3', {
    paginationMode: 'compound', nextCursor: 'ig-max',
    nextParams: { next_max_id: 'ig-max', rank_token: 'ig-rank' },
  }, { cursor: 'ig-max', params: { next_max_id: 'ig-max', rank_token: 'ig-rank' } }],
  ['xiaohongshu', 'app v2 search', {
    paginationMode: 'composite', nextCursor: 'xhs-search', nextPage: 2,
    nextParams: { search_id: 'xhs-search' },
  }, { page: 2, params: { search_id: 'xhs-search' } }],
  ['weibo', 'web v2 realtime search', {
    paginationMode: 'page', nextPage: 2,
  }, { page: 2 }],
  ['bilibili', 'web general search', {
    paginationMode: 'page', nextPage: 2,
  }, { page: 2 }],
  ['wechat_search', 'search v2', {
    paginationMode: 'offset', nextPage: 2, nextParams: { offset: 20 },
  }, { page: 2, params: { offset: 20 } }],
  ['reddit', 'app dynamic search', {
    paginationMode: 'cursor', nextCursor: 'reddit-after', nextParams: { cursor: 'reddit-after' },
  }, { cursor: 'reddit-after' }],
  ['youtube', 'web general search v2', {
    paginationMode: 'cursor', nextCursor: 'yt-continuation',
    nextParams: { continuation_token: 'yt-continuation' },
  }, { cursor: 'yt-continuation' }],
  ['kuaishou', 'app comprehensive search', {
    paginationMode: 'cursor', nextCursor: 'ks-pcursor', nextParams: { pcursor: 'ks-pcursor' },
  }, { cursor: 'ks-pcursor' }],
  ['twitter', 'TikHub web search timeline', {
    paginationMode: 'cursor', nextCursor: 'twitter-next', nextParams: { cursor: 'twitter-next' },
  }, { cursor: 'twitter-next' }],
]

for (const [platform, endpoint, page, expected] of cases) {
  test(`${platform} ${endpoint}: the same downstream cursor flow restores its own upstream state`, () => {
    const options = {
      operation: 'raw', platform,
      codec: createNightAllCompatibilityCursorCodec('pagination-matrix-test-secret-with-entropy', 'consumer'),
    }
    const request = { platform, query: 'example', count: 20 }
    const first = prepareNightAllCompatibilityTraversal({ ...options, upstreamBody: request })
    const payload = { data: { page: { hasMore: true, ...page }, raw_info: '[]', raw_data: '[]' } }
    const wrapped = capNightAllCompatibilityTraversal(payload, {
      ...options, page: first.page, scope: first.scope, upstreamBody: first.upstreamBody,
    })
    const cursor = wrapped.data.page.nextCursor
    assert.ok(cursor?.startsWith('mxnc1.'), 'every continuation has the same public cursor entry point')
    assert.equal(wrapped.data.page.nextPage, null)
    const next = prepareNightAllCompatibilityTraversal({
      ...options, upstreamBody: { ...request, cursor },
    })
    assert.equal(next.page, 2)
    assert.deepEqual(next.upstreamBody, { ...request, ...expected })
    if (wrapped.data.page.nextParams) {
      assert.deepEqual(prepareNightAllCompatibilityTraversal({
        ...options, upstreamBody: { ...request, params: wrapped.data.page.nextParams },
      }), next, 'legacy callers keep the same continuation')
    }
  })
}
