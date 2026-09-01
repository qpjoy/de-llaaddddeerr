import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalTimelineInitialResponse,
  canonicalTimelineScopeFingerprint,
  decodeCanonicalTimelineCursor,
  normalizeCanonicalTimelineQuery,
} from '../../server/data/canonical-timeline.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import {
  PostgresStore,
  buildCanonicalTimelineStoragePlan,
} from '../../server/stores/postgres-store.mjs'

const SECRET = 'canonical-timeline-unit-test-secret'
const ANCHOR_ID = '40000000-0000-4000-8000-000000000004'
const DATASET_ID = 'telegram.monitor.messages.v1'
const CHAT_ID = '-100700'

function row(sequence) {
  return {
    id: `40000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    dataset_id: DATASET_ID,
    platform: 'telegram',
    object_type: 'message',
    content_type: 'text',
    external_id: `${CHAT_ID}:${sequence}`,
    title: 'Chat',
    body: `message-${sequence}`,
    event_time: `2026-08-24T10:0${sequence}:00.000Z`,
    collected_at: `2026-08-24T11:0${sequence}:00.000Z`,
    stable_fields: { relations: { chatId: CHAT_ID } },
    context_id: CHAT_ID,
  }
}

test('canonical timeline cursor is scope/path bound and zero after keeps a default-size polling cursor', () => {
  const scopeFingerprint = canonicalTimelineScopeFingerprint({
    tenantId: '10000000-0000-4000-8000-000000000001',
    consumerId: '20000000-0000-4000-8000-000000000002',
  })
  const query = normalizeCanonicalTimelineQuery({ before: '0', after: '0' }, {
    anchorId: ANCHOR_ID,
    maxPageSize: 50,
    scopeFingerprint,
    cursorSecret: SECRET,
  })
  const current = row(4)
  const response = canonicalTimelineInitialResponse({
    anchorId: ANCHOR_ID,
    query,
    result: {
      current,
      before: [],
      after: [],
      hasMoreStoredBefore: true,
      hasMoreStoredAfter: false,
    },
    scopeFingerprint,
    cursorSecret: SECRET,
  })
  assert.equal(response.items.length, 1)
  assert.equal(response.pageInfo.newer.hasMore, false)
  assert.equal(typeof response.pageInfo.newer.cursor, 'string')
  const cursor = decodeCanonicalTimelineCursor(response.pageInfo.newer.cursor, {
    anchorId: ANCHOR_ID,
    maxPageSize: 50,
    scopeFingerprint,
    secret: SECRET,
  })
  assert.equal(cursor.direction, 'newer')
  assert.equal(cursor.pageSize, 10)
  assert.deepEqual(cursor.boundary, {
    eventTime: current.event_time.replace('.000Z', '.000000Z'),
    id: current.id,
  })

  assert.throws(
    () => decodeCanonicalTimelineCursor(response.pageInfo.newer.cursor, {
      anchorId: '90000000-0000-4000-8000-000000000009',
      maxPageSize: 50,
      scopeFingerprint,
      secret: SECRET,
    }),
    (error) => error.status === 400 && error.code === 'invalid_cursor',
  )
  assert.throws(
    () => normalizeCanonicalTimelineQuery({ cursor: response.pageInfo.newer.cursor, after: '1' }, {
      anchorId: ANCHOR_ID,
      maxPageSize: 50,
      scopeFingerprint,
      cursorSecret: SECRET,
    }),
    (error) => error.status === 400 && error.code === 'invalid_request',
  )
  assert.throws(
    () => normalizeCanonicalTimelineQuery({ before: '' }, {
      anchorId: ANCHOR_ID,
      maxPageSize: 50,
      scopeFingerprint,
      cursorSecret: SECRET,
    }),
    (error) => error.status === 400 && error.code === 'invalid_request',
  )
})

test('MemoryStore resolves an initial window and cursor-contained pages in ascending order', async () => {
  const store = new MemoryStore()
  for (let sequence = 1; sequence <= 7; sequence += 1) {
    const item = row(sequence)
    store.canonicalRecords.set(item.id, item)
  }
  const initial = await store.getCanonicalContext({ id: ANCHOR_ID, before: 2, after: 1 })
  assert.equal(initial.contextSupported, true)
  assert.deepEqual(initial.before.map((item) => item.body), ['message-2', 'message-3'])
  assert.equal(initial.current.body, 'message-4')
  assert.deepEqual(initial.after.map((item) => item.body), ['message-5'])
  assert.equal(initial.hasMoreStoredBefore, true)
  assert.equal(initial.hasMoreStoredAfter, true)

  store.canonicalRecords.delete(ANCHOR_ID)
  const older = await store.getCanonicalTimelinePage({
    datasetId: DATASET_ID,
    contextId: CHAT_ID,
    direction: 'older',
    boundary: { eventTime: row(2).event_time, id: row(2).id },
    pageSize: 2,
  })
  const newer = await store.getCanonicalTimelinePage({
    datasetId: DATASET_ID,
    contextId: CHAT_ID,
    direction: 'newer',
    boundary: { eventTime: row(5).event_time, id: row(5).id },
    pageSize: 1,
  })
  assert.deepEqual(older.items.map((item) => item.body), ['message-1'])
  assert.equal(older.hasMore, false)
  assert.deepEqual(newer.items.map((item) => item.body), ['message-6'])
  assert.equal(newer.hasMore, true)
})

test('same-millisecond microseconds remain observable and page exclusively in both directions', async () => {
  const store = new MemoryStore()
  const fractions = ['123100', '123200', '123300', '123400', '123500']
  fractions.forEach((fraction, index) => {
    const item = row(index + 1)
    item.event_time = `2026-08-24T10:00:00.${fraction}Z`
    store.canonicalRecords.set(item.id, item)
  })
  const anchorId = row(3).id
  const result = await store.getCanonicalContext({ id: anchorId, before: 1, after: 1 })
  assert.deepEqual(
    [...result.before, result.current, ...result.after].map((item) => item.event_time_cursor),
    [
      '2026-08-24T10:00:00.123200Z',
      '2026-08-24T10:00:00.123300Z',
      '2026-08-24T10:00:00.123400Z',
    ],
  )

  const scopeFingerprint = canonicalTimelineScopeFingerprint({
    tenantId: '10000000-0000-4000-8000-000000000001',
    consumerId: '20000000-0000-4000-8000-000000000002',
  })
  const query = normalizeCanonicalTimelineQuery({ before: '1', after: '1' }, {
    anchorId,
    maxPageSize: 50,
    scopeFingerprint,
    cursorSecret: SECRET,
  })
  const response = canonicalTimelineInitialResponse({
    anchorId,
    query,
    result,
    scopeFingerprint,
    cursorSecret: SECRET,
  })
  assert.deepEqual(response.items.map((item) => item.eventTime), [
    '2026-08-24T10:00:00.123200Z',
    '2026-08-24T10:00:00.123300Z',
    '2026-08-24T10:00:00.123400Z',
  ])

  const older = decodeCanonicalTimelineCursor(response.pageInfo.older.cursor, {
    anchorId,
    maxPageSize: 50,
    scopeFingerprint,
    secret: SECRET,
  })
  const newer = decodeCanonicalTimelineCursor(response.pageInfo.newer.cursor, {
    anchorId,
    maxPageSize: 50,
    scopeFingerprint,
    secret: SECRET,
  })
  assert.equal(older.boundary.eventTime, '2026-08-24T10:00:00.123200Z')
  assert.equal(newer.boundary.eventTime, '2026-08-24T10:00:00.123400Z')
  assert.deepEqual((await store.getCanonicalTimelinePage({
    datasetId: older.datasetId,
    contextId: older.streamId,
    direction: older.direction,
    boundary: older.boundary,
    pageSize: older.pageSize,
  })).items.map((item) => item.event_time_cursor), ['2026-08-24T10:00:00.123100Z'])
  assert.deepEqual((await store.getCanonicalTimelinePage({
    datasetId: newer.datasetId,
    contextId: newer.streamId,
    direction: newer.direction,
    boundary: newer.boundary,
    pageSize: newer.pageSize,
  })).items.map((item) => item.event_time_cursor), ['2026-08-24T10:00:00.123500Z'])
})

test('Postgres timeline pages use literal dataset predicates and exclusive keyset boundaries', async () => {
  const calls = []
  const rows = [row(3), row(2), row(1)]
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows }
    },
  })
  const result = await store.getCanonicalTimelinePage({
    datasetId: DATASET_ID,
    contextId: CHAT_ID,
    direction: 'older',
    boundary: { eventTime: row(4).event_time.replace('.000Z', '.000000Z'), id: row(4).id },
    pageSize: 2,
  })
  assert.deepEqual(calls[0].values, [
    CHAT_ID,
    row(4).event_time.replace('.000Z', '.000000Z'),
    row(4).id,
    3,
  ])
  assert.match(calls[0].sql, /dataset_id = 'telegram\.monitor\.messages\.v1'/)
  assert.match(calls[0].sql, /\(r\.event_time, r\.id\) < \(\$2::timestamptz, \$3::uuid\)/)
  assert.match(calls[0].sql, /ORDER BY r\.event_time DESC, r\.id DESC/)
  assert.match(calls[0].sql, /to_char\(r\.event_time AT TIME ZONE 'UTC'/)
  assert.doesNotMatch(calls[0].sql, /raw_payload|extensions|lineage/)
  assert.deepEqual(result.items.map((item) => item.body), ['message-2', 'message-3'])
  assert.equal(result.hasMore, true)

  const plan = buildCanonicalTimelineStoragePlan()
  assert.deepEqual(Object.keys(plan).sort(), [
    'telegram.monitor.messages.v1',
    'telegram.sqlite.messages.v1',
  ])
  assert.match(plan['telegram.sqlite.messages.v1'].newer, /> \(\$2::timestamptz, \$3::uuid\)/)
  assert.match(plan['telegram.sqlite.messages.v1'].newer, /ORDER BY r\.event_time ASC, r\.id ASC/)
})
