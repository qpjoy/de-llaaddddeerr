// provider_state has one row per provider. Under a burst, every dispatch and
// every successful settlement of that provider used to update it and keep it
// locked until COMMIT had flushed, so a slow disk serialised the provider.
// These cases hold that row in another session and prove the request path no
// longer waits for it, while failure/recovery state still applies.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL' }

async function fixture(t) {
  // A short lock_timeout turns any wait on the held row into a failure.
  const pool = new pg.Pool({ connectionString, statement_timeout: 5000, lock_timeout: 1000 })
  const usage = new PostgresStore(pool)
  const service = new HubService({ store: usage, adapter: {}, apiKeyPepper: 'hot-row-postgres-test-pepper-32-characters' })
  const providerKey = `hot-${randomUUID().slice(0, 8)}`
  const store = new PostgresExternalPlatformStore({ pool, providerKey })
  const holder = await pool.connect()
  t.after(async () => {
    await holder.query('ROLLBACK').catch(() => {})
    holder.release()
    await pool.end()
  })
  await pool.query('INSERT INTO external_platform.provider_state(provider_key) VALUES ($1)', [providerKey])
  const tenant = await service.createTenant({ name: providerKey })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Hot row test' })
  await service.putPlatformConfiguration('ecommerce', { tenantId: tenant.id, consumerId: consumer.id,
    enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Hot row test', platforms: ['ecommerce'], capabilities: [] })
  async function begin() {
    const requestId = randomUUID()
    await usage.reserve({ requestId, idempotencyKey: requestId, fingerprint: 'b'.repeat(64),
      tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id, platform: 'ecommerce',
      unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 60_000),
      windowStart: new Date(Date.now() - 3600_000), maxRequests: 100 })
    const delivery = { tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id,
      usageRequestId: requestId, operation: 'ecommerce.products.search',
      contractVersion: 'hot-row-test.v1', endpointKey: 'hot-row-test.v1', endpointVersion: 'v1',
      marketplace: 'jd', fingerprint: 'b'.repeat(64) }
    const call = await store.beginProviderCall(delivery)
    return { callId: call.id, delivery }
  }
  const succeed = call => store.finishProviderStep({ ...call, outcome: 'succeeded', httpStatus: 200,
    businessCode: 200, billed: true, costMinor: 1, costKind: 'estimated', currency: 'CNY',
    itemCount: 1, latencyMs: 10 })
  const holdProviderRow = async () => {
    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM external_platform.provider_state WHERE provider_key = $1 FOR UPDATE', [providerKey])
  }
  const state = async () => (await pool.query(
    'SELECT last_call_at, last_success_at, consecutive_failures FROM external_platform.provider_state WHERE provider_key = $1',
    [providerKey])).rows[0]
  return { pool, store, providerKey, holder, begin, succeed, holdProviderRow, state }
}

test('dispatch does not wait for a provider_state row held by another session', native, async t => {
  const { holder, begin, holdProviderRow, state } = await fixture(t)
  const first = await begin()
  assert.ok((await state()).last_call_at, 'an idle row is still stamped')
  await holdProviderRow()
  const started = Date.now()
  const second = await begin()
  assert.ok(Date.now() - started < 1000, 'dispatch skipped the locked observation row')
  assert.notEqual(second.callId, first.callId)
  await holder.query('ROLLBACK')
})

test('healthy settlements refresh provider_state at most every five seconds and never queue on it', native, async t => {
  const { pool, providerKey, holder, begin, succeed, holdProviderRow, state } = await fixture(t)
  await succeed(await begin())
  const firstSuccess = (await state()).last_success_at
  assert.ok(firstSuccess)
  const call = await begin()
  await holdProviderRow()
  await succeed(call)
  assert.equal((await state()).last_success_at.getTime(), firstSuccess.getTime(), 'recent healthy success is not rewritten')
  await holder.query('ROLLBACK')
  await pool.query("UPDATE external_platform.provider_state SET last_success_at = now() - interval '6 seconds' WHERE provider_key = $1", [providerKey])
  await succeed(await begin())
  assert.ok((await state()).last_success_at > firstSuccess, 'a stale healthy timestamp is refreshed')
})

test('a success after failures still recovers the circuit and waits for the row if needed', native, async t => {
  const { store, begin, succeed, state } = await fixture(t)
  for (let i = 0; i < 2; i += 1) {
    await store.finishProviderStep({ ...await begin(), outcome: 'rejected', httpStatus: 429,
      errorCode: 'upstream_rate_limited' })
  }
  assert.equal((await state()).consecutive_failures, 2)
  await succeed(await begin())
  assert.equal((await state()).consecutive_failures, 0)
})
