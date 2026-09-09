import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { requiredAuthorizationScopes } from '../../server/stores/usage-authorization.mjs'

const PLATFORM = 'xiaohongshu'
const OPERATION = 'social.posts.resolve'
const COMPATIBILITY = 'compat.xiaohongshu.app_v2'
const postgresConnectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

function reservationInput(owner, overrides = {}) {
  return {
    requestId: randomUUID(),
    idempotencyKey: `multi-axis-${randomUUID()}`,
    fingerprint: 'a'.repeat(64),
    tenantId: owner.tenant.id,
    consumerId: owner.consumer.id,
    apiKeyId: owner.apiKey.id,
    platform: PLATFORM,
    meterKey: OPERATION,
    requiredAuthorizationScopes: [
      { type: 'capability', key: OPERATION },
      { type: 'platform', key: PLATFORM },
    ],
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000),
    windowStart: new Date(Date.now() - 3_600_000),
    maxRequests: 1_000,
    ...overrides,
  }
}

async function configuredMemoryStore({ includeCompatibility = false } = {}) {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Multi-axis tenant' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Multi-axis consumer' })
  await store.replaceGrants(consumer.id, [PLATFORM])
  await store.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: PLATFORM,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  await store.putCapabilityConfiguration({
    tenantId: tenant.id,
    consumerId: consumer.id,
    capability: OPERATION,
    enabled: true,
    maxRequests: 1,
    windowSeconds: 60,
  })
  if (includeCompatibility) {
    await store.putCapabilityConfiguration({
      tenantId: tenant.id,
      consumerId: consumer.id,
      capability: COMPATIBILITY,
      enabled: true,
      maxRequests: 1_000,
      windowSeconds: 3_600,
    })
  }
  const apiKey = await store.createApiKey({
    id: randomUUID(),
    tenantId: tenant.id,
    consumerId: consumer.id,
    name: 'Multi-axis key',
    digest: 'b'.repeat(64),
    prefix: 'mih_live_multi',
    lastFour: 'axis',
    expiresAt: new Date(Date.now() + 3_600_000),
    platformEntitlements: [{
      platform: PLATFORM,
      maxRequests: 1_000,
      windowSeconds: 3_600,
      maxPageSize: 100,
    }],
    capabilityEntitlements: [
      { capability: OPERATION, maxRequests: 1, windowSeconds: 60 },
      ...(includeCompatibility
        ? [{ capability: COMPATIBILITY, maxRequests: 1_000, windowSeconds: 3_600 }]
        : []),
    ],
  })
  return { store, tenant, consumer, apiKey }
}

test('required authorization scopes are deterministic and must include the billing scope', () => {
  assert.deepEqual(requiredAuthorizationScopes({
    platform: PLATFORM,
    requiredAuthorizationScopes: [
      { type: 'capability', key: OPERATION },
      { type: 'platform', key: PLATFORM },
      { type: 'capability', key: OPERATION },
      { type: 'capability', key: COMPATIBILITY },
    ],
  }), [
    { type: 'platform', key: PLATFORM },
    { type: 'capability', key: COMPATIBILITY },
    { type: 'capability', key: OPERATION },
  ])
  assert.throws(() => requiredAuthorizationScopes({
    platform: PLATFORM,
    requiredAuthorizationScopes: [{ type: 'capability', key: OPERATION }],
  }), /must include the primary accounting scope/)
})

test('MemoryStore reserve closes the precheck-to-charge revoke gap for every required axis', async () => {
  const owner = await configuredMemoryStore({ includeCompatibility: true })
  assert.deepEqual(
    await owner.store.listEffectiveCapabilityGrants(owner.consumer.id, owner.apiKey.id),
    [COMPATIBILITY, OPERATION],
  )

  // This models an Admin revoke after a gateway precheck but before the final
  // admission transaction. The key snapshot still contains the capability.
  await owner.store.putCapabilityConfiguration({
    tenantId: owner.tenant.id,
    consumerId: owner.consumer.id,
    capability: COMPATIBILITY,
    enabled: false,
    maxRequests: 1_000,
    windowSeconds: 3_600,
  })
  await assert.rejects(
    owner.store.reserve(reservationInput(owner, {
      requiredAuthorizationScopes: [
        { type: 'platform', key: PLATFORM },
        { type: 'capability', key: OPERATION },
        { type: 'capability', key: COMPATIBILITY },
      ],
    })),
    (error) => {
      assert.equal(error.status, 403)
      assert.equal(error.code, 'api_key_scope_not_granted')
      assert.deepEqual(error.details, { capability: COMPATIBILITY })
      return true
    },
  )
  assert.equal(owner.store.requests.size, 0)
  assert.equal(owner.store.customerCharges.size, 0)
})

test('MemoryStore accounts each authorization axis in its own quota window', async () => {
  const owner = await configuredMemoryStore()
  const first = await owner.store.reserve(reservationInput(owner))
  assert.equal(first.kind, 'reserved')
  assert.equal(first.request.billingMeterKey, OPERATION)

  // The operation has a 1/minute limit while the platform has 1000/hour.
  // Moving this request two minutes back must free only the operation window;
  // collapsing both axes to 1/hour would incorrectly reject the next call.
  owner.store.requests.get(first.request.id).reservedAt = new Date(Date.now() - 120_000).toISOString()
  const second = await owner.store.reserve(reservationInput(owner))
  assert.equal(second.kind, 'reserved')

  await assert.rejects(owner.store.reserve(reservationInput(owner)), (error) => {
    assert.equal(error.status, 429)
    assert.equal(error.code, 'quota_exceeded')
    assert.deepEqual(error.details, {
      capability: OPERATION,
      maxRequests: 1,
      limitScope: 'consumer',
    })
    return true
  })
})

test('MemoryStore replay preserves one immutable authorization edge set and one usage row', async () => {
  const owner = await configuredMemoryStore({ includeCompatibility: true })
  const input = reservationInput(owner, {
    requiredAuthorizationScopes: [
      { type: 'capability', key: OPERATION },
      { type: 'capability', key: COMPATIBILITY },
      { type: 'platform', key: PLATFORM },
    ],
  })
  const first = await owner.store.reserve(input)
  await owner.store.commitRequest(first.request.id, {
    responseStatus: 200,
    responseBody: { ok: true },
    unitsActual: 1,
    upstreamLatencyMs: 5,
  })
  const replay = await owner.store.reserve({ ...input, requestId: randomUUID() })

  assert.equal(replay.kind, 'replay')
  assert.equal(replay.request.id, first.request.id)
  assert.equal(owner.store.requests.size, 1)
  assert.equal(owner.store.usageAuthorizationScopes.size, 1)
  assert.deepEqual(owner.store.usageAuthorizationScopes.get(first.request.id), [
    { type: 'platform', key: PLATFORM },
    { type: 'capability', key: COMPATIBILITY },
    { type: 'capability', key: OPERATION },
  ])
})

function postgresHarness({ deniedScope = null, derived = false } = {}) {
  const calls = []
  let released = false
  const client = {
    async query(sql, values = []) {
      const normalized = sql.trim().replace(/\s+/gu, ' ')
      calls.push({ sql: normalized, values })
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)
        || normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 0 }
      if (normalized.startsWith('SELECT id FROM api_keys')) {
        return { rows: [{ id: values[0] }], rowCount: 1 }
      }
      if (normalized.includes('FROM api_keys api_key_record')) {
        if (derived) {
          return {
            rows: [{ granted_count: 1, max_requests: 100, window_seconds: 60 }],
            rowCount: 1,
          }
        }
        if (values[1] === deniedScope) return { rows: [], rowCount: 0 }
        const shortWindow = values[1] === OPERATION
        return {
          rows: [{
            max_requests: shortWindow ? 1 : 1_000,
            window_seconds: shortWindow ? 60 : 3_600,
            consumer_max_requests: shortWindow ? 1 : 1_000,
            consumer_window_seconds: shortWindow ? 60 : 3_600,
          }],
          rowCount: 1,
        }
      }
      if (normalized.includes('FROM usage_idempotency_bindings binding')) {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.startsWith('SELECT count(*)::integer AS count')) {
        return { rows: [{ count: 0 }], rowCount: 1 }
      }
      if (normalized.includes('FROM consumer_plan_assignments assignment')) {
        return {
          rows: [{
            plan_key: 'launch-1m',
            plan_status: 'active',
            version_status: 'published',
            limits: {},
            assigned_at: new Date(0),
            period_start: new Date(0),
          }],
          rowCount: 1,
        }
      }
      if (normalized.startsWith('INSERT INTO usage_requests')) {
        return {
          rows: [{
            id: values[0], tenant_id: values[1], consumer_id: values[2], api_key_id: values[3],
            idempotency_key: values[4], fingerprint: values[5], platform: values[6],
            capability: values[7], billing_meter_key: values[8],
            authorization_scopes: JSON.parse(values[9]), status: 'reserved',
            units_reserved: values[10], lease_expires_at: values[11], reserved_at: new Date(),
            created_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (normalized.startsWith('INSERT INTO usage_idempotency_bindings')) {
        return { rows: [], rowCount: 1 }
      }
      assert.fail(`unexpected SQL: ${normalized}`)
    },
    release() { released = true },
  }
  return {
    store: new PostgresStore({ async connect() { return client } }),
    calls,
    released: () => released,
  }
}

function postgresOwner() {
  return {
    tenant: { id: '11111111-1111-4111-8111-111111111111' },
    consumer: { id: '22222222-2222-4222-8222-222222222222' },
    apiKey: { id: '33333333-3333-4333-8333-333333333333' },
  }
}

test('Postgres reserve locks and inserts the immutable authorization snapshot atomically', async () => {
  const harness = postgresHarness()
  const owner = postgresOwner()
  const input = reservationInput(owner, {
    requestId: '44444444-4444-4444-8444-444444444444',
    idempotencyKey: 'multi-axis-postgres-success',
    requiredAuthorizationScopes: [
      { type: 'capability', key: OPERATION },
      { type: 'platform', key: PLATFORM },
      { type: 'capability', key: COMPATIBILITY },
    ],
  })
  const result = await harness.store.reserve(input)
  assert.equal(result.kind, 'reserved')
  assert.equal(result.request.billingMeterKey, OPERATION)
  assert.equal(harness.released(), true)

  const locks = harness.calls
    .filter((call) => call.sql.startsWith('SELECT pg_advisory_xact_lock'))
    .map((call) => call.values[0])
  assert.deepEqual(locks, [
    `${owner.tenant.id}:${owner.consumer.id}:plan-month`,
    `${owner.consumer.id}:authorization:platform:${PLATFORM}`,
    `${owner.consumer.id}:authorization:capability:${COMPATIBILITY}`,
    `${owner.consumer.id}:authorization:capability:${OPERATION}`,
    `${owner.consumer.id}:idempotency:${input.idempotencyKey}`,
  ])
  const ownerLock = harness.calls.find((call) => call.sql.startsWith('SELECT id FROM api_keys'))
  assert.match(ownerLock.sql, /FOR SHARE$/u)
  assert.doesNotMatch(ownerLock.sql, /FOR KEY SHARE/u)

  const quotaCalls = harness.calls.filter((call) => (
    call.sql.startsWith('SELECT count(*)::integer AS count')
    && call.sql.includes('usage_request_authorization_scopes')
  ))
  assert.equal(quotaCalls.length, 6)
  assert.ok(quotaCalls.every((call) => call.sql.includes('NOT EXISTS')))
  assert.deepEqual(
    quotaCalls.filter((_, index) => index % 2 === 0).map((call) => call.values.slice(2, 4)),
    [
      ['platform', PLATFORM],
      ['capability', COMPATIBILITY],
      ['capability', OPERATION],
    ],
  )
  const usageInsert = harness.calls.find((call) => call.sql.startsWith('INSERT INTO usage_requests'))
  assert.deepEqual(JSON.parse(usageInsert.values[9]), [
    { type: 'platform', key: PLATFORM },
    { type: 'capability', key: COMPATIBILITY },
    { type: 'capability', key: OPERATION },
  ])
  assert.match(usageInsert.sql, /authorization_scopes/u)
  assert.equal(
    harness.calls.some((call) => call.sql.startsWith('INSERT INTO usage_request_authorization_scopes')),
    false,
  )
})

test('Postgres reserve rolls back before usage or customer charge when any axis is revoked', async () => {
  const harness = postgresHarness({ deniedScope: COMPATIBILITY })
  const owner = postgresOwner()
  await assert.rejects(harness.store.reserve(reservationInput(owner, {
    idempotencyKey: 'multi-axis-postgres-denied',
    requiredAuthorizationScopes: [
      { type: 'platform', key: PLATFORM },
      { type: 'capability', key: OPERATION },
      { type: 'capability', key: COMPATIBILITY },
    ],
  })), (error) => {
    assert.equal(error.status, 403)
    assert.equal(error.code, 'api_key_scope_not_granted')
    assert.deepEqual(error.details, { capability: COMPATIBILITY })
    return true
  })
  assert.equal(harness.calls.some((call) => call.sql.startsWith('INSERT INTO usage_requests')), false)
  assert.equal(harness.calls.some((call) => call.sql === 'COMMIT'), false)
  assert.equal(harness.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(harness.released(), true)
})

test('legacy derived usage supplies a finite quota-window parameter', async () => {
  const harness = postgresHarness({ derived: true })
  const owner = postgresOwner()
  const input = reservationInput(owner, {
    idempotencyKey: 'legacy-derived-postgres-success',
    platform: undefined,
    capability: 'data.canonical-search',
    meterKey: undefined,
    requiredAuthorizationScopes: undefined,
    authorizationPlatforms: [PLATFORM],
    apiKeyQuota: { maxRequests: 100, windowSeconds: 60 },
    windowStart: new Date(Date.now() - 3_600_000),
  })
  const result = await harness.store.reserve(input)
  assert.equal(result.kind, 'reserved')
  const consumerQuota = harness.calls.find((call) => (
    call.sql.startsWith('SELECT count(*)::integer AS count')
    && call.sql.includes('usage_request_authorization_scopes')
    && call.values.length === 6
  ))
  assert.equal(Number.isInteger(consumerQuota.values[5]), true)
  assert.ok(consumerQuota.values[5] > 0)
})

test('migration 063 is bounded, append-only, and avoids an in-transaction history backfill', async () => {
  const sql = await readFile(fileURLToPath(new URL(
    '../../migrations/063_usage_request_authorization_scopes.sql',
    import.meta.url,
  )), 'utf8')
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/u)
  assert.match(sql, /SET LOCAL statement_timeout = '2min';/u)
  assert.match(sql, /PRIMARY KEY \(usage_request_id, scope_type, scope_key\)/u)
  assert.match(sql, /AFTER INSERT ON usage_requests/u)
  assert.match(sql, /BEFORE UPDATE OR DELETE ON usage_request_authorization_scopes/u)
  assert.doesNotMatch(sql, /INSERT INTO usage_request_authorization_scopes[\s\S]+FROM usage_requests/u)
})

test('migration 065 makes the parent snapshot authoritative and immutable', async () => {
  const sql = await readFile(fileURLToPath(new URL(
    '../../migrations/065_lock_usage_authorization_scope_set.sql',
    import.meta.url,
  )), 'utf8')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS authorization_scopes jsonb/u)
  assert.match(sql, /BEFORE UPDATE OF authorization_scopes/u)
  assert.match(sql, /jsonb_array_elements\(NEW\.authorization_scopes\)/u)
  assert.match(sql, /snapshot omits the primary accounting scope/u)
  assert.match(sql, /request\.authorization_scopes/u)
  assert.match(sql, /BEFORE INSERT OR UPDATE OR DELETE/u)
  assert.match(sql, /usage request authorization scopes are immutable/u)
  assert.doesNotMatch(sql, /request\.xmin|pg_current_xact_id/u)
})

test('PostgreSQL persists every authorization axis and rejects a revoked axis atomically', {
  skip: postgresConnectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString: postgresConnectionString, statement_timeout: 5_000 })
  const store = new PostgresStore(pool)
  try {
    const tenant = await store.createTenant({ name: `multi-axis-${randomUUID()}` })
    const consumer = await store.createConsumer({
      tenantId: tenant.id,
      name: 'PostgreSQL multi-axis consumer',
    })
    await store.replaceGrants(consumer.id, [PLATFORM])
    await store.putPolicy({
      tenantId: tenant.id,
      consumerId: consumer.id,
      platform: PLATFORM,
      maxRequests: 1_000,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
    for (const capability of [OPERATION, COMPATIBILITY]) {
      await store.putCapabilityConfiguration({
        tenantId: tenant.id,
        consumerId: consumer.id,
        capability,
        enabled: true,
        maxRequests: 1_000,
        windowSeconds: 3_600,
      })
    }
    const apiKey = await store.createApiKey({
      id: randomUUID(),
      tenantId: tenant.id,
      consumerId: consumer.id,
      name: 'PostgreSQL multi-axis key',
      digest: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      prefix: 'mih_live_multi',
      lastFour: 'axis',
      expiresAt: new Date(Date.now() + 3_600_000),
      platformEntitlements: [{
        platform: PLATFORM,
        maxRequests: 1_000,
        windowSeconds: 3_600,
        maxPageSize: 100,
      }],
      capabilityEntitlements: [
        { capability: OPERATION, maxRequests: 1_000, windowSeconds: 3_600 },
        { capability: COMPATIBILITY, maxRequests: 1_000, windowSeconds: 3_600 },
      ],
    })
    const owner = { tenant, consumer, apiKey }
    const first = await store.reserve(reservationInput(owner, {
      requiredAuthorizationScopes: [
        { type: 'capability', key: OPERATION },
        { type: 'platform', key: PLATFORM },
        { type: 'capability', key: COMPATIBILITY },
      ],
    }))
    assert.equal(first.kind, 'reserved')

    const edges = await pool.query(
      `SELECT scope_type, scope_key
         FROM usage_request_authorization_scopes
        WHERE usage_request_id = $1
        ORDER BY scope_type DESC, scope_key`,
      [first.request.id],
    )
    assert.deepEqual(edges.rows, [
      { scope_type: 'platform', scope_key: PLATFORM },
      { scope_type: 'capability', scope_key: COMPATIBILITY },
      { scope_type: 'capability', scope_key: OPERATION },
    ])
    await assert.rejects(
      pool.query(
        `INSERT INTO usage_request_authorization_scopes
           (usage_request_id, scope_type, scope_key)
         VALUES ($1, 'capability', 'late.audit.scope')`,
        [first.request.id],
      ),
      (error) => error?.code === '55000'
        && /authorization scopes are immutable/u.test(error?.message),
    )
    await assert.rejects(
      pool.query(
        `WITH touched AS (
           UPDATE usage_requests
              SET lease_expires_at = lease_expires_at
            WHERE id = $1
            RETURNING id
         )
         INSERT INTO usage_request_authorization_scopes
           (usage_request_id, scope_type, scope_key)
         SELECT id, 'capability', 'late.after.update.scope'
           FROM touched`,
        [first.request.id],
      ),
      (error) => error?.code === '55000'
        && /authorization scopes are immutable/u.test(error?.message),
    )

    await store.putCapabilityConfiguration({
      tenantId: tenant.id,
      consumerId: consumer.id,
      capability: COMPATIBILITY,
      enabled: false,
      maxRequests: 1_000,
      windowSeconds: 3_600,
    })
    await assert.rejects(store.reserve(reservationInput(owner, {
      requiredAuthorizationScopes: [
        { type: 'platform', key: PLATFORM },
        { type: 'capability', key: OPERATION },
        { type: 'capability', key: COMPATIBILITY },
      ],
    })), (error) => error?.status === 403 && error?.code === 'api_key_scope_not_granted')

    const usage = await pool.query(
      'SELECT count(*)::integer AS count FROM usage_requests WHERE consumer_id = $1',
      [consumer.id],
    )
    assert.equal(usage.rows[0].count, 1)
  } finally {
    await pool.end()
  }
})
