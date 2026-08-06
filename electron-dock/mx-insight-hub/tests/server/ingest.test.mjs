import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson,
  normalizeSearchPayload,
  observationHash,
  sha256,
} from '../../server/ingest/normalizers.mjs'

function payload(items) {
  return { data: { platform: 'xiaohongshu', items } }
}

const xhsItem = {
  id: 'xiaohongshu:note-1',
  externalId: 'note-1',
  platform: 'xiaohongshu',
  contentType: 'video',
  url: 'https://example.invalid/note-1',
  title: 'AI Agent 实践',
  text: '正文内容',
  publishedAt: '2026-08-03T00:00:00.000Z',
  collectedAt: '2026-08-03T00:00:10.000Z',
  author: { id: 'user-1', name: '作者', avatarUrl: 'https://example.invalid/a.png' },
  metrics: { likes: 1, comments: 2, shares: 3, views: null, bookmarks: 4 },
  media: { coverUrl: 'https://example.invalid/c.png', images: [], videos: [] },
  source: { provider: 'tikhub', endpointId: 'xiaohongshu_app_v2_search_notes' },
}

test('maps the upstream stable envelope onto canonical fields', () => {
  const { records, skipped } = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu')
  assert.equal(skipped, 0)
  assert.equal(records.length, 1)
  const record = records[0]

  assert.equal(record.externalId, 'note-1')
  assert.equal(record.objectType, 'post')
  assert.equal(record.title, 'AI Agent 实践')
  assert.equal(record.body, '正文内容')
  assert.equal(record.authorExternalId, 'user-1')
  assert.equal(record.authorName, '作者')
  assert.equal(record.eventTime.toISOString(), '2026-08-03T00:00:00.000Z')
  assert.equal(record.rank, 1)
  // `views: null` must not become a 0 metric.
  assert.deepEqual(record.metrics, { likes: 1, comments: 2, shares: 3, bookmarks: 4 })
})

test('keeps provider lineage out of mapped columns but inside extensions', () => {
  const { records } = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu')
  // `source` is lineage: retained for ingest, never promoted to a public column.
  assert.deepEqual(records[0].extensions.source, {
    provider: 'tikhub',
    endpointId: 'xiaohongshu_app_v2_search_notes',
  })
})

test('unmapped upstream fields survive as extensions instead of being dropped', () => {
  const { records } = normalizeSearchPayload(
    payload([{ ...xhsItem, brandNewField: { nested: 1 } }]),
    'xiaohongshu',
  )
  assert.deepEqual(records[0].extensions.brandNewField, { nested: 1 })
})

test('items without an external id are skipped rather than given a synthetic key', () => {
  const { records, skipped } = normalizeSearchPayload(
    payload([{ title: 'no id' }, xhsItem]),
    'xiaohongshu',
  )
  assert.equal(skipped, 1)
  assert.equal(records.length, 1)
  assert.equal(records[0].externalId, 'note-1')
})

test('twitter items get a title derived from the body', () => {
  const { records } = normalizeSearchPayload(
    { data: { items: [{ externalId: 't-1', text: 'hello world', author: { id: 'a' } }] } },
    'twitter',
  )
  assert.equal(records[0].title, 'hello world')
  assert.equal(records[0].contentType, 'tweet')
})

test('douyin items default to video content type', () => {
  const { records } = normalizeSearchPayload(
    { data: { items: [{ externalId: 'd-1', text: 'v', author: { id: 'a' } }] } },
    'douyin',
  )
  assert.equal(records[0].contentType, 'video')
})

test('payload hash ignores key order so an unchanged item does not create a revision', () => {
  const reordered = Object.fromEntries(Object.entries(xhsItem).reverse())
  const first = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu').records[0]
  const second = normalizeSearchPayload(payload([reordered]), 'xiaohongshu').records[0]
  assert.equal(first.payloadSha256, second.payloadSha256)
})

test('collection metadata and drifting metrics do not count as content changes', () => {
  // Otherwise every re-crawl of an unchanged post would create a revision and
  // enqueue a projection event. That history belongs to observations instead.
  const base = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu').records[0]
  const recrawled = normalizeSearchPayload(
    payload([{ ...xhsItem, collectedAt: '2026-09-01T00:00:00.000Z', metrics: { likes: 999 } }]),
    'xiaohongshu',
  ).records[0]
  assert.equal(base.payloadSha256, recrawled.payloadSha256)
  // The new metric value still reaches the observation record.
  assert.deepEqual(recrawled.metrics, { likes: 999 })
})

test('payload hash changes when content changes', () => {
  const edited = { ...xhsItem, title: 'changed' }
  const first = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu').records[0]
  const second = normalizeSearchPayload(payload([edited]), 'xiaohongshu').records[0]
  assert.notEqual(first.payloadSha256, second.payloadSha256)
})

test('observation hash is stable for a replayed batch and distinct for a later crawl', () => {
  const [record] = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu').records
  const replay = normalizeSearchPayload(payload([xhsItem]), 'xiaohongshu').records[0]
  assert.equal(observationHash(record, 'fp'), observationHash(replay, 'fp'))

  const later = normalizeSearchPayload(
    payload([{ ...xhsItem, collectedAt: '2026-08-04T00:00:00.000Z' }]),
    'xiaohongshu',
  ).records[0]
  assert.notEqual(observationHash(record, 'fp'), observationHash(later, 'fp'))

  // A different query that returned the same post is a separate sighting.
  assert.notEqual(observationHash(record, 'fp'), observationHash(record, 'other-fp'))
})

test('canonical json sorts keys deterministically', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}')
  assert.equal(sha256('x').length, 64)
})
