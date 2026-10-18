import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { FACEBOOK_ENDPOINT, FACEBOOK_OPERATION, FACEBOOK_JUSTONE_KEY } from '../../server/contracts/facebook-search.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { rehydrateTikHubXiaohongshuQueuedRecords } from '../../server/ingest/tikhub-xiaohongshu.mjs'
import { NIGHT_ALL_COMPAT_DATASET_ID } from '../../server/ingest/legacy-night-all.mjs'

const PEPPER = 'facebook-ingest-offline-test-pepper-at-least-32-bytes'
const post = { post_id: '90071992547409931', message: '完整 Facebook 内容\n第二段内容', timestamp: 1792195200,
  reactions_count: null, likes: 999, comments_count: 0, reshare_count: null, shares: 888,
  video_view_count: null, views: 777, bookmark_count: null, bookmarks: 666 }

async function produce(t, provider) {
  const usage = new MemoryStore(), service = new HubService({ store: usage, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Offline ingestion' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Offline ingestion' })
  await service.putPlatformConfiguration('facebook', { tenantId: tenant.id, consumerId: consumer.id,
    enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Offline ingestion', platforms: ['facebook'], capabilities: [] })
  const context = await service.authenticate(key.secret), controls = createExternalPlatformControlStore({})
  const gateways = {}, stores = {}, dispatched = []
  for (const selected of ['rapidapi', 'justone']) {
    const endpointKey = selected === 'rapidapi' ? FACEBOOK_ENDPOINT : `native.${FACEBOOK_JUSTONE_KEY}`
    const operation = selected === 'rapidapi' ? FACEBOOK_OPERATION.operationKey : endpointKey
    const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 1000,
      freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100 }
    const current = (await controls.describeProvider(selected, { config, credentialConfigured: true })).find(row => row.operationKey === operation)
    await controls.updatePolicy(selected, operation, { expectedRevision: current.revision, desiredState: 'active', reason: 'Offline ingestion regression',
      priceBook: { currency: selected === 'rapidapi' ? 'USD' : 'CNY', pricingAsOf: '2026-10-17T00:00:00Z',
        monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000, unitCostMinorByEndpoint: { [endpointKey]: selected === 'rapidapi' ? 0 : 1 } } },
    { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async () => {
      dispatched.push(selected)
      return Response.json(selected === 'rapidapi' ? { results: [post], cursor: null }
        : { code: 0, message: 'success', requestId: 'offline-justone-request', recordTime: '2026-10-17T00:00:00Z',
          data: { results: [post], cursor: null } },
      { headers: { 'x-ratelimit-requests-remaining': '100', 'x-ratelimit-requests-reset': '172800' } })
    }
    const adapter = selected === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'offline-fixture', fetchImpl })
      : new JustOneAdapter({ token: 'offline-fixture', fetchImpl, logger: { warn() {}, error() {} } })
    t.after(() => adapter.close?.())
    stores[selected] = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: selected, authorizationPlatform: 'facebook' })
    gateways[selected] = new ExternalPlatformGateway({ usageStore: usage, platformStore: stores[selected], adapter, config,
      providerKey: selected, operationControlStore: controls, apiKeyPepper: PEPPER, reservationLeaseMs: 120000,
      logger: { warn() {}, error() {} } })
  }
  const policyStore = { facebook: async () => ({ mode: provider, monthly_limit: 1000, probe_interval_hours: 72, revision: 1 }),
    admitRapid: async () => ({ allowed: true, token: 'offline' }), observeRapid: async () => {} }
  service.externalDataSearch = (ctx, input) => gateways.rapidapi.searchFacebook(ctx, input, { policyStore, fallbackGateway: gateways.justone })
  const invoke = () => service.search(context, { path: '/api/v1/data/search', idempotencyKey: `facebook-ingestion-${provider}`,
    body: { platform: 'facebook', query: 'offline fixture', pageSize: 20, type: 'stable' } })
  const delivered = await invoke()
  assert.equal(delivered.body.data.items.length, 1)
  assert.deepEqual(dispatched, [provider])
  const jobs = stores[provider].ingestJobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].payload.providerCallId, [...stores[provider].calls.values()][0].id)
  await invoke()
  assert.deepEqual(dispatched, [provider], 'replay must not dispatch again')
  assert.equal(jobs.length, 1, 'replay must not enqueue another canonical ingest')
  return JSON.parse(JSON.stringify(jobs[0].payload))
}

for (const provider of ['justone', 'rapidapi']) test(`actual Facebook ${provider} standard producer job passes worker and preserves calibrated canonical fields`, async t => {
  const payload = await produce(t, provider)
  assert.deepEqual(classifyExternalPlatformIngest(payload), {
    enterprise: false, justOne: false, tikHubXiaohongshu: false, hubRaw: true,
  })
  assert.equal(payload.datasetId, 'night-all.search.v1')
  assert.equal(payload.platform, 'facebook')
  // The worker's hubRaw branch uses this existing rehydrator; producer-side
  // rawSearchRecords has already run the shared mapper and Facebook calibration.
  const [record] = rehydrateTikHubXiaohongshuQueuedRecords(payload.records)
  assert.equal(record.externalId, post.post_id)
  assert.equal(record.body, post.message)
  assert.equal(record.title, null)
  assert.equal(record.stableFields.connectorId, `external-platform:${provider}`)
  assert.ok(record.eventTime instanceof Date)
  assert.ok(record.collectedAt instanceof Date)
  assert.deepEqual(record.metrics, { likes: null, comments: 0, shares: null, views: null, bookmarks: null })
  assert.deepEqual(record.stableFields.metrics, record.metrics)
  assert.equal(record.rawItem.likes, 999, 'raw evidence survives without reviving an unknown canonical metric')
  assert.equal(record.rawItem.content_id, post.post_id)
  assert.match(record.rawPayloadSha256, /^[a-f0-9]{64}$/u)
})

test('Facebook worker admission remains limited to the actual standard producer tuple', () => {
  const base = { kind: 'external-platform-result', providerKey: 'justone', platform: 'facebook', datasetId: 'night-all.search.v1', records: [] }
  for (const providerKey of ['justone', 'rapidapi']) {
    assert.equal(classifyExternalPlatformIngest({ ...base, providerKey }).hubRaw, true)
    for (const datasetId of [NIGHT_ALL_COMPAT_DATASET_ID, 'social.data.v1', 'social.comments.v1', 'ecommerce.products.v1', '']) {
      assert.throws(() => classifyExternalPlatformIngest({ ...base, providerKey, datasetId }), /pinned contract/u)
    }
  }
  for (const providerKey of ['tikhub', 'night-all', 'qixin', '']) {
    assert.throws(() => classifyExternalPlatformIngest({ ...base, providerKey }), /pinned contract/u)
  }
  for (const records of [undefined, null, {}, '[]']) assert.throws(() => classifyExternalPlatformIngest({ ...base, records }), /pinned contract/u)
  assert.throws(() => classifyExternalPlatformIngest({ ...base, kind: 'search-result' }), /pinned contract/u)
})
