import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeHubDataSearch, projectTwitterSearchFillDelivery } from '../../server/contracts/hub-data-search.mjs'
import { normalizeRawSearch } from '../../server/contracts/raw-search.mjs'
import { normalizeTwitterResponse } from '../../server/contracts/hub-social.mjs'
import { createDataSearchCursorCodec, createRawSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const codec = createDataSearchCursorCodec('twitter-fill-offline-test-pepper', 'consumer:key')
const body = { platform: 'twitter', query: 'fixture', pageSize: 20 }
const deliveryId = '992e50ff-aa36-480b-b25e-e9a0f7abd625'
const buffer = { callId: '446a7664-028d-4dc8-940a-06baaff0c340', offset: 3, hash: 'a'.repeat(64) }
const normalize = (patch = {}) => normalizeHubDataSearch({ ...body, ...patch }, codec, 'stable')
const fill = { version: 'twitter-fill.v1', previousDeliveryId: deliveryId, upstreamPages: 2 }

test('fill cursors carry bounded durable lineage and admit arbitrary source offsets without weakening legacy buffers', () => {
  const first = normalize()
  const cursor = first.encodeNext({ page: 2, buffer, fill })
  const next = normalize({ cursor })
  assert.deepEqual(next.fill, fill)
  assert.deepEqual(next.buffer, buffer)
  assert.equal(next.scopeHash, codec.decode(cursor).scope)
  assert.equal(next.resultType, 'stable')
  assert.ok(cursor.length < 1000)
  assert.equal(codec.decode(cursor).provider, 'rapidapi')
  assert.throws(() => normalize({ cursor: first.encodeNext({ page: 2, buffer }) }), { code: 'invalid_cursor' })
  const old = first.encodeNext({ page: 2, buffer: { ...buffer, offset: 20 } })
  assert.equal(normalize({ cursor: old }).fill, null)
  assert.equal(normalize({ cursor: old }).buffer.offset, 20)
})

test('fill markers fail closed for unsupported versions, lineage IDs, counters, extra state and raw routes', () => {
  const first = normalize(), state = codec.decode(first.encodeNext({ page: 2, buffer, fill }))
  for (const bad of [null, [], {}, { ...fill, version: 'twitter-fill.v2' }, { ...fill, previousDeliveryId: 'invalid' },
    { ...fill, upstreamPages: -1 }, { ...fill, upstreamPages: 16 }, { ...fill, upstreamPages: 1.5 },
    { ...fill, seenIds: ['1'] }]) {
    assert.throws(() => normalize({ cursor: codec.encode({ ...state, fill: bad }) }), { code: 'invalid_cursor' })
  }
  for (const patch of [{ provider: 'tikhub' }, { provider: undefined }]) {
    assert.throws(() => normalize({ cursor: codec.encode({ ...state, ...patch }) }), { code: 'invalid_cursor' })
  }
  const rawCodec = createRawSearchCursorCodec('twitter-fill-offline-test-pepper', 'consumer:key')
  assert.throws(() => normalizeRawSearch({ platform: 'twitter', pageSize: 20,
    upstreamBody: { platform: 'twitter', query: 'fixture', count: 20, cursor: rawCodec.encode(state) } }, rawCodec), { code: 'invalid_cursor' })
  assert.throws(() => normalize({ query: 'changed', cursor: codec.encode(state) }), { code: 'invalid_cursor' })
  assert.throws(() => normalizeHubDataSearch({ ...body, cursor: codec.encode(state) }, codec, 'fresh'), { code: 'invalid_cursor' })
})

test('fill delivery preserves per-source collectedAt and projection incompleteness in strict standard v1', () => {
  const request = normalize()
  const acquired = normalizeTwitterResponse({ entries: [{ content: { itemContent: { tweet_results: { result: {
    rest_id: '1', legacy: { full_text: 'fixture content' },
  } } } } }] }, request.providerRequest)
  const item = { ...acquired.data.items[0], collectedAt: '2026-10-14T01:00:00.000Z' }
  const result = projectTwitterSearchFillDelivery({ items: [item], capturedAt: '2026-10-15T01:00:00.000Z',
    buffer, providerCursor: null, upstreamPages: 2, upstreamCallCount: 1, previousDeliveryId: deliveryId,
    discardedCount: 1 }, request)
  assert.equal(result.publicBody.data.contractVersion, 'night-all.data-search.v1')
  assert.equal(result.publicBody.data.items[0].collectedAt, item.collectedAt)
  assert.equal(result.publicBody.data.status, 'partial')
  assert.equal(result.publicBody.data.warnings[0].code, 'TWITTER_ITEMS_DISCARDED')
  assert.equal(result.publicBody.data.meta.providerCalls, 1)
  const state = codec.decode(result.publicBody.data.pageInfo.nextCursor)
  assert.deepEqual(state.fill, fill)
  assert.deepEqual(state.buffer, buffer)
  assert.doesNotMatch(JSON.stringify(result.publicBody), /previousDeliveryId|twitter-fill|bodySha256/)
})

test('fill delivery distinguishes the upstream traversal cap from the public page cap', () => {
  const input = { items: [], capturedAt: '2026-10-15T01:00:00.000Z', providerCursor: 'private-next',
    upstreamPages: 15, upstreamCallCount: 0, previousDeliveryId: deliveryId }
  const stopped = projectTwitterSearchFillDelivery(input, normalize())
  assert.equal(stopped.publicBody.data.pageInfo.hasMore, false)
  assert.equal(stopped.publicBody.data.pageInfo.nextCursor, null)
  assert.equal(stopped.publicBody.data.warnings[0].code, 'TWITTER_PAGE_LIMIT_REACHED')
  const carry = projectTwitterSearchFillDelivery({ ...input, buffer }, normalize())
  assert.equal(carry.publicBody.data.pageInfo.hasMore, true, 'already purchased carry remains deliverable at upstream cap')
  const capped = projectTwitterSearchFillDelivery({ ...input, buffer }, { ...normalize(), page: 15 })
  assert.equal(capped.publicBody.data.pageInfo.hasMore, false)
  assert.equal(capped.publicBody.data.pageInfo.nextCursor, null)
})
