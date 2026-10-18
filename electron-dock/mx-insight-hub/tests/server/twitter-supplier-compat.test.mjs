import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { ContentSearchStateStore } from '../../server/external-platforms/content-search-store.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'
import { assertTwitterSearchAvailable } from '../../server/data/twitter-search-availability.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { TIKHUB_CONTENT_SEARCH_VERSION } from '../../server/contracts/tikhub-content-search.mjs'

const pepper = 'offline-twitter-supplier-compatibility-fixture'
const path = '/api/v1/data/search'
const requestBody = { platform: 'twitter', query: 'fixture keyword', pageSize: 20, type: 'stable' }
const oldDate = new Date(Date.now() - 30 * 86400000).toISOString()
const context = () => ({ tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } })
const row = (ctx, patch = {}) => ({ id: randomUUID(), tenantId: ctx.tenant.id, consumerId: ctx.consumer.id,
  apiKeyId: ctx.apiKey.id, platform: 'twitter', idempotencyKey: 'old-twitter-supplier-key', status: 'unknown',
  fingerprint: requestFingerprint({ method: 'POST', path, body: requestBody }), reservedAt: oldDate,
  acquisitionRequest: { method: 'POST', path, body: requestBody }, ...patch })

async function harness() {
  const usageStore = new MemoryStore(), calls = { rapid: 0, tikhub: 0 }
  const service = new HubService({ store: usageStore, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Synthetic migration tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic migration caller' })
  await usageStore.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Existing Twitter grant', platforms: ['twitter'], capabilities: [] })
  const ctx = await service.authenticate(key.secret)
  const rapidGateway = new ExternalPlatformGateway({ usageStore,
    platformStore: new MemoryExternalPlatformStore({ usageStore, providerKey: 'rapidapi', authorizationPlatform: 'twitter' }),
    providerKey: 'rapidapi', apiKeyPepper: pepper, reservationLeaseMs: 120000,
    operationControlStore: {}, config: { configured: false, contractVerified: false }, logger: { warn() {} },
    adapter: { async execute() { calls.rapid++; throw new Error('Historical receipt must not purchase again') } },
  })
  const tikHubGateway = new ExternalPlatformGateway({ usageStore,
    platformStore: new MemoryExternalPlatformStore({ usageStore, providerKey: 'tikhub', authorizationPlatform: 'twitter' }),
    providerKey: 'tikhub', apiKeyPepper: pepper, reservationLeaseMs: 120000,
    operationControlStore: {}, config: { configured: false, contractVerified: false }, logger: { warn() {} },
    adapter: { async forwardNative() { calls.tikhub++; throw new Error('Historical receipt must not purchase again') } },
  })
  service.externalDataSearch = createTwitterSearchRouter({ usageStore, rapidGateway, tikHubGateway, apiKeyPepper: pepper })
  const seed = patch => {
    const value = row(ctx, patch)
    usageStore.requests.set(value.id, value)
    usageStore.requestsByScope.set(`${ctx.consumer.id}:${value.idempotencyKey}`, value.id)
    return value
  }
  const invoke = (body = requestBody, idempotencyKey = 'old-twitter-supplier-key', requestPath = path) => service.search(ctx, { path: requestPath, body, idempotencyKey })
  return { usageStore, service, ctx, calls, seed, invoke, rapidGateway, tikHubGateway }
}

test('same-key historical Rapid 200 remains an exact standard replay without TikHub grants or dispatch', async () => {
  const h = await harness(), requestId = randomUUID()
  const response = { requestId, data: { contractVersion: 'night-all.data-search.v1', platform: 'twitter', query: requestBody.query,
    items: [{ id: 'historical-post', text: 'Preserved delivered text' }], pageInfo: { hasMore: false, nextCursor: null }, status: 'ok' } }
  h.seed({ id: requestId, status: 'committed', responseStatus: 200, responseBody: response, completedAt: oldDate, capturedAt: oldDate })
  const result = await h.invoke()
  assert.equal(result.replay, true)
  assert.deepEqual(result.body, response)
  assert.deepEqual(h.calls, { rapid: 0, tikhub: 0 })
  assert.deepEqual(await h.usageStore.listEffectiveCapabilityGrants(h.ctx.consumer.id, h.ctx.apiKey.id), [])
})

for (const status of ['committed', 'released']) test(`same-key historical Rapid 400 (${status}) remains immutable and cannot become a TikHub retry`, async () => {
  const h = await harness(), requestId = randomUUID()
  h.seed({ id: requestId, status, responseStatus: 502, completedAt: oldDate,
    responseBody: { error: { code: 'social_upstream_rejected', message: 'Saved supplier refusal', details: { upstreamStatus: 400, retryable: false } }, requestId } })
  await assert.rejects(h.invoke(), error => error.code === 'social_upstream_rejected' && error.status === 502
    && error.details.requestId === requestId && error.details.upstreamStatus === 400)
  assert.deepEqual(h.calls, { rapid: 0, tikhub: 0 })
})

test('same-key Rapid unknown remains owned, and a different key or v2 cannot bypass it through TikHub', async () => {
  const h = await harness(), saved = h.seed({ status: 'unknown' })
  await assert.rejects(h.invoke(), error => error.code === 'request_outcome_unknown' && error.details.requestId === saved.id)
  await assert.rejects(h.invoke({ ...requestBody, pageSize: 40, type: 'fresh' }, 'changed-key-same-query'),
    error => error.code === 'request_outcome_unknown' && error.details.requestId === saved.id)
  await assert.rejects(h.invoke({ ...requestBody, timeWindow: { from: '2026-10-15T00:00:00Z', to: '2026-10-16T00:00:00Z',
    timezone: 'Asia/Shanghai', boundary: '[from,to)' } }, 'v2-key-same-query', '/api/v2/data/search'),
  error => error.code === 'search_admission_blocked' && error.details.blockingRequestId === saved.id)
  assert.deepEqual(h.calls, { rapid: 0, tikhub: 0 })
  assert.equal(h.usageStore.requests.get(saved.id).status, 'unknown')
})

test('historical Rapid fresh renewal checks a TikHub unknown with the same query and a different page fingerprint', async () => {
  const h = await harness(), body = { ...requestBody, type: 'fresh' }
  const original = h.seed({ status: 'committed', responseStatus: 200, completedAt: oldDate,
    fingerprint: requestFingerprint({ method: 'POST', path, body }), acquisitionRequest: { method: 'POST', path, body },
    responseBody: { data: { items: [{ id: 'historical-item' }] } } })
  const unknownBody = { ...requestBody, pageSize: 40 }
  const blocker = h.seed({ idempotencyKey: 'other-tikhub-unknown-key',
    fingerprint: requestFingerprint({ method: 'POST', path, body: unknownBody }),
    acquisitionRequest: { method: 'POST', path, body: unknownBody, searchProvider: 'tikhub',
      searchContractVersion: TIKHUB_CONTENT_SEARCH_VERSION } })
  assert.notEqual(original.fingerprint, blocker.fingerprint)
  await assert.rejects(h.invoke(body), error => error.code === 'request_outcome_unknown' && error.details.blockingRequestId === blocker.id)
  assert.deepEqual(h.calls, { rapid: 0, tikhub: 0 })
  assert.equal(h.usageStore.requests.get(original.id).status, 'committed')
  assert.equal(h.usageStore.requests.get(blocker.id).status, 'unknown')
  const renewed = await h.usageStore.getUsageRequestByIdempotencyKey(h.ctx.consumer.id, original.idempotencyKey)
  assert.notEqual(renewed.id, original.id)
  assert.equal(renewed.status, 'released', 'The new un-dispatched renewal releases only its own reservation')
})

test('TikHub admission failure records supplier ownership before dispatch and keeps an allowed retry on that supplier', async () => {
  const h = await harness()
  // A malformed native-only option is deliberately rejected after reservation;
  // it must not acquire from RapidAPI when the same public key is used again.
  const input = { body: requestBody, normalized: { ...requestBody, params: { unsupported: 'fixture' } },
    idempotencyKey: 'new-tikhub-admission-key', dataSearch: { resultType: 'stable', replayWindowMs: null } }
  await assert.rejects(h.tikHubGateway.searchContent(h.ctx, input), error => error.code === 'unsupported_fields')
  const saved = await h.usageStore.getUsageRequestByIdempotencyKey(h.ctx.consumer.id, input.idempotencyKey)
  assert.equal(saved.status, 'released')
  assert.equal(saved.acquisitionRequest.searchProvider, 'tikhub')
  assert.equal(saved.acquisitionRequest.searchContractVersion, TIKHUB_CONTENT_SEARCH_VERSION)
  assert.equal(h.tikHubGateway.platformStore.calls.size, 0)
  const router = createTwitterSearchRouter({ usageStore: h.usageStore, rapidGateway: h.rapidGateway,
    tikHubGateway: h.tikHubGateway, apiKeyPepper: pepper })
  await assert.rejects(router(h.ctx, input), error => error.code === 'unsupported_fields')
  assert.deepEqual(h.calls, { rapid: 0, tikhub: 0 })
  const retried = await h.usageStore.getUsageRequestByIdempotencyKey(h.ctx.consumer.id, input.idempotencyKey)
  assert.equal(h.usageStore.requests.size, 2)
  assert.notEqual(retried.id, saved.id)
  assert.equal(retried.acquisitionRequest.searchProvider, 'tikhub')
  assert.equal(retried.acquisitionRequest.searchContractVersion, TIKHUB_CONTENT_SEARCH_VERSION)
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
for (const postgres of [false, true]) {
  test(`${postgres ? 'PGlite' : 'Memory'} cross-supplier unknown guard uses exact known query ownership, without an age or platform-wide ban`,
    { skip: postgres && !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE to the local PGlite module' : false }, async t => {
      const ctx = context(), usageStore = new MemoryStore()
      let db
      if (postgres) {
        const { PGlite } = await import(pathToFileURL(modulePath).href)
        db = new PGlite(); t.after(() => db.close())
        await db.exec(`CREATE TABLE usage_requests (id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid,
          platform text,status text,acquisition_request jsonb,reserved_at timestamptz);`)
        usageStore.pool = { query: (sql, args) => db.query(sql, args) }
      }
      const seed = async value => {
        usageStore.requests.clear()
        if (postgres) {
          await db.exec('DELETE FROM usage_requests')
          await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [value.id, value.tenantId,
            value.consumerId, value.apiKeyId, value.platform, value.status, JSON.stringify(value.acquisitionRequest), value.reservedAt])
        } else usageStore.requests.set(value.id, value)
      }
      const invoke = excludeRequestIds => assertTwitterSearchAvailable({ usageStore, context: ctx, query: requestBody.query, excludeRequestIds })
      for (const status of ['unknown', 'reserved']) {
        const saved = row(ctx, { status, acquisitionRequest: { path, body: { ...requestBody, query: '\n\u00a0fixture keyword\ufeff' } } })
        await seed(saved)
        await assert.rejects(invoke(), error => error.code === (status === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
          && error.details.requestId === saved.id)
        await invoke([saved.id])
      }
      for (const patch of [
        { tenantId: randomUUID() }, { consumerId: randomUUID() }, { apiKeyId: randomUUID() }, { platform: 'facebook' },
        { status: 'committed' }, { status: 'released' }, { acquisitionRequest: null },
        { acquisitionRequest: { path, body: {} } }, { acquisitionRequest: { path, body: { query: 42 } } },
        { acquisitionRequest: { path, body: { query: ' \n' } } },
        { acquisitionRequest: { path, body: { query: 'other query' } } },
        { acquisitionRequest: { path: '/api/v1/night-all/search/raw', body: requestBody } },
      ]) { await seed(row(ctx, patch)); await invoke() }
      for (const [savedQuery, newQuery] of [['alpha AND beta AND NOT gamma', 'alpha beta -gamma'],
        ['alpha beta -gamma', 'alpha AND beta AND NOT gamma']]) {
        const saved = row(ctx, { acquisitionRequest: { path, body: { ...requestBody, query: savedQuery } } })
        await seed(saved)
        await assert.rejects(assertTwitterSearchAvailable({ usageStore, context: ctx, query: newQuery }),
          error => error.code === 'request_outcome_unknown' && error.details.requestId === saved.id)
      }
    })
}

for (const postgres of [false, true]) test(`${postgres ? 'PGlite' : 'Memory'} rolling Rapid and TikHub deliveries arbitrate the same public fingerprint before either supplier can run`,
  { skip: postgres && !modulePath ? 'Set MX_INSIGHT_TEST_PGLITE_MODULE to the local PGlite module' : false }, async t => {
    let pool
    const usageStore = new MemoryStore()
    if (postgres) {
      const { PGlite } = await import(pathToFileURL(modulePath).href)
      const db = new PGlite(); t.after(() => db.close())
      await db.exec(`CREATE SCHEMA external_platform; CREATE TABLE external_platform.dispatch_leases (
        consumer_id uuid,operation text,request_fingerprint char(64),owner_request_id uuid,expires_at timestamptz,
        created_at timestamptz DEFAULT now(),UNIQUE(consumer_id,operation,request_fingerprint));`)
      pool = { query: (sql, args) => db.query(sql, args) }
    }
    const Store = postgres ? PostgresExternalPlatformStore : MemoryExternalPlatformStore
    const rapid = new Store({ pool, usageStore, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
    const tikhub = new ContentSearchStateStore(new Store({ pool, usageStore, providerKey: 'tikhub', authorizationPlatform: 'twitter' }),
      { platform: 'twitter', operation: 'native.t.twitter_web_fetch_search_timeline', endpointKey: 't.twitter_web_fetch_search_timeline' })
    const a = { consumerId: randomUUID(), fingerprint: 'a'.repeat(64), ownerRequestId: randomUUID(),
      operation: 'social.content.search', expiresAt: new Date(Date.now() + 60000).toISOString() }
    const b = { ...a, ownerRequestId: randomUUID() }
    assert.equal((await rapid.acquireTwitterFillDeliveryLease(a)).kind, 'acquired')
    assert.equal(await tikhub.acquireDeliveryLease(b), false)
    await tikhub.releaseDeliveryLease(b)
    assert.equal(await tikhub.acquireDeliveryLease(b), false, 'A different supplier owner cannot release the existing lease')
    await rapid.releaseDispatchLease(a)
    assert.equal(await tikhub.acquireDeliveryLease(b), true)
    assert.equal((await rapid.acquireTwitterFillDeliveryLease(a)).kind, 'busy')
    await tikhub.releaseDeliveryLease(b)
    assert.equal((await rapid.acquireTwitterFillDeliveryLease(a)).kind, 'acquired')
  })
