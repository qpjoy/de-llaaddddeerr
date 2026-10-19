import assert from 'node:assert/strict'
import test from 'node:test'
import { ElasticsearchError, ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { SearchQueries } from '../../server/search/queries.mjs'
import { telegramDataSearchResponse } from '../../server/data/telegram-monitor.mjs'

const id = '11111111-1111-4111-8111-111111111111'
const pgId = '22222222-2222-4222-8222-222222222222'
const time = '2026-10-18T12:00:00.000Z'
const hit = { _id: id, _score: 1, _source: { id, body: 'partial keyword' }, sort: [1, time, id, 1] }
const cursor = { mode: 'elasticsearch', pitId: 'caller-pit', searchAfter: [1, time, id, 1] }
const filters = { platform: 'telegram', datasetIds: ['telegram.monitor.messages.v1', 'telegram.sqlite.messages.v1'],
  objectType: 'message', fromTime: '2026-10-13T12:00:00.000Z', toTime: time, size: 20 }

function response(overrides = {}) {
  return { pit_id: 'renewed-pit', timed_out: false, _shards: { total: 2, successful: 2, skipped: 0, failed: 0 },
    hits: { total: { value: 0, relation: 'eq' }, hits: [] }, ...overrides }
}

function fixture({ searchResponse = response(), opened = { id: 'opened-pit' }, pgError = null, closeError = null } = {}) {
  const calls = []
  const pgCalls = []
  const warnings = []
  const queries = new SearchQueries({
    pool: { async query(sql, values) {
      pgCalls.push({ sql, values })
      if (pgError) throw pgError
      return { rows: [{ id: pgId, dataset_id: filters.datasetIds[0], platform: 'telegram', object_type: 'message',
        body: 'complete PostgreSQL keyword', event_time: new Date(time), event_time_cursor: time, stable_fields: {} }] }
    } },
    client: { async request(method, path, body) {
      calls.push({ method, path, body })
      if (path.includes('/_pit?')) return opened
      if (method === 'DELETE' && path === '/_pit') {
        if (closeError) throw closeError
        return { succeeded: true }
      }
      assert.equal(path, '/_search')
      if (searchResponse instanceof Error) throw searchResponse
      return typeof searchResponse === 'function' ? searchResponse() : searchResponse
    } },
    segmenter: { async segmentWithMeta() { return { tokens: ['keyword'], backendUsed: 'hanlp', degraded: false } } },
    indexSet: { readAlias: 'synthetic-content' },
    logger: { warn(...values) { warnings.push(values) } },
  })
  return { queries, calls, pgCalls, warnings }
}

const closedPits = calls => calls.filter(call => call.method === 'DELETE').map(call => call.body.id)
const telegramPage = result => telegramDataSearchResponse({ query: 'keyword', result, pageSize: 20,
  cursor: null, cursorBinding: 'synthetic-binding', cursorSecret: 'synthetic-secret', durationMs: 1 }).data

test('healthy empty Elasticsearch response remains a successful empty page without PostgreSQL fallback', async () => {
  const f = fixture()
  const result = await f.queries.searchContent('keyword', filters)
  assert.equal(result.mode, 'elasticsearch')
  assert.deepEqual(result.items, [])
  assert.equal(result.hasMore, false)
  assert.equal(result.nextCursor, null)
  assert.deepEqual(telegramPage(result).warnings, [])
  assert.equal(f.pgCalls.length, 0)
  assert.deepEqual(closedPits(f.calls), ['renewed-pit'])
})

for (const failure of [
  { label: 'timed-out', metadata: { timed_out: true } },
  { label: 'failed-shard', metadata: { _shards: { total: 2, successful: 1, skipped: 0, failed: 1 } } },
]) {
  for (const hits of [[], [hit]]) {
    test(`${failure.label} first page with ${hits.length} ES hits discards incomplete data and closes PIT before PG fallback`, async () => {
      const f = fixture({ searchResponse: response({ ...failure.metadata, hits: { total: { value: hits.length }, hits } }) })
      const result = await f.queries.searchContent('keyword', filters)
      assert.equal(result.mode, 'postgres')
      assert.deepEqual(result.items.map(item => item.id), [pgId])
      assert.equal(result.nextCursor, null)
      assert.equal(f.pgCalls.length, 1)
      assert.deepEqual(f.pgCalls[0].values.slice(1, 5), ['telegram', null, filters.datasetIds, 'message'])
      assert.deepEqual(f.pgCalls[0].values.slice(7, 9), [filters.fromTime, filters.toTime])
      assert.deepEqual(closedPits(f.calls), ['renewed-pit'])
      assert.equal(telegramPage(result).warnings[0].code, 'search_projection_degraded')
    })

    test(`${failure.label} continuation with ${hits.length} ES hits returns 503 and preserves the same cursor snapshot`, async () => {
      let retry = false
      const f = fixture({ searchResponse: () => retry ? response() : response({
        ...failure.metadata, hits: { total: { value: hits.length }, hits },
      }) })
      await assert.rejects(f.queries.searchContent('keyword', { ...filters, cursor }), {
        status: 503, code: 'search_cursor_unavailable',
      })
      assert.equal(f.pgCalls.length, 0)
      assert.equal(f.calls.some(call => call.path.includes('/_pit?')), false)
      assert.deepEqual(closedPits(f.calls), [])
      assert.deepEqual(f.calls[0].body.search_after, cursor.searchAfter)
      retry = true
      const result = await f.queries.searchContent('keyword', { ...filters, cursor })
      assert.equal(result.mode, 'elasticsearch')
      assert.deepEqual(f.calls[1].body.search_after, cursor.searchAfter)
      assert.deepEqual(f.calls[1].body.pit.id, cursor.pitId)
      assert.deepEqual(closedPits(f.calls), ['renewed-pit'])
    })
  }
}

test('partially opened PIT is closed without attempting an incomplete Elasticsearch search', async () => {
  const f = fixture({ opened: { id: 'partial-opened-pit', _shards: { total: 2, successful: 1, failed: 1 } } })
  const result = await f.queries.searchContent('keyword', filters)
  assert.equal(result.mode, 'postgres')
  assert.equal(f.calls.some(call => call.path === '/_search'), false)
  assert.deepEqual(closedPits(f.calls), ['partial-opened-pit'])
})

test('first-page transport outage closes the unissued PIT and retains the existing PG fallback', async () => {
  const f = fixture({ searchResponse: new ElasticsearchUnavailableError(new Error('synthetic offline')) })
  assert.equal((await f.queries.searchContent('keyword', filters)).mode, 'postgres')
  assert.deepEqual(closedPits(f.calls), ['opened-pit'])
})

test('PIT cleanup does not hide the PostgreSQL failure or prevent fallback when close is unavailable', async () => {
  const pgError = new Error('synthetic PostgreSQL failure')
  const f = fixture({ searchResponse: response({ timed_out: true }), pgError })
  await assert.rejects(f.queries.searchContent('keyword', filters), error => error === pgError)
  assert.deepEqual(closedPits(f.calls), ['renewed-pit'])
  const closeFailure = fixture({ searchResponse: response({ timed_out: true }), closeError: new Error('synthetic close failure') })
  assert.equal((await closeFailure.queries.searchContent('keyword', filters)).mode, 'postgres')
  assert.ok(closeFailure.warnings.some(args => args.at(-1).includes('TTL will reclaim it')))
})

test('a definite Elasticsearch request rejection stays an error while its unissued PIT is closed', async () => {
  const rejection = new ElasticsearchError(400, { error: { type: 'parsing_exception' } })
  const f = fixture({ searchResponse: rejection })
  await assert.rejects(f.queries.searchContent('keyword', filters), error => error === rejection)
  assert.equal(f.pgCalls.length, 0)
  assert.deepEqual(closedPits(f.calls), ['opened-pit'])
})
