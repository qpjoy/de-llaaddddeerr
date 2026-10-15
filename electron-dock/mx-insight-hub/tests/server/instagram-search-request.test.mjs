import assert from 'node:assert/strict'
import test from 'node:test'
import { canRouteRawSearch, normalizeRawSearch, JUSTONE_INSTAGRAM_SEARCH_KEY } from '../../server/contracts/raw-search.mjs'
import { canRouteDataSearch, normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { createRawSearchCursorCodec, createDataSearchCursorCodec, createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { prepareNightAllCompatibilityTraversal, capNightAllCompatibilityTraversal, capNightAllDataSearchTraversal } from '../../server/data/night-all-pagination.mjs'

const secret = 'instagram-justone-contract-offline-secret'
const rawCodec = createRawSearchCursorCodec(secret, 'consumer:key')
const dataCodec = createDataSearchCursorCodec(secret, 'consumer:key')
const historicalCodec = createNightAllCompatibilityCursorCodec(secret, 'consumer')
const options = { instagramProvider: 'justone', historicalCodec }
const rawInput = (body = {}, pageSize = 20) => ({ platform: 'instagram', pageSize,
  upstreamBody: { platform: 'instagram', keyword: ' 原查询 #词 ', count: pageSize, ...body } })
const buffer = { callId: '11111111-2222-4333-8444-555555555555', offset: 20, hash: 'a'.repeat(64) }

test('Instagram routing stays in Hub even for shapes that cannot dispatch', () => {
  for (const body of [{}, { cursor: 'mxnc1.historical' }, { params: { unsupported: 'value' } },
    { includeDetails: true }, { page: 2 }, { queries: ['one', 'two'] }]) {
    assert.equal(canRouteRawSearch(rawInput(body, 1)), true)
  }
  for (const cursor of [undefined, 'mxnc1.historical', 'mxds1.saved', 'provider-token']) {
    assert.equal(canRouteDataSearch({ platform: 'instagram', pageSize: 1, cursor }), true)
  }
})

test('JustOne first-page raw/data contracts preserve caller identity and use only native keyword/token parameters', () => {
  for (const pageSize of [1, 20, 100]) {
    for (const queryField of ['keyword', 'query']) {
      const input = rawInput({}, pageSize)
      delete input.upstreamBody.keyword
      input.upstreamBody[queryField] = ' 原查询 #词 '
      const before = structuredClone(input)
      const normalized = normalizeRawSearch(input, rawCodec, options)
      assert.equal(normalized.key, JUSTONE_INSTAGRAM_SEARCH_KEY)
      assert.equal(normalized.endpointPath, '/api/instagram/general-search/v1')
      assert.equal(normalized.provider, 'justone')
      assert.equal(normalized.providerCursor, null)
      assert.deepEqual(normalized.upstreamQuery, { keyword: '原查询 #词', paginationToken: '' })
      assert.deepEqual(normalized.fingerprintBody, { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...input.upstreamBody })
      assert.deepEqual(input, before)
    }
    for (const type of ['fresh', 'stable']) {
      const body = { platform: 'instagram', query: '原查询 #词', pageSize }
      const normalized = normalizeHubDataSearch(body, dataCodec, type, historicalCodec, options)
      assert.equal(normalized.provider, 'justone')
      assert.deepEqual(normalized.fingerprintBody, { ...body, type })
      assert.deepEqual(normalized.upstreamQuery, { keyword: body.query, paginationToken: '' })
    }
  }
})

test('JustOne continuation pins the provider and preserves its opaque string token without conversion', () => {
  const input = rawInput()
  const first = normalizeRawSearch(input, rawCodec, options)
  const token = 'pagination+/==&query=#原值'
  const cursor = first.encodeNext({ page: 2, providerCursor: token })
  assert.equal(rawCodec.decode(cursor).provider, 'justone')
  assert.doesNotMatch(cursor, /pagination|原值/)
  const next = normalizeRawSearch(rawInput({ cursor }), rawCodec, options)
  assert.equal(next.page, 2)
  assert.equal(next.providerCursor, token)
  assert.deepEqual(next.upstreamQuery, { keyword: '原查询 #词', paginationToken: token })
  assert.throws(() => normalizeRawSearch(rawInput({ cursor }), rawCodec), { code: 'invalid_cursor' })
  for (const providerCursor of [42, true, {}, { next_max_id: token, rank_token: token }, '', ' ', 'a'.repeat(2049), '\u0000']) {
    assert.throws(() => first.encodeNext({ page: 2, providerCursor }), { code: 'invalid_cursor' })
    const invalid = rawCodec.encode({ ...rawCodec.decode(cursor), providerCursor })
    assert.throws(() => normalizeRawSearch(rawInput({ cursor: invalid }), rawCodec, options), { code: 'invalid_cursor' })
  }
  const wrongProvider = rawCodec.encode({ ...rawCodec.decode(cursor), provider: 'rapidapi' })
  assert.throws(() => normalizeRawSearch(rawInput({ cursor: wrongProvider }), rawCodec, options), { code: 'invalid_cursor' })
  const buffered = first.encodeNext({ page: 2, buffer })
  const savedPage = normalizeRawSearch(rawInput({ cursor: buffered }), rawCodec, options)
  assert.deepEqual(savedPage.buffer, buffer)
  assert.equal(savedPage.providerCursor, null)
})

test('JustOne cursors retain query, page-size, identity and data/raw/type boundaries', () => {
  const first = normalizeHubDataSearch({ platform: 'instagram', query: '原查询', pageSize: 20 }, dataCodec, 'fresh', historicalCodec, options)
  const cursor = first.encodeNext({ page: 2, providerCursor: 'unchanged' })
  for (const [body, codec, type] of [
    [{ platform: 'instagram', query: '另查询', pageSize: 20, cursor }, dataCodec, 'fresh'],
    [{ platform: 'instagram', query: '原查询', pageSize: 30, cursor }, dataCodec, 'fresh'],
    [{ platform: 'instagram', query: '原查询', pageSize: 20, cursor }, dataCodec, 'stable'],
    [{ platform: 'instagram', query: '原查询', pageSize: 20, cursor }, createDataSearchCursorCodec(secret, 'consumer:other-key'), 'fresh'],
  ]) assert.throws(() => normalizeHubDataSearch(body, codec, type, historicalCodec, options), { code: 'invalid_cursor' })
  assert.throws(() => normalizeRawSearch(rawInput({ keyword: '原查询', cursor }), rawCodec, options), { code: 'invalid_cursor' })
})

test('untagged TikHub continuations and saved buffers preserve their old ledger identity but require restart', () => {
  const first = normalizeRawSearch(rawInput(), rawCodec)
  assert.equal(first.key, 't.instagram_v3_general_search')
  assert.deepEqual(first.upstreamQuery, { query: '原查询 #词', enable_metadata: true })
  for (const state of [
    { page: 2, providerCursor: { next_max_id: 'old-next', rank_token: 'old-rank' } },
    { page: 2, buffer },
  ]) {
    const cursor = first.encodeNext(state)
    assert.equal(rawCodec.decode(cursor).provider, undefined)
    const input = rawInput({ cursor })
    const oldRequest = normalizeRawSearch(input, rawCodec)
    const retired = normalizeRawSearch(input, rawCodec, options)
    assert.equal(retired.restartRequired, true)
    assert.equal(retired.provider, 'tikhub')
    assert.equal(retired.upstreamQuery, undefined)
    assert.deepEqual(retired.fingerprintBody, oldRequest.fingerprintBody)
    assert.deepEqual(retired.buffer, oldRequest.buffer)
  }
  const body = { platform: 'instagram', query: '原查询', pageSize: 20 }
  const oldFirst = normalizeHubDataSearch(body, dataCodec, 'fresh', historicalCodec)
  const cursor = oldFirst.encodeNext({ page: 2, providerCursor: { next_max_id: 'old-next' } })
  const oldNext = normalizeHubDataSearch({ ...body, cursor }, dataCodec, 'fresh', historicalCodec)
  const retired = normalizeHubDataSearch({ ...body, cursor }, dataCodec, 'fresh', historicalCodec, options)
  assert.equal(retired.restartRequired, true)
  assert.equal(retired.upstreamQuery, undefined)
  assert.deepEqual(retired.fingerprintBody, oldNext.fingerprintBody)
})

test('historical mxnc1 raw and data cursors decode only to retain the old fingerprint for replay', () => {
  const input = rawInput({}, 1)
  const original = prepareNightAllCompatibilityTraversal({ operation: 'raw', platform: 'instagram',
    upstreamBody: input.upstreamBody, codec: historicalCodec })
  const page = capNightAllCompatibilityTraversal({ data: { raw_info: '[]', raw_data: '[]',
    page: { hasMore: true, nextCursor: 'legacy-provider-token', paginationMode: 'cursor' } } }, {
    operation: 'raw', platform: 'instagram', page: original.page, scope: original.scope, codec: historicalCodec })
  const cursor = page.data.page.nextCursor
  for (const continuation of [{ cursor }, { params: { cursor } }]) {
    const nextBody = { ...input.upstreamBody, ...continuation }
    const historical = prepareNightAllCompatibilityTraversal({ operation: 'raw', platform: 'instagram', upstreamBody: nextBody, codec: historicalCodec })
    const retired = normalizeRawSearch({ ...input, upstreamBody: nextBody }, rawCodec, options)
    assert.equal(retired.restartRequired, true)
    assert.equal(retired.upstreamQuery, undefined)
    assert.deepEqual(retired.fingerprintBody, { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...historical.upstreamBody })
  }
  const body = { platform: 'instagram', query: '原查询', pageSize: 1 }
  const initial = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'instagram', upstreamBody: body, codec: historicalCodec })
  const data = capNightAllDataSearchTraversal({ data: { pageInfo: { hasMore: true, nextCursor: 'legacy-token' } } }, {
    platform: 'instagram', page: initial.page, scope: initial.scope, codec: historicalCodec })
  const next = { ...body, cursor: data.data.pageInfo.nextCursor }
  const historical = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform: 'instagram', upstreamBody: next, codec: historicalCodec })
  const retired = normalizeHubDataSearch(next, dataCodec, 'fresh', historicalCodec, options)
  assert.equal(retired.restartRequired, true)
  assert.deepEqual(retired.fingerprintBody, { ...historical.upstreamBody, type: 'fresh' })
  assert.throws(() => normalizeHubDataSearch({ ...next, query: 'different' }, dataCodec, 'fresh', historicalCodec, options), { code: 'invalid_cursor' })
})

test('unmappable Instagram shapes and invalid page sizes fail closed before a provider request exists', () => {
  for (const body of [{ keyword: ['one'] }, { query: 'second' }, { keywords: ['one', 'two'] },
    { includeDetails: true }, { includeComments: true }, { commentLimit: 1 }, { page: 2 },
    { cacheMaxAgeHours: 1 }, { concurrency: 1 }, { params: { paginationToken: 'untrusted' } },
    { params: { cursor: 'unwrapped' } }, { params: { cursor: 123 } }, { params: { cursor: {} } }]) {
    assert.throws(() => normalizeRawSearch(rawInput(body), rawCodec, options), { code: 'invalid_raw_search' })
  }
  for (const size of [0, 101, 1.5, '20']) {
    assert.throws(() => normalizeRawSearch(rawInput({}, size), rawCodec, options), { code: 'invalid_raw_search' })
  }
  assert.throws(() => normalizeRawSearch(rawInput({ cursor: 'unwrapped-provider-token' }), rawCodec, options), { code: 'invalid_cursor' })
})

test('Instagram option does not alter Weibo or Twitter normalization and routing', () => {
  for (const platform of ['weibo', 'twitter']) {
    const input = { platform, pageSize: 20, upstreamBody: { platform, query: 'fixture', count: 20 } }
    const original = normalizeRawSearch(input, rawCodec)
    const withOption = normalizeRawSearch(input, rawCodec, options)
    assert.deepEqual(withOption.upstreamQuery, original.upstreamQuery)
    assert.deepEqual(withOption.fingerprintBody, original.fingerprintBody)
    assert.equal(withOption.operation, original.operation)
  }
  assert.equal(canRouteDataSearch({ platform: 'weibo', pageSize: 1 }), false)
  assert.equal(canRouteRawSearch({ platform: 'twitter', pageSize: 100, upstreamBody: { query: 'fixture' } }), false)
  assert.equal(canRouteRawSearch({ platform: 'weibo', pageSize: 20, upstreamBody: { query: 'fixture', includeDetails: true } }), true)
})
