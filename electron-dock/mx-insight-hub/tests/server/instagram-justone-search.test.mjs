import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JustOneAdapter, JustOneRejectedError } from '../../server/adapters/justone.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { JUSTONE_INSTAGRAM_SEARCH_KEY, projectJustOneInstagramSearch } from '../../server/contracts/instagram-justone-search.mjs'
import { projectInstagramSearch } from '../../server/contracts/instagram-search.mjs'
import { normalizeHubDataSearch, projectDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

// Anonymous subset of the official non-synthetic public example, checkedAt
// 2026-10-15T00:00:09. No customer response, token or author data is retained.
// https://api.justoneapi.com/status/api-example/detail?api=%2Fapi%2Finstagram%2Fgeneral-search%2Fv1
const fixture = JSON.parse(readFileSync(new URL('../fixtures/justone/instagram-general-search-v1.success.json', import.meta.url), 'utf8'))
const capturedAt = '2026-10-15T01:00:00.000Z'
const callId = '11111111-2222-4333-8444-555555555555'
const request = overrides => ({ query: '#主题 & fixture', page: 1, pageSize: 20, providerCursor: null,
  archiveCallId: callId, encodeNext: value => JSON.stringify(value), ...overrides })
const nativeResult = data => ({ publicBody: { data, meta: { capturedAt, projection: 'native' } }, items: [], records: [] })
const project = (data = fixture.data, overrides) => projectJustOneInstagramSearch(nativeResult(data), request(overrides))

test('JustOne Instagram native GET uses the fixed official endpoint and only keyword/paginationToken', async () => {
  const endpoint = nativeForwardingEndpoint(JUSTONE_INSTAGRAM_SEARCH_KEY)
  assert.equal(endpoint.provider, 'justone')
  assert.equal(endpoint.path, '/api/instagram/general-search/v1')
  assert.equal(endpoint.operation, `native.${JUSTONE_INSTAGRAM_SEARCH_KEY}`)
  assert.deepEqual(endpoint.parameters.map(({ name, required, type }) => ({ name, required, type })), [
    { name: 'keyword', required: true, type: 'string' },
    { name: 'paginationToken', required: false, type: 'string' },
  ])
  for (const paginationToken of [undefined, fixture.data.pagination_token]) {
    const params = { keyword: '#fashion/中文 &+ 空格', ...(paginationToken ? { paginationToken } : {}) }
    const normalized = normalizeNativeForwardingRequest(JUSTONE_INSTAGRAM_SEARCH_KEY, { params })
    let calls = 0
    const wire = ` ${JSON.stringify(fixture)}\n`
    const adapter = new JustOneAdapter({ token: 'synthetic-justone-secret', fetchImpl: async (url, options) => {
      calls++
      const parsed = new URL(url)
      assert.equal(parsed.origin, 'https://api.justoneapi.com')
      assert.equal(parsed.pathname, '/api/instagram/general-search/v1')
      assert.equal(parsed.hash, '')
      assert.deepEqual(Object.fromEntries(parsed.searchParams), {
        token: 'synthetic-justone-secret', keyword: params.keyword, paginationToken: paginationToken ?? '',
      })
      assert.equal(options.method, 'GET')
      assert.equal(options.body, undefined)
      return new Response(wire, { headers: { 'content-type': 'application/json' } })
    } })
    const result = await adapter.forwardNative(JUSTONE_INSTAGRAM_SEARCH_KEY, { params }, { capturedAt })
    const projected = projectJustOneInstagramSearch(result, request())
    assert.equal(calls, 1, 'neither native forwarding nor projection follows a provider cursor')
    assert.equal(normalized.upstreamQuery.keyword, params.keyword)
    assert.equal(projected.restrictedResponseArchive, result.restrictedResponseArchive)
    assert.equal(projected.restrictedResponseArchive.bodyText, wire)
    assert.equal(projected.restrictedResponseArchive.bodySha256, createHash('sha256').update(wire).digest('hex'))
    assert.equal(Object.prototype.propertyIsEnumerable.call(projected, 'restrictedResponseArchive'), false)
    assert.equal(projected.archiveObjects, result.archiveObjects)
    assert.deepEqual(result.publicBody.data, fixture.data)
  }
})

test('JustOne observed data.data.items and pagination_token project to the existing Instagram raw contract', () => {
  const original = structuredClone(fixture.data)
  const result = project(original)
  assert.deepEqual(original, fixture.data)
  assert.equal(result.publicBody.contractVersion, 'mx-insight-hub.raw-search.v1')
  assert.equal(result.publicBody.data.platform, 'instagram')
  assert.equal(result.publicBody.data.raw_info, '[]')
  assert.deepEqual(JSON.parse(result.publicBody.data.raw_data), result.items)
  assert.deepEqual(result.items, result.acquiredItems)
  assert.equal(result.items[0].content_id, '9007199254740993001')
  assert.equal(result.items[0].author_id, '9007199254740993002')
  assert.equal(result.items[0].text, '匿名示例 #主题\n第二行😀')
  assert.equal(result.items[0].url, 'https://www.instagram.com/p/fixtureShortcode/')
  assert.equal(result.items[0].author_name, 'fixture_author')
  assert.equal(result.items[0].author_avatar_url, 'https://example.invalid/avatar.jpg')
  assert.equal(result.items[0].cover_url, 'https://example.invalid/image.jpg')
  assert.deepEqual(JSON.parse(result.items[0].image_urls), ['https://example.invalid/image.jpg'])
  assert.deepEqual(JSON.parse(result.items[0].video_urls), ['https://example.invalid/video.mp4'])
  assert.equal(result.items[0].like_count, 7)
  assert.equal(result.items[0].comment_count, 2)
  assert.equal(result.items[0].view_count, 21)
  assert.equal(result.items[0].collected_at, capturedAt)
  assert.deepEqual(JSON.parse(result.publicBody.data.page.nextCursor), { page: 2, providerCursor: fixture.data.pagination_token })
  assert.equal(result.publicBody.data.meta.upstreamCallCount, 1)
})

test('JustOne Instagram thumbnail fallback retains the existing row contract', () => {
  const data = structuredClone(fixture.data)
  data.data.items[0].image_versions.items = []
  const result = project(data)
  assert.equal(result.items[0].cover_url, 'https://example.invalid/thumbnail.jpg')
  assert.deepEqual(JSON.parse(result.items[0].image_urls), ['https://example.invalid/thumbnail.jpg'])
})

test('Instagram standard search reports JustOne cursor pagination while preserving TikHub compound pagination', () => {
  const codec = createDataSearchCursorCodec('instagram-pagination-offline-secret', 'consumer:key')
  const body = { platform: 'instagram', query: 'fixture', pageSize: 20 }
  for (const instagramProvider of [undefined, 'tikhub', 'justone']) {
    const normalized = normalizeHubDataSearch(body, codec, 'fresh', undefined,
      instagramProvider ? { instagramProvider } : {})
    const justone = instagramProvider === 'justone'
    const result = justone ? projectJustOneInstagramSearch(nativeResult(fixture.data), normalized)
      : projectInstagramSearch(nativeResult({ items: fixture.data.data.items,
        next_max_id: 'fixture-next-max-id', rank_token: 'fixture-rank-token', more_available: true }), normalized)
    const standard = projectDataSearch(result, normalized).data
    assert.equal(standard.meta.paginationMode, justone ? 'cursor' : 'compound')
    assert.equal(standard.pageInfo.cursorType, 'opaque')
    assert.equal(standard.pageInfo.hasMore, true)
    assert.equal(standard.meta.providerCalls, 1)
    const continuation = codec.decode(standard.pageInfo.nextCursor)
    assert.deepEqual(continuation.providerCursor, justone ? fixture.data.pagination_token
      : { next_max_id: 'fixture-next-max-id', rank_token: 'fixture-rank-token' })
    assert.equal(continuation.provider, justone ? 'justone' : undefined)
  }
})

test('an explicit empty or null provider token ends a valid empty or nonempty page', () => {
  // These are boundary fixtures, not evidence of a live observed terminal page.
  for (const [items, pagination_token] of [[], fixture.data.data.items].flatMap(items => ['', null].map(token => [items, token]))) {
    const result = project({ data: { count: items.length, items }, pagination_token })
    assert.equal(result.publicBody.data.page.hasMore, false)
    assert.equal(result.publicBody.data.page.nextCursor, null)
    assert.equal(result.publicBody.data.status, 'ok')
  }
})

test('JustOne Instagram unknown success bodies and malformed identities fail closed', () => {
  for (const data of [null, 'string', [], {}, { items: [] }, { data: { items: [] }, pagination_token: '' },
    { data: { count: '1', items: [] }, pagination_token: '' },
    { data: { count: 1, items: {} }, pagination_token: '' },
    { data: { count: 1, items: [null] }, pagination_token: '' },
    { data: { count: 1, items: [{ id: 9007199254740992, code: 'x' }] }, pagination_token: '' },
    { data: { count: 1, items: [{ ...fixture.data.data.items[0], image_versions: [] }] }, pagination_token: '' }]) {
    assert.throws(() => project(data), /invalid_instagram_(search_shape|post_identity)/)
  }
})

test('JustOne Instagram rejects unknown continuation types and repeated provider tokens', () => {
  for (const pagination_token of [undefined, 123, true, {}, [], ' ', '\u0000', 'x'.repeat(2049)]) {
    assert.throws(() => project({ ...fixture.data, pagination_token }), /invalid_instagram_continuation/)
  }
  assert.throws(() => project({ data: fixture.data.data }), /invalid_instagram_continuation/)
  assert.throws(() => project(fixture.data, { providerCursor: fixture.data.pagination_token }), /invalid_instagram_continuation/)
})

test('oversized JustOne pages deliver the full paid receipt through hash-bound buffers before advancing the opaque token', () => {
  const items = Array.from({ length: 45 }, (_, index) => ({ ...fixture.data.data.items[0], id: String(9000 + index), code: `fixture${index}` }))
  const data = { data: { count: items.length, items }, pagination_token: fixture.data.pagination_token }
  const first = project(data)
  const secondState = JSON.parse(first.publicBody.data.page.nextCursor)
  assert.equal(first.items.length, 20)
  assert.equal(first.acquiredItems.length, 45)
  assert.deepEqual(secondState, { page: 2, buffer: { callId, offset: 20,
    hash: createHash('sha256').update(JSON.stringify(first.acquiredItems)).digest('hex') }, providerCursor: null })
  const second = project(data, secondState)
  const thirdState = JSON.parse(second.publicBody.data.page.nextCursor)
  const third = project(data, thirdState)
  assert.equal(second.items.length, 20)
  assert.equal(third.items.length, 5)
  assert.equal(second.publicBody.data.meta.upstreamCallCount, 0)
  assert.equal(third.publicBody.data.meta.upstreamCallCount, 0)
  assert.equal(third.acquiredItems.length, 45)
  assert.deepEqual([...first.items, ...second.items, ...third.items], first.acquiredItems)
  assert.deepEqual(JSON.parse(third.publicBody.data.page.nextCursor), { page: 4, providerCursor: fixture.data.pagination_token })
  assert.throws(() => project(data, { archiveCallId: undefined }), /instagram_page_archive_required/)
  for (const buffer of [{ ...secondState.buffer, hash: '0'.repeat(64) },
    { ...secondState.buffer, offset: 21 }, { ...secondState.buffer, offset: 60 }, { ...secondState.buffer, offset: 0 }]) {
    assert.throws(() => project(data, { page: 2, buffer }), /instagram_buffer_mismatch/)
  }
  const changed = structuredClone(data)
  changed.data.items[0].caption.text = 'changed receipt'
  assert.throws(() => project(changed, secondState), /instagram_buffer_mismatch/)
})

test('JustOne Instagram keeps the 15-page traversal limit and reports unserved remainder', () => {
  const result = project(fixture.data, { page: 15 })
  assert.equal(result.publicBody.data.page.hasMore, false)
  assert.equal(result.publicBody.data.page.nextCursor, null)
  assert.equal(result.publicBody.data.status, 'partial')
  assert.equal(result.publicBody.data.warnings[0].code, 'INSTAGRAM_PAGE_LIMIT_REACHED')
  assert.equal(result.acquiredItems.length, 1)
})

test('JustOne Instagram native business rejection preserves the receipt and does not retry or project', async () => {
  let calls = 0
  const wire = ' {"code":400,"message":"Invalid parameters","data":null,"recordTime":null,"requestId":"fixture-rejection"}\n'
  const adapter = new JustOneAdapter({ token: 'synthetic-justone-secret', fetchImpl: async () => {
    calls++
    return new Response(wire, { status: 400, headers: { 'content-type': 'application/json' } })
  } })
  await assert.rejects(() => adapter.forwardNative(JUSTONE_INSTAGRAM_SEARCH_KEY, { params: { keyword: 'fixture' } }), error => {
    assert.ok(error instanceof JustOneRejectedError)
    assert.equal(error.evidence.outcome, 'rejected')
    assert.equal(error.evidence.businessCode, 400)
    assert.equal(error.evidence.billed, false)
    assert.equal(error.evidence.retryable, false)
    assert.equal(error.restrictedResponseArchive.bodyText, wire)
    return true
  })
  assert.equal(calls, 1)
})
