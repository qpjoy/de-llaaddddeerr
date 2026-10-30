import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { JUSTONE_OPERATION } from '../../server/contracts/justone.mjs'
import {
  acquireSupplierRate, acquireTikHubRateLimit, bypassesSupplierLimits, isHubRateLimitExempt, isLcySupplierPriority,
} from '../../server/core/internal-traffic-policy.mjs'
import { ConcurrencyAdmissionQueue } from '../../server/external-platforms/concurrency-admission.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import {
  LCY_RESERVED_SHARE, RATE_LIMIT_RECOVERY_MS, acquirePacedProviderRate, adaptiveRateLimit, enterPriority, leavePriority,
  ordinaryCapacityBlocked, waitForPriorityCapacity,
} from '../../server/external-platforms/priority-admission.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { readKeyHubLimits, saveKeyHubLimits } from '../../server/stores/key-hub-limits.mjs'
import { LCY_IDENTITY, LcyHubLimitStore } from '../fixtures/lcy-hub-limit-store.mjs'

const lcy = (apiKey = {}) => ({ apiKey: { id: LCY_IDENTITY.key, hubRateLimitExempt: true, ...apiKey },
  tenant: { id: LCY_IDENTITY.tenant }, consumer: { id: LCY_IDENTITY.consumer } })
const ordinary = { apiKey: { id: '11111111-1111-4111-8111-111111111111', hubRateLimitExempt: null },
  tenant: { id: '22222222-2222-4222-8222-222222222222' }, consumer: { id: '33333333-3333-4333-8333-333333333333' } }
const nextTick = () => new Promise(resolve => setImmediate(resolve))

function gatewayDouble({ maxConcurrency = 4, maxWaitMs = 1_000, now = () => Date.now() } = {}) {
  return { active: 0, priorityActive: 0, activeByConsumer: new Map(), admissionClock: now,
    concurrencyQueue: new ConcurrencyAdmissionQueue({ clock: now }),
    config: { maxConcurrency, maxConsumerConcurrency: maxConcurrency, timeoutMs: 30_000,
      concurrencyQueue: { maxWaitMs, maxPending: 8 } } }
}

test('priority is opt-in on top of the explicit exemption and only for the original LCY identity', () => {
  assert.equal(isLcySupplierPriority(lcy({ hubSupplierAdmission: 'priority' })), true)
  assert.equal(bypassesSupplierLimits(lcy({ hubSupplierAdmission: 'priority' })), false)
  // The saved default keeps the original exemption exactly.
  for (const mode of [undefined, 'bypass']) {
    assert.equal(isLcySupplierPriority(lcy({ hubSupplierAdmission: mode })), false)
    assert.equal(bypassesSupplierLimits(lcy({ hubSupplierAdmission: mode })), true)
  }
  // Without the exemption a stored mode means nothing, and nobody else gets it.
  for (const context of [lcy({ hubRateLimitExempt: false, hubSupplierAdmission: 'priority' }),
    lcy({ hubRateLimitExempt: null, hubSupplierAdmission: 'priority' }),
    { ...ordinary, apiKey: { ...ordinary.apiKey, hubRateLimitExempt: true, hubSupplierAdmission: 'priority' } }]) {
    assert.equal(isLcySupplierPriority(context), false)
    assert.equal(bypassesSupplierLimits(context), false)
  }
  // Priority keeps every Hub quota, budget and circuit exemption.
  assert.equal(isHubRateLimitExempt(lcy({ hubSupplierAdmission: 'priority' })), true)
})

test('priority waiters are offered a slot before ordinary ones that queued first', async () => {
  const queue = new ConcurrencyAdmissionQueue()
  let free = 0
  const admitted = []
  const enter = (id, priority) => queue.enter({ maxPending: 4, deadline: Date.now() + 1_000, priority,
    tryEnter() { if (!free) return false; free--; admitted.push(id); return true } })
  const first = enter('ordinary', false), second = enter('priority', true)
  assert.equal(queue.priorityWaiting(), 1)
  free = 1; queue.drain(); await second
  assert.deepEqual(admitted, ['priority'])
  assert.equal(queue.priorityWaiting(), 0)
  free = 1; queue.drain(); await first
  assert.deepEqual(admitted, ['priority', 'ordinary'])
})

test('other Keys keep the unreserved share while priority work runs, and everything while it is idle', () => {
  const gateway = gatewayDouble()
  assert.equal(ordinaryCapacityBlocked(gateway, 10), false, 'idle priority reserves nothing')
  assert.equal(enterPriority(gateway, LCY_IDENTITY.consumer, 10), 'priority')
  const ordinaryShare = Math.floor(10 * (1 - LCY_RESERVED_SHARE))
  gateway.active += ordinaryShare - 1
  assert.equal(ordinaryCapacityBlocked(gateway, 10), false)
  gateway.active += 1
  assert.equal(ordinaryCapacityBlocked(gateway, 10), true, 'the 80% reserve is kept for priority work')
  // A small per-process pool has no ordinary share while priority work runs.
  assert.equal(ordinaryCapacityBlocked({ ...gatewayDouble(), active: 1, priorityActive: 1 }, 4), true)
  leavePriority(gateway, 'priority')
  assert.equal(gateway.priorityActive, 0)
  leavePriority(gateway, true)
  assert.equal(gateway.priorityActive, 0, 'ordinary admissions never touch the priority count')
  // Priority itself never exceeds the gateway total.
  const full = gatewayDouble(); full.active = 4
  assert.equal(enterPriority(full, LCY_IDENTITY.consumer, 4), false)
})

test('a priority request waits within its deadline, keeps no slot when revalidation fails, and reports a retryable Hub wait', async () => {
  const gateway = gatewayDouble({ maxWaitMs: 1_000 })
  const enter = () => enterPriority(gateway, LCY_IDENTITY.consumer, 1)
  const leave = admission => { leavePriority(gateway, admission); gateway.active -= 1 }
  const expiresAt = new Date(Date.now() + 60_000)
  assert.equal(await waitForPriorityCapacity(gateway, { enter, leave, expiresAt }), 'priority')

  const waiting = waitForPriorityCapacity(gateway, { enter, leave, expiresAt })
  await nextTick()
  assert.equal(gateway.concurrencyQueue.priorityWaiting(), 1)
  leave('priority'); gateway.concurrencyQueue.drain()
  assert.equal(await waiting, 'priority')
  assert.equal(gateway.active, 1)

  const revoked = waitForPriorityCapacity(gateway, { enter, leave, expiresAt,
    revalidate: async () => { throw Object.assign(new Error('revoked'), { code: 'capability_not_granted' }) } })
  await nextTick()
  leave('priority'); gateway.concurrencyQueue.drain()
  await assert.rejects(revoked, { code: 'capability_not_granted' })
  assert.equal(gateway.active, 0, 'a failed revalidation returns its slot')

  gateway.active = 1
  await assert.rejects(waitForPriorityCapacity(gatewayDouble({ maxWaitMs: 20 }), {
    enter: () => false, leave, expiresAt }), error => {
    assert.equal(error.status, 429)
    assert.equal(error.code, 'external_platform_busy')
    assert.deepEqual([error.details.layer, error.details.upstreamDispatched, error.details.admissionMode,
      error.details.reason], ['hub', false, 'priority', 'concurrency_queue_timeout'])
    return true
  })
  // The request's own end, minus one upstream timeout, bounds the wait too.
  await assert.rejects(waitForPriorityCapacity(gatewayDouble({ maxWaitMs: 60_000 }), {
    enter: () => false, leave, expiresAt: new Date(Date.now() + 35_010) }), { code: 'external_platform_busy' })
  const cancel = new AbortController()
  const cancelled = waitForPriorityCapacity(gatewayDouble(), { enter: () => false, leave, expiresAt, signal: cancel.signal })
  cancel.abort()
  await assert.rejects(cancelled, { code: 'request_cancelled' })
})

test('after a supplier rate refusal priority pacing halves the RPM, then recovers within a minute', () => {
  const refused = at => ({ lastErrorCode: 'upstream_rate_limited', lastFailureAt: new Date(at).toISOString() })
  const now = Date.parse('2026-10-31T08:00:00Z')
  assert.equal(adaptiveRateLimit(120, null, now), 120)
  assert.equal(adaptiveRateLimit(120, { lastErrorCode: 'upstream_balance_exhausted', lastFailureAt: new Date(now).toISOString() }, now), 120)
  assert.equal(adaptiveRateLimit(120, refused(now), now), 60)
  assert.equal(adaptiveRateLimit(120, refused(now - RATE_LIMIT_RECOVERY_MS / 2), now), 90)
  assert.equal(adaptiveRateLimit(120, refused(now - RATE_LIMIT_RECOVERY_MS), now), 120)
  assert.equal(adaptiveRateLimit(120, refused(now + 5_000), now), 60, 'clock skew counts as just refused')
  assert.equal(adaptiveRateLimit(1, refused(now), now), 1)
})

test('paced RPM waits for tokens until its deadline and reads provider state only when pacing', async () => {
  let clock = 0
  const asked = []
  const store = { acquireProviderRateLimit: async input => {
    asked.push(input)
    return asked.length < 3 ? { allowed: false, retryAfterMs: 400 } : { allowed: true, retryAfterMs: 0 }
  } }
  const wait = async ms => { clock += ms }
  const allowed = await acquirePacedProviderRate(store, { limit: 50, windowMs: 60_000, deadline: 10_000,
    providerState: async () => ({ lastErrorCode: 'upstream_rate_limited', lastFailureAt: new Date(0).toISOString() }) },
  { clock: () => clock, wait })
  assert.equal(allowed.allowed, true)
  assert.equal(clock, 800)
  assert.deepEqual(asked.map(input => input.limit), [25, 25, 25])

  asked.length = 0; clock = 0
  const refused = await acquirePacedProviderRate(store, { limit: 50, deadline: 300 }, { clock: () => clock, wait })
  assert.deepEqual([refused.allowed, refused.retryAfterMs, asked.length, clock], [false, 400, 1, 0])
  asked.length = 0
  assert.equal((await acquirePacedProviderRate(store, { limit: 50 }, { clock: () => clock, wait })).allowed, false)
  assert.equal(asked.length, 1, 'without a deadline it is a single attempt')
  // An atomic multi-call workflow is never paced below its own token count.
  asked.length = 0
  await acquirePacedProviderRate({ acquireProviderRateLimit: async input => { asked.push(input); return { allowed: true } } },
    { limit: 4, tokens: 3, providerState: { lastErrorCode: 'upstream_rate_limited', lastFailureAt: new Date().toISOString() } })
  assert.deepEqual([asked[0].limit, asked[0].tokens], [3, 3])
})

test('supplier RPM: bypass skips it, priority waits for it, everyone else keeps one attempt', async () => {
  const calls = []
  const store = { acquireProviderRateLimit: async input => { calls.push(input); return { allowed: calls.length > 1, retryAfterMs: 1 } } }
  assert.deepEqual(await acquireSupplierRate(lcy(), store, { limit: 10 }), { allowed: true, retryAfterMs: 0 })
  assert.deepEqual(await acquireSupplierRate(ordinary, store, { limit: 10, bypass: true }), { allowed: true, retryAfterMs: 0 })
  assert.equal(calls.length, 0)
  assert.equal((await acquireSupplierRate(ordinary, store, { limit: 10, deadline: Date.now() + 60_000 })).allowed, false)
  assert.deepEqual(calls[0], { limit: 10, windowMs: 60_000 })
  const paced = await acquireSupplierRate(lcy({ hubSupplierAdmission: 'priority' }), store,
    { limit: 10, bypass: true, deadline: Date.now() + 60_000 })
  assert.equal(paced.allowed, true, 'priority ignores the internal-traffic bypass and waits')
  // TikHub's internal-traffic exemption no longer skips RPM for priority LCY.
  const tikhub = []
  const usage = { internalTrafficPolicy: null }
  const lcyManaged = lcy({ accessProfile: 'managed_full' })
  assert.equal((await acquireTikHubRateLimit(usage, lcyManaged, { acquireProviderRateLimit: async input => { tikhub.push(input); return { allowed: true } } },
    { limit: 5, windowMs: 60_000 })).allowed, true)
  assert.equal(tikhub.length, 0)
  await acquireTikHubRateLimit(usage, { ...lcyManaged, apiKey: { ...lcyManaged.apiKey, hubSupplierAdmission: 'priority' } },
    { acquireProviderRateLimit: async input => { tikhub.push(input); return { allowed: true } } }, { limit: 5, windowMs: 60_000 })
  assert.deepEqual(tikhub.map(input => input.limit), [5])
})

async function lcyStore() {
  const store = new LcyHubLimitStore(true)
  const hub = new HubService({ store, adapter: {}, apiKeyPepper: 'lcy-supplier-priority-pepper-entropy' })
  const tenant = await hub.createTenant({ name: 'LCY' })
  const consumer = await hub.createConsumer({ tenantId: tenant.id, name: 'LCY-delta' })
  await store.setPlatformGrant(consumer.id, 'ecommerce', true)
  await hub.putCapabilityConfiguration(JUSTONE_OPERATION, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'ecommerce', maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 })
  const key = await hub.createApiKey({ consumerId: consumer.id, name: 'LCY-delta', platforms: ['ecommerce'], capabilities: [JUSTONE_OPERATION] })
  Object.assign(store.apiKeys.get(LCY_IDENTITY.key), { environment: 'live',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
  return { store, hub, tenant, consumer, key }
}

test('the switch saves the supplier mode with CAS and audit, and older clients keep the stored mode', async () => {
  const { store } = await lcyStore()
  const requestId = () => crypto.randomUUID()
  const initial = await readKeyHubLimits(store, LCY_IDENTITY.key)
  assert.deepEqual([initial.hubSupplierAdmission, initial.effectiveSupplierPriority, initial.policyVersion], ['bypass', false, 2])
  const saved = await saveKeyHubLimits(store, LCY_IDENTITY.key, { hubRateLimitExempt: true, hubSupplierAdmission: 'priority',
    revision: initial.revision, reason: '优先排队' }, { actor: 'admin-token', requestId: requestId() })
  assert.deepEqual([saved.hubSupplierAdmission, saved.effectiveSupplierPriority, saved.effectiveExempt], ['priority', true, true])
  // A client that only knows the exemption leaves the mode as stored.
  const legacy = await saveKeyHubLimits(store, LCY_IDENTITY.key, { hubRateLimitExempt: true, revision: saved.revision,
    reason: '旧版界面保存' }, { actor: 'admin-token', requestId: requestId() })
  assert.equal(legacy.hubSupplierAdmission, 'priority')
  // Turning the exemption off makes the stored mode inert, not lost.
  const off = await saveKeyHubLimits(store, LCY_IDENTITY.key, { hubRateLimitExempt: false, revision: legacy.revision,
    reason: '恢复普通限制' }, { actor: 'admin-token', requestId: requestId() })
  assert.deepEqual([off.hubSupplierAdmission, off.effectiveSupplierPriority, off.effectiveExempt], ['priority', false, false])
  assert.deepEqual(store.keyHubLimitEvents.map(event => [event.previousSupplierAdmission, event.nextSupplierAdmission]),
    [['bypass', 'priority'], ['priority', 'priority'], ['priority', 'priority']])
  for (const hubSupplierAdmission of ['fast', true, null]) {
    await assert.rejects(saveKeyHubLimits(store, LCY_IDENTITY.key, { hubRateLimitExempt: true, hubSupplierAdmission,
      revision: off.revision, reason: '非法模式' }, { actor: 'admin-token', requestId: requestId() }), { code: 'invalid_key_hub_limits' })
  }
  // Authentication carries the stored mode into request context.
  assert.equal(store.apiKeys.get(LCY_IDENTITY.key).hubSupplierAdmission, 'priority')
})

const json = (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } })
const business = code => json({ code, message: 'private-provider-message', data: null, recordTime: '2026-10-31T08:00:00Z' })
const product = JSON.parse(await readFile(new URL('../fixtures/justone/taobao-product-search-v1.success.json', import.meta.url), 'utf8'))

async function ecommerce(mode, responses) {
  const { store, hub, key } = await lcyStore()
  Object.assign(store.apiKeys.get(LCY_IDENTITY.key), { hubSupplierAdmission: mode })
  const context = await hub.authenticate(key.secret)
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, circuitFailureThreshold: 3 })
  const rates = []
  const acquire = platformStore.acquireProviderRateLimit.bind(platformStore)
  platformStore.acquireProviderRateLimit = async input => { rates.push(input.limit); return acquire(input) }
  const seen = []
  const adapter = new JustOneAdapter({ token: 'justone-secret-token',
    fetchImpl: async url => { seen.push(String(url)); return responses.shift()() } })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, providerKey: 'justone',
    apiKeyPepper: 'lcy-supplier-priority-pepper-entropy', reservationLeaseMs: 150_000, logger: { warn() {}, error() {} },
    config: { token: 'configured', configured: true, contractVerified: true, dispatchEnabled: true, configurationError: null,
      timeoutMs: 30_000, freshTtlMs: 60_000, staleTtlMs: 86_400_000, maxConcurrency: 32, maxConsumerConcurrency: 8,
      maxRequestsPerMinute: 50, circuitFailureThreshold: 3, circuitOpenMs: 60_000,
      billing: { source: 'manual', currency: 'CNY', pricingAsOf: '2026-10-01T00:00:00.000Z', freeDailyCalls: null,
        monthlyBudgetMinor: 10_000, monthlySubsidyBudgetMinor: 10_000, unitCostMinorByEndpoint: { 'taobao-tmall.product-search.v1': 15 } } } })
  const search = idempotencyKey => gateway.search(context, { idempotencyKey, path: '/api/v1/data/ecommerce/products/search',
    body: { marketplace: 'taobao', query: '始祖鸟', deliveryMode: 'live_only' } })
  return { store, platformStore, gateway, rates, seen, search }
}

test('priority LCY retries an unbilled JustOne rate refusal once in the same request, paced and counted', async () => {
  const state = await ecommerce('priority', [() => business(302), () => json(product)])
  const result = await state.search('priority-rate-retry-0001')
  assert.equal(result.status, 200)
  assert.ok(result.body.data.items.length > 0)
  const calls = [...state.platformStore.calls.values()]
  assert.deepEqual(calls.map(call => [call.outcome, call.billed, call.callOrdinal]), [['rejected', false, 0], ['succeeded', true, 1]])
  assert.equal(new Set(calls.map(call => call.usageRequestId)).size, 1, 'one customer request, one charge')
  assert.equal(state.seen.length, 2)
  // Both dispatches took RPM tokens; the retry was paced below the configured 50.
  assert.equal(state.rates.length, 2)
  assert.equal(state.rates[0], 50)
  assert.ok(state.rates[1] < 50)
  assert.deepEqual([state.gateway.active, state.gateway.priorityActive], [0, 0])
  assert.equal(state.platformStore.leases.size, 0)
})

test('bypass mode, a second refusal and a non-rate refusal keep their error without another purchase', async () => {
  const bypass = await ecommerce('bypass', [() => business(302)])
  await assert.rejects(bypass.search('bypass-rate-0001'), { status: 429 })
  assert.deepEqual([bypass.seen.length, bypass.rates.length], [1, 0], 'the original exemption neither retries nor takes RPM')

  const twice = await ecommerce('priority', [() => business(302), () => business(302)])
  await assert.rejects(twice.search('priority-rate-twice-0001'), { status: 429 })
  assert.equal(twice.seen.length, 2, 'retried once only')

  const balance = await ecommerce('priority', [() => business(601)])
  await assert.rejects(balance.search('priority-balance-0001'), { status: 503 })
  assert.equal(balance.seen.length, 1, 'only rate refusals are retried')
})
