import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
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

test('one consumer grant covers rotated keys while ecommerce accounting keeps delivery modes separate', async () => {
  const usageStore = new MemoryStore()
  const mediaLoads = []
  const service = new HubService({
    store: usageStore,
    adapter: {},
    apiKeyPepper: PEPPER,
    externalImageLoader: async (sourceUrl, options) => {
      mediaLoads.push({ sourceUrl, options })
      return { body: Buffer.from('verified-image'), contentType: 'image/png' }
    },
  })
  const tenant = await service.createTenant({ name: 'HTTP Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'HTTP Consumer' })
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'HTTP Key' })
  const rotatedApiKey = await service.createApiKey({ consumerId: consumer.id, name: 'Rotated HTTP Key' })
  const testApiKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Legacy Test HTTP Key',
    environment: 'test',
  })
  // Simulate a row created before environment metadata was backfilled. The
  // immutable prefix remains authoritative enough to fail closed.
  usageStore.apiKeys.get(testApiKey.id).environment = 'live'
  await service.putPlatformConfiguration('ecommerce', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 20,
  })
  await usageStore.setPlatformGrant(consumer.id, 'youtube', true)
  service.adapter.capabilities = async () => ({
    // A broad legacy adapter must not override the Test-key readiness gate.
    data: { platforms: [{ platform: 'ecommerce', ready: true }], legacySearch: null },
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
              shop: { id: null, name: null }, images: ['https://images.example.test/camera.png'],
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
  service.externalPlatformCapabilities = () => gateway.capabilities()
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
  const request = async (idempotencyKey, secret = apiKey.secret, body = BODY) => {
    const response = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    })
    return { response, payload: await response.json() }
  }

  try {
    const preflight = await fetch(`${baseUrl}${PATH}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://insight.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, idempotency-key',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      assert.match(preflight.headers.get('access-control-allow-methods') || '', new RegExp(method, 'u'))
    }
    for (const header of ['authorization', 'content-type', 'idempotency-key', 'x-api-key']) {
      assert.match(preflight.headers.get('access-control-allow-headers') || '', new RegExp(header, 'u'))
    }
    assert.equal(adapterCalls, 0)
    assert.equal(platformStore.calls.size, 0)

    const testCapabilities = await fetch(`${baseUrl}/api/v1/data/capabilities`, {
      headers: { authorization: `Bearer ${testApiKey.secret}` },
    })
    const testCapabilitiesPayload = await testCapabilities.json()
    const testEcommerce = testCapabilitiesPayload.data.platforms.find((entry) => entry.platform === 'ecommerce')
    assert.equal(testCapabilities.status, 200)
    assert.equal(testEcommerce?.ready, false)

    const rejectedTest = await request('http-test-key-0001', testApiKey.secret)
    assert.equal(rejectedTest.response.status, 403)
    assert.equal(rejectedTest.payload.error.code, 'test_key_not_supported')

    const rejectedTestMediaUrl = new URL('/api/v1/data/ecommerce/products/media', baseUrl)
    rejectedTestMediaUrl.searchParams.set('requestId', randomUUID())
    rejectedTestMediaUrl.searchParams.set('itemId', 'jd:sku-1')
    rejectedTestMediaUrl.searchParams.set('imageIndex', '0')
    const rejectedTestMedia = await fetch(rejectedTestMediaUrl, {
      headers: { authorization: `Bearer ${testApiKey.secret}` },
    })
    assert.equal(rejectedTestMedia.status, 403)
    assert.equal((await rejectedTestMedia.json()).error.code, 'test_key_not_supported')
    assert.equal(adapterCalls, 0)
    assert.equal(mediaLoads.length, 0)
    assert.equal(platformStore.calls.size, 0)
    const usageAfterTestRejection = await usageStore.usage({ consumerId: consumer.id })
    assert.equal(usageAfterTestRejection.requests, 0)
    assert.equal(usageAfterTestRejection.committed, 0)
    assert.equal(usageAfterTestRejection.units, 0)
    assert.deepEqual(usageAfterTestRejection.byPlatform, {})

    const cacheOnlyMiss = await request(
      'http-cache-miss-01',
      apiKey.secret,
      { marketplace: 'jd', query: 'not-yet-retained', deliveryMode: 'cache_only' },
    )
    assert.equal(cacheOnlyMiss.response.status, 404)
    assert.equal(cacheOnlyMiss.payload.error.code, 'stored_snapshot_not_found')
    assert.equal(adapterCalls, 0)
    assert.equal(platformStore.calls.size, 0)

    const refreshWithoutKey = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...BODY, deliveryMode: 'refresh' }),
    })
    assert.equal(refreshWithoutKey.status, 400)
    assert.equal((await refreshWithoutKey.json()).error.code, 'idempotency_key_required')
    assert.equal(adapterCalls, 0)

    const refreshBody = { ...BODY, deliveryMode: 'refresh' }
    const live = await request('http-live-key-0001', apiKey.secret, refreshBody)
    const cached = await request(
      'http-cache-key-001',
      rotatedApiKey.secret,
      { ...BODY, deliveryMode: 'cache_only' },
    )

    assert.equal(live.response.status, 200)
    assert.equal(cached.response.status, 200)
    assert.equal(live.response.headers.get('access-control-allow-origin'), '*')
    const exposedHeaders = live.response.headers.get('access-control-expose-headers') || ''
    for (const header of ['idempotent-replay', 'x-mx-insight-request-id', 'x-mx-insight-source-mode', 'x-mx-insight-captured-at', 'age', 'warning']) {
      assert.match(exposedHeaders, new RegExp(header, 'u'))
    }
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
    assert.equal(usageAfterCache.requests, 3)
    assert.equal(usageAfterCache.committed, 2)
    assert.equal(usageAfterCache.units, 2)

    const replay = await request('http-live-key-0001', rotatedApiKey.secret, refreshBody)
    assert.equal(replay.response.status, 200)
    assert.equal(replay.payload.meta.sourceMode, 'idempotent_replay')
    assert.equal(replay.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(replay.response.headers.get('x-mx-insight-request-id'), live.payload.requestId)
    assert.equal(replay.payload.requestId, live.payload.requestId)
    assert.equal(replay.payload.meta.capturedAt, capturedAt)
    assert.deepEqual(replay.payload.data.items, live.payload.data.items)

    const mediaUrl = new URL('/api/v1/data/ecommerce/products/media', baseUrl)
    mediaUrl.searchParams.set('requestId', live.payload.requestId)
    mediaUrl.searchParams.set('itemId', live.payload.data.items[0].id)
    mediaUrl.searchParams.set('imageIndex', '0')
    const mediaHeaders = { authorization: `Bearer ${rotatedApiKey.secret}` }

    const unsupportedUrl = new URL(mediaUrl)
    unsupportedUrl.searchParams.set('url', 'https://attacker.invalid/image.png')
    const unsupported = await fetch(unsupportedUrl, { headers: mediaHeaders })
    assert.equal(unsupported.status, 400)
    assert.equal((await unsupported.json()).error.code, 'unsupported_fields')

    const repeated = await fetch(`${mediaUrl}&imageIndex=1`, { headers: mediaHeaders })
    assert.equal(repeated.status, 400)
    assert.equal((await repeated.json()).error.code, 'invalid_request')

    const media = await fetch(mediaUrl, { headers: mediaHeaders })
    assert.equal(media.status, 200)
    assert.equal(media.headers.get('content-type'), 'image/png')
    assert.equal(media.headers.get('cache-control'), 'private, no-store')
    assert.equal(media.headers.get('vary'), 'Authorization')
    assert.equal(media.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(media.headers.get('access-control-allow-origin'), '*')
    assert.equal(Buffer.from(await media.arrayBuffer()).toString(), 'verified-image')
    assert.equal(mediaLoads.length, 1)
    assert.equal(mediaLoads[0].sourceUrl, 'https://images.example.test/camera.png')
    assert.equal(mediaLoads[0].options.cacheScope, consumer.id)

    const usageAfterReplay = await usageStore.usage({ consumerId: consumer.id })
    assert.deepEqual(usageAfterReplay, usageAfterCache)
    assert.equal(adapterCalls, 1)
    assert.equal(platformStore.calls.size, 1)

    const unauthorized = await fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), '*')

    const analytics = await platformStore.analytics({ from: new Date(0) })
    assert.equal(analytics.totals.hubRequests, 4)
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

test('media route does not begin a relay after the client disconnects during authentication', async () => {
  let releaseAuthentication
  let authenticationStarted
  const authenticationStartedPromise = new Promise((resolve) => { authenticationStarted = resolve })
  const authenticationReleasePromise = new Promise((resolve) => { releaseAuthentication = resolve })
  let mediaCalls = 0
  const service = {
    async authenticate() {
      authenticationStarted()
      await authenticationReleasePromise
      return { consumer: { id: randomUUID() } }
    },
    async ecommerceProductImage() {
      mediaCalls += 1
      return { body: Buffer.from('must-not-run'), contentType: 'image/png' }
    },
  }
  const app = createApp({
    service,
    store: {},
    adapter: {},
    listenerMode: 'public',
    logger: { error() {} },
  })
  const server = createServer(app)
  const serverObservedClose = new Promise((resolve) => {
    server.once('request', (_request, response) => response.once('close', resolve))
  })
  const baseUrl = await listen(server)
  const target = new URL('/api/v1/data/ecommerce/products/media', baseUrl)
  target.searchParams.set('requestId', randomUUID())
  target.searchParams.set('itemId', 'product-1')
  target.searchParams.set('imageIndex', '0')

  try {
    const client = httpRequest(target, {
      headers: { authorization: 'Bearer mih_test_disconnect_check' },
    })
    client.on('error', () => {})
    client.end()
    await authenticationStartedPromise
    const closed = new Promise((resolve) => client.once('close', resolve))
    client.destroy()
    await closed
    await serverObservedClose
    releaseAuthentication()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(mediaCalls, 0)
  } finally {
    releaseAuthentication()
    await close(server)
  }
})
