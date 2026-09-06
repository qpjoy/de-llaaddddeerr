import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const DATASET_ID = 'ecommerce.products.v1'
const PLATFORM = 'ecommerce'
const CONNECTOR_ID = 'external-platform:justone'
const FINGERPRINT = 'a'.repeat(64)

function productRecord() {
  return {
    platform: PLATFORM,
    objectType: 'product',
    externalId: 'jd:sku-1',
    payloadSha256: 'b'.repeat(64),
    rawPayloadSha256: 'c'.repeat(64),
    rawItem: { skuId: 'sku-1', title: 'Camera' },
    parserVersion: 'mxih-justone-product-search.v1',
    contentType: 'product',
    url: 'https://item.jd.com/sku-1.html',
    title: 'Camera',
    body: null,
    authorExternalId: 'shop-1',
    authorName: 'Shop',
    eventTime: null,
    collectedAt: new Date('2026-09-03T00:00:00.000Z'),
    latitude: null,
    longitude: null,
    countryCode: 'CN',
    admin1Code: null,
    admin2Code: null,
    stableFields: { commerce: { product: { goodsId: 'sku-1' } } },
    extensions: {},
    metrics: { comments: 3 },
    rank: 1,
    deletedAt: null,
  }
}

function lineage(requestId, providerCallId) {
  return {
    requestId,
    queryFingerprint: FINGERPRINT,
    providerCallId,
  }
}

test('external-platform worker contract carries gateway call lineage into canonical ingest', async () => {
  const gateway = await readFile(
    new URL('../../server/external-platforms/gateway.mjs', import.meta.url),
    'utf8',
  )
  const worker = await readFile(
    new URL('../../server/workers/ingest.mjs', import.meta.url),
    'utf8',
  )

  assert.match(gateway, /kind:\s*'external-platform-result'[\s\S]*?requestId:\s*activeRequestId[\s\S]*?queryFingerprint:\s*requestFingerprint[\s\S]*?providerCallId:\s*call\.id[\s\S]*?records:\s*result\.records/u)
  assert.match(worker, /const records = rehydrateJustOneQueuedRecords\(payload\.records\)[\s\S]*?records,/u)
  assert.match(worker, /payload\?\.kind === 'external-platform-result'[\s\S]*?externalPlatformLineage:\s*\{[\s\S]*?requestId:\s*payload\.requestId\s*\?\?\s*null[\s\S]*?queryFingerprint:\s*payload\.queryFingerprint\s*\?\?\s*null[\s\S]*?providerCallId:\s*payload\.providerCallId\s*\?\?\s*null/u)
})

test('PostgresStore accepts only a succeeded matching provider call and writes canonical lineage atomically', async () => {
  const queries = []
  const requestId = randomUUID()
  const providerCallId = randomUUID()
  const runId = randomUUID()
  const sourceObjectId = randomUUID()
  const sourceRevisionId = randomUUID()
  const recordId = randomUUID()
  const record = productRecord()
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/INSERT INTO ingest\.ingest_runs/u.test(sql)) return { rows: [{ id: runId }], rowCount: 1 }
      if (/INSERT INTO ingest\.source_objects/u.test(sql)) {
        return { rows: [{ id: sourceObjectId, current_revision: 1 }], rowCount: 1 }
      }
      if (/INSERT INTO ingest\.source_object_revisions/u.test(sql)) {
        return { rows: [{ id: sourceRevisionId }], rowCount: 1 }
      }
      if (/INSERT INTO core\.canonical_records/u.test(sql)) {
        return { rows: [{ id: recordId, current_revision: 1, projection_revision: 1 }], rowCount: 1 }
      }
      if (/INSERT INTO core\.record_revisions/u.test(sql)) return { rows: [], rowCount: 1 }
      if (/INSERT INTO core\.observations/u.test(sql)) return { rows: [], rowCount: 1 }
      if (/INSERT INTO outbox\.projection_events/u.test(sql)) return { rows: [], rowCount: 1 }
      if (/UPDATE ingest\.ingest_runs/u.test(sql)) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })

  const result = await store.ingestExternalRecords({
    datasetId: DATASET_ID,
    platform: PLATFORM,
    records: [record],
    importRunId: null,
    connectorId: CONNECTOR_ID,
    externalPlatformLineage: lineage(requestId, providerCallId),
  })

  assert.deepEqual(result, {
    ingested: 1,
    changed: 1,
    deleted: 0,
    cursorEnd: null,
    rowCount: 1,
    runId,
  })
  assert.equal(queries.at(-1).sql, 'COMMIT')

  const runInsert = queries.find(({ sql }) => /INSERT INTO ingest\.ingest_runs/u.test(sql))
  assert.match(runInsert.sql, /external_platform_call_id/u)
  assert.match(runInsert.sql, /FROM external_platform\.provider_calls call/u)
  assert.match(runInsert.sql, /call\.usage_request_id = \$4/u)
  assert.match(runInsert.sql, /call\.request_fingerprint = \$5/u)
  assert.match(runInsert.sql, /call\.outcome = 'succeeded'/u)
  assert.match(runInsert.sql, /\$2 = 'external-platform:' \|\| call\.provider_key/u)
  assert.match(runInsert.sql, /\$3 = split_part\(call\.operation, '\.', 1\) \|\| '\.external-platform\.v1'/u)
  assert.deepEqual(runInsert.values.slice(3), [requestId, FINGERPRINT, providerCallId])

  for (const pattern of [
    /INSERT INTO ingest\.source_objects/u,
    /INSERT INTO ingest\.source_object_revisions/u,
    /INSERT INTO core\.record_revisions/u,
  ]) {
    assert.match(queries.find(({ sql }) => pattern.test(sql)).sql, /ingest_run_id/u)
  }

  const observation = queries.find(({ sql }) => /INSERT INTO core\.observations/u.test(sql))
  assert.equal(observation.values[3], `${providerCallId}:product:jd:sku-1`)
  assert.equal(observation.values[4], FINGERPRINT)
  assert.equal(observation.values[5], 1)
  assert.deepEqual(observation.values[6], { comments: 3 })
  assert.match(observation.values[7], /^[0-9a-f]{64}$/u)
  assert.equal(observation.values[8], runId)

  const outbox = queries.find(({ sql }) => /INSERT INTO outbox\.projection_events/u.test(sql))
  assert.deepEqual(outbox.values, [
    recordId,
    1,
    'upsert',
    { datasetId: DATASET_ID, platform: PLATFORM, objectType: 'product' },
  ])
  const canonical = queries.find(({ sql }) => /INSERT INTO core\.canonical_records/u.test(sql))
  assert.match(canonical.sql, /collected_at = GREATEST\(\s*core\.canonical_records\.collected_at,\s*EXCLUDED\.collected_at\s*\)/u)
  assert.match(canonical.sql, /projection_revision[\s\S]*?\$25::boolean[\s\S]*?IS DISTINCT FROM GREATEST\(/u)
  assert.equal(canonical.values[24], true)
  const runUpdate = queries.find(({ sql }) => /UPDATE ingest\.ingest_runs/u.test(sql))
  assert.deepEqual(runUpdate.values, [runId, 1])
  assert.match(runUpdate.sql, /RETURNING id/u)
})

test('PostgresStore rejects external lineage when no succeeded matching provider call exists', async () => {
  const queries = []
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (/INSERT INTO ingest\.ingest_runs/u.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM ingest\.ingest_runs/u.test(sql)) return { rows: [], rowCount: 0 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })

  await assert.rejects(
    store.ingestExternalRecords({
      datasetId: DATASET_ID,
      platform: PLATFORM,
      records: [productRecord()],
      importRunId: null,
      connectorId: CONNECTOR_ID,
      externalPlatformLineage: lineage(randomUUID(), randomUUID()),
    }),
    (error) => error?.code === 'api_search_lineage_mismatch',
  )
  assert.equal(queries.at(-1), 'ROLLBACK')
  assert.equal(queries.some((sql) => /canonical_records|core\.observations|projection_events/u.test(sql)), false)
})

test('PostgresStore completes an external-platform ingest run for an empty result page', async () => {
  const queries = []
  const requestId = randomUUID()
  const providerCallId = randomUUID()
  const runId = randomUUID()
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/INSERT INTO ingest\.ingest_runs/u.test(sql)) return { rows: [{ id: runId }], rowCount: 1 }
      if (/UPDATE ingest\.ingest_runs/u.test(sql)) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })

  const result = await store.ingestExternalRecords({
    datasetId: DATASET_ID,
    platform: PLATFORM,
    records: [],
    importRunId: null,
    connectorId: CONNECTOR_ID,
    externalPlatformLineage: lineage(requestId, providerCallId),
  })

  assert.deepEqual(result, {
    ingested: 0,
    changed: 0,
    deleted: 0,
    cursorEnd: null,
    rowCount: 0,
    runId,
  })
  const runUpdate = queries.find(({ sql }) => /UPDATE ingest\.ingest_runs/u.test(sql))
  assert.deepEqual(runUpdate.values, [runId, 0])
  assert.equal(
    queries.some(({ sql }) => /source_objects|canonical_records|core\.observations|projection_events/u.test(sql)),
    false,
  )
  assert.equal(queries.at(-1).sql, 'COMMIT')
})

test('PostgresStore replays a finished provider-call ingest without touching canonical state', async () => {
  const queries = []
  const requestId = randomUUID()
  const providerCallId = randomUUID()
  const runId = randomUUID()
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/INSERT INTO ingest\.ingest_runs/u.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM ingest\.ingest_runs/u.test(sql)) {
        return {
          rows: [{
            id: runId,
            connector_id: CONNECTOR_ID,
            stream_id: 'ecommerce.external-platform.v1',
            request_id: requestId,
            query_fingerprint: FINGERPRINT,
            item_count: 2,
            finished_at: new Date('2026-09-03T00:01:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })

  const result = await store.ingestExternalRecords({
    datasetId: DATASET_ID,
    platform: PLATFORM,
    records: [productRecord()],
    importRunId: null,
    connectorId: CONNECTOR_ID,
    externalPlatformLineage: lineage(requestId, providerCallId),
  })

  assert.deepEqual(result, {
    ingested: 2,
    changed: 0,
    deleted: 0,
    rowCount: 2,
    replayed: true,
    runId,
  })
  assert.match(queries.find((sql) => /FROM ingest\.ingest_runs/u.test(sql)), /external_platform_call_id = \$1/u)
  assert.equal(queries.some((sql) => /source_objects|canonical_records|core\.observations|projection_events/u.test(sql)), false)
  assert.equal(queries.at(-1), 'COMMIT')
})

test('external-platform migration pins ingest runs to one provider call', async () => {
  const migration = await readFile(
    new URL('../../migrations/051_external_platform_gateway.sql', import.meta.url),
    'utf8',
  )

  assert.match(migration, /ADD COLUMN IF NOT EXISTS external_platform_call_id uuid\s+REFERENCES external_platform\.provider_calls\(id\) ON DELETE RESTRICT/iu)
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS ingest_runs_external_platform_call_idx\s+ON ingest\.ingest_runs \(external_platform_call_id\)\s+WHERE external_platform_call_id IS NOT NULL/iu)
  assert.match(migration, /ON usage_requests \(id, tenant_id, consumer_id, api_key_id, fingerprint\)/u)
  assert.match(migration, /FOREIGN KEY \(usage_request_id, tenant_id, consumer_id, api_key_id, request_fingerprint\)\s+REFERENCES usage_requests \(id, tenant_id, consumer_id, api_key_id, fingerprint\)/u)
  assert.match(migration, /external_platform_provider_calls_global_endpoint_guard_idx[\s\S]*?\(provider_key, operation, endpoint_key, outcome, completed_at DESC\)/u)
})

test('reservation reaping closes pending external-platform calls in the same statement', async () => {
  let statement
  const store = new PostgresStore({
    async query(sql) {
      statement = sql
      return { rows: [{ reaped: 2 }] }
    },
  })

  assert.equal(await store.reapStaleReservations(), 2)
  assert.match(statement, /closed_external_platform_calls AS/u)
  assert.match(statement, /UPDATE external_platform\.provider_calls call SET/u)
  assert.match(statement, /call\.outcome = 'pending'/u)
  assert.match(statement, /outcome = 'unknown'/u)
  assert.match(statement, /error_code = 'reservation_lease_expired'/u)
})

test('Data Center record lineage exposes bounded external-platform evidence', async () => {
  const recordId = randomUUID()
  const callId = randomUUID()
  let detailSql
  const store = new PostgresStore({
    async query(sql) {
      detailSql = sql
      return { rows: [{
        id: recordId,
        dataset_id: DATASET_ID,
        platform: PLATFORM,
        object_type: 'product',
        external_id: 'jd:sku-1',
        current_revision: 1,
        projection_revision: 2,
        observation_id: randomUUID(),
        observation_ingest_run_id: randomUUID(),
        observation_connector_id: CONNECTOR_ID,
        observation_source_event_id: `${callId}:product:jd:sku-1`,
        observation_query_fingerprint: FINGERPRINT,
        observation_request_id: randomUUID(),
        external_platform_call_id: callId,
        external_provider_key: 'justone',
        external_operation: 'ecommerce.products.search',
        external_endpoint_key: 'jd.product-search.v1',
        external_endpoint_version: 'v1',
        external_marketplace: 'jd',
        external_outcome: 'succeeded',
        external_billed: true,
        external_cost_minor: '5',
        external_cost_kind: 'estimated',
        external_currency: 'CNY',
        external_upstream_request_id: 'upstream-1',
        external_upstream_record_time: '2026-09-03T00:00:00Z',
        external_completed_at: new Date('2026-09-03T00:00:01.000Z'),
        external_response_contract_state: 'accepted',
        external_response_captured_at: new Date('2026-09-03T00:00:00.500Z'),
        external_response_payload_sha256: 'd'.repeat(64),
        external_archive_path: 'justone/jd/product-search/v1/2026-09-03/responses/hash.json',
        external_archive_source_key: 'source-catalog-0060',
      }] }
    },
  })

  const [record] = await store.dataCenterRecordsByIds([recordId])
  assert.equal(record.lineage.latestObservation.externalPlatformCallId, callId)
  assert.deepEqual(record.lineage.latestObservation.externalPlatform, {
    providerKey: 'justone',
    operation: 'ecommerce.products.search',
    endpointKey: 'jd.product-search.v1',
    endpointVersion: 'v1',
    marketplace: 'jd',
    outcome: 'succeeded',
    billed: true,
    costMinor: 5,
    costKind: 'estimated',
    currency: 'CNY',
    upstreamRequestId: 'upstream-1',
    upstreamRecordTime: '2026-09-03T00:00:00Z',
    completedAt: '2026-09-03T00:00:01.000Z',
    responseContractState: 'accepted',
    responseCapturedAt: '2026-09-03T00:00:00.500Z',
    responsePayloadSha256: 'd'.repeat(64),
    archivePath: 'justone/jd/product-search/v1/2026-09-03/responses/hash.json',
    sourceCatalogKey: 'source-catalog-0060',
  })
  assert.match(detailSql, /LEFT JOIN external_platform\.provider_calls external_call/u)
  assert.match(detailSql, /LEFT JOIN external_platform\.response_archives external_response/u)
  assert.match(detailSql, /FROM external_platform\.archive_objects/u)
})

test('Data Center leaves optional external-platform timestamps null instead of inventing epoch evidence', async () => {
  const recordId = randomUUID()
  const callId = randomUUID()
  const store = new PostgresStore({
    async query() {
      return { rows: [{
        id: recordId,
        dataset_id: DATASET_ID,
        platform: PLATFORM,
        object_type: 'product',
        external_id: 'jd:sku-2',
        current_revision: 1,
        projection_revision: 1,
        observation_id: randomUUID(),
        external_platform_call_id: callId,
        external_completed_at: null,
        external_response_captured_at: null,
      }] }
    },
  })

  const [record] = await store.dataCenterRecordsByIds([recordId])
  assert.equal(record.lineage.latestObservation.externalPlatform.completedAt, null)
  assert.equal(record.lineage.latestObservation.externalPlatform.responseCapturedAt, null)
})
