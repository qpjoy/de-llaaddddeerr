import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { QixinAdminService, QIXIN_METADATA } from '../../server/external-platforms/qixin-admin.mjs'
import { QixinAdapter } from '../../server/adapters/qixin.mjs'
import { QIXIN_CATALOG, QIXIN_CONFIG, enterpriseOperation, enterpriseEndpoint, normalizeEnterpriseRequest, enterpriseFields } from '../../server/contracts/enterprise.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { StructuredExternalPlatformCredentialStore, QIXIN_CREDENTIAL_FIELDS } from '../../server/external-platforms/structured-credentials.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'

const pepper = 'enterprise-test-pepper-at-least-32-characters'
const credentials = { appkey: 'synthetic-app-key', secret_key: 'synthetic-secret-key' }
const payload = { status: '200', message: '成功', sign: 'business-data-sign', data: { total: 1, items: [{ name: '示例企业', id: 'ent-1', token: 'business-token', url: 'https://example.com/file?sign=business' }] } }
const request = { apiId: '1.31', body: { query: { keyword: '示例企业' } }, idempotencyKey: 'enterprise-test-0001', path: '/api/v1/data/enterprise/1.31/query' }

export async function enterpriseFixture({ fetchImpl = async () => new Response(JSON.stringify(payload)), activate = true, store = new MemoryStore(), platformStore, control, credentialStore } = {}) {
  const hub = new HubService({ store, adapter: {}, apiKeyPepper: pepper })
  const tenant = await hub.createTenant({ name: 'Enterprise test tenant' })
  const consumer = await hub.createConsumer({ name: 'Enterprise test consumer', tenantId: tenant.id })
  await store.setPlatformGrant(consumer.id, 'enterprise', true)
  await hub.putCapabilityConfiguration('enterprise.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'Enterprise Key', platforms: ['enterprise'], capabilities: ['enterprise.query'] })
  const context = await hub.authenticate(key.secret)
  platformStore ??= new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'qixin', authorizationPlatform: 'enterprise' })
  control ??= new MemoryExternalPlatformControlStore()
  credentialStore ??= new StructuredExternalPlatformCredentialStore({ providerKey: 'qixin', fields: QIXIN_CREDENTIAL_FIELDS, pepper })
  await credentialStore.updateCredential('qixin', { credentials, expectedRevision: 0 })
  const enable = async (id = '1.31', price = 1) => control.updatePolicy('qixin', enterpriseOperation(id), {
    desiredState: 'active', expectedRevision: (await control.describeProvider('qixin', { config: QIXIN_CONFIG, credentialConfigured: true })).find(row => row.operationKey === enterpriseOperation(id)).revision, reason: 'Offline fixture price review',
    priceBook: { currency: 'CNY', pricingAsOf: '2026-09-17T00:00:00Z', monthlyBudgetMinor: 1000, monthlySubsidyBudgetMinor: 1000, unitCostMinorByEndpoint: { [enterpriseEndpoint(id)]: price } },
  }, { runtime: { config: QIXIN_CONFIG, credentialConfigured: true } })
  if (activate) await enable()
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, operationControlStore: control, credentialStore,
    providerKey: 'qixin', config: QIXIN_CONFIG, apiKeyPepper: pepper, adapter: new QixinAdapter({ fetchImpl }), reservationLeaseMs: 120000 })
  return { hub, store, context, platformStore, credentialStore, control, gateway, enable, key }
}

test('all 274 catalog requests are fixed-origin and locally validated, including conditional fields', () => {
  assert.equal(QIXIN_CATALOG.apis.length, 274)
  assert.equal(new Set(QIXIN_CATALOG.apis.map(api => api.api_id)).size, 274)
  assert.equal(normalizeEnterpriseRequest('1.31', request.body).endpointVersion, 'qixin-auth-v2.catalog-2026-09-01', 'pricing must preserve existing retry/cache identities')
  for (const api of QIXIN_CATALOG.apis) {
    assert.equal(new URL(api.interface).origin, 'https://api.qixin.com')
    const make = section => Object.fromEntries(enterpriseFields(api, section).filter(f => f.required === 1).map(f => [f.name, f.type.toLowerCase() === 'number' ? 1 : '示例']))
    const input = { query: make('query'), ...(api.body.length ? { body: make('body') } : {}) }
    if (api.api_id === '66.35') input.query.keyword = '示例'
    if (api.api_id === '22.11') input.query.register_no = '示例'
    assert.equal(normalizeEnterpriseRequest(api.api_id, input).endpointKey, enterpriseEndpoint(api.api_id))
  }
  for (const body of [{ url: 'https://evil.test' }, { query: { keyword: ['bad'] } }, { query: { keyword: '有效', appkey: 'x' } }, { query: { keyword: '有效', skip: true } }, { query: { keyword: '有效' }, body: {} }]) assert.throws(() => normalizeEnterpriseRequest('1.31', body))
  assert.throws(() => normalizeEnterpriseRequest('66.35', { query: {} }))
  assert.throws(() => normalizeEnterpriseRequest('missing', {}), { status: 404 })
})

test('multi-field credential save is atomic, encrypted, revisioned and absent from status', async () => {
  const store = new StructuredExternalPlatformCredentialStore({ providerKey: 'qixin', fields: QIXIN_CREDENTIAL_FIELDS, pepper })
  await assert.rejects(store.updateCredential('qixin', { credentials: { appkey: 'only-one' }, expectedRevision: 0 }), { status: 400 })
  await store.updateCredential('qixin', { credentials, expectedRevision: 0 })
  assert.deepEqual(await store.readCredential('qixin'), credentials)
  assert.equal((await store.readCredentialSnapshot('qixin')).revision, 1)
  const stored = await store.storage.readCredential('qixin')
  assert.ok(!stored.includes(credentials.appkey) && !stored.includes(credentials.secret_key))
  assert.ok(!JSON.stringify(await store.describeCredential('qixin')).includes(credentials.secret_key))
  await assert.rejects(store.updateCredential('qixin', { credentials, expectedRevision: 0 }), { status: 409 })
  await assert.rejects(store.readCredential('justone'), { status: 404 })
})

test('signing, GET encoding, exact data retention, snapshot replay and correct ingest domain', async () => {
  let calls = 0
  const f = await enterpriseFixture({ fetchImpl: async (url, init) => {
    calls++; assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    assert.equal(new URL(url).searchParams.get('keyword'), '示例企业')
    assert.equal(init.headers.sign, createHash('md5').update(credentials.appkey + init.headers.timestamp + credentials.secret_key).digest('hex'))
    return new Response(JSON.stringify(payload))
  } })
  const result = await f.gateway.queryEnterprise(f.context, request)
  assert.deepEqual(result.body.data, payload)
  const replay = await f.gateway.queryEnterprise(f.context, request)
  assert.equal(replay.replay, true); assert.equal(calls, 1)
  const call = [...f.platformStore.calls.values()][0]
  assert.equal(call.billed, null)
  const archive = f.platformStore.restrictedResponseArchives.get(call.id)
  assert.equal(archive.bodyText, JSON.stringify(payload))
  const job = f.platformStore.ingestJobs[0].payload
  assert.equal(job.platform, 'enterprise'); assert.equal(job.datasetId, 'enterprise.responses.v1')
  assert.deepEqual(job.records[0].rawItem, payload)
  assert.equal(job.records[0].objectType, 'enterprise_response')
  await assert.rejects(f.gateway.queryEnterprise(f.context, { ...request, body: { query: { keyword: '不同企业' } } }), { status: 409 })
  await f.store.setPlatformGrant(f.context.consumer.id, 'enterprise', false)
  await assert.rejects(f.gateway.queryEnterprise(f.context, request), { status: 403 })
  assert.equal(calls, 1)
})

test('default gates still require customer pricing or subsidy; Test or ungranted Keys never dispatch', async () => {
  let calls = 0
  const f = await enterpriseFixture({ activate: false, fetchImpl: async () => { calls++; return new Response('{}') } })
  await assert.rejects(f.gateway.queryEnterprise(f.context, request), { code: 'external_platform_cost_budget_exhausted' })
  await assert.rejects(f.gateway.queryEnterprise({ ...f.context, apiKey: { ...f.context.apiKey, environment: 'test' } }, request), { code: 'test_key_not_supported' })
  const empty = await f.hub.createApiKey({ consumerId: f.context.consumer.id, name: 'Empty', platforms: [], capabilities: [] })
  await assert.rejects(f.gateway.queryEnterprise(await f.hub.authenticate(empty.secret), request), { status: 403 })
  assert.equal(calls, 0)
})

test('cache-only requests never dispatch and fresh snapshots can be reused without another supplier call', async () => {
  let calls = 0
  const f = await enterpriseFixture({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload)) } })
  const cachedRequest = { ...request, idempotencyKey: undefined, body: { ...request.body, deliveryMode: 'cache_only' } }
  await assert.rejects(f.gateway.queryEnterprise(f.context, cachedRequest), { code: 'stored_snapshot_not_found' })
  assert.equal(calls, 0)
  await f.gateway.queryEnterprise(f.context, request)
  const cached = await f.gateway.queryEnterprise(f.context, cachedRequest)
  assert.deepEqual(cached.body.data, payload)
  assert.equal(cached.sourceMode, 'fresh_cache'); assert.equal(calls, 1)
})

test('HTTP forwarding and credential management preserve separate Public and Admin authentication', async t => {
  let calls = 0
  const f = await enterpriseFixture({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload)) } })
  const adminToken = 'enterprise-http-synthetic-admin'
  const externalPlatformAdmin = new QixinAdminService({ store: f.platformStore, config: QIXIN_CONFIG,
    credentialStore: f.credentialStore, operationControlStore: f.control, providerKey: 'qixin', metadata: QIXIN_METADATA })
  const server = createServer(createApp({ service: f.hub, store: f.store, adminToken,
    enterpriseGateway: f.gateway, externalPlatformAdmin, logger: { info() {}, error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const send = (path, headers, body, method = 'POST') => fetch(origin + path, {
    method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const publicHeaders = { authorization: `Bearer ${f.key.secret}`, 'idempotency-key': request.idempotencyKey }
  assert.equal((await send(request.path, {}, request.body)).status, 401)
  assert.equal((await send(request.path + '?url=https://example.com', publicHeaders, request.body)).status, 400)
  const delivered = await send(request.path, publicHeaders, request.body)
  assert.equal(delivered.status, 200); assert.deepEqual((await delivered.json()).data, payload)
  const replay = await send(request.path, publicHeaders, request.body)
  assert.equal(replay.headers.get('idempotent-replay'), 'true'); assert.equal(calls, 1)
  const credentialPath = '/internal/v1/admin/external-platforms/qixin/credential'
  assert.equal((await send(credentialPath + '/reveal', publicHeaders, { adminToken })).status, 403)
  const adminHeaders = { 'x-mx-insight-admin-token': adminToken }
  assert.equal((await send(credentialPath + '/reveal', adminHeaders, { adminToken: 'wrong' })).status, 403)
  const reveal = await send(credentialPath + '/reveal', adminHeaders, { adminToken })
  assert.equal(reveal.status, 200); assert.match(reveal.headers.get('cache-control'), /no-store/)
  assert.deepEqual((await reveal.json()).data.credentials, credentials)
  const detail = await send('/internal/v1/admin/external-platforms/qixin', adminHeaders, null, 'GET')
  const detailText = await detail.text()
  assert.equal(detail.status, 200); assert.ok(!detailText.includes(credentials.secret_key))
  // Anonymous documentation routes deliberately hide their existence.
  assert.equal((await fetch(origin + '/docs/enterprise/1.31')).status, 404)
  assert.equal(calls, 1)
})

test('unknown outcome blocks automatic redispatch; rejected payload is archived', async () => {
  let calls = 0
  const f = await enterpriseFixture({ fetchImpl: async () => { calls++; throw new Error('network detail must not leak') } })
  await assert.rejects(f.gateway.queryEnterprise(f.context, request), { code: 'external_platform_outcome_unknown' })
  await assert.rejects(f.gateway.queryEnterprise(f.context, { ...request, idempotencyKey: 'enterprise-second-0002' }))
  assert.equal(calls, 1)
  const denied = await enterpriseFixture({ fetchImpl: async () => new Response(JSON.stringify({ status: '102', message: 'balance', data: null })) })
  await assert.rejects(denied.gateway.queryEnterprise(denied.context, request))
  assert.equal(denied.platformStore.restrictedResponseArchives.size, 1)
})

test('reviewed zero-cost result endpoint, no-data and pending responses have explicit semantics', async () => {
  const f = await enterpriseFixture({ activate: false, fetchImpl: async () => new Response(JSON.stringify({ status: '202', data: { report_id: 'report-1' } })) })
  await f.enable('36.99', 0)
  const api = QIXIN_CATALOG.apis.find(api => api.api_id === '36.99')
  const query = Object.fromEntries(enterpriseFields(api, 'query').filter(f => f.required === 1).map(f => [f.name, 'report-1']))
  const result = await f.gateway.queryEnterprise(f.context, { ...request, apiId: '36.99', path: '/api/v1/data/enterprise/36.99/query', body: { query } })
  assert.equal(result.body.meta.resultState, 'pending')
  assert.equal([...f.platformStore.calls.values()][0].costMinor, 0)
  await assert.rejects(f.enable('1.31', 0), { status: 400 })
})

test('documentation is separate, searchable and tenant-scope filtered', () => {
  const scopes = [{ platforms: ['enterprise'], capabilities: ['enterprise.query'] }]
  assert.ok(publicDocsHtmlForPath('/docs/enterprise').includes('enterprise-filter'))
  const html = publicDocsHtmlForPath('/docs/enterprise/1.31', { tenant: true, scopes })
  assert.ok(html.includes('/api/v1/data/enterprise/1.31/query'))
  assert.ok(!html.includes('\n+  -H'))
  assert.ok(!html.includes('api.qixin.com') && !html.includes('官网参考价'))
  assert.equal(publicDocsHtmlForPath('/docs/enterprise/1.31', { tenant: true, scopes: [] }), null)
  const allowed = tenantOpenApiDocument(scopes)
  assert.equal(Object.keys(allowed.paths).filter(path => path.startsWith('/data/enterprise/')).length, 274)
  assert.deepEqual(allowed.paths['/data/enterprise/1.31/query'].post.requestBody.content['application/json'].schema.required, ['query'])
  assert.deepEqual(allowed.paths['/data/enterprise/42.3/query'].post.requestBody.content['application/json'].schema.required, ['body'])
  const denied = tenantOpenApiDocument([{ platforms: ['enterprise'], capabilities: [] }, { platforms: [], capabilities: ['enterprise.query'] }])
  assert.ok(!Object.keys(denied.paths).some(path => path.startsWith('/data/enterprise/')))
})

test('POST JSON uses the pinned method, removes credential echoes only, and preserves business sign/token fields', async () => {
  const input = { body: { longitude: 121.47, latitude: 31.23, radius: 5 } }
  const adapter = new QixinAdapter({ fetchImpl: async (url, init) => {
    assert.equal(new URL(url).origin, 'https://api.qixin.com')
    assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(init.body), input.body)
    return new Response(JSON.stringify({ status: '200', data: { sign: 'business-sign', token: 'business-token', credentialEcho: credentials.secret_key } }).replace('synthetic-secret-key', '\\u0073ynthetic-secret-key'))
  } })
  const result = await adapter.query('42.3', input, { credential: credentials })
  assert.equal(result.publicBody.data.data.credentialEcho, '[REDACTED]')
  assert.equal(result.publicBody.data.data.sign, 'business-sign')
  assert.equal(result.publicBody.data.data.token, 'business-token')
  assert.ok(!result.restrictedResponseArchive.bodyText.includes(credentials.secret_key))
})

test('oversized or invalid JSON is not delivered as a successful or truncated response', async () => {
  const oversized = new QixinAdapter({ maxResponseBytes: 8, fetchImpl: async () => new Response(JSON.stringify(payload)) })
  await assert.rejects(oversized.query('1.31', request.body, { credential: credentials }), error => error.evidence.outcome === 'unknown')
  const malformed = new QixinAdapter({ fetchImpl: async () => new Response('<html>upstream failure</html>') })
  await assert.rejects(malformed.query('1.31', request.body, { credential: credentials }), error => {
    assert.equal(error.evidence.outcome, 'unknown'); assert.equal(error.restrictedResponseArchive.bodyText, '<html>upstream failure</html>'); return true
  })
})

test('PostgreSQL migration, price controls, archives, worker ingest and outbox persist end to end', { skip: !process.env.MX_ENTERPRISE_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.MX_ENTERPRISE_PGLITE_MODULE)
  const { pg_trgm } = await import(new URL('./contrib/pg_trgm.js', `file://${process.env.MX_ENTERPRISE_PGLITE_MODULE}`))
  const { readFile, readdir } = await import('node:fs/promises')
  const { PostgresStore } = await import('../../server/stores/postgres-store.mjs')
  const { PostgresExternalPlatformStore } = await import('../../server/external-platforms/store.mjs')
  const { PostgresExternalPlatformControlStore } = await import('../../server/external-platforms/control-store.mjs')
  const { rehydrateJustOneQueuedRecords } = await import('../../server/ingest/justone.mjs')
  const { PostgresAcquisitionHistoryStore } = await import('../../server/acquisitions/history-store.mjs')
  const db = new PGlite({ extensions: { pg_trgm } })
  t.after(() => db.close())
  for (const directory of [new URL('../../../mx-common/migrations/', import.meta.url), new URL('../../migrations/', import.meta.url)]) {
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      if (file === '092_qixin_official_prices.sql') {
        await db.exec("UPDATE control.external_platform_operation_policies SET desired_state='paused', control_source='database', revision=1, updated_by='existing-operator' WHERE provider_key='qixin' AND operation_key='enterprise.api.1.2'")
      }
      await db.exec('BEGIN'); await db.exec(await readFile(new URL(file, directory), 'utf8')); await db.exec('COMMIT')
    }
  }
  const query = async (sql, values) => { const result = await db.query(sql, values); return { ...result, rowCount: result.rows.length || result.affectedRows } }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  const store = new PostgresStore(pool)
  const platformStore = new PostgresExternalPlatformStore({ pool, usageStore: store, providerKey: 'qixin', authorizationPlatform: 'enterprise' })
  const control = new PostgresExternalPlatformControlStore({ pool })
  const migrated = await control.describeProvider('qixin', { config: QIXIN_CONFIG, credentialConfigured: true })
  assert.equal(migrated.filter(row => row.effectiveState === 'active').length, 259)
  assert.equal(migrated.find(row => row.operationKey === 'enterprise.api.1.2').effectiveState, 'paused', 'deployment preserves operator pause')
  assert.equal(migrated.find(row => row.operationKey === 'enterprise.api.1.2').revision, 1)
  assert.equal(migrated.find(row => row.operationKey === 'enterprise.api.77.58').priceBook.endpointPrices['enterprise.77.58'], 10)
  assert.ok(migrated.every(row => Object.keys(row.priceBook.endpointPrices).length <= 1), 'do not duplicate the 260-entry book into every operation payload')
  const credentialStore = new StructuredExternalPlatformCredentialStore({ pool, providerKey: 'qixin', fields: QIXIN_CREDENTIAL_FIELDS, pepper })
  const f = await enterpriseFixture({ store, platformStore, control, credentialStore })
  const combined = await f.hub.publishPlanVersion({ key: 'pg-qixin', name: 'PG official combination',
    components: [{ type: 'feature', key: 'qixin', version: 1, multiplierPpm: 900000 }, { type: 'feature', key: 'xiaohongshu', version: 1 }],
    limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 }, priceBook: { key: 'pg-qixin', currency: 'CNY', defaultMultiplierPpm: 1000000 },
  }, 'fixture')
  assert.equal(combined.priceBook.entries.length, 264)
  const currentPlan = await f.hub.getConsumerPlan(f.context.consumer.id)
  await f.hub.assignConsumerPlan(f.context.consumer.id, { planVersionId: combined.versionId, expectedRevision: currentPlan.revision }, 'fixture')
  assert.equal((await f.hub.getConsumerPlan(f.context.consumer.id)).priceBook.entries.find(entry => entry.meterKey === 'enterprise.api.47.51').unitPriceMinor, 270)
  const result = await f.gateway.queryEnterprise(f.context, request)
  assert.deepEqual(result.body.data, payload)
  assert.equal((await query("SELECT count(*) AS count FROM control.external_platform_operation_policies WHERE provider_key='qixin'")).rows[0].count, 274)
  const jobs = (await query("SELECT payload FROM mxq.jobs WHERE payload->>'providerKey'='qixin'")).rows
  assert.equal(jobs.length, 1)
  const job = jobs[0].payload
  const ingested = await store.ingestExternalRecords({ datasetId: job.datasetId, platform: job.platform,
    records: rehydrateJustOneQueuedRecords(job.records), importRunId: null, connectorId: 'external-platform:qixin',
    externalPlatformLineage: { requestId: job.requestId, queryFingerprint: job.queryFingerprint, providerCallId: job.providerCallId } })
  assert.equal(ingested.ingested, 1)
  const saved = (await query("SELECT dataset_id, extensions FROM core.canonical_records WHERE platform='enterprise'")).rows[0]
  assert.equal(saved.dataset_id, 'enterprise.responses.v1'); assert.deepEqual(saved.extensions.response, payload)
  assert.ok((await query('SELECT * FROM outbox.projection_events')).rows.length > 0)
  const history = new PostgresAcquisitionHistoryStore(pool)
  const deliveredRun = await history.getPublicDeliveredRun({ requestId: result.requestId, consumerId: f.context.consumer.id, apiKeyId: f.context.apiKey.id })
  assert.deepEqual(deliveredRun.delivered.responseBody.data, payload)
  assert.equal(deliveredRun.items.length, 1)
  assert.equal(deliveredRun.scope.platform, 'enterprise')
  await assert.rejects(history.getPublicDeliveredRun({ requestId: result.requestId, consumerId: f.context.tenant.id, apiKeyId: f.context.apiKey.id }), { status: 404 })
  assert.equal((await f.gateway.queryEnterprise(f.context, request)).replay, true)
  await f.enable('36.99', 0)
  const api = QIXIN_CATALOG.apis.find(api => api.api_id === '36.99')
  const input = Object.fromEntries(enterpriseFields(api, 'query').filter(f => f.required === 1).map(f => [f.name, 'report-1']))
  const zero = await f.gateway.queryEnterprise(f.context, { ...request, apiId: '36.99', path: '/api/v1/data/enterprise/36.99/query', idempotencyKey: 'enterprise-zero-0001', body: { query: input } })
  assert.equal(zero.status, 200)
  assert.equal((await query("SELECT cost_minor FROM external_platform.provider_calls WHERE endpoint_key='enterprise.36.99'")).rows[0].cost_minor, 0)
})

test('official defaults allow granted billed requests, while negotiated APIs and missing grants never dispatch', async () => {
  let calls = 0
  const f = await enterpriseFixture({ activate: false, fetchImpl: async () => { calls++; return new Response(JSON.stringify(payload)) } })
  const operations = await f.control.describeProvider('qixin', { config: QIXIN_CONFIG, credentialConfigured: true })
  assert.equal(operations.filter(op => op.effectiveState === 'active').length, 260)
  assert.equal(operations.filter(op => op.blockers.some(item => item.code === 'enterprise_price_negotiated')).length, 14)
  await assert.rejects(f.control.updatePolicy('qixin', 'enterprise.api.55.82', {
    desiredState: 'active', expectedRevision: 0, reason: 'Attempt override',
    priceBook: { currency: 'CNY', pricingAsOf: new Date().toISOString(), monthlyBudgetMinor: 1000, monthlySubsidyBudgetMinor: 1000, unitCostMinorByEndpoint: { 'enterprise.55.82': 500 } },
  }), { code: 'enterprise_price_negotiated' })
  const plan = await f.hub.publishPlanVersion({ key: 'qixin-official', name: 'Official-price fixture',
    components: [{ type: 'feature', key: 'qixin', version: 1, multiplierPpm: 1_200_000 }],
    limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 },
    priceBook: { key: 'qixin-official', currency: 'CNY', defaultMultiplierPpm: 1000000 },
  }, 'fixture')
  const current = await f.hub.getConsumerPlan(f.context.consumer.id)
  await f.hub.assignConsumerPlan(f.context.consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'fixture')
  await f.hub.setTenantBillingProfile(f.context.tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'fixture')
  await f.hub.addTenantCredit(f.context.tenant.id, { amountMinor: 10000, currency: 'CNY', reason: 'Offline fixture credit' }, { idempotencyKey: 'qixin-test-credit', actor: 'fixture' })
  await f.gateway.queryEnterprise(f.context, request)
  assert.equal(calls, 1)
  const billing = await f.hub.getTenantBilling(f.context.tenant.id)
  assert.equal(billing.account.availableMinor, 10000 - plan.priceBook.entries.find(entry => entry.meterKey === 'enterprise.api.1.31').unitPriceMinor)
  await assert.rejects(f.gateway.queryEnterprise(f.context, { ...request, apiId: '55.82' }), { code: 'enterprise_price_negotiated' })
  await assert.rejects(new QixinAdapter({ fetchImpl: () => { calls++; throw Error('must not dispatch') } }).query('55.82', {}, { credential: credentials }), { code: 'enterprise_price_negotiated' })
  // Consumer revocation constrains an already-issued Key immediately.
  await f.hub.putCapabilityConfiguration('enterprise.query', { tenantId: f.context.tenant.id, consumerId: f.context.consumer.id, enabled: false })
  await assert.rejects(f.gateway.queryEnterprise(f.context, { ...request, idempotencyKey: 'new-request-with-revoked-grant' }), { status: 403 })
  assert.equal(calls, 1)
})
