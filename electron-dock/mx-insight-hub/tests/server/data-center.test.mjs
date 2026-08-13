import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const ADMIN_TOKEN = 'data-center-admin-token'
const quiet = { error() {} }

async function withApp({ store, listenerMode = 'combined', identity = null }, operation) {
  const app = createApp({
    service: {},
    store,
    adapter: {},
    adminToken: ADMIN_TOKEN,
    listenerMode,
    identity,
    logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    await operation(baseUrl)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('Data Center route is admin-token-only, validates filters, and stays off the public listener', async () => {
  const calls = []
  const store = {
    async dataCenter(filters) {
      calls.push(filters)
      return {
        stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
        datasets: [],
        records: [],
        pageSize: filters.pageSize,
      }
    },
  }

  await withApp({ store }, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/internal/v1/admin/data-center`)
    assert.equal(unauthorized.status, 401)

    const launcherOnly = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { authorization: 'Bearer launcher-session' },
    })
    assert.equal(launcherOnly.status, 401)

    const response = await fetch(
      `${baseUrl}/internal/v1/admin/data-center?datasetId=%20telegram.messages.v1%20&platform=telegram&objectType=message&pageSize=25`,
      { headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN } },
    )
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, {
      stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
      datasets: [],
      records: [],
      pageSize: 25,
    })
    assert.deepEqual(calls, [{
      datasetId: 'telegram.messages.v1',
      platform: 'telegram',
      objectType: 'message',
      pageSize: 25,
    }])

    const defaults = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(defaults.status, 200)
    assert.equal((await defaults.json()).data.pageSize, 50)
    assert.deepEqual(calls[1], { datasetId: null, platform: null, objectType: null, pageSize: 50 })

    for (const pageSize of ['0', '101', '1.5', 'not-a-number']) {
      const invalid = await fetch(`${baseUrl}/internal/v1/admin/data-center?pageSize=${pageSize}`, {
        headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      })
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).error.code, 'invalid_page_size')
    }
    assert.equal(calls.length, 2)
  })

  const identity = {
    enabled: true,
    async resolve() {
      return { kind: 'launcher-user', platformAdmin: true, capabilities: [], memberships: [] }
    },
  }
  await withApp({ store, identity }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { authorization: 'Bearer launcher-session' },
    })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error.code, 'admin_token_required')
  })

  await withApp({ store, listenerMode: 'public' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/internal/v1/admin/data-center`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(response.status, 404)
  })
})

test('MemoryStore exposes an empty authoritative catalog', async () => {
  const store = new MemoryStore()
  assert.deepEqual(await store.dataCenter({ pageSize: 17 }), {
    stats: { datasetCount: 0, activeRecordCount: 0, revisionCount: 0, deletedRecordCount: 0 },
    datasets: [],
    records: [],
    pageSize: 17,
  })
  const source = await store.createExternalSource({
    sourceKey: 'local-upload',
    displayName: 'Local upload',
    sourceKind: 'file',
    datasetId: 'external.local-upload.v1',
    platform: 'external',
    objectType: 'record',
    connection: { fileMode: 'upload' },
  })
  assert.deepEqual(await store.getExternalSource('local-upload'), source)
  assert.deepEqual(await store.listExternalSources(), [source])
  assert.deepEqual(await store.dataCenterRecords(), { items: [], hasMore: false, nextCursor: null })
})

test('Data Center record browser pages PostgreSQL and searches the ES projection', async () => {
  const browseCalls = []
  const searchCalls = []
  const store = {
    async dataCenterRecords(filters) {
      browseCalls.push(filters)
      return {
        items: [{ id: 'record-1', datasetId: 'external.canyie.v1', body: '本地正文' }],
        hasMore: true,
        nextCursor: { sortTime: '2026-08-12T01:02:03.000Z', id: '11111111-1111-4111-8111-111111111111' },
      }
    },
    async dataCenterRecordsByIds(ids) {
      assert.deepEqual(ids, ['record-2'])
      return [{
        id: 'record-2', body: '完整、未脱敏正文',
        stableFields: { source: { sourceKey: 'private-source' } },
        extensions: { private_note: 'admin-visible' },
      }]
    },
  }
  const search = {
    queries: {
      async searchContent(query, options) {
        searchCalls.push({ query, options })
        return {
          mode: 'elasticsearch',
          items: [{ id: 'record-2', body: '命中的正文', highlight: { body: ['<em>命中</em>的正文'] } }],
          hasMore: true,
          nextCursor: { mode: 'elasticsearch', pitId: 'pit-1', searchAfter: [1, 'record-2'] },
        }
      },
    },
  }
  const app = createApp({
    service: {}, store, adapter: {}, search,
    adminToken: ADMIN_TOKEN, listenerMode: 'combined', logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
  try {
    const first = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=external.canyie.v1&pageSize=25`,
      { headers },
    )
    assert.equal(first.status, 200)
    const firstBody = (await first.json()).data
    assert.equal(firstBody.mode, 'postgres')
    assert.equal(firstBody.pageInfo.hasMore, true)
    assert.equal(typeof firstBody.pageInfo.nextCursor, 'string')
    assert.deepEqual(browseCalls[0], {
      datasetId: 'external.canyie.v1', platform: null, objectType: null, pageSize: 25, cursor: null,
    })

    const second = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=external.canyie.v1&pageSize=25&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`,
      { headers },
    )
    assert.equal(second.status, 200)
    assert.deepEqual(browseCalls[1].cursor, {
      sortTime: '2026-08-12T01:02:03.000Z', id: '11111111-1111-4111-8111-111111111111',
    })

    const searched = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?q=%E5%91%BD%E4%B8%AD&platform=twitter&pageSize=10`,
      { headers },
    )
    assert.equal(searched.status, 200)
    const searchBody = (await searched.json()).data
    assert.equal(searchBody.mode, 'elasticsearch')
    assert.equal(searchBody.items[0].body, '完整、未脱敏正文')
    assert.equal(searchBody.items[0].extensions.private_note, 'admin-visible')
    assert.deepEqual(searchBody.items[0].highlight, { body: ['<em>命中</em>的正文'] })
    assert.deepEqual(searchCalls[0], {
      query: '命中',
      options: {
        datasetId: null, platform: 'twitter', objectType: null, size: 10, cursor: null,
      },
    })

    const mismatched = await fetch(
      `${baseUrl}/internal/v1/admin/data-center/records?datasetId=other&pageSize=25&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor)}`,
      { headers },
    )
    assert.equal(mismatched.status, 400)
    assert.equal((await mismatched.json()).error.code, 'invalid_cursor')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('PostgresStore aggregates canonical truth and returns only safe record fields', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      if (sql.includes('GROUP BY dataset_id')) {
        return {
          rows: [{
            dataset_id: 'telegram.messages.v1',
            platforms: ['telegram'],
            object_types: ['message'],
            content_types: ['text/plain'],
            active_record_count: '4',
            deleted_record_count: '2',
            revision_count: '9',
            last_collected_at: '2026-08-12T01:02:03.000Z',
            last_event_at: '2026-08-12T01:00:00.000Z',
          }],
        }
      }
      if (sql.includes('FROM core.canonical_records')) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            dataset_id: 'telegram.messages.v1',
            platform: 'telegram',
            object_type: 'message',
            content_type: 'text/plain',
            external_id: '-1001:42',
            title: 'Safe title',
            current_revision: 3,
            event_time: '2026-08-12T01:00:00.000Z',
            collected_at: '2026-08-12T01:02:03.000Z',
            deleted_at: null,
            body: 'must not escape',
            stable_fields: { credential: 'must not escape' },
            extensions: { raw: 'must not escape' },
          }],
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  })

  const result = await store.dataCenter({
    datasetId: 'telegram.messages.v1',
    platform: 'telegram',
    objectType: 'message',
    pageSize: 25,
  })

  assert.deepEqual(result, {
    stats: { datasetCount: 1, activeRecordCount: 4, revisionCount: 9, deletedRecordCount: 2 },
    datasets: [{
      datasetId: 'telegram.messages.v1',
      platforms: ['telegram'],
      objectTypes: ['message'],
      contentTypes: ['text/plain'],
      activeRecordCount: 4,
      deletedRecordCount: 2,
      revisionCount: 9,
      lastCollectedAt: '2026-08-12T01:02:03.000Z',
      lastEventAt: '2026-08-12T01:00:00.000Z',
    }],
    records: [{
      id: '11111111-1111-4111-8111-111111111111',
      datasetId: 'telegram.messages.v1',
      platform: 'telegram',
      objectType: 'message',
      contentType: 'text/plain',
      externalId: '-1001:42',
      title: 'Safe title',
      currentRevision: 3,
      eventTime: '2026-08-12T01:00:00.000Z',
      collectedAt: '2026-08-12T01:02:03.000Z',
      deletedAt: null,
    }],
    pageSize: 25,
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].values, ['telegram.messages.v1', 'telegram', 'message'])
  assert.deepEqual(calls[1].values, ['telegram.messages.v1', 'telegram', 'message', 25])
  assert.match(calls[1].sql, /LIMIT \$4/)
  assert.doesNotMatch(calls.map((call) => call.sql).join('\n'), /\bbody\b|raw_payload|extensions|stable_fields|credential/i)
  assert.doesNotMatch(JSON.stringify(result.records), /must not escape/)
})

test('PostgresStore keyset-pages full canonical records for the Admin browser', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      return {
        rows: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            dataset_id: 'external.canyie.v1', platform: 'twitter', object_type: 'post',
            content_type: null, external_id: '1962355370623652093', url: 'https://x.com/canyie/status/1',
            title: null, body: '正文一', author_external_id: '1192067927777742848', author_name: null,
            current_revision: 1, event_time: '2025-09-01T03:22:33.000Z',
            collected_at: '2025-11-21T03:14:24.000Z', deleted_at: null,
            sort_time: '2025-09-01T03:22:33.000Z',
          },
          {
            id: '11111111-1111-4111-8111-111111111111',
            dataset_id: 'external.canyie.v1', platform: 'twitter', object_type: 'post',
            content_type: null, external_id: 'older', url: null, title: null, body: '正文二',
            author_external_id: null, author_name: null, current_revision: 1,
            event_time: '2025-08-01T00:00:00.000Z', collected_at: null, deleted_at: null,
            sort_time: '2025-08-01T00:00:00.000Z',
          },
        ],
      }
    },
  })
  const result = await store.dataCenterRecords({
    datasetId: 'external.canyie.v1', platform: 'twitter', objectType: 'post', pageSize: 1,
    cursor: { sortTime: '2026-01-01T00:00:00.000Z', id: '33333333-3333-4333-8333-333333333333' },
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].body, '正文一')
  assert.equal(result.items[0].externalId, '1962355370623652093')
  assert.equal(result.hasMore, true)
  assert.deepEqual(result.nextCursor, {
    sortTime: '2025-09-01T03:22:33.000Z', id: '22222222-2222-4222-8222-222222222222',
  })
  assert.deepEqual(calls[0].values, [
    'external.canyie.v1', 'twitter', 'post',
    '2026-01-01T00:00:00.000Z', '33333333-3333-4333-8333-333333333333', 2,
  ])
  assert.match(calls[0].sql, /^WITH page AS MATERIALIZED/)
  assert.match(calls[0].sql, /JOIN core\.canonical_records r ON r\.id = page\.id/)
  assert.match(calls[0].sql, /ORDER BY coalesce\(r\.event_time, r\.collected_at, r\.last_seen_at, r\.first_seen_at\) DESC, r\.id DESC/)
})
