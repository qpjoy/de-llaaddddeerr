import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProviderRegistry,
  decryptProviderPassword,
  encryptProviderPassword,
  normalizePostgresProviderConfig,
  parseProviderMasterKey,
} from '../../server/ingest/external/provider-registry.mjs'
import { DatabaseSourcePuller } from '../../server/ingest/external/database-source.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const MASTER_HEX = '11'.repeat(32)
const MASTER_BASE64 = Buffer.alloc(32, 0x22).toString('base64')
const CONFIG = {
  host: 'postgres.internal',
  port: 5432,
  database: 'night_all',
  username: 'mx_reader',
  sslMode: 'verify-full',
}

test('provider master key accepts exactly 32-byte base64 or 64 hexadecimal characters', () => {
  assert.equal(parseProviderMasterKey(MASTER_HEX).length, 32)
  assert.equal(parseProviderMasterKey(MASTER_BASE64).length, 32)
  assert.throws(
    () => parseProviderMasterKey(''),
    (error) => error?.status === 500 && error?.code === 'provider_master_key_not_configured',
  )
  for (const invalid of ['11'.repeat(31), Buffer.alloc(31).toString('base64'), 'not base64!']) {
    assert.throws(
      () => parseProviderMasterKey(invalid),
      (error) => error?.status === 500 && error?.code === 'invalid_provider_master_key',
    )
  }
})

test('PostgreSQL provider config is a strict non-secret allowlist', () => {
  assert.deepEqual(normalizePostgresProviderConfig({
    host: 'db.example.test', database: 'analytics', username: 'reader',
  }), {
    host: 'db.example.test', port: 5432, database: 'analytics', username: 'reader', sslMode: 'require',
  })
  for (const config of [
    { ...CONFIG, password: 'must-not-live-in-config' },
    { ...CONFIG, port: 65_536 },
    { ...CONFIG, sslMode: 'prefer' },
    { ...CONFIG, host: 'postgres://reader@db.example.test' },
  ]) {
    assert.throws(
      () => normalizePostgresProviderConfig(config),
      (error) => error?.status === 400 && error?.code === 'invalid_provider_config',
    )
  }
})

test('AES-256-GCM envelope uses providerKey as authenticated data and reveals no plaintext', () => {
  const password = 'correct horse battery staple'
  const encryptedSecret = encryptProviderPassword({
    providerKey: 'night-all-pg', password, masterKey: MASTER_HEX,
  })
  assert.equal(encryptedSecret.version, 1)
  assert.equal(encryptedSecret.algorithm, 'aes-256-gcm')
  assert.equal(JSON.stringify(encryptedSecret).includes(password), false)
  assert.equal(decryptProviderPassword({
    providerKey: 'night-all-pg', encryptedSecret, masterKey: MASTER_HEX,
  }), password)

  assert.throws(
    () => decryptProviderPassword({
      providerKey: 'other-provider', encryptedSecret, masterKey: MASTER_HEX,
    }),
    (error) => error?.code === 'provider_secret_invalid',
  )
  assert.throws(
    () => decryptProviderPassword({
      providerKey: 'night-all-pg',
      encryptedSecret: { ...encryptedSecret, ciphertext: `${encryptedSecret.ciphertext.slice(0, -2)}AA` },
      masterKey: MASTER_HEX,
    }),
    (error) => error?.code === 'provider_secret_invalid',
  )
})

test('registry CRUD keeps ciphertext internal while allowing deliberate credential resolution', async () => {
  const store = new MemoryStore()
  const registry = new ProviderRegistry({ store, masterKey: MASTER_BASE64 })
  const created = await registry.create({
    providerKey: 'night-all-pg',
    displayName: 'Night-All read replica',
    config: CONFIG,
    password: 'first-password',
  })
  assert.equal(created.secretConfigured, true)
  assert.equal(created.encryptedSecret, undefined)
  assert.equal(created.password, undefined)
  assert.equal(JSON.stringify(created).includes('first-password'), false)

  const stored = await store.getSourceProviderSecret('night-all-pg')
  assert.ok(stored.encryptedSecret.ciphertext)
  assert.equal(JSON.stringify(stored).includes('first-password'), false)
  assert.deepEqual(await registry.resolveCredentials('night-all-pg'), {
    ...CONFIG,
    password: 'first-password',
  })

  const renamed = await registry.update('night-all-pg', { displayName: 'Primary PostgreSQL' })
  assert.equal(renamed.displayName, 'Primary PostgreSQL')
  assert.equal(renamed.encryptedSecret, undefined)
  let validatedDraft = null
  await registry.update('night-all-pg', { password: 'rotated-password' }, {
    validateCredentials: async (credentials) => { validatedDraft = credentials },
  })
  assert.equal(validatedDraft.password, 'rotated-password')
  assert.equal(validatedDraft.host, CONFIG.host)
  assert.equal((await registry.resolveCredentials('night-all-pg')).password, 'rotated-password')
  assert.equal((await registry.get('night-all-pg')).healthStatus, 'healthy')

  const checkedAt = new Date('2026-08-10T03:00:00.000Z')
  const health = await registry.recordHealth('night-all-pg', {
    status: 'unhealthy', errorCode: 'connection_refused', checkedAt,
  })
  assert.equal(health.healthStatus, 'unhealthy')
  assert.equal(health.healthErrorCode, 'connection_refused')
  assert.equal(health.healthCheckedAt, checkedAt.toISOString())
  assert.equal((await registry.list()).length, 1)

  await assert.rejects(
    () => registry.update('night-all-pg', { encryptedSecret: { plaintext: true } }),
    (error) => error?.code === 'invalid_provider',
  )
  await assert.rejects(
    () => registry.recordHealth('night-all-pg', {
      status: 'unhealthy', errorCode: 'host=db.internal connection refused',
    }),
    (error) => error?.code === 'invalid_provider_health',
  )
  await registry.delete('night-all-pg')
  assert.equal(await registry.get('night-all-pg'), null)
})

test('registry fails explicitly when the platform master key is not configured', () => {
  assert.throws(
    () => new ProviderRegistry({ store: new MemoryStore(), masterKey: '' }),
    (error) => error?.status === 500 && error?.code === 'provider_master_key_not_configured',
  )
})

test('provider creation persists nothing until the candidate read-only connection passes', async () => {
  const store = new MemoryStore()
  const registry = new ProviderRegistry({ store, masterKey: MASTER_HEX })
  await assert.rejects(
    () => registry.create({
      providerKey: 'night-all-pg', displayName: 'Night-All', config: CONFIG, password: 'wrong',
    }, {
      validateCredentials: async () => { throw new Error('draft connection rejected') },
    }),
    /draft connection rejected/,
  )
  assert.equal(await registry.get('night-all-pg'), null)

  const created = await registry.create({
    providerKey: 'night-all-pg', displayName: 'Night-All', config: CONFIG, password: 'working',
  }, {
    validateCredentials: async (credentials) => assert.equal(credentials.password, 'working'),
  })
  assert.equal(created.healthStatus, 'healthy')
  assert.ok(created.healthCheckedAt)
})

test('provider-backed sessions resolve rotated passwords on every connection and stay read-only', async () => {
  const store = new MemoryStore()
  const registry = new ProviderRegistry({ store, masterKey: MASTER_HEX })
  await registry.create({
    providerKey: 'night-all-pg',
    displayName: 'Night-All PostgreSQL',
    config: CONFIG,
    password: 'first-password',
  })
  const optionsSeen = []
  const puller = new DatabaseSourcePuller({
    store,
    queue: null,
    providerRegistry: registry,
    poolFactory: (options) => {
      optionsSeen.push(options)
      return {
        query: async () => ({ rows: [{
          database_name: 'night_all', database_user: 'mx_reader',
          server_version: '16.11', read_only: 'on',
        }] }),
        end: async () => {},
      }
    },
  })

  const first = await puller.testProvider('night-all-pg')
  assert.deepEqual(first.connection, {
    database: 'night_all', user: 'mx_reader', serverVersion: '16.11', readOnly: true,
  })
  assert.equal(optionsSeen[0].password, 'first-password')
  assert.equal(optionsSeen[0].options, '-c default_transaction_read_only=on')
  assert.deepEqual(optionsSeen[0].ssl, { rejectUnauthorized: true })

  await registry.update('night-all-pg', { password: 'rotated-password' }, {
    validateCredentials: (credentials) => puller.testProviderCredentials(credentials),
  })
  await puller.testProvider('night-all-pg')
  assert.equal(optionsSeen[1].password, 'rotated-password', 'draft credentials are tested before persistence')
  assert.equal(optionsSeen[2].password, 'rotated-password', 'the next session resolves the persisted rotation')
  assert.equal(JSON.stringify(await registry.list()).includes('rotated-password'), false)
})

test('a failed draft connection test leaves the last-known-good provider unchanged', async () => {
  const store = new MemoryStore()
  const registry = new ProviderRegistry({ store, masterKey: MASTER_HEX })
  await registry.create({
    providerKey: 'night-all-pg', displayName: 'Night-All', config: CONFIG, password: 'working-password',
  })
  await registry.recordHealth('night-all-pg', { status: 'healthy' })

  await assert.rejects(
    () => registry.update('night-all-pg', { password: 'wrong-password' }, {
      validateCredentials: async () => { throw new Error('connection refused') },
    }),
    /connection refused/,
  )
  assert.equal((await registry.resolveCredentials('night-all-pg')).password, 'working-password')
  assert.equal((await registry.get('night-all-pg')).healthStatus, 'healthy')
})

test('provider connection setup failures are persisted and returned without driver details', async () => {
  const store = new MemoryStore()
  const registry = new ProviderRegistry({ store, masterKey: MASTER_HEX })
  await registry.create({
    providerKey: 'broken-pg', displayName: 'Broken', config: CONFIG, password: 'private-password',
  })
  const puller = new DatabaseSourcePuller({
    store,
    queue: null,
    providerRegistry: registry,
    poolFactory: () => {
      throw new Error('postgres://mx_reader:private-password@private.internal/night_all refused')
    },
  })
  await assert.rejects(
    () => puller.testProvider('broken-pg'),
    (error) => error?.status === 503 && error?.code === 'provider_connection_failed'
      && !error.message.includes('private-password') && !error.message.includes('private.internal'),
  )
  const [provider] = await registry.list()
  assert.equal(provider.healthStatus, 'unhealthy')
  assert.equal(provider.healthErrorCode, 'provider_connection_failed')
})

test('PostgresStore provider reads are safe by default and secret reads are explicit', async () => {
  const calls = []
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    provider_key: 'warehouse-pg',
    display_name: 'Warehouse',
    provider_type: 'postgresql',
    config: CONFIG,
    encrypted_secret: { version: 1, algorithm: 'aes-256-gcm', iv: 'iv', authTag: 'tag', ciphertext: 'secret' },
    health_status: 'unknown',
    health_checked_at: null,
    health_error_code: null,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
  }
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [row] }
    },
  })

  const created = await store.createSourceProvider({
    providerKey: row.provider_key,
    displayName: row.display_name,
    config: CONFIG,
    encryptedSecret: row.encrypted_secret,
  })
  assert.equal(created.secretConfigured, true)
  assert.equal(created.encryptedSecret, undefined)
  assert.doesNotMatch(calls[0].sql, /RETURNING\s+\*/i)

  const listed = await store.listSourceProviders()
  assert.equal(listed[0].encryptedSecret, undefined)
  assert.doesNotMatch(calls[1].sql, /encrypted_secret/i)

  const internal = await store.getSourceProviderSecret(row.provider_key)
  assert.deepEqual(internal.encryptedSecret, row.encrypted_secret)
  assert.match(calls[2].sql, /encrypted_secret/i)
})

test('PostgresStore persists provider scheduling and import evidence fields', async () => {
  const calls = []
  const providerId = '11111111-1111-4111-8111-111111111111'
  const sourceId = '22222222-2222-4222-8222-222222222222'
  const cursorStart = { cursor: '10', lastId: '9' }
  const cursorEnd = { cursor: '20', lastId: '19' }
  const sourceRow = {
    id: sourceId,
    source_key: 'warehouse-events',
    display_name: 'Warehouse events',
    source_kind: 'database',
    dataset_id: 'warehouse.events.v1',
    platform: 'external',
    object_type: 'event',
    status: 'paused',
    connection: { table: 'events' },
    provider_id: providerId,
    provider_key: 'warehouse-pg',
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
    connection: sourceRow.connection,
    providerId,
    syncIntervalSeconds: 300,
  })
  assert.equal(source.providerId, providerId)
  assert.equal(source.providerKey, 'warehouse-pg')
  assert.equal(source.syncIntervalSeconds, 300)
  assert.match(calls[0].sql, /LEFT JOIN catalog\.source_providers/)
  assert.deepEqual(calls[0].values.slice(-2), [providerId, 300])

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
  const value = await store.withExternalSourceLock('warehouse-events', async () => 'done')
  assert.equal(value, 'done')
  assert.equal(queries.length, 2)
  assert.match(queries[0].sql, /pg_try_advisory_lock/)
  assert.match(queries[1].sql, /pg_advisory_unlock/)
  assert.equal(queries[0].values[0], 'mx-insight-hub:external-source:warehouse-events')
  assert.equal(released, true)

  const busyClient = {
    async query() { return { rows: [{ locked: false }] } },
    release() {},
  }
  const busyStore = new PostgresStore({ connect: async () => busyClient })
  await assert.rejects(
    () => busyStore.withExternalSourceLock('warehouse-events', async () => 'never'),
    (error) => error?.status === 409 && error?.code === 'source_busy',
  )
})

test('PostgresStore reports a referenced provider as in use instead of leaking a driver error', async () => {
  const store = new PostgresStore({
    async query() {
      const error = new Error('foreign key detail with internal identifiers')
      error.code = '23503'
      throw error
    },
  })
  await assert.rejects(
    () => store.deleteSourceProvider('warehouse-pg'),
    (error) => error?.status === 409 && error?.code === 'provider_in_use' && !/foreign key/.test(error.message),
  )
})
