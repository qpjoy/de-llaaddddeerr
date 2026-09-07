import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''

test('PostgreSQL retains one usage row per execution behind a stable idempotency binding', {
  skip: connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured',
}, async () => {
  const pool = new pg.Pool({ connectionString, statement_timeout: 5_000 })
  const store = new PostgresStore(pool)
  const service = new HubService({
    store,
    adapter: {},
    apiKeyPepper: 'idempotency-integration-pepper-at-least-32-bytes',
  })
  try {
    const tenant = await service.createTenant({ name: `idempotency-${randomUUID()}` })
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Metered retries' })
    await service.putPlatformConfiguration('telegram', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 3,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
    const issued = await service.createApiKey({
      consumerId: consumer.id,
      name: 'Metered retry key',
      platforms: ['telegram'],
      capabilities: [],
    })
    const context = await service.authenticate(issued.secret)
    const idempotencyKey = `metered-${randomUUID()}`
    const requestIds = []

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestId = randomUUID()
      requestIds.push(requestId)
      const reservation = await store.reserve({
        requestId,
        idempotencyKey,
        fingerprint: 'a'.repeat(64),
        tenantId: tenant.id,
        consumerId: consumer.id,
        apiKeyId: context.apiKey.id,
        platform: 'telegram',
        unitsReserved: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        windowStart: new Date(Date.now() - 3_600_000),
        maxRequests: 3,
        replayWindowMs: 1,
      })
      assert.equal(reservation.kind, 'reserved')
      assert.equal(reservation.request.id, requestId)
      await store.commitRequest(requestId, {
        responseStatus: 200,
        responseBody: { data: { attempt } },
        unitsActual: 1,
        upstreamLatencyMs: 1,
      })
      await pool.query(
        `UPDATE usage_requests SET completed_at = now() - interval '10 seconds'
          WHERE id = $1`,
        [requestId],
      )
    }

    await assert.rejects(
      () => store.reserve({
        requestId: randomUUID(),
        idempotencyKey,
        fingerprint: 'a'.repeat(64),
        tenantId: tenant.id,
        consumerId: consumer.id,
        apiKeyId: context.apiKey.id,
        platform: 'telegram',
        unitsReserved: 1,
        leaseExpiresAt: new Date(Date.now() + 30_000),
        windowStart: new Date(Date.now() - 3_600_000),
        maxRequests: 3,
        replayWindowMs: 1,
      }),
      (error) => error?.status === 429 && error?.details?.limitScope === 'consumer',
    )

    const history = await pool.query(
      `SELECT id, response_body
         FROM usage_requests
        WHERE consumer_id = $1 AND idempotency_key = $2
        ORDER BY created_at, id`,
      [consumer.id, idempotencyKey],
    )
    assert.equal(history.rowCount, 3)
    assert.deepEqual(new Set(history.rows.map(({ id }) => id)), new Set(requestIds))
    assert.deepEqual(
      new Set(history.rows.map(({ response_body: body }) => body.data.attempt)),
      new Set([0, 1, 2]),
    )
    const current = await store.getUsageRequestByIdempotencyKey(consumer.id, idempotencyKey)
    assert.equal(current.id, requestIds.at(-1))
    assert.equal((await store.usage({ apiKeyId: context.apiKey.id })).requests, 3)
  } finally {
    await pool.end()
  }
})
