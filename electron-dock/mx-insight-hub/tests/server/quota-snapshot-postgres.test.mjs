// The quota snapshot is what the console shows an operator who is asking "why
// was I rejected". It is only worth anything if it agrees with the admission
// check on the same database -- a snapshot that promises headroom the gateway
// will not honour is worse than showing nothing at all.
//
// So this does not assert numbers in isolation: it drives real reservations
// through PostgresStore.reserve and asserts that remaining reaches zero on
// exactly the call that gets rejected.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

test('PostgreSQL reports the quota it will actually enforce', {
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
    const tenant = await service.createTenant({ name: `quota-${randomUUID()}` })
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Quota consumer' })

    // A ceiling small enough to reach, so the test observes the real rejection
    // rather than extrapolating toward one.
    const consumerMax = 4
    await service.putPlatformConfiguration('xiaohongshu', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: consumerMax,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
    const issued = await service.createApiKey({
      consumerId: consumer.id,
      name: 'Quota key',
      platforms: ['xiaohongshu'],
      capabilities: [],
    })
    const context = await service.authenticate(issued.secret)

    const snapshot = async () => {
      const rows = await store.quotaSnapshot({
        tenantId: tenant.id,
        consumerId: consumer.id,
        apiKeyId: issued.id,
      })
      return rows.find((row) => row.scope === 'xiaohongshu')
    }

    const initial = await snapshot()
    assert.ok(initial, 'the key\'s granted platform appears in the snapshot')
    assert.equal(initial.scopeType, 'platform')
    assert.equal(initial.binding.remaining, consumerMax)
    assert.deepEqual(
      initial.layers.map((layer) => layer.limitScope).sort(),
      ['api_key', 'consumer'],
    )

    const reserve = (index) => store.reserve({
      requestId: randomUUID(),
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      idempotencyKey: randomUUID(),
      fingerprint: String(index).padStart(64, '0'),
      platform: 'xiaohongshu',
      unitsReserved: 1,
      requiredAuthorizationScopes: [{ type: 'platform', key: 'xiaohongshu' }],
      leaseExpiresAt: new Date(Date.now() + 120_000),
    })

    for (let call = 1; call <= consumerMax; call += 1) {
      assert.equal((await reserve(call)).kind, 'reserved', `call ${call} is admitted`)
      const after = await snapshot()
      assert.equal(
        after.binding.remaining,
        consumerMax - call,
        `after ${call} admitted call(s) the snapshot counts them`,
      )
    }

    // The moment of truth: remaining is 0 and the next call is refused, so the
    // console's number and the gateway's decision describe the same state.
    const exhausted = await snapshot()
    assert.equal(exhausted.binding.remaining, 0)
    await assert.rejects(
      () => reserve(consumerMax + 1),
      (error) => error?.status === 429 && error?.details?.limitScope === exhausted.binding.limitScope,
      'the layer the snapshot named as binding is the layer that rejected the call',
    )

    // A key from another consumer must not be able to read this consumer's
    // ceiling through a mismatched pairing.
    const other = await service.createConsumer({ tenantId: tenant.id, name: 'Other consumer' })
    assert.deepEqual(
      await store.quotaSnapshot({
        tenantId: tenant.id,
        consumerId: other.id,
        apiKeyId: issued.id,
      }),
      [],
    )
  } finally {
    await pool.end()
  }
})
