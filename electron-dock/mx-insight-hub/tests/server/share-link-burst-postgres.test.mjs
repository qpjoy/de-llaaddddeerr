import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { SHARE_LINK_RESOLVER } from '../../shared/share-link-resolver.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL

test('PostgreSQL share-link burst hints follow the shared consumer window across concurrent keys', {
  skip: !connectionString && 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL',
}, async t => {
  const applicationName = `share-burst-${randomUUID()}`
  const pool = new pg.Pool({ connectionString, application_name: applicationName, max: 5 })
  t.after(() => pool.end())
  const store = new PostgresStore(pool)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'share-link-burst-test-pepper-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: applicationName })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Burst fixture' })
  const { platform, capability } = SHARE_LINK_RESOLVER
  const grant = { consumerId: consumer.id, tenantId: tenant.id, enabled: true, windowSeconds: 3600, maxRequests: 1000 }
  await service.putPlatformConfiguration(platform, { ...grant, maxPageSize: 100 })
  await service.putCapabilityConfiguration(capability, grant)
  const keys = []
  for (const name of ['first', 'sibling']) {
    keys.push(await service.createApiKey({ consumerId: consumer.id, name, platforms: [platform], capabilities: [capability] }))
  }
  const revision = (await service.getConsumerPlan(consumer.id)).revision
  const planVersionId = randomUUID()
  await pool.query(
    `WITH plan AS (INSERT INTO plans (id,plan_key,name,status) VALUES ($1,$2,'Burst fixture','active') RETURNING id)
     INSERT INTO plan_versions (id,plan_id,version,status,limits,pricing,published_at)
     SELECT $3,id,1,'published','{"burstRps":1}'::jsonb,'{}'::jsonb,now() FROM plan`,
    [randomUUID(), applicationName, planVersionId],
  )
  await service.assignConsumerPlan(consumer.id, { planVersionId, expectedRevision: revision }, 'integration-test')
  const reserve = (key, options = {}) => store.reserve({
    requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: 'a'.repeat(64),
    tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id, capability,
    requiredAuthorizationScopes: [{ type: 'platform', key: platform }, { type: 'capability', key: capability }],
    unitsReserved: 1, windowStart: new Date(Date.now() - 3_600_000), maxRequests: 1000,
    leaseExpiresAt: new Date(Date.now() + 120_000), ...options,
  })
  const optedIn = { includePlanBurstRetryAfter: true }
  const first = await reserve(keys[0], optedIn)
  assert.equal(first.kind, 'reserved')
  await assert.rejects(reserve(keys[1]), error => error.code === 'plan_burst_exceeded'
    && error.status === 429 && !Object.hasOwn(error.details, 'retryAfterMs'))
  await pool.query('SELECT pg_sleep(0.15)')
  await assert.rejects(reserve(keys[1], optedIn), error => error.code === 'plan_burst_exceeded'
    && Number.isInteger(error.details.retryAfterMs) && error.details.retryAfterMs >= 1 && error.details.retryAfterMs <= 850)

  // Start both transactions in the old window, then release the consumer lock
  // after it expires. The new admission decision must see the database time
  // after the wait as well as the reservation committed by the first waiter.
  const holder = await pool.connect()
  let pending
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenant.id}:${consumer.id}:plan-month`])
    pending = Promise.allSettled(keys.map(key => reserve(key, optedIn)))
    const deadline = Date.now() + 2500
    while ((await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'", [applicationName])).rowCount < 2) {
      assert.ok(Date.now() < deadline, 'both connections must be blocked on the consumer lock')
      await delay(10)
    }
    await holder.query('SELECT pg_sleep(1.01)')
  } finally {
    await holder.query('ROLLBACK')
    holder.release()
  }
  const attempts = await pending
  assert.equal(attempts.filter(result => result.status === 'fulfilled' && result.value.kind === 'reserved').length, 1)
  const rejected = attempts.find(result => result.status === 'rejected')
  assert.equal(rejected.reason.code, 'plan_burst_exceeded')
  assert.ok(rejected.reason.details.retryAfterMs >= 1 && rejected.reason.details.retryAfterMs <= 1000)
  const ledger = await pool.query(
    `SELECT count(*)::int AS total, max(reserved_at)-min(reserved_at) >= interval '1 second' AS separate_windows
     FROM usage_requests WHERE consumer_id=$1`, [consumer.id],
  )
  assert.deepEqual(ledger.rows[0], { total: 2, separate_windows: true })
})

test('PostgreSQL returns the local slot hint only after a successful reservation fills the plan', {
  skip: !connectionString && 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL',
}, async t => {
  const pool = new pg.Pool({ connectionString })
  t.after(() => pool.end())
  const store = new PostgresStore(pool)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'share-link-slot-test-pepper-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: 'Slot hint' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Slot hint' })
  const { platform, capability } = SHARE_LINK_RESOLVER
  const grant = { tenantId: tenant.id, consumerId: consumer.id, enabled: true }
  await service.putPlatformConfiguration(platform, grant)
  await service.putCapabilityConfiguration(capability, grant)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Slot hint', platforms: [platform], capabilities: [capability] })
  const planKey = 'slots-' + randomUUID()
  const plan = await service.publishPlanVersion({
    key: planKey, name: 'Two slots', limits: { burstRps: 2 },
    priceBook: { key: planKey, currency: 'CNY', entries: [{ meterKey: capability, unitPriceMinor: 1 }] },
  }, 'integration-test')
  const { revision } = await service.getConsumerPlan(consumer.id)
  await service.assignConsumerPlan(consumer.id, { planVersionId: plan.versionId, expectedRevision: revision }, 'integration-test')
  const reserve = idempotencyKey => store.reserve({
    requestId: randomUUID(), idempotencyKey, fingerprint: 'b'.repeat(64),
    tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id, capability,
    requiredAuthorizationScopes: [{ type: 'platform', key: platform }, { type: 'capability', key: capability }],
    unitsReserved: 1, windowStart: new Date(Date.now() - 3_600_000), maxRequests: 1000,
    leaseExpiresAt: new Date(Date.now() + 120_000), includePlanBurstRetryAfter: true,
  })
  const first = await reserve('first-slot')
  assert.equal(Object.hasOwn(first, 'nextPlanBurstSlotAt'), false)

  await service.setTenantBillingProfile(tenant.id, { mode: 'enforced' }, 'integration-test')
  await assert.rejects(reserve('second-slot'), { status: 402, code: 'insufficient_credit' })
  const rows = await pool.query('SELECT id FROM usage_requests WHERE consumer_id = $1', [consumer.id])
  assert.deepEqual(rows.rows, [{ id: first.request.id }])
  await service.addTenantCredit(tenant.id, { amountMinor: 5, currency: 'CNY', reason: 'Test credit' },
    { idempotencyKey: 'slot-test-credit', actor: 'integration-test' })
  await pool.query("UPDATE usage_requests SET reserved_at = clock_timestamp() - interval '300 milliseconds' WHERE id = $1", [first.request.id])
  const before = performance.now()
  const second = await reserve('second-slot')
  assert.ok(second.nextPlanBurstSlotAt > before && second.nextPlanBurstSlotAt <= performance.now() + 701)
  assert.equal(Object.hasOwn(second.request, 'nextPlanBurstSlotAt'), false)
  assert.equal(Object.hasOwn(await reserve('second-slot'), 'nextPlanBurstSlotAt'), false)
  await store.releaseRequest(second.request.id, 'test_release')
  const retried = await reserve('second-slot')
  assert.equal(retried.kind, 'reserved')
  assert.ok(Number.isFinite(retried.nextPlanBurstSlotAt))
  const { account } = await service.getTenantBilling(tenant.id)
  assert.equal(account.availableMinor, 4)
  assert.equal(account.heldMinor, 1)
})
