import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTwitterSearchParameters } from '../../server/contracts/twitter-search-parameters.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { normalizeContentSearchDelivery } from '../../server/external-platforms/content-search.mjs'
import { createDataSearchCursorCodec, createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'
import { normalizeDataSearchV2, prepareDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { normalizedTwitterRetryBody } from '../../server/external-platforms/twitter-manual-retry.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'

const pepper = 'twitter-parameters-fixture-pepper-32bytes'
const codec = createDataSearchCursorCodec(pepper, 'consumer:key')
const body = { platform: 'twitter', query: 'fixture #topic', pageSize: 20 }
const rapid = patch => normalizeHubDataSearch({ ...body, ...patch }, codec, 'stable')
const tikHub = patch => normalizeContentSearchDelivery({ ...body, ...patch }, { dataSearch: { resultType: 'stable' }, codec })
const deliveryId = 'd45d5607-0f30-40a0-9649-40260a7f47d1'

test('new standard searches default to Latest and explicit category/filter/timestamp overrides reach the actual adapter', async () => {
  assert.deepEqual(rapid().twitterSearchParameters, { category: 'Latest', includeTimestamp: false })
  assert.deepEqual(rapid().fingerprintBody, { ...body, type: 'stable' }, 'implicit default does not rewrite old saved fingerprints')
  for (const category of ['Top', 'Latest', 'Photos', 'Videos']) {
    const params = { category, filters: ' lang:zh -filter:retweets ', includeTimestamp: true }
    const request = rapid({ params }), wires = []
    const adapter = new RapidApiAdapter({ apiKey: 'synthetic-only', fetchImpl: async (url, options) => {
      wires.push({ url, options }); return Response.json({ entries: [] })
    } })
    await adapter.execute(request.providerRequest)
    assert.equal(wires.length, 1)
    assert.deepEqual(Object.fromEntries(wires[0].url.searchParams), {
      count: '20', category, includeTimestamp: 'true', filters: 'lang:zh -filter:retweets',
    })
    assert.equal(wires[0].options.method, 'GET')
    assert.equal(decodeURIComponent(wires[0].url.pathname.slice('/search/'.length)), body.query)
  }
})

test('parameters are bounded content options; native pagination, count, People and routing controls are rejected', () => {
  for (const params of [null, [], '', { category: 'People' }, { category: 'latest' }, { category: null },
    { filters: 'a'.repeat(2049) }, { filters: 'x\0y' }, { filters: {} }, { includeTimestamp: 'false' },
    { count: 20 }, { cursor: 'native-bottom' }, { provider: 'rapidapi' }, { timeout: 60000 }]) {
    assert.throws(() => rapid({ params }), { code: 'invalid_twitter_search_parameters' })
  }
  assert.deepEqual(normalizeTwitterSearchParameters({ filters: '  ', includeTimestamp: false }), { includeTimestamp: false })
})

test('new cursors bind every override and page size while retaining native Bottom tokens and buffers', () => {
  const params = { category: 'Photos', filters: 'lang:zh', includeTimestamp: true }
  const first = rapid({ params }), buffer = { callId: deliveryId, offset: 20, hash: 'a'.repeat(64) }
  const cursor = first.encodeNext({ page: 2, providerCursor: 'native+bottom/=', buffer })
  const next = rapid({ params, cursor })
  assert.equal(next.providerRequest.upstreamQuery.cursor, 'native+bottom/=')
  assert.deepEqual(next.buffer, buffer)
  assert.deepEqual(next.twitterSearchParameters, first.twitterSearchParameters)
  for (const patch of [{ params: { ...params, category: 'Latest' } }, { params: { ...params, filters: 'lang:en' } },
    { params: { ...params, includeTimestamp: false } }, { params: undefined }, { pageSize: 10 }]) {
    assert.throws(() => rapid({ params, cursor, ...patch }), { code: 'invalid_cursor' })
  }
  const implicit = rapid(), implicitCursor = implicit.encodeNext({ page: 2, providerCursor: 'bottom' })
  assert.equal(rapid({ cursor: implicitCursor }).providerRequest.upstreamQuery.category, 'Latest')
  assert.throws(() => rapid({ cursor: implicitCursor, params: {} }), { code: 'invalid_cursor' })
})

test('maximum filter text is not duplicated into the cursor and a bounded native token still fits Hub pagination', () => {
  const params = { filters: '文'.repeat(2048), includeTimestamp: true }
  const first = rapid({ params }), token = 'n'.repeat(4096)
  const cursor = first.encodeNext({ page: 2, providerCursor: token })
  assert.ok(cursor.length <= 8192)
  assert.equal(rapid({ params, cursor }).providerRequest.upstreamQuery.cursor, token)
  assert.equal(codec.decode(cursor).twitterSearchCategory, 'Latest')
})

test('old markerless RapidAPI and TikHub cursors retain Top through subsequent new cursors', () => {
  for (const normalize of [rapid, tikHub]) {
    const first = normalize(), issued = normalize === rapid
      ? first.encodeNext({ page: 2, providerCursor: 'old-native' }) : first.encodeNext(deliveryId)
    const old = codec.decode(issued)
    delete old.twitterSearchCategory
    const oldCursor = codec.encode(old), continued = normalize({ cursor: oldCursor })
    assert.equal(continued.twitterSearchParameters.category, 'Top')
    assert.equal(normalize === rapid ? continued.providerRequest.upstreamQuery.category : continued.params.search_type, 'Top')
    const nextCursor = normalize === rapid ? continued.encodeNext({ page: 3, providerCursor: 'next-native' }) : continued.encodeNext(deliveryId)
    assert.equal(normalize({ cursor: nextCursor }).twitterSearchParameters.category, 'Top')
    assert.throws(() => normalize({ cursor: oldCursor, params: { category: 'Latest' } }), { code: 'invalid_cursor' })
  }
})

test('TikHub preserves supported explicit sorting and rejects options it cannot represent before acquisition', () => {
  assert.deepEqual(tikHub().params, { search_type: 'Latest' })
  assert.deepEqual(tikHub({ params: { category: 'Top', includeTimestamp: false } }).params, { search_type: 'Top' })
  for (const params of [{ category: 'Photos' }, { category: 'Videos' }, { filters: 'lang:zh' }, { includeTimestamp: true }]) {
    assert.throws(() => tikHub({ params }), { code: 'twitter_search_parameters_unsupported' })
  }
})

test('v2 and explicit retry preserve normalized options, bind continuations and retain omitted historical bodies', () => {
  const timeWindow = { from: '2026-10-16T16:00:00.000Z', to: '2026-10-18T16:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' }
  const params = { category: 'Videos', filters: 'lang:zh', includeTimestamp: true }
  const normalized = normalizeDataSearchV2({ ...body, type: 'stable', timeWindow, params })
  const v2Codec = createDataSearchV2CursorCodec(pepper, 'consumer:key'), prepared = prepareDataSearchV2(normalized, v2Codec)
  assert.deepEqual(prepared.upstream.params, params)
  const snapshot = { method: 'POST', path: '/api/v1/data/search', body: prepared.upstream }
  assert.deepEqual(normalizedTwitterRetryBody(snapshot), prepared.upstream)
  assert.equal(Object.hasOwn(normalizeDataSearchV2({ ...body, timeWindow }), 'params'), false)
  const cursor = v2Codec.encode({ ...prepared.state, page: 2, cursor: 'mxds1.existing-inner-token' })
  assert.deepEqual(prepareDataSearchV2({ ...normalized, cursor }, v2Codec).upstream.params, params)
  assert.throws(() => prepareDataSearchV2({ ...normalized, params: { ...params, category: 'Top' }, cursor }, v2Codec), { code: 'invalid_cursor' })
  assert.throws(() => normalizeDataSearchV2({ ...body, platform: 'reddit', timeWindow, params }), { code: 'unsupported_fields' })
})
