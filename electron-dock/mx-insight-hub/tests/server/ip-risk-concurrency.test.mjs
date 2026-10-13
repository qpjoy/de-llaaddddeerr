import test from 'node:test'
import assert from 'node:assert/strict'
import { IpSearchAdapter } from '../../server/adapters/ipsearch.mjs'
import { BaiduIpRiskAdapter } from '../../server/adapters/baidu-ip-risk.mjs'
import { IpRiskGateway } from '../../server/external-platforms/ip-risk-gateway.mjs'
import { IpRiskChannels } from '../../server/external-platforms/ip-risk-channels.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'

const payload = { code: 200, data: { risk: { proxy: '否', risk_score: 0, risk_level: '', mb_rate: '0%', real: '70%', risk_tag: [] } } }
const request = index => ({ body: { ip: `8.8.8.${index}` }, idempotencyKey: `ip-queue-test-${index}`, path: '/api/v1/data/ip/risk' })

async function occupiedGateway(t) {
  const ready = Promise.withResolvers(), release = Promise.withResolvers(), queued = Promise.withResolvers()
  const store = new MemoryStore()
  const hub = new HubService({ store, adapter: {}, apiKeyPepper: 'ip-risk-queue-test-pepper-at-least-32-characters' })
  const tenant = await hub.createTenant({ name: 'IP queue tenant' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'IP queue consumer' })
  await store.setPlatformGrant(consumer.id, 'ip_risk', true)
  await hub.putCapabilityConfiguration('ip.risk.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'Queue key', platforms: ['ip_risk'], capabilities: ['ip.risk.query'] })
  const context = await hub.authenticate(key.secret)
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'ipsearch', authorizationPlatform: 'ip_risk' })
  const calls = []
  const adapter = new IpSearchAdapter({ apiKey: 'test-key', fetchImpl: async (_url, options) => {
    calls.push(new URLSearchParams(options.body))
    if (calls.length === 3) ready.resolve()
    if (calls.length <= 3) await release.promise
    return Response.json(payload)
  } })
  const gateway = new IpRiskGateway({ usageStore: store, platformStore, adapter, enabled: true,
    concurrencyPolicy: { maxWaitMs: 1000, maxPending: 2 } })
  const originalEnter = gateway.concurrencyQueue.enter.bind(gateway.concurrencyQueue)
  gateway.concurrencyQueue.enter = input => { const result = originalEnter(input); queued.resolve(); return result }
  let rateAdmissions = 0
  const originalRate = platformStore.acquireProviderRateLimit.bind(platformStore)
  platformStore.acquireProviderRateLimit = input => { rateAdmissions++; assert.equal(input.limit, 60); return originalRate(input) }
  const active = [1, 2, 3].map(index => gateway.query(context, request(index)))
  t.after(async () => { release.resolve(); await Promise.all(active) })
  await ready.promise
  return { store, context, platformStore, adapter, gateway, calls, active, release: release.resolve,
    queued: queued.promise, rateAdmissions: () => rateAdmissions }
}

test('IP adapters declare the full original workflow budget including both Baidu waits and calls', () => {
  assert.equal(new IpSearchAdapter().dispatchBudgetMs, 15000)
  assert.equal(new IpSearchAdapter({ timeoutMs: 12000 }).dispatchBudgetMs, 12000)
  assert.equal(new BaiduIpRiskAdapter().dispatchBudgetMs, 40000)
  assert.equal(new BaiduIpRiskAdapter({ timeoutMs: 12000 }).dispatchBudgetMs, 44000)
})

test('fourth IP query waits for the existing three slots without consuming supplier capacity and replays once', async (t) => {
  const state = await occupiedGateway(t)
  const fourth = state.gateway.query(state.context, request(4))
  await state.queued
  assert.equal(state.gateway.active, 3)
  assert.equal(state.calls.length, 3)
  assert.equal(state.rateAdmissions(), 3)
  assert.equal(state.platformStore.leases.size, 3, 'the queued fourth request releases its dispatch lock')
  state.release()
  const result = await fourth
  await Promise.all(state.active)
  assert.equal(result.status, 200)
  assert.equal(state.calls.length, 4)
  assert.equal((await state.gateway.query(state.context, request(4))).replay, true)
  assert.equal(state.calls.length, 4)
  assert.equal(state.rateAdmissions(), 4)
  assert.equal(state.gateway.active, 0)
  assert.equal(state.platformStore.leases.size, 0)
})

test('IP queue full and cancellation failures retain request identities and never dispatch', async (t) => {
  const state = await occupiedGateway(t)
  state.gateway.concurrencyPolicy.maxPending = 1
  const controller = new AbortController()
  const pending = state.gateway.query(state.context, { ...request(4), signal: controller.signal }).catch(error => error)
  await state.queued
  await assert.rejects(state.gateway.query(state.context, request(5)), error => error.code === 'external_platform_busy'
    && error.details.reason === 'concurrency_queue_full' && error.details.platform === 'ip_risk'
    && error.details.upstreamDispatched === false && typeof error.details.requestId === 'string')
  controller.abort()
  const cancelled = await pending
  assert.equal(cancelled.code, 'request_cancelled')
  assert.equal(typeof cancelled.details.requestId, 'string')
  assert.equal(state.gateway.concurrencyQueue.entries.length, 0)
  assert.equal(state.gateway.active, 3)
  assert.equal(state.calls.length, 3)
  assert.equal(state.rateAdmissions(), 3)
  assert.equal([...state.store.requests.values()].filter(row => row.status === 'released').length, 2)
})

test('IP queue timeout releases the original reservation without attempting an upstream retry', async (t) => {
  const state = await occupiedGateway(t)
  state.gateway.concurrencyPolicy.maxWaitMs = 20
  await assert.rejects(state.gateway.query(state.context, request(4)), error => error.code === 'external_platform_busy'
    && error.details.reason === 'concurrency_queue_timeout')
  assert.equal(state.calls.length, 3)
  assert.equal(state.gateway.concurrencyQueue.entries.length, 0)
  assert.equal([...state.store.requests.values()].find(row => row.idempotencyKey === request(4).idempotencyKey).status, 'released')
})

test('IP queue refuses insufficient original lease time or an unknown dispatch budget', async (t) => {
  const state = await occupiedGateway(t)
  state.gateway.reservationLeaseMs = 20000
  await assert.rejects(state.gateway.query(state.context, request(4)), error => error.code === 'external_platform_busy'
    && error.details.reason === 'concurrency_queue_timeout')
  state.gateway.reservationLeaseMs = 60000
  state.adapter.timeoutMs = undefined
  await assert.rejects(state.gateway.query(state.context, request(5)), { code: 'ip_risk_unavailable' })
  assert.equal(state.calls.length, 3)
  assert.equal(state.rateAdmissions(), 3)
})

test('IP queue revalidates current identity, grants, plan, credential, channel and circuit', async (t) => {
  const cases = [
    { name: 'key revoked', code: 'capability_not_granted', change: state => { state.store.apiKeys.get(state.context.apiKey.id).status = 'revoked' } },
    { name: 'grant removed', code: 'capability_not_granted', change: state => state.store.grants.set(state.context.consumer.id, []) },
    { name: 'plan inactive', code: 'plan_assignment_unavailable', change: state => { state.store.consumerPlans.get(state.context.consumer.id).status = 'paused' } },
    { name: 'database credential cleared', code: 'ip_risk_unavailable', change: state => {
      state.gateway.credentialStore = { async readCredentialSnapshot() { return { source: 'database', apiKey: null } } }
    } },
    { name: 'channel paused', code: 'ip_risk_unavailable', change: state => { state.adapter.capabilities = async () => ({ ready: false }) } },
    { name: 'circuit opened', code: 'ip_risk_unavailable', change: state => { state.platformStore.providerState = async () => ({ circuitOpenUntil: new Date(Date.now() + 60000) }) } },
  ]
  for (const item of cases) await t.test(item.name, async subtest => {
    const state = await occupiedGateway(subtest)
    const pending = state.gateway.query(state.context, request(4)).catch(error => error)
    await state.queued
    item.change(state)
    state.release()
    assert.equal((await pending).code, item.code)
    await Promise.all(state.active)
    assert.equal(state.calls.length, 3)
    assert.equal(state.gateway.active, 0)
    assert.equal(state.platformStore.leases.size, 0)
  })
})

test('IP queue uses a rotated current credential after waiting and rechecks unknown dispatch protection', async (t) => {
  await t.test('rotation', async subtest => {
    const state = await occupiedGateway(subtest)
    const pending = state.gateway.query(state.context, request(4))
    await state.queued
    state.gateway.credentialStore = { async readCredentialSnapshot() { return { source: 'database', apiKey: 'rotated-test-key' } } }
    state.release()
    assert.equal((await pending).status, 200)
    assert.equal(state.calls[3].get('key'), 'rotated-test-key')
  })
  await t.test('unknown outcome', async subtest => {
    const state = await occupiedGateway(subtest)
    const pending = state.gateway.query(state.context, request(4)).catch(error => error)
    await state.queued
    state.platformStore.acquireDispatchLease = async () => ({ kind: 'blocked', reason: 'unknown' })
    state.release()
    assert.equal((await pending).code, 'ip_query_in_progress_or_unknown')
    assert.equal(state.calls.length, 3)
  })
})

test('IP batch cancellation removes queued children and preserves completed batch replay', async (t) => {
  const state = await occupiedGateway(t)
  const controller = new AbortController()
  const input = { body: { ips: ['8.8.8.4', '8.8.8.5'] }, idempotencyKey: 'ip-queued-batch-cancel', path: '/api/v1/data/ip/risk/batch', signal: controller.signal }
  const pending = state.gateway.batch.query(state.context, input)
  await state.queued
  controller.abort()
  const result = await pending
  assert.deepEqual(result.body.data.map(row => row.status), [499, 499])
  assert.equal(state.calls.length, 3)
  assert.equal((await state.gateway.batch.query(state.context, input)).replay, true)
  assert.equal(state.calls.length, 3)
})

test('IP batch and channel children receive their original batch deadline and cancellation signal', async (t) => {
  const state = await occupiedGateway(t)
  state.release()
  await Promise.all(state.active)
  const controller = new AbortController(), inputs = []
  state.gateway.execute = async (_context, input) => { inputs.push(input); return { status: 200, body: {} } }
  const start = Date.now()
  await state.gateway.batch.query(state.context, { body: { ips: ['8.8.8.4'] }, idempotencyKey: 'ip-budget-batch', path: '/api/v1/data/ip/risk/batch', signal: controller.signal })
  const channels = new IpRiskChannels(state.gateway, state.gateway)
  await channels.query(state.context, { body: { ip: '8.8.8.5', channels: ['legacy-v1'] }, idempotencyKey: 'ip-budget-channel', path: '/api/v1/data/ip/risk/channels', signal: controller.signal })
  assert.equal(inputs.length, 2)
  for (const input of inputs) {
    assert.equal(input.signal, controller.signal)
    assert.ok(input.dispatchDeadline >= start + 60000 && input.dispatchDeadline <= Date.now() + 60000)
  }
})
