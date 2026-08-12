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
