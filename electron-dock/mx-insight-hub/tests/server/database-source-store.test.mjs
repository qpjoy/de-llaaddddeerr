import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

test('PostgresStore persists direct source connections, scheduling, and import evidence', async () => {
  const calls = []
  const sourceId = '22222222-2222-4222-8222-222222222222'
  const cursorStart = { cursor: '10', lastId: '9' }
  const cursorEnd = { cursor: '20', lastId: '19' }
  const connection = {
    host: 'database.internal', port: 5432, database: 'night_all', username: 'mx_data',
    password: 'plain-password', sslMode: 'disable', schema: 'public', table: 'events',
  }
  const sourceRow = {
    id: sourceId,
    source_key: 'warehouse-events',
    display_name: 'Warehouse events',
    source_kind: 'database',
    dataset_id: 'warehouse.events.v1',
    platform: 'external',
    object_type: 'event',
    status: 'paused',
    connection,
    sync_interval_seconds: 300,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
  }
  const runRow = {
    id: '33333333-3333-4333-8333-333333333333',
    source_id: sourceId,
    mapping_version: 2,
    input_name: 'database:warehouse-events',
    input_bytes: null,
    status: 'succeeded',
    row_count: 12,
    ingested_count: 12,
    rejected_count: 0,
    changed_count: 4,
    deleted_count: 2,
    cursor_start: cursorStart,
    cursor_end: cursorEnd,
    batch_count: 3,
    trigger: 'schedule',
    last_error: null,
    started_at: '2026-08-10T00:00:00.000Z',
    finished_at: '2026-08-10T00:01:00.000Z',
  }
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      if (/INSERT INTO catalog\.external_sources/.test(sql)) return { rows: [sourceRow] }
      if (/UPDATE catalog\.external_sources/.test(sql)) return { rows: [{ ...sourceRow, sync_interval_seconds: null }] }
      if (/INSERT INTO ingest\.import_runs/.test(sql)) return { rows: [{ id: runRow.id }] }
      if (/UPDATE ingest\.import_runs/.test(sql)) return { rows: [] }
      if (/FROM ingest\.import_runs r/.test(sql)) return { rows: [runRow] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  })

  const source = await store.createExternalSource({
    sourceKey: sourceRow.source_key,
    displayName: sourceRow.display_name,
    sourceKind: sourceRow.source_kind,
    datasetId: sourceRow.dataset_id,
    platform: sourceRow.platform,
    objectType: sourceRow.object_type,
    status: sourceRow.status,
    connection,
    syncIntervalSeconds: 300,
  })
  assert.deepEqual(source.connection, connection)
  assert.equal(source.connection.password, 'plain-password')
  assert.equal(source.syncIntervalSeconds, 300)
  assert.doesNotMatch(calls[0].sql, /source_providers|provider_id/i)
  assert.deepEqual(calls[0].values.slice(-2), [connection, 300])

  const disabled = await store.updateExternalSource(sourceRow.source_key, { syncIntervalSeconds: null })
  assert.equal(disabled.syncIntervalSeconds, null)
  assert.deepEqual(calls[1].values.slice(-2), [true, null])

  await store.startImportRun({
    sourceId, mappingVersion: 2, inputSha256: null,
    inputName: runRow.input_name, inputBytes: null, cursorStart,
  })
  assert.deepEqual(calls[2].values.at(-2), cursorStart)
  assert.equal(calls[2].values.at(-1), 'manual')
  await store.finishImportRun(runRow.id, {
    status: 'succeeded', rowCount: 12, rejectedCount: 0,
    changedCount: 4, deletedCount: 2, cursorEnd, error: null,
  })
  assert.deepEqual(calls[3].values.slice(4, 7), [4, 2, cursorEnd])

  const [run] = await store.listImportRuns(sourceId)
  assert.equal(run.changedCount, 4)
  assert.equal(run.deletedCount, 2)
  assert.equal(run.batchCount, 3)
  assert.equal(run.trigger, 'schedule')
  assert.deepEqual(run.cursorStart, cursorStart)
  assert.deepEqual(run.cursorEnd, cursorEnd)
})

test('PostgresStore atomically resumes a running database import by its stable run key', async () => {
  let captured
  const store = new PostgresStore({
    async query(sql, values) {
      captured = { sql, values }
      return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] }
    },
  })
  const runKey = 'a'.repeat(64)
  const run = await store.startImportRun({
    sourceId: '22222222-2222-4222-8222-222222222222',
    mappingVersion: 2,
    inputSha256: null,
    inputName: 'database:warehouse-events',
    inputBytes: null,
    cursorStart: { cursor: '10', lastId: '9' },
    trigger: 'schedule',
    runKey,
  })
  assert.equal(run.id, '33333333-3333-4333-8333-333333333333')
  assert.equal(captured.values.at(-1), runKey)
  assert.match(captured.sql, /ON CONFLICT \(source_id, run_key\)/)
  assert.match(captured.sql, /status = 'running'/)
})

test('PostgresStore uses a session advisory lock for source pull and reset operations', async () => {
  const queries = []
  let released = false
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
      return { rows: [{ pg_advisory_unlock: true }] }
    },
    release() { released = true },
  }
  const store = new PostgresStore({ connect: async () => client })
  assert.equal(await store.withExternalSourceLock('warehouse-events', async () => 'done'), 'done')
  assert.equal(queries.length, 2)
  assert.match(queries[0].sql, /pg_try_advisory_lock/)
  assert.match(queries[1].sql, /pg_advisory_unlock/)
  assert.equal(queries[0].values[0], 'mx-insight-hub:external-source:warehouse-events')
  assert.equal(released, true)

  const busyStore = new PostgresStore({
    connect: async () => ({
      async query() { return { rows: [{ locked: false }] } },
      release() {},
    }),
  })
  await assert.rejects(
    () => busyStore.withExternalSourceLock('warehouse-events', async () => 'never'),
    (error) => error?.status === 409 && error?.code === 'source_busy',
  )
})
