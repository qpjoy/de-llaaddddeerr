import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { LcyHubLimitStore } from '../fixtures/lcy-hub-limit-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { IpRiskGateway } from '../../server/external-platforms/ip-risk-gateway.mjs'
import { IpSearchAdapter } from '../../server/adapters/ipsearch.mjs'
import { BaiduIpRiskAdapter } from '../../server/adapters/baidu-ip-risk.mjs'

const success = { code: 200, data: { risk: { proxy: '否', risk_score: 0, risk_level: '', mb_rate: '0%', real: '70%', risk_tag: [] } } }
const input = n => ({ body: { ip: `8.8.8.${n}` }, idempotencyKey: `lcy-ip-limit-${n}`, path: '/api/v1/data/ip/risk' })
async function fixture(fetchImpl) {
  const store = new LcyHubLimitStore()
  const hub = new HubService({ store, adapter: {}, apiKeyPepper: 'lcy-ip-limit-test-pepper-at-least-32-characters' })
  const tenant = await hub.createTenant({ name: 'Synthetic tenant' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'Synthetic consumer' })
  await store.setPlatformGrant(consumer.id, 'ip_risk', true)
  await hub.putCapabilityConfiguration('ip.risk.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'Synthetic key', platforms: ['ip_risk'], capabilities: ['ip.risk.query'] })
  const context = await hub.authenticate(key.secret)
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'ipsearch', authorizationPlatform: 'ip_risk' })
  const adapter = new IpSearchAdapter({ apiKey: 'synthetic-upstream-key', fetchImpl })
  const gateway = new IpRiskGateway({ usageStore: store, platformStore, adapter, enabled: true,
    config: { maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 60 },
    concurrencyPolicy: { maxWaitMs: 1, maxPending: 1 } })
  return { store, hub, key, context, platformStore, gateway }
}

test('LCY IP exemption skips occupied capacity and local rate, preserves counters, and explicit off restores both', async () => {
  let calls = 0, rates = 0
  const f = await fixture(async () => { calls++; return Response.json(success) })
  f.gateway.active = 3
  f.platformStore.acquireProviderRateLimit = async () => { rates++; return { allowed: false } }
  assert.equal((await f.gateway.query(f.context, input(1))).status, 200)
  assert.equal(calls, 1)
  assert.equal(rates, 0)
  assert.equal(f.gateway.active, 3, 'exempt completion cannot release ordinary capacity')
  assert.equal(f.gateway.concurrencyQueue.entries.length, 0)
  f.store.apiKeys.get(f.key.id).hubRateLimitExempt = false
  const ordinary = await f.hub.authenticate(f.key.secret)
  await assert.rejects(f.gateway.query(ordinary, input(2)), { code: 'external_platform_busy' })
  f.gateway.active = 0
  await assert.rejects(f.gateway.query(ordinary, input(3)), { code: 'ip_query_rate_limited' })
  assert.equal(calls, 1)
  assert.equal(rates, 1)
  assert.equal(f.gateway.active, 0)
})

test('IP requests preserve public HTTP compatibility while exposing upstream 429 and unknown-result protection', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return Response.json({ code: 429 }, { status: 429 }) })
  const result = await f.gateway.query(f.context, input(1))
  assert.equal(result.status, 502, 'existing public IP error status remains stable')
  assert.equal(result.body.error.details.layer, 'upstream')
  assert.equal(result.body.error.details.upstreamStatus, 429)
  assert.equal(result.body.error.details.upstreamDispatched, true)
  assert.equal(result.body.error.details.retryable, false)
  assert.equal(calls, 1)
  f.store.apiKeys.get(f.key.id).hubRateLimitExempt = false
  const ordinary = await f.hub.authenticate(f.key.secret)
  const ordinaryResult = await f.gateway.query(ordinary, input(2))
  assert.equal(ordinaryResult.status, 502)
  assert.equal(ordinaryResult.body.error.details.upstreamStatus, 429)
  assert.equal(calls, 2, 'each caller request dispatches once, without automatic retries')
  const unknown = await fixture(async () => { throw new Error('synthetic transport outcome unknown') })
  assert.equal((await unknown.gateway.query(unknown.context, input(2))).status, 502)
  await assert.rejects(unknown.gateway.query(unknown.context, input(2)), { code: 'request_unknown' })
  assert.equal(unknown.platformStore.calls.size, 1)
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('Baidu exempt dispatch preserves actual call evidence and ordinary channel limits, while pause stays authoritative', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA hub_commerce;
    CREATE TABLE hub_commerce.ip_channel(id text PRIMARY KEY,enabled boolean,daily_limit integer,
      spacing_ms integer,tokens numeric,refill_at timestamptz,day date,calls integer,next_at timestamptz,
      cooldown_until timestamptz,last_status text,last_observed_at timestamptz);
    CREATE TABLE hub_commerce.ip_upstream_calls(id uuid PRIMARY KEY,request_id uuid,endpoint text,
      status integer,body bytea,outcome text DEFAULT 'unknown',completed_at timestamptz);
    INSERT INTO hub_commerce.ip_channel VALUES('baidu-v2',true,1200,2000,0,now(),
      (now() AT TIME ZONE 'Asia/Shanghai')::date,1200,now()+interval '1 minute',now()+interval '30 minutes',null,null);`)
  const query = (...args) => db.query(...args)
  const pool = { query, async connect() { return { query, release() {} } } }
  let calls = 0
  const adapter = new BaiduIpRiskAdapter({ pool, sleep: () => assert.fail('exempt request must not wait'),
    fetchImpl: async () => { calls++; return Response.json({ ret_data: { code: 601 } }, { status: 429 }) } })
  assert.equal((await adapter.capabilities()).ready, false)
  assert.equal((await adapter.capabilities({ hubRateLimitExempt: true })).ready, true)
  await assert.rejects(adapter.claim(randomUUID(), 'base'), { code: 'ip_channel_cooling' })
  const before = (await db.query('SELECT * FROM hub_commerce.ip_channel')).rows[0]
  const result = await adapter.query('8.8.8.8', { requestId: randomUUID(), hubRateLimitExempt: true })
  assert.equal(result.httpStatus, 429)
  assert.equal(result.outcome, 'rejected')
  assert.equal(result.errorCode, 'ip_channel_rate_limited')
  assert.equal(calls, 1, 'actual upstream refusal cannot automatically retry or fetch the second component')
  const after = (await db.query('SELECT * FROM hub_commerce.ip_channel')).rows[0]
  assert.equal(after.calls, 1201)
  assert.equal(after.last_status, 'rate_limited')
  assert.deepEqual(after.next_at, before.next_at, 'exempt request cannot move ordinary scheduling')
  assert.ok(new Date(after.cooldown_until) >= new Date(before.cooldown_until))
  const evidence = (await db.query('SELECT * FROM hub_commerce.ip_upstream_calls')).rows
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].status, 429)
  assert.equal(evidence[0].outcome, 'rejected')
  await db.exec("UPDATE hub_commerce.ip_channel SET enabled=false WHERE id='baidu-v2'")
  assert.equal((await adapter.capabilities({ hubRateLimitExempt: true })).ready, false)
  await assert.rejects(adapter.claim(randomUUID(), 'base', { hubRateLimitExempt: true }), { code: 'ip_channel_paused' })
})
