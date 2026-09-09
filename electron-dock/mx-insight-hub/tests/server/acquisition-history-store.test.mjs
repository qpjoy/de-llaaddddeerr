import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  deliveredResponseSemanticSha256,
  PostgresAcquisitionHistoryStore,
} from '../../server/acquisitions/history-store.mjs'
import { acquireMigrationLock } from '../../server/migrate.mjs'

function queryKind(sql) {
  return /acquisition-history:([a-z-]+)/u.exec(sql)?.[1] || 'unknown'
}

function fakePool(fixtures = {}) {
  const queries = []
  return {
    queries,
    async query(sql, values = []) {
      const kind = queryKind(sql)
      queries.push({ kind, sql, values })
      const rows = fixtures[kind]
      if (rows === undefined) throw new Error(`unexpected acquisition history query: ${kind}`)
      return { rows }
    },
  }
}

function connectedPool(fixtures = {}) {
  const queries = []
  let inFlight = false
  const client = {
    async query(sql, values = []) {
      if (inFlight) throw new Error('queries overlapped on one PostgreSQL client')
      inFlight = true
      try {
        await new Promise((resolve) => setImmediate(resolve))
        const command = String(sql).trim().split(/\s+/u)[0].toUpperCase()
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command)) {
          queries.push({ kind: command.toLowerCase(), sql, values })
          return { rows: [] }
        }
        const kind = queryKind(sql)
        queries.push({ kind, sql, values })
        const rows = fixtures[kind]
        if (rows === undefined) throw new Error(`unexpected acquisition history query: ${kind}`)
        return { rows }
      } finally {
        inFlight = false
      }
    },
    release() {},
  }
  return {
    queries,
    query: (...args) => client.query(...args),
    async connect() { return client },
  }
}

function rootRow(overrides = {}) {
  return {
    id: randomUUID(),
    tenant_id: randomUUID(),
    consumer_id: randomUUID(),
    api_key_id: randomUUID(),
    idempotency_key: 'note-detail-1',
    fingerprint: 'a'.repeat(64),
    platform: null,
    capability: 'social.posts.resolve',
    billing_meter_key: 'social.posts.resolve',
    status: 'committed',
    units_reserved: 1,
    units_actual: 1,
    response_status: 200,
    response_body: {
      data: {
        desc: '这是完整正文，长度明显超过六十个字，历史查询必须返回已交付内容本身，不能重新截断、脱敏或改写。'.repeat(2),
        tags: ['旅行', '建筑'],
      },
    },
    has_response_body: true,
    delivery_source_mode: 'live',
    response_captured_at: new Date('2026-09-10T01:02:03.000Z'),
    compatibility_snapshot_id: null,
    completed_at: new Date('2026-09-10T01:02:04.000Z'),
    tenant_name: 'Tenant A',
    consumer_name: 'Consumer A',
    consumer_business_id: 'consumer-a',
    api_key_prefix: 'mih_live_',
    api_key_last_four: '1234',
    customer_charge_id: randomUUID(),
    customer_meter_key: 'social.posts.resolve',
    customer_billing_unit: 'request',
    customer_enforcement_mode: 'enforced',
    customer_charge_status: 'captured',
    customer_currency: 'CNY',
    customer_unit_price_minor: '30',
    customer_quoted_minor: '30',
    customer_charged_minor: '30',
    customer_price_book_key: 'default-cny',
    customer_price_book_version: 1,
    customer_settled_at: new Date('2026-09-10T01:02:04.000Z'),
    ...overrides,
  }
}

function itemRow(overrides = {}) {
  return {
    observation_id: randomUUID(),
    record_id: randomUUID(),
    connector_id: 'external-platform:tikhub',
    query_fingerprint: 'b'.repeat(64),
    observed_at: new Date('2026-09-10T01:02:03.500Z'),
    rank: 1,
    metrics: { likes: 12 },
    ingest_run_id: randomUUID(),
    dataset_id: 'tikhub.xiaohongshu.note.v1',
    platform: 'xiaohongshu',
    object_type: 'note',
    external_id: 'note-1',
    current_revision: 4,
    canonical_revision: 2,
    revision_evidence: 'captured',
    normalized_payload: { body: '完整正文', tags: ['旅行', '建筑'] },
    source_kind: 'provider',
    source_call_id: randomUUID(),
    source_call_ordinal: 0,
    source_started_at: new Date('2026-09-10T01:02:02.000Z'),
    ...overrides,
  }
}

test('migration 061 captures immutable delivered-source and canonical-revision references without copying raw', async () => {
  const sql = await readFile(
    new URL('../../migrations/061_acquisition_query_run_history.sql', import.meta.url),
    'utf8',
  )

  assert.match(sql, /ADD COLUMN IF NOT EXISTS source_provider_call_id uuid/u)
  assert.match(sql, /FOREIGN KEY \(source_provider_call_id\)[\s\S]*NOT VALID/u)
  assert.match(sql, /snapshot\.last_success_call_id[\s\S]*INTO NEW\.source_provider_call_id/u)
  assert.match(sql, /gateway request source provider call is immutable/u)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS canonical_revision integer/u)
  assert.match(sql, /SELECT record\.current_revision[\s\S]*INTO NEW\.canonical_revision/u)
  assert.match(sql, /observation canonical revision is immutable/u)
  assert.match(sql, /NEW\.ingest_run_id IS DISTINCT FROM OLD\.ingest_run_id/u)
  assert.match(sql, /UPDATE OF canonical_revision, record_id, ingest_run_id/u)
  assert.match(sql, /observations_ingest_order_idx/u)
  assert.match(sql, /pg_total_relation_size/u)
  assert.match(sql, /> 134217728/u)
  assert.ok(
    sql.indexOf('DO $large_table_preflight$')
      < sql.indexOf('ALTER TABLE external_platform.gateway_requests'),
    'large-table preflight must run before the first gateway ledger lock',
  )
  assert.match(sql, /scripts\/acquisition-history-indexes\.sql outside a transaction/u)
  assert.match(sql, /invalid or has the wrong definition/u)
  assert.doesNotMatch(sql, /CREATE INDEX IF NOT EXISTS/u)
  assert.doesNotMatch(sql, /CREATE TABLE/iu)
  assert.doesNotMatch(sql, /control\.external_platform_restricted_raw_responses/iu)
  assert.doesNotMatch(sql, /UPDATE\s+core\.observations\s+SET\s+canonical_revision/iu)
})

test('migration 064 indexes only direct request-owned ingest history and supports online preparation', async () => {
  const [migration, onlinePreparation] = await Promise.all([
    readFile(
      new URL('../../migrations/064_direct_request_acquisition_history.sql', import.meta.url),
      'utf8',
    ),
    readFile(new URL('../../scripts/acquisition-history-indexes.sql', import.meta.url), 'utf8'),
  ])

  for (const sql of [migration, onlinePreparation]) {
    assert.match(sql, /ingest_runs_request_history_idx/u)
    assert.match(sql, /request_id[\s\S]*started_at[\s\S]*id/u)
    assert.match(sql, /request_id IS NOT NULL/u)
    assert.match(sql, /connector_call_id IS NULL/u)
    assert.match(sql, /external_platform_call_id IS NULL/u)
  }
  assert.match(migration, /pg_total_relation_size\('ingest\.ingest_runs'::regclass\)/u)
  assert.match(migration, /> 134217728/u)
  assert.match(onlinePreparation, /CREATE INDEX CONCURRENTLY ingest_runs_request_history_idx/u)
})

test('Hub migration runner serializes product DDL with a session advisory lock', async () => {
  const source = await readFile(new URL('../../server/migrate.mjs', import.meta.url), 'utf8')
  const lock = source.indexOf("SELECT pg_try_advisory_lock($1) AS acquired")
  const migrationTable = source.indexOf('CREATE TABLE IF NOT EXISTS schema_migrations')
  const unlock = source.indexOf("SELECT pg_advisory_unlock($1)")
  assert.ok(lock >= 0 && lock < migrationTable)
  assert.ok(unlock > migrationTable)
  assert.match(source, /const MIGRATION_LOCK_KEY = 0x4d58_0002/u)
  assert.match(source, /if \(migrationLockAcquired\)/u)
})

test('Hub migration runner fails fast when another migration owns its advisory lock', async () => {
  const calls = []
  await assert.rejects(
    acquireMigrationLock({
      async query(sql, values) {
        calls.push({ sql, values })
        return { rows: [{ acquired: false }] }
      },
    }),
    /Another MX Insight Hub migration is already running/u,
  )
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /pg_try_advisory_lock/u)
})

test('delivered response semantic hash is stable across JSON object key order', () => {
  assert.equal(
    deliveredResponseSemanticSha256({ b: 2, a: { d: 4, c: 3 } }),
    deliveredResponseSemanticSha256({ a: { c: 3, d: 4 }, b: 2 }),
  )
})

test('acquisition history fails closed instead of rounding an unsafe bigint', async () => {
  const root = rootRow({ units_actual: '9007199254740992' })
  const pool = fakePool({
    root: [root],
    items: [],
    'gateway-events': [],
  })
  const store = new PostgresAcquisitionHistoryStore(pool)

  await assert.rejects(
    store.getPublicDeliveredRun({
      requestId: root.id,
      consumerId: root.consumer_id,
      apiKeyId: root.api_key_id,
    }),
    (error) => error?.code === 'acquisition_history_integer_out_of_range',
  )
})

test('Public acquisition history enforces owner in SQL and returns only the own safe delivered projection', async () => {
  const root = rootRow()
  const first = itemRow()
  const second = itemRow({
    rank: 2,
    external_id: 'note-2',
    canonical_revision: 1,
    current_revision: 1,
  })
  const pool = fakePool({
    root: [root],
    items: [first, second],
    'gateway-events': [{
      id: randomUUID(),
      provider_key: 'tikhub',
      source_mode: 'fresh_cache',
      succeeded: true,
      response_status: 200,
      provider_call_id: null,
      source_provider_call_id: randomUUID(),
      snapshot_id: randomUUID(),
      error_code: null,
      created_at: new Date('2026-09-10T01:02:04.000Z'),
    }],
  })
  const store = new PostgresAcquisitionHistoryStore(pool)

  const result = await store.getPublicDeliveredRun({
    requestId: root.id,
    consumerId: root.consumer_id,
    apiKeyId: root.api_key_id,
  })

  assert.deepEqual(result.delivered.responseBody, root.response_body)
  assert.equal(result.delivered.responseHash.length, 64)
  assert.equal(result.delivered.responseHashContract, 'sha256-canonical-json-v1')
  assert.equal(result.delivered.gatewayEvents[0].sourceMode, 'fresh_cache')
  assert.equal(result.items[0].ordinal, 1)
  assert.equal(result.items[0].canonicalRevision, 2)
  assert.equal(result.items[0].currentRevision, 4)
  assert.equal(result.items[1].ordinal, 2)
  assert.equal(result.customerCharge.chargedMinor, '30')
  assert.equal(result.owner, undefined)
  assert.equal(result.costLineage, undefined)
  assert.equal(result.requestEvidence, undefined)
  assert.equal(result.items[0].connectorId, undefined)
  assert.equal(result.items[0].datasetId, undefined)
  assert.equal(result.items[0].normalizedPayload, undefined)
  assert.equal(result.delivered.gatewayEvents[0].providerKey, undefined)
  assert.equal(result.delivered.gatewayEvents[0].errorCode, undefined)

  const rootQuery = pool.queries.find((query) => query.kind === 'root')
  assert.match(rootQuery.sql, /AND usage\.consumer_id = \$2 AND usage\.api_key_id = \$3/u)
  assert.deepEqual(rootQuery.values, [root.id, root.consumer_id, root.api_key_id])
  assert.deepEqual(pool.queries.map((query) => query.kind).sort(), [
    'gateway-events',
    'items',
    'root',
  ])
  assert.match(pool.queries.find((query) => query.kind === 'items').sql, /source_provider_call_id/u)
  assert.match(pool.queries.find((query) => query.kind === 'items').sql, /compatibility_snapshots/u)
  assert.match(
    pool.queries.find((query) => query.kind === 'items').sql,
    /run\.request_id = \$1[\s\S]*run\.connector_call_id IS NULL[\s\S]*run\.external_platform_call_id IS NULL/u,
  )
  assert.match(
    pool.queries.find((query) => query.kind === 'items').sql,
    /usage\.delivery_source_mode = 'live'[\s\S]*call\.outcome = 'succeeded'/u,
  )
})

test('stored fallback item lineage excludes successful calls from the failed live attempt', async () => {
  const root = rootRow({ delivery_source_mode: 'stored_fallback' })
  const pool = fakePool({
    root: [root],
    items: [],
    'gateway-events': [],
  })
  const store = new PostgresAcquisitionHistoryStore(pool)

  await store.getPublicDeliveredRun({
    requestId: root.id,
    consumerId: root.consumer_id,
    apiKeyId: root.api_key_id,
  })

  const itemQuery = pool.queries.find((query) => query.kind === 'items').sql
  assert.match(itemQuery, /JOIN public\.usage_requests usage/u)
  assert.match(itemQuery, /usage\.delivery_source_mode = 'live'/u)
  assert.doesNotMatch(
    itemQuery,
    /WHERE call\.usage_request_id = \$1\s+AND call\.outcome = 'succeeded'/u,
  )
})

test('Public acquisition history does not reveal whether a foreign request exists', async () => {
  const requestId = randomUUID()
  const consumerId = randomUUID()
  const apiKeyId = randomUUID()
  const pool = fakePool({ root: [] })
  const store = new PostgresAcquisitionHistoryStore(pool)

  await assert.rejects(
    store.getPublicDeliveredRun({ requestId, consumerId, apiKeyId }),
    (error) => error.status === 404 && error.code === 'acquisition_query_run_not_found',
  )
  assert.equal(pool.queries.length, 1)
  assert.match(pool.queries[0].sql, /AND usage\.consumer_id = \$2 AND usage\.api_key_id = \$3/u)
})

test('Admin acquisition history includes owner and provider cost lineage without restricted raw', async () => {
  const root = rootRow()
  const item = itemRow()
  const providerCallId = item.source_call_id
  const pool = fakePool({
    root: [root],
    items: [item],
    'gateway-events': [{
      id: randomUUID(),
      provider_key: 'tikhub',
      source_mode: 'live',
      succeeded: true,
      response_status: 200,
      provider_call_id: providerCallId,
      source_provider_call_id: providerCallId,
      snapshot_id: randomUUID(),
      error_code: null,
      created_at: new Date('2026-09-10T01:02:04.000Z'),
    }],
    'provider-calls': [{
      id: providerCallId,
      provider_key: 'tikhub',
      usage_request_id: root.id,
      request_call: true,
      delivered_source: true,
      call_ordinal: 1,
      call_role: 'enrichment',
      operation: 'social.posts.resolve',
      contract_version: 'tikhub.xiaohongshu.get-note-info.v1',
      endpoint_key: 'xiaohongshu.app.get-note-info',
      endpoint_version: 'v1',
      marketplace: 'xiaohongshu',
      operation_policy_revision: 3,
      operation_release_revision: 2,
      provider_price_book_version: 4,
      provider_credential_revision: 5,
      request_fingerprint: 'a'.repeat(64),
      dispatch_fingerprint: 'c'.repeat(64),
      outcome: 'succeeded',
      http_status: 200,
      business_code: 200,
      billed: true,
      cost_minor: '5',
      cost_kind: 'provider_reported',
      currency: 'CNY',
      latency_ms: 42,
      item_count: 1,
      error_code: null,
      upstream_request_id: 'upstream-request-1',
      upstream_record_time: '1700000000',
      started_at: new Date('2026-09-10T01:02:02.000Z'),
      completed_at: new Date('2026-09-10T01:02:03.000Z'),
    }],
    'connector-calls': [],
  })
  const store = new PostgresAcquisitionHistoryStore(pool)

  const result = await store.getAdminDeliveredRun(root.id)

  assert.equal(result.owner.consumerId, root.consumer_id)
  assert.equal(result.requestEvidence.fingerprint, root.fingerprint)
  assert.equal(result.items[0].connectorId, 'external-platform:tikhub')
  assert.equal(result.items[0].datasetId, 'tikhub.xiaohongshu.note.v1')
  assert.deepEqual(result.items[0].normalizedPayload, item.normalized_payload)
  assert.equal(result.costLineage.providerCalls[0].providerKey, 'tikhub')
  assert.equal(result.costLineage.providerCalls[0].costMinor, '5')
  assert.equal(result.costLineage.providerCalls[0].currency, 'CNY')
  assert.equal(result.costLineage.providerCalls[0].deliveredSource, true)
  assert.equal(result.costLineage.providerCalls[0].operationPolicyRevision, 3)
  assert.equal(result.costLineage.providerCalls[0].operationReleaseRevision, 2)
  assert.equal(result.costLineage.providerCalls[0].providerPriceBookVersion, 4)
  assert.equal(result.costLineage.providerCalls[0].providerCredentialRevision, 5)
  assert.equal(result.delivered.gatewayEvents[0].deliveredSourceProviderCallId, providerCallId)
  assert.doesNotMatch(
    pool.queries.map((query) => query.sql).join('\n'),
    /control\.external_platform_restricted_raw_responses/u,
  )
})

test('a known but not committed request has no historical delivery projection', async () => {
  const root = rootRow({
    status: 'reserved',
    response_body: null,
    has_response_body: false,
  })
  const pool = fakePool({ root: [root] })
  const store = new PostgresAcquisitionHistoryStore(pool)

  await assert.rejects(
    store.getAdminDeliveredRun(root.id),
    (error) => error.status === 409 && error.code === 'acquisition_query_run_unavailable',
  )
  assert.equal(pool.queries.length, 1)
})

test('invalid acquisition history identifiers fail before database access', async () => {
  const pool = fakePool({})
  const store = new PostgresAcquisitionHistoryStore(pool)

  await assert.rejects(
    store.getPublicDeliveredRun({
      requestId: 'not-a-uuid',
      consumerId: randomUUID(),
      apiKeyId: randomUUID(),
    }),
    (error) => error.status === 400 && error.code === 'invalid_request_id',
  )
  assert.equal(pool.queries.length, 0)
})

test('repeatable-read history queries are serialized on one PostgreSQL client', async () => {
  const root = rootRow()
  const pool = connectedPool({
    root: [root],
    items: [],
    'gateway-events': [],
    'provider-calls': [],
    'connector-calls': [],
  })
  const store = new PostgresAcquisitionHistoryStore(pool)

  await store.getAdminDeliveredRun(root.id)

  assert.deepEqual(pool.queries.map((query) => query.kind), [
    'begin',
    'root',
    'items',
    'gateway-events',
    'provider-calls',
    'connector-calls',
    'commit',
  ])
})
