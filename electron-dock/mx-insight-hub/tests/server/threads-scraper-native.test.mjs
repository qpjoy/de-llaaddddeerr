import test from 'node:test'
import assert from 'node:assert/strict'
import sample from '../fixtures/threads-scraper-search.json' with { type: 'json' }
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { parseThreadsScraperSearchPage } from '../../server/contracts/threads.mjs'

const key = 'r.threads_scraper_search_posts'
const capturedAt = '2026-11-13T00:00:00.000Z'
const cursor = 'opaque +/%='
const edge = post => ({ node: { thread: { thread_items: [{ post }] } } })
const page = (results, cursor) => ({ status: 'ok', data: { results, cursor } })
const parse = (body, currentCursor) => parseThreadsScraperSearchPage(body, { capturedAt, currentCursor })

test('Threads Scraper has its own native route, host, operation and marketplace', async () => {
  const params = { query: '张婧怡', cursor }
  const native = normalizeNativeForwardingRequest(key, { params })
  assert.equal(native.marketplace, 'threads-scraper')
  assert.equal(native.operation, 'native.r.threads_scraper_search_posts')
  const seen = []
  const body = page([], null)
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-scraper-key', fetchImpl: async (url, options) => {
    seen.push({ url, options })
    return Response.json(body)
  } })
  for (const invalid of [{}, { query: ' ' }, { query: 'q', end_cursor: cursor }, { query: 'q', cursor: ' ' }]) {
    await assert.rejects(adapter.forwardNative(key, { params: invalid }), { status: 400 })
  }
  assert.equal(seen.length, 0)
  const result = await adapter.forwardNative(key, { params })
  assert.equal(seen.length, 1)
  const { url, options } = seen[0]
  assert.equal(options.method, 'GET')
  assert.equal(url.origin + url.pathname, 'https://threads-scraper.p.rapidapi.com/api/v1/posts/search')
  assert.equal(options.headers['x-rapidapi-host'], url.host)
  assert.deepEqual(Object.fromEntries(url.searchParams), params)
  assert.deepEqual(result.publicBody.data, body)
})

test('Threads Scraper preserves search order, first matches and unknown counts', () => {
  const { rows, providerPage } = parse(sample)
  assert.deepEqual(rows.map(row => row.content_id), ['30', '20'])
  assert.equal(rows[0].text, 'first result')
  assert.equal(rows[0].like_count, 0)
  assert.equal(rows[0].comment_count, null)
  assert.equal(rows[0].published_at, null)
  assert.equal(rows[0].url, 'https://www.threads.com/@sample/post/A')
  assert.equal(rows[1].author_id, null)
  assert.equal(rows[1].like_count, null)
  assert.deepEqual(rows.map(row => JSON.parse(row.metadata).isReply), [null, false])
  assert.deepEqual(providerPage, { hasMore: true, nextParams: { cursor }, nextPage: null })
})

test('a legacy error, missing collection or malformed source edge cannot look like an empty search', () => {
  for (const body of [null, { status: 'error', data: { results: [] } }, { data: { results: [] } },
    { status: 'ok', errors: ['source unavailable'], data: { results: [] } }, { status: 'ok', data: null },
    { status: 'ok', data: { posts: [] } }, { status: 'ok', data: { results: {} } },
    ...[null, { node: {} }, { node: { thread: { thread_items: [] } } }, edge({}), edge({ pk: 2 ** 53 })].map(bad => page([edge({ pk: '42' }), bad], null))]) {
    assert.throws(() => parse(body), /invalid_threads_response/)
  }
})

test('only null cursor or an empty page proves exhaustion; repeated and malformed cursors cannot advance', () => {
  const entries = [edge({ pk: '10' })]
  const finished = { hasMore: false, nextParams: null, nextPage: null }
  assert.deepEqual(parse(page([], cursor)).providerPage, finished)
  assert.deepEqual(parse(page(entries, null)).providerPage, finished)
  for (const invalid of [undefined, false, 1, {}, '', ' ', '\0', 'x'.repeat(8193)]) {
    assert.deepEqual(parse(page(entries, invalid)).providerPage, { hasMore: null, nextParams: null, nextPage: null })
  }
  assert.deepEqual(parse(page(entries, cursor), cursor).providerPage,
    { hasMore: null, nextParams: null, nextPage: null, stopReason: 'repeated_cursor' })
})
