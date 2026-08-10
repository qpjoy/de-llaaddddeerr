import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { createApp } from '../../server/app.mjs'
import { loadConfig } from '../../server/config.mjs'
import { isNightAllDataSearchV1Envelope } from '../../server/contracts/night-all-data-search.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'test-admin-token'
const PEPPER = 'test-pepper-with-enough-entropy'

let baseUrl
let server
let store
let service
let adapter
let upstreamCalls
let upstreamBodies

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function nightAllSearchEnvelope({ platform = 'xiaohongshu', query = 'AI', pageSize = 20 } = {}) {
  return {
    data: {
      contractVersion: 'night-all.data-search.v1',
      platform,
      query,
      items: [{
        id: `${platform}:one`,
        externalId: 'one',
        platform,
        contentType: 'normal',
        url: null,
        title: query,
        text: query,
        publishedAt: '2026-08-01T00:00:00.000Z',
        collectedAt: '2026-08-01T00:01:00.000Z',
        author: { id: 'author-one', name: 'Alice', avatarUrl: null },
        metrics: { likes: 1, comments: 2, shares: 3, views: 4, bookmarks: 5 },
        media: { coverUrl: null, images: [], videos: [] },
        source: { provider: 'tikhub', endpointId: 'private-upstream-endpoint' },
      }],
      pageInfo: {
        pageIndex: 1,
        pageSize,
        returnedCount: 1,
        hasMore: false,
        nextCursor: null,
        cursorType: 'none',
      },
      status: 'ok',
      warnings: [],
      meta: {
        capability: 'search_posts',
        capabilityStatus: 'ready',
        paginationMode: 'composite',
        sourceProvider: 'tikhub',
        endpointId: 'private-upstream-endpoint',
        providerCalls: 1,
        durationMs: 12,
      },
    },
    requestId: 'night-all-request',
    traceId: 'night-all-trace',
  }
}

before(async () => {
  store = new MemoryStore()
  upstreamCalls = new Map()
  upstreamBodies = []
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname
    if (pathname === '/api/v1/health') return jsonResponse({ data: { ok: true, version: '1.0.0' } })
    if (pathname === '/api/v1/data/capabilities') {
      return jsonResponse({
        data: {
          provider: 'must-not-leak',
          platforms: [
            { platform: 'xiaohongshu', defaultProvider: 'tikhub', ready: true },
            { platform: 'twitter', defaultProvider: 'rapidapi', ready: true },
          ],
        },
      })
    }
    if (pathname !== '/api/v1/data/search') return jsonResponse({ error: 'not found' }, 404)
    const body = JSON.parse(options.body)
    upstreamBodies.push(body)
    upstreamCalls.set(body.platform, (upstreamCalls.get(body.platform) || 0) + 1)
    if (body.platform === 'twitter') throw new TypeError('connection reset')
    if (body.platform === 'facebook') return jsonResponse({ error: { code: 'unavailable' } }, 503)
    return jsonResponse(nightAllSearchEnvelope(body))
  }
  adapter = new NightAllAdapter({ baseUrl: 'http://night-all.invalid', fetchImpl })
  service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN, logger: { error() {} } })
  server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, payload: await response.json() }
}

const adminHeaders = { 'x-mx-insight-admin-token': ADMIN_TOKEN }

test('public listener does not require or receive an admin token', () => {
  const config = loadConfig({
    MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_STORE: 'memory',
    MX_INSIGHT_API_KEY_PEPPER: PEPPER,
  })
  assert.equal(config.adminToken, null)
  assert.throws(
    () => loadConfig({ MX_INSIGHT_LISTENER_MODE: 'admin', MX_INSIGHT_STORE: 'memory', MX_INSIGHT_API_KEY_PEPPER: PEPPER }),
    /MX_INSIGHT_ADMIN_TOKEN is required/,
  )
})

test('Night-All adapter rejects invalid successful envelopes', async () => {
  const invalidAdapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async () => new Response('<html>proxy error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  })
  await assert.rejects(
    () => invalidAdapter.search({ body: { platform: 'xiaohongshu', query: 'AI', pageSize: 1 }, businessId: 'test' }),
    (error) => error?.name === 'UpstreamRejectedError' && error?.status === 502,
  )

  const missingSource = nightAllSearchEnvelope({ pageSize: 1 })
  delete missingSource.data.items[0].source.endpointId
  const invalidContractAdapter = new NightAllAdapter({
    baseUrl: 'http://night-all.invalid',
    fetchImpl: async () => jsonResponse(missingSource),
  })
  await assert.rejects(
    () => invalidContractAdapter.search({ body: { platform: 'xiaohongshu', query: 'AI', pageSize: 1 }, businessId: 'test' }),
    (error) => (
      error?.name === 'UpstreamRejectedError'
      && error?.status === 502
      && error?.body?.code === 'invalid_upstream_contract'
    ),
  )
})

test('Hub validator is equivalent to the strict Night-All v1 single-platform field contract', () => {
  const valid = nightAllSearchEnvelope()
  assert.equal(isNightAllDataSearchV1Envelope(valid), true)

  const missingRequiredSourceField = structuredClone(valid)
  delete missingRequiredSourceField.data.items[0].source.provider
  assert.equal(isNightAllDataSearchV1Envelope(missingRequiredSourceField), false)

  const unknownItemField = structuredClone(valid)
  unknownItemField.data.items[0].rawProviderPayload = { secret: true }
  assert.equal(isNightAllDataSearchV1Envelope(unknownItemField), false)

  const negativeMetric = structuredClone(valid)
  negativeMetric.data.items[0].metrics.views = -1
  assert.equal(isNightAllDataSearchV1Envelope(negativeMetric), false)

  const emptyMetaEndpoint = structuredClone(valid)
  emptyMetaEndpoint.data.meta.endpointId = ''
  assert.equal(isNightAllDataSearchV1Envelope(emptyMetaEndpoint), false)
})

test('expired reservations become unknown instead of permanent in-progress requests', async () => {
  const leaseStore = new MemoryStore()
  const reservation = await leaseStore.reserve({
    requestId: 'request-lease-test',
    idempotencyKey: 'lease-test-key',
    fingerprint: 'fingerprint',
    tenantId: 'tenant',
    consumerId: 'consumer',
    apiKeyId: 'key',
    platform: 'xiaohongshu',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() - 1000),
    windowStart: new Date(Date.now() - 60_000),
    maxRequests: 10,
  })
  assert.equal(reservation.request.status, 'reserved')
  assert.equal(await leaseStore.reapStaleReservations(), 1)
  const request = await leaseStore.getRequest('request-lease-test', 'consumer')
  assert.equal(request.status, 'unknown')
  assert.equal(request.errorCode, 'reservation_lease_expired')
})

test('platform policies are isolated between consumers in the same tenant', async () => {
  const isolatedStore = new MemoryStore()
  const isolatedService = new HubService({
    store: isolatedStore,
    adapter: {},
    apiKeyPepper: PEPPER,
  })
  const tenant = await isolatedService.createTenant({ name: 'Shared tenant' })
  const consumerA = await isolatedService.createConsumer({ tenantId: tenant.id, name: 'Consumer A' })
  const consumerB = await isolatedService.createConsumer({ tenantId: tenant.id, name: 'Consumer B' })

  await isolatedService.putPlatformConfiguration('xhs', {
    tenantId: tenant.id,
    consumerId: consumerA.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 25,
  })
  await isolatedService.putPlatformConfiguration('xhs', {
    tenantId: tenant.id,
    consumerId: consumerB.id,
    enabled: true,
    maxRequests: 2,
    windowSeconds: 60,
    maxPageSize: 1,
  })

  const [configurationA, configurationB] = await Promise.all([
    isolatedService.getPlatformConfiguration({ tenantId: tenant.id, consumerId: consumerA.id }),
    isolatedService.getPlatformConfiguration({ tenantId: tenant.id, consumerId: consumerB.id }),
  ])
  assert.deepEqual(configurationA.grants, ['xiaohongshu'])
  assert.deepEqual(configurationB.grants, ['xiaohongshu'])
  assert.equal(configurationA.policies.length, 1)
  assert.equal(configurationB.policies.length, 1)
  assert.deepEqual(
    {
      consumerId: configurationA.policies[0].consumerId,
      maxRequests: configurationA.policies[0].maxRequests,
      windowSeconds: configurationA.policies[0].windowSeconds,
      maxPageSize: configurationA.policies[0].maxPageSize,
    },
    { consumerId: consumerA.id, maxRequests: 10, windowSeconds: 3_600, maxPageSize: 25 },
  )
  assert.deepEqual(
    {
      consumerId: configurationB.policies[0].consumerId,
      maxRequests: configurationB.policies[0].maxRequests,
      windowSeconds: configurationB.policies[0].windowSeconds,
      maxPageSize: configurationB.policies[0].maxPageSize,
    },
    { consumerId: consumerB.id, maxRequests: 2, windowSeconds: 60, maxPageSize: 1 },
  )
})

test('API keys default to 180 days, allow bounded expiry, and reject expired authentication', async () => {
  const isolatedStore = new MemoryStore()
  const isolatedService = new HubService({
    store: isolatedStore,
    adapter: {},
    apiKeyPepper: PEPPER,
  })
  const tenant = await isolatedService.createTenant({ name: 'Expiry tenant' })
  const consumer = await isolatedService.createConsumer({ tenantId: tenant.id, name: 'Expiry consumer' })

  const issuedAt = Date.now()
  const defaultKey = await isolatedService.createApiKey({ consumerId: consumer.id, name: 'Default lifetime' })
  const defaultLifetimeMs = new Date(defaultKey.expiresAt).getTime() - issuedAt
  assert.ok(defaultLifetimeMs >= 180 * 86_400_000 - 2_000)
  assert.ok(defaultLifetimeMs <= 180 * 86_400_000 + 2_000)
  assert.equal(defaultKey.effectiveStatus, 'active')

  const customKey = await isolatedService.createApiKey({
    consumerId: consumer.id,
    name: 'Custom lifetime',
    expiresInDays: 30,
  })
  const customLifetimeMs = new Date(customKey.expiresAt).getTime() - Date.now()
  assert.ok(customLifetimeMs >= 30 * 86_400_000 - 2_000)
  assert.ok(customLifetimeMs <= 30 * 86_400_000 + 2_000)

  for (const expiresInDays of [0, 1.5, 731]) {
    await assert.rejects(
      () => isolatedService.createApiKey({
        consumerId: consumer.id,
        name: 'Invalid lifetime',
        expiresInDays,
      }),
      (error) => error?.status === 400 && error?.code === 'invalid_request',
    )
  }

  const stored = isolatedStore.apiKeys.get(defaultKey.id)
  stored.expiresAt = new Date(Date.now() - 1_000).toISOString()
  assert.equal(stored.lastUsedAt, null)
  await assert.rejects(
    () => isolatedService.authenticate(defaultKey.secret),
    (error) => error?.status === 401 && error?.code === 'invalid_api_key',
  )
  assert.equal(stored.lastUsedAt, null)
  assert.equal((await isolatedService.listApiKeys(consumer.id)).find((key) => key.id === defaultKey.id).effectiveStatus, 'expired')
  assert.equal((await isolatedStore.dashboard()).activeApiKeys, 1)
})

test('health reports liveness and dependencies', async () => {
  const live = await call('/health/live')
  assert.equal(live.response.status, 200)
  assert.equal(live.payload.data.status, 'live')
  const ready = await call('/health/ready')
  assert.equal(ready.response.status, 200)
  assert.equal(ready.payload.data.dependencies.nightAll.status, 'up')
})

test('listener modes fail closed across public and admin planes', async () => {
  async function isolatedCall(listenerMode, path, headers) {
    const isolated = createServer(createApp({
      service,
      store,
      adapter,
      adminToken: ADMIN_TOKEN,
      listenerMode,
      logger: { error() {} },
    }))
    await new Promise((resolve) => isolated.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${isolated.address().port}${path}`, { headers })
      return response.status
    } finally {
      await new Promise((resolve) => isolated.close(resolve))
    }
  }

  assert.equal(
    await isolatedCall('public', '/internal/v1/admin/dashboard', adminHeaders),
    404,
  )
  assert.equal(
    await isolatedCall('admin', '/api/v1/data/capabilities', { authorization: 'Bearer invalid' }),
    404,
  )

  const publicServer = createServer(createApp({
    service,
    store,
    adapter,
    adminToken: null,
    listenerMode: 'public',
    logger: { error() {} },
  }))
  await new Promise((resolve) => publicServer.listen(0, '127.0.0.1', resolve))
  try {
    const publicBase = `http://127.0.0.1:${publicServer.address().port}`
    const dependencies = await fetch(`${publicBase}/health/dependencies`)
    assert.equal(dependencies.status, 404)
    const ready = await fetch(`${publicBase}/health/ready`)
    const payload = await ready.json()
    assert.equal(payload.data.status, 'ready')
    assert.equal(payload.data.dependencies, undefined)
    assert.equal(JSON.stringify(payload).includes('nightAll'), false)
  } finally {
    await new Promise((resolve) => publicServer.close(resolve))
  }
})

test('admin provisioning, grants, authenticated search, idempotency, usage, and revocation', async () => {
  const unauthorized = await call('/internal/v1/admin/dashboard')
  assert.equal(unauthorized.response.status, 401)

  const tenantResult = await call('/internal/v1/admin/tenants', {
    method: 'POST',
    headers: adminHeaders,
    body: { name: 'Acme' },
  })
  assert.equal(tenantResult.response.status, 201)
  const tenant = tenantResult.payload.data

  const consumerResult = await call('/internal/v1/admin/consumers', {
    method: 'POST',
    headers: adminHeaders,
    body: { tenantId: tenant.id, name: 'Research' },
  })
  const consumer = consumerResult.payload.data
  assert.match(consumer.businessId, /^mxih:/)

  const keyResult = await call('/internal/v1/admin/api-keys', {
    method: 'POST',
    headers: adminHeaders,
    body: { consumerId: consumer.id, name: 'Terminal key' },
  })
  assert.equal(keyResult.response.status, 201)
  const secret = keyResult.payload.data.secret
  assert.match(secret, /^mih_live_/)
  assert.equal(keyResult.payload.data.environment, 'live')
  assert.equal(keyResult.payload.data.effectiveStatus, 'active')
  assert.ok(new Date(keyResult.payload.data.expiresAt).getTime() > Date.now() + 179 * 86_400_000)
  assert.equal([...store.apiKeys.values()][0].digest.includes(secret), false)

  const keys = await call(`/internal/v1/admin/api-keys?consumerId=${consumer.id}`, {
    headers: adminHeaders,
  })
  assert.equal(keys.payload.data[0].secret, undefined)
  assert.equal(keys.payload.data[0].digest, undefined)

  await call('/internal/v1/admin/platforms/xhs', {
    method: 'PUT',
    headers: adminHeaders,
    body: {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 10,
      windowSeconds: 3600,
      maxPageSize: 5,
    },
  })
  const wildcardGrant = await call('/internal/v1/admin/platforms/all', {
    method: 'PUT',
    headers: adminHeaders,
    body: { tenantId: tenant.id, consumerId: consumer.id, enabled: true },
  })
  assert.equal(wildcardGrant.response.status, 400)
  assert.equal(wildcardGrant.payload.error.code, 'invalid_platform')

  const publicHeaders = { authorization: `Bearer ${secret}` }
  const capabilities = await call('/api/v1/data/capabilities', { headers: publicHeaders })
  assert.deepEqual(capabilities.payload.data.platforms, [{ platform: 'xiaohongshu', ready: true }])
  assert.equal(capabilities.payload.data.provider, undefined)

  const missingIdempotency = await call('/api/v1/data/search', {
    method: 'POST',
    headers: publicHeaders,
    body: { platform: 'xhs', query: 'AI', pageSize: 2 },
  })
  assert.equal(missingIdempotency.response.status, 400)
  assert.equal(missingIdempotency.payload.error.code, 'idempotency_key_required')

  const searchHeaders = { ...publicHeaders, 'idempotency-key': 'search-one' }
  const attemptedFanout = await call('/api/v1/data/search', {
    method: 'POST',
    headers: { ...publicHeaders, 'idempotency-key': 'fanout-bypass' },
    body: { platform: 'xhs', platforms: ['weibo', 'all'], query: 'AI', pageSize: 2 },
  })
  assert.equal(attemptedFanout.response.status, 400)
  assert.equal(attemptedFanout.payload.error.code, 'unsupported_fields')
  assert.equal(upstreamCalls.get('xiaohongshu'), undefined)

  const first = await call('/api/v1/data/search', {
    method: 'POST',
    headers: searchHeaders,
    body: {
      platform: 'xhs',
      query: 'AI',
      pageSize: 2,
    },
  })
  assert.equal(first.response.status, 200)
  assert.equal(first.response.headers.get('idempotent-replay'), 'false')
  assert.equal(isNightAllDataSearchV1Envelope(first.payload), true)
  assert.deepEqual(first.payload.data.items[0].source, { provider: null, endpointId: null })
  assert.equal(first.payload.data.meta.sourceProvider, undefined)
  assert.equal(first.payload.data.meta.endpointId, undefined)
  assert.equal(JSON.stringify(first.payload).includes('private-upstream-endpoint'), false)
  assert.equal(upstreamBodies.at(-1).businessId, consumer.businessId)
  assert.equal(upstreamBodies.at(-1).availabilityMode, 'ready_only')

  const replay = await call('/api/v1/data/search', {
    method: 'POST',
    headers: searchHeaders,
    body: {
      platform: 'xhs',
      query: 'AI',
      pageSize: 2,
    },
  })
  assert.equal(replay.response.status, 200)
  assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
  assert.equal(upstreamCalls.get('xiaohongshu'), 1)

  const conflict = await call('/api/v1/data/search', {
    method: 'POST',
    headers: searchHeaders,
    body: { platform: 'xhs', query: 'different', pageSize: 2 },
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.payload.error.code, 'idempotency_conflict')

  const status = await call(`/api/v1/requests/${first.payload.requestId}`, { headers: publicHeaders })
  assert.equal(status.payload.data.status, 'committed')
  assert.equal(status.payload.data.responseBody, undefined)
  assert.equal(status.payload.data.apiKeyId, undefined)
  assert.equal(status.payload.data.idempotencyKey, undefined)

  const usage = await call('/api/v1/usage', { headers: publicHeaders })
  assert.equal(usage.payload.data.committed, 1)
  assert.equal(usage.payload.data.units, 1)

  const dashboard = await call('/internal/v1/ops/summary', { headers: adminHeaders })
  assert.equal(dashboard.payload.data.activeApiKeys, 1)
  assert.equal(dashboard.payload.data.committed, 1)

  const revoke = await call(`/internal/v1/admin/api-keys/${keyResult.payload.data.id}/revoke`, {
    method: 'POST',
    headers: adminHeaders,
  })
  assert.equal(revoke.payload.data.status, 'revoked')
  const rejected = await call('/api/v1/usage', { headers: publicHeaders })
  assert.equal(rejected.response.status, 401)
})

test('ambiguous POST is called once and held in unknown state', async () => {
  const tenant = (await store.listTenants())[0]
  const consumer = (await store.listConsumers(tenant.id))[0]
  const issued = await call('/internal/v1/admin/api-keys', {
    method: 'POST',
    headers: adminHeaders,
    body: { consumerId: consumer.id, name: 'Unknown test key' },
  })
  const headers = { authorization: `Bearer ${issued.payload.data.secret}` }
  await call('/internal/v1/admin/platforms/twitter', {
    method: 'PUT',
    headers: adminHeaders,
    body: { tenantId: tenant.id, consumerId: consumer.id, enabled: true },
  })
  const first = await call('/api/v1/data/search', {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': 'unknown-one' },
    body: { platform: 'twitter', query: 'AI' },
  })
  assert.equal(first.response.status, 502)
  assert.equal(first.payload.error.code, 'upstream_outcome_unknown')
  assert.equal(upstreamCalls.get('twitter'), 1)

  const second = await call('/api/v1/data/search', {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': 'unknown-one' },
    body: { platform: 'twitter', query: 'AI' },
  })
  assert.equal(second.response.status, 409)
  assert.equal(second.payload.error.code, 'request_outcome_unknown')
  assert.equal(upstreamCalls.get('twitter'), 1)
})

test('known upstream rejection releases reservation so explicit retry is possible', async () => {
  const tenant = (await store.listTenants())[0]
  const consumer = (await store.listConsumers(tenant.id))[0]
  const issued = await call('/internal/v1/admin/api-keys', {
    method: 'POST',
    headers: adminHeaders,
    body: { consumerId: consumer.id, name: 'Release test key' },
  })
  const headers = { authorization: `Bearer ${issued.payload.data.secret}`, 'idempotency-key': 'released-one' }
  await call('/internal/v1/admin/platforms/facebook', {
    method: 'PUT',
    headers: adminHeaders,
    body: { tenantId: tenant.id, consumerId: consumer.id, enabled: true },
  })
  const body = { platform: 'facebook', query: 'AI' }
  const first = await call('/api/v1/data/search', { method: 'POST', headers, body })
  const second = await call('/api/v1/data/search', { method: 'POST', headers, body })
  assert.equal(first.payload.error.code, 'night_all_rejected')
  assert.equal(second.payload.error.code, 'night_all_rejected')
  assert.equal(upstreamCalls.get('facebook'), 2)
})
