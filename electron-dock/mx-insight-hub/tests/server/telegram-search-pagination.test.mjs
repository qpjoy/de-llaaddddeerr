import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { cursorTimestamp, cursorTimestampOrderKey } from '../../server/core/cursor-time.mjs'
import {
  decodeTelegramCursor, encodeTelegramCursor, encodeTelegramSearchCursor,
  normalizeTelegramMonitorQuery, normalizeTelegramSearchQuery, publicTelegramMonitorPage,
} from '../../server/data/telegram-monitor.mjs'
import { canonicalSearchResponse, normalizeCanonicalSearchQuery } from '../../server/data/stored-search.mjs'
import { SearchQueries } from '../../server/search/queries.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const SECRET = 'telegram-pagination-local-test-only'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PRECISE = '2026-10-18T12:00:00.123999Z'

test('dedicated Telegram search owns its platform, honors a small page policy and cannot route to external search', async () => {
  const store = new MemoryStore()
  const calls = []
  const service = new HubService({ store, apiKeyPepper: SECRET,
    adapter: { capabilities: async () => ({ data: { platforms: [] } }) },
    externalWechatSearch: async () => assert.fail('Telegram route must never dispatch WeChat'),
    searchQueries: { searchContent: async (query, options) => {
      calls.push({ query, options })
      return { mode: 'postgres', items: [], hasMore: false }
    } },
  })
  const tenant = await service.createTenant({ name: 'Telegram contract test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Reader' })
  await service.putPlatformConfiguration('telegram', {
    tenantId: tenant.id, consumerId: consumer.id, enabled: true,
    maxRequests: 10, windowSeconds: 3600, maxPageSize: 5,
  })
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'Reader', platforms: ['telegram'] })
  const context = { tenant, consumer, apiKey }
  const input = { path: '/api/v1/data/telegram/search', idempotencyKey: 'tg-dedicated-default', body: { query: 'agent' } }
  assert.equal((await service.search(context, input)).status, 200)
  assert.equal(calls[0].options.size, 5)
  assert.equal(calls[0].options.platform, 'telegram')
  assert.equal((await service.search(context, input)).replay, true)
  assert.equal(calls.length, 1)
  await assert.rejects(() => service.search(context, {
    ...input, idempotencyKey: 'tg-invalid-platform', body: { query: 'agent', platform: 'wechat_search' },
  }), { code: 'unsupported_fields' })
  assert.equal(calls.length, 1)
})

test('keyset timestamps preserve microseconds and reject malformed canonical times', () => {
  assert.equal(cursorTimestamp(PRECISE), PRECISE)
  assert.equal(cursorTimestamp(new Date(PRECISE)), '2026-10-18T12:00:00.123Z')
  assert.equal(cursorTimestampOrderKey('2026-10-18T12:00:00.123Z'), cursorTimestampOrderKey('2026-10-18T12:00:00.123000Z'))
  assert.ok(cursorTimestampOrderKey(PRECISE) > cursorTimestampOrderKey('2026-10-18T12:00:00.123998Z'))
  for (const invalid of ['2026-02-30T12:00:00.123456Z', '2026-10-18T24:00:00.123Z', 'x', '2026-10-18T12:00:00.1234567Z']) {
    assert.equal(cursorTimestamp(invalid), null)
  }
})

test('legacy and source-bound Telegram history cursors retain exact boundaries and accept old tokens', () => {
  for (const sortTime of [PRECISE, '2026-10-18T12:00:00.123Z']) {
    assert.deepEqual(decodeTelegramCursor(encodeTelegramCursor({ sortTime, id: id(1) })), { sortTime, id: id(1) })
    const input = { sourceScope: 'all', chatId: '-1007', pageSize: 1 }
    const query = normalizeTelegramMonitorQuery(input, 100, 'messages', SECRET)
    const page = publicTelegramMonitorPage([
      { id: id(1), sort_time: sortTime, stable_fields: {} },
      { id: id(2), sort_time: sortTime, stable_fields: {} },
    ], 1, { cursorBinding: query.cursorBinding, cursorSecret: SECRET })
    const next = normalizeTelegramMonitorQuery({ ...input, cursor: page.pageInfo.nextCursor }, 100, 'messages', SECRET)
    assert.deepEqual(next.cursor, { sortTime, id: id(1) })
    assert.throws(() => normalizeTelegramMonitorQuery({ ...input, pageSize: 2, cursor: page.pageInfo.nextCursor }, 100, 'messages', SECRET), { code: 'invalid_cursor' })
  }
})

function publicSearchCursor(result, query) {
  return encodeTelegramSearchCursor({ ...result.nextCursor, seen: 1 }, query.cursorBinding, SECRET)
}

test('Telegram and canonical PG search contracts accept exact microseconds without relaxing signed filters', () => {
  for (const time of [PRECISE, '2026-10-18T12:00:00.123Z', null]) {
    const input = { query: 'agent', sourceScope: 'all', pageSize: 1 }
    const normalized = normalizeTelegramSearchQuery(input, 100, SECRET)
    const result = { mode: 'postgres', items: [{ id: id(1) }], hasMore: true,
      nextCursor: { mode: 'postgres', pitId: null, searchAfter: [time, id(1)] } }
    const cursor = publicSearchCursor(result, normalized)
    assert.equal(normalizeTelegramSearchQuery({ ...input, cursor }, 100, SECRET).cursor.searchAfter[0], time)
    assert.throws(() => normalizeTelegramSearchQuery({ ...input, query: 'changed', cursor }, 100, SECRET), { code: 'invalid_cursor' })
    const canonicalInput = { query: 'agent', platform: 'telegram', pageSize: 1 }
    const options = { platforms: ['telegram'], cursorSecret: SECRET }
    const query = normalizeCanonicalSearchQuery(canonicalInput, options)
    const response = canonicalSearchResponse({ query, result, durationMs: 1, cursorSecret: SECRET })
    assert.equal(normalizeCanonicalSearchQuery({ ...canonicalInput, cursor: response.data.pageInfo.nextCursor }, options).cursor.searchAfter[0], time)
  }
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('real PostgreSQL fallback paginates same-millisecond rows once and treats wildcard characters literally', {
  skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to an installed PGlite module',
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA core; CREATE TABLE core.canonical_records (
    id uuid PRIMARY KEY, dataset_id text, platform text, object_type text,
    external_id text, url text, title text, body text, author_external_id text, author_name text,
    event_time timestamptz, collected_at timestamptz, stable_fields jsonb, deleted_at timestamptz
  )`)
  for (const [n, time, body] of [
    [1, PRECISE, 'agent rate 50% user_name C:\\logs'],
    [2, '2026-10-18T12:00:00.123998Z', 'agent rate 500 userXname C:logs'],
    [3, '2026-10-18T12:00:00.123998Z', 'agent third'],
    [4, null, 'agent undated'],
  ]) {
    await db.query(`INSERT INTO core.canonical_records
      (id,dataset_id,platform,object_type,external_id,body,event_time,stable_fields)
      VALUES ($1,'telegram.monitor.messages.v1','telegram','message',$2,$3,$4,'{}')`, [id(n), `-1007:${n}`, body, time])
  }
  const queries = new SearchQueries({ pool: db, client: null, segmenter: null, indexSet: {} })
  const input = { query: 'agent', sourceScope: 'all', pageSize: 1 }
  let normalized = normalizeTelegramSearchQuery(input, 100, SECRET)
  const delivered = []
  do {
    const result = await queries.searchContent(input.query, { platform: 'telegram', size: 1, cursor: normalized.cursor })
    delivered.push(...result.items.map((item) => item.id))
    if (!result.hasMore) break
    normalized = normalizeTelegramSearchQuery({ ...input, cursor: publicSearchCursor(result, normalized) }, 100, SECRET)
  } while (delivered.length < 8)
  assert.deepEqual(delivered, [id(1), id(3), id(2), id(4)])
  for (const query of ['50%', 'user_name', 'C:\\logs']) {
    const result = await queries.searchContent(query, { platform: 'telegram', trackTotalHits: true })
    assert.deepEqual(result.items.map((item) => item.id), [id(1)])
    assert.equal(result.total, 1)
    // Empty offset page uses the separate count query; its matching must agree.
    const empty = await queries.searchContent(query, { platform: 'telegram', offset: 1, trackTotalHits: true })
    assert.deepEqual(empty.items, [])
    assert.equal(empty.total, 1)
  }
})
