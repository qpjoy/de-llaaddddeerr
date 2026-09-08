import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MemoryExternalPlatformStore,
  PostgresExternalPlatformStore,
} from '../../server/external-platforms/store.mjs'

const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)
const SNAPSHOT_FINGERPRINT = 'c'.repeat(64)
const OPERATION = 'ecommerce.products.search'
const JD_ENDPOINT_KEY = 'jd.product-search.v1'
const TAOBAO_ENDPOINT_KEY = 'taobao-tmall.product-search.v1'
const ENDPOINT_KEY = JD_ENDPOINT_KEY
const CONTRACT_V1 = 'justone.product-search.v1'
const CONTRACT_V2 = 'justone.product-search.v2'

test('migration 053 adds one durable uncertain-retry edge without rewriting existing calls', async () => {
  const sql = await readFile(
    new URL('../../migrations/053_external_platform_uncertain_retry.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /ADD COLUMN IF NOT EXISTS retry_of_usage_request_id uuid/u)
  assert.match(sql, /REFERENCES usage_requests\(id\) ON DELETE RESTRICT/u)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS external_platform_provider_calls_retry_of_idx/u)
  assert.match(sql, /WHERE retry_of_usage_request_id IS NOT NULL/u)
  assert.doesNotMatch(sql, /^\s*(?:UPDATE|DELETE FROM|TRUNCATE)\b/imu)
})

test('migration 055 preserves rolling writers and adds multi-call and shared rate-bucket state', async () => {
  const sql = await readFile(
    new URL('../../migrations/055_external_platform_multi_call_rate_limit.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /ADD COLUMN IF NOT EXISTS call_ordinal integer NOT NULL DEFAULT 0/u)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS dispatch_fingerprint char\(64\)/u)
  assert.match(sql, /BEFORE INSERT ON external_platform\.provider_calls/u)
  assert.match(sql, /NEW\.dispatch_fingerprint := NEW\.request_fingerprint/u)
  assert.match(sql, /\(usage_request_id, call_ordinal\)/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS external_platform\.provider_rate_buckets/u)
  assert.match(sql, /last_admitted boolean NOT NULL/u)
  assert.doesNotMatch(sql, /provider_rate_windows/u)
})

function callInput(overrides = {}) {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    consumerId: randomUUID(),
    apiKeyId: randomUUID(),
    usageRequestId: randomUUID(),
    operation: OPERATION,
    contractVersion: 'mx-insight-hub.ecommerce-products.v1',
    endpointKey: ENDPOINT_KEY,
    endpointVersion: 'v1',
    marketplace: 'jd',
    fingerprint: FINGERPRINT,
    ...overrides,
  }
}

function reservedUsage(input, overrides = {}) {
  return {
    id: input.usageRequestId,
    tenantId: input.tenantId,
    consumerId: input.consumerId,
    apiKeyId: input.apiKeyId,
    fingerprint: input.fingerprint,
    platform: 'ecommerce',
    status: 'reserved',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

function stagedEvidence(input, overrides = {}) {
  const capturedAt = '2026-09-08T04:05:06.789Z'
  const capturedDate = capturedAt.slice(0, 10)
  const responseHash = 'd'.repeat(64)
  const itemHash = 'e'.repeat(64)
  const rawPayload = { code: 200, request_id: 'provider-request-1', data: { items: [{ id: 'item-1' }] } }
  return {
    callId: input.id,
    delivery: { ...input },
    httpStatus: 200,
    businessCode: 200,
    billed: true,
    costMinor: 5,
    costKind: 'estimated',
    currency: 'CNY',
    latencyMs: 31,
    itemCount: 1,
    errorCode: null,
    responseArchive: {
      contractState: 'accepted',
      httpStatus: 200,
      businessCode: 200,
      contentType: 'application/json',
      bodySize: 123,
      payloadSha256: responseHash,
      rawPayload,
      capturedAt,
    },
    upstreamEvidence: { requestId: 'provider-request-1', recordTime: '1700000000' },
    archiveObjects: [{
      kind: 'response',
      marketplace: input.marketplace,
      endpointVersion: input.endpointVersion,
      capturedDate,
      archivePath: `external/justone/${capturedDate}/responses/${responseHash}.json`,
      envelopePointer: '$',
      sourceKey: responseHash,
      payloadSha256: responseHash,
      rawPayload,
    }, {
      kind: 'item',
      marketplace: input.marketplace,
      endpointVersion: input.endpointVersion,
      capturedDate,
      archivePath: `external/justone/${capturedDate}/items/${itemHash}.json`,
      envelopePointer: '$.data.items[0]',
      sourceKey: 'item-1',
      payloadSha256: itemHash,
      rawPayload: { id: 'item-1' },
    }],
    ...overrides,
  }
}

function providerCallRow(input, evidence = null, outcome = 'pending') {
  return {
    id: input.id,
    provider_key: 'justone',
    tenant_id: input.tenantId,
    consumer_id: input.consumerId,
    usage_request_id: input.usageRequestId,
    operation: input.operation,
    request_fingerprint: input.fingerprint,
    outcome,
    http_status: evidence?.responseArchive?.httpStatus ?? evidence?.httpStatus ?? null,
    business_code: evidence?.responseArchive?.businessCode ?? evidence?.businessCode ?? null,
    upstream_request_id: evidence?.upstreamEvidence?.requestId ?? null,
    upstream_record_time: evidence?.upstreamEvidence?.recordTime ?? null,
    billed: evidence?.billed ?? null,
    cost_minor: evidence?.costMinor ?? null,
    cost_kind: evidence?.costKind ?? 'unknown',
    currency: evidence?.currency ?? null,
    latency_ms: evidence?.latencyMs ?? null,
    item_count: evidence?.itemCount ?? null,
    error_code: evidence?.errorCode ?? null,
    response_archive_id: evidence?.responseArchive ? 'response-archive-1' : null,
    archive_contract_state: evidence?.responseArchive?.contractState ?? null,
    archive_http_status: evidence?.responseArchive?.httpStatus ?? null,
    archive_business_code: evidence?.responseArchive?.businessCode ?? null,
    archive_content_type: evidence?.responseArchive?.contentType ?? null,
    archive_body_size: evidence?.responseArchive?.bodySize ?? null,
    archive_payload_sha256: evidence?.responseArchive?.payloadSha256 ?? null,
    archive_raw_payload: evidence?.responseArchive?.rawPayload ?? null,
    archive_captured_at: evidence?.responseArchive?.capturedAt ?? null,
  }
}

function archiveObjectRows(input, evidence) {
  return evidence.archiveObjects.map((object, itemOrdinal) => ({
    provider_key: 'justone',
    object_kind: object.kind,
    marketplace: object.marketplace,
    operation: input.operation,
    endpoint_version: object.endpointVersion,
    captured_date: object.capturedDate,
    archive_path: object.archivePath,
    response_pointer: object.envelopePointer,
    source_key: object.sourceKey,
    payload_sha256: object.payloadSha256,
    raw_payload: object.rawPayload,
    item_ordinal: itemOrdinal,
  }))
}

test('memory provider token bucket refills continuously instead of resetting at a wall-clock boundary', async () => {
  const store = new MemoryExternalPlatformStore({ usageStore: { requests: new Map() } })
  const startedAt = new Date('2026-09-08T00:00:59.900Z')

  assert.deepEqual(await store.acquireProviderRateLimit({
    limit: 2, windowMs: 60_000, at: startedAt,
  }), { allowed: true, remaining: 1, retryAfterMs: 0 })
  assert.deepEqual(await store.acquireProviderRateLimit({
    limit: 2, windowMs: 60_000, at: startedAt,
  }), { allowed: true, remaining: 0, retryAfterMs: 0 })

  const justAcrossMinute = await store.acquireProviderRateLimit({
    limit: 2,
    windowMs: 60_000,
    at: new Date(startedAt.getTime() + 200),
  })
  assert.equal(justAcrossMinute.allowed, false)
  assert.ok(justAcrossMinute.retryAfterMs >= 29_799 && justAcrossMinute.retryAfterMs <= 29_801)

  const refilled = await store.acquireProviderRateLimit({
    limit: 2,
    windowMs: 60_000,
    at: new Date(startedAt.getTime() + 30_001),
  })
  assert.equal(refilled.allowed, true)
  assert.equal(refilled.remaining, 0)
  assert.equal(refilled.retryAfterMs, 0)
})

test('Postgres provider token bucket is one atomic PostgreSQL-clock-driven admission', async () => {
  let statement
  const store = new PostgresExternalPlatformStore({
    pool: {
      async query(sql, values) {
        statement = { sql, values }
        return { rows: [{ allowed: false, remaining: '0', retry_after_ms: '1234' }] }
      },
    },
  })

  assert.deepEqual(await store.acquireProviderRateLimit({ limit: 90, windowMs: 60_000 }), {
    allowed: false,
    remaining: 0,
    retryAfterMs: 1234,
  })
  assert.deepEqual(statement.values, ['justone', 90, 60_000])
  assert.match(statement.sql, /SELECT clock_timestamp\(\) AS observed_at/u)
  assert.match(statement.sql, /INSERT INTO external_platform\.provider_rate_buckets/u)
  assert.match(statement.sql, /ON CONFLICT \(provider_key\) DO UPDATE/u)
  assert.match(statement.sql, /last_admitted/u)
  assert.doesNotMatch(statement.sql, /window_start/u)
})

test('memory beginProviderCall requires one live owned ecommerce reservation', async () => {
  const input = callInput()
  const usageStore = { requests: new Map([[input.usageRequestId, reservedUsage(input)]]) }
  const store = new MemoryExternalPlatformStore({ usageStore })

  const call = await store.beginProviderCall(input)
  assert.equal(call.id, input.id)
  assert.equal(call.outcome, 'pending')
  assert.equal(call.callOrdinal, 0)
  assert.equal(call.callRole, 'primary')
  assert.equal(call.dispatchFingerprint, input.fingerprint)

  await assert.rejects(
    store.beginProviderCall({ ...input, id: randomUUID() }),
    (error) => error?.code === 'external_platform_call_exists',
  )

  const enrichment = await store.beginProviderCall({
    ...input,
    id: randomUUID(),
    callOrdinal: 1,
    callRole: 'enrichment',
    dispatchFingerprint: OTHER_FINGERPRINT,
  })
  assert.equal(enrichment.callOrdinal, 1)
  assert.equal(enrichment.callRole, 'enrichment')
  assert.equal(enrichment.dispatchFingerprint, OTHER_FINGERPRINT)
  await assert.rejects(
    store.beginProviderCall({
      ...input,
      id: randomUUID(),
      callOrdinal: 1,
      dispatchFingerprint: OTHER_FINGERPRINT,
    }),
    (error) => error?.code === 'external_platform_call_exists',
  )
  await assert.rejects(
    store.beginProviderCall({ ...input, id: randomUUID(), callOrdinal: 2, callRole: 'other' }),
    /callRole must be primary or enrichment/u,
  )
  await assert.rejects(
    store.beginProviderCall({ ...input, id: randomUUID(), callOrdinal: 2, dispatchFingerprint: 'bad' }),
    /dispatchFingerprint must be a lowercase SHA-256 fingerprint/u,
  )

  const wrongPlatform = callInput()
  usageStore.requests.set(
    wrongPlatform.usageRequestId,
    reservedUsage(wrongPlatform, { platform: 'telegram' }),
  )
  await assert.rejects(
    store.beginProviderCall(wrongPlatform),
    (error) => error?.code === 'external_platform_usage_scope_mismatch',
  )

  const expired = callInput()
  usageStore.requests.set(
    expired.usageRequestId,
    reservedUsage(expired, { leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() }),
  )
  await assert.rejects(
    store.beginProviderCall(expired),
    (error) => error?.code === 'external_platform_usage_scope_mismatch',
  )
})

test('memory stages paid provider evidence exactly once without settling usage or derived state', async () => {
  const input = callInput()
  const usage = reservedUsage(input)
  const usageStore = { requests: new Map([[input.usageRequestId, usage]]) }
  const store = new MemoryExternalPlatformStore({ usageStore })
  await store.beginProviderCall(input)
  const evidence = stagedEvidence(input)
  const exactReplay = structuredClone(evidence)

  assert.deepEqual(await store.stageProviderEvidence(evidence), {
    staged: true,
    reconciled: false,
    alreadySettled: false,
  })
  assert.deepEqual(await store.stageProviderEvidence(exactReplay), {
    staged: true,
    reconciled: true,
    alreadySettled: false,
  })
  const call = store.calls.get(input.id)
  assert.equal(call.outcome, 'pending')
  assert.equal(call.billed, true)
  assert.equal(call.httpStatus, 200)
  assert.equal(call.itemCount, 1)
  assert.equal(store.responseArchives.size, 1)
  assert.equal(store.snapshots.size, 0)
  assert.equal(store.ingestJobs.length, 0)
  assert.equal(store.requests.length, 0)
  assert.equal(usage.status, 'reserved')

  evidence.archiveObjects[0].rawPayload.code = 500
  assert.equal(store.responseArchives.get(input.id).rawPayload.code, 200)
  assert.equal(call.archiveObjects[0].rawPayload.code, 200)
  await assert.rejects(
    store.stageProviderEvidence({ ...exactReplay, costMinor: 6 }),
    (error) => error?.status === 409 && error?.code === 'external_platform_evidence_conflict',
  )
  await assert.rejects(
    store.stageProviderEvidence({
      ...exactReplay,
      archiveObjects: [...exactReplay.archiveObjects].reverse(),
    }),
    (error) => error?.status === 409 && error?.code === 'external_platform_evidence_conflict',
  )
  await assert.rejects(
    store.stageProviderEvidence({
      ...exactReplay,
      delivery: { ...exactReplay.delivery, consumerId: randomUUID() },
    }),
    (error) => error?.status === 409 && error?.code === 'external_platform_evidence_conflict',
  )

  usage.status = 'unknown'
  usage.errorCode = 'reservation_lease_expired'
  assert.equal(await store.reapStaleCalls(), 1)
  assert.equal(call.outcome, 'unknown')
  assert.equal(call.billed, true)
  assert.equal(call.archiveObjects.length, 2)
  assert.equal(store.responseArchives.get(input.id).payloadSha256, 'd'.repeat(64))
  assert.equal((await store.stageProviderEvidence(exactReplay)).alreadySettled, true)
})

test('memory validates a complete stage receipt before mutating a provider call', async () => {
  const input = callInput()
  const usageStore = {
    requests: new Map([[input.usageRequestId, reservedUsage(input)]]),
  }
  const store = new MemoryExternalPlatformStore({ usageStore })
  await store.beginProviderCall(input)
  const invalid = stagedEvidence(input)
  invalid.archiveObjects[1].capturedDate = '2026-09-07'

  await assert.rejects(
    store.stageProviderEvidence(invalid),
    (error) => error?.code === 'external_platform_archive_date_invalid',
  )
  const call = store.calls.get(input.id)
  assert.equal(call.outcome, 'pending')
  assert.equal(call.billed, undefined)
  assert.equal(call.stagedEvidence, undefined)
  assert.equal(store.responseArchives.size, 0)
})

test('memory provider-call audit records an unknown retry target only once and in scope', async () => {
  const first = callInput()
  const retryOfRequestId = randomUUID()
  const retryTarget = reservedUsage(first, {
    id: retryOfRequestId,
    status: 'unknown',
    leaseExpiresAt: null,
  })
  const usageStore = {
    requests: new Map([
      [retryOfRequestId, retryTarget],
      [first.usageRequestId, reservedUsage(first)],
    ]),
  }
  const store = new MemoryExternalPlatformStore({ usageStore })

  const created = await store.beginProviderCall({ ...first, retryOfRequestId })
  assert.equal(created.retryOfRequestId, retryOfRequestId)

  const second = callInput({
    tenantId: first.tenantId,
    consumerId: first.consumerId,
    apiKeyId: first.apiKeyId,
    fingerprint: first.fingerprint,
  })
  usageStore.requests.set(second.usageRequestId, reservedUsage(second))
  await assert.rejects(
    store.beginProviderCall({ ...second, retryOfRequestId }),
    (error) => error?.code === 'uncertain_retry_not_allowed',
  )

  const otherConsumer = callInput({
    tenantId: first.tenantId,
    apiKeyId: first.apiKeyId,
    fingerprint: first.fingerprint,
  })
  usageStore.requests.set(otherConsumer.usageRequestId, reservedUsage(otherConsumer))
  await assert.rejects(
    store.beginProviderCall({ ...otherConsumer, retryOfRequestId }),
    (error) => error?.code === 'uncertain_retry_not_allowed',
  )
})

test('endpoint contract quarantine is global while unknown fingerprints remain consumer-local', async () => {
  const store = new MemoryExternalPlatformStore({
    usageStore: { requests: new Map() },
    uncertainCooldownMs: 60_000,
  })
  store.calls.set('unusable', {
    id: 'unusable',
    consumerId: 'consumer-a',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    outcome: 'succeeded_unusable',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })

  const quarantined = await store.acquireDispatchLease({
    consumerId: 'consumer-b',
    operation: OPERATION,
    fingerprint: OTHER_FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
  })
  assert.equal(quarantined.kind, 'blocked')
  assert.equal(quarantined.reason, 'succeeded_unusable')

  store.calls.clear()
  store.calls.set('unknown', {
    id: 'unknown',
    consumerId: 'consumer-a',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    outcome: 'unknown',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const independentConsumer = await store.acquireDispatchLease({
    consumerId: 'consumer-b',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
  })
  assert.deepEqual(independentConsumer, { kind: 'acquired' })
})

test('endpoint upgrade releases Taobao V1 quarantine while unchanged JD V1 stays blocked', async () => {
  const store = new MemoryExternalPlatformStore({
    usageStore: { requests: new Map() },
    uncertainCooldownMs: 60_000,
  })
  store.calls.set('unusable-v1', {
    id: 'unusable-v1',
    consumerId: 'consumer-a',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: TAOBAO_ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    outcome: 'succeeded_unusable',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })

  const upgraded = await store.acquireDispatchLease({
    consumerId: 'consumer-b',
    operation: OPERATION,
    fingerprint: OTHER_FINGERPRINT,
    endpointKey: TAOBAO_ENDPOINT_KEY,
    contractVersion: CONTRACT_V2,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
  })

  assert.deepEqual(upgraded, { kind: 'acquired' })

  store.calls.set('jd-unusable-v1', {
    id: 'jd-unusable-v1',
    consumerId: 'consumer-a',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: JD_ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    outcome: 'succeeded_unusable',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const unchanged = await store.acquireDispatchLease({
    consumerId: 'consumer-b',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: JD_ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
  })

  assert.equal(unchanged.kind, 'blocked')
  assert.equal(unchanged.reason, 'succeeded_unusable')
})

test('memory dispatch lease bypasses only the exact referenced unknown request', async () => {
  const consumerId = randomUUID()
  const retryOfRequestId = randomUUID()
  const completedAt = new Date().toISOString()
  const acquire = (store) => store.acquireDispatchLease({
    consumerId,
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
    retryOfRequestId,
  })
  const storeWith = (...calls) => {
    const store = new MemoryExternalPlatformStore({
      usageStore: { requests: new Map() },
      uncertainCooldownMs: 60_000,
    })
    for (const call of calls) store.calls.set(call.id, call)
    return store
  }
  const exactUnknown = {
    id: 'exact-unknown',
    usageRequestId: retryOfRequestId,
    consumerId,
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    dispatchFingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    outcome: 'unknown',
    startedAt: completedAt,
    completedAt,
  }

  assert.deepEqual(await acquire(storeWith(exactUnknown)), { kind: 'acquired' })

  const anotherUnknown = {
    ...exactUnknown,
    id: 'another-unknown',
    usageRequestId: randomUUID(),
  }
  const unknownBlocked = await acquire(storeWith(exactUnknown, anotherUnknown))
  assert.equal(unknownBlocked.kind, 'blocked')
  assert.equal(unknownBlocked.reason, 'unknown')

  const pendingBlocked = await acquire(storeWith({
    ...exactUnknown,
    id: 'pending',
    outcome: 'pending',
    completedAt: null,
  }))
  assert.equal(pendingBlocked.kind, 'blocked')
  assert.equal(pendingBlocked.reason, 'pending')

  const unusableBlocked = await acquire(storeWith({
    ...exactUnknown,
    id: 'unusable',
    consumerId: randomUUID(),
    fingerprint: OTHER_FINGERPRINT,
    outcome: 'succeeded_unusable',
  }))
  assert.equal(unusableBlocked.kind, 'blocked')
  assert.equal(unusableBlocked.reason, 'succeeded_unusable')
})

test('Postgres dispatch lease excludes only the referenced unknown usage request', async () => {
  const retryOfRequestId = randomUUID()
  const queries = []
  const completedAt = new Date('2026-09-03T00:00:00.000Z')
  const store = new PostgresExternalPlatformStore({
    pool: {
      async query(sql, values) {
        queries.push({ sql, values })
        if (/INSERT INTO external_platform\.dispatch_leases/u.test(sql)) {
          return { rows: [] }
        }
        if (/SELECT outcome, error_code, completed_at/u.test(sql)) {
          return {
            rows: [{
              outcome: 'unknown',
              error_code: null,
              completed_at: completedAt,
              blocked_until: new Date(completedAt.getTime() + 60_000),
            }],
          }
        }
        throw new Error(`unexpected SQL: ${sql}`)
      },
    },
    uncertainCooldownMs: 60_000,
  })

  const result = await store.acquireDispatchLease({
    consumerId: randomUUID(),
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    contractVersion: CONTRACT_V1,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
    retryOfRequestId,
  })

  assert.equal(result.kind, 'blocked')
  assert.equal(result.reason, 'unknown')
  assert.equal(queries[0].values[7], retryOfRequestId)
  assert.equal(queries[0].values[8], CONTRACT_V1)
  assert.equal(queries[0].values[9], 'justone')
  assert.match(queries[0].sql, /call\.provider_key = \$10/u)
  assert.match(
    queries[0].sql,
    /call\.dispatch_fingerprint = \$3[\s\S]*?call\.dispatch_fingerprint IS NULL[\s\S]*?call\.request_fingerprint = \$3/u,
  )
  assert.match(
    queries[0].sql,
    /call\.outcome = 'unknown'[\s\S]*?call\.usage_request_id <> \$8/u,
  )
  assert.match(queries[0].sql, /call\.outcome = 'pending'/u)
  assert.match(
    queries[0].sql,
    /call\.endpoint_key = \$7[\s\S]*?call\.contract_version = \$9[\s\S]*?call\.outcome = 'succeeded_unusable'/u,
  )
  assert.match(queries[0].sql, /call\.error_code IS DISTINCT FROM 'upstream_note_unavailable'/u)
  assert.equal(queries[1].values[5], retryOfRequestId)
  assert.equal(queries[1].values[6], CONTRACT_V1)
  assert.equal(queries[1].values[7], 'justone')
  assert.match(queries[1].sql, /WHERE provider_key = \$8/u)
  assert.match(
    queries[1].sql,
    /dispatch_fingerprint = \$3[\s\S]*?dispatch_fingerprint IS NULL[\s\S]*?request_fingerprint = \$3/u,
  )
  assert.match(
    queries[1].sql,
    /outcome = 'unknown'[\s\S]*?usage_request_id <> \$6/u,
  )
  assert.match(
    queries[1].sql,
    /endpoint_key = \$5[\s\S]*?contract_version = \$7[\s\S]*?outcome = 'succeeded_unusable'/u,
  )
  assert.match(queries[1].sql, /error_code IS DISTINCT FROM 'upstream_note_unavailable'/u)
})

test('Postgres beginProviderCall locks and inserts only its owned reservation', async () => {
  const input = callInput()
  const queries = []
  let releasedWith
  const startedAt = new Date('2026-09-03T00:00:00.000Z')
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (/WITH owned_request AS MATERIALIZED/u.test(sql)) {
        return { rows: [{ id: input.id, started_at: startedAt }], rowCount: 1 }
      }
      if (/UPDATE external_platform\.provider_state/u.test(sql)) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query() { throw new Error('reconciliation must not run') },
    },
  })

  assert.deepEqual(await store.beginProviderCall(input), {
    id: input.id,
    startedAt: startedAt.toISOString(),
  })
  const inserted = queries.find(({ sql }) => /WITH owned_request AS MATERIALIZED/u.test(sql))
  assert.equal(inserted.values.length, 17)
  assert.match(inserted.sql, /request\.id = \$5[\s\S]*?request\.status = 'reserved'/u)
  assert.match(inserted.sql, /request\.tenant_id = \$2[\s\S]*?request\.consumer_id = \$3/u)
  assert.match(inserted.sql, /request\.api_key_id = \$4[\s\S]*?request\.fingerprint = \$11/u)
  assert.match(inserted.sql, /request\.platform = \$14/u)
  assert.match(inserted.sql, /request\.lease_expires_at > now\(\)/u)
  assert.match(inserted.sql, /retry_of_usage_request_id/u)
  assert.equal(inserted.values[11], null)
  assert.equal(inserted.values[12], 'justone')
  assert.equal(inserted.values[13], 'ecommerce')
  assert.equal(inserted.values[14], 0)
  assert.equal(inserted.values[15], 'primary')
  assert.equal(inserted.values[16], input.fingerprint)
  assert.match(inserted.sql, /SELECT \$1, \$13, \$2/u)
  assert.match(inserted.sql, /call_ordinal, call_role,[\s\S]*?dispatch_fingerprint/u)
  assert.match(inserted.sql, /FOR UPDATE[\s\S]*?INSERT INTO external_platform\.provider_calls/u)
  assert.equal(queries.at(-1).sql, 'COMMIT')
  assert.equal(releasedWith, null)
})

test('Postgres provider-call insert validates and persists uncertain retry lineage', async () => {
  const input = callInput({ retryOfRequestId: randomUUID() })
  let inserted
  const startedAt = new Date('2026-09-03T00:00:00.000Z')
  const client = {
    async query(sql, values) {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/WITH owned_request AS MATERIALIZED/u.test(sql)) {
        inserted = { sql, values }
        return { rows: [{ id: input.id, started_at: startedAt }] }
      }
      if (/UPDATE external_platform\.provider_state/u.test(sql)) return { rows: [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query() { throw new Error('reconciliation must not run') },
    },
  })

  await store.beginProviderCall(input)

  assert.equal(inserted.values[11], input.retryOfRequestId)
  assert.match(inserted.sql, /retry\.id = \$12/u)
  assert.match(inserted.sql, /retry\.status = 'unknown'/u)
  assert.match(inserted.sql, /retry\.tenant_id = \$2/u)
  assert.match(inserted.sql, /retry\.consumer_id = \$3/u)
  assert.match(inserted.sql, /retry\.fingerprint = \$11/u)
  assert.match(inserted.sql, /retry\.platform = \$14/u)
  assert.equal(inserted.values[12], 'justone')
  assert.equal(inserted.values[13], 'ecommerce')
  assert.match(inserted.sql, /previous_retry\.retry_of_usage_request_id = retry\.id/u)
  assert.match(inserted.sql, /request_fingerprint, retry_of_usage_request_id/u)
  assert.match(inserted.sql, /\$12::uuid IS NULL OR EXISTS \(SELECT 1 FROM retry_target\)/u)
})

test('Postgres beginProviderCall reconciles a lost COMMIT only with the full owned pending call', async () => {
  const input = callInput()
  const queries = []
  const commitError = new Error('lost COMMIT acknowledgement')
  const startedAt = new Date('2026-09-03T00:00:00.000Z')
  let releasedWith
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql === 'BEGIN') return { rows: [] }
      if (/WITH owned_request AS MATERIALIZED/u.test(sql)) {
        return { rows: [{ id: input.id, started_at: startedAt }] }
      }
      if (/UPDATE external_platform\.provider_state/u.test(sql)) return { rows: [] }
      if (sql === 'COMMIT') throw commitError
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  let reconciliation
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query(sql, values) {
        reconciliation = { sql, values }
        return { rows: [{ id: input.id, started_at: startedAt }] }
      },
    },
  })

  assert.equal((await store.beginProviderCall(input)).id, input.id)
  assert.equal(releasedWith, commitError)
  assert.equal(queries.includes('ROLLBACK'), false)
  assert.deepEqual(reconciliation.values, [
    input.id, input.tenantId, input.consumerId, input.apiKeyId, input.usageRequestId,
    input.operation, input.contractVersion, input.endpointKey,
    input.endpointVersion, input.marketplace, input.fingerprint,
    null, 'justone', 'ecommerce', 0, 'primary', input.fingerprint,
  ])
  for (const pattern of [
    /call\.tenant_id = \$2/u,
    /call\.consumer_id = \$3/u,
    /call\.api_key_id = \$4/u,
    /call\.usage_request_id = \$5/u,
    /call\.operation = \$6/u,
    /call\.contract_version = \$7/u,
    /call\.endpoint_key = \$8/u,
    /call\.endpoint_version = \$9/u,
    /call\.marketplace = \$10/u,
    /call\.request_fingerprint = \$11/u,
    /call\.retry_of_usage_request_id IS NOT DISTINCT FROM \$12::uuid/u,
    /call\.provider_key = \$13/u,
    /call\.outcome = 'pending'/u,
    /request\.status = 'reserved'/u,
    /request\.platform = \$14/u,
    /call\.call_ordinal = \$15/u,
    /call\.call_role = \$16/u,
    /call\.dispatch_fingerprint = \$17/u,
  ]) assert.match(reconciliation.sql, pattern)
})

test('Postgres beginProviderCall fails closed when a lost COMMIT cannot be reconciled', async () => {
  const input = callInput()
  const commitError = new Error('lost begin-call COMMIT acknowledgement')
  let releasedWith = null
  const statements = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql === 'BEGIN') return { rows: [] }
      if (/WITH owned_request AS MATERIALIZED/u.test(sql)) {
        return { rows: [{ id: input.id, started_at: new Date() }] }
      }
      if (/UPDATE external_platform\.provider_state/u.test(sql)) return { rows: [] }
      if (sql === 'COMMIT') throw commitError
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query() { throw new Error('reconciliation connection unavailable') },
    },
  })

  await assert.rejects(
    store.beginProviderCall(input),
    (error) => error?.status === 503
      && error?.code === 'external_platform_call_persistence_unknown',
  )
  assert.equal(releasedWith, commitError)
  assert.equal(statements.includes('ROLLBACK'), false)
})

test('Postgres beginProviderCall maps a duplicate call ordinal to the stable store conflict', async () => {
  const input = callInput({ callOrdinal: 1, callRole: 'enrichment' })
  const duplicate = Object.assign(new Error('duplicate provider-call ordinal'), {
    code: '23505',
    constraint: 'external_platform_provider_calls_usage_ordinal_idx',
  })
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (/WITH owned_request AS MATERIALIZED/u.test(sql)) throw duplicate
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query() { return { rows: [] } },
    },
  })

  await assert.rejects(
    store.beginProviderCall(input),
    (error) => error?.status === 409 && error?.code === 'external_platform_call_exists',
  )
})

test('Postgres call reaper closes pending calls whose reservation became unknown', async () => {
  let statement
  const store = new PostgresExternalPlatformStore({
    pool: {
      async query(sql) {
        statement = sql
        return { rows: [{ id: randomUUID() }, { id: randomUUID() }] }
      },
    },
  })

  assert.equal(await store.reapStaleCalls(), 2)
  assert.match(statement, /UPDATE external_platform\.provider_calls call SET/u)
  assert.match(statement, /FROM usage_requests request/u)
  assert.match(statement, /call\.outcome = 'pending'/u)
  assert.match(statement, /request\.status = 'unknown'/u)
  assert.match(statement, /outcome = 'unknown'/u)
  assert.match(statement, /RETURNING call\.id/u)
})

test('Postgres stageProviderEvidence reconciles a lost COMMIT without duplicating paid evidence', async () => {
  const input = callInput()
  const evidence = stagedEvidence(input)
  const commitError = new Error('lost stage COMMIT acknowledgement')
  const statements = []
  let workingEvidence = null
  let durableEvidence = null
  let releasedWith = null

  const queryState = (sql, currentEvidence) => {
    if (/SELECT call\.\*/u.test(sql)) {
      return { rows: [providerCallRow(input, currentEvidence)] }
    }
    if (/FROM external_platform\.archive_objects/u.test(sql)) {
      return { rows: currentEvidence ? archiveObjectRows(input, currentEvidence) : [] }
    }
    throw new Error(`unexpected state SQL: ${sql}`)
  }
  const client = {
    async query(sql, values) {
      statements.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql === 'COMMIT') {
        durableEvidence = structuredClone(workingEvidence)
        throw commitError
      }
      if (/SELECT call\.\*/u.test(sql) || /FROM external_platform\.archive_objects/u.test(sql)) {
        return queryState(sql, workingEvidence)
      }
      if (/UPDATE external_platform\.provider_calls SET/u.test(sql)) {
        workingEvidence = structuredClone(evidence)
        return { rows: [{ id: input.id }] }
      }
      if (/INSERT INTO external_platform\.(?:response_archives|archive_objects)/u.test(sql)) {
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  let poolReads = 0
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query(sql) {
        poolReads += 1
        return queryState(sql, durableEvidence)
      },
    },
  })

  assert.deepEqual(await store.stageProviderEvidence(evidence), {
    staged: true,
    reconciled: true,
    alreadySettled: false,
  })
  assert.equal(releasedWith, commitError)
  assert.equal(statements.filter(({ sql }) => sql === 'BEGIN').length, 1)
  assert.equal(statements.some(({ sql }) => sql === 'ROLLBACK'), false)
  assert.equal(poolReads, 2)
  assert.equal(statements.filter(({ sql }) => /INSERT INTO external_platform\.response_archives/u.test(sql)).length, 1)
  assert.equal(statements.filter(({ sql }) => /INSERT INTO external_platform\.archive_objects/u.test(sql)).length, 2)
  for (const forbidden of [/usage_requests/u, /gateway_requests/u, /response_snapshots/u, /mxq\.jobs/u]) {
    assert.equal(statements.some(({ sql }) => forbidden.test(sql)), false)
  }
})

test('Postgres stageProviderEvidence rejects a conflicting durable receipt without mutation', async () => {
  const input = callInput()
  const evidence = stagedEvidence(input)
  const existing = stagedEvidence(input, { costMinor: 9 })
  const statements = []
  const client = {
    async query(sql, values) {
      statements.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (/SELECT call\.\*/u.test(sql)) return { rows: [providerCallRow(input, existing)] }
      if (/FROM external_platform\.archive_objects/u.test(sql)) {
        return { rows: archiveObjectRows(input, existing) }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query(sql) {
        if (/SELECT call\.\*/u.test(sql)) return { rows: [providerCallRow(input, existing)] }
        if (/FROM external_platform\.archive_objects/u.test(sql)) {
          return { rows: archiveObjectRows(input, existing) }
        }
        throw new Error(`unexpected reconciliation SQL: ${sql}`)
      },
    },
  })

  await assert.rejects(
    store.stageProviderEvidence(evidence),
    (error) => error?.status === 409 && error?.code === 'external_platform_evidence_conflict',
  )
  assert.equal(statements.some(({ sql }) => /UPDATE external_platform\.provider_calls/u.test(sql)), false)
  assert.equal(statements.some(({ sql }) => /INSERT INTO external_platform\./u.test(sql)), false)
  assert.equal(statements.at(-1).sql, 'ROLLBACK')
})

test('Postgres analytics counts calls whose billing outcome is indeterminate', async () => {
  let callTotalsSql
  let trendSql
  let tenantTotalsSql
  const store = new PostgresExternalPlatformStore({
    pool: {
      async query(sql) {
        if (/FROM external_platform\.gateway_requests[\s\S]*?WHERE provider_key/u.test(sql)
          && !/WITH requests AS/u.test(sql)
          && !/JOIN tenants/u.test(sql)) {
          return { rows: [{
            hub_requests: 0,
            successful_hub_requests: 0,
            fresh_cache: 0,
            stored_fallback: 0,
            stored_fallback_without_dispatch: 0,
            stored_fallback_after_dispatch: 0,
            idempotent_replay: 0,
            duplicate_suppressed: 0,
            circuit_rejected: 0,
          }] }
        }
        if (/percentile_cont/u.test(sql)) {
          callTotalsSql = sql
          return { rows: [{
            upstream_calls: 2,
            successful_upstream_calls: 0,
            usable_upstream_calls: 0,
            unusable_successes: 0,
            billed_calls: 0,
            indeterminate_billing_calls: 2,
            unknown_outcomes: 2,
            p95_latency_ms: null,
            known_cost_minor: null,
            unknown_cost_calls: 0,
            last_call_at: null,
            last_success_at: null,
          }] }
        }
        if (/WITH request_totals AS/u.test(sql)) {
          tenantTotalsSql = sql
          return { rows: [{
            id: 'tenant-a',
            name: 'Tenant A',
            hub_requests: 1,
            succeeded: 1,
            upstream_calls: 3,
            cost_minor: '15',
          }] }
        }
        if (/WITH requests AS/u.test(sql)) {
          trendSql = sql
          return { rows: [] }
        }
        if (/FROM external_platform\.provider_state/u.test(sql)) return { rows: [] }
        return { rows: [] }
      },
    },
  })

  const analytics = await store.analytics({ from: new Date('2026-09-01T00:00:00.000Z') })
  assert.equal(analytics.totals.indeterminateBillingCalls, 2)
  assert.equal(analytics.totals.usableUpstreamCalls, 0)
  assert.match(callTotalsSql, /outcome IN \('succeeded', 'succeeded_unusable'\)[\s\S]*?AS successful_upstream_calls/u)
  assert.match(callTotalsSql, /outcome = 'succeeded'\)::integer AS usable_upstream_calls/u)
  assert.match(callTotalsSql, /count\(\*\) FILTER \(WHERE billed IS NULL\)::integer AS indeterminate_billing_calls/u)
  assert.equal(analytics.tenants[0].upstreamCalls, 3)
  assert.equal(analytics.tenants[0].knownCostMinor, 15)
  assert.match(trendSql, /FULL OUTER JOIN calls USING \(bucket\)/u)
  assert.match(trendSql, /coalesce\(requests\.hub_requests, 0\)/u)
  assert.match(tenantTotalsSql, /FROM external_platform\.provider_calls/u)
  assert.match(tenantTotalsSql, /GROUP BY tenant_id/u)
})

test('memory analytics separates provider success from Hub-usable success', async () => {
  const store = new MemoryExternalPlatformStore({ usageStore: { requests: new Map() } })
  const now = new Date().toISOString()
  for (const [id, outcome] of [
    ['usable', 'succeeded'],
    ['provider-success-only', 'succeeded_unusable'],
    ['rejected', 'rejected'],
  ]) {
    store.calls.set(id, {
      id,
      outcome,
      billed: outcome !== 'rejected',
      costMinor: outcome === 'rejected' ? 0 : 5,
      startedAt: now,
      completedAt: now,
    })
  }

  const analytics = await store.analytics({ from: new Date(Date.now() - 60_000) })
  assert.equal(analytics.totals.upstreamCalls, 3)
  assert.equal(analytics.totals.successfulUpstreamCalls, 2)
  assert.equal(analytics.totals.usableUpstreamCalls, 1)
  assert.equal(analytics.totals.unusableSuccesses, 1)
})

test('memory tenant analytics counts every provider call in a multi-call request', async () => {
  const store = new MemoryExternalPlatformStore({ usageStore: { requests: new Map() } })
  const tenantId = randomUUID()
  const now = new Date().toISOString()
  store.requests.push({
    tenantId,
    tenantName: 'Tenant A',
    succeeded: true,
    sourceMode: 'live',
    providerCallId: 'primary',
    createdAt: now,
  })
  for (const [id, costMinor] of [['primary', 5], ['detail', 7]]) {
    store.calls.set(id, {
      id,
      tenantId,
      outcome: 'succeeded',
      billed: true,
      costMinor,
      latencyMs: 10,
      startedAt: now,
      completedAt: now,
    })
  }

  const analytics = await store.analytics({ from: new Date(Date.now() - 60_000) })
  assert.equal(analytics.tenants[0].hubRequests, 1)
  assert.equal(analytics.tenants[0].upstreamCalls, 2)
  assert.equal(analytics.tenants[0].knownCostMinor, 12)
})

test('memory live delivery shares a snapshot fingerprint while retaining request identity and end-to-end latency', async () => {
  const input = callInput()
  const secondUsageRequestId = randomUUID()
  const committed = []
  const usageStore = {
    requests: new Map([
      [input.usageRequestId, reservedUsage(input)],
      [secondUsageRequestId, reservedUsage({ ...input, usageRequestId: secondUsageRequestId })],
    ]),
    async commitRequest(id, evidence) {
      committed.push({ id, evidence })
      this.requests.get(id).status = 'committed'
    },
  }
  const store = new MemoryExternalPlatformStore({ usageStore })
  const call = await store.beginProviderCall(input)
  const capturedAt = new Date('2026-09-08T01:00:00.000Z')
  const snapshotBody = { data: { items: [{ id: 'note-1' }] } }
  const delivery = { ...input, snapshotFingerprint: SNAPSHOT_FINGERPRINT }

  await store.commitLiveDelivery({
    callId: call.id,
    delivery,
    responseBody: { ...snapshotBody, requestId: input.usageRequestId },
    snapshotBody,
    capturedAt,
    freshUntil: new Date(capturedAt.getTime() + 60_000),
    staleUntil: new Date(capturedAt.getTime() + 120_000),
    itemCount: 1,
    latencyMs: 12,
    usageLatencyMs: 34,
    billed: true,
    costMinor: 5,
    costKind: 'estimated',
    currency: 'CNY',
  })

  assert.equal(store.calls.get(call.id).latencyMs, 12)
  assert.equal(committed[0].evidence.upstreamLatencyMs, 34)
  assert.equal(committed[0].evidence.deliverySourceMode, 'live')
  assert.equal(committed[0].evidence.capturedAt, capturedAt.toISOString())
  const shared = await store.snapshotFor({
    consumerId: input.consumerId,
    operation: input.operation,
    fingerprint: OTHER_FINGERPRINT,
    snapshotFingerprint: SNAPSHOT_FINGERPRINT,
  }, capturedAt)
  assert.equal(shared.fingerprint, SNAPSHOT_FINGERPRINT)

  await assert.rejects(
    store.commitSnapshotDelivery({
      delivery: {
        ...delivery,
        usageRequestId: secondUsageRequestId,
        fingerprint: OTHER_FINGERPRINT,
        snapshotFingerprint: FINGERPRINT,
      },
      snapshot: shared,
      sourceMode: 'fresh_cache',
    }),
    (error) => error?.code === 'external_platform_snapshot_unavailable',
  )
  assert.equal(committed.length, 1)

  await store.commitSnapshotDelivery({
    delivery: {
      ...delivery,
      usageRequestId: secondUsageRequestId,
      fingerprint: OTHER_FINGERPRINT,
    },
    snapshot: shared,
    sourceMode: 'fresh_cache',
  })
  assert.equal(committed[1].id, secondUsageRequestId)
  assert.equal(committed[1].evidence.deliverySourceMode, 'live')
  assert.equal(committed[1].evidence.capturedAt, shared.capturedAt)
  assert.equal(store.requests.at(-1).fingerprint, OTHER_FINGERPRINT)
})

test('memory failure fallback locks the snapshot by its shared fingerprint', async () => {
  const input = callInput()
  const commits = []
  const usageStore = {
    requests: new Map([[input.usageRequestId, reservedUsage(input)]]),
    async commitRequest(id, evidence) { commits.push({ id, evidence }) },
  }
  const store = new MemoryExternalPlatformStore({ usageStore })
  const call = await store.beginProviderCall(input)
  const snapshot = {
    id: randomUUID(),
    responseBody: { data: { items: [{ id: 'cached' }] } },
    capturedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 60_000).toISOString(),
    staleUntil: new Date(Date.now() + 120_000).toISOString(),
  }
  store.snapshots.set(
    `${input.consumerId}\u0000${input.operation}\u0000${SNAPSHOT_FINGERPRINT}`,
    snapshot,
  )
  const failure = {
    callId: call.id,
    delivery: { ...input, snapshotFingerprint: OTHER_FINGERPRINT },
    outcome: 'rejected',
    httpStatus: 429,
    businessCode: null,
    billed: false,
    latencyMs: 10,
    errorCode: 'upstream_rate_limited',
    affectsCircuit: false,
    snapshot,
  }

  await assert.rejects(
    store.finishFailure(failure),
    (error) => error?.code === 'external_platform_snapshot_unavailable',
  )
  assert.equal(store.calls.get(call.id).outcome, 'pending')
  assert.equal(commits.length, 0)

  await store.finishFailure({
    ...failure,
    delivery: { ...input, snapshotFingerprint: SNAPSHOT_FINGERPRINT },
  })
  assert.equal(commits.length, 1)
  assert.equal(commits[0].evidence.deliverySourceMode, 'stale')
  assert.equal(commits[0].evidence.capturedAt, snapshot.capturedAt)
  assert.equal(store.requests.at(-1).fingerprint, FINGERPRINT)
  assert.equal(store.requests.at(-1).snapshotId, snapshot.id)
})

test('memory finishProviderStep settles enrichment, cache, circuit and ingest without committing usage', async () => {
  const input = callInput({
    operation: 'social.posts.resolve',
    contractVersion: 'tikhub.xiaohongshu-detail.v1',
    endpointKey: 'tikhub.xiaohongshu-detail.v1',
    marketplace: 'xiaohongshu',
  })
  let usageCommits = 0
  const usageStore = {
    requests: new Map([[input.usageRequestId, reservedUsage(input)]]),
    async commitRequest() { usageCommits += 1 },
  }
  usageStore.requests.get(input.usageRequestId).platform = 'ecommerce'
  const store = new MemoryExternalPlatformStore({ usageStore })
  const call = await store.beginProviderCall({
    ...input,
    callOrdinal: 1,
    callRole: 'enrichment',
    dispatchFingerprint: OTHER_FINGERPRINT,
  })
  store.state.consecutiveFailures = 2
  const capturedAt = new Date('2026-09-08T02:00:00.000Z')

  const result = await store.finishProviderStep({
    callId: call.id,
    delivery: { ...input, snapshotFingerprint: SNAPSHOT_FINGERPRINT },
    outcome: 'succeeded',
    httpStatus: 200,
    businessCode: 0,
    billed: true,
    costMinor: 5,
    costKind: 'estimated',
    currency: 'CNY',
    latencyMs: 20,
    itemCount: 1,
    snapshot: {
      responseBody: { data: { id: 'note-1', body: 'full body' } },
      capturedAt,
      freshUntil: new Date(capturedAt.getTime() + 60_000),
      staleUntil: new Date(capturedAt.getTime() + 120_000),
    },
    ingestJob: {
      payload: { kind: 'external-platform-result' },
      dedupeKey: `external-platform:justone:${call.id}`,
    },
  })

  assert.equal(store.calls.get(call.id).outcome, 'succeeded')
  assert.equal(result.snapshot.fingerprint, SNAPSHOT_FINGERPRINT)
  assert.equal(store.state.consecutiveFailures, 0)
  assert.equal(store.ingestJobs.length, 1)
  assert.equal(usageCommits, 0)
  assert.equal(store.requests.length, 0)
})

test('Postgres finishProviderStep persists only provider-step evidence and uses the shared snapshot key', async () => {
  const input = callInput({ operation: 'social.posts.resolve' })
  const capturedAt = new Date('2026-09-08T03:00:00.000Z')
  const queries = []
  let settled = false
  let storedSnapshot = null
  let storedIngestJob = null
  const settlement = {
    callId: input.id,
    delivery: { ...input, snapshotFingerprint: SNAPSHOT_FINGERPRINT },
    outcome: 'succeeded',
    latencyMs: 20,
    itemCount: 1,
    snapshot: {
      responseBody: { data: { id: 'note-1' } },
      capturedAt,
      freshUntil: new Date(capturedAt.getTime() + 60_000),
      staleUntil: new Date(capturedAt.getTime() + 120_000),
    },
    ingestJob: { payload: { records: [] }, dedupeKey: `step:${input.id}` },
  }
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/SELECT call\.\*/u.test(sql)) {
        return { rows: [providerCallRow(input, settled ? settlement : null, settled ? 'succeeded' : 'pending')] }
      }
      if (/FROM external_platform\.archive_objects/u.test(sql)) return { rows: [] }
      if (/FROM external_platform\.response_snapshots/u.test(sql)) {
        return { rows: storedSnapshot ? [storedSnapshot] : [] }
      }
      if (/FROM mxq\.jobs/u.test(sql)) {
        return { rows: storedIngestJob ? [storedIngestJob] : [] }
      }
      if (/UPDATE external_platform\.provider_calls SET/u.test(sql)) {
        settled = true
        return { rows: [{ id: input.id }] }
      }
      if (/INSERT INTO external_platform\.response_snapshots/u.test(sql)) {
        storedSnapshot = {
          id: randomUUID(),
          provider_key: 'justone',
          consumer_id: input.consumerId,
          operation: input.operation,
          request_fingerprint: SNAPSHOT_FINGERPRINT,
          response_body: { data: { id: 'note-1' } },
          captured_at: capturedAt,
          fresh_until: new Date(capturedAt.getTime() + 60_000),
          stale_until: new Date(capturedAt.getTime() + 120_000),
          last_success_call_id: input.id,
        }
        return { rows: [storedSnapshot] }
      }
      if (/UPDATE external_platform\.provider_state/u.test(sql)) return { rows: [] }
      if (/INSERT INTO mxq\.jobs/u.test(sql)) {
        storedIngestJob = {
          queue: 'mx-insight-hub:ingest',
          payload: settlement.ingestJob.payload,
          dedupe_key: settlement.ingestJob.dedupeKey,
          priority: 100,
        }
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query() { throw new Error('reconciliation must not run') },
    },
  })

  const result = await store.finishProviderStep(settlement)

  assert.equal(result.snapshot.fingerprint, SNAPSHOT_FINGERPRINT)
  const snapshotInsert = queries.find(({ sql }) => /INSERT INTO external_platform\.response_snapshots/u.test(sql))
  assert.equal(snapshotInsert.values[3], SNAPSHOT_FINGERPRINT)
  assert.equal(queries.some(({ sql }) => /UPDATE usage_requests/u.test(sql)), false)
  assert.equal(queries.some(({ sql }) => /gateway_requests/u.test(sql)), false)
  assert.equal(queries.some(({ sql }) => /INSERT INTO mxq\.jobs/u.test(sql)), true)
  assert.equal(queries.at(-1).sql, 'COMMIT')
})

test('Postgres finishProviderStep can terminalize staged detail evidence as unknown without changing it', async () => {
  const input = callInput({ operation: 'social.posts.resolve' })
  const evidence = stagedEvidence(input)
  const settlement = {
    ...evidence,
    outcome: 'unknown',
    affectsCircuit: false,
  }
  let terminal = false
  const statements = []
  const client = {
    async query(sql) {
      statements.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/SELECT call\.\*/u.test(sql)) {
        return { rows: [providerCallRow(input, evidence, terminal ? 'unknown' : 'pending')] }
      }
      if (/FROM external_platform\.archive_objects/u.test(sql)) {
        return { rows: archiveObjectRows(input, evidence) }
      }
      if (/UPDATE external_platform\.provider_calls SET/u.test(sql)) {
        terminal = true
        return { rows: [{ id: input.id }] }
      }
      if (/INSERT INTO external_platform\.(?:response_archives|archive_objects)/u.test(sql)) {
        return { rows: [] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query() { throw new Error('reconciliation must not run') },
    },
  })

  await store.finishProviderStep(settlement)
  assert.equal(terminal, true)
  assert.equal(statements.filter((sql) => /UPDATE external_platform\.provider_calls/u.test(sql)).length, 1)
  assert.equal(statements.at(-1), 'COMMIT')
})

test('Postgres finishProviderStep reconciles a committed terminal step after its COMMIT acknowledgement is lost', async () => {
  const input = callInput({ operation: 'social.posts.resolve' })
  const evidence = stagedEvidence(input)
  const capturedAt = new Date(evidence.responseArchive.capturedAt)
  const settlement = {
    ...evidence,
    outcome: 'succeeded',
    affectsCircuit: false,
    snapshot: {
      responseBody: { data: { item: { externalId: 'item-1', text: 'full body' } } },
      capturedAt,
      freshUntil: new Date(capturedAt.getTime() + 60_000),
      staleUntil: new Date(capturedAt.getTime() + 120_000),
    },
    ingestJob: {
      payload: { providerCallId: input.id, records: [{ externalId: 'item-1' }] },
      dedupeKey: `external-platform:justone:${input.id}`,
      priority: 100,
    },
  }
  const commitError = new Error('lost finish COMMIT acknowledgement')
  const statements = []
  let workingSettled = false
  let workingSnapshot = null
  let workingJob = null
  let durable = false
  let releasedWith = null

  const stateQuery = (sql, isDurable) => {
    const visible = isDurable || workingSettled
    if (/SELECT call\.\*/u.test(sql)) {
      return { rows: [providerCallRow(input, visible ? settlement : null, visible ? 'succeeded' : 'pending')] }
    }
    if (/FROM external_platform\.archive_objects/u.test(sql)) {
      return { rows: visible ? archiveObjectRows(input, settlement) : [] }
    }
    if (/FROM external_platform\.response_snapshots/u.test(sql)) {
      return { rows: (isDurable ? durable : workingSnapshot) ? [{
        id: 'snapshot-1',
        provider_key: 'justone',
        consumer_id: input.consumerId,
        operation: input.operation,
        request_fingerprint: input.fingerprint,
        response_body: settlement.snapshot.responseBody,
        captured_at: settlement.snapshot.capturedAt,
        fresh_until: settlement.snapshot.freshUntil,
        stale_until: settlement.snapshot.staleUntil,
        last_success_call_id: input.id,
      }] : [] }
    }
    if (/FROM mxq\.jobs/u.test(sql)) {
      return { rows: (isDurable ? durable : workingJob) ? [{
        queue: 'mx-insight-hub:ingest',
        payload: settlement.ingestJob.payload,
        dedupe_key: settlement.ingestJob.dedupeKey,
        priority: 100,
      }] : [] }
    }
    throw new Error(`unexpected state SQL: ${sql}`)
  }
  const client = {
    async query(sql, values) {
      statements.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] }
      if (sql === 'COMMIT') {
        durable = true
        throw commitError
      }
      if (/SELECT call\.\*/u.test(sql)
        || /FROM external_platform\.archive_objects/u.test(sql)
        || /FROM external_platform\.response_snapshots/u.test(sql)
        || /FROM mxq\.jobs/u.test(sql)) return stateQuery(sql, false)
      if (/UPDATE external_platform\.provider_calls SET/u.test(sql)) {
        workingSettled = true
        return { rows: [{ id: input.id }] }
      }
      if (/INSERT INTO external_platform\.(?:response_archives|archive_objects)/u.test(sql)) {
        return { rows: [] }
      }
      if (/INSERT INTO external_platform\.response_snapshots/u.test(sql)) {
        workingSnapshot = true
        return stateQuery('FROM external_platform.response_snapshots', false)
      }
      if (/INSERT INTO mxq\.jobs/u.test(sql)) {
        workingJob = true
        return { rows: [] }
      }
      if (/UPDATE external_platform\.provider_state/u.test(sql)) return { rows: [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release(error) { releasedWith = error },
  }
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() { return client },
      async query(sql) { return stateQuery(sql, true) },
    },
  })

  const result = await store.finishProviderStep(settlement)
  assert.equal(result.reconciled, true)
  assert.equal(result.snapshot.lastSuccessCallId, input.id)
  assert.equal(releasedWith, commitError)
  assert.equal(statements.filter(({ sql }) => sql === 'BEGIN').length, 1)
  assert.equal(statements.some(({ sql }) => sql === 'ROLLBACK'), false)
})

test('Postgres finishProviderStep retries once only after reconciliation proves the call is still pending', async () => {
  const input = callInput({ operation: 'social.posts.resolve' })
  const settlement = {
    callId: input.id,
    delivery: input,
    outcome: 'rejected',
    httpStatus: 503,
    businessCode: 503,
    billed: false,
    costMinor: null,
    costKind: 'unknown',
    currency: null,
    latencyMs: 19,
    itemCount: 0,
    errorCode: 'upstream_business_error',
    affectsCircuit: false,
  }
  let connectCount = 0
  let terminal = false
  const clientStatements = [[], []]
  const clients = [0, 1].map((clientIndex) => ({
    async query(sql) {
      clientStatements[clientIndex].push(sql)
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] }
      if (/SELECT call\.\*/u.test(sql)) {
        return { rows: [providerCallRow(input, terminal ? settlement : null, terminal ? 'rejected' : 'pending')] }
      }
      if (/FROM external_platform\.archive_objects/u.test(sql)) return { rows: [] }
      if (/UPDATE external_platform\.provider_calls SET/u.test(sql)) {
        if (clientIndex === 0) throw new Error('explicit write failure')
        terminal = true
        return { rows: [{ id: input.id }] }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }))
  const store = new PostgresExternalPlatformStore({
    pool: {
      async connect() {
        const client = clients[connectCount]
        connectCount += 1
        return client
      },
      async query(sql) {
        if (/SELECT call\.\*/u.test(sql)) {
          return { rows: [providerCallRow(input, null, 'pending')] }
        }
        if (/FROM external_platform\.archive_objects/u.test(sql)) return { rows: [] }
        throw new Error(`unexpected reconciliation SQL: ${sql}`)
      },
    },
  })

  await store.finishProviderStep(settlement)
  assert.equal(connectCount, 2)
  assert.equal(clientStatements[0].filter((sql) => sql === 'ROLLBACK').length, 1)
  assert.equal(clientStatements[1].filter((sql) => sql === 'COMMIT').length, 1)
  assert.equal(clientStatements.flat().filter((sql) => /UPDATE external_platform\.provider_calls/u.test(sql)).length, 2)
})

test('gateway request insert has exactly twelve positional values in contract order', async () => {
  let inserted
  const store = new PostgresExternalPlatformStore({
    pool: {
      async query(sql, values) {
        inserted = { sql, values }
        return { rows: [] }
      },
    },
  })
  const delivery = {
    tenantId: randomUUID(),
    consumerId: randomUUID(),
    usageRequestId: randomUUID(),
    fingerprint: FINGERPRINT,
  }

  await store.recordGatewayAttempt({
    delivery,
    sourceMode: 'unavailable',
    succeeded: false,
    status: 503,
    errorCode: 'upstream_unavailable',
  })

  assert.equal(Math.max(...[...inserted.sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]))), 12)
  assert.equal(inserted.values.length, 12)
  assert.deepEqual(inserted.values.slice(1), [
    delivery.tenantId,
    delivery.consumerId,
    delivery.usageRequestId,
    delivery.fingerprint,
    'unavailable',
    false,
    503,
    null,
    null,
    'upstream_unavailable',
    'justone',
  ])
  assert.match(inserted.sql, /\(id, provider_key, tenant_id/u)
  assert.match(inserted.sql, /VALUES \(\$1, \$12, \$2/u)
})

test('known provider failures atomically commit stable error responses', async () => {
  const input = callInput()
  const queries = []
  const client = {
    async query(sql, values) {
      queries.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (/UPDATE external_platform\.provider_calls/u.test(sql)) return { rows: [{ id: input.id }] }
      if (/UPDATE usage_requests/u.test(sql)) return { rows: [{ id: input.usageRequestId }] }
      if (/INSERT INTO external_platform\.gateway_requests/u.test(sql)) return { rows: [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({
    pool: { async connect() { return client } },
  })
  const responseBody = {
    error: { code: 'invalid_marketplace', message: 'Marketplace is unsupported' },
  }

  await store.finishFailure({
    callId: input.id,
    delivery: input,
    outcome: 'rejected',
    httpStatus: 400,
    businessCode: 40001,
    billed: false,
    latencyMs: 12,
    errorCode: 'invalid_marketplace',
    failureResponseStatus: 400,
    failureResponseBody: responseBody,
    affectsCircuit: false,
  })

  const usage = queries.find(({ sql }) => /UPDATE usage_requests/u.test(sql))
  assert.match(usage.sql, /status = 'committed'/u)
  assert.match(usage.sql, /error_code = \$6/u)
  assert.match(usage.sql, /RETURNING id/u)
  assert.equal(usage.values[0], input.usageRequestId)
  assert.equal(usage.values[1], 400)
  assert.deepEqual(usage.values[2], responseBody)
  assert.equal(usage.values[5], 'invalid_marketplace')
  assert.equal(queries.at(-1).sql, 'COMMIT')

  const unusableBody = {
    error: { code: 'external_platform_response_unusable', message: 'Response could not be normalized' },
  }
  const beforeUnusable = queries.length
  await store.finishFailure({
    callId: randomUUID(),
    delivery: { ...input, usageRequestId: randomUUID() },
    outcome: 'succeeded_unusable',
    httpStatus: 200,
    businessCode: 0,
    billed: true,
    latencyMs: 18,
    errorCode: 'invalid_upstream_contract',
    failureResponseStatus: 502,
    failureResponseBody: unusableBody,
    affectsCircuit: false,
  })

  const unusableUsage = queries.slice(beforeUnusable).find(({ sql }) => /UPDATE usage_requests/u.test(sql))
  assert.match(unusableUsage.sql, /status = 'committed'/u)
  assert.equal(unusableUsage.values[1], 502)
  assert.deepEqual(unusableUsage.values[2], unusableBody)
  assert.equal(queries.at(-1).sql, 'COMMIT')
})
