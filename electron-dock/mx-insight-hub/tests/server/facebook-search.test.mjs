import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { FACEBOOK_ENDPOINT, FACEBOOK_OPERATION, FACEBOOK_JUSTONE_KEY } from '../../server/contracts/facebook-search.mjs'
import { PlatformSearchPolicyStore, rapidQuotaObservation } from '../../server/external-platforms/platform-search-policy.mjs'
import { migrateFacebookCredentials } from '../../scripts/migrate-facebook-credentials.mjs'

const PEPPER = 'facebook-offline-test-pepper-at-least-32-characters'
const ADMIN = 'facebook-offline-admin-token-at-least-32-characters'
const post = { post_id: '123_456', message: '完整内容\n' + '正文'.repeat(1000), timestamp: 1791597600,
  author: { id: '123', name: 'Author' }, reactions_count: 0, comments_count: 2, video_files: { hd: 'https://example.test/movie' } }

async function harness({ rapidStatus = 200, mode = 'auto', quotaAllowed = true, malformed = false, hasMore = false, policyStore: suppliedPolicy, pool = null } = {}) {
  const usage = pool ? new PostgresStore(pool) : new MemoryStore(), calls = [], stores = {}, gateways = {}, observations = []
  let oldCalls = 0
  const service = new HubService({ store: usage, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { oldCalls++; throw new Error('Facebook must not reach Night-All') },
    async search() { oldCalls++; throw new Error('Facebook must not reach Night-All') },
  } })
  const tenant = await service.createTenant({ name: 'Facebook fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Facebook fixture' })
  await service.putPlatformConfiguration('facebook', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Facebook', platforms: ['facebook'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const controls = createExternalPlatformControlStore({ pool })
  const policy = { mode, monthly_limit: 1000, probe_interval_hours: 72, revision: 1 }
  const policyStore = suppliedPolicy || { facebook: async () => policy,
    admitRapid: async () => ({ allowed: quotaAllowed, token: 'fixture' }),
    observeRapid: async (_, value) => observations.push(value) }
  for (const provider of ['rapidapi', 'justone']) {
    const endpointKey = provider === 'rapidapi' ? FACEBOOK_ENDPOINT : `native.${FACEBOOK_JUSTONE_KEY}`
    const operation = provider === 'rapidapi' ? FACEBOOK_OPERATION.operationKey : endpointKey
    const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 1000,
      freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100 }
    const current = (await controls.describeProvider(provider, { config, credentialConfigured: true })).find(row => row.operationKey === operation)
    await controls.updatePolicy(provider, operation, { expectedRevision: current.revision, desiredState: 'active', reason: 'Offline Facebook fixture',
      priceBook: { currency: provider === 'rapidapi' ? 'USD' : 'CNY', pricingAsOf: '2026-10-10T00:00:00Z',
        monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpointKey]: provider === 'rapidapi' ? 0 : 1 } } },
    { runtime: { config, credentialConfigured: true } })
    const fetchImpl = async url => {
      calls.push({ provider, url: new URL(url) })
      if (provider === 'rapidapi') {
        if (rapidStatus === 'timeout') throw new Error('synthetic transport loss')
        return Response.json(malformed ? { unexpected: true } : { results: [post], cursor: hasMore ? 'private-upstream-cursor' : null },
          { status: rapidStatus, headers: { 'x-ratelimit-requests-remaining': rapidStatus === 429 ? '0' : '999', 'x-ratelimit-requests-reset': '172800' } })
      }
      return Response.json({ code: 0, message: 'success', requestId: 'upstream-justone', recordTime: '2026-10-10T00:00:00Z',
        data: { business_data: [post], cursor: hasMore ? 'private-justone-cursor' : null } })
    }
    const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: 'fixture-only-key', fetchImpl })
      : new JustOneAdapter({ token: 'fixture-only-key', fetchImpl, logger: { warn() {}, error() {} } })
    const platformStore = pool ? new PostgresExternalPlatformStore({ pool, providerKey: provider, authorizationPlatform: 'facebook' })
      : new MemoryExternalPlatformStore({ usageStore: usage, providerKey: provider, authorizationPlatform: 'facebook' })
    stores[provider] = platformStore
    gateways[provider] = new ExternalPlatformGateway({ usageStore: usage, platformStore, adapter, config, providerKey: provider,
      operationControlStore: controls, apiKeyPepper: PEPPER, reservationLeaseMs: 120000, logger: pool ? console : { warn() {}, error() {} } })
  }
  const dispatch = (ctx, input) => gateways.rapidapi.searchFacebook(ctx, input, { policyStore, fallbackGateway: gateways.justone })
  service.externalRawSearch = dispatch; service.externalDataSearch = dispatch
  const invoke = (body = { platform: 'facebook', query: 'Unitree', count: 20 }, idempotencyKey = 'facebook-request-0001') =>
    service.nightAllCompatibilitySearch(context, { operation: 'raw', body, idempotencyKey, path: '/api/v1/night-all/search/raw' })
  return { usage, service, stores, context, key, calls, policy, policyStore, observations, invoke, oldCalls: () => oldCalls }
}

test('Facebook raw owns both providers, dates, exact replay and canonical ingest', async () => {
  const h = await harness()
  const body = { platform: 'facebook', query: '(Unitree OR 宇树科技)', count: 20, params: { startTime: '2026-10-07T10:11:11Z', endTime: '2026-10-10T10:11:11Z' } }
  const first = await h.invoke(body)
  assert.equal(first.body.data.status, 'ok')
  assert.equal(h.calls[0].url.host, 'facebook-scraper3.p.rapidapi.com')
  assert.equal(h.calls[0].url.searchParams.get('start_date'), '2026-10-07')
  assert.equal(h.calls[0].url.searchParams.get('query'), body.query)
  assert.equal(JSON.parse(first.body.data.raw_data)[0].full_text, post.message)
  assert.equal(h.stores.rapidapi.ingestJobs[0].payload.records[0].body, post.message)
  assert.deepEqual((await h.invoke(body)).body, first.body)
  assert.equal(h.calls.length, 1); assert.equal(h.oldCalls(), 0)
})

test('confirmed 429 uses one customer request and two durable provider receipts', async () => {
  const h = await harness({ rapidStatus: 429 })
  const first = await h.invoke()
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi', 'justone'])
  const rapid = [...h.stores.rapidapi.calls.values()][0], fallback = [...h.stores.justone.calls.values()][0]
  assert.equal(rapid.outcome, 'rejected'); assert.equal(fallback.outcome, 'succeeded')
  assert.equal(rapid.usageRequestId, fallback.usageRequestId)
  assert.equal(fallback.callOrdinal, 1)
  assert.equal(first.body.data.meta.upstreamCallCount, 2)
  assert.equal(h.stores.justone.ingestJobs[0].payload.providerKey, 'justone')
  assert.deepEqual((await h.invoke()).body, first.body)
  assert.equal(h.calls.length, 2)
})

test('exhausted quota and administrator-selected JustOne never send RapidAPI traffic', async () => {
  for (const options of [{ quotaAllowed: false }, { mode: 'justone' }]) {
    const h = await harness(options)
    await h.invoke()
    assert.deepEqual(h.calls.map(row => row.provider), ['justone'])
  }
})

test('ambiguous or malformed paid responses never fall through or retry', async () => {
  for (const options of [{ rapidStatus: 'timeout' }, { rapidStatus: 503 }, { malformed: true }]) {
    const h = await harness(options)
    await assert.rejects(h.invoke())
    await assert.rejects(h.invoke())
    assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi'])
    assert.equal(h.oldCalls(), 0)
  }
})

test('cursor is consumer/query/provider pinned; pause and invalid shapes fail before dispatch', async () => {
  const h = await harness({ hasMore: true, mode: 'justone' })
  const first = await h.invoke()
  const cursor = first.body.data.page.nextCursor
  assert.ok(cursor.startsWith('mxraw1.')); assert.ok(!cursor.includes('justone'))
  h.policy.mode = 'auto'
  await h.invoke({ platform: 'facebook', query: 'Unitree', count: 20, cursor }, 'facebook-request-page2')
  assert.deepEqual(h.calls.map(row => row.provider), ['justone', 'justone'])
  assert.equal(h.calls[1].url.searchParams.get('cursor'), 'private-justone-cursor')
  for (const body of [ { platform: 'facebook', query: 'changed', cursor }, { platform: 'facebook', query: 'Unitree', cursor: 'old-provider-token' },
    { platform: 'facebook', queries: ['a', 'b'], count: 20 }, { platform: 'facebook', query: 'x', params: { host: 'evil' } } ]) {
    await assert.rejects(h.invoke(body, 'invalid-request-0001'), e => e.status === 400)
  }
  h.policy.mode = 'paused'
  await assert.rejects(h.invoke({ platform: 'facebook', query: 'other' }, 'paused-request-0001'), { code: 'facebook_search_paused' })
  assert.equal(h.calls.length, 2); assert.equal(h.oldCalls(), 0)
})

test('data/search projects Facebook into the existing canonical-compatible v1 envelope', async () => {
  const h = await harness()
  const result = await h.service.search(h.context, { body: { platform: 'facebook', query: 'Unitree', pageSize: 20,
    params: { startTime: '2026-10-07T10:11:11Z', endTime: '2026-10-10T10:11:11Z' } },
    idempotencyKey: 'facebook-data-00001', path: '/api/v1/data/search' })
  assert.equal(result.body.data.contractVersion, 'night-all.data-search.v1')
  assert.equal(result.body.data.items[0].title, null)
  assert.equal(result.body.data.items[0].text, post.message)
  assert.equal(result.body.data.items[0].source.provider, null)
  assert.equal(h.calls[0].url.searchParams.get('start_date'), '2026-10-07')
  assert.equal(h.calls[0].url.searchParams.get('end_date'), '2026-10-10')
  assert.equal(h.oldCalls(), 0)
})

test('an exhausted RapidAPI continuation never sends its cursor to JustOne', async () => {
  let allowed = true
  const h = await harness({ hasMore: true, policyStore: { facebook: async () => ({ mode: 'auto' }),
    admitRapid: async () => ({ allowed }), observeRapid: async () => {} } })
  const first = await h.invoke()
  allowed = false
  await assert.rejects(h.invoke({ platform: 'facebook', query: 'Unitree', count: 20, cursor: first.body.data.page.nextCursor },
    'facebook-pinned-capacity'), { code: 'search_restart_required' })
  assert.deepEqual(h.calls.map(row => row.provider), ['rapidapi'])
  assert.equal(h.oldCalls(), 0)
})

test('capabilities expose Hub-owned Facebook search separately from unmigrated operations', async () => {
  const h = await harness()
  h.service.externalFacebookCapabilities = async () => ({ ready: true })
  const result = await h.service.capabilities(h.context)
  const row = result.data.platforms.find(row => row.platform === 'facebook')
  assert.equal(row.search.ready, true)
  assert.equal(row.search.source, 'hub')
  assert.equal(row.ready, false)
  h.service.externalFacebookCapabilities = async () => ({ ready: false })
  assert.equal((await h.service.capabilities(h.context)).data.platforms.find(row => row.platform === 'facebook').search.ready, false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.oldCalls(), 0)
})

test('HTTP aliases share immutable delivery and policy endpoints require the Admin token', async t => {
  const h = await harness()
  const app = createApp({ service: h.service, store: h.usage, adminToken: ADMIN,
    platformSearchPolicyStore: { list: async () => [{ platform: 'facebook' }], update: async (_, body) => body } })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${h.key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'facebook-http-alias' }
  const bodies = []
  for (const path of ['/api/v1/night-all/search/raw', '/api/v1/search/raw']) {
    const response = await fetch(origin + path, { method: 'POST', headers, body: JSON.stringify({ platform: 'facebook', query: 'Unitree', count: 20 }) })
    assert.equal(response.status, 200); bodies.push(await response.json())
  }
  assert.deepEqual(bodies[0], bodies[1]); assert.equal(h.calls.length, 1)
  assert.notEqual((await fetch(origin + '/internal/v1/admin/platform-search-policies', { headers })).status, 200)
  assert.equal((await fetch(origin + '/internal/v1/admin/platform-search-policies', { headers: { 'x-mx-insight-admin-token': ADMIN } })).status, 200)
})

test('credential bootstrap preserves configured and deliberately cleared credentials and is idempotent', async () => {
  const states = { rapidapi: { revision: 0, credentialConfigured: false, source: 'environment' }, justone: { revision: 2, credentialConfigured: true, source: 'database' } }
  const writes = [], reads = []
  const options = { fetchImpl: async (url, input) => {
    const provider = url.includes('/rapidapi') ? 'rapidapi' : 'justone'
    if (input.method === 'PUT') { writes.push(provider); states[provider] = { revision: 1, credentialConfigured: true, source: 'database' }; return Response.json({ data: states[provider] }) }
    return Response.json({ data: { credential: states[provider] } })
  }, readCredentials: async (_, { providers }) => { reads.push(...providers); return { rapidapi: 'fixture-key' } } }
  await migrateFacebookCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN }, options)
  await migrateFacebookCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN }, options)
  assert.deepEqual(reads, ['rapidapi']); assert.deepEqual(writes, ['rapidapi'])
  states.rapidapi.credentialConfigured = false
  await migrateFacebookCredentials({ MX_INSIGHT_ADMIN_TOKEN: ADMIN }, options)
  assert.deepEqual(writes, ['rapidapi'])
})

test('RapidAPI billing headers are separate from short rate windows', () => {
  assert.equal(rapidQuotaObservation(new Response('', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' } })).remaining, null)
  const v = rapidQuotaObservation(new Response('', { status: 429, headers: { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': '80000', 'retry-after': '20' } }))
  assert.equal(v.remaining, 0); assert.equal(v.resetSeconds, 80000); assert.equal(v.retryAfterSeconds, 20)
})

test('PostgreSQL fallback preserves one usage identity, two raw receipts and one ingest job', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_FACEBOOK_TEST_DATABASE_URL })
  try {
    const h = await harness({ pool, rapidStatus: 429 })
    const first = await h.invoke()
    assert.deepEqual((await h.invoke()).body, first.body)
    assert.equal(h.calls.length, 2)
    const usages = (await pool.query('SELECT status,units_actual FROM usage_requests WHERE id=$1', [first.requestId])).rows
    assert.equal(usages.length, 1); assert.equal(usages[0].status, 'committed'); assert.equal(Number(usages[0].units_actual), 1)
    const calls = (await pool.query(`SELECT provider_key,outcome,usage_request_id,call_ordinal FROM external_platform.provider_calls
      WHERE usage_request_id=$1 ORDER BY call_ordinal`, [first.requestId])).rows
    assert.deepEqual(calls.map(row => [row.provider_key, row.outcome]), [['rapidapi', 'rejected'], ['justone', 'succeeded']])
    const archives = await pool.query(`SELECT count(*)::int n FROM control.external_platform_restricted_raw_responses raw
      JOIN external_platform.provider_calls call ON call.id=raw.provider_call_id WHERE call.usage_request_id=$1`, [first.requestId])
    assert.equal(archives.rows[0].n, 2)
    const jobs = await pool.query("SELECT payload FROM mxq.jobs WHERE payload->>'requestId'=$1", [first.requestId])
    assert.equal(jobs.rows.length, 1)
    assert.equal(jobs.rows[0].payload.records.length, 1)
    assert.equal(jobs.rows[0].payload.platform, 'facebook')
    assert.equal(h.oldCalls(), 0)
  } finally { await pool.end() }
})

test('PostgreSQL quota serializes replicas, recovers from reset/probes and audits policy CAS', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_FACEBOOK_TEST_DATABASE_URL })
  try {
    assert.match((await pool.query('SELECT current_database() name')).rows[0].name, /^mx_facebook_test_/)
    const sql = await readFile(new URL('../../migrations/143_facebook_platform_search.sql', import.meta.url), 'utf8')
    await pool.query('CREATE SCHEMA IF NOT EXISTS control')
    await pool.query(sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('ALTER TABLE')))
    const store = new PlatformSearchPolicyStore(pool)
    const results = await Promise.all(Array.from({ length: 20 }, () => store.admitRapid()))
    assert.equal(results.filter(r => r.allowed).length, 1)
    const first = results.find(r => r.allowed)
    await store.observeRapid(first, { ok: true, remaining: 0, resetSeconds: 3600 })
    assert.equal((await store.admitRapid()).allowed, false)
    await pool.query("UPDATE control.facebook_rapid_quota SET reset_at=now()-interval '1 second'")
    const reset = await store.admitRapid(); assert.equal(reset.allowed, true)
    await store.observeRapid(reset, { ok: true, remaining: 999 })
    await pool.query("UPDATE control.facebook_rapid_quota SET used=1000, remaining=0, reset_at=NULL, blocked_until=now()-interval '1 second'")
    const probes = await Promise.all(Array.from({ length: 12 }, () => store.admitRapid()))
    assert.equal(probes.filter(r => r.allowed).length, 1)
    const probe = probes.find(r => r.allowed); assert.equal(probe.probe, true)
    await store.observeRapid(probe, { ok: true })
    assert.equal((await store.admitRapid()).allowed, false, 'HTTP 200 alone can mean a billed overage')
    await pool.query("UPDATE control.facebook_rapid_quota SET blocked_until=now()-interval '1 second'")
    await store.observeRapid(await store.admitRapid(), { ok: true, remaining: 998, resetSeconds: 2500000 })
    assert.equal((await store.facebook()).used, 2)
    const policy = await store.facebook()
    const update = { mode: 'justone', monthlyLimit: 900, probeIntervalHours: 72, expectedRevision: policy.revision, reason: 'Test audited change' }
    await store.update('facebook', update)
    await assert.rejects(store.update('facebook', update), { code: 'platform_search_revision_conflict' })
    assert.equal((await store.admitRapid()).allowed, false)
    assert.equal((await pool.query("SELECT count(*)::int n FROM control.platform_search_policy_events WHERE platform='facebook'")).rows[0].n, 2)
  } finally { await pool.end() }
})

test('PostgreSQL recovery probe preserves unknown procurement cost', { skip: !process.env.MX_FACEBOOK_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.MX_FACEBOOK_TEST_DATABASE_URL })
  try {
    const h = await harness({ pool, policyStore: { facebook: async () => ({ mode: 'auto' }),
      admitRapid: async () => ({ allowed: true, probe: true }), observeRapid: async () => {} } })
    const result = await h.invoke()
    const { rows: [call] } = await pool.query('SELECT billed,cost_minor,cost_kind FROM external_platform.provider_calls WHERE usage_request_id=$1', [result.requestId])
    assert.equal(call.billed, null)
    assert.equal(call.cost_minor, null)
    assert.equal(call.cost_kind, 'unknown')
    assert.equal(h.calls.length, 1)
  } finally { await pool.end() }
})
