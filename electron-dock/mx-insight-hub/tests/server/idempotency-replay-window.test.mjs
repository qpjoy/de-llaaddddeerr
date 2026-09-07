import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const CONSUMER = '33333333-3333-4333-8333-333333333333'

/**
 * Drive `reserve` against one pre-existing committed request selected by its
 * stable idempotency binding.
 *
 * Only the branch under test is modelled: the advisory lock, quota check and
 * transaction control all return empty result sets, which is what the real
 * statements yield when they succeed.
 */
function storeWithCommittedRequest({ completedAt }) {
  const statements = []
  const committed = {
    id: '44444444-4444-4444-8444-444444444444',
    consumer_id: CONSUMER,
    api_key_id: '77777777-7777-4777-8777-777777777777',
    idempotency_key: 'search-abc12345',
    fingerprint: 'fp-1',
    status: 'committed',
    response_status: 200,
    response_body: { data: { items: ['stale'] } },
    completed_at: completedAt,
  }
  const client = {
    async query(sql, values) {
      statements.push(sql.trim())
      if (sql.includes('FROM api_keys api_key_record')) {
        return { rows: [{ max_requests: 1_000, window_seconds: 3_600 }] }
      }
      if (sql.includes('FROM consumer_plan_assignments assignment')) {
        return {
          rows: [{
            plan_key: 'launch-1m', plan_status: 'active', version_status: 'published',
            limits: {}, assigned_at: new Date(0), period_start: new Date(0),
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('count(*)')) return { rows: [{ count: '0' }] }
      if (sql.includes('FROM usage_idempotency_bindings binding')) return { rows: [committed] }
      if (sql.startsWith('INSERT INTO usage_requests')) {
        return {
          rows: [{
            ...committed,
            id: values[0],
            status: 'reserved',
            response_status: null,
            response_body: null,
            completed_at: null,
          }],
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  return {
    store: new PostgresStore({ async connect() { return client } }),
    statements,
  }
}

function input(overrides = {}) {
  return {
    requestId: '55555555-5555-4555-8555-555555555555',
    idempotencyKey: 'search-abc12345',
    fingerprint: 'fp-1',
    tenantId: '66666666-6666-4666-8666-666666666666',
    consumerId: CONSUMER,
    apiKeyId: '77777777-7777-4777-8777-777777777777',
    platform: 'telegram',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 30_000),
    windowStart: new Date(Date.now() - 3_600_000),
    maxRequests: 1_000,
    ...overrides,
  }
}

test('a retry inside the window still replays the stored response', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 5_000) })
  const reservation = await store.reserve(input({ replayWindowMs: 120_000 }))
  // This is the case an Idempotency-Key exists for: a duplicate delivery must
  // not search or charge twice.
  assert.equal(reservation.kind, 'replay')
  assert.deepEqual(reservation.request.responseBody, { data: { items: ['stale'] } })
})

test('the same key asked again much later re-executes against current data', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 3_600_000) })
  const reservation = await store.reserve(input({ replayWindowMs: 120_000 }))
  // An hour later the corpus has moved; returning the frozen answer would make
  // the key a cache rather than a retry guard.
  assert.equal(reservation.kind, 'reserved')
  assert.equal(reservation.request.id, '55555555-5555-4555-8555-555555555555')
  assert.notEqual(reservation.request.id, '44444444-4444-4444-8444-444444444444')
})

test('a stable request keeps replaying forever', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date('2026-01-01T00:00:00.000Z') })
  // No window: one key names one immutable answer, which is the whole point of
  // the stable result type.
  const reservation = await store.reserve(input({ replayWindowMs: null }))
  assert.equal(reservation.kind, 'replay')
})

test('re-executing after the window still re-checks quota', async () => {
  const { store, statements } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 3_600_000) })
  await store.reserve(input({ replayWindowMs: 120_000 }))
  // A fresh execution consumes quota like any other and receives an immutable
  // usage row; only the idempotency binding advances to the new attempt.
  assert.ok(statements.some((statement) => statement.startsWith('INSERT INTO usage_requests')))
  assert.ok(statements.some((statement) => statement.startsWith('COMMIT')))
  assert.ok(statements.some((statement) => statement.startsWith('UPDATE usage_idempotency_bindings')))
  assert.equal(statements.some((statement) => statement.startsWith('UPDATE usage_requests')), false)
})

test('a different body under the same key is still a conflict, window or not', async () => {
  const { store } = storeWithCommittedRequest({ completedAt: new Date(Date.now() - 3_600_000) })
  const reservation = await store.reserve(input({ fingerprint: 'fp-2', replayWindowMs: 120_000 }))
  assert.equal(reservation.kind, 'conflict')
})

test('MemoryStore mirrors replay expiry without clearing previous delivery evidence', async () => {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Replay-window tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Replay-window consumer' })
  await store.replaceGrants(consumer.id, ['telegram'])
  await store.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: 'telegram',
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const apiKey = await store.createApiKey({
    id: '77777777-7777-4777-8777-777777777777',
    tenantId: tenant.id,
    consumerId: consumer.id,
    name: 'Replay-window key',
    digest: 'replay-window-key-digest',
    prefix: 'mih_live_replay',
    lastFour: 'test',
    platformEntitlements: [{ platform: 'telegram', maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 }],
    capabilityEntitlements: [],
  })
  const scope = { tenantId: tenant.id, consumerId: consumer.id, apiKeyId: apiKey.id }
  const first = await store.reserve(input({ ...scope, replayWindowMs: 120_000 }))
  await store.commitRequest(first.request.id, {
    responseStatus: 200,
    responseBody: { data: { items: ['old'] } },
    unitsActual: 1,
    upstreamLatencyMs: 10,
  })
  Object.assign(store.requests.get(first.request.id), {
    completedAt: new Date(Date.now() - 3_600_000).toISOString(),
    deliverySourceMode: 'stale',
    capturedAt: new Date(Date.now() - 4_000_000).toISOString(),
    snapshotId: '88888888-8888-4888-8888-888888888888',
  })

  const reservation = await store.reserve(input({
    ...scope,
    requestId: '55555555-5555-4555-8555-555555555556',
    replayWindowMs: 120_000,
  }))
  assert.equal(reservation.kind, 'reserved')
  assert.notEqual(reservation.request.id, first.request.id)
  assert.equal(reservation.request.apiKeyId, apiKey.id)
  assert.equal(reservation.request.responseStatus, null)
  assert.equal(reservation.request.responseBody, null)
  assert.equal(reservation.request.deliverySourceMode, null)
  assert.equal(reservation.request.capturedAt, null)
  assert.equal(reservation.request.snapshotId, null)
  const historical = store.requests.get(first.request.id)
  assert.equal(historical.status, 'committed')
  assert.deepEqual(historical.responseBody, { data: { items: ['old'] } })
  assert.equal(historical.deliverySourceMode, 'stale')
  assert.equal(historical.snapshotId, '88888888-8888-4888-8888-888888888888')
  assert.equal((await store.usage({ apiKeyId: apiKey.id })).requests, 2)
})

test('each execution after replay expiry gets its own metered usage row', async () => {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Metered replay tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Metered replay consumer' })
  await store.replaceGrants(consumer.id, ['telegram'])
  await store.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: 'telegram',
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const apiKey = await store.createApiKey({
    id: '77777777-7777-4777-8777-777777777778',
    tenantId: tenant.id,
    consumerId: consumer.id,
    name: 'Metered replay key',
    digest: 'metered-replay-key-digest',
    prefix: 'mih_live_metered',
    lastFour: 'test',
    platformEntitlements: [{ platform: 'telegram', maxRequests: 10, windowSeconds: 3_600, maxPageSize: 100 }],
    capabilityEntitlements: [],
  })
  const scope = { tenantId: tenant.id, consumerId: consumer.id, apiKeyId: apiKey.id }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reservation = await store.reserve(input({
      ...scope,
      requestId: `55555555-5555-4555-8555-55555555555${attempt}`,
      replayWindowMs: 1,
    }))
    assert.equal(reservation.kind, 'reserved')
    await store.commitRequest(reservation.request.id, {
      responseStatus: 200,
      responseBody: { data: { attempt } },
      unitsActual: 1,
      upstreamLatencyMs: 1,
    })
    store.requests.get(reservation.request.id).completedAt = new Date(Date.now() - 10_000).toISOString()
  }
  assert.equal(store.requests.size, 3)
  assert.equal((await store.usage({ apiKeyId: apiKey.id })).requests, 3)
})

test('an idempotency key cannot rebind a committed usage row to another API key', async () => {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Cross-key tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Cross-key consumer' })
  await store.replaceGrants(consumer.id, ['telegram'])
  await store.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: 'telegram',
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const issue = (id, digest) => store.createApiKey({
    id,
    tenantId: tenant.id,
    consumerId: consumer.id,
    name: id,
    digest,
    prefix: 'mih_live_cross',
    lastFour: id.slice(-4),
    platformEntitlements: [{ platform: 'telegram', maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 }],
    capabilityEntitlements: [],
  })
  const firstKey = await issue('77777777-7777-4777-8777-777777777777', 'cross-key-digest-one')
  const secondKey = await issue('99999999-9999-4999-8999-999999999999', 'cross-key-digest-two')
  const scope = { tenantId: tenant.id, consumerId: consumer.id }
  const first = await store.reserve(input({ ...scope, apiKeyId: firstKey.id, replayWindowMs: 120_000 }))
  await store.commitRequest(first.request.id, {
    responseStatus: 200,
    responseBody: { data: { items: ['owned-by-first-key'] } },
    unitsActual: 1,
    upstreamLatencyMs: 10,
  })
  store.requests.get(first.request.id).completedAt = new Date(Date.now() - 3_600_000).toISOString()

  const conflict = await store.reserve(input({
    ...scope,
    apiKeyId: secondKey.id,
    replayWindowMs: 120_000,
  }))
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.request.apiKeyId, firstKey.id)
  assert.deepEqual(conflict.request.responseBody, { data: { items: ['owned-by-first-key'] } })
})
