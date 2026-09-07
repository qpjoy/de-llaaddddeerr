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

test('memory beginProviderCall requires one live owned ecommerce reservation', async () => {
  const input = callInput()
  const usageStore = { requests: new Map([[input.usageRequestId, reservedUsage(input)]]) }
  const store = new MemoryExternalPlatformStore({ usageStore })

  const call = await store.beginProviderCall(input)
  assert.equal(call.id, input.id)
  assert.equal(call.outcome, 'pending')

  await assert.rejects(
    store.beginProviderCall({ ...input, id: randomUUID() }),
    (error) => error?.code === 'external_platform_call_exists',
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
  assert.equal(inserted.values.length, 14)
  assert.match(inserted.sql, /request\.id = \$5[\s\S]*?request\.status = 'reserved'/u)
  assert.match(inserted.sql, /request\.tenant_id = \$2[\s\S]*?request\.consumer_id = \$3/u)
  assert.match(inserted.sql, /request\.api_key_id = \$4[\s\S]*?request\.fingerprint = \$11/u)
  assert.match(inserted.sql, /request\.platform = \$14/u)
  assert.match(inserted.sql, /request\.lease_expires_at > now\(\)/u)
  assert.match(inserted.sql, /retry_of_usage_request_id/u)
  assert.equal(inserted.values[11], null)
  assert.equal(inserted.values[12], 'justone')
  assert.equal(inserted.values[13], 'ecommerce')
  assert.match(inserted.sql, /SELECT \$1, \$13, \$2/u)
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
    null, 'justone', 'ecommerce',
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
  ]) assert.match(reconciliation.sql, pattern)
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

test('Postgres analytics counts calls whose billing outcome is indeterminate', async () => {
  let callTotalsSql
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
