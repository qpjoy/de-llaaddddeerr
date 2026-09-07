import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'request-status-test-pepper-with-enough-entropy'
const LOOKUP_PATH = '/api/v1/requests/by-idempotency-key'

async function withFixture(run) {
  const store = new MemoryStore()
  let upstreamCalls = 0
  const adapter = {
    async capabilities() {
      upstreamCalls += 1
      return { data: { platforms: [] } }
    },
    async search() {
      upstreamCalls += 1
      throw new Error('request status lookup must not call upstream')
    },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Request status tenant' })
  const owner = await service.createConsumer({ tenantId: tenant.id, name: 'Request owner' })
  const other = await service.createConsumer({ tenantId: tenant.id, name: 'Other consumer' })
  for (const consumer of [owner, other]) {
    await service.putPlatformConfiguration('ecommerce', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 100,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
  }
  const ownerKey = await service.createApiKey({ consumerId: owner.id, name: 'Owner key' })
  const otherKey = await service.createApiKey({ consumerId: other.id, name: 'Other key' })
  const server = createServer(createApp({
    service,
    store,
    adapter,
    adminToken: null,
    listenerMode: 'public',
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async ({ secret, idempotencyKey, path = LOOKUP_PATH }) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    })
    return { response, payload: await response.json() }
  }
  try {
    await run({ store, tenant, owner, other, ownerKey, otherKey, call, upstreamCalls: () => upstreamCalls })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await store.close()
  }
}

async function reserve(store, { tenant, consumer, apiKey, idempotencyKey, leaseExpiresAt }) {
  const requestId = randomUUID()
  const result = await store.reserve({
    requestId,
    idempotencyKey,
    fingerprint: 'a'.repeat(64),
    tenantId: tenant.id,
    consumerId: consumer.id,
    apiKeyId: apiKey.id,
    platform: 'ecommerce',
    unitsReserved: 1,
    leaseExpiresAt,
    windowStart: new Date(0),
    maxRequests: 100,
  })
  assert.equal(result.kind, 'reserved')
  return result.request
}

test('idempotency-key status route authenticates first, validates its header, and wins over the UUID route', async () => {
  await withFixture(async ({ ownerKey, call }) => {
    const unauthenticated = await call({ idempotencyKey: 'status-key-0001' })
    assert.equal(unauthenticated.response.status, 401)

    const missingHeader = await call({ secret: ownerKey.secret })
    assert.equal(missingHeader.response.status, 400)
    assert.equal(missingHeader.payload.error.code, 'idempotency_key_required')

    const invalidHeader = await call({ secret: ownerKey.secret, idempotencyKey: 'short' })
    assert.equal(invalidHeader.response.status, 400)
    assert.equal(invalidHeader.payload.error.code, 'invalid_idempotency_key')

    const queryLeak = await call({
      secret: ownerKey.secret,
      path: `${LOOKUP_PATH}?idempotencyKey=status-key-0001`,
    })
    assert.equal(queryLeak.response.status, 400)
    assert.equal(queryLeak.payload.error.code, 'unsupported_fields')
  })
})

test('idempotency-key status lookup is consumer-scoped, safe-projected, and creates no usage or upstream call', async () => {
  await withFixture(async ({ store, tenant, owner, ownerKey, otherKey, call, upstreamCalls }) => {
    const idempotencyKey = 'status-key-committed-0001'
    const seeded = await reserve(store, {
      tenant,
      consumer: owner,
      apiKey: ownerKey,
      idempotencyKey,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    await store.commitRequest(seeded.id, {
      responseStatus: 200,
      responseBody: { private: 'must-not-leak' },
      unitsActual: 3,
      upstreamLatencyMs: 42,
    })
    const usageCount = store.requests.size

    const isolated = await call({ secret: otherKey.secret, idempotencyKey })
    assert.equal(isolated.response.status, 404)
    assert.equal(isolated.payload.error.code, 'request_not_found')

    const found = await call({ secret: ownerKey.secret, idempotencyKey })
    assert.equal(found.response.status, 200)
    assert.equal(found.payload.data.id, seeded.id)
    assert.equal(found.payload.data.status, 'committed')
    assert.equal(found.payload.data.platform, 'ecommerce')
    assert.equal(found.payload.data.units, 3)
    assert.match(found.payload.requestId, /^[0-9a-f-]{36}$/u)
    assert.notEqual(found.payload.requestId, seeded.id)
    for (const privateField of ['apiKeyId', 'consumerId', 'tenantId', 'fingerprint', 'idempotencyKey', 'responseBody']) {
      assert.equal(found.payload.data[privateField], undefined)
    }
    assert.equal(store.requests.size, usageCount)
    assert.equal(upstreamCalls(), 0)
  })
})

test('idempotency-key status lookup reuses stale-reservation convergence without retrying upstream', async () => {
  await withFixture(async ({ store, tenant, owner, ownerKey, call, upstreamCalls }) => {
    const idempotencyKey = 'status-key-expired-0001'
    const seeded = await reserve(store, {
      tenant,
      consumer: owner,
      apiKey: ownerKey,
      idempotencyKey,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    })
    const usageCount = store.requests.size

    const found = await call({ secret: ownerKey.secret, idempotencyKey })
    assert.equal(found.response.status, 200)
    assert.equal(found.payload.data.id, seeded.id)
    assert.equal(found.payload.data.status, 'unknown')
    assert.equal(found.payload.data.errorCode, 'reservation_lease_expired')
    assert.equal(found.payload.data.units, null)
    assert.ok(found.payload.data.completedAt)
    assert.equal(store.requests.size, usageCount)
    assert.equal(upstreamCalls(), 0)
  })
})
