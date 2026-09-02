import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  DatabaseSourcePuller,
  validateDatabaseLocator,
  validateDatabaseTransport,
} from '../../server/ingest/external/database-source.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const PROFILE_ID = '11111111-1111-4111-8111-111111111111'
const SOURCE_ID = '22222222-2222-4222-8222-222222222222'
const CREATED_AT = '2026-09-01T00:00:00.000Z'
const TRANSPORT = Object.freeze({
  host: 'database.internal',
  port: 5432,
  database: 'night_all',
  username: 'mx_reader',
  password: 'plain-password',
  sslMode: 'disable',
})
const LOCATOR = Object.freeze({
  schema: 'public',
  table: 'events',
  cursorColumn: 'updated_at',
  idColumn: 'id',
})

function profileRow(overrides = {}) {
  return {
    id: PROFILE_ID,
    connection_key: 'night-all-primary',
    display_name: 'Night-All primary',
    engine: 'postgresql',
    connection: TRANSPORT,
    revision: 1,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  }
}

function sourceRow(overrides = {}) {
  return {
    id: SOURCE_ID,
    source_key: 'warehouse-events',
    display_name: 'Warehouse events',
    source_kind: 'database',
    dataset_id: 'warehouse.events.v1',
    platform: 'external',
    object_type: 'event',
    status: 'paused',
    connection: LOCATOR,
    database_connection_id: PROFILE_ID,
    sync_interval_seconds: 300,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  }
}

test('migration 048 adds shared database connections without removing inline source connections', async () => {
  const sql = await readFile(new URL('../../migrations/048_database_connections.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS catalog\.database_connections/)
  assert.match(sql, /connection_key text NOT NULL UNIQUE/)
  assert.match(sql, /engine text NOT NULL DEFAULT 'postgresql'/)
  assert.match(sql, /connection jsonb NOT NULL DEFAULT '\{\}'::jsonb/)
  assert.match(sql, /revision integer NOT NULL DEFAULT 1/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS database_connection_id uuid/)
  assert.match(sql, /REFERENCES catalog\.database_connections\(id\) ON DELETE RESTRICT/)
  assert.match(sql, /external_sources_database_connection_idx/)
  assert.doesNotMatch(sql, /DROP COLUMN|DROP TABLE|UPDATE catalog\.external_sources/i)
})

test('MemoryStore manages profiles, references, revisions, and explicit source detach', async () => {
  const store = new MemoryStore()
  const profile = await store.createDatabaseConnection({
    key: 'night-all-primary',
    displayName: 'Night-All primary',
    connection: TRANSPORT,
  })
  assert.equal(profile.revision, 1)
  assert.deepEqual((await store.getDatabaseConnection(profile.id)).connection, TRANSPORT)
  assert.equal((await store.listDatabaseConnections()).length, 1)

  const source = await store.createExternalSource({
    sourceKey: 'warehouse-events',
    displayName: 'Warehouse events',
    sourceKind: 'database',
    datasetId: 'warehouse.events.v1',
    platform: 'external',
    objectType: 'event',
    status: 'paused',
    connection: LOCATOR,
    databaseConnectionId: profile.id,
    syncIntervalSeconds: 300,
  })
  assert.equal(source.databaseConnectionId, profile.id)
  assert.deepEqual((await store.listDatabaseConnectionReferences(profile.id)).map((item) => item.sourceKey), [
    'warehouse-events',
  ])

  const updated = await store.updateDatabaseConnection(profile.id, { displayName: 'Primary warehouse' })
  assert.equal(updated.displayName, 'Primary warehouse')
  assert.equal(updated.revision, 2)
  await assert.rejects(
    () => store.deleteDatabaseConnection(profile.id),
    (error) => error?.code === 'database_connection_in_use'
      && error.details?.references?.[0]?.sourceKey === 'warehouse-events',
  )

  const detached = await store.updateExternalSource('warehouse-events', {
    databaseConnectionId: null,
    connection: { ...TRANSPORT, ...LOCATOR },
  })
  assert.equal(detached.databaseConnectionId, null)
  assert.deepEqual(detached.connection, { ...TRANSPORT, ...LOCATOR })
  assert.deepEqual(await store.listDatabaseConnectionReferences(profile.id), [])
  assert.equal((await store.deleteDatabaseConnection(profile.id)).id, profile.id)
  assert.equal(await store.getDatabaseConnection(profile.id), null)
})

test('MemoryStore batch source updates preserve omitted profile ids and apply explicit null atomically', async () => {
  const store = new MemoryStore()
  const profile = await store.createDatabaseConnection({
    key: 'night-all-primary', displayName: 'Night-All primary', connection: TRANSPORT,
  })
  for (const sourceKey of ['events-a', 'events-b']) {
    await store.createExternalSource({
      sourceKey,
      displayName: sourceKey,
      sourceKind: 'database',
      datasetId: `warehouse.${sourceKey}.v1`,
      platform: 'external',
      connection: LOCATOR,
      databaseConnectionId: profile.id,
    })
  }
  const preserved = await store.updateExternalSourcesBatch([
    { sourceKey: 'events-a', status: 'paused' },
  ])
  assert.equal(preserved[0].databaseConnectionId, profile.id)
  const detached = await store.updateExternalSourcesBatch([
    { sourceKey: 'events-a', databaseConnectionId: null },
    { sourceKey: 'events-b', databaseConnectionId: null },
  ])
  assert.deepEqual(detached.map((source) => source.databaseConnectionId), [null, null])

  await assert.rejects(
    () => store.updateExternalSourcesBatch([
      { sourceKey: 'events-a', status: 'active' },
      { sourceKey: 'missing', status: 'active' },
    ]),
    (error) => error?.code === 'source_not_found',
  )
  assert.equal((await store.getExternalSource('events-a')).status, 'paused')
})

test('MemoryStore database profile revision check allows exactly one concurrent writer', async () => {
  const store = new MemoryStore()
  const profile = await store.createDatabaseConnection({
    key: 'night-all-primary', displayName: 'Night-All primary', connection: TRANSPORT,
  })
  const results = await Promise.allSettled([
    store.updateDatabaseConnection(profile.id, { displayName: 'Writer A' }, { expectedRevision: 1 }),
    store.updateDatabaseConnection(profile.id, { displayName: 'Writer B' }, { expectedRevision: 1 }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'database_connection_revision_conflict')
  assert.deepEqual(rejected.reason.details, { expectedRevision: 1, currentRevision: 2 })
})

test('PostgresStore maps database profiles and propagates source profile ids including explicit null', async () => {
  const calls = []
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (/INSERT INTO catalog\.database_connections/.test(sql)) return { rows: [profileRow()] }
      if (/UPDATE catalog\.database_connections/.test(sql)) {
        return { rows: [profileRow({ display_name: values[2], revision: 2 })] }
      }
      if (/FROM catalog\.database_connections WHERE id/.test(sql)) return { rows: [profileRow()] }
      if (/FROM catalog\.database_connections\s+ORDER BY/.test(sql)) return { rows: [profileRow()] }
      if (/FROM catalog\.external_sources\s+WHERE database_connection_id/.test(sql)) {
        return { rows: [sourceRow()] }
      }
      if (/INSERT INTO catalog\.external_sources/.test(sql)) return { rows: [sourceRow()] }
      if (/UPDATE catalog\.external_sources/.test(sql)) {
        return { rows: [sourceRow({ database_connection_id: values[4] })] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
  const store = new PostgresStore(pool)

  const created = await store.createDatabaseConnection({
    key: 'night-all-primary', displayName: 'Night-All primary', connection: TRANSPORT,
  })
  assert.equal(created.key, 'night-all-primary')
  assert.deepEqual(created.connection, TRANSPORT)
  assert.equal((await store.getDatabaseConnection(PROFILE_ID)).id, PROFILE_ID)
  assert.equal((await store.listDatabaseConnections())[0].revision, 1)
  assert.equal((await store.updateDatabaseConnection(PROFILE_ID, { displayName: 'Renamed' })).revision, 2)
  assert.equal((await store.listDatabaseConnectionReferences(PROFILE_ID))[0].databaseConnectionId, PROFILE_ID)

  const source = await store.createExternalSource({
    sourceKey: 'warehouse-events',
    displayName: 'Warehouse events',
    sourceKind: 'database',
    datasetId: 'warehouse.events.v1',
    platform: 'external',
    objectType: 'event',
    status: 'paused',
    connection: LOCATOR,
    databaseConnectionId: PROFILE_ID,
    syncIntervalSeconds: 300,
  })
  assert.equal(source.databaseConnectionId, PROFILE_ID)
  const sourceInsert = calls.find(({ sql }) => /INSERT INTO catalog\.external_sources/.test(sql))
  assert.equal(sourceInsert.values[8], PROFILE_ID)
  assert.deepEqual(sourceInsert.values.slice(-2), [LOCATOR, 300])

  const detached = await store.updateExternalSource('warehouse-events', { databaseConnectionId: null })
  assert.equal(detached.databaseConnectionId, null)
  const sourceUpdate = calls.find(({ sql }) => /UPDATE catalog\.external_sources/.test(sql))
  assert.deepEqual(sourceUpdate.values.slice(3, 5), [true, null])
})

test('PostgresStore deletes an unreferenced database profile under a transaction lock', async () => {
  const calls = []
  let released = false
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (/FROM catalog\.database_connections.*FOR UPDATE/.test(sql)) return { rows: [profileRow()] }
      if (/FROM catalog\.external_sources/.test(sql)) return { rows: [] }
      if (/DELETE FROM catalog\.database_connections/.test(sql)) return { rows: [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() { released = true },
  }
  const store = new PostgresStore({ connect: async () => client })
  const deleted = await store.deleteDatabaseConnection(PROFILE_ID)
  assert.equal(deleted.id, PROFILE_ID)
  assert.deepEqual(calls.map(({ sql }) => sql.trim().split(/\s+/)[0]), [
    'BEGIN', 'SELECT', 'SELECT', 'DELETE', 'COMMIT',
  ])
  assert.equal(released, true)
})

test('PostgresStore database profile update fences stale revisions atomically and distinguishes missing ids', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      if (/UPDATE catalog\.database_connections/.test(sql)) return { rows: [] }
      if (/SELECT revision FROM catalog\.database_connections/.test(sql)) {
        return { rows: values[0] === PROFILE_ID ? [{ revision: 4 }] : [] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  })
  await assert.rejects(
    () => store.updateDatabaseConnection(
      PROFILE_ID,
      { displayName: 'Stale writer' },
      { expectedRevision: 3 },
    ),
    (error) => error?.code === 'database_connection_revision_conflict'
      && error.details?.expectedRevision === 3
      && error.details?.currentRevision === 4,
  )
  assert.match(calls[0].sql, /revision = \$8/)
  assert.equal(calls[0].values[7], 3)

  await assert.rejects(
    () => store.updateDatabaseConnection(
      '33333333-3333-4333-8333-333333333333',
      { displayName: 'Missing' },
      { expectedRevision: 1 },
    ),
    (error) => error?.code === 'database_connection_not_found',
  )
})

test('DatabaseSourcePuller resolves shared transport plus source locator and preserves legacy inline sources', async () => {
  let profileReads = 0
  const profile = {
    id: PROFILE_ID,
    key: 'night-all-primary',
    displayName: 'Night-All primary',
    engine: 'postgresql',
    connection: TRANSPORT,
    revision: 3,
  }
  const puller = new DatabaseSourcePuller({
    store: {
      async getDatabaseConnection(id) {
        profileReads += 1
        return id === PROFILE_ID ? profile : null
      },
    },
  })

  const resolved = await puller.resolveConnectionCandidate({
    databaseConnectionId: PROFILE_ID,
    connection: LOCATOR,
  })
  assert.deepEqual(resolved.connection, { ...TRANSPORT, ...LOCATOR })
  assert.equal(resolved.databaseConnectionKey, 'night-all-primary')
  assert.equal(resolved.databaseConnectionRevision, 3)

  const inline = { ...TRANSPORT, ...LOCATOR }
  assert.deepEqual((await puller.resolveConnectionCandidate({ connection: inline })).connection, inline)
  assert.equal(profileReads, 1)

  await assert.rejects(
    () => puller.resolveConnectionCandidate({
      databaseConnectionId: PROFILE_ID,
      connection: { ...LOCATOR, host: TRANSPORT.host },
    }),
    (error) => error?.code === 'unsupported_database_locator_fields',
  )
  await assert.rejects(
    () => puller.resolveConnectionCandidate({
      databaseConnectionId: '33333333-3333-4333-8333-333333333333',
      connection: LOCATOR,
    }),
    (error) => error?.code === 'database_connection_not_found',
  )

  assert.equal(validateDatabaseTransport(TRANSPORT), true)
  assert.equal(validateDatabaseLocator(LOCATOR), true)
  assert.throws(
    () => validateDatabaseTransport({ ...TRANSPORT, table: 'events' }),
    (error) => error?.code === 'unsupported_database_transport_fields',
  )
})

test('DatabaseSourcePuller tests transport-only profiles and persisted profile-backed sources read-only', async () => {
  const poolOptions = []
  const profile = {
    id: PROFILE_ID,
    key: 'night-all-primary',
    engine: 'postgresql',
    connection: TRANSPORT,
    revision: 1,
  }
  const store = {
    async getDatabaseConnection() { return profile },
    async getExternalSource() {
      return {
        id: SOURCE_ID,
        sourceKey: 'warehouse-events',
        sourceKind: 'database',
        datasetId: 'warehouse.events.v1',
        platform: 'external',
        objectType: 'event',
        status: 'paused',
        connection: LOCATOR,
        databaseConnectionId: PROFILE_ID,
      }
    },
    async getActiveMapping() { return null },
  }
  const puller = new DatabaseSourcePuller({
    store,
    poolFactory(options) {
      poolOptions.push(options)
      return {
        async query() {
          return { rows: [{
            database_name: 'night_all',
            database_user: 'mx_reader',
            server_version: '16.4',
            read_only: 'on',
          }] }
        },
        async end() {},
      }
    },
  })

  assert.equal((await puller.testDatabaseConnectionProfile(PROFILE_ID)).readOnly, true)
  assert.equal((await puller.testSource('warehouse-events')).database, 'night_all')
  assert.equal(poolOptions[0].host, TRANSPORT.host)
  assert.equal(poolOptions[0].application_name, 'mx-insight-hub-database-profile-test')
  assert.equal(poolOptions[1].application_name, 'mx-insight-hub-source-connection-test')
  assert.equal(poolOptions.every((options) => options.options === '-c default_transaction_read_only=on'), true)
})
