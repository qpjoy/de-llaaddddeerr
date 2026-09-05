import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JustOneAdapter, JustOneRejectedError } from '../../server/adapters/justone.mjs'
import { normalizeJustOneProductSearchRequest } from '../../server/contracts/justone.mjs'
import { ExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'external-platform-test-pepper-with-entropy'
const ENDPOINT_KEY = 'jd.product-search.v1'

function config(overrides = {}) {
  return {
    token: 'configured',
    configured: true,
    contractVerified: true,
    dispatchEnabled: true,
    configurationError: null,
    timeoutMs: 60_000,
    freshTtlMs: 60_000,
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
      monthlyBudgetMinor: 10_000,
      unitCostMinorByEndpoint: { 'jd.product-search.v1': 5 },
    },
    ...overrides,
  }
}

async function fixture({ adapter, gatewayConfig = config() } = {}) {
  const usageStore = new MemoryStore()
  const hub = new HubService({
    store: usageStore,
    adapter: {},
    apiKeyPepper: PEPPER,
  })
  const tenant = await hub.createTenant({ name: 'Tenant A' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'Consumer A' })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'Key A' })
  await usageStore.setPlatformGrant(consumer.id, 'ecommerce', true)
  await usageStore.putPolicy({
    tenantId: tenant.id,
    consumerId: consumer.id,
    platform: 'ecommerce',
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const context = await hub.authenticate(key.secret)
  const platformStore = new MemoryExternalPlatformStore({
    usageStore,
    circuitFailureThreshold: gatewayConfig.circuitFailureThreshold,
    circuitOpenMs: gatewayConfig.circuitOpenMs,
  })
  const gateway = new ExternalPlatformGateway({
    usageStore,
    platformStore,
    adapter,
    config: gatewayConfig,
    apiKeyPepper: PEPPER,
    reservationLeaseMs: 150_000,
    logger: { warn() {} },
  })
  return { usageStore, platformStore, gateway, context, gatewayConfig }
}

function successfulResult(body, options) {
  const request = normalizeJustOneProductSearchRequest(body, options)
  const capturedAt = new Date(options.capturedAt ?? Date.now()).toISOString()
  return {
    publicBody: {
      contractVersion: 'mx-insight-hub.ecommerce-products.v1',
      data: {
        items: [{
          id: 'sku-1', marketplace: request.marketplace, title: 'Product', url: null,
          pricing: { current: '9.9', original: null, currency: 'CNY' },
          shop: { id: null, name: null }, images: [],
          signals: { sales: null, reviewCount: null, location: null },
          attributes: { brand: null, category: null },
        }],
        page: { page: request.page, returnedCount: 1, discardedCount: 0, hasMore: false, nextCursor: null },
      },
      meta: { capturedAt },
    },
    items: [{ id: 'sku-1' }],
    archiveObjects: [{
      marketplace: request.marketplace,
      endpointVersion: 'v1',
      archivePath: `justone/${request.marketplace}/product-search/v1/2026-09-03/hash.json`,
      sourceKey: 'source-catalog-0060',
      payloadSha256: 'a'.repeat(64),
      rawPayload: { skuId: 'sku-1' },
    }],
    records: [],
  }
}

test('snapshot freshness starts at accepted response capture, not dispatch start', async () => {
  let acceptedAfter = null
  let receivedDispatchTimestamp = false
  const adapter = {
    async searchProducts(body, options) {
      receivedDispatchTimestamp = Object.hasOwn(options, 'capturedAt')
      await new Promise((resolve) => setTimeout(resolve, 20))
      acceptedAfter = Date.now()
      return successfulResult(body, options)
    },
  }
  const state = await fixture({
    adapter,
    gatewayConfig: config({ freshTtlMs: 5_000, staleTtlMs: 60_000 }),
  })

  await state.gateway.search(state.context, {
    body: { marketplace: 'jd', query: 'camera' },
    idempotencyKey: 'accepted-capture-01',
    path: '/api/v1/data/ecommerce/products/search',
  })

  const [snapshot] = [...state.platformStore.snapshots.values()]
  const capturedAt = new Date(snapshot.capturedAt).getTime()
  assert.equal(receivedDispatchTimestamp, false)
  assert.ok(capturedAt >= acceptedAfter)
  assert.equal(new Date(snapshot.freshUntil).getTime() - capturedAt, 5_000)
  assert.equal(new Date(snapshot.staleUntil).getTime() - capturedAt, 60_000)
})

test('live, fresh-cache and idempotent replay are separate delivery modes and only live dispatches cost', async () => {
  let calls = 0
  const adapter = {
    async searchProducts(body, options) {
      calls += 1
      return successfulResult(body, options)
    },
  }
  const body = { marketplace: 'jd', query: 'camera' }
  const stable = await fixture({ adapter })
  const live = await stable.gateway.search(stable.context, {
    body,
    idempotencyKey: 'request-live-0002',
    path: '/api/v1/data/ecommerce/products/search',
  })
  const cached = await stable.gateway.search(stable.context, {
    body,
    idempotencyKey: 'request-cache-0001',
    path: '/api/v1/data/ecommerce/products/search',
  })
  const replay = await stable.gateway.search(stable.context, {
    body,
    idempotencyKey: 'request-live-0002',
    path: '/api/v1/data/ecommerce/products/search',
  })

  assert.equal(live.sourceMode, 'live')
  assert.equal(cached.sourceMode, 'fresh_cache')
  assert.equal(replay.sourceMode, 'idempotent_replay')
  assert.equal(replay.replay, true)
  assert.equal(live.body.meta.sourceMode, 'live')
  assert.equal(cached.body.meta.sourceMode, 'fresh_cache')
  assert.equal(replay.body.meta.sourceMode, 'idempotent_replay')
  assert.equal(calls, 1, 'cache delivery and replay never dispatch upstream')

  const analytics = await stable.platformStore.analytics({ from: new Date(Date.now() - 60_000) })
  assert.equal(analytics.totals.upstreamCalls, 1)
  assert.equal(analytics.totals.freshCache, 1)
  assert.equal(analytics.totals.idempotentReplay, 1)
  assert.equal(analytics.totals.knownCostMinor, 5)
})

test('missing dynamic credential fails closed before a provider call is recorded', async () => {
  let resolutions = 0
  let dispatches = 0
  const adapter = new JustOneAdapter({
    credentialResolver: async () => {
      resolutions += 1
      return null
    },
    fetchImpl: async () => {
      dispatches += 1
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  const state = await fixture({ adapter })

  assert.equal((await state.gateway.capabilities()).ready, false)
  await assert.rejects(
    () => state.gateway.search(state.context, {
      body: { marketplace: 'jd', query: 'camera' },
      idempotencyKey: 'missing-credential-0001',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error instanceof AppError
      && error.status === 503
      && error.code === 'external_platform_not_configured',
  )

  assert.equal(resolutions, 2, 'capability and dispatch checks each read current credential state once')
  assert.equal(dispatches, 0)
  assert.equal(state.platformStore.calls.size, 0)
  assert.equal(state.platformStore.requests.at(-1)?.sourceMode, 'unavailable')
})

test('gateway resolves one credential before recording and dispatching a provider call', async () => {
  let resolutions = 0
  let dispatchedToken = null
  const adapter = new JustOneAdapter({
    credentialResolver: async () => {
      resolutions += 1
      return 'database-token'
    },
    fetchImpl: async (url) => {
      dispatchedToken = new URL(url).searchParams.get('token')
      return new Response(JSON.stringify({
        code: 0,
        message: null,
        data: { items: [{ skuId: 'sku-1', title: 'Product' }], hasMore: false },
        recordTime: '2026-09-03T00:00:00Z',
        requestId: 'request-1',
      }), { headers: { 'content-type': 'application/json' } })
    },
  })
  const state = await fixture({ adapter })

  const result = await state.gateway.search(state.context, {
    body: { marketplace: 'jd', query: 'camera' },
    idempotencyKey: 'dynamic-credential-0001',
    path: '/api/v1/data/ecommerce/products/search',
  })

  assert.equal(result.sourceMode, 'live')
  assert.equal(resolutions, 1)
  assert.equal(dispatchedToken, 'database-token')
  assert.equal(state.platformStore.calls.size, 1)
})

test('a definite provider capacity error returns an exact stored fallback without redispatch', async () => {
  let fail = false
  let calls = 0
  const adapter = {
    async searchProducts(body, options) {
      calls += 1
      if (fail) {
        throw new JustOneRejectedError({
          outcome: 'rejected', httpStatus: 200, businessCode: 601,
          billed: false, errorCode: 'upstream_balance_exhausted', retryable: false,
        })
      }
      return successfulResult(body, options)
    },
  }
  const state = await fixture({ adapter, gatewayConfig: config({ freshTtlMs: 1 }) })
  const body = { marketplace: 'jd', query: 'camera' }
  await state.gateway.search(state.context, {
    body,
    idempotencyKey: 'fallback-live-01',
    path: '/api/v1/data/ecommerce/products/search',
  })
  await new Promise((resolve) => setTimeout(resolve, 3))
  fail = true
  const fallback = await state.gateway.search(state.context, {
    body,
    idempotencyKey: 'fallback-next-01',
    path: '/api/v1/data/ecommerce/products/search',
  })
  assert.equal(fallback.sourceMode, 'stored_fallback')
  assert.equal(fallback.body.meta.fallbackReason, 'upstream_balance_exhausted')
  assert.equal(fallback.body.data.items[0].id, 'sku-1')
  assert.equal(calls, 2, 'the failed upstream request is not retried')
})

test('a definite request rejection is durably replayed and never advances the provider circuit', async () => {
  let calls = 0
  const adapter = {
    async searchProducts() {
      calls += 1
      throw new JustOneRejectedError({
        outcome: 'rejected',
        httpStatus: 200,
        businessCode: 400,
        billed: false,
        errorCode: 'invalid_request',
        circuitCategory: 'request',
        affectsCircuit: false,
        retryable: false,
      })
    },
  }
  const state = await fixture({
    adapter,
    gatewayConfig: config({ circuitFailureThreshold: 1 }),
  })
  const request = () => state.gateway.search(state.context, {
    body: { marketplace: 'jd', query: 'camera' },
    idempotencyKey: 'rejected-replay-01',
    path: '/api/v1/data/ecommerce/products/search',
  })

  let first
  await assert.rejects(request, (error) => {
    first = error
    assert.equal(error.status, 502)
    assert.equal(error.code, 'external_platform_rejected')
    assert.match(error.details.requestId, /^[0-9a-f-]{36}$/u)
    return true
  })
  await assert.rejects(request, (error) => {
    assert.equal(error.status, first.status)
    assert.equal(error.code, first.code)
    assert.equal(error.message, first.message)
    assert.equal(error.details.requestId, first.details.requestId)
    return true
  })

  assert.equal(calls, 1)
  assert.equal(state.platformStore.state.consecutiveFailures, 0)
  assert.equal(state.platformStore.state.circuitOpenUntil, null)
  const usage = state.usageStore.requests.get(first.details.requestId)
  assert.equal(usage.status, 'committed')
  assert.equal(usage.responseStatus, 502)
  assert.equal(usage.responseBody.error.code, 'external_platform_rejected')
  const replayEvent = state.platformStore.requests.at(-1)
  assert.equal(replayEvent.sourceMode, 'idempotent_replay')
  assert.equal(replayEvent.succeeded, false)
  assert.equal(replayEvent.responseStatus, 502)
})

test('authentication failures advance the global circuit and retain a durable request id', async () => {
  const state = await fixture({
    adapter: {
      async searchProducts() {
        throw new JustOneRejectedError({
          outcome: 'rejected',
          httpStatus: 200,
          businessCode: 100,
          billed: false,
          errorCode: 'upstream_auth_invalid',
          circuitCategory: 'authentication',
          affectsCircuit: true,
          retryable: false,
        })
      },
    },
    gatewayConfig: config({ circuitFailureThreshold: 1 }),
  })

  await assert.rejects(
    () => state.gateway.search(state.context, {
      body: { marketplace: 'jd', query: 'camera' },
      idempotencyKey: 'auth-circuit-001',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error.code === 'external_platform_capacity_unavailable'
      && typeof error.details?.requestId === 'string',
  )
  assert.equal(state.platformStore.state.consecutiveFailures, 1)
  assert.ok(new Date(state.platformStore.state.circuitOpenUntil) > new Date())
})

test('a pre-dispatch platform-store failure releases the owned usage reservation', async () => {
  const state = await fixture({ adapter: { searchProducts: successfulResult } })
  state.platformStore.snapshotFor = async () => {
    throw new AppError(503, 'external_platform_store_unavailable', 'External platform store is unavailable')
  }

  let durableRequestId
  await assert.rejects(
    () => state.gateway.search(state.context, {
      body: { marketplace: 'jd', query: 'camera' },
      idempotencyKey: 'store-failure-001',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => {
      durableRequestId = error.details?.requestId
      assert.equal(error.code, 'external_platform_store_unavailable')
      assert.match(durableRequestId, /^[0-9a-f-]{36}$/u)
      return true
    },
  )
  assert.equal(state.usageStore.requests.get(durableRequestId).status, 'released')
  assert.equal(
    state.usageStore.requests.get(durableRequestId).errorCode,
    'external_platform_pre_dispatch_failed',
  )
})

test('cross-key equal requests use a dispatch lease and never create a second paid call', async () => {
  let release
  let calls = 0
  const gate = new Promise((resolve) => { release = resolve })
  const adapter = {
    async searchProducts(body, options) {
      calls += 1
      await gate
      return successfulResult(body, options)
    },
  }
  const state = await fixture({ adapter })
  const request = (key) => state.gateway.search(state.context, {
    body: { marketplace: 'jd', query: 'camera' },
    idempotencyKey: key,
    path: '/api/v1/data/ecommerce/products/search',
  })
  const leader = request('concurrent-leader')
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(
    () => request('concurrent-follower'),
    (error) => error?.code === 'request_in_progress',
  )
  release()
  await leader
  assert.equal(calls, 1)
})

test('a billed code=0 response that cannot be normalized is archived and never redispatched automatically', async () => {
  let calls = 0
  const adapter = new JustOneAdapter({
    token: 'provider-secret-that-must-not-be-stored',
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({
        code: 0,
        message: null,
        data: { providerChangedShape: [] },
        recordTime: '2026-09-03T00:00:00Z',
        requestId: 'upstream-request-1',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const state = await fixture({ adapter })
  await assert.rejects(
    () => state.gateway.search(state.context, {
      body: { marketplace: 'jd', query: 'camera' },
      idempotencyKey: 'unusable-shape-01',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error?.code === 'external_platform_response_unusable',
  )
  await assert.rejects(
    () => state.gateway.search(state.context, {
      // Contract drift is endpoint-scoped: do not spend another call probing a
      // different query on the same endpoint during the quarantine window.
      body: { marketplace: 'jd', query: 'different camera query' },
      idempotencyKey: 'unusable-shape-02',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error?.status === 409
      && error?.code === 'external_platform_response_unusable'
      && typeof error.details?.requestId === 'string',
  )

  assert.equal(calls, 1)
  const [call] = [...state.platformStore.calls.values()]
  assert.equal(call.outcome, 'succeeded_unusable')
  assert.equal(call.billed, true)
  assert.equal(call.costMinor, 5)
  assert.equal(call.upstreamRequestId, 'upstream-request-1')
  assert.equal(state.platformStore.responseArchives.size, 1)
  assert.doesNotMatch(
    JSON.stringify([...state.platformStore.responseArchives.values()]),
    /provider-secret-that-must-not-be-stored/u,
  )
  const analytics = await state.platformStore.analytics({ from: new Date(Date.now() - 60_000) })
  assert.equal(analytics.totals.billedCalls, 1)
  assert.equal(analytics.totals.unusableSuccesses, 1)
  assert.equal(analytics.totals.successfulUpstreamCalls, 1)
  assert.equal(analytics.totals.usableUpstreamCalls, 0)
})

test('an ambiguous dispatch quarantines its exact fingerprint without spending another call', async () => {
  let calls = 0
  const adapter = new JustOneAdapter({
    token: 'secret-token',
    fetchImpl: async () => {
      calls += 1
      throw new Error('connection ended without a response')
    },
  })
  const state = await fixture({ adapter })
  const body = { marketplace: 'jd', query: 'camera' }
  await assert.rejects(
    () => state.gateway.search(state.context, {
      body,
      idempotencyKey: 'ambiguous-call-01',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error?.code === 'external_platform_outcome_unknown'
      && typeof error.details?.requestId === 'string',
  )
  await assert.rejects(
    () => state.gateway.search(state.context, {
      body,
      idempotencyKey: 'ambiguous-call-02',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error?.status === 409
      && error?.code === 'request_outcome_unknown'
      && typeof error.details?.requestId === 'string',
  )
  assert.equal(calls, 1)
})

test('a post-dispatch persistence failure closes call and usage evidence as unknown', async () => {
  const state = await fixture({
    adapter: { searchProducts: successfulResult },
  })
  state.platformStore.commitLiveDelivery = async () => {
    throw new Error('database connection lost during commit')
  }

  await assert.rejects(
    () => state.gateway.search(state.context, {
      body: { marketplace: 'jd', query: 'camera' },
      idempotencyKey: 'persistence-failure-01',
      path: '/api/v1/data/ecommerce/products/search',
    }),
    (error) => error instanceof AppError
      && error.status === 500
      && error.code === 'internal_error'
      && typeof error.details?.requestId === 'string'
      && !error.message.includes('database connection lost'),
  )
  const [call] = [...state.platformStore.calls.values()]
  assert.equal(call.outcome, 'unknown')
  assert.equal(call.billed, true)
  const usage = state.usageStore.requests.get(call.usageRequestId)
  assert.equal(usage.status, 'unknown')
})

test('admin projection keeps unknown price/quota distinct from zero and reports the capability gaps', async () => {
  const state = await fixture({
    adapter: { searchProducts: successfulResult },
    gatewayConfig: config({
      token: null,
      configured: false,
      dispatchEnabled: false,
      billing: {
        source: 'unknown', currency: null, pricingAsOf: null, freeDailyCalls: null,
        monthlyBudgetMinor: null, unitCostMinorByEndpoint: {},
      },
    }),
  })
  const admin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
    durable: false,
  })
  const detail = await admin.detail('justone', '7d')
  assert.equal(detail.provider.status, 'not_configured')
  assert.equal(detail.provider.quota.freeDailyCalls, null)
  assert.equal(detail.costPlan.projectedMonthlyCostMinor, null)
  assert.equal(detail.capabilities.find((entry) => entry.capability === 'search_intent').providerMapping, 'hub_orchestration')
  assert.equal(
    detail.capabilities.find((entry) => entry.capability === 'youtube_channel_comments').providerMapping,
    'composed_no_direct_equivalent',
  )
})

test('admin cost and quota forecasts fail closed while provider billing is indeterminate', async () => {
  const billing = {
    source: 'manual',
    currency: 'CNY',
    pricingAsOf: '2026-09-01T00:00:00.000Z',
    freeDailyCalls: 100,
    monthlyBudgetMinor: 10_000,
    unitCostMinorByEndpoint: { [ENDPOINT_KEY]: 5 },
  }
  const state = await fixture({
    adapter: null,
    gatewayConfig: config({ billing }),
  })
  state.platformStore.calls.set('unknown-billing', {
    id: 'unknown-billing',
    tenantId: state.context.tenantId,
    consumerId: state.context.consumerId,
    operation: 'ecommerce.products.search',
    endpointKey: ENDPOINT_KEY,
    outcome: 'unknown',
    billed: null,
    costMinor: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const admin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
  })

  const detail = await admin.detail('justone', '7d')
  assert.equal(detail.provider.metrics.indeterminateBillingCalls, 1)
  assert.equal(detail.costPlan.indeterminateBillingCalls, 1)
  assert.equal(detail.costPlan.projectedMonthlyCalls, 5)
  assert.equal(detail.costPlan.projectedPaidCalls, null)
  assert.equal(detail.costPlan.projectedMonthlyCostMinor, null)
  assert.equal(detail.costPlan.confidence, 'unknown')
  assert.match(detail.costPlan.recommendation, /计费状态尚未确定/u)
  assert.equal(detail.provider.quota.usedToday, null)
  assert.equal(detail.provider.quota.remainingToday, null)
  assert.match(detail.provider.quota.note, /不推断已用量或剩余额度/u)
})

test('admin monthly cost remains unknown when a billed call lacks cost evidence', async () => {
  const billing = {
    source: 'manual',
    currency: 'CNY',
    pricingAsOf: '2026-09-01T00:00:00.000Z',
    freeDailyCalls: 0,
    monthlyBudgetMinor: 10_000,
    unitCostMinorByEndpoint: { [ENDPOINT_KEY]: 5 },
  }
  const state = await fixture({
    adapter: null,
    gatewayConfig: config({ billing }),
  })
  state.platformStore.calls.set('unknown-cost', {
    id: 'unknown-cost',
    tenantId: state.context.tenantId,
    consumerId: state.context.consumerId,
    operation: 'ecommerce.products.search',
    endpointKey: ENDPOINT_KEY,
    outcome: 'succeeded',
    billed: true,
    costMinor: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const admin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
  })

  const detail = await admin.detail('justone', '7d')
  assert.equal(detail.costPlan.indeterminateBillingCalls, 0)
  assert.equal(detail.costPlan.unknownCostCalls, 1)
  assert.equal(detail.costPlan.projectedPaidCalls, 5)
  assert.equal(detail.costPlan.projectedMonthlyCostMinor, null)
  assert.equal(detail.costPlan.confidence, 'unknown')
  assert.match(detail.costPlan.recommendation, /缺少单价或成本证据/u)
})

test('admin distinguishes provider success rate from Hub-usable response rate', async () => {
  const state = await fixture({ adapter: null })
  const now = new Date().toISOString()
  for (const [id, outcome] of [
    ['usable', 'succeeded'],
    ['provider-success-only', 'succeeded_unusable'],
    ['rejected', 'rejected'],
  ]) {
    state.platformStore.calls.set(id, {
      id,
      tenantId: state.context.tenantId,
      consumerId: state.context.consumerId,
      operation: 'ecommerce.products.search',
      endpointKey: ENDPOINT_KEY,
      outcome,
      billed: outcome !== 'rejected',
      costMinor: outcome === 'rejected' ? 0 : 5,
      startedAt: now,
      completedAt: now,
    })
  }
  const admin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
  })

  const detail = await admin.detail('justone', '7d')
  assert.equal(detail.provider.metrics.upstreamCalls, 3)
  assert.equal(detail.provider.metrics.successfulUpstreamCalls, 2)
  assert.equal(detail.provider.metrics.usableUpstreamCalls, 1)
  assert.equal(detail.provider.metrics.unusableSuccesses, 1)
  assert.equal(detail.provider.metrics.upstreamSuccessRate, 0.6667)
  assert.equal(detail.provider.metrics.upstreamUsableRate, 0.3333)
})

test('admin load forecast excludes known unbilled rejections from paid-call forecast', async () => {
  const billing = {
    source: 'manual',
    currency: 'CNY',
    pricingAsOf: '2026-09-01T00:00:00.000Z',
    freeDailyCalls: 0,
    monthlyBudgetMinor: 10_000,
    unitCostMinorByEndpoint: { [ENDPOINT_KEY]: 5 },
  }
  const state = await fixture({
    adapter: null,
    gatewayConfig: config({ billing }),
  })
  state.platformStore.calls.set('known-unbilled', {
    id: 'known-unbilled',
    tenantId: state.context.tenantId,
    consumerId: state.context.consumerId,
    operation: 'ecommerce.products.search',
    endpointKey: ENDPOINT_KEY,
    outcome: 'rejected',
    billed: false,
    costMinor: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const admin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
  })

  const detail = await admin.detail('justone', '7d')
  assert.equal(detail.costPlan.projectedMonthlyCalls, 5)
  assert.equal(detail.costPlan.projectedPaidCalls, 0)
  assert.equal(detail.costPlan.projectedMonthlyCostMinor, 0)
  assert.equal(detail.costPlan.confidence, 'medium')
})

test('admin keeps manual list-price estimates separate from actual net spend', async () => {
  const billing = {
    source: 'manual',
    currency: 'CNY',
    pricingAsOf: '2026-09-01T00:00:00.000Z',
    freeDailyCalls: 100,
    monthlyBudgetMinor: 10_000,
    unitCostMinorByEndpoint: { [ENDPOINT_KEY]: 5 },
  }
  const state = await fixture({
    adapter: null,
    gatewayConfig: config({ billing }),
  })
  state.platformStore.calls.set('known-billed', {
    id: 'known-billed',
    tenantId: state.context.tenantId,
    consumerId: state.context.consumerId,
    operation: 'ecommerce.products.search',
    endpointKey: ENDPOINT_KEY,
    outcome: 'succeeded',
    billed: true,
    costMinor: 5,
    costKind: 'estimated',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  })
  const admin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
  })

  const detail = await admin.detail('justone', '24h')
  assert.equal(detail.costPlan.grossEstimatedCostMinor, 5)
  assert.equal(detail.costPlan.actualCostMinor, null)
  assert.equal(detail.costPlan.projectedPaidCalls, 0)
  assert.equal(detail.costPlan.projectedMonthlyCostMinor, 0)
})

test('admin projection distinguishes contract verification from safe misconfiguration without credentials', async () => {
  const state = await fixture({
    adapter: null,
    gatewayConfig: config({
      token: null,
      configured: true,
      contractVerified: false,
      dispatchEnabled: false,
    }),
  })
  const awaitingAdmin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: state.gatewayConfig,
  })
  const awaiting = await awaitingAdmin.detail('justone', '24h')
  assert.equal(awaiting.provider.status, 'awaiting_verification')
  assert.equal(awaiting.provider.configuration.contractVerified, false)
  assert.equal(awaiting.provider.configuration.dispatchEligible, false)
  assert.equal(awaiting.provider.configuration.error, null)

  const misconfiguredAdmin = new ExternalPlatformAdminService({
    store: state.platformStore,
    config: config({
      token: null,
      configured: true,
      contractVerified: true,
      dispatchEnabled: false,
      configurationError: {
        code: 'invalid_configuration',
        message: 'MX_INSIGHT_JUSTONE_STALE_TTL_MS must be greater than or equal to MX_INSIGHT_JUSTONE_FRESH_TTL_MS',
      },
    }),
  })
  const misconfigured = await misconfiguredAdmin.detail('justone', '24h')
  assert.equal(misconfigured.provider.status, 'misconfigured')
  assert.equal(misconfigured.provider.configuration.dispatchEligible, false)
  assert.deepEqual(misconfigured.provider.configuration.error, {
    code: 'invalid_configuration',
    message: 'MX_INSIGHT_JUSTONE_STALE_TTL_MS must be greater than or equal to MX_INSIGHT_JUSTONE_FRESH_TTL_MS',
  })
  assert.doesNotMatch(JSON.stringify(misconfigured.provider), /token/u)
})
