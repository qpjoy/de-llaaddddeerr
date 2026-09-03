import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  MemoryExternalPlatformStore,
  PostgresExternalPlatformStore,
} from '../../server/external-platforms/store.mjs'

const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)
const OPERATION = 'ecommerce.products.search'
const ENDPOINT_KEY = 'jd.product-search.v1'

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
    outcome: 'succeeded_unusable',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })

  const quarantined = await store.acquireDispatchLease({
    consumerId: 'consumer-b',
    operation: OPERATION,
    fingerprint: OTHER_FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
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
    outcome: 'unknown',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const independentConsumer = await store.acquireDispatchLease({
    consumerId: 'consumer-b',
    operation: OPERATION,
    fingerprint: FINGERPRINT,
    endpointKey: ENDPOINT_KEY,
    ownerRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 30_000),
  })
  assert.deepEqual(independentConsumer, { kind: 'acquired' })
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
  assert.equal(inserted.values.length, 11)
  assert.match(inserted.sql, /request\.id = \$5[\s\S]*?request\.status = 'reserved'/u)
  assert.match(inserted.sql, /request\.tenant_id = \$2[\s\S]*?request\.consumer_id = \$3/u)
  assert.match(inserted.sql, /request\.api_key_id = \$4[\s\S]*?request\.fingerprint = \$11/u)
  assert.match(inserted.sql, /request\.platform = 'ecommerce'/u)
  assert.match(inserted.sql, /request\.lease_expires_at > now\(\)/u)
  assert.match(inserted.sql, /FOR UPDATE[\s\S]*?INSERT INTO external_platform\.provider_calls/u)
  assert.equal(queries.at(-1).sql, 'COMMIT')
  assert.equal(releasedWith, null)
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
    /call\.outcome = 'pending'/u,
    /request\.status = 'reserved'/u,
    /request\.platform = 'ecommerce'/u,
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

test('gateway request insert has exactly eleven positional values in contract order', async () => {
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

  assert.equal(Math.max(...[...inserted.sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]))), 11)
  assert.equal(inserted.values.length, 11)
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
  ])
})

test('definite provider rejection atomically commits the stable error response', async () => {
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
})
