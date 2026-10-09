import test from 'node:test'
import assert from 'node:assert/strict'
import { enrichWeiboRawSearch } from '../../server/external-platforms/raw-search-enrichment.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { createInternalTrafficPolicy } from '../../server/core/internal-traffic-policy.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { weiboRow } from '../../server/contracts/raw-search.mjs'

async function fixture({ count = 1, rpm = 50, internal = false, remainingMs = 120000 } = {}) {
  const start = Date.parse('2026-10-09T07:02:54.265Z')
  let now = start, serial = 0
  const calls = [], receipts = [], waits = [], logs = [], holds = new Set(), leases = new Set()
  const bucket = new MemoryExternalPlatformStore({ providerKey: 'tikhub', rateLimitBurst: 1 })
  const take = options => bucket.acquireProviderRateLimit({ ...options, at: new Date(now) })
  await take({ limit: rpm }) // The just-completed search spent the burst token.
  const context = { tenant: { id: 'tenant' }, consumer: { id: 'consumer' }, apiKey: { id: 'key' } }
  const rows = Array.from({ length: count }, (_, i) => weiboRow({ weibo_id: String(5352046656226431 + i),
    user_id: '7851053384', content: '正文摘要 展开c' }, new Date(now).toISOString()))
  const result = { items: rows, publicBody: { data: { meta: {} } } }
  const gateway = { providerKey: 'tikhub', config: { timeoutMs: 1000, maxRequestsPerMinute: rpm },
    usageStore: { internalTrafficPolicy: createInternalTrafficPolicy({ keyIds: internal ? ['key'] : [] }) },
    logger: { warn(value) { logs.push(JSON.parse(value)) } },
    operationControlStore: { async authorizeDispatch() { return { billing: {} } } },
    platformStore: {
      async providerState() { return null },
      async acquireDispatchLease(input) { leases.add(input.fingerprint); return { kind: 'acquired' } },
      async releaseDispatchLease(input) { leases.delete(input.fingerprint) },
      async reserveProviderCostWorkflow() { const id = `hold-${++serial}`; holds.add(id); return { id } },
      async releaseProviderCostWorkflow(input) { holds.delete(input.reservationId) },
      acquireProviderRateLimit: take,
      async beginProviderCall(input) { const call = { ...input, id: `call-${calls.length}` }; calls.push(call); return call },
      async finishProviderStep(input) { receipts.push(input) },
    },
    adapter: { async forwardNative(key, body) { return { publicBody: {
      data: { idstr: body.params.id, user: { idstr: '7851053384' }, isLongText: true,
        longText: { content: `完整正文 ${body.params.id}` } }, meta: { capturedAt: new Date(now).toISOString() } } } } },
  }
  const runtime = { clock: () => now, async wait(ms) {
    assert.equal(holds.size, 0, 'waiting must not retain a procurement hold')
    assert.equal(leases.size, 0, 'waiting must not retain a dispatch lease')
    waits.push(ms); now += ms
  } }
  const run = () => enrichWeiboRawSearch({ gateway, context, result,
    request: { enrichment: { enabled: true, all: false, maxItems: count } },
    delivery: { usageRequestId: 'request', fingerprint: 'parent' }, credential: {}, credentialRevision: 1,
    providerCostControl: () => ({ costMinor: 12, currency: 'USD', costKind: 'estimated' }),
    deadlineAt: start + remainingMs,
  }, runtime)
  return { gateway, result, run, calls, receipts, waits, logs, holds, leases, runtime, start,
    advance(ms) { now += ms } }
}

test('Weibo waits for the real one-token bucket, filling multiple previews once each', async () => {
  const h = await fixture({ count: 3 })
  const result = await h.run()
  assert.equal(result.publicBody.data.status, 'ok')
  assert.deepEqual(h.waits, [1200, 1200, 1200])
  assert.equal(h.calls.length, 3)
  assert.equal(new Set(h.calls.map(call => call.dispatchFingerprint)).size, 3)
  assert.deepEqual(h.calls.map(call => call.callOrdinal), [2, 3, 4])
  assert.equal(h.receipts.length, 3)
  assert.ok(h.receipts.every(receipt => receipt.billed === true))
  assert.ok(result.items.every(row => row.full_text?.startsWith('完整正文') && row.summary === '正文摘要 展开c'))
  assert.equal(h.holds.size, 0)
  assert.equal(h.leases.size, 0)
})

test('internal callers bypass the local bucket but wait out the existing 10-second rate circuit', async () => {
  const h = await fixture({ internal: true })
  const state = Object.freeze({ lastErrorCode: 'upstream_rate_limited',
    lastFailureAt: new Date(h.start - 1000).toISOString(), circuitOpenUntil: new Date(h.start + 59000).toISOString() })
  h.gateway.platformStore.providerState = async () => state
  h.gateway.platformStore.acquireProviderRateLimit = () => assert.fail('internal caller must not consume the bucket')
  assert.equal((await h.run()).publicBody.data.status, 'ok')
  assert.deepEqual(h.waits, [5000, 4000])
  assert.equal(h.calls.length, 1)
  assert.equal(Date.parse(state.circuitOpenUntil), h.start + 59000)
})

test('ordinary callers wait for the full rate cooldown; other faults stay blocked', async () => {
  for (const error of ['upstream_rate_limited', 'upstream_authentication_failed']) {
    const h = await fixture()
    h.gateway.platformStore.providerState = async () => ({ lastErrorCode: error,
      lastFailureAt: new Date(h.start - 1000).toISOString(), circuitOpenUntil: new Date(h.start + 59000).toISOString() })
    const result = await h.run()
    assert.equal(result.publicBody.data.status, error === 'upstream_rate_limited' ? 'ok' : 'partial')
    assert.equal(h.waits.reduce((a, b) => a + b, 0), error === 'upstream_rate_limited' ? 59000 : 0)
    assert.equal(h.calls.length, error === 'upstream_rate_limited' ? 1 : 0)
  }
})

test('waiting rechecks operation and budget, and does not consume calls when either is withdrawn', async () => {
  for (const [target, method, code, reason] of [
    ['operationControlStore', 'authorizeDispatch', 'external_platform_operation_paused', 'operation_unavailable'],
    ['platformStore', 'reserveProviderCostWorkflow', 'external_platform_cost_budget_exhausted', 'cost_unavailable'],
  ]) {
    const h = await fixture()
    const wait = h.runtime.wait
    h.runtime.wait = async ms => {
      await wait(ms)
      h.gateway[target][method] = async () => { throw new AppError(503, code, 'private administrative reason') }
    }
    assert.equal((await h.run()).publicBody.data.status, 'partial')
    assert.equal(h.calls.length, 0)
    assert.equal(h.logs[0].skipped[0].reason, reason)
    assert.equal(h.logs[0].admissionWaitMs, 1200)
    assert.doesNotMatch(JSON.stringify(h.logs), /private administrative reason|正文/)
    assert.equal(h.holds.size, 0)
    assert.equal(h.leases.size, 0)
  }
})

test('Weibo preserves dispatch time and bounds cumulative admission waits to 60 seconds', async () => {
  const short = await fixture({ remainingMs: 7000 })
  assert.equal((await short.run()).publicBody.data.status, 'partial')
  assert.equal(short.calls.length, 0)
  assert.deepEqual(short.waits, [])
  const slow = await fixture({ count: 4, rpm: 3, remainingMs: 180000 })
  assert.equal((await slow.run()).publicBody.data.status, 'partial')
  assert.equal(slow.calls.length, 3)
  assert.equal(slow.waits.reduce((a, b) => a + b, 0), 60000)
  assert.equal(slow.logs[0].admissionWaitMs, 60000)
  assert.equal(slow.logs[0].skipped[0].postId, slow.result.items[3].content_id)
  const delayed = await fixture({ remainingMs: 8000 })
  const wait = delayed.runtime.wait
  delayed.runtime.wait = async ms => { await wait(ms); delayed.advance(2000) }
  await delayed.run()
  assert.equal(delayed.calls.length, 0)
  assert.equal(delayed.logs[0].skipped[0].reason, 'deadline')
})

test('circuit extension and unsafe dispatch leases are rechecked after a local wait', async () => {
  for (const block of ['circuit', 'lease']) {
    const h = await fixture()
    const wait = h.runtime.wait
    h.runtime.wait = async ms => {
      await wait(ms)
      if (block === 'circuit') h.gateway.platformStore.providerState = async () => ({
        lastErrorCode: 'upstream_rate_limited', circuitOpenUntil: new Date(h.start + 120000).toISOString() })
      else h.gateway.platformStore.acquireDispatchLease = async () => ({ kind: 'blocked', reason: 'unknown' })
    }
    await h.run()
    assert.equal(h.calls.length, 0)
    assert.equal(h.logs[0].skipped[0].reason, block === 'circuit' ? 'provider_circuit_open' : 'dispatch_lease_unavailable')
    assert.equal(h.holds.size, 0)
    assert.equal(h.leases.size, 0)
  }
})

test('waiting never retries an already sent detail, including rate rejection and unknown outcomes', async () => {
  for (const [outcome, httpStatus] of [['rejected', 429], ['unknown', null]]) {
    const h = await fixture()
    let dispatched = 0
    h.gateway.adapter.forwardNative = async () => {
      dispatched++
      throw new TikHubUpstreamError('upstream failure', { outcome, httpStatus, billed: null,
        errorCode: httpStatus === 429 ? 'upstream_rate_limited' : 'upstream_transport_error' })
    }
    assert.equal((await h.run()).publicBody.data.status, 'partial')
    assert.equal(dispatched, 1)
    assert.equal(h.calls.length, 1)
    assert.equal(h.receipts.length, 1)
    assert.equal(h.receipts[0].billed, null)
    assert.deepEqual(h.waits, [1200])
  }
})
