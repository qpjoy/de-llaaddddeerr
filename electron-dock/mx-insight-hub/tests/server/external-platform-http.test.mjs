import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'external-platform-http-test-pepper-with-entropy'
const PATH = '/api/v1/data/ecommerce/products/search'
const BODY = { marketplace: 'jd', query: 'camera' }

function gatewayConfig() {
  return {
    configured: true,
    contractVerified: true,
    dispatchEnabled: true,
    configurationError: null,
    freshTtlMs: 300_000,
    staleTtlMs: 86_400_000,
    unknownFingerprintCooldownMs: 900_000,
    maxConcurrency: 8,
    maxConsumerConcurrency: 2,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
    billing: {
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-01T00:00:00.000Z',
      freeDailyCalls: null,
      monthlyBudgetMinor: null,
      unitCostMinorByEndpoint: { 'jd.product-search.v1': 5 },
    },
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

test('public ecommerce route separates live, fresh cache and idempotent replay accounting', async () => {
  const usageStore = new MemoryStore()
  const service = new HubService({ store: usageStore, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'HTTP Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'HTTP Consumer' })
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'HTTP Key' })
  await service.putPlatformConfiguration('ecommerce', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 20,
  })

  let adapterCalls = 0
  const capturedAt = new Date().toISOString()
  const adapter = {
    async searchProducts() {
      adapterCalls += 1
      return {
        publicBody: {
          contractVersion: 'mx-insight-hub.ecommerce-products.v1',
          data: {
            items: [{
              id: 'jd:sku-1', marketplace: 'jd', title: 'Camera', url: null,
              pricing: { current: '399', original: null, currency: 'CNY' },
              shop: { id: null, name: null }, images: [],
              signals: { sales: null, reviewCount: null, location: null },
              attributes: { brand: null, category: null },
            }],
            page: {
              page: 1,
              returnedCount: 1,
              discardedCount: 0,
              hasMore: false,
              nextCursor: null,
            },
          },
          meta: { capturedAt },
        },
        items: [{ id: 'jd:sku-1' }],
        archiveObjects: [],
        records: [],
      }
    },
  }
  const platformStore = new MemoryExternalPlatformStore({
    usageStore,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
  })
  const gateway = new ExternalPlatformGateway({
    usageStore,
    platformStore,
    adapter,
    config: gatewayConfig(),
    apiKeyPepper: PEPPER,
    reservationLeaseMs: 150_000,
    logger: { warn() {}, error() {} },
  })
  const app = createApp({
    service,
    store: usageStore,
    adapter: {},
    adminToken: null,
    externalPlatformGateway: gateway,
    listenerMode: 'public',
    logger: { error() {} },
  })
  const server = createServer(app)
  const baseUrl = await listen(server)
  const request = async (idempotencyKey) => {
    const response = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey.secret}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(BODY),
    })
    return { response, payload: await response.json() }
  }

  try {
    const live = await request('http-live-key-0001')
    const cached = await request('http-cache-key-001')

    assert.equal(live.response.status, 200)
    assert.equal(cached.response.status, 200)
    assert.equal(live.payload.contractVersion, 'mx-insight-hub.ecommerce-products.v1')
    assert.equal(cached.payload.contractVersion, 'mx-insight-hub.ecommerce-products.v1')
    assert.equal(live.payload.meta.sourceMode, 'live')
    assert.equal(cached.payload.meta.sourceMode, 'fresh_cache')
    assert.equal(live.response.headers.get('x-mx-insight-source-mode'), 'live')
    assert.equal(cached.response.headers.get('x-mx-insight-source-mode'), 'fresh_cache')
    assert.equal(live.response.headers.get('idempotent-replay'), 'false')
    assert.equal(cached.response.headers.get('idempotent-replay'), 'false')
    assert.equal(live.response.headers.get('x-mx-insight-request-id'), live.payload.requestId)
    assert.equal(cached.response.headers.get('x-mx-insight-request-id'), cached.payload.requestId)
    assert.notEqual(cached.payload.requestId, live.payload.requestId)
    assert.equal(live.response.headers.get('x-mx-insight-captured-at'), capturedAt)
    assert.equal(cached.response.headers.get('x-mx-insight-captured-at'), capturedAt)
    assert.match(live.response.headers.get('age'), /^\d+$/u)
    assert.match(cached.response.headers.get('age'), /^\d+$/u)
    assert.equal(live.payload.meta.capturedAt, capturedAt)
    assert.equal(cached.payload.meta.capturedAt, capturedAt)
    assert.deepEqual(cached.payload.data.items, live.payload.data.items)

    const usageAfterCache = await usageStore.usage({ consumerId: consumer.id })
    assert.equal(usageAfterCache.requests, 2)
    assert.equal(usageAfterCache.committed, 2)
    assert.equal(usageAfterCache.units, 2)

    const replay = await request('http-live-key-0001')
    assert.equal(replay.response.status, 200)
    assert.equal(replay.payload.meta.sourceMode, 'idempotent_replay')
    assert.equal(replay.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(replay.response.headers.get('x-mx-insight-request-id'), live.payload.requestId)
    assert.equal(replay.payload.requestId, live.payload.requestId)
    assert.equal(replay.payload.meta.capturedAt, capturedAt)
    assert.deepEqual(replay.payload.data.items, live.payload.data.items)

    const usageAfterReplay = await usageStore.usage({ consumerId: consumer.id })
    assert.deepEqual(usageAfterReplay, usageAfterCache)
    assert.equal(adapterCalls, 1)
    assert.equal(platformStore.calls.size, 1)
    const analytics = await platformStore.analytics({ from: new Date(0) })
    assert.equal(analytics.totals.hubRequests, 3)
    assert.equal(analytics.totals.upstreamCalls, 1)
    assert.equal(analytics.totals.billedCalls, 1)
    assert.equal(analytics.totals.knownCostMinor, 5)
    assert.equal(analytics.totals.freshCache, 1)
    assert.equal(analytics.totals.idempotentReplay, 1)
  } finally {
    await close(server)
    await usageStore.close()
  }
})
