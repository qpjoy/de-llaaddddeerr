import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { PROBE_CASES, HALF_CASES, HALF_RECEIPTS, AND_CASES, ENGLISH_AND_RECEIPT, GROUP_CASES, EVENT_RECEIPT, ORDER_CASES, ORDER_RECEIPT, TERM_CASES, UPDATE_RECEIPT, PROXY_CASES, HOST_PROXY_URL, ORIGINAL_REQUEST_ID, QUERY_PARAM_REQUEST_ID, CANDIDATE_REQUEST_IDS, runTwitterQueryParamProbe, queryParamAdapter, prepareHostProxyTransport } from '../../server/ops/verify-twitter-query-param.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { rapidApiConfig } from '../../server/external-platforms/rapidapi-config.mjs'
import { guardDataSearchV1 } from '../../server/data/search-protocol.mjs'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'
import { createRapidApiProxyFetch, proxyEndpointLabel } from '../../server/external-platforms/proxy.mjs'

const ORIGINAL_QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") AND NOT ("广告" OR "营销" OR "重复搬运") AND (("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost)'
const SECRET = 'offline-provider-secret-do-not-print'
const POST = 'private supplier post must not enter the report'
const PEPPER = 'twitter-query-param-offline-fixture-pepper'
async function fixture({ grant = true, enabled = true, outcome = 'success', observedAt = () => new Date().toISOString() } = {}) {
  const usage = new MemoryStore(), service = new HubService({ store: usage, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Offline query-param tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Offline query-param caller' })
  await usage.setPlatformGrant(consumer.id, 'twitter', true)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Offline fixture', platforms: ['twitter'],
    capabilities: [] })
  const context = await service.authenticate(key.secret)
  if (!grant) await usage.setPlatformGrant(consumer.id, 'twitter', false)
  const original = { id: ORIGINAL_REQUEST_ID, tenant_id: tenant.id, consumer_id: consumer.id, api_key_id: context.apiKey.id,
    platform: 'twitter', status: 'committed', response_status: 502, fingerprint: 'original-fixed-fingerprint',
    response_body: { error: { code: 'social_upstream_rejected', details: { upstreamStatus: 400, outcome: 'rejected', retryable: false } } },
    acquisition_request: { method: 'POST', path: '/api/v1/data/search', body: { platform: 'twitter', query: ORIGINAL_QUERY, pageSize: 20 } } }
  const originalCall = { tenant_id: tenant.id, consumer_id: consumer.id, api_key_id: context.apiKey.id, provider_key: 'rapidapi',
    operation: 'social.content.search', endpoint_key: 'twitter-aio.search', endpoint_version: 'twitter-aio.hub.v1',
    contract_version: 'mx-insight-hub.social-data.v1', outcome: 'rejected', http_status: 400, call_ordinal: 0, call_role: 'primary' }
  const knownIds = [...CANDIDATE_REQUEST_IDS, QUERY_PARAM_REQUEST_ID]
  const knownCandidates = knownIds.map(id => ({ ...structuredClone(original), id,
    acquisition_request: { ...structuredClone(original.acquisition_request),
      path: id === QUERY_PARAM_REQUEST_ID ? '/api/v1/night-all/search/raw' : '/api/v1/data/search', body: { platform: 'twitter', query: PROBE_CASES.candidate.query, pageSize: 20 } } }))
  const knownCalls = knownIds.map(id => ({ ...structuredClone(originalCall), id: id === QUERY_PARAM_REQUEST_ID ? '38e539e4-eeb8-497a-bbee-b5f6c681a2bf' : randomUUID() }))
  const knownHalves = HALF_RECEIPTS.map(receipt => ({ ...structuredClone(original), id: receipt.requestId,
    response_status: receipt.outcome === 'success' ? 200 : 502,
    response_body: receipt.outcome === 'success' ? { data: { items: [] } } : structuredClone(original.response_body),
    acquisition_request: { method: 'POST', path: '/api/v1/night-all/search/raw',
      body: { platform: 'twitter', query: HALF_CASES[receipt.caseName].query, pageSize: 20 } } }))
  const halfCalls = HALF_RECEIPTS.map(receipt => ({ ...structuredClone(originalCall), id: receipt.callId,
    outcome: receipt.outcome === 'success' ? 'succeeded' : 'rejected', http_status: receipt.outcome === 'success' ? 200 : 400 }))
  const knownEnglishAnd = { ...structuredClone(original), id: ENGLISH_AND_RECEIPT.requestId,
    idempotency_key: AND_CASES.english_and.idempotencyKey,
    acquisition_request: { method: 'POST', path: '/api/v1/night-all/search/raw',
      body: { platform: 'twitter', query: AND_CASES.english_and.query, pageSize: 20 } } }
  const englishAndCalls = [{ ...structuredClone(originalCall), id: ENGLISH_AND_RECEIPT.callId }]
  const knownEvent = { ...structuredClone(original), id: EVENT_RECEIPT.requestId,
    idempotency_key: GROUP_CASES.english_events.idempotencyKey,
    acquisition_request: { method: 'POST', path: '/api/v1/night-all/search/raw',
      body: { platform: 'twitter', query: GROUP_CASES.english_events.query, pageSize: 20 } } }
  const eventCalls = [{ ...structuredClone(originalCall), id: EVENT_RECEIPT.callId }]
  const knownOrder = { ...structuredClone(original), id: ORDER_RECEIPT.requestId,
    idempotency_key: ORDER_CASES.events_order.idempotencyKey,
    acquisition_request: { method: 'POST', path: '/api/v1/night-all/search/raw',
      body: { platform: 'twitter', query: ORDER_CASES.events_order.query, pageSize: 20 } } }
  const orderCalls = [{ ...structuredClone(originalCall), id: ORDER_RECEIPT.callId }]
  const knownUpdate = { ...structuredClone(original), id: UPDATE_RECEIPT.requestId,
    idempotency_key: TERM_CASES.event_update.idempotencyKey,
    acquisition_request: { method: 'POST', path: '/api/v1/night-all/search/raw',
      body: { platform: 'twitter', query: TERM_CASES.event_update.query, pageSize: 20 } } }
  const updateCalls = [{ ...structuredClone(originalCall), id: UPDATE_RECEIPT.callId }]
  const controls = new MemoryExternalPlatformControlStore(), config = { ...rapidApiConfig(), configured: true, timeoutMs: 50 }
  if (enabled) await controls.updatePolicy('rapidapi', 'social.content.search', { expectedRevision: 1, desiredState: 'active', reason: 'Offline only',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-18T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { 'twitter-aio.search': 1 } } },
  { runtime: { config, credentialConfigured: true } })
  const platform = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const sent = [], sql = []
  const query = async (text, values) => {
    sql.push(text)
    if (text.includes('twitter-query-param:known-update-calls')) return { rows: structuredClone(updateCalls) }
    if (text.includes('twitter-query-param:known-update')) return { rows: [structuredClone(knownUpdate)].filter(row => row.id === values[0]) }
    if (text.includes('twitter-query-param:known-order-calls')) return { rows: structuredClone(orderCalls) }
    if (text.includes('twitter-query-param:known-order')) return { rows: [structuredClone(knownOrder)].filter(row => row.id === values[0]) }
    if (text.includes('twitter-query-param:known-event-calls')) return { rows: structuredClone(eventCalls) }
    if (text.includes('twitter-query-param:known-event')) return { rows: [structuredClone(knownEvent)].filter(row => row.id === values[0]) }
    if (text.includes('twitter-query-param:known-english-and-calls')) return { rows: structuredClone(englishAndCalls) }
    if (text.includes('twitter-query-param:known-english-and')) return { rows: [structuredClone(knownEnglishAnd)].filter(row => row.id === values[0]) }
    if (text.includes('twitter-query-param:known-half-calls')) return { rows: [structuredClone(halfCalls[HALF_RECEIPTS.findIndex(row => row.requestId === values[0])])] }
    if (text.includes('twitter-query-param:known-half')) return { rows: knownHalves.filter(row => row.id === values[0]).map(row => structuredClone(row)) }
    if (text.includes('twitter-query-param:known-candidate-calls')) return { rows: [structuredClone(knownCalls[knownIds.indexOf(values[0])])] }
    if (text.includes('twitter-query-param:known-candidate')) return { rows: knownCandidates.filter(row => row.id === values[0]).map(row => structuredClone(row)) }
    if (text.includes('twitter-query-param:original-calls')) return { rows: [structuredClone(originalCall)] }
    if (text.includes('twitter-query-param:original')) return { rows: [structuredClone(original)] }
    if (text.includes('twitter-query-param:existing')) return { rows: [...usage.requests.values()]
      .filter(row => row.consumerId === values[0] && row.idempotencyKey === values[1]).map(row => ({ id: row.id,
        tenant_id: row.tenantId, consumer_id: row.consumerId, api_key_id: row.apiKeyId, platform: row.platform, status: row.status, response_status: row.responseStatus,
        response_body: structuredClone(row.responseBody), acquisition_request: structuredClone(row.acquisitionRequest) })) }
    if (text.includes('twitter-query-param:probe-calls')) return { rows: [...platform.calls.values()]
      .filter(row => row.usageRequestId === values[0]).map(row => ({ id: row.id, outcome: row.outcome,
        http_status: row.httpStatus, upstream_request_id: row.upstreamRequestId,
        completed_at: row.completedAt, observed_at: observedAt(),
        tenant_id: row.tenantId, consumer_id: row.consumerId, api_key_id: row.apiKeyId, provider_key: row.providerKey,
        operation: row.operation, endpoint_key: row.endpointKey, endpoint_version: row.endpointVersion, contract_version: row.contractVersion,
        call_ordinal: row.callOrdinal, call_role: row.callRole })) }
    if (text.includes('twitter-query-param:probe-archive')) {
      const archive = platform.restrictedResponseArchives.get(values[0])
      return { rows: archive ? [{ body_bytes: archive.bodyBytes, body_size: archive.bodySize,
        body_sha256: archive.bodySha256, captured_at: archive.capturedAt }] : [] }
    }
    assert.match(text, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK|SET LOCAL statement_timeout)/u)
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  let runtimeCreations = 0
  const createGatewayRuntime = async (onDispatch, caseName) => {
    runtimeCreations++
    const adapter = queryParamAdapter(new RapidApiAdapter({ apiKey: SECRET, timeoutMs: 50, fetchImpl: async url => {
      sent.push(new URL(url))
      const selectedOutcome = typeof outcome === 'function' ? outcome(caseName) : outcome
      if (selectedOutcome === 'unknown') throw new Error(SECRET)
      if (selectedOutcome === 'rejected') return Response.json({ message: '400, bad request' }, { status: 400 })
      if (selectedOutcome === 'other-rejection') return Response.json({ message: 'service temporarily unavailable' }, { status: 503 })
      if (selectedOutcome === 'unusable') return Response.json({ unexpected: 'not a timeline' })
      if (['overflow', 'overflow22', 'overflow27'].includes(selectedOutcome)) return Response.json({ entries: [{ type: 'TimelineAddEntries', entries: [
        ...Array.from({ length: selectedOutcome === 'overflow27' ? 27 : selectedOutcome === 'overflow22' ? 22 : 21 }, (_, index) => ({ content: { itemContent: { tweet_results: { result: {
          rest_id: String(index + 1), legacy: { full_text: POST },
        } } } } })), { content: { cursorType: 'Bottom', value: 'do-not-follow' } },
      ] }] }, { headers: { 'x-rapidapi-request-id': 'synthetic-upstream-overflow' } })
      return Response.json({ entries: [{ content: { itemContent: { tweet_results: { result: {
        rest_id: '1', legacy: { full_text: POST },
      } } } } }, { content: { cursorType: 'Bottom', value: 'do-not-follow' } }] },
      { headers: { 'x-rapidapi-request-id': 'synthetic-upstream-1' } })
    } }), caseName, onDispatch)
    return { store: usage, guardDataSearchV1,
      ...(Object.hasOwn(PROXY_CASES, caseName) ? { diagnosticTransport: { scope: 'diagnostic_process_only', selectedProxy: HOST_PROXY_URL,
        currentConfiguredRoute: { source: 'system', proxyEndpoints: [], directFallback: true },
        comparisonLimit: 'Historical route not retained; synthetic test route observation only.' } } : {}),
      gateway: new ExternalPlatformGateway({ usageStore: usage,
      platformStore: platform, adapter, config, providerKey: 'rapidapi', apiKeyPepper: PEPPER,
      operationControlStore: controls, reservationLeaseMs: 60000, logger: { warn() {} } }) }
  }
  return { pool, createGatewayRuntime, original, originalCall, knownCandidates, knownCalls, knownHalves, halfCalls, knownEnglishAnd, englishAndCalls, knownEvent, eventCalls, knownOrder, orderCalls, knownUpdate, updateCalls, context, usage, platform, sent, sql,
    creations: () => runtimeCreations, run: options => runTwitterQueryParamProbe({ pool, createGatewayRuntime, ...options }) }
}

// Model the already recorded v4 topic probe through the real raw gateway.
// The v5 diagnostic may inspect this receipt but must never send it again.
async function seedGroupTopic(f, { historical = true } = {}) {
  const runtime = await f.createGatewayRuntime(() => {}, 'english_topics')
  const body = { platform: 'twitter', query: GROUP_CASES.english_topics.query, pageSize: 20 }
  try {
    await runtime.gateway.searchRaw(f.context, { body,
      normalized: { platform: 'twitter', upstreamBody: body, pageSize: 20 },
      idempotencyKey: GROUP_CASES.english_topics.idempotencyKey })
  } catch (error) {
    assert.match(error.code, /^social_upstream_(?:rejected|response_unusable|outcome_unknown)$/u)
  }
  assert.equal(f.usage.requests.size, 1)
  assert.equal(f.platform.calls.size, 1)
  const row = { usage: [...f.usage.requests.values()][0], call: [...f.platform.calls.values()][0],
    archive: [...f.platform.restrictedResponseArchives.values()][0] }
  // A real earlier receipt has already aged past the endpoint quarantine.
  // Keep that governance intact; tests never disable its configured duration.
  if (historical) row.call.completedAt = new Date(Date.now() - 6 * 60_000).toISOString()
  return row
}

test('dry-run checks the fixed original rejection without constructing a credentialed gateway or creating usage', async () => {
  const f = await fixture(), before = structuredClone(f.original)
  const result = await f.run()
  assert.equal(result.mode, 'read_only')
  assert.equal(result.case, 'control')
  assert.equal(result.originalRejectionVerified, true)
  assert.equal(result.adapterCalls, 0)
  assert.equal(f.creations(), 0)
  assert.equal(f.usage.requests.size, 0)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.original, before)
  assert.ok(f.sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
})

test('each explicit fixed case uses the real adapter and gateway for one archived request, retaining the response and original', async () => {
  for (const caseName of ['control', 'candidate']) {
    const f = await fixture(), before = structuredClone(f.original)
    const result = await f.run({ caseName, execute: true })
    assert.equal(result.errorCode, undefined)
    assert.equal(result.httpStatus, 200)
    assert.equal(result.adapterCalls, 1)
    assert.equal(result.itemCount, 1)
    assert.match(result.countMeaning, /not proof of HTTP dispatch/u)
    assert.match(result.deliveryScope, /not a standard search delivery/u)
    assert.equal(f.context.apiKey.capabilities?.length || 0, 0)
    assert.equal(result.hasMore, true)
    assert.equal(result.originalUnchanged, true)
    assert.equal(result.knownCandidateRejections.length, caseName === 'candidate' ? 2 : 0)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].origin, 'https://twitter-aio.p.rapidapi.com')
    assert.equal(f.sent[0].pathname, '/search')
    assert.deepEqual(Object.fromEntries(f.sent[0].searchParams), { count: '20', category: 'Top', includeTimestamp: 'false',
      searchItem: PROBE_CASES[caseName].query })
    assert.equal(f.usage.requests.size, 1)
    assert.equal(f.platform.calls.size, 1)
    assert.equal(f.platform.restrictedResponseArchives.size, 1)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|${POST}|do-not-follow`))
    const saved = structuredClone([...f.usage.requests.values()][0])
    const repeated = await f.run({ caseName, execute: true })
    assert.equal(repeated.existing.requestId, result.requestId)
    assert.equal(repeated.adapterCalls, 0)
    assert.equal(f.sent.length, 1)
    assert.deepEqual([...f.usage.requests.values()][0], saved)
    assert.deepEqual(f.original, before)
  }
})

test('confirmed supplier rejection and unknown transport stay durable and never repeat on a second invocation', async () => {
  for (const outcome of ['rejected', 'unknown']) {
    const f = await fixture({ outcome })
    const result = await f.run({ caseName: 'control', execute: true })
    assert.equal(result.adapterCalls, 1)
    assert.equal(f.sent.length, 1)
    assert.equal(result.errorCode, outcome === 'rejected' ? 'social_upstream_rejected' : 'social_upstream_outcome_unknown')
    assert.equal(result.saved.status, outcome === 'rejected' ? 'committed' : 'unknown')
    const next = await f.run({ caseName: 'control', execute: true })
    assert.equal(next.adapterCalls, 0)
    assert.equal(next.existing.status, result.saved.status)
    assert.equal(f.sent.length, 1)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET))
  }
})

test('standard v2 unknown and running bindings block the raw alias before it can dispatch', async () => {
  for (const state of ['unknown', 'running']) {
    const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'existing-v2-guard', body: {
      platform: 'twitter', query: 'OpenAI', pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const result = await f.run({ caseName: 'control', execute: true })
    assert.equal(result.errorCode, state === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
    assert.equal(result.adapterCalls, 0)
    assert.equal(f.sent.length, 0)
    assert.equal(f.usage.requests.size, 0)
  }
})

test('current platform authorization and operation policy remain mandatory and no grants are changed', async () => {
  for (const options of [{ grant: false }, { enabled: false }]) {
    const f = await fixture(options)
    const result = await f.run({ caseName: 'control', execute: true })
    assert.ok(result.errorCode)
    if (options.grant === false) assert.equal(result.errorCode, 'platform_not_granted')
    assert.equal(result.adapterCalls, 0)
    assert.equal(f.sent.length, 0)
  }
})

test('the original must remain a verified owned first-page 400; no arbitrary query or variant can execute', async () => {
  for (const mutate of [f => { f.original.status = 'unknown' }, f => { f.original.response_status = 200 },
    f => { f.originalCall.outcome = 'unknown' }, f => { f.originalCall.api_key_id = randomUUID() },
    f => { f.original.acquisition_request.body.query = 'different' }, f => { f.original.acquisition_request.body.cursor = 'old-page' }]) {
    const f = await fixture(); mutate(f)
    const result = await f.run({ caseName: 'control', execute: true })
    assert.match(result.errorCode, /original_(?:rejection|provider_evidence)_unverified/u)
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
  const f = await fixture()
  await assert.rejects(f.run({ execute: true }), /invalid_arguments/u)
  await assert.rejects(f.run({ execute: true, caseName: 'arbitrary' }), /invalid_arguments/u)
  const adapter = queryParamAdapter({ execute: async () => assert.fail('must not dispatch'), resolveCredential: async () => SECRET }, 'control')
  const request = normalizeHubSocialRequest('search', { platform: 'twitter', query: 'different', count: 20, sort: 'top' })
  await assert.rejects(adapter.execute(request), /probe_request_mismatch/u)
})

test('candidate transport comparison stops if either fixed earlier candidate lacks a confirmed owned 400', async () => {
  for (const index of [0, 1]) {
    for (const mutate of [f => { f.knownCandidates[index].status = 'unknown' },
      f => { f.knownCandidates[index].api_key_id = randomUUID() },
      f => { f.knownCandidates[index].acquisition_request.body.query = 'different' },
      f => { f.knownCalls[index].outcome = 'unknown' },
      f => { f.knownCandidates.splice(index, 1) }]) {
      const f = await fixture(); mutate(f)
      const result = await f.run({ caseName: 'candidate', execute: true })
      assert.match(result.errorCode, /known_candidate_(?:rejection|provider_evidence)_unverified/u)
      assert.equal(result.adapterCalls, 0)
      assert.equal(f.creations(), 0)
      assert.equal(f.sent.length, 0)
    }
  }
})

test('halves are fixed proper subexpressions and preserve previously issued query-param keys', async () => {
  assert.equal(HALF_CASES.chinese_half.query.length, 115)
  assert.equal(HALF_CASES.english_half.query.length, 141)
  assert.equal(`${HALF_CASES.chinese_half.query} ${HALF_CASES.english_half.query}`, PROBE_CASES.candidate.query)
  assert.equal(PROBE_CASES.control.idempotencyKey, 'ops-twitter-queryparam-159fd300ff79c767140ef9d3350894776620bdac2d14bd4a')
  assert.equal(PROBE_CASES.candidate.idempotencyKey, 'ops-twitter-queryparam-a99ae443b6685fa1666315486f57e4a9162a0ca6639283ff')
  const f = await fixture(), result = await f.run({ caseName: 'halves' })
  assert.equal(result.mode, 'read_only')
  assert.equal(result.reports.length, 2)
  assert.equal(result.adapterCalls, 0)
  assert.equal(f.creations(), 0)
  assert.deepEqual(result.reports.map(row => row.queryLength), [115, 141])
  assert.ok(result.reports.every(row => row.knownCandidateRejections.some(known => known.requestId === QUERY_PARAM_REQUEST_ID)))
  assert.match(result.deliveryScope, /subexpressions/u)
})

test('halves execute at most two independent path pages and only continue after a confirmed owned 200 or 400', async () => {
  for (const outcome of ['success', 'rejected']) {
    const f = await fixture({ outcome }), result = await f.run({ caseName: 'halves', execute: true })
    assert.equal(result.errorCode, undefined)
    assert.equal(result.adapterCalls, 2)
    assert.equal(result.reports.length, 2)
    assert.deepEqual(result.reports.map(row => row.savedOutcomeVerified), [outcome === 'success' ? 'success' : 'rejected400', outcome === 'success' ? 'success' : 'rejected400'])
    assert.equal(f.sent.length, 2)
    assert.equal(f.platform.calls.size, 2)
    assert.equal(f.platform.restrictedResponseArchives.size, 2)
    for (const [index, name] of ['chinese_half', 'english_half'].entries()) {
      assert.equal(decodeURIComponent(f.sent[index].pathname.slice('/search/'.length)), HALF_CASES[name].query)
      assert.deepEqual(Object.fromEntries(f.sent[index].searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
      assert.equal(result.reports[index].providerCalls.length, 1)
    }
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|${POST}|do-not-follow`))
    const next = await f.run({ caseName: 'halves', execute: true })
    assert.equal(next.adapterCalls, 0)
    assert.equal(next.reports.length, 2)
    assert.equal(f.sent.length, 2)
  }
})

test('unknown and unconfirmed first-half outcomes stop the second half and never redispatch an existing key', async () => {
  for (const outcome of ['unknown', 'other-rejection']) {
    const f = await fixture({ outcome }), result = await f.run({ caseName: 'halves', execute: true })
    assert.equal(result.adapterCalls, 1)
    assert.equal(result.reports.length, 1)
    assert.equal(result.stoppedAfter, 'chinese_half')
    assert.ok(result.errorCode)
    const next = await f.run({ caseName: 'halves', execute: true })
    assert.equal(next.adapterCalls, 0)
    assert.equal(next.stoppedAfter, 'chinese_half')
    assert.equal(f.sent.length, 1)
  }
  const f = await fixture({ outcome: part => part === 'english_half' ? 'unknown' : 'success' })
  const result = await f.run({ caseName: 'halves', execute: true })
  assert.equal(result.adapterCalls, 2)
  assert.equal(result.stoppedAfter, 'english_half')
  const next = await f.run({ caseName: 'halves', execute: true })
  assert.equal(next.adapterCalls, 0)
  assert.equal(next.stoppedAfter, 'english_half')
  assert.equal(f.sent.length, 2)
})

test('halves require the exact saved query-param refusal and retain standard v2 unknown protection', async () => {
  for (const mutate of [f => { f.knownCandidates[2].status = 'unknown' }, f => { f.knownCalls[2].id = randomUUID() },
    f => { f.knownCandidates[2].acquisition_request.path = '/api/v1/data/search' }]) {
    const f = await fixture(); mutate(f)
    const result = await f.run({ caseName: 'halves', execute: true })
    assert.equal(result.adapterCalls, 0)
    assert.equal(result.stoppedAfter, 'chinese_half')
    assert.equal(f.creations(), 0)
  }
  const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
  const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'existing-half-unknown', body: {
    platform: 'twitter', query: HALF_CASES.chinese_half.query, pageSize: 20, type: 'stable',
    timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
  } })
  await protocol.finish(lease.input, { state: 'unknown', usageRequestId: randomUUID() })
  const result = await f.run({ caseName: 'halves', execute: true })
  assert.equal(result.adapterCalls, 0)
  assert.equal(result.errorCode, 'request_outcome_unknown')
  assert.equal(result.reports.length, 1)
})

test('explicit AND retains every atom and prior key, and dry-run validates both fixed half receipts without runtime creation', async () => {
  assert.equal(HALF_CASES.chinese_half.idempotencyKey, 'ops-twitter-half-ba496ab3ee690016e7b56b830d8d68dc359838fc291fcefd')
  assert.equal(HALF_CASES.english_half.idempotencyKey, 'ops-twitter-half-940ac241b29f66f738cecc8169f57ab282ed704ed3fd75d7')
  assert.equal(AND_CASES.english_and.query, HALF_CASES.english_half.query)
  assert.equal(AND_CASES.english_and.providerQuery, '("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost')
  assert.equal(AND_CASES.candidate_and.query, PROBE_CASES.candidate.query)
  assert.equal(AND_CASES.candidate_and.providerQuery, '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") AND ("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -"广告" -"营销" -"重复搬运" -ad -marketing -repost')
  const f = await fixture(), report = await f.run({ caseName: 'english-and' })
  assert.equal(report.mode, 'read_only')
  assert.equal(report.reports.length, 2)
  assert.equal(report.adapterCalls, 0)
  assert.equal(f.creations(), 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.usage.requests.size, 0)
  assert.ok(report.reports.every(row => row.knownHalfOutcomes.length === 2))
  assert.deepEqual(report.reports.map(row => row.providerQueryLength), [145, 265])
  assert.ok(report.reports.every(row => /not historical outgoing URL/u.test(row.providerQueryEvidence)
    && row.preparedProviderQuery === undefined))
  assert.match(report.deliveryScope, /no Delta mutation or cold-start delivery/u)
})

test('explicit AND reaches the actual wire and full query follows only the saved English success, with replay of both receipts', async () => {
  const f = await fixture(), report = await f.run({ caseName: 'english-and', execute: true })
  assert.equal(report.errorCode, undefined)
  assert.equal(report.adapterCalls, 2)
  assert.deepEqual(report.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
  for (const [index, name] of ['english_and', 'candidate_and'].entries()) {
    const sent = f.sent[index], selected = AND_CASES[name]
    assert.equal(decodeURIComponent(sent.pathname.slice('/search/'.length)), selected.providerQuery)
    assert.equal((decodeURIComponent(sent.pathname).match(/ AND /gu) || []).length, index + 1)
    assert.deepEqual(Object.fromEntries(sent.searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
    const saved = [...f.usage.requests.values()].find(row => row.id === report.reports[index].requestId)
    assert.equal(saved.acquisitionRequest.body.query, selected.query)
    assert.equal(report.reports[index].providerCalls.length, 1)
    assert.equal(report.reports[index].preparedProviderQuery.querySha256, report.reports[index].providerQuerySha256)
  }
  assert.equal(f.platform.calls.size, 2)
  assert.equal(f.platform.restrictedResponseArchives.size, 2)
  const again = await f.run({ caseName: 'english-and', execute: true })
  assert.equal(again.adapterCalls, 0)
  assert.deepEqual(again.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
  assert.equal(f.sent.length, 2)
  assert.ok(again.reports.every(row => row.preparedProviderQuery === undefined))
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${POST}|do-not-follow`))
})

test('a previous native half refusal is not replayed as an explicit-AND result despite sharing the raw fingerprint', async () => {
  const f = await fixture({ outcome: name => name === 'english_half' ? 'rejected' : 'success' })
  const before = await f.run({ caseName: 'halves', execute: true })
  assert.equal(before.reports[1].savedOutcomeVerified, 'rejected400')
  const oldEnglish = [...f.usage.requests.values()].find(row => row.id === before.reports[1].requestId)
  const after = await f.run({ caseName: 'english-and', execute: true })
  const newEnglish = [...f.usage.requests.values()].find(row => row.id === after.reports[0].requestId)
  assert.equal(newEnglish.fingerprint, oldEnglish.fingerprint)
  assert.notEqual(newEnglish.id, oldEnglish.id)
  assert.notEqual(newEnglish.idempotencyKey, oldEnglish.idempotencyKey)
  assert.equal(after.adapterCalls, 2)
  assert.deepEqual(after.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
  assert.equal(f.sent.length, 4)
  assert.equal(decodeURIComponent(f.sent[2].pathname.slice('/search/'.length)), AND_CASES.english_and.providerQuery)
  assert.equal(decodeURIComponent(f.sent[3].pathname.slice('/search/'.length)), AND_CASES.candidate_and.providerQuery)
})

test('English explicit-AND rejection, unknown or other failure never reaches the full query, including later invocations', async () => {
  for (const outcome of ['rejected', 'unknown', 'other-rejection']) {
    const f = await fixture({ outcome }), report = await f.run({ caseName: 'english-and', execute: true })
    assert.equal(report.adapterCalls, 1)
    assert.equal(report.reports.length, 1)
    assert.equal(report.stoppedAfter, 'english_and')
    assert.ok(report.errorCode)
    const again = await f.run({ caseName: 'english-and', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.equal(again.reports.length, 1)
    assert.equal(again.stoppedAfter, 'english_and')
    assert.equal(f.sent.length, 1)
  }
  const f = await fixture({ outcome: name => name === 'candidate_and' ? 'rejected' : 'success' })
  const report = await f.run({ caseName: 'english-and', execute: true })
  assert.equal(report.adapterCalls, 2)
  assert.equal(report.stoppedAfter, 'candidate_and')
  assert.equal((await f.run({ caseName: 'english-and', execute: true })).adapterCalls, 0)
  assert.equal(f.sent.length, 2)
})

test('both selected half receipts require exact owned input and call identity before explicit-AND dispatch', async () => {
  for (const index of [0, 1]) for (const mutate of [
    f => { f.knownHalves[index].status = 'unknown' },
    f => { f.knownHalves[index].api_key_id = randomUUID() },
    f => { f.knownHalves[index].acquisition_request.body.query = 'different' },
    f => { f.knownHalves[index].acquisition_request.body.cursor = 'old-page' },
    f => { f.knownHalves[index].acquisition_request.body.pageSize = 10 },
    f => { f.knownHalves[index].acquisition_request.path = '/api/v1/data/search' },
    f => { f.halfCalls[index].id = randomUUID() },
    f => { f.halfCalls[index].outcome = 'unknown' },
    f => { f.halfCalls[index].api_key_id = randomUUID() },
    f => { f.knownHalves.splice(index, 1) },
  ]) {
    const f = await fixture(); mutate(f)
    const report = await f.run({ caseName: 'english-and', execute: true })
    assert.equal(report.errorCode, 'known_half_outcome_unverified')
    assert.equal(report.stoppedAfter, 'english_and')
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
})

test('full explicit-AND dispatch requires a saved English sole owned success, not just a returned 200', async () => {
  for (const corrupt of [
    f => { [...f.usage.requests.values()][0].status = 'unknown' },
    f => { [...f.usage.requests.values()][0].status = 'released' },
    f => { [...f.usage.requests.values()][0].acquisitionRequest.body.query = 'different' },
    f => { [...f.platform.calls.values()][0].outcome = 'unknown' },
    f => { [...f.platform.calls.values()][0].apiKeyId = randomUUID() },
    f => { f.platform.calls.set(randomUUID(), { ...[...f.platform.calls.values()][0], id: randomUUID() }) },
    f => { f.platform.calls.clear() },
  ]) {
    const f = await fixture()
    const create = f.createGatewayRuntime
    const createGatewayRuntime = async (...args) => {
      const runtime = await create(...args), searchRaw = runtime.gateway.searchRaw.bind(runtime.gateway)
      runtime.gateway.searchRaw = async (...queryArgs) => { const result = await searchRaw(...queryArgs); corrupt(f); return result }
      return runtime
    }
    const report = await runTwitterQueryParamProbe({ pool: f.pool, createGatewayRuntime, caseName: 'english-and', execute: true })
    assert.equal(report.reports[0].httpStatus, 200)
    assert.equal(report.reports[0].savedOutcomeVerified, null)
    assert.equal(report.adapterCalls, 1)
    assert.equal(report.stoppedAfter, 'english_and')
    const again = await f.run({ caseName: 'english-and', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.equal(again.reports.length, 1)
    assert.equal(f.sent.length, 1)
  }
})

test('explicit-AND adaptation retains the native query guard and cannot bypass its running or unknown v2 request', async () => {
  for (const state of ['running', 'unknown']) {
    const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'original-english-v2-identity', body: {
      platform: 'twitter', query: HALF_CASES.english_half.query, pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const report = await f.run({ caseName: 'english-and', execute: true })
    assert.equal(report.errorCode, state === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.reports.length, 1)
    assert.equal(f.sent.length, 0)
  }
})

test('explicit-AND wire override rejects mismatched normal input, cursor, endpoint or parameters before dispatch', async () => {
  for (const change of [request => { request.query = 'different' }, request => { request.endpointPath = '/search/different' },
    request => { request.providerCursor = 'cursor' }, request => { request.page = 2 },
    request => { request.upstreamQuery.count = 10 }, request => { request.upstreamQuery.category = 'Top' }]) {
    const adapter = queryParamAdapter({ execute: async () => assert.fail('must not dispatch') }, 'english_and')
    const request = normalizeHubSocialRequest('search', { platform: 'twitter', query: AND_CASES.english_and.query, count: 20, sort: 'latest' })
    change(request)
    await assert.rejects(adapter.execute(request), /probe_request_mismatch/u)
  }
})

test('English groups retain exact terms, exclusions and all old keys; dry-run checks historical receipts without creating a runtime', async () => {
  assert.equal(GROUP_CASES.english_topics.query, '("diplomacy" OR "foreign policy" OR "diplomatic relations") -ad -marketing -repost')
  assert.equal(GROUP_CASES.english_events.query, '("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost')
  assert.equal(AND_CASES.english_and.idempotencyKey, 'ops-twitter-and-f67d5a195990ece97be8ee72e0e01c17f5f360db708d25f9')
  assert.equal(AND_CASES.candidate_and.idempotencyKey, 'ops-twitter-and-18a90c05ecf4c9a6638b37ff9568f19be25bfab9fd2af4b9')
  const f = await fixture(), report = await f.run({ caseName: 'english-groups' })
  assert.equal(report.case, 'english-groups')
  assert.equal(report.mode, 'read_only')
  assert.equal(report.reports.length, 2)
  assert.equal(report.adapterCalls, 0)
  assert.equal(f.creations(), 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.usage.requests.size, 0)
  assert.deepEqual(report.reports.map(row => row.queryLength), [82, 81])
  assert.ok(report.reports.every(row => row.knownHalfOutcomes.length === 2
    && row.knownCandidateRejections.length === 3
    && row.knownEnglishAnd.requestId === ENGLISH_AND_RECEIPT.requestId))
  assert.match(report.interpretation, /reason.*remains unproven/u)
  assert.deepEqual(report.rejectedGroups, [])
  assert.deepEqual(report.succeededGroups, [])
})

test('English groups inspect the existing topic then send only the event query after confirmed 200 or 400, with durable replay', async () => {
  for (const rejected of ['english_topics', 'english_events', 'both', 'neither']) {
    const f = await fixture({ outcome: name => rejected === 'both' || name === rejected ? 'rejected' : 'success' })
    await seedGroupTopic(f)
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(report.errorCode, undefined)
    assert.equal(report.adapterCalls, 1)
    assert.equal(report.maxAdapterCalls, 1)
    assert.equal(report.reports.length, 2)
    assert.equal(f.creations(), 2)
    assert.equal(f.sent.length, 2)
    assert.equal(f.platform.calls.size, 2)
    assert.equal(f.platform.restrictedResponseArchives.size, 2)
    const expectedRejected = rejected === 'both' ? ['english_topics', 'english_events'] : rejected === 'neither' ? [] : [rejected]
    assert.deepEqual(report.rejectedGroups, expectedRejected)
    assert.equal(report.succeededGroups.length, 2 - expectedRejected.length)
    for (const [index, name] of ['english_topics', 'english_events'].entries()) {
      const sent = f.sent[index]
      assert.equal(decodeURIComponent(sent.pathname.slice('/search/'.length)), GROUP_CASES[name].query)
      assert.deepEqual(Object.fromEntries(sent.searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
      if (index) assert.equal(report.reports[index].preparedProviderQuery.querySha256, report.reports[index].querySha256)
      else assert.equal(report.reports[index].preparedProviderQuery, undefined)
      assert.equal(report.reports[index].providerCalls.length, 1)
    }
    assert.match(report.deliveryScope, /Neither result is a full-query result/u)
    assert.match(report.interpretation, /no cold-start recovery/u)
    const again = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.deepEqual(again.rejectedGroups, expectedRejected)
    assert.equal(f.sent.length, 2)
    assert.ok(again.reports.every(row => row.preparedProviderQuery === undefined))
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${POST}|do-not-follow`))
  }
})

test('English group unknown, other rejection or missing evidence stops later requests, including repeated execution', async () => {
  for (const outcome of ['unknown', 'other-rejection']) {
    const f = await fixture({ outcome })
    await seedGroupTopic(f)
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.reports.length, 1)
    assert.equal(report.stoppedAfter, 'english_topics')
    assert.ok(report.errorCode)
    const again = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.equal(again.reports.length, 1)
    assert.equal(f.sent.length, 1)
  }
  const f = await fixture({ outcome: name => name === 'english_events' ? 'unknown' : 'rejected' })
  await seedGroupTopic(f)
  const report = await f.run({ caseName: 'english-groups', execute: true })
  assert.equal(report.adapterCalls, 1)
  assert.equal(report.stoppedAfter, 'english_events')
  assert.deepEqual(report.rejectedGroups, ['english_topics'])
  assert.equal((await f.run({ caseName: 'english-groups', execute: true })).adapterCalls, 0)
  assert.equal(f.sent.length, 2)
  const missing = await fixture()
  await seedGroupTopic(missing)
  missing.platform.calls.clear()
  const unverified = await missing.run({ caseName: 'english-groups', execute: true })
  assert.equal(unverified.reports[0].saved.httpStatus, 200)
  assert.equal(unverified.reports[0].savedOutcomeVerified, null)
  assert.equal(unverified.stoppedAfter, 'english_topics')
  assert.equal(unverified.adapterCalls, 0)
  assert.equal((await missing.run({ caseName: 'english-groups', execute: true })).adapterCalls, 0)
  assert.equal(missing.sent.length, 1)
})

test('English groups require the exact owned explicit-AND key, body and sole saved 400 call', async () => {
  for (const mutate of [
    f => { f.knownEnglishAnd.id = randomUUID() },
    f => { f.knownEnglishAnd.idempotency_key = 'other-key' },
    f => { f.knownEnglishAnd.status = 'unknown' },
    f => { f.knownEnglishAnd.response_status = 200 },
    f => { f.knownEnglishAnd.response_body.error.details.retryable = true },
    f => { f.knownEnglishAnd.api_key_id = randomUUID() },
    f => { f.knownEnglishAnd.acquisition_request.body.query = AND_CASES.english_and.providerQuery },
    f => { f.knownEnglishAnd.acquisition_request.body.cursor = 'cursor' },
    f => { f.knownEnglishAnd.acquisition_request.body.pageSize = 10 },
    f => { f.knownEnglishAnd.acquisition_request.path = '/api/v1/data/search' },
    f => { f.englishAndCalls[0].id = randomUUID() },
    f => { f.englishAndCalls[0].api_key_id = randomUUID() },
    f => { f.englishAndCalls[0].http_status = 200 },
    f => { f.englishAndCalls[0].outcome = 'unknown' },
    f => { f.englishAndCalls.push({ ...f.englishAndCalls[0], id: randomUUID() }) },
    f => { f.englishAndCalls.length = 0 },
  ]) {
    const f = await fixture(); mutate(f)
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(report.errorCode, 'known_english_and_unverified')
    assert.equal(report.stoppedAfter, 'english_topics')
    assert.equal(report.adapterCalls, 0)
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
})

test('English groups retain original and half proof checks plus running and unknown v2 protections', async () => {
  for (const mutate of [f => { f.knownCandidates[2].status = 'unknown' }, f => { f.halfCalls[0].id = randomUUID() },
    f => { f.knownHalves[1].acquisition_request.body.query = 'different' }]) {
    const f = await fixture(); mutate(f)
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.ok(report.errorCode)
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
  for (const state of ['running', 'unknown']) {
    const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
    await seedGroupTopic(f)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'same-group-v2-identity', body: {
      platform: 'twitter', query: GROUP_CASES.english_events.query, pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(report.errorCode, state === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.reports.length, 2)
    assert.equal(report.stoppedAfter, 'english_events')
    assert.equal(f.sent.length, 1)
  }
})

test('group continuation cannot acquire a missing topic receipt', async () => {
  const f = await fixture(), report = await f.run({ caseName: 'english-groups', execute: true })
  assert.equal(report.maxAdapterCalls, 1)
  assert.equal(report.adapterCalls, 0)
  assert.equal(report.stoppedAfter, 'english_topics')
  assert.equal(report.reports.length, 1)
  assert.equal(f.creations(), 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.usage.requests.size, 0)
})

test('an archived overflow topic permits only the event probe without changing its saved raw failure or original receipt', async () => {
  const f = await fixture({ outcome: name => name === 'english_topics' ? 'overflow' : 'success' })
  const topic = await seedGroupTopic(f), before = structuredClone(topic), original = structuredClone(f.original)
  assert.equal(topic.usage.responseStatus, 502)
  assert.equal(topic.call.outcome, 'succeeded_unusable')
  const report = await f.run({ caseName: 'english-groups', execute: true })
  assert.equal(report.errorCode, undefined)
  assert.equal(report.adapterCalls, 1)
  assert.equal(report.maxAdapterCalls, 1)
  assert.equal(report.reports.length, 2)
  assert.equal(report.reports[0].adapterCalls, 0)
  assert.equal(report.reports[0].saved.httpStatus, 502)
  assert.equal(report.reports[0].savedOutcomeVerified, null)
  assert.equal(report.reports[0].archiveObservation.state, 'valid_overflow_response')
  assert.equal(report.reports[0].archiveObservation.acquiredCount, 21)
  assert.equal(report.reports[0].archiveObservation.overflowCount, 1)
  assert.equal(report.reports[0].archiveObservation.deliveryEstablished, false)
  assert.deepEqual(report.archiveValidatedGroups, ['english_topics'])
  assert.deepEqual(report.succeededGroups, ['english_events'])
  assert.deepEqual(report.rejectedGroups, [])
  assert.deepEqual(structuredClone(topic), before)
  assert.deepEqual(f.original, original)
  assert.equal(f.sent.length, 2)
  assert.equal(decodeURIComponent(f.sent[1].pathname.slice('/search/'.length)), GROUP_CASES.english_events.query)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${POST}|do-not-follow`))
  const again = await f.run({ caseName: 'english-groups', execute: true })
  assert.equal(again.adapterCalls, 0)
  assert.deepEqual(again.archiveValidatedGroups, ['english_topics'])
  assert.equal(f.sent.length, 2)
  assert.deepEqual(structuredClone(topic), before)
})

test('a newly acquired event overflow is observed offline and replayed without pretending either raw failure was delivered', async () => {
  const f = await fixture({ outcome: 'overflow' })
  await seedGroupTopic(f)
  const report = await f.run({ caseName: 'english-groups', execute: true })
  assert.equal(report.errorCode, undefined)
  assert.equal(report.adapterCalls, 1)
  assert.deepEqual(report.archiveValidatedGroups, ['english_topics', 'english_events'])
  assert.deepEqual(report.succeededGroups, [])
  assert.deepEqual(report.rejectedGroups, [])
  assert.equal(report.reports[1].errorCode, 'social_upstream_response_unusable')
  for (const row of report.reports) {
    assert.equal(row.saved.httpStatus, 502)
    assert.equal(row.savedOutcomeVerified, null)
    assert.equal(row.archiveObservation.acquiredCount, 21)
    assert.equal(row.archiveObservation.deliveryEstablished, false)
  }
  const saved = structuredClone([...f.usage.requests.values()]), calls = structuredClone([...f.platform.calls.values()])
  assert.equal((await f.run({ caseName: 'english-groups', execute: true })).adapterCalls, 0)
  assert.deepEqual([...f.usage.requests.values()], saved)
  assert.deepEqual([...f.platform.calls.values()], calls)
  assert.equal(f.sent.length, 2)
})

test('an active endpoint quarantine still blocks the event even after topic archive overflow is verified', async () => {
  const f = await fixture({ outcome: 'overflow' })
  await seedGroupTopic(f, { historical: false })
  const report = await f.run({ caseName: 'english-groups', execute: true })
  assert.equal(report.errorCode, 'external_platform_response_unusable')
  assert.equal(report.stoppedAfter, 'english_events')
  assert.deepEqual(report.archiveValidatedGroups, ['english_topics'])
  assert.equal(report.adapterCalls, 0)
  assert.equal(f.sent.length, 1)
})

test('archive verification fails closed for missing, damaged, excessive, malformed or non-overflow responses', async () => {
  const replacePayload = (archive, payload) => {
    archive.bodyBytes = Buffer.from(payload)
    archive.bodySize = archive.bodyBytes.length
    archive.bodySha256 = createHash('sha256').update(archive.bodyBytes).digest('hex')
  }
  for (const corrupt of [
    (f) => { f.platform.restrictedResponseArchives.clear() },
    (_f, row) => { row.archive.bodySha256 = '0'.repeat(64) },
    (_f, row) => { row.archive.bodySize++ },
    (_f, row) => { row.archive.bodySize = 4 * 1024 * 1024 + 1 },
    (_f, row) => { row.archive.bodyBytes = null },
    (_f, row) => { row.archive.capturedAt = 'invalid-date' },
    (_f, row) => { replacePayload(row.archive, '{invalid json') },
    (_f, row) => { replacePayload(row.archive, '{"errors":[{"message":"supplier error"}],"entries":[]}') },
    (_f, row) => { replacePayload(row.archive, '{"entries":[]}') },
    (_f, row) => { replacePayload(row.archive, '{"entries":[],"unsafe":"\\u0000"}') },
    (_f, row) => { replacePayload(row.archive, '{"unrecognized":[]}') },
  ]) {
    const f = await fixture({ outcome: 'overflow' }), topic = await seedGroupTopic(f)
    corrupt(f, topic)
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.stoppedAfter, 'english_topics')
    assert.equal(report.reports[0].savedOutcomeVerified, null)
    assert.notEqual(report.reports[0].archiveObservation?.state, 'valid_overflow_response')
    assert.deepEqual(report.archiveValidatedGroups, [])
    assert.equal(f.sent.length, 1)
  }
})

test('archive overflow never overrides an unknown, mismatched input, ownership, call identity or different saved failure', async () => {
  for (const corrupt of [
    row => { row.usage.status = 'unknown' },
    row => { row.usage.status = 'released' },
    row => { row.usage.apiKeyId = randomUUID() },
    row => { row.usage.acquisitionRequest.body.query = 'different' },
    row => { row.usage.acquisitionRequest.body.pageSize = 21 },
    row => { row.usage.acquisitionRequest.body.cursor = 'cursor' },
    row => { row.usage.acquisitionRequest.body.params = { cursor: 'cursor' } },
    row => { row.usage.acquisitionRequest.path = '/api/v1/data/search' },
    row => { row.usage.responseBody.error.details.retryable = true },
    row => { row.usage.responseBody.error.details.outcome = 'unknown' },
    row => { row.usage.responseBody.error.details.upstreamStatus = 400 },
    row => { row.call.outcome = 'unknown' },
    row => { row.call.httpStatus = 400 },
    row => { row.call.apiKeyId = randomUUID() },
    row => { row.call.endpointVersion = 'unexpected' },
    (row, f) => { f.platform.calls.set(randomUUID(), { ...row.call, id: randomUUID() }) },
  ]) {
    const f = await fixture({ outcome: 'overflow' }), topic = await seedGroupTopic(f)
    corrupt(topic, f)
    const report = await f.run({ caseName: 'english-groups', execute: true })
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.stoppedAfter, 'english_topics')
    assert.deepEqual(report.archiveValidatedGroups, [])
    assert.equal(f.sent.length, 1)
    assert.equal(f.sql.some(text => text.includes('twitter-query-param:probe-archive')), false)
  }
})

test('overflow compatibility is observation-only for English groups and leaves the ordinary raw route strict', async () => {
  const f = await fixture({ outcome: 'overflow' }), result = await f.run({ caseName: 'control', execute: true })
  assert.equal(result.errorCode, 'social_upstream_response_unusable')
  assert.equal(result.httpStatus, 502)
  assert.equal(result.savedOutcomeVerified, null)
  assert.equal(result.archiveObservation, undefined)
  assert.equal(result.providerCalls[0].outcome, 'succeeded_unusable')
  assert.equal(f.sql.some(text => text.includes('twitter-query-param:probe-archive')), false)
  assert.equal(f.sent.length, 1)
})

test('event ordering preserves exact atoms, Boolean meaning and old keys without dispatching in dry-run', async () => {
  const ordered = '("update" OR "clarification" OR "response" OR "statement") -ad -marketing -repost'
  assert.equal(ORDER_CASES.events_order.query, GROUP_CASES.english_events.query)
  assert.equal(ORDER_CASES.events_order.providerQuery, ordered)
  assert.equal(ORDER_CASES.candidate_order.query, PROBE_CASES.candidate.query)
  assert.equal(ORDER_CASES.candidate_order.providerQuery, PROBE_CASES.candidate.query.replace(
    '("statement" OR "response" OR "clarification" OR "update")',
    '("update" OR "clarification" OR "response" OR "statement")'))
  assert.equal(ORDER_CASES.candidate_order.providerQuery.length, 257)
  const atoms = query => (query.match(/-?"[^"]+"|-[a-z]+/gu) || []).sort()
  for (const selected of Object.values(ORDER_CASES)) {
    assert.deepEqual(atoms(selected.providerQuery), atoms(selected.query))
    assert.notEqual(selected.idempotencyKey, GROUP_CASES.english_events.idempotencyKey)
    assert.notEqual(selected.idempotencyKey, PROBE_CASES.candidate.idempotencyKey)
  }
  const evaluate = (query, present) => [...query.matchAll(/\(([^()]*)\)|(-"[^"]+"|-[a-z]+)/gu)].every(match =>
    match[1] ? [...match[1].matchAll(/"([^"]+)"/gu)].some(atom => present.has(atom[1]))
      : !present.has(match[2].slice(1).replace(/^"|"$/gu, '')))
  const terms = ['statement', 'response', 'clarification', 'update', 'ad', 'marketing', 'repost']
  for (let bits = 0; bits < 2 ** terms.length; bits++) for (const chinese of [false, true]) for (const topic of [false, true]) {
    const present = new Set(terms.filter((_term, index) => bits & (1 << index)))
    if (chinese) present.add('外交')
    if (topic) present.add('diplomacy')
    for (const selected of Object.values(ORDER_CASES)) assert.equal(evaluate(selected.query, present), evaluate(selected.providerQuery, present))
  }
  assert.equal(GROUP_CASES.english_events.idempotencyKey, 'ops-twitter-group-4ab63c1b8204c5c155156ca674661666f587e5b362c21abb')
  const f = await fixture(), report = await f.run({ caseName: 'event-order' })
  assert.equal(report.case, 'event-order')
  assert.equal(report.mode, 'read_only')
  assert.equal(report.maxAdapterCalls, 2)
  assert.equal(report.adapterCalls, 0)
  assert.equal(report.reports.length, 2)
  assert.equal(f.creations(), 0)
  assert.equal(f.usage.requests.size, 0)
  assert.ok(report.reports.every(row => row.knownEvent.requestId === EVENT_RECEIPT.requestId
    && row.knownEvent.savedOutcomeVerified === 'rejected400'))
})

test('event-order dispatch pins both wire queries while retaining native saved identity and durable replay', async () => {
  const f = await fixture(), original = structuredClone(f.original), knownEvent = structuredClone(f.knownEvent)
  const report = await f.run({ caseName: 'event-order', execute: true })
  assert.equal(report.errorCode, undefined)
  assert.equal(report.adapterCalls, 2)
  assert.deepEqual(report.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
  for (const [index, name] of ['events_order', 'candidate_order'].entries()) {
    const selected = ORDER_CASES[name], result = report.reports[index]
    assert.equal(decodeURIComponent(f.sent[index].pathname.slice('/search/'.length)), selected.providerQuery)
    assert.deepEqual(Object.fromEntries(f.sent[index].searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
    const saved = [...f.usage.requests.values()].find(row => row.id === result.requestId)
    assert.equal(saved.acquisitionRequest.body.query, selected.query)
    assert.equal(result.preparedProviderQuery.querySha256, createHash('sha256').update(selected.providerQuery).digest('hex'))
    assert.equal(result.providerCalls.length, 1)
  }
  assert.equal(f.platform.calls.size, 2)
  const receipts = structuredClone([...f.usage.requests.values()]), calls = structuredClone([...f.platform.calls.values()])
  const again = await f.run({ caseName: 'event-order', execute: true })
  assert.equal(again.adapterCalls, 0)
  assert.deepEqual(again.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
  assert.equal(f.sent.length, 2)
  assert.deepEqual([...f.usage.requests.values()], receipts)
  assert.deepEqual([...f.platform.calls.values()], calls)
  assert.deepEqual(f.original, original)
  assert.deepEqual(f.knownEvent, knownEvent)
  assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${POST}|do-not-follow`))
})

test('event-order continuation stops for an event refusal, unknown or other failure and never retries it', async () => {
  for (const outcome of ['rejected', 'unknown', 'other-rejection']) {
    const f = await fixture({ outcome }), report = await f.run({ caseName: 'event-order', execute: true })
    assert.equal(report.adapterCalls, 1)
    assert.equal(report.reports.length, 1)
    assert.equal(report.stoppedAfter, 'events_order')
    assert.ok(report.errorCode)
    const again = await f.run({ caseName: 'event-order', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.equal(again.stoppedAfter, 'events_order')
    assert.equal(f.sent.length, 1)
  }
  const f = await fixture({ outcome: name => name === 'candidate_order' ? 'rejected' : 'success' })
  const report = await f.run({ caseName: 'event-order', execute: true })
  assert.equal(report.adapterCalls, 2)
  assert.equal(report.stoppedAfter, 'candidate_order')
  assert.equal(report.reports[1].savedOutcomeVerified, 'rejected400')
  assert.equal((await f.run({ caseName: 'event-order', execute: true })).adapterCalls, 0)
  assert.equal(f.sent.length, 2)
})

test('event-order requires the exact original event refusal, including its owner, key, body and sole call', async () => {
  for (const mutate of [
    f => { f.knownEvent.id = randomUUID() },
    f => { f.knownEvent.idempotency_key = 'different-key' },
    f => { f.knownEvent.status = 'unknown' },
    f => { f.knownEvent.response_body.error.details.retryable = true },
    f => { f.knownEvent.api_key_id = randomUUID() },
    f => { f.knownEvent.acquisition_request.body.query = ORDER_CASES.events_order.providerQuery },
    f => { f.knownEvent.acquisition_request.body.cursor = 'next-page' },
    f => { f.knownEvent.acquisition_request.body.pageSize = 10 },
    f => { f.knownEvent.acquisition_request.path = '/api/v1/data/search' },
    f => { f.eventCalls[0].id = randomUUID() },
    f => { f.eventCalls[0].api_key_id = randomUUID() },
    f => { f.eventCalls[0].http_status = 200 },
    f => { f.eventCalls[0].outcome = 'unknown' },
    f => { f.eventCalls.push({ ...f.eventCalls[0], id: randomUUID() }) },
    f => { f.eventCalls.length = 0 },
  ]) {
    const f = await fixture(); mutate(f)
    const report = await f.run({ caseName: 'event-order', execute: true })
    assert.equal(report.errorCode, 'known_event_unverified')
    assert.equal(report.stoppedAfter, 'events_order')
    assert.equal(report.adapterCalls, 0)
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
})

test('event-order cannot bypass running or unknown v2 bindings of either original native query', async () => {
  for (const selected of ['events_order', 'candidate_order']) for (const state of ['running', 'unknown']) {
    const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'original-order-native-identity', body: {
      platform: 'twitter', query: ORDER_CASES[selected].query, pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const report = await f.run({ caseName: 'event-order', execute: true })
    assert.equal(report.errorCode, state === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
    assert.equal(report.stoppedAfter, selected)
    assert.equal(report.adapterCalls, selected === 'events_order' ? 0 : 1)
    assert.equal(f.sent.length, selected === 'events_order' ? 0 : 1)
  }
})

test('event-order wire override rejects altered source conditions before HTTP dispatch', async () => {
  for (const name of ['events_order', 'candidate_order']) for (const change of [
    request => { request.query = ORDER_CASES[name].providerQuery },
    request => { request.endpointPath = '/search/different' },
    request => { request.providerCursor = 'cursor' },
    request => { request.upstreamQuery.count = 10 },
  ]) {
    const adapter = queryParamAdapter({ execute: async () => assert.fail('must not dispatch') }, name)
    const request = normalizeHubSocialRequest('search', { platform: 'twitter', query: ORDER_CASES[name].query, count: 20, sort: 'latest' })
    change(request)
    await assert.rejects(adapter.execute(request), /probe_request_mismatch/u)
  }
})

test('event-order observes fresh overflow without changing raw failures or bypassing endpoint quarantine', async () => {
  const f = await fixture({ outcome: 'overflow' })
  const first = await f.run({ caseName: 'event-order', execute: true })
  assert.equal(first.reports[0].archiveObservation.state, 'valid_overflow_response')
  assert.equal(first.reports[0].saved.httpStatus, 502)
  assert.equal(first.reports[0].savedOutcomeVerified, null)
  assert.equal(first.reports[0].archiveObservation.deliveryEstablished, false)
  assert.equal(first.reports[0].archiveObservation.overflowCooldownElapsed, false)
  assert.ok(Number.isFinite(Date.parse(first.reports[0].archiveObservation.overflowCooldownUntil)))
  assert.equal(first.stoppedAfter, 'events_order')
  assert.equal(first.errorCode, 'event_order_full_query_deferred')
  assert.equal(first.adapterCalls, 1)
  assert.equal(f.sent.length, 1)
  assert.equal(f.usage.requests.size, 1)
  assert.equal(f.creations(), 1)
  const saved = structuredClone([...f.usage.requests.values()])
  assert.equal((await f.run({ caseName: 'event-order', execute: true })).adapterCalls, 0)
  assert.deepEqual([...f.usage.requests.values()], saved)
  assert.equal(f.sent.length, 1)
  // The first phase did not consume the full-query key while quarantined.
  const eventCall = [...f.platform.calls.values()][0]
  eventCall.completedAt = new Date(Date.now() - 6 * 60_000).toISOString()
  const resumed = await f.run({ caseName: 'event-order', execute: true })
  assert.equal(resumed.adapterCalls, 1)
  assert.equal(resumed.reports.length, 2)
  assert.equal(resumed.reports[0].adapterCalls, 0)
  assert.equal(resumed.reports[0].archiveObservation.overflowCooldownElapsed, true)
  assert.equal(resumed.reports[1].archiveObservation.state, 'valid_overflow_response')
  assert.equal(f.usage.requests.size, 2)
  assert.equal(f.sent.length, 2)
  assert.deepEqual([...f.usage.requests.values()][0], saved[0])
})

test('event-order can use an aged overflow archive for eligibility before the first full-query attempt', async () => {
  const f = await fixture({ outcome: 'overflow' })
  const runtime = await f.createGatewayRuntime(() => {}, 'events_order')
  const body = { platform: 'twitter', query: ORDER_CASES.events_order.query, pageSize: 20 }
  await assert.rejects(runtime.gateway.searchRaw(f.context, { body,
    normalized: { platform: 'twitter', upstreamBody: body, pageSize: 20 },
    idempotencyKey: ORDER_CASES.events_order.idempotencyKey }), { code: 'social_upstream_response_unusable' })
  const eventCall = [...f.platform.calls.values()][0]
  // Model an earlier event-only probe after its normal quarantine has expired.
  // The test does not delete a failed full-query receipt or alter its key.
  eventCall.completedAt = new Date(Date.now() - 6 * 60_000).toISOString()
  const eventUsage = structuredClone([...f.usage.requests.values()][0])
  const second = await f.run({ caseName: 'event-order', execute: true })
  assert.equal(second.adapterCalls, 1)
  assert.equal(second.reports.length, 2)
  assert.equal(second.reports[0].adapterCalls, 0)
  for (const row of second.reports) {
    assert.equal(row.archiveObservation.state, 'valid_overflow_response')
    assert.equal(row.savedOutcomeVerified, null)
    assert.equal(row.saved.httpStatus, 502)
    assert.equal(row.archiveObservation.acquiredCount, 21)
    assert.equal(row.archiveObservation.deliveryEstablished, false)
  }
  assert.deepEqual([...f.usage.requests.values()][0], eventUsage)
  const saved = structuredClone([...f.usage.requests.values()])
  assert.equal((await f.run({ caseName: 'event-order', execute: true })).adapterCalls, 0)
  assert.deepEqual([...f.usage.requests.values()], saved)
  assert.equal(f.sent.length, 2)
})

test('event-order does not promote a corrupted or unknown overflow receipt to full-query eligibility', async () => {
  for (const corrupt of [
    f => { f.platform.restrictedResponseArchives.clear() },
    f => { [...f.platform.restrictedResponseArchives.values()][0].bodySha256 = '0'.repeat(64) },
    f => { [...f.usage.requests.values()][0].status = 'unknown' },
    f => { [...f.platform.calls.values()][0].apiKeyId = randomUUID() },
  ]) {
    const f = await fixture({ outcome: 'overflow' })
    const createGatewayRuntime = async (...args) => {
      const runtime = await f.createGatewayRuntime(...args), searchRaw = runtime.gateway.searchRaw.bind(runtime.gateway)
      runtime.gateway.searchRaw = async (...queryArgs) => {
        try { return await searchRaw(...queryArgs) } finally { corrupt(f) }
      }
      return runtime
    }
    const report = await runTwitterQueryParamProbe({ pool: f.pool, createGatewayRuntime, caseName: 'event-order', execute: true })
    assert.equal(report.stoppedAfter, 'events_order')
    assert.equal(report.adapterCalls, 1)
    assert.equal(report.reports.length, 1)
    assert.notEqual(report.reports[0].archiveObservation?.state, 'valid_overflow_response')
    assert.equal((await f.run({ caseName: 'event-order', execute: true })).adapterCalls, 0)
    assert.equal(f.sent.length, 1)
  }
})

test('event-order overflow delay requires both valid completion time and database observation time', async () => {
  for (const observedAt of [() => null, () => 'invalid-date', () => '2026-01-01T00:00:00Z']) {
    const f = await fixture({ outcome: 'overflow', observedAt })
    const report = await f.run({ caseName: 'event-order', execute: true })
    assert.equal(report.reports[0].archiveObservation.state, 'valid_overflow_response')
    assert.equal(report.reports[0].archiveObservation.overflowCooldownElapsed, false)
    assert.equal(report.errorCode, 'event_order_full_query_deferred')
    assert.equal(report.reports.length, 1)
    assert.equal(f.sent.length, 1)
    assert.equal(f.usage.requests.size, 1)
  }
  for (const completedAt of [null, 'invalid-date']) {
    const f = await fixture({ outcome: 'overflow' })
    await f.run({ caseName: 'event-order', execute: true })
    const call = [...f.platform.calls.values()][0]
    call.completedAt = completedAt
    const report = await f.run({ caseName: 'event-order', execute: true })
    assert.equal(report.reports[0].archiveObservation.overflowCooldownElapsed, false)
    assert.equal(report.errorCode, 'event_order_full_query_deferred')
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.reports.length, 1)
    assert.equal(f.sent.length, 1)
    assert.equal(f.usage.requests.size, 1)
  }
})

test('event-term probes preserve exact atoms and exclusions with distinct keys, and dry-run never constructs a runtime', async () => {
  assert.deepEqual(Object.keys(TERM_CASES), ['events_pair_a', 'events_pair_b', 'event_statement', 'event_response', 'event_clarification', 'event_update'])
  assert.deepEqual(Object.values(TERM_CASES).map(row => row.query), [
    '("statement" OR "response") -ad -marketing -repost',
    '("clarification" OR "update") -ad -marketing -repost',
    '"statement" -ad -marketing -repost', '"response" -ad -marketing -repost',
    '"clarification" -ad -marketing -repost', '"update" -ad -marketing -repost',
  ])
  const oldKeys = Object.values({ ...PROBE_CASES, ...HALF_CASES, ...AND_CASES, ...GROUP_CASES, ...ORDER_CASES }).map(row => row.idempotencyKey)
  const keys = Object.values(TERM_CASES).map(row => row.idempotencyKey)
  assert.equal(new Set(keys).size, 6)
  assert.ok(keys.every(key => !oldKeys.includes(key)))
  assert.equal(ORDER_CASES.events_order.idempotencyKey, 'ops-twitter-order-cd4d17e0dc1d9988d65482334578ed273b33d358067d7641')
  const f = await fixture(), report = await f.run({ caseName: 'event-terms' })
  assert.equal(report.case, 'event-terms')
  assert.equal(report.mode, 'read_only')
  assert.equal(report.maxAdapterCalls, 6)
  assert.deepEqual(report.reports.map(row => row.case), ['events_pair_a', 'events_pair_b'])
  assert.equal(report.adapterCalls, 0)
  assert.equal(f.creations(), 0)
  assert.equal(f.usage.requests.size, 0)
  assert.ok(report.reports.every(row => row.knownOrder.requestId === ORDER_RECEIPT.requestId
    && row.knownOrder.savedOutcomeVerified === 'rejected400'))
})

test('event-term matrix uses two, four or six acquisitions and splits only confirmed rejected pairs without full-query dispatch', async () => {
  for (const rejectedPairs of [[], ['events_pair_a'], ['events_pair_b'], ['events_pair_a', 'events_pair_b']]) {
    const f = await fixture({ outcome: name => rejectedPairs.includes(name) ? 'rejected' : 'success' })
    const original = structuredClone(f.original), order = structuredClone(f.knownOrder)
    const report = await f.run({ caseName: 'event-terms', execute: true })
    const expected = ['events_pair_a', 'events_pair_b',
      ...(rejectedPairs.includes('events_pair_a') ? ['event_statement', 'event_response'] : []),
      ...(rejectedPairs.includes('events_pair_b') ? ['event_clarification', 'event_update'] : [])]
    assert.equal(report.errorCode, undefined)
    assert.equal(report.adapterCalls, expected.length)
    assert.equal(report.maxAdapterCalls, 6)
    assert.deepEqual(report.reports.map(row => row.case), expected)
    assert.equal(f.sent.length, expected.length)
    assert.equal(f.platform.calls.size, expected.length)
    assert.equal(f.platform.restrictedResponseArchives.size, expected.length)
    for (const [index, name] of expected.entries()) {
      const row = report.reports[index]
      assert.equal(decodeURIComponent(f.sent[index].pathname.slice('/search/'.length)), TERM_CASES[name].query)
      assert.deepEqual(Object.fromEntries(f.sent[index].searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
      assert.equal(row.savedOutcomeVerified, rejectedPairs.includes(name) ? 'rejected400' : 'success')
      assert.equal(row.acquisitionScope, 'diagnostic_provider_page')
      assert.equal(row.deliveryEstablished, false)
      assert.equal(row.hasMore, undefined)
      assert.equal(row.itemCount, undefined)
      assert.equal(row.nextCursor, undefined)
      if (!rejectedPairs.includes(name)) assert.equal(row.acquiredCount, 1)
    }
    const receipts = structuredClone([...f.usage.requests.values()]), calls = structuredClone([...f.platform.calls.values()])
    const repeated = await f.run({ caseName: 'event-terms', execute: true })
    assert.equal(repeated.adapterCalls, 0)
    assert.deepEqual(repeated.reports.map(row => row.case), expected)
    assert.equal(f.sent.length, expected.length)
    assert.deepEqual([...f.usage.requests.values()], receipts)
    assert.deepEqual([...f.platform.calls.values()], calls)
    assert.deepEqual(f.original, original)
    assert.deepEqual(f.knownOrder, order)
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${POST}|do-not-follow`))
  }
})

test('confirmed single-word refusals remain diagnostic evidence and do not exceed the six-call matrix', async () => {
  const f = await fixture({ outcome: 'rejected' }), report = await f.run({ caseName: 'event-terms', execute: true })
  assert.equal(report.errorCode, undefined)
  assert.equal(report.adapterCalls, 6)
  assert.equal(report.reports.length, 6)
  assert.ok(report.reports.every(row => row.savedOutcomeVerified === 'rejected400'))
  assert.equal((await f.run({ caseName: 'event-terms', execute: true })).adapterCalls, 0)
  assert.equal(f.sent.length, 6)
})

test('new event-term diagnostics accept whole 21 and 22 item provider pages without quarantining the subsequent probe', async () => {
  const f = await fixture({ outcome: name => name === 'events_pair_a' ? 'overflow' : 'overflow22' })
  const report = await f.run({ caseName: 'event-terms', execute: true })
  assert.equal(report.errorCode, undefined)
  assert.equal(report.adapterCalls, 2)
  assert.deepEqual(report.reports.map(row => row.acquiredCount), [21, 22])
  assert.deepEqual(report.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
  assert.ok(report.reports.every(row => row.saved.httpStatus === 200 && row.hasMore === undefined
    && row.itemCount === undefined && row.deliveryEstablished === false))
  assert.ok([...f.platform.calls.values()].every(call => call.outcome === 'succeeded'))
  assert.equal(f.platform.restrictedResponseArchives.size, 2)
  const again = await f.run({ caseName: 'event-terms', execute: true })
  assert.equal(again.adapterCalls, 0)
  assert.deepEqual(again.reports.map(row => row.acquiredCount), [21, 22])
  assert.equal(f.sent.length, 2)
  const raw = await fixture({ outcome: 'overflow' })
  const old = await raw.run({ caseName: 'control', execute: true })
  assert.equal(old.httpStatus, 502)
  assert.equal(old.errorCode, 'social_upstream_response_unusable')
  assert.equal(old.providerCalls[0].outcome, 'succeeded_unusable')
})

test('only new event-term and proxy adapter handoffs enable full-page parsing, with original wire count and a one-call bound', async () => {
  for (const name of [...Object.keys(TERM_CASES), ...Object.keys(PROXY_CASES), 'control', 'english_topics', 'events_order']) {
    const selected = TERM_CASES[name] || PROXY_CASES[name] || PROBE_CASES[name] || GROUP_CASES[name] || ORDER_CASES[name]
    const sent = [], adapter = queryParamAdapter({ execute: async request => { sent.push(request); return {} } }, name)
    const request = normalizeHubSocialRequest('search', { platform: 'twitter', query: selected.query, count: 20, sort: 'latest' })
    await adapter.execute(request)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].standardSearch === true, Object.hasOwn(TERM_CASES, name) || Object.hasOwn(PROXY_CASES, name))
    assert.equal(sent[0].allowOverflow === true, Object.hasOwn(TERM_CASES, name) || Object.hasOwn(PROXY_CASES, name))
    assert.equal(sent[0].upstreamQuery.count, 20)
    assert.equal(sent[0].upstreamQuery.category, 'Top')
    await assert.rejects(adapter.execute(request), /probe_call_limit/u)
    assert.equal(sent.length, 1)
  }
})

test('event-term diagnostics stop unknown, 5xx and unusable pages at either pair or single term without redispatching them', async () => {
  for (const outcome of ['unknown', 'other-rejection', 'unusable']) for (const stopAt of ['events_pair_a', 'events_pair_b', 'event_statement']) {
    const f = await fixture({ outcome: name => name === stopAt ? outcome : name === 'events_pair_a' ? 'rejected' : 'success' })
    const report = await f.run({ caseName: 'event-terms', execute: true })
    const expectedCount = ['events_pair_a', 'events_pair_b', 'event_statement'].indexOf(stopAt) + 1
    assert.equal(report.stoppedAfter, stopAt)
    assert.ok(report.errorCode)
    assert.equal(report.adapterCalls, expectedCount)
    assert.equal(report.reports.length, expectedCount)
    const repeated = await f.run({ caseName: 'event-terms', execute: true })
    assert.equal(repeated.adapterCalls, 0)
    assert.equal(repeated.stoppedAfter, stopAt)
    assert.equal(f.sent.length, expectedCount)
  }
})

test('event-term diagnostics require the owned order-refusal receipt and cannot infer permission from missing or mismatched evidence', async () => {
  for (const mutate of [
    f => { f.knownOrder.id = randomUUID() }, f => { f.knownOrder.status = 'unknown' },
    f => { f.knownOrder.idempotency_key = 'different-key' }, f => { f.knownOrder.api_key_id = randomUUID() },
    f => { f.knownOrder.acquisition_request.body.query = ORDER_CASES.events_order.providerQuery },
    f => { f.knownOrder.acquisition_request.body.cursor = 'old-cursor' },
    f => { f.knownOrder.acquisition_request.body.pageSize = 50 },
    f => { f.knownOrder.response_body.error.details.retryable = true },
    f => { f.orderCalls[0].id = randomUUID() }, f => { f.orderCalls[0].api_key_id = randomUUID() },
    f => { f.orderCalls[0].outcome = 'unknown' }, f => { f.orderCalls[0].http_status = 200 },
    f => { f.orderCalls.length = 0 }, f => { f.orderCalls.push({ ...f.orderCalls[0], id: randomUUID() }) },
  ]) {
    const f = await fixture(); mutate(f)
    const report = await f.run({ caseName: 'event-terms', execute: true })
    assert.equal(report.errorCode, 'known_order_unverified')
    assert.equal(report.adapterCalls, 0)
    assert.equal(report.stoppedAfter, 'events_pair_a')
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
})

test('event-term diagnostics retain current grant, policy and running or unknown v2 protection for their exact selected query', async () => {
  for (const options of [{ grant: false }, { enabled: false }]) {
    const f = await fixture(options), report = await f.run({ caseName: 'event-terms', execute: true })
    assert.ok(report.errorCode)
    assert.equal(report.adapterCalls, 0)
    assert.equal(f.sent.length, 0)
  }
  for (const state of ['running', 'unknown']) for (const name of ['events_pair_a', 'events_pair_b', 'event_statement']) {
    const f = await fixture({ outcome: part => part === 'events_pair_a' ? 'rejected' : 'success' })
    const protocol = new SearchProtocolStore(f.usage)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'existing-term-identity', body: {
      platform: 'twitter', query: TERM_CASES[name].query, pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const report = await f.run({ caseName: 'event-terms', execute: true })
    assert.equal(report.errorCode, state === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
    assert.equal(report.stoppedAfter, name)
    assert.equal(report.adapterCalls, ['events_pair_a', 'events_pair_b', 'event_statement'].indexOf(name))
  }
})

test('a returned 200 without an owned confirmed single-call receipt never advances the event-term matrix', async () => {
  for (const corrupt of [
    f => { [...f.usage.requests.values()][0].status = 'unknown' },
    f => { [...f.usage.requests.values()][0].acquisitionRequest.body.query = 'different' },
    f => { [...f.platform.calls.values()][0].outcome = 'unknown' },
    f => { [...f.platform.calls.values()][0].apiKeyId = randomUUID() },
    f => { f.platform.calls.clear() },
  ]) {
    const f = await fixture()
    const createGatewayRuntime = async (...args) => {
      const runtime = await f.createGatewayRuntime(...args), searchRaw = runtime.gateway.searchRaw.bind(runtime.gateway)
      runtime.gateway.searchRaw = async (...queryArgs) => { const result = await searchRaw(...queryArgs); corrupt(f); return result }
      return runtime
    }
    const report = await runTwitterQueryParamProbe({ pool: f.pool, createGatewayRuntime, caseName: 'event-terms', execute: true })
    assert.equal(report.reports[0].httpStatus, 200)
    assert.equal(report.reports[0].savedOutcomeVerified, null)
    assert.equal(report.stoppedAfter, 'events_pair_a')
    assert.equal(report.adapterCalls, 1)
    assert.equal((await f.run({ caseName: 'event-terms', execute: true })).adapterCalls, 0)
    assert.equal(f.sent.length, 1)
  }
})

test('host proxy cases preserve update and full candidate predicates with new keys and no dry-run network', async () => {
  assert.equal(HOST_PROXY_URL, 'http://127.0.0.1:7788')
  assert.equal(PROXY_CASES.update_proxy.query, '"update" -ad -marketing -repost')
  assert.equal(PROXY_CASES.update_proxy.query, TERM_CASES.event_update.query)
  assert.equal(PROXY_CASES.candidate_proxy.query, PROBE_CASES.candidate.query)
  const oldKeys = Object.values({ ...PROBE_CASES, ...HALF_CASES, ...AND_CASES, ...GROUP_CASES, ...ORDER_CASES, ...TERM_CASES }).map(row => row.idempotencyKey)
  assert.ok(Object.values(PROXY_CASES).every(row => !oldKeys.includes(row.idempotencyKey)))
  assert.notEqual(PROXY_CASES.update_proxy.idempotencyKey, PROXY_CASES.candidate_proxy.idempotencyKey)
  const f = await fixture(), report = await f.run({ caseName: 'host-proxy' })
  assert.equal(report.mode, 'read_only')
  assert.equal(report.maxAdapterCalls, 2)
  assert.equal(report.adapterCalls, 0)
  assert.deepEqual(report.reports.map(row => row.case), ['update_proxy', 'candidate_proxy'])
  assert.ok(report.reports.every(row => row.knownUpdate.requestId === UPDATE_RECEIPT.requestId
    && row.knownUpdate.savedOutcomeVerified === 'rejected400'))
  assert.equal(f.creations(), 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.usage.requests.size, 0)
})

test('host proxy accepts update before sending the unchanged full predicate, retains whole paid pages and replays without runtime creation', async () => {
  for (const outcome of ['success', 'overflow27']) {
    const f = await fixture({ outcome }), before = structuredClone(f.original), update = structuredClone(f.knownUpdate)
    const report = await f.run({ caseName: 'host-proxy', execute: true })
    assert.equal(report.errorCode, undefined)
    assert.equal(report.adapterCalls, 2)
    assert.equal(report.maxAdapterCalls, 2)
    assert.deepEqual(report.reports.map(row => row.savedOutcomeVerified), ['success', 'success'])
    for (const [index, name] of ['update_proxy', 'candidate_proxy'].entries()) {
      const row = report.reports[index]
      assert.equal(decodeURIComponent(f.sent[index].pathname.slice('/search/'.length)), PROXY_CASES[name].query)
      assert.deepEqual(Object.fromEntries(f.sent[index].searchParams), { count: '20', category: 'Top', includeTimestamp: 'false' })
      assert.equal(row.acquisitionScope, 'diagnostic_provider_page')
      assert.equal(row.deliveryEstablished, false)
      assert.equal(row.acquiredCount, outcome === 'overflow27' ? 27 : 1)
      assert.equal(row.hasMore, undefined)
      assert.equal(row.itemCount, undefined)
      assert.equal(row.nextCursor, undefined)
      assert.equal(row.transport.scope, 'diagnostic_process_only')
      assert.equal(row.transport.selectedProxy, HOST_PROXY_URL)
      const saved = [...f.usage.requests.values()].find(usage => usage.id === row.requestId)
      assert.equal(saved.acquisitionRequest.body.query, PROXY_CASES[name].query)
    }
    assert.equal(f.platform.calls.size, 2)
    assert.equal(f.platform.restrictedResponseArchives.size, 2)
    const calls = structuredClone([...f.platform.calls.values()]), usages = structuredClone([...f.usage.requests.values()])
    const again = await f.run({ caseName: 'host-proxy', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.equal(f.creations(), 2)
    assert.equal(f.sent.length, 2)
    assert.ok(again.reports.every(row => row.transport === undefined))
    assert.deepEqual(again.reports.map(row => row.acquiredCount), [outcome === 'overflow27' ? 27 : 1, outcome === 'overflow27' ? 27 : 1])
    assert.deepEqual([...f.platform.calls.values()], calls)
    assert.deepEqual([...f.usage.requests.values()], usages)
    assert.deepEqual(f.original, before)
    assert.deepEqual(f.knownUpdate, update)
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${SECRET}|${POST}|do-not-follow`))
  }
})

test('host proxy refuses to send the full query after rejected, unknown or unparseable update and never retries saved results', async () => {
  for (const outcome of ['rejected', 'unknown', 'other-rejection', 'unusable']) {
    const f = await fixture({ outcome }), report = await f.run({ caseName: 'host-proxy', execute: true })
    assert.equal(report.stoppedAfter, 'update_proxy')
    assert.ok(report.errorCode)
    assert.equal(report.adapterCalls, 1)
    assert.equal(report.reports.length, 1)
    const again = await f.run({ caseName: 'host-proxy', execute: true })
    assert.equal(again.adapterCalls, 0)
    assert.equal(again.stoppedAfter, 'update_proxy')
    assert.equal(f.creations(), 1)
    assert.equal(f.sent.length, 1)
  }
  const f = await fixture({ outcome: name => name === 'candidate_proxy' ? 'unknown' : 'success' })
  const report = await f.run({ caseName: 'host-proxy', execute: true })
  assert.equal(report.stoppedAfter, 'candidate_proxy')
  assert.equal(report.adapterCalls, 2)
  assert.equal(report.reports[1].saved.status, 'unknown')
  assert.equal((await f.run({ caseName: 'host-proxy', execute: true })).adapterCalls, 0)
  assert.equal(f.sent.length, 2)
})

test('host proxy requires exact original update refusal, owner, key and sole owned provider call', async () => {
  for (const mutate of [
    f => { f.knownUpdate.id = randomUUID() }, f => { f.knownUpdate.idempotency_key = 'different-key' },
    f => { f.knownUpdate.status = 'unknown' }, f => { f.knownUpdate.api_key_id = randomUUID() },
    f => { f.knownUpdate.acquisition_request.body.query = 'update' },
    f => { f.knownUpdate.acquisition_request.body.cursor = 'cursor' },
    f => { f.knownUpdate.acquisition_request.body.pageSize = 50 },
    f => { f.knownUpdate.response_body.error.details.retryable = true },
    f => { f.knownUpdate.response_body.error.details.upstreamStatus = 500 },
    f => { f.updateCalls[0].id = randomUUID() }, f => { f.updateCalls[0].api_key_id = randomUUID() },
    f => { f.updateCalls[0].outcome = 'unknown' }, f => { f.updateCalls[0].http_status = 200 },
    f => { f.updateCalls.length = 0 }, f => { f.updateCalls.push({ ...f.updateCalls[0], id: randomUUID() }) },
  ]) {
    const f = await fixture(); mutate(f)
    const report = await f.run({ caseName: 'host-proxy', execute: true })
    assert.equal(report.errorCode, 'known_update_unverified')
    assert.equal(report.stoppedAfter, 'update_proxy')
    assert.equal(report.adapterCalls, 0)
    assert.equal(f.creations(), 0)
    assert.equal(f.sent.length, 0)
  }
})

test('changing proxy cannot bypass running or unknown v2 identity for update or the full query', async () => {
  for (const state of ['running', 'unknown']) for (const name of ['update_proxy', 'candidate_proxy']) {
    const f = await fixture(), protocol = new SearchProtocolStore(f.usage)
    const lease = await protocol.begin(f.context, { version: 2, idempotencyKey: 'preexisting-proxy-comparison-identity', body: {
      platform: 'twitter', query: PROXY_CASES[name].query, pageSize: 20, type: 'stable',
      timeWindow: { from: '2026-10-17T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' },
    } })
    if (state === 'unknown') await protocol.finish(lease.input, { state, usageRequestId: randomUUID() })
    const report = await f.run({ caseName: 'host-proxy', execute: true })
    assert.equal(report.errorCode, state === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress')
    assert.equal(report.stoppedAfter, name)
    assert.equal(report.adapterCalls, name === 'update_proxy' ? 0 : 1)
    assert.equal(f.sent.length, name === 'update_proxy' ? 0 : 1)
  }
  for (const options of [{ grant: false }, { enabled: false }]) {
    const f = await fixture(options), report = await f.run({ caseName: 'host-proxy', execute: true })
    assert.ok(report.errorCode)
    assert.equal(report.adapterCalls, 0)
    assert.equal(f.sent.length, 0)
  }
})

test('the host-proxy full-query continuation requires an owned saved update success instead of just a returned 200', async () => {
  for (const corrupt of [
    f => { [...f.usage.requests.values()][0].status = 'unknown' },
    f => { [...f.usage.requests.values()][0].acquisitionRequest.body.query = 'different' },
    f => { [...f.platform.calls.values()][0].outcome = 'unknown' },
    f => { [...f.platform.calls.values()][0].apiKeyId = randomUUID() },
    f => { f.platform.calls.clear() },
  ]) {
    const f = await fixture()
    const createGatewayRuntime = async (...args) => {
      const runtime = await f.createGatewayRuntime(...args), searchRaw = runtime.gateway.searchRaw.bind(runtime.gateway)
      runtime.gateway.searchRaw = async (...queryArgs) => { const result = await searchRaw(...queryArgs); corrupt(f); return result }
      return runtime
    }
    const report = await runTwitterQueryParamProbe({ pool: f.pool, createGatewayRuntime, caseName: 'host-proxy', execute: true })
    assert.equal(report.reports[0].httpStatus, 200)
    assert.equal(report.reports[0].savedOutcomeVerified, null)
    assert.equal(report.stoppedAfter, 'update_proxy')
    assert.equal(report.adapterCalls, 1)
    assert.equal((await f.run({ caseName: 'host-proxy', execute: true })).adapterCalls, 0)
    assert.equal(f.sent.length, 1)
  }
})

test('host-proxy preparation reads normal routing once, redacts credentials and fixes only its private fetch to 7788', async () => {
  let routeReads = 0, selectedRoute, factoryCalls = 0
  const route = { source: 'override', proxyUrls: ['http://user:private-proxy-password@other-proxy:7890'], directFallback: true,
    fingerprint: 'normal-route', probePolicy: { attempts: 5 } }
  const original = structuredClone(route)
  const fetchImpl = () => assert.fail('preparation cannot send network requests')
  const result = await prepareHostProxyTransport({ proxyEndpointLabel, createRapidApiProxyFetch: store => {
    factoryCalls++
    selectedRoute = store.route()
    return fetchImpl
  } }, { route: async () => { routeReads++; return route }, update: () => assert.fail('no binding write allowed') })
  assert.equal(routeReads, 1)
  assert.equal(factoryCalls, 1)
  assert.equal(result.fetchImpl, fetchImpl)
  const pinned = await selectedRoute
  assert.deepEqual(pinned.proxyUrls, [HOST_PROXY_URL])
  assert.equal(pinned.directFallback, false)
  assert.deepEqual(pinned.probePolicy, { attempts: 1, timeoutMs: 15000, cacheTtlMs: 0 })
  assert.equal(result.diagnosticTransport.scope, 'diagnostic_process_only')
  assert.equal(result.diagnosticTransport.selectedProxy, HOST_PROXY_URL)
  assert.deepEqual(result.diagnosticTransport.currentConfiguredRoute, { source: 'override', proxyEndpoints: ['http://other-proxy:7890'], directFallback: true })
  assert.match(result.diagnosticTransport.comparisonLimit, /historical/i)
  assert.doesNotMatch(JSON.stringify(result.diagnosticTransport), /user|private-proxy-password/u)
  assert.deepEqual(route, original)
})

test('fixed host-proxy transport sends an unauthenticated reachability probe and at most one credentialed business call, with no fallback', async () => {
  for (const outcome of ['success', 'refusal', 'transport-error', 'probe-failure']) {
    const requests = [], agents = []
    const prepared = await prepareHostProxyTransport({ proxyEndpointLabel,
      createRapidApiProxyFetch: store => createRapidApiProxyFetch(store, {
        makeAgent: url => { const agent = { url, close: async () => {} }; agents.push(agent); return agent },
        fetchImpl: async (url, init) => {
          const target = new URL(url); requests.push({ target, init })
          if (target.pathname === '/') return Response.json({}, { status: outcome === 'probe-failure' ? 503 : 401 })
          if (outcome === 'transport-error') throw new Error('synthetic transport error')
          return Response.json({}, { status: outcome === 'refusal' ? 400 : 200 })
        },
      }) }, { route: async () => ({ source: 'system', proxyUrls: [], directFallback: true }) })
    const request = prepared.fetchImpl('https://twitter-aio.p.rapidapi.com/search/%22update%22', {
      method: 'GET', redirect: 'error', headers: { 'x-rapidapi-key': SECRET, 'x-rapidapi-host': 'twitter-aio.p.rapidapi.com' },
    })
    if (outcome === 'transport-error' || outcome === 'probe-failure') await assert.rejects(request)
    else assert.equal((await request).status, outcome === 'refusal' ? 400 : 200)
    assert.equal(requests.length, outcome === 'probe-failure' ? 1 : 2)
    assert.equal(requests[0].target.href, 'https://twitter-aio.p.rapidapi.com/')
    assert.equal(requests[0].init.headers, undefined)
    assert.equal(requests[0].init.redirect, 'error')
    if (outcome !== 'probe-failure') assert.equal(requests[1].init.headers['x-rapidapi-key'], SECRET)
    assert.ok(requests.every(row => row.init.dispatcher.url === HOST_PROXY_URL))
    assert.equal(agents.length, 1)
    assert.doesNotMatch(JSON.stringify(prepared.diagnosticTransport), new RegExp(SECRET))
  }
})

test('CLI requires an explicit reviewed case before importing database modules or reading credentials', () => {
  const file = fileURLToPath(new URL('../../server/ops/verify-twitter-query-param.mjs', import.meta.url))
  for (const args of [['--execute'], ['--case=arbitrary', '--execute'], ['--case=control', '--case=candidate']]) {
    const result = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH,
      DATABASE_URL: 'postgres://must-not-connect.invalid/probe', MX_INSIGHT_RAPIDAPI_API_KEY: SECRET } })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).errorCode, 'invalid_arguments')
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-connect|offline-provider-secret/u)
  }
})

test('stdin import is pure while the actual stdin script remains executable', () => {
  const url = new URL('../../server/ops/verify-twitter-query-param.mjs', import.meta.url)
  const env = { PATH: process.env.PATH, DATABASE_URL: 'postgres://must-not-connect.invalid/probe', MX_TWITTER_QUERY_PARAM_VERIFY: '1' }
  const imported = spawnSync(process.execPath, ['--input-type=module', '-'], { encoding: 'utf8', env,
    input: `const m = await import(${JSON.stringify(url.href)}); console.log(m.REVISION);` })
  assert.equal(imported.status, 0)
  assert.equal(imported.stdout.trim(), 'twitter-query-param-check.v8')
  assert.equal(imported.stderr, '')
  const entry = spawnSync(process.execPath, ['--input-type=module', '-', '--execute'], { encoding: 'utf8', env,
    input: readFileSync(url, 'utf8') })
  assert.equal(entry.status, 1)
  assert.equal(JSON.parse(entry.stdout).errorCode, 'invalid_arguments')
  assert.doesNotMatch(imported.stdout + imported.stderr + entry.stdout + entry.stderr, /must-not-connect/u)
})
