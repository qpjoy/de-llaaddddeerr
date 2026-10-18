import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { PROBE_CASES, HALF_CASES, ORIGINAL_REQUEST_ID, QUERY_PARAM_REQUEST_ID, CANDIDATE_REQUEST_IDS, runTwitterQueryParamProbe, queryParamAdapter } from '../../server/ops/verify-twitter-query-param.mjs'
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

const ORIGINAL_QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") AND NOT ("广告" OR "营销" OR "重复搬运") AND (("diplomacy" OR "foreign policy" OR "diplomatic relations") AND ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost)'
const SECRET = 'offline-provider-secret-do-not-print'
const POST = 'private supplier post must not enter the report'
const PEPPER = 'twitter-query-param-offline-fixture-pepper'
async function fixture({ grant = true, enabled = true, outcome = 'success' } = {}) {
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
  const controls = new MemoryExternalPlatformControlStore(), config = { ...rapidApiConfig(), configured: true, timeoutMs: 50 }
  if (enabled) await controls.updatePolicy('rapidapi', 'social.content.search', { expectedRevision: 1, desiredState: 'active', reason: 'Offline only',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-18T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { 'twitter-aio.search': 1 } } },
  { runtime: { config, credentialConfigured: true } })
  const platform = new MemoryExternalPlatformStore({ usageStore: usage, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const sent = [], sql = []
  const query = async (text, values) => {
    sql.push(text)
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
        tenant_id: row.tenantId, consumer_id: row.consumerId, api_key_id: row.apiKeyId, provider_key: row.providerKey,
        operation: row.operation, endpoint_key: row.endpointKey, endpoint_version: row.endpointVersion, contract_version: row.contractVersion,
        call_ordinal: row.callOrdinal, call_role: row.callRole })) }
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
      return Response.json({ entries: [{ content: { itemContent: { tweet_results: { result: {
        rest_id: '1', legacy: { full_text: POST },
      } } } } }, { content: { cursorType: 'Bottom', value: 'do-not-follow' } }] },
      { headers: { 'x-rapidapi-request-id': 'synthetic-upstream-1' } })
    } }), caseName, onDispatch)
    return { store: usage, guardDataSearchV1, gateway: new ExternalPlatformGateway({ usageStore: usage,
      platformStore: platform, adapter, config, providerKey: 'rapidapi', apiKeyPepper: PEPPER,
      operationControlStore: controls, reservationLeaseMs: 60000, logger: { warn() {} } }) }
  }
  return { pool, createGatewayRuntime, original, originalCall, knownCandidates, knownCalls, context, usage, platform, sent, sql,
    creations: () => runtimeCreations, run: options => runTwitterQueryParamProbe({ pool, createGatewayRuntime, ...options }) }
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
  assert.equal(imported.stdout.trim(), 'twitter-query-param-check.v2')
  assert.equal(imported.stderr, '')
  const entry = spawnSync(process.execPath, ['--input-type=module', '-', '--execute'], { encoding: 'utf8', env,
    input: readFileSync(url, 'utf8') })
  assert.equal(entry.status, 1)
  assert.equal(JSON.parse(entry.stdout).errorCode, 'invalid_arguments')
  assert.doesNotMatch(imported.stdout + imported.stderr + entry.stdout + entry.stderr, /must-not-connect/u)
})
