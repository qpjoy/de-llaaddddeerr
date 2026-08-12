import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

test('PostgresStore usage transitions guard terminal request states', async () => {
  const statements = []
  const requestRow = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'reserved',
    reserved_at: '2026-08-10T00:00:00.000Z',
    lease_expires_at: '2026-08-10T00:02:00.000Z',
    created_at: '2026-08-10T00:00:00.000Z',
  }
  const store = new PostgresStore({
    query: async (sql) => {
      statements.push(sql.replace(/\s+/g, ' ').trim())
      return { rows: [requestRow] }
    },
  })

  await store.commitRequest(requestRow.id, {
    responseStatus: 200, responseBody: null, unitsActual: 1, upstreamLatencyMs: 1,
  })
  await store.releaseRequest(requestRow.id, 'failed')
  await store.markRequestUnknown(requestRow.id, 'ambiguous')

  assert.match(statements[0], /WHERE id = \$1 AND status = 'reserved'/)
  assert.match(statements[1], /WHERE id = \$1 AND status = 'reserved'/)
  assert.match(statements[2], /WHERE id = \$1 AND status IN \('reserved', 'committed'\)/)
})

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

test('PostgresStore scopes direct-file duplicate lookup and inserts to the interpretation key', async () => {
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/UPDATE ingest\.import_runs/.test(sql)) return { rows: [], rowCount: 1 }
      if (/^\s*SELECT id, started_at FROM ingest\.import_runs/.test(sql)) return { rows: [] }
      return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] }
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const interpretationKey = 'c'.repeat(64)

  await store.startImportRun({
    sourceId: '22222222-2222-4222-8222-222222222222',
    mappingVersion: 3,
    inputSha256: 'a'.repeat(64),
    interpretationKey,
    inputName: 'records.csv',
    inputBytes: 42,
  })

  assert.deepEqual(
    calls.map(({ sql }) => sql.trim().split(/\s+/)[0]),
    ['BEGIN', 'UPDATE', 'SELECT', 'INSERT', 'COMMIT'],
  )
  assert.match(calls[1].sql, /input_sha256 IS NOT NULL/)
  assert.match(calls[1].sql, /last_error = 'superseded_by_new_file_import'/)
  assert.deepEqual(calls[1].values, ['22222222-2222-4222-8222-222222222222'])
  assert.match(calls[2].sql, /interpretation_key = \$3/)
  assert.deepEqual(calls[2].values, [
    '22222222-2222-4222-8222-222222222222', 'a'.repeat(64), interpretationKey,
  ])
  assert.match(calls[3].sql, /interpretation_key/)
  assert.equal(calls[3].values.at(-3), interpretationKey)
})

test('PostgresStore fences stale file runs before returning a NULL-key legacy duplicate', async () => {
  const calls = []
  let staleStatus = 'running'
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/UPDATE ingest\.import_runs/.test(sql)) {
        staleStatus = 'failed'
        return { rows: [], rowCount: 1 }
      }
      if (/SELECT id, started_at FROM ingest\.import_runs/.test(sql)) {
        assert.equal(staleStatus, 'failed')
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })

  const run = await store.startImportRun({
    sourceId: '22222222-2222-4222-8222-222222222222',
    mappingVersion: 2,
    inputSha256: 'b'.repeat(64),
    inputName: 'legacy.csv',
    inputBytes: 7,
  })

  assert.deepEqual(run, { duplicateOf: '55555555-5555-4555-8555-555555555555', id: null })
  assert.equal(staleStatus, 'failed')
  assert.deepEqual(
    calls.map(({ sql }) => sql.trim().split(/\s+/)[0]),
    ['BEGIN', 'UPDATE', 'SELECT', 'COMMIT'],
  )
  assert.match(calls[2].sql, /interpretation_key IS NULL/)
  assert.deepEqual(calls[2].values, [
    '22222222-2222-4222-8222-222222222222', 'b'.repeat(64),
  ])
  assert.equal(calls.some(({ sql }) => /INSERT INTO ingest\.import_runs/.test(sql)), false)
})

test('PostgresStore fences pre-012 file runs without relying on their legacy manual trigger', async () => {
  const historical = [{ id: 'stale-run', inputSha256: 'f'.repeat(64), trigger: 'manual', status: 'running' }]
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/UPDATE ingest\.import_runs/.test(sql)) {
        for (const run of historical) {
          if (run.inputSha256 && run.status === 'running') run.status = 'failed'
        }
        return { rows: [], rowCount: 1 }
      }
      if (/SELECT id, started_at FROM ingest\.import_runs/.test(sql)) {
        return { rows: historical.filter((row) => row.status === 'succeeded') }
      }
      return { rows: [{ id: 'retry-run' }] }
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })

  const run = await store.startImportRun({
    sourceId: '22222222-2222-4222-8222-222222222222',
    mappingVersion: 3,
    inputSha256: 'd'.repeat(64),
    interpretationKey: 'e'.repeat(64),
    inputName: 'records.csv',
    inputBytes: 42,
  })

  assert.deepEqual(run, { id: 'retry-run', duplicateOf: null })
  assert.equal(historical[0].status, 'failed')
  assert.match(calls[1].sql, /input_sha256 IS NOT NULL/)
  assert.doesNotMatch(calls[1].sql, /trigger = 'file'/)
  assert.match(calls[2].sql, /status = 'succeeded'/)
  assert.doesNotMatch(calls[2].sql, /status IN \('succeeded', 'running'\)/)
  assert.equal(calls.filter(({ sql }) => /INSERT INTO ingest\.import_runs/.test(sql)).length, 1)
})

test('migration 019 splits interpreted successes while retaining legacy NULL-key uniqueness', async () => {
  const migration = await readFile(
    new URL('../../migrations/019_direct_file_interpretation_idempotency.sql', import.meta.url),
    'utf8',
  )
  assert.match(migration, /ADD COLUMN IF NOT EXISTS interpretation_key char\(64\)/)
  assert.match(migration, /interpretation_key ~ '\^\[0-9a-f\]\{64\}\$'/)
  assert.match(migration, /\(source_id, input_sha256, interpretation_key\)/)
  assert.match(migration, /interpretation_key IS NOT NULL/)
  assert.match(migration, /import_runs_legacy_input_idx/)
  assert.match(migration, /interpretation_key IS NULL/)
  assert.match(migration, /DROP INDEX IF EXISTS ingest\.import_runs_input_idx/)
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
  assert.equal(await store.withExternalSourceLock('warehouse-events', async (_assertOwned, sessionClient) => {
    assert.equal(sessionClient, client)
    return 'done'
  }), 'done')
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

test('a disconnected source-lock session is destroyed and a later caller can retry', async () => {
  let endHandler
  let lostReleaseError
  const lostClient = {
    once(event, handler) { if (event === 'end') endHandler = handler },
    off() {},
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
      if (/pg_advisory_unlock/.test(sql)) throw new Error('lock session disconnected')
      return { rows: [] }
    },
    release(error) { lostReleaseError = error },
  }
  const retryClient = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] }
      return { rows: [{ pg_advisory_unlock: true }] }
    },
    release() {},
  }
  const clients = [lostClient, retryClient]
  const store = new PostgresStore({ connect: async () => clients.shift() })

  await assert.rejects(
    () => store.withExternalSourceLock('files', async (assertOwned) => {
      endHandler()
      await assertOwned()
    }),
    (error) => error?.code === 'source_lock_lost',
  )
  assert.match(lostReleaseError.message, /lock session lost/)
  assert.equal(await store.withExternalSourceLock('files', async () => 'retried'), 'retried')
})

test('file-import writes never fall back to the pool after their held session fails', async () => {
  let poolUses = 0
  let releases = 0
  const disconnected = new Error('held source-lock session disconnected')
  const sessionClient = {
    async query() { throw disconnected },
    release() { releases += 1 },
  }
  const store = new PostgresStore({
    async query() {
      poolUses += 1
      throw new Error('must not use pool query')
    },
    async connect() {
      poolUses += 1
      throw new Error('must not acquire replacement client')
    },
  })
  const sourceId = '22222222-2222-4222-8222-222222222222'

  await assert.rejects(
    () => store.startImportRun({
      sourceId, mappingVersion: 2, inputSha256: 'a'.repeat(64),
      interpretationKey: 'b'.repeat(64), inputName: 'records.csv', inputBytes: 10,
      sessionClient,
    }),
    (error) => error === disconnected,
  )
  await assert.rejects(
    () => store.ingestExternalRecords({
      datasetId: 'dataset', platform: 'external', connectorId: 'external:files',
      sourceId, importRunId: '33333333-3333-4333-8333-333333333333', records: [{}],
      sessionClient,
    }),
    (error) => error === disconnected,
  )
  await assert.rejects(
    () => store.recordRejectedRows(
      '33333333-3333-4333-8333-333333333333',
      [{ rowIndex: 1, reason: 'missing id', raw: {} }],
      { sessionClient },
    ),
    (error) => error === disconnected,
  )
  await assert.rejects(
    () => store.finishImportRun('33333333-3333-4333-8333-333333333333', {
      status: 'failed', rowCount: 1, rejectedCount: 1, error: 'session lost',
    }, { sessionClient }),
    (error) => error === disconnected,
  )

  assert.equal(poolUses, 0)
  assert.equal(releases, 0)
})

test('PostgresStore updates a built-in pipeline source set in one transaction', async () => {
  const calls = []
  const rows = {
    'telegram-monitor-chats': {
      id: 'source-chats', source_key: 'telegram-monitor-chats', display_name: 'Chats',
      source_kind: 'database', dataset_id: 'telegram.monitor.chats.v1', platform: 'telegram',
      object_type: 'chat', status: 'paused', connection: {}, sync_interval_seconds: 300,
    },
    'telegram-monitor-messages': {
      id: 'source-messages', source_key: 'telegram-monitor-messages', display_name: 'Messages',
      source_kind: 'database', dataset_id: 'telegram.monitor.messages.v1', platform: 'telegram',
      object_type: 'message', status: 'paused', connection: {}, sync_interval_seconds: 300,
    },
  }
  let released = false
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      const row = rows[values[0]]
      return { rows: row ? [{ ...row, status: values[1] ?? row.status }] : [] }
    },
    release() { released = true },
  }
  const store = new PostgresStore({ connect: async () => client })
  const updated = await store.updateExternalSourcesBatch([
    { sourceKey: 'telegram-monitor-chats', status: 'active' },
    { sourceKey: 'telegram-monitor-messages', status: 'active' },
  ])
  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), ['BEGIN', 'UPDATE', 'UPDATE', 'COMMIT'])
  assert.deepEqual(updated.map((source) => source.status), ['active', 'active'])
  assert.equal(released, true)

  calls.length = 0
  await assert.rejects(
    () => store.updateExternalSourcesBatch([
      { sourceKey: 'telegram-monitor-chats', status: 'paused' },
      { sourceKey: 'missing', status: 'paused' },
    ]),
    (error) => error?.code === 'source_not_found',
  )
  assert.equal(calls.at(-1).sql, 'ROLLBACK')
})

test('PostgresStore approves built-in mappings in one transaction', async () => {
  const calls = []
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      return { rows: [{
        id: values[0], source_id: values[1], version: values[2],
        field_map: {}, origin: 'manual', approved_at: '2026-08-11T00:00:00.000Z',
        approved_by: values[3], created_at: '2026-08-10T00:00:00.000Z',
      }] }
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const approved = await store.approveSourceMappingsBatch({
    approvals: [
      { mappingId: 'mapping-chats', sourceId: 'source-chats', version: 2 },
      { mappingId: 'mapping-messages', sourceId: 'source-messages', version: 2 },
    ],
    approvedBy: 'admin-token',
  })
  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), ['BEGIN', 'UPDATE', 'UPDATE', 'COMMIT'])
  assert.deepEqual(approved.map((mapping) => [mapping.sourceId, mapping.version, mapping.approved]), [
    ['source-chats', 2, true],
    ['source-messages', 2, true],
  ])
})

test('PostgresStore activates mappings, both sources and writer attestation in one transaction', async () => {
  const calls = []
  const sourceRows = {
    'telegram-monitor-chats': {
      id: 'source-chats', source_key: 'telegram-monitor-chats', display_name: 'Chats',
      source_kind: 'database', dataset_id: 'telegram.monitor.chats.v1', platform: 'telegram',
      object_type: 'chat', status: 'active', connection: {}, sync_interval_seconds: 300,
    },
    'telegram-monitor-messages': {
      id: 'source-messages', source_key: 'telegram-monitor-messages', display_name: 'Messages',
      source_kind: 'database', dataset_id: 'telegram.monitor.messages.v1', platform: 'telegram',
      object_type: 'message', status: 'active', connection: {}, sync_interval_seconds: 300,
    },
  }
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
      if (/UPDATE catalog\.source_mappings/.test(sql)) return { rows: [{ id: values[0] }] }
      if (/INSERT INTO catalog\.pipeline_writer_contract_attestations/.test(sql)) {
        return { rows: [{
          id: values[0], pipeline_key: values[1], contract_version: values[2],
          contract_digest: values[3], contract_summary: values[4], attested_by: values[5],
          attested_at: '2026-08-11T00:00:00.000Z',
        }] }
      }
      if (/UPDATE catalog\.external_sources/.test(sql)) return { rows: [sourceRows[values[0]]] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.activateExternalSourcesWithAttestation({
    sourceKeys: ['telegram-monitor-chats', 'telegram-monitor-messages'],
    pipelineKey: 'telegram-monitor',
    contractVersion: 'telegram-monitor.writer.v1',
    contractDigest: 'a'.repeat(64),
    contractSummary: { ordering: 'strict' },
    attestedBy: 'admin-token',
    approvals: [
      { mappingId: 'mapping-chats', sourceId: 'source-chats', version: 2 },
      { mappingId: 'mapping-messages', sourceId: 'source-messages', version: 2 },
    ],
  })
  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), [
    'BEGIN', 'UPDATE', 'UPDATE', 'INSERT', 'UPDATE', 'UPDATE', 'COMMIT',
  ])
  assert.deepEqual(result.sources.map((source) => source.status), ['active', 'active'])
  assert.equal(result.attestation.attestedBy, 'admin-token')
  assert.equal(result.attestation.contractDigest, 'a'.repeat(64))
})
