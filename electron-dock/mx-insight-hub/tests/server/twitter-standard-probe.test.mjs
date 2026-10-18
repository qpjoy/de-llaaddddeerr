import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { runStandardVerification, countSupplierCalls, ORIGINAL_REQUEST_ID, KEYS, TIME_WINDOW } from '../../server/ops/verify-twitter-standard.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'

const QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") AND NOT ("广告" OR "营销" OR "重复搬运") AND (("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost)'
const pepper = 'offline-standard-probe-test-pepper-at-least-32'
const dbRow = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/[A-Z]/gu, c => `_${c.toLowerCase()}`), value]))
const post = id => ({ tweet_id: String(1979366117396988012n + BigInt(id)), text: `Synthetic standard page ${id}`,
  created_at: 'Sun Oct 18 05:00:00 +0000 2026', user_info: { rest_id: '1899000000000000001', screen_name: 'fixture' },
  favorites: 0, replies: 0, retweets: 0, views: '1' })

async function harness({ empty = false, terminal = false, publishedAt, fail = false } = {}) {
  const store = new MemoryStore(), service = new HubService({ store, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Synthetic standard acceptance' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Existing Twitter caller' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Twitter-only', platforms: ['twitter'], capabilities: [] })
  const context = await service.authenticate(key.secret)
  const original = { id: ORIGINAL_REQUEST_ID, tenant_id: tenant.id, consumer_id: consumer.id, api_key_id: context.apiKey.id,
    platform: 'twitter', status: 'committed', response_status: 502,
    response_body: { error: { code: 'social_upstream_rejected', details: { upstreamStatus: 400 } } },
    acquisition_request: { path: '/api/v1/data/search', body: { platform: 'twitter', query: QUERY, pageSize: 20 } } }
  const controls = new MemoryExternalPlatformControlStore()
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const operation = 'native.t.twitter_web_fetch_search_timeline'
  await controls.updatePolicy('tikhub', operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline verification',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-18T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [operation]: 1 } } }, { runtime: { config, credentialConfigured: true } })
  let http = 0, locked = false, lockAvailable = true, released = 0, changedBudgetOwner = false
  const adapter = new TikHubAdapter({ apiKey: 'offline-fixture-secret', timeoutMs: 100, fetchImpl: async () => {
    http++
    if (fail) throw new Error('Synthetic supplier connection outcome unknown')
    const rows = empty ? [] : [1, 2, 3].map(id => ({ ...post(id), ...(publishedAt ? { created_at: publishedAt } : {}) }))
    return Response.json({ code: 200, data: { timeline: rows, next_cursor: terminal ? null : `synthetic-next-${http}` } })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'twitter' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: pepper, reservationLeaseMs: 120000, operationControlStore: controls, logger: { warn() {} } })
  const rapid = { platformStore: { calls: new Map() }, searchRaw: () => { throw new Error('Unexpected supplier switch') } }
  service.externalDataSearch = createTwitterSearchRouter({ usageStore: store, rapidGateway: rapid, tikHubGateway: gateway, apiKeyPepper: pepper })
  const calls = () => [...platformStore.calls.values()].filter(call => KEYS.includes(store.requests.get(call.usageRequestId)?.idempotencyKey))
  const pool = { async query(sql, args = []) {
    if (sql.includes('twitter-standard:original')) return { rows: [structuredClone(original)] }
    if (sql.includes('twitter-standard:budget')) return { rows: calls().map(call => ({ ...dbRow(call), request_tenant_id: original.tenant_id,
      request_api_key_id: original.api_key_id, ...(changedBudgetOwner ? { api_key_id: 'other' } : {}) })).slice(0, 3) }
    if (sql.includes('twitter-standard:saved')) { const row = store.requests.get(args[0]); return { rows: row?.idempotencyKey === args[1] ? [dbRow(row)] : [] } }
    if (sql.includes('twitter-standard:calls')) return { rows: calls().filter(call => call.usageRequestId === args[0]).map(dbRow) }
    if (sql.includes('twitter-standard:lock')) { const acquired = lockAvailable && !locked; locked ||= acquired; return { rows: [{ acquired }] } }
    if (sql.includes('pg_advisory_unlock')) { locked = false; return { rows: [] } }
    throw new Error(`Unexpected diagnostic SQL: ${sql}`)
  }, async connect() { return { query: pool.query, release() { released++ } } } }
  const runtime = { pool, store, service, externalPlatformControlStore: controls, tikHubAdapter: adapter, hubSocialGateway: rapid }
  return { runtime, store, original, platformStore, http: () => http, released: () => released, context,
    run: () => runStandardVerification({ runtime, AppError }), noLock: () => { lockAvailable = false },
    corruptBudgetOwner: () => { changedBudgetOwner = true } }
}

test('actual standard gateways deliver v1/v2, buffer next pages and exactly replay with at most two supplier attempts across reruns', async () => {
  const h = await harness(), first = await h.run()
  assert.equal(first.errorCode, undefined, JSON.stringify(first))
  assert.equal(first.standardDeliveryVerified, true)
  assert.equal(first.paginationVerified, true)
  assert.equal(first.originalUnchanged, true)
  assert.equal(first.versions.length, 2)
  assert.ok(first.adapterCalls <= 2 && first.adapterCalls > 0)
  for (const version of first.versions) {
    assert.deepEqual(version.pages.map(page => page.resultCount), [1, 1])
    assert.ok(version.pages.every(page => page.samePageReplayVerified))
    assert.equal(version.pages[1].providerCalls.length, 0, 'The second Hub page must consume the first supplier page buffer')
    assert.equal(version.pages[1].bufferedContinuationVerified, true)
  }
  const before = h.http(), second = await h.run()
  assert.equal(second.errorCode, undefined, JSON.stringify(second))
  assert.equal(second.adapterCalls, 0)
  assert.equal(h.http(), before)
  assert.equal(second.supplierCallsBefore, second.supplierCallsAfter)
  assert.equal(h.released(), 2)
  assert.deepEqual(await h.store.listEffectiveCapabilityGrants(h.context.consumer.id, h.context.apiKey.id), [])
  assert.doesNotMatch(JSON.stringify(first), /offline-fixture-secret|Synthetic standard page|synthetic-next-/u)
})

test('two empty source pages exhaust the persisted budget before a third HTTP request without creating unknown', async () => {
  const h = await harness({ empty: true }), first = await h.run()
  assert.equal(h.http(), 2)
  assert.equal(first.supplierCallsAfter, 2)
  assert.equal(first.errorCode, 'external_platform_operation_blocked', JSON.stringify(first))
  assert.ok([...h.store.requests.values()].every(row => row.status !== 'unknown'))
  const again = await h.run()
  assert.equal(h.http(), 2)
  assert.equal(again.adapterCalls, 0)
  assert.equal(again.originalUnchanged, true)
})

test('v2 filtering can legitimately deliver zero while retaining continuation and replay verification', async () => {
  const h = await harness({ publishedAt: 'Mon Sep 01 05:00:00 +0000 2025' }), report = await h.run()
  assert.equal(report.errorCode, undefined, JSON.stringify(report))
  assert.equal(report.standardDeliveryVerified, true)
  assert.deepEqual(report.versions[1].pages.map(row => row.resultCount), [0, 0])
  assert.deepEqual(report.versions[1].pages[0].effectiveWindow.from, TIME_WINDOW.from)
  assert.equal(report.paginationVerified, true)
})

test('unknown is retained and neither rerun nor v2 creates another acquisition', async () => {
  const h = await harness({ fail: true }), report = await h.run()
  assert.equal(h.http(), 1)
  assert.match(report.errorCode, /unknown/u)
  assert.equal(report.versions.length, 1)
  assert.equal(report.standardDeliveryVerified, undefined)
  await h.run()
  assert.equal(h.http(), 1)
})

test('concurrent diagnostic, missing owner and original query mutation stop before supplier dispatch', async () => {
  for (const mutate of [h => h.noLock(), h => { h.runtime.store.findApiKeyById = async () => null },
    h => { h.original.acquisition_request.body.query = 'OpenAI' }]) {
    const h = await harness(); mutate(h)
    const report = await h.run()
    assert.ok(report.errorCode)
    assert.equal(h.http(), 0)
  }
})

test('foreign call evidence never becomes additional allowance on the next run', async () => {
  const h = await harness(); await h.run()
  const before = h.http(); h.corruptBudgetOwner()
  const report = await h.run()
  assert.equal(report.errorCode, 'receipt_owner_mismatch')
  assert.equal(h.http(), before)
})

test('PostgreSQL JSONB object-key ordering does not invalidate exact semantic replay or window', async () => {
  const h = await harness(), search = h.runtime.service.search.bind(h.runtime.service)
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value
  h.runtime.service.search = async (...args) => {
    const result = await search(...args)
    return { ...result, body: result.replay ? reorder(result.body) : result.body }
  }
  assert.equal((await h.run()).errorCode, undefined)
  assert.equal((await h.run()).errorCode, undefined)
})

test('duplicate delivered identity and mismatched supplier evidence cannot claim acceptance', async () => {
  for (const corruptCalls of [false, true]) {
    const h = await harness(), search = h.runtime.service.search.bind(h.runtime.service)
    let firstId
    h.runtime.service.search = async (...args) => {
      const result = structuredClone(await search(...args))
      if (corruptCalls) for (const call of h.platformStore.calls.values()) call.endpointKey = 'unrelated-endpoint'
      else if (result.body.data.items[0]) {
        firstId ||= result.body.data.items[0].id
        result.body.data.items[0].id = firstId
      }
      return result
    }
    const report = await h.run()
    assert.equal(report.errorCode, corruptCalls ? 'provider_receipt_unverified' : 'duplicate_or_missing_item_identity')
    assert.equal(report.standardDeliveryVerified, undefined)
  }
})

const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('standard verification replays buffered deliveries when its internal identity lookup uses the real PostgreSQL mapper',
  { skip: !pgliteModule && 'Set MX_INSIGHT_TEST_PGLITE_MODULE to the local PGlite module' }, async t => {
    const { PGlite } = await import(pathToFileURL(pgliteModule).href)
    const db = new PGlite(); t.after(() => db.close())
    await db.exec(`CREATE TABLE usage_requests(id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,idempotency_key text,
      platform text,status text,fingerprint text,acquisition_request jsonb,response_status int,response_body jsonb);
      CREATE TABLE usage_idempotency_bindings(consumer_id uuid,idempotency_key text,current_request_id uuid);`)
    const h = await harness(), postgres = new PostgresStore(db)
    // All search/gateway state still belongs to the offline fixture. Only the
    // internal lookup crosses a real JSONB round-trip and production row mapper,
    // which is the boundary the earlier all-Memory acceptance test missed.
    h.store.getUsageRequestByIdempotencyKey = async (consumerId, key) => {
      await db.exec('TRUNCATE usage_requests,usage_idempotency_bindings')
      for (const row of h.store.requests.values()) {
        await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [row.id, row.tenantId, row.consumerId, row.apiKeyId, row.idempotencyKey, row.platform, row.status,
            row.fingerprint, JSON.stringify(row.acquisitionRequest), row.responseStatus, JSON.stringify(row.responseBody ?? null)])
      }
      for (const [scope, id] of h.store.requestsByScope) {
        const colon = scope.indexOf(':')
        await db.query('INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3)', [scope.slice(0, colon), scope.slice(colon + 1), id])
      }
      return postgres.getUsageRequestByIdempotencyKey(consumerId, key)
    }
    const first = await h.run()
    assert.equal(first.errorCode, undefined, JSON.stringify(first))
    assert.equal(first.standardDeliveryVerified, true)
    assert.equal(first.paginationVerified, true)
    assert.ok(first.versions.every(version => version.pages[1].bufferedContinuationVerified))
    const calls = h.http(), repeated = await h.run()
    assert.equal(repeated.errorCode, undefined, JSON.stringify(repeated))
    assert.equal(repeated.adapterCalls, 0)
    assert.equal(h.http(), calls)
  })

test('PostgreSQL budget query counts all historical attempts and validates both request and call ownership',
  { skip: !pgliteModule && 'Set MX_INSIGHT_TEST_PGLITE_MODULE to the local PGlite module' }, async t => {
    const { PGlite } = await import(pathToFileURL(pgliteModule).href)
    const db = new PGlite(); t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform;
      CREATE TABLE usage_requests(id text,tenant_id text,consumer_id text,api_key_id text,idempotency_key text);
      CREATE TABLE external_platform.provider_calls(id text,usage_request_id text,tenant_id text,consumer_id text,api_key_id text);`)
    const owner = { tenant_id: 'tenant', consumer_id: 'consumer', api_key_id: 'key' }
    assert.equal(await countSupplierCalls(db, owner), 0)
    for (const id of ['previous-released-attempt', 'current-attempt']) {
      await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5)', [id, 'tenant', 'consumer', 'key', KEYS[0]])
      await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$1,$2,$3,$4)', [id, 'tenant', 'consumer', 'key'])
    }
    assert.equal(await countSupplierCalls(db, owner), 2)
    await db.exec("UPDATE usage_requests SET api_key_id='foreign' WHERE id='previous-released-attempt'")
    await assert.rejects(countSupplierCalls(db, owner), error => error.code === 'receipt_owner_mismatch')
  })
