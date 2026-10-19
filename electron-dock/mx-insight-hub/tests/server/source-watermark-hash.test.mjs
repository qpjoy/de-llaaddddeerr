import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMapping, refreshMappedPayloadSha256 } from '../../server/ingest/external/mapping.mjs'

// Telegram monitor messages mapping v2 (migration 012), trimmed to what matters.
const fieldMap = {
  externalId: { from: ['chat_id', 'message_id'], type: 'composite', separator: ':' },
  body: { from: 'message_text' },
  eventTime: { from: 'message_at', type: 'timestamp' },
  collectedAt: { from: 'collected_at', type: 'timestamp' },
  deletedAt: { from: 'deleted_at', type: 'timestamp' },
  'metrics.views': { from: 'view_count', type: 'number' },
  _drop: { from: ['id', 'metadata'] },
}
const row = (overrides = {}) => ({ id: 1, chat_id: 7, message_id: 9, message_text: 'hello', message_at: '2026-10-19T00:00:00Z',
  collected_at: '2026-10-19T00:00:01Z', deleted_at: null, view_count: 10, updated_at: '2026-10-19T00:00:02Z', ...overrides })
const map = (raw, bookkeepingColumns = ['updated_at']) => refreshMappedPayloadSha256(applyMapping(raw, fieldMap, {
  platform: 'telegram', objectType: 'message', source: { origin: 'database', sourceKey: 'telegram-monitor-messages' },
  bookkeepingColumns }).record)

test('a re-read that only advanced the source watermark is neither a canonical nor a raw change', () => {
  const first = map(row()), touched = map(row({ updated_at: '2026-10-19T05:00:00Z' }))
  assert.equal(touched.payloadSha256, first.payloadSha256)
  assert.equal(touched.rawPayloadSha256, first.rawPayloadSha256)
  assert.equal(Object.hasOwn(touched.extensions, 'updated_at'), false)
  assert.equal(touched.rawItem.updated_at, '2026-10-19T05:00:00Z', 'lineage keeps the watermark')
})

test('real content, deletion and metric changes still create revisions', () => {
  const first = map(row())
  for (const change of [{ message_text: 'edited' }, { deleted_at: '2026-10-19T06:00:00Z' }, { view_count: 11 }]) {
    const next = map(row({ ...change, updated_at: '2026-10-19T06:00:00Z' }))
    assert.notEqual(next.rawPayloadSha256, first.rawPayloadSha256, JSON.stringify(change))
    if (!('view_count' in change)) assert.notEqual(next.payloadSha256, first.payloadSha256, JSON.stringify(change))
  }
})

test('without the option the watermark still counts, as before', () => {
  const legacy = map(row(), []), touched = map(row({ updated_at: '2026-10-19T05:00:00Z' }), [])
  assert.notEqual(touched.payloadSha256, legacy.payloadSha256)
  assert.notEqual(touched.rawPayloadSha256, legacy.rawPayloadSha256)
  assert.equal(legacy.extensions.updated_at, '2026-10-19T00:00:02Z')
})

test('a consumed watermark is still kept out of the raw hash; canonical content made from it still revises', () => {
  const touch = { updated_at: '2026-10-19T05:00:00Z' }
  const mapWith = (extra, raw) => refreshMappedPayloadSha256(applyMapping(raw, { ...fieldMap, ...extra }, {
    platform: 'telegram', objectType: 'message', bookkeepingColumns: ['updated_at'] }).record)

  // Chats mapping v2: collectedAt <- updated_at (observation metadata).
  const chat = { collectedAt: { from: 'updated_at', type: 'timestamp' } }
  const chatFirst = mapWith(chat, row()), chatTouched = mapWith(chat, row(touch))
  assert.equal(chatTouched.collectedAt.toISOString(), '2026-10-19T05:00:00.000Z')
  assert.equal(chatTouched.rawPayloadSha256, chatFirst.rawPayloadSha256)
  assert.equal(chatTouched.payloadSha256, chatFirst.payloadSha256)

  const dropped = { _drop: { from: ['id', 'metadata', 'updated_at'] } }
  assert.equal(mapWith(dropped, row(touch)).rawPayloadSha256, mapWith(dropped, row()).rawPayloadSha256)

  const content = { editedAt: { from: 'updated_at', type: 'timestamp' } }
  assert.notEqual(mapWith(content, row(touch)).payloadSha256, mapWith(content, row()).payloadSha256)
})
