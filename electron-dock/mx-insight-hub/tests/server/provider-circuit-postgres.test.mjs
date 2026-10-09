import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

for (const method of ['commitLiveDelivery', 'finishProviderStep']) {
  test(`PostgreSQL ${method} fences delayed success from newer failures`, {
    skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL',
  }, async () => {
    const pool = new pg.Pool({ connectionString, statement_timeout: 5000 })
    const usage = new PostgresStore(pool)
    const service = new HubService({ store: usage, adapter: {}, apiKeyPepper: 'circuit-postgres-test-pepper-32-characters' })
    const providerKey = `circuit-${randomUUID().slice(0, 8)}`
    const store = new PostgresExternalPlatformStore({ pool, providerKey })
    try {
      await pool.query('INSERT INTO external_platform.provider_state(provider_key) VALUES ($1)', [providerKey])
      const tenant = await service.createTenant({ name: providerKey })
      const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Circuit test' })
      await service.putPlatformConfiguration('ecommerce', { tenantId: tenant.id, consumerId: consumer.id,
        enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
      const key = await service.createApiKey({ consumerId: consumer.id, name: 'Circuit test', platforms: ['ecommerce'], capabilities: [] })
      async function begin() {
        const requestId = randomUUID()
        await usage.reserve({ requestId, idempotencyKey: requestId, fingerprint: 'a'.repeat(64),
          tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id, platform: 'ecommerce',
          unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 60_000),
          windowStart: new Date(Date.now() - 3600_000), maxRequests: 100 })
        const delivery = { tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id,
          usageRequestId: requestId, operation: 'ecommerce.products.search',
          contractVersion: 'circuit-test.v1', endpointKey: 'circuit-test.v1', endpointVersion: 'v1',
          marketplace: 'jd', fingerprint: 'a'.repeat(64) }
        const call = await store.beginProviderCall(delivery)
        return { callId: call.id, delivery }
      }
      const old = await begin()
      for (let i = 0; i < 3; i += 1) {
        await store.finishProviderStep({ ...await begin(), outcome: 'rejected', httpStatus: 429,
          errorCode: 'upstream_rate_limited' })
      }
      const circuit = await store.providerState()
      assert.equal(circuit.consecutiveFailures, 3)
      assert.ok(circuit.circuitOpenUntil)
      const succeed = call => store[method]({ ...call, outcome: 'succeeded', httpStatus: 200,
        businessCode: 200, billed: true, costMinor: 1, costKind: 'estimated', currency: 'CNY',
        itemCount: 1, latencyMs: 10, responseBody: { data: [] }, capturedAt: new Date(),
        freshUntil: new Date(Date.now() + 60_000), staleUntil: new Date(Date.now() + 120_000) })
      await succeed(old)
      const retained = await store.providerState()
      assert.equal(retained.circuitOpenUntil, circuit.circuitOpenUntil)
      assert.equal(retained.consecutiveFailures, 3)
      assert.equal(retained.lastErrorCode, 'upstream_rate_limited')
      // Gateway admission, not settlement, controls the cooldown. Simulate its
      // expiry without a timer, then prove a newly started success can recover.
      await pool.query("UPDATE external_platform.provider_state SET circuit_open_until = now() - interval '1 second' WHERE provider_key = $1", [providerKey])
      await succeed(await begin())
      assert.equal((await store.providerState()).circuitOpenUntil, null)
      assert.equal((await store.providerState()).consecutiveFailures, 0)
    } finally { await pool.end() }
  })
}
