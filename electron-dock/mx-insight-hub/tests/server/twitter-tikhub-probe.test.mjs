import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { REVISION, ORIGINAL_REQUEST_ID, PROXY_RECEIPT, QUERY, NATIVE_KEY, NATIVE_PATH, IDEMPOTENCY_KEY, PROTOCOL_KEYS,
  runTwitterTikHubProbe, inspectTikHubReadiness, oneShotTikHubAdapter } from '../../server/ops/verify-twitter-tikhub.mjs'
import { PROXY_CASES } from '../../server/ops/verify-twitter-query-param.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { MemoryExternalPlatformCredentialStore } from '../../server/external-platforms/credentials-store.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'

const ORIGINAL_QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") AND NOT ("广告" OR "营销" OR "重复搬运") AND (("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost)'
const SECRET = 'offline-tikhub-secret-must-not-appear'
const POST = 'private acquired text must not appear'
const CURSOR = 'private-opaque-cursor-do-not-follow'
const PEPPER = 'offline-tikhub-probe-pepper-long-enough'
const SHA = value => createHash('sha256').update(value).digest('hex')

async function fixture({ grant = true, platformGrant = true, credential = true, enabled = true, outcome = 'success',
  postDispatchLookupFailure = false, protocolFinishFailure = false } = {}) {
  const endpoint = nativeForwardingEndpoint(NATIVE_KEY)
  const usage = new MemoryStore(), service = new HubService({ store: usage, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Offline TikHub probe' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Offline original caller' })
  await usage.setPlatformGrant(consumer.id, endpoint.authorizationPlatform, true)
  await usage.setPlatformGrant(consumer.id, 'twitter', true)
  await service.putCapabilityConfiguration(endpoint.operation, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Offline key',
    platforms: [endpoint.authorizationPlatform, 'twitter'], capabilities: grant ? [endpoint.operation] : [] })
  const context = await service.authenticate(key.secret)
  if (!platformGrant) await usage.setPlatformGrant(consumer.id, endpoint.authorizationPlatform, false)
  const original = { id: ORIGINAL_REQUEST_ID, tenant_id: tenant.id, consumer_id: consumer.id, api_key_id: context.apiKey.id,
    platform: 'twitter', status: 'committed', response_status: 502, fingerprint: 'fixed-original-fingerprint',
    response_body: { error: { code: 'social_upstream_rejected', details: { upstreamStatus: 400, outcome: 'rejected', retryable: false } } },
    acquisition_request: { method: 'POST', path: '/api/v1/data/search', body: { platform: 'twitter', query: ORIGINAL_QUERY, pageSize: 20 } } }
  const originalCall = { id: '98828234-9aa4-4f1a-88ac-f7db09f54b1e', tenant_id: tenant.id,
    consumer_id: consumer.id, api_key_id: context.apiKey.id, provider_key: 'rapidapi', operation: 'social.content.search',
    endpoint_key: 'twitter-aio.search', endpoint_version: 'twitter-aio.hub.v1', contract_version: 'mx-insight-hub.social-data.v1',
    outcome: 'rejected', http_status: 400, call_ordinal: 0, call_role: 'primary' }
  const proxy = { ...structuredClone(original), id: PROXY_RECEIPT.requestId,
    idempotency_key: PROXY_CASES.update_proxy.idempotencyKey,
    acquisition_request: { method: 'POST', path: '/api/v1/night-all/search/raw',
      body: { platform: 'twitter', query: PROXY_CASES.update_proxy.query, pageSize: 20 } } }
  const proxyCall = { ...structuredClone(originalCall), id: PROXY_RECEIPT.callId }
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 50,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3,
    maxRequestsPerMinute: 100, billing: {} }
  const control = new MemoryExternalPlatformControlStore()
  if (enabled) await control.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline fixture only',
    priceBook: { currency: 'CNY', pricingAsOf: '2026-10-18T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 1 } } },
  { runtime: { config, credentialConfigured: true } })
  const credentials = new MemoryExternalPlatformCredentialStore({ providerKey: 'tikhub', environmentConfigured: credential })
  const platform = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: 'tikhub', authorizationPlatform: endpoint.authorizationPlatform })
  const sent = [], sql = [], alteredRows = { existing: null, calls: null }
  const usageRow = row => ({ id: row.id, tenant_id: row.tenantId, consumer_id: row.consumerId, api_key_id: row.apiKeyId,
    platform: row.platform, status: row.status, response_status: row.responseStatus, response_body: structuredClone(row.responseBody),
    acquisition_request: structuredClone(row.acquisitionRequest), idempotency_key: row.idempotencyKey, fingerprint: row.fingerprint })
  const callRow = row => ({ id: row.id, tenant_id: row.tenantId, consumer_id: row.consumerId, api_key_id: row.apiKeyId,
    provider_key: row.providerKey, operation: row.operation, endpoint_key: row.endpointKey, endpoint_version: row.endpointVersion,
    contract_version: row.contractVersion, outcome: row.outcome, http_status: row.httpStatus, business_code: row.businessCode,
    call_ordinal: row.callOrdinal, call_role: row.callRole, upstream_request_id: row.upstreamRequestId })
  const query = async (text, values) => {
    sql.push(text)
    if (text.includes('twitter-tikhub:original-calls')) return { rows: [structuredClone(originalCall)] }
    if (text.includes('twitter-tikhub:original')) return { rows: [structuredClone(original)] }
    if (text.includes('twitter-tikhub:proxy-calls')) return { rows: [structuredClone(proxyCall)] }
    if (text.includes('twitter-tikhub:proxy')) return { rows: [structuredClone(proxy)] }
    if (text.includes('twitter-tikhub:existing')) {
      if (postDispatchLookupFailure && sent.length) throw new Error('synthetic receipt read unavailable')
      return { rows: alteredRows.existing ?? [...usage.requests.values()]
        .filter(row => row.consumerId === values[0] && row.idempotencyKey === IDEMPOTENCY_KEY).map(usageRow) }
    }
    if (text.includes('twitter-tikhub:probe-calls')) return { rows: alteredRows.calls ?? [...platform.calls.values()]
      .filter(row => row.usageRequestId === values[0]).map(callRow) }
    assert.match(text, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SET LOCAL statement_timeout)/u)
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  const protocol = new SearchProtocolStore(usage)
  if (protocolFinishFailure) protocol.finish = async () => { throw new Error('synthetic protocol persistence unavailable') }
  let runtimeCreations = 0, gatewayCreations = 0
  const createRuntime = async () => {
    runtimeCreations++
    return { store: usage, protocol,
      inspectReadiness: async () => {
        const current = usage.apiKeys.get(context.apiKey.id), liveConsumer = usage.consumers.get(consumer.id), liveTenant = usage.tenants.get(tenant.id)
        return inspectTikHubReadiness({ owner: { active: current.status === 'active' && liveConsumer.status === 'active' && liveTenant.status === 'active',
          testKey: current.environment === 'test', consumerId: consumer.id,
          platformGranted: (await usage.listEffectiveGrants(consumer.id, context.apiKey.id)).includes(endpoint.authorizationPlatform),
          capabilityGranted: (await usage.listEffectiveCapabilityGrants(consumer.id, context.apiKey.id)).includes(endpoint.operation) },
        credentialStore: credentials, controlStore: control, config })
      },
      createGateway: async onDispatch => {
        gatewayCreations++
        const adapter = oneShotTikHubAdapter(new TikHubAdapter({ apiKey: SECRET, timeoutMs: 50, fetchImpl: async (url, options) => {
          sent.push({ url: new URL(url), options })
          if (outcome === 'unknown') throw new Error(SECRET)
          if (outcome === 'rejected') return Response.json({ code: 400, message: SECRET }, { status: 400 })
          if (outcome === 'business-rejected') return Response.json({ code: 400, message: SECRET })
          return Response.json({ code: 200, message: 'ok', data: { entries: [{ content: { itemContent: { tweet_results: { result: {
            rest_id: '123', legacy: { full_text: POST } } } } } }, { content: { cursorType: 'Bottom', value: CURSOR } }] } })
        } }), onDispatch)
        return new ExternalPlatformGateway({ usageStore: usage, platformStore: platform, adapter, config,
          providerKey: 'tikhub', apiKeyPepper: PEPPER, operationControlStore: control, reservationLeaseMs: 150000, logger: { warn() {} } })
      } }
  }
  return { original, originalCall, proxy, proxyCall, usage, platform, control, credentials, config, context, endpoint, key, sent, sql, alteredRows,
    creations: () => ({ runtimeCreations, gatewayCreations }), run: options => runTwitterTikHubProbe({ pool, createRuntime, ...options }) }
}

test('read-only readiness uses metadata and reviewed controls without credentials, usage or authentication writes', async () => {
  const f = await fixture(), before = structuredClone(f.usage.apiKeys.get(f.context.apiKey.id))
  f.credentials.readCredential = () => assert.fail('read-only probe must not resolve a secret')
  f.credentials.readCredentialSnapshot = () => assert.fail('read-only probe must not resolve a secret')
  const result = await f.run()
  assert.equal(result.diagnosticRevision, REVISION)
  assert.equal(result.mode, 'read_only')
  assert.equal(result.adapterCalls, 0)
  assert.equal(result.readiness.ready, true)
  assert.equal(f.creations().gatewayCreations, 0)
  assert.equal(f.usage.requests.size, 0)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.usage.apiKeys.get(f.context.apiKey.id), before)
  assert.ok(f.sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
})

test('real TikHub native gateway sends every query atom exactly once without cursor, count or fill', async () => {
  const f = await fixture(), before = structuredClone([f.original, f.proxy])
  const result = await f.run({ execute: true })
  assert.equal(result.httpStatus, 200, JSON.stringify(result))
  assert.equal(result.adapterCalls, 1)
  assert.equal(result.savedOutcomeVerified, 'native_success')
  assert.equal(result.deliveryEstablished, false)
  assert.equal(QUERY.length, 257)
  assert.equal(SHA(QUERY), '1f56dcc7e0521efdb6bed09df10ff0c72ab2615940a880b45b963ccfd852e215')
  assert.equal(f.sent.length, 1)
  const { url, options } = f.sent[0]
  assert.equal(url.origin, 'https://api.tikhub.io')
  assert.equal(url.pathname, '/api/v1/twitter/web/fetch_search_timeline')
  assert.deepEqual(Object.fromEntries(url.searchParams), { keyword: QUERY, search_type: 'Top' })
  assert.equal(options.method, 'GET')
  assert.equal(options.body, undefined)
  assert.equal(options.redirect, 'error')
  assert.equal(f.usage.requests.size, 1)
  assert.equal(f.platform.calls.size, 1)
  assert.equal(f.platform.restrictedResponseArchives.size, 1)
  assert.deepEqual([f.original, f.proxy], before)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|${POST}|${CURSOR}`))
  assert.equal([...f.usage.requests.values()][0].acquisitionRequest.path, NATIVE_PATH)
})

test('missing native grants, unavailable credentials, disabled controls and revoked current keys send nothing', async () => {
  for (const options of [{ grant: false }, { platformGrant: false }, { credential: false }, { enabled: false }, { revoke: true }]) {
    const f = await fixture(options)
    if (options.revoke) await f.usage.revokeApiKey(f.context.apiKey.id)
    const result = await f.run({ execute: true })
    assert.equal(result.readiness.ready, false, JSON.stringify(result))
    assert.equal(result.adapterCalls, 0)
    assert.equal(f.creations().gatewayCreations, 0)
    assert.equal(f.sent.length, 0)
    assert.equal(f.usage.requests.size, 0)
  }
})

test('saved success, rejection and transport unknown are inspected without constructing another gateway', async () => {
  for (const outcome of ['success', 'rejected', 'unknown']) {
    const f = await fixture({ outcome }), first = await f.run({ execute: true })
    assert.equal(f.sent.length, 1, JSON.stringify(first))
    const stored = structuredClone([...f.usage.requests.values()][0]), count = f.creations()
    const second = await f.run({ execute: true })
    assert.equal(second.adapterCalls, 0)
    assert.equal(second.existing.requestId, stored.id)
    assert.equal(f.sent.length, 1)
    assert.deepEqual(f.creations(), count)
    assert.deepEqual([...f.usage.requests.values()][0], stored)
    if (outcome === 'unknown') assert.notEqual(second.savedOutcomeVerified, 'native_success')
  }
})

test('released old failures remain inspections and never reacquire the fixed diagnostic identity', async () => {
  const f = await fixture({ outcome: 'rejected' })
  await f.run({ execute: true })
  const row = [...f.usage.requests.values()][0]
  row.status = 'released'
  const result = await f.run({ execute: true })
  assert.equal(result.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
  assert.equal(row.status, 'released')
})

test('native HTTP 200 with a business rejection does not establish successful alternate search', async () => {
  const f = await fixture({ outcome: 'business-rejected' }), result = await f.run({ execute: true })
  assert.equal(f.sent.length, 1)
  assert.notEqual(result.savedOutcomeVerified, 'native_success')
  assert.equal(result.deliveryEstablished, false)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
  const repeated = await f.run({ execute: true })
  assert.equal(repeated.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
})

test('unresolved standard-search identities block both original and native spellings before supplier dispatch', async () => {
  for (const query of [ORIGINAL_QUERY, QUERY]) for (const state of ['running', 'unknown']) {
    const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'existing-v2-search-page', body: {
      platform: 'twitter', query, pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const result = await f.run({ execute: true })
    assert.equal(result.errorCode, 'search_admission_blocked', JSON.stringify(result))
    assert.equal(result.adapterCalls, 0)
    assert.equal(f.sent.length, 0)
    assert.equal(f.usage.requests.size, 0)
  }
})

test('original and forced-proxy evidence must retain exact owned definitive rejections', async () => {
  for (const mutate of [f => { f.original.status = 'unknown' }, f => { f.original.acquisition_request.body.query = 'different' },
    f => { f.originalCall.api_key_id = randomUUID() }, f => { f.proxy.status = 'unknown' },
    f => { f.proxy.acquisition_request.body.cursor = 'old-page' }, f => { f.proxy.idempotency_key = 'other-key' },
    f => { f.proxyCall.outcome = 'unknown' }, f => { f.proxyCall.id = randomUUID() }]) {
    const f = await fixture(); mutate(f)
    const result = await f.run({ execute: true })
    assert.ok(result.errorCode, JSON.stringify(result))
    assert.equal(f.creations().runtimeCreations, 0)
    assert.equal(f.sent.length, 0)
  }
})

test('saved ownership or receipt corruption cannot count as success or authorize new acquisition', async () => {
  for (const mutate of [f => { [...f.usage.requests.values()][0].apiKeyId = randomUUID() },
    f => { [...f.usage.requests.values()][0].acquisitionRequest.body.params.keyword = 'different' },
    f => { [...f.platform.calls.values()][0].apiKeyId = randomUUID() },
    f => { [...f.platform.calls.values()][0].businessCode = 400 }]) {
    const f = await fixture(); await f.run({ execute: true }); mutate(f)
    const result = await f.run({ execute: true })
    assert.notEqual(result.savedOutcomeVerified, 'native_success')
    assert.equal(result.adapterCalls, 0)
    assert.equal(f.sent.length, 1)
  }
})

test('a new TikHub unknown blocks future standard v1 and v2 acquisitions for both equivalent query spellings', async () => {
  const f = await fixture({ outcome: 'unknown' }), result = await f.run({ execute: true })
  assert.equal(f.sent.length, 1)
  assert.equal(result.saved.status, 'unknown')
  const protocol = new SearchProtocolStore(f.usage)
  for (const key of Object.values(PROTOCOL_KEYS)) {
    const binding = await protocol.binding(f.context, key)
    assert.equal(binding.state, 'unknown')
    assert.equal(binding.usageRequestId, result.saved.requestId)
    assert.equal(binding.result, null)
  }
  for (const query of [ORIGINAL_QUERY, QUERY]) for (const version of [1, 2]) {
    await assert.rejects(protocol.begin(f.context, { version, idempotencyKey: `future-query-${randomUUID()}`,
      body: { platform: 'twitter', query, pageSize: 20, type: 'stable' } }),
    { code: version === 1 ? 'request_outcome_unknown' : 'search_admission_blocked' })
  }
  assert.equal(f.sent.length, 1)
})

test('definitive native results never become a standard-search delivery but permit an explicit later acquisition', async () => {
  for (const outcome of ['success', 'rejected', 'business-rejected']) {
    const f = await fixture({ outcome }), result = await f.run({ execute: true })
    assert.equal(f.sent.length, 1)
    assert.equal(result.deliveryEstablished, false)
    const protocol = new SearchProtocolStore(f.usage)
    for (const key of Object.values(PROTOCOL_KEYS)) {
      const binding = await protocol.binding(f.context, key)
      assert.equal(binding.state, 'failed')
      assert.equal(binding.result, null)
      assert.equal(binding.error.code, 'diagnostic_not_standard_delivery')
    }
    for (const query of [ORIGINAL_QUERY, QUERY]) for (const version of [1, 2]) {
      const lease = await protocol.begin(f.context, { version, idempotencyKey: `later-query-${randomUUID()}`,
        body: { platform: 'twitter', query, pageSize: 20, type: 'stable' } })
      assert.equal(lease.kind, 'acquired')
      await protocol.finish(lease.input, { state: 'retryable' })
    }
    assert.equal(f.sent.length, 1)
  }
})

test('one-shot adapter rejects alternate keys, changed conditions and pagination, and never permits a second attempt', async () => {
  const body = { params: { keyword: QUERY, search_type: 'Top' }, deliveryMode: 'live_only' }
  let calls = 0, attempts = 0
  const adapter = oneShotTikHubAdapter({ forwardNative: async () => { calls++; return { preserved: true } } }, () => attempts++)
  for (const [key, request] of [['t.other', body], [NATIVE_KEY, { ...body, params: { ...body.params, cursor: 'next' } }],
    [NATIVE_KEY, { ...body, params: { ...body.params, keyword: 'update' } }],
    [NATIVE_KEY, { ...body, params: { ...body.params, search_type: 'Latest' } }]]) {
    await assert.rejects(adapter.forwardNative(key, request), /probe_request_mismatch/u)
  }
  assert.equal(calls, 0)
  assert.deepEqual(await adapter.forwardNative(NATIVE_KEY, body), { preserved: true })
  await assert.rejects(adapter.forwardNative(NATIVE_KEY, body), /probe_call_limit/u)
  assert.equal(calls, 1)
  assert.equal(attempts, 1)
})

test('a failed post-dispatch receipt lookup retains unknown guards even after a returned supplier 200', async () => {
  const f = await fixture({ postDispatchLookupFailure: true }), result = await f.run({ execute: true })
  assert.equal(f.sent.length, 1)
  assert.ok(result.verificationError)
  assert.equal(result.protocolGuardState, 'unknown')
  const protocol = new SearchProtocolStore(f.usage)
  for (const key of Object.values(PROTOCOL_KEYS)) assert.equal((await protocol.binding(f.context, key)).state, 'unknown')
  const second = await f.run({ execute: true })
  assert.ok(second.errorCode)
  assert.equal(second.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
})

test('protocol persistence failure leaves both retained leases blocking rather than clearing uncertain ownership', async () => {
  const f = await fixture({ protocolFinishFailure: true }), result = await f.run({ execute: true })
  assert.equal(f.sent.length, 1)
  assert.equal(result.verificationError, 'diagnostic_guard_persistence_unknown')
  const protocol = new SearchProtocolStore(f.usage)
  for (const key of Object.values(PROTOCOL_KEYS)) assert.equal((await protocol.binding(f.context, key)).state, 'running')
  for (const query of [ORIGINAL_QUERY, QUERY]) await assert.rejects(protocol.begin(f.context, {
    version: 1, idempotencyKey: `future-v1-${randomUUID()}`, body: { platform: 'twitter', query, pageSize: 20, type: 'stable' },
  }), { code: 'request_in_progress' })
  const repeated = await f.run({ execute: true })
  assert.equal(repeated.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
})

test('JSONB key reordering preserves exact saved request verification without reacquiring the page', async () => {
  const f = await fixture(); await f.run({ execute: true })
  const row = [...f.usage.requests.values()][0]
  row.acquisitionRequest = { body: { deliveryMode: 'live_only', params: { search_type: 'Top', keyword: QUERY } },
    path: NATIVE_PATH, method: 'POST' }
  const repeated = await f.run({ execute: true })
  assert.equal(repeated.savedOutcomeVerified, 'native_success')
  assert.equal(repeated.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
})

test('concurrent invocations share the fixed identity and allow at most one supplier request', async () => {
  const f = await fixture()
  const results = await Promise.all([f.run({ execute: true }), f.run({ execute: true })])
  assert.equal(results.reduce((total, result) => total + result.adapterCalls, 0), 1)
  assert.equal(f.sent.length, 1)
  assert.equal(f.usage.requests.size, 1)
  assert.equal(f.platform.calls.size, 1)
  const repeated = await f.run({ execute: true })
  assert.equal(repeated.savedOutcomeVerified, 'native_success')
  assert.equal(repeated.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
})

test('blocked second query binding releases the unsent first guard and allows explicit continuation after resolution', async () => {
  const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
  const blocker = await protocol.begin(f.context, { version: 2, idempotencyKey: 'other-native-query-in-progress',
    body: { platform: 'twitter', query: QUERY, pageSize: 20, type: 'stable' } })
  const blocked = await f.run({ execute: true })
  assert.equal(blocked.errorCode, 'search_admission_blocked')
  assert.equal(blocked.protocolGuardState, 'retryable')
  assert.equal(blocked.adapterCalls, 0)
  assert.equal((await protocol.binding(f.context, PROTOCOL_KEYS.original)).state, 'retryable')
  assert.equal(await protocol.binding(f.context, PROTOCOL_KEYS.native), null)
  assert.equal(f.sent.length, 0)
  await protocol.finish(blocker.input, { state: 'failed', error: { code: 'synthetic-definitive-rejection', status: 422 } })
  const resumed = await f.run({ execute: true })
  assert.equal(resumed.savedOutcomeVerified, 'native_success', JSON.stringify(resumed))
  assert.equal(resumed.adapterCalls, 1)
  assert.equal(f.sent.length, 1)
})
