// Suspension on the production store.
//
// PostgreSQL enforces this in the authentication query itself -- the join
// requires an active tenant -- so it is worth proving against a real database
// rather than inferring it from the SQL. A suspension that does not actually
// stop traffic is the one failure mode that makes this feature harmful.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

test('PostgreSQL refuses traffic for a suspended tenant and restores it on resume', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const store = new PostgresStore(pool)
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'integration-test-pepper-at-least-32-bytes',
  })
  try {
    const tenant = await service.createTenant({ name: `suspend-${randomUUID()}` })
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Suspend consumer' })
    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id, consumerId: consumer.id, enabled: true,
      maxRequests: 100, windowSeconds: 3_600, maxPageSize: 100,
    })
    const issued = await service.createApiKey({
      consumerId: consumer.id, name: 'Suspend key', platforms: ['xiaohongshu'], capabilities: [],
    })

    assert.ok(await service.authenticate(issued.secret))

    const suspended = await service.setTenantStatus(tenant.id, { status: 'suspended' })
    assert.equal(suspended.status, 'suspended')
    await assert.rejects(
      () => service.authenticate(issued.secret),
      (error) => error?.status === 403 && error?.code === 'tenant_suspended',
      'the authentication join requires an active tenant, and the refusal says so',
    )
    // The explanation must not widen into a probe: an unknown secret still
    // learns nothing about which tenants exist.
    await assert.rejects(
      () => service.authenticate('mih_live_deadbeef_not-a-real-secret'),
      (error) => error?.status === 401 && error?.code === 'invalid_api_key',
    )

    // The row is untouched, which is what makes this reversible.
    const row = await pool.query('SELECT status FROM api_keys WHERE id = $1', [issued.id])
    assert.equal(row.rows[0].status, 'active')

    await service.setTenantStatus(tenant.id, { status: 'active' })
    const after = await service.authenticate(issued.secret)
    assert.equal(after.apiKey.id, issued.id)

    // The database's own CHECK constraint is the backstop behind the service's
    // validation; neither is allowed to be the only guard.
    await assert.rejects(
      () => pool.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, 'deleted']),
      (error) => error?.code === '23514',
    )
  } finally {
    await pool.end()
  }
})
