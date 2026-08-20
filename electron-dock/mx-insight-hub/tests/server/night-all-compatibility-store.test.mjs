import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const FINGERPRINT = 'a'.repeat(64)
const OPERATION = 'search.raw'

async function memoryFixture() {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Compatibility tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Compatibility consumer' })
  return { store, tenant, consumer }
}

async function reserve(store, { tenant, consumer }, idempotencyKey) {
  return store.reserve({
    requestId: randomUUID(),
    idempotencyKey,
    fingerprint: FINGERPRINT,
    tenantId: tenant.id,
    consumerId: consumer.id,
    apiKeyId: randomUUID(),
    platform: 'telegram',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(Date.now() - 60_000),
    maxRequests: Number.POSITIVE_INFINITY,
  })
}

async function begin(store, consumerId, requestId) {
  return store.beginConnectorCall({
    consumerId,
    requestId,
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    platform: 'telegram',
  })
}

test('complete live delivery stores last-good but a later partial delivery cannot replace it', async () => {
  const fixture = await memoryFixture()
  const first = await reserve(fixture.store, fixture, 'compat-complete-1')
  const firstCall = await begin(fixture.store, fixture.consumer.id, first.request.id)
  const capturedAt = '2026-08-20T01:00:00.000Z'
  const completeBody = { code: 0, data: { raw_data: [{ id: 'complete' }] } }
  const complete = await fixture.store.commitCompatibilityLiveDelivery(firstCall.id, {
    outcome: 'complete',
    responseBody: completeBody,
    capturedAt,
    staleUntil: '2026-08-20T03:00:00.000Z',
    businessStatus: 'complete',
    nightAllRequestId: 'na-request-1',
    nightAllTraceId: 'na-trace-1',
  })

  assert.equal(complete.request.deliverySourceMode, 'live')
  assert.equal(complete.request.capturedAt, capturedAt)
  assert.equal(complete.request.snapshotId, complete.snapshot.id)
  assert.equal(complete.call.outcome, 'complete')
  assert.equal(complete.call.nightAllTraceId, 'na-trace-1')
  assert.deepEqual(complete.snapshot.responseBody, completeBody)

  const second = await reserve(fixture.store, fixture, 'compat-partial-2')
  const secondCall = await begin(fixture.store, fixture.consumer.id, second.request.id)
  const partial = await fixture.store.commitCompatibilityLiveDelivery(secondCall.id, {
    outcome: 'partial',
    responseBody: { code: 0, data: { results: [{ error: 'one source failed' }] } },
    capturedAt: '2026-08-20T02:00:00.000Z',
    businessStatus: 'partial',
    failureKind: 'business',
    errorCode: 'partial_result',
  })

  assert.equal(partial.snapshot, null)
  assert.equal(partial.request.deliverySourceMode, 'live')
  assert.equal(partial.request.snapshotId, null)
  assert.equal(partial.call.outcome, 'partial')

  const lastGood = await fixture.store.findUsableCompatibilitySnapshot({
    consumerId: fixture.consumer.id,
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    at: '2026-08-20T02:30:00.000Z',
  })
  assert.equal(lastGood.id, complete.snapshot.id)
  assert.equal(lastGood.lastSuccessCallId, firstCall.id)
  assert.deepEqual(lastGood.responseBody, completeBody)

  const late = await reserve(fixture.store, fixture, 'compat-late-old-complete')
  const lateCall = await begin(fixture.store, fixture.consumer.id, late.request.id)
  const lateResult = await fixture.store.commitCompatibilityLiveDelivery(lateCall.id, {
    outcome: 'complete',
    responseBody: { code: 0, data: { raw_data: [{ id: 'older' }] } },
    capturedAt: '2026-08-20T00:30:00.000Z',
    staleUntil: '2026-08-20T03:30:00.000Z',
  })
  assert.equal(lateResult.snapshot, null)
  assert.equal(lateResult.request.snapshotId, null)
  assert.deepEqual((await fixture.store.findUsableCompatibilitySnapshot({
    consumerId: fixture.consumer.id,
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    at: '2026-08-20T02:30:00.000Z',
  })).responseBody, completeBody)
})

test('stale delivery accepts only transient failures and replay retains source metadata', async () => {
  const fixture = await memoryFixture()
  const seed = await reserve(fixture.store, fixture, 'compat-seed')
  const seedCall = await begin(fixture.store, fixture.consumer.id, seed.request.id)
  const seeded = await fixture.store.commitCompatibilityLiveDelivery(seedCall.id, {
    outcome: 'complete',
    responseBody: { code: 0, data: { raw_data: [{ id: 'last-good' }] } },
    capturedAt: '2026-08-20T01:00:00.000Z',
    staleUntil: '2026-08-20T04:00:00.000Z',
  })

  const reservation = await reserve(fixture.store, fixture, 'compat-stale-replay')
  const failedCall = await begin(fixture.store, fixture.consumer.id, reservation.request.id)
  await assert.rejects(
    fixture.store.commitCompatibilityStaleDelivery(failedCall.id, {
      snapshotId: seeded.snapshot.id,
      failureKind: 'http',
      httpStatus: 429,
      errorCode: 'upstream_quota_exceeded',
      at: '2026-08-20T02:00:00.000Z',
    }),
    (error) => error.code === 'compatibility_fallback_not_allowed',
  )

  const stale = await fixture.store.commitCompatibilityStaleDelivery(failedCall.id, {
    snapshotId: seeded.snapshot.id,
    failureKind: 'http',
    httpStatus: 503,
    errorCode: 'upstream_unavailable',
    upstreamLatencyMs: 250,
    at: '2026-08-20T02:00:00.000Z',
  })
  assert.deepEqual(stale.request.responseBody, seeded.snapshot.responseBody)
  assert.equal(stale.request.deliverySourceMode, 'stale')
  assert.equal(stale.request.capturedAt, seeded.snapshot.capturedAt)
  assert.equal(stale.request.snapshotId, seeded.snapshot.id)
  assert.equal(stale.call.outcome, 'failed')
  assert.equal(stale.call.sourceMode, 'stale')

  const networkReservation = await reserve(fixture.store, fixture, 'compat-stale-network')
  const networkCall = await begin(fixture.store, fixture.consumer.id, networkReservation.request.id)
  const networkStale = await fixture.store.commitCompatibilityStaleDelivery(networkCall.id, {
    snapshotId: seeded.snapshot.id,
    failureKind: 'network',
    errorCode: 'upstream_outcome_unknown',
    at: '2026-08-20T02:01:00.000Z',
  })
  assert.equal(networkStale.call.outcome, 'unknown')
  assert.equal(networkStale.call.sourceMode, 'stale')

  const replay = await fixture.store.reserve({
    requestId: randomUUID(),
    idempotencyKey: 'compat-stale-replay',
    fingerprint: FINGERPRINT,
    tenantId: fixture.tenant.id,
    consumerId: fixture.consumer.id,
    apiKeyId: randomUUID(),
    platform: 'telegram',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(Date.now() - 60_000),
    maxRequests: Number.POSITIVE_INFINITY,
  })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.request.deliverySourceMode, 'stale')
  assert.equal(replay.request.capturedAt, seeded.snapshot.capturedAt)
  assert.equal(replay.request.snapshotId, seeded.snapshot.id)
  assert.equal(seeded.snapshot.lastSuccessCallId, seedCall.id)
})

test('connector evidence accepts internal failures without creating a delivery', async () => {
  const fixture = await memoryFixture()
  const reservation = await reserve(fixture.store, fixture, 'compat-internal')
  const call = await begin(fixture.store, fixture.consumer.id, reservation.request.id)
  const finished = await fixture.store.finishConnectorCall(call.id, {
    outcome: 'failed',
    failureKind: 'internal',
    errorCode: 'response_redaction_failed',
  })
  assert.equal(finished.outcome, 'failed')
  assert.equal(finished.failureKind, 'internal')
  assert.equal((await fixture.store.getRequest(reservation.request.id)).status, 'reserved')
})

test('reservation lease reaping also closes a pending connector call as unknown', async () => {
  const fixture = await memoryFixture()
  const reservation = await reserve(fixture.store, fixture, 'compat-expired-call')
  const call = await begin(fixture.store, fixture.consumer.id, reservation.request.id)
  fixture.store.requests.get(reservation.request.id).leaseExpiresAt = new Date(Date.now() - 1_000).toISOString()

  assert.equal(await fixture.store.reapStaleReservations(), 1)
  assert.equal(fixture.store.requests.get(reservation.request.id).status, 'unknown')
  const closed = fixture.store.connectorCalls.get(call.id)
  assert.equal(closed.outcome, 'unknown')
  assert.equal(closed.failureKind, 'unknown')
  assert.equal(closed.errorCode, 'reservation_lease_expired')
  assert.ok(closed.completedAt)
})

test('PostgresStore lease reaper closes pending connector evidence in the same statement', async () => {
  let statement
  const store = new PostgresStore({
    async query(sql) {
      statement = sql
      return { rows: [{ reaped: 2 }] }
    },
  })
  assert.equal(await store.reapStaleReservations(), 2)
  assert.match(statement, /WITH reaped AS/)
  assert.match(statement, /UPDATE serving\.connector_calls call/)
  assert.match(statement, /call\.outcome IS NULL/)
  assert.match(statement, /failure_kind = 'unknown'/)
})

test('PostgresStore partial live delivery commits evidence and queue without touching last-good', async () => {
  const queries = []
  const callId = '11111111-1111-4111-8111-111111111111'
  const requestId = '22222222-2222-4222-8222-222222222222'
  const consumerId = '33333333-3333-4333-8333-333333333333'
  const capturedAt = new Date('2026-08-20T01:00:00.000Z')
  const responseBody = { code: 0, data: { warnings: ['partial'] } }
  const callRow = {
    id: callId,
    consumer_id: consumerId,
    usage_request_id: requestId,
    operation: OPERATION,
    request_fingerprint: FINGERPRINT,
    platform: 'telegram',
    source_mode: 'live',
    outcome: null,
    started_at: capturedAt,
    created_at: capturedAt,
  }
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/SELECT \* FROM serving\.connector_calls/.test(sql)) return { rows: [callRow] }
      if (/UPDATE usage_requests/.test(sql)) {
        return { rows: [{
          id: requestId,
          consumer_id: consumerId,
          status: 'committed',
          response_status: 200,
          response_body: responseBody,
          units_actual: 1,
          delivery_source_mode: 'live',
          response_captured_at: capturedAt,
          compatibility_snapshot_id: null,
          completed_at: capturedAt,
          created_at: capturedAt,
        }] }
      }
      if (/UPDATE serving\.connector_calls/.test(sql)) {
        return { rows: [{ ...callRow, outcome: 'partial', business_status: 'partial', completed_at: capturedAt }] }
      }
      if (/INSERT INTO mxq\.jobs/.test(sql)) return { rows: [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.commitCompatibilityLiveDelivery(callId, {
    outcome: 'partial',
    responseBody,
    capturedAt,
    businessStatus: 'partial',
    job: { queue: 'night-all-ingest', payload: { requestId }, dedupeKey: requestId },
  })

  assert.equal(result.snapshot, null)
  assert.equal(result.request.deliverySourceMode, 'live')
  assert.equal(result.request.snapshotId, null)
  assert.equal(queries.some(({ sql }) => /INSERT INTO serving\.compatibility_snapshots/.test(sql)), false)
  assert.equal(queries.some(({ sql }) => /INSERT INTO mxq\.jobs/.test(sql)), true)
  assert.deepEqual(queries.at(-1).sql, 'COMMIT')
})

test('PostgresStore complete live delivery updates snapshot in the same transaction', async () => {
  const queries = []
  const callId = '44444444-4444-4444-8444-444444444444'
  const requestId = '55555555-5555-4555-8555-555555555555'
  const consumerId = '66666666-6666-4666-8666-666666666666'
  const snapshotId = '77777777-7777-4777-8777-777777777777'
  const capturedAt = new Date('2026-08-20T01:00:00.000Z')
  const staleUntil = new Date('2026-08-20T03:00:00.000Z')
  const responseBody = { code: 0, data: { raw_data: [{ id: 'ok' }] } }
  const callRow = {
    id: callId, consumer_id: consumerId, usage_request_id: requestId,
    operation: OPERATION, request_fingerprint: FINGERPRINT, platform: 'telegram',
    source_mode: 'live', outcome: null, started_at: capturedAt, created_at: capturedAt,
  }
  const snapshotRow = {
    id: snapshotId, consumer_id: consumerId, operation: OPERATION,
    request_fingerprint: FINGERPRINT, platform: 'telegram', response_body: responseBody,
    captured_at: capturedAt, stale_until: staleUntil, last_success_call_id: callId,
    created_at: capturedAt, updated_at: capturedAt,
  }
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/SELECT \* FROM serving\.connector_calls/.test(sql)) return { rows: [callRow] }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] }
      if (/SELECT \* FROM serving\.compatibility_snapshots/.test(sql)) return { rows: [] }
      if (/INSERT INTO serving\.compatibility_snapshots/.test(sql)) return { rows: [snapshotRow] }
      if (/UPDATE usage_requests/.test(sql)) {
        return { rows: [{
          id: requestId, consumer_id: consumerId, status: 'committed', response_status: 200,
          response_body: responseBody, units_actual: 1, delivery_source_mode: 'live',
          response_captured_at: capturedAt, compatibility_snapshot_id: snapshotId,
          completed_at: capturedAt, created_at: capturedAt,
        }] }
      }
      if (/UPDATE serving\.connector_calls/.test(sql)) {
        return { rows: [{ ...callRow, outcome: 'complete', completed_at: capturedAt }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.commitCompatibilityLiveDelivery(callId, {
    outcome: 'complete', responseBody, capturedAt, staleUntil,
  })

  assert.equal(result.snapshot.id, snapshotId)
  assert.deepEqual(result.snapshot.responseBody, responseBody)
  assert.equal(result.snapshot.capturedAt, capturedAt.toISOString())
  assert.equal(result.request.snapshotId, snapshotId)
  assert.equal(queries.some(({ sql }) => /pg_advisory_xact_lock/.test(sql)), true)
  assert.match(queries.find(({ sql }) => /SELECT \* FROM serving\.compatibility_snapshots/.test(sql)).sql,
    /superseded_at IS NULL/)
  assert.deepEqual(queries.at(-1).sql, 'COMMIT')
})

test('PostgresStore stale delivery commits the immutable snapshot and failed evidence atomically', async () => {
  const queries = []
  const callId = '88888888-8888-4888-8888-888888888888'
  const requestId = '99999999-9999-4999-8999-999999999999'
  const consumerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const snapshotId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const capturedAt = new Date('2026-08-20T01:00:00.000Z')
  const deliveredAt = new Date('2026-08-20T02:00:00.000Z')
  const responseBody = { code: 0, data: { raw_data: [{ id: 'immutable' }] } }
  const callRow = {
    id: callId, consumer_id: consumerId, usage_request_id: requestId,
    operation: OPERATION, request_fingerprint: FINGERPRINT, platform: 'telegram',
    source_mode: 'live', outcome: null, started_at: capturedAt, created_at: capturedAt,
  }
  const snapshotRow = {
    id: snapshotId, consumer_id: consumerId, operation: OPERATION,
    request_fingerprint: FINGERPRINT, platform: 'telegram', response_body: responseBody,
    captured_at: capturedAt, stale_until: new Date('2026-08-20T04:00:00.000Z'),
    last_success_call_id: randomUUID(), superseded_at: new Date('2026-08-20T01:30:00.000Z'),
    created_at: capturedAt, updated_at: capturedAt,
  }
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/SELECT \* FROM serving\.connector_calls/.test(sql)) return { rows: [callRow] }
      if (/SELECT \* FROM serving\.compatibility_snapshots/.test(sql)) return { rows: [snapshotRow] }
      if (/UPDATE usage_requests/.test(sql)) {
        return { rows: [{
          id: requestId, consumer_id: consumerId, status: 'committed', response_status: 200,
          response_body: responseBody, units_actual: 1, delivery_source_mode: 'stale',
          response_captured_at: capturedAt, compatibility_snapshot_id: snapshotId,
          completed_at: deliveredAt, created_at: capturedAt,
        }] }
      }
      if (/UPDATE serving\.connector_calls/.test(sql)) {
        return { rows: [{
          ...callRow, outcome: 'failed', source_mode: 'stale', http_status: 503,
          failure_kind: 'http', error_code: 'upstream_unavailable', completed_at: deliveredAt,
        }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.commitCompatibilityStaleDelivery(callId, {
    snapshotId,
    failureKind: 'http',
    httpStatus: 503,
    errorCode: 'upstream_unavailable',
    at: deliveredAt,
  })

  assert.equal(result.request.deliverySourceMode, 'stale')
  assert.equal(result.request.snapshotId, snapshotId)
  assert.equal(result.request.capturedAt, capturedAt.toISOString())
  assert.deepEqual(result.request.responseBody, responseBody)
  assert.equal(result.call.outcome, 'failed')
  assert.equal(result.call.sourceMode, 'stale')
  assert.equal(result.snapshot.supersededAt, '2026-08-20T01:30:00.000Z')
  assert.equal(queries.some((sql) => /UPDATE serving\.compatibility_snapshots/.test(sql)), false)
  assert.equal(queries.at(-1), 'COMMIT')
})

test('PostgresStore refuses non-transient stale fallback before opening a transaction', async () => {
  const store = new PostgresStore({
    async connect() {
      throw new Error('transaction must not start')
    },
  })
  await assert.rejects(
    store.commitCompatibilityStaleDelivery(randomUUID(), {
      snapshotId: randomUUID(), failureKind: 'http', httpStatus: 401,
    }),
    (error) => error.code === 'compatibility_fallback_not_allowed',
  )
})

test('PostgresStore writes compatibility run, canonical revision, observation and outbox atomically', async () => {
  const queries = []
  const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const recordId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const requestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const connectorCallId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const record = {
    platform: 'telegram',
    objectType: 'post',
    externalId: 'post-1',
    payloadSha256: 'b'.repeat(64),
    rawItem: { content_id: 'post-1', text: 'hello' },
    parserVersion: 'mxih-external.v1:night-all-legacy.v1',
    contentType: null,
    url: null,
    title: null,
    body: 'hello',
    authorExternalId: 'user-1',
    authorName: 'Alice',
    eventTime: new Date('2026-08-20T00:00:00.000Z'),
    collectedAt: new Date('2026-08-20T00:01:00.000Z'),
    latitude: null,
    longitude: null,
    countryCode: null,
    admin1Code: null,
    admin2Code: null,
    stableFields: { metrics: { likes: 3 } },
    extensions: {},
    metrics: { likes: 3 },
    deletedAt: null,
  }
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/INSERT INTO ingest\.ingest_runs/.test(sql)) return { rows: [{ id: runId }], rowCount: 1 }
      if (/INSERT INTO ingest\.source_objects/.test(sql)) return { rows: [], rowCount: 1 }
      if (/INSERT INTO core\.canonical_records/.test(sql)) {
        return { rows: [{ id: recordId, current_revision: 1, projection_revision: 1 }], rowCount: 1 }
      }
      if (/INSERT INTO core\.record_revisions/.test(sql)) return { rows: [], rowCount: 1 }
      if (/INSERT INTO core\.observations/.test(sql)) return { rows: [], rowCount: 1 }
      if (/INSERT INTO outbox\.projection_events/.test(sql)) return { rows: [], rowCount: 1 }
      if (/UPDATE ingest\.ingest_runs/.test(sql)) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.ingestExternalRecords({
    datasetId: 'night-all.compat.v1',
    platform: 'telegram',
    records: [record],
    importRunId: null,
    connectorId: 'night-all-legacy',
    apiSearchLineage: { requestId, queryFingerprint: FINGERPRINT, connectorCallId },
  })

  assert.equal(result.runId, runId)
  assert.equal(result.ingested, 1)
  assert.equal(result.changed, 1)
  assert.equal(queries.at(-1).sql, 'COMMIT')

  const runInsert = queries.find(({ sql }) => /INSERT INTO ingest\.ingest_runs/.test(sql))
  assert.match(runInsert.sql, /trigger, request_id, query_fingerprint/)
  assert.match(runInsert.sql, /connector_call_id/)
  assert.deepEqual(runInsert.values.slice(3), [requestId, FINGERPRINT, connectorCallId])
  assert.match(queries.find(({ sql }) => /INSERT INTO ingest\.source_objects/.test(sql)).sql, /ingest_run_id/)
  assert.match(queries.find(({ sql }) => /INSERT INTO core\.record_revisions/.test(sql)).sql, /ingest_run_id/)

  const observation = queries.find(({ sql }) => /INSERT INTO core\.observations/.test(sql))
  assert.match(observation.sql, /source_event_id/)
  assert.equal(observation.values[3], `${connectorCallId}:post:post-1`)
  assert.equal(observation.values[4], FINGERPRINT)
  assert.equal(observation.values[8], runId)
  assert.match(observation.values[7], /^[0-9a-f]{64}$/)
  assert.ok(queries.findIndex(({ sql }) => /UPDATE ingest\.ingest_runs/.test(sql)) < queries.length - 1)
})

test('PostgresStore replays a finished connector-call ingest without touching canonical state', async () => {
  const queries = []
  const runId = randomUUID()
  const requestId = randomUUID()
  const connectorCallId = randomUUID()
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/INSERT INTO ingest\.ingest_runs/.test(sql)) return { rows: [], rowCount: 0 }
      if (/FROM ingest\.ingest_runs/.test(sql)) {
        return { rows: [{
          id: runId,
          request_id: requestId,
          query_fingerprint: FINGERPRINT,
          item_count: 2,
          finished_at: new Date(),
        }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.ingestExternalRecords({
    datasetId: 'night-all.compat.v1', platform: 'telegram', records: [],
    importRunId: null, connectorId: 'night-all-legacy',
    apiSearchLineage: { requestId, queryFingerprint: FINGERPRINT, connectorCallId },
  })

  assert.deepEqual(result, {
    ingested: 2, changed: 0, deleted: 0, rowCount: 2, replayed: true, runId,
  })
  assert.equal(queries.some((sql) => /canonical_records|core\.observations/.test(sql)), false)
  assert.equal(queries.at(-1), 'COMMIT')
})

test('Data Center record detail links the latest observation to request and connector call', async () => {
  let detailSql
  const store = new PostgresStore({
    async query(sql) {
      detailSql = sql
      return { rows: [{
        id: randomUUID(), dataset_id: 'night-all.compat.v1', platform: 'telegram',
        object_type: 'post', external_id: 'post-1', current_revision: 1,
        projection_revision: 1, observation_id: 'observation-1',
        observation_ingest_run_id: 'run-1', observation_connector_id: 'night-all-legacy',
        observation_source_event_id: 'call-1:post:post-1',
        observation_query_fingerprint: FINGERPRINT,
        observation_request_id: 'request-1', connector_call_id: 'call-1',
        connector_operation: 'raw',
      }] }
    },
  })
  const [record] = await store.dataCenterRecordsByIds([randomUUID()])

  assert.deepEqual(record.lineage.latestObservation, {
    id: 'observation-1',
    ingestRunId: 'run-1',
    connectorId: 'night-all-legacy',
    sourceEventId: 'call-1:post:post-1',
    queryFingerprint: FINGERPRINT,
    requestId: 'request-1',
    connectorCallId: 'call-1',
    operation: 'raw',
  })
  assert.match(detailSql, /LEFT JOIN LATERAL/)
  assert.match(detailSql, /JOIN ingest\.ingest_runs observation_run/)
  assert.match(detailSql, /JOIN serving\.connector_calls connector_call/)
})

test('migration defines exact snapshot identity, evidence, and replay metadata', async () => {
  const sql = await readFile(new URL('../../migrations/031_night_all_compatibility_cache.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serving\.connector_calls/)
  assert.match(sql, /outcome IN \('complete', 'partial', 'failed', 'unknown'\)/)
  assert.match(sql, /upstream_request_id text/)
  assert.match(sql, /upstream_trace_id text/)
  assert.match(sql, /compatibility_snapshots_current_key_idx/)
  assert.match(sql, /WHERE superseded_at IS NULL/)
  assert.match(sql, /delivery_source_mode text/)
  assert.match(sql, /response_captured_at timestamptz/)
  assert.match(sql, /compatibility_snapshot_id uuid/)
  assert.match(sql, /connector_call_id uuid/)
  assert.match(sql, /ingest_runs_connector_call_idx/)

  const worker = await readFile(new URL('../../server/workers/ingest.mjs', import.meta.url), 'utf8')
  assert.match(worker, /apiSearchLineage:\s*\{/)
  assert.match(worker, /requestId: payload\.requestId/)
  assert.match(worker, /queryFingerprint: payload\.queryFingerprint/)
  assert.match(worker, /connectorCallId: payload\.connectorCallId/)
})
