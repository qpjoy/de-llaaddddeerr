import assert from 'node:assert/strict'
import test from 'node:test'
import { lookupRequestDiagnostics } from '../../server/acquisitions/diagnostics.mjs'

const id = 'a227f54a-0ac6-43f5-9d23-687fc369f2ae'
function fixture({ status = 'released', responseStatus = 502, errorCode = 'enterprise_query_rejected', hasResponseBody = true, gateway = null, providers, connectors = [], matches = [{ id }], fail } = {}) {
  const queries = []
  let released = false
  const pool = { async connect() { return {
    async query(sql, params) {
      queries.push({ sql, params })
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/)
      if (fail && sql.includes('request-diagnostics:usage')) throw Object.assign(new Error('secret connection data'), { code: fail })
      if (sql.includes('request-diagnostics:lookup')) return { rows: matches }
      if (sql.includes('request-diagnostics:usage')) return { rows: [{ id: params[0], platform: 'enterprise', status, error_code: errorCode, response_status: responseStatus, has_response_body: hasResponseBody, units_actual: 0, delivery_source_mode: 'live', response_body: { secret: 'hidden' } }] }
      if (sql.includes('request-diagnostics:gateway')) return { rows: gateway ? [gateway] : [] }
      if (sql.includes('request-diagnostics:providers')) return { rows: providers || [{ id: 'call', provider_key: 'qixin', outcome: 'rejected', http_status: 200, business_code: 105, reviewed_message: '未授权调用该接口', has_restricted_archive: true, billed: null, cost_kind: 'estimated', cost_minor: '15', currency: 'CNY', raw_payload: { secret: 'hidden' } }] }
      if (sql.includes('request-diagnostics:connectors')) return { rows: connectors }
      if (sql.includes('request-diagnostics:charges')) return { rows: [{ status: 'released', enforcement_mode: 'enforced', charged_minor: '0', quoted_minor: '15', currency: 'CNY', pricing_snapshot: 'hidden' }] }
      return { rows: [] }
    },
    release() { released = true },
  } } }
  return { pool, queries, released: () => released }
}

test('released requests expose reviewed rejection and zero charge without requiring successful replay', async () => {
  const f = fixture()
  const result = await lookupRequestDiagnostics(f.pool, id)
  const run = result.runs[0]
  assert.equal(run.replayAvailable, false)
  assert.equal(run.hasResponseBody, true)
  assert.equal(run.providerCalls[0].message, '未授权调用该接口')
  assert.equal(run.providerCalls[0].billed, null)
  assert.equal(run.customerCharge.chargedMinor, '0')
  assert.match(run.guidance, /拒绝接口授权/)
  assert.doesNotMatch(JSON.stringify(result), /hidden|raw_payload|response_body|pricing_snapshot/)
  assert.equal(f.queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(f.queries.at(-1).sql, 'COMMIT')
  assert.ok(f.released())
})

test('upstream identifiers use exact parameterized lookup and may match several Hub requests', async () => {
  const f = fixture({ matches: [{ id }, { id: '49711b2c-766c-410c-b646-37047e4656b0' }] })
  const result = await lookupRequestDiagnostics(f.pool, ' req_mucfct0c_30fe37b5 ')
  assert.equal(result.runs.length, 2)
  const lookup = f.queries.find(q => q.sql.includes('request-diagnostics:lookup'))
  assert.deepEqual(lookup.params, ['req_mucfct0c_30fe37b5', null])
  assert.match(lookup.sql, /upstream_request_id = \$1/)
  assert.doesNotMatch(lookup.sql, /ILIKE|response_body|::text/)
})

test('confirmed JustOne 301 explains collection failure without exposing upstream text or assuming customer billing', async () => {
  const providers = [{ id: 'call', provider_key: 'justone', outcome: 'rejected',
    http_status: 200, business_code: 301, error_code: 'upstream_collection_failed',
    billed: false, reviewed_message: 'private-token upstream text', has_restricted_archive: true }]
  const { runs: [run] } = await lookupRequestDiagnostics(fixture({ status: 'committed', providers }).pool, id)
  assert.match(run.guidance, /301（采集失败）/u)
  assert.match(run.guidance, /只读历史查询/u)
  assert.match(run.guidance, /POST.*各接口幂等规则与回放窗口限制/u)
  assert.match(run.guidance, /同一幂等标识也可能重新采集并再次计费/u)
  assert.match(run.guidance, /客户扣费分别查看/u)
  assert.equal(run.providerCalls[0].billed, false)
  assert.equal(run.providerCalls[0].message, null)
  assert.doesNotMatch(JSON.stringify(run), /private-token|upstream text/u)
  for (const mismatched of [
    { ...providers[0], provider_key: 'another-provider' },
    { ...providers[0], business_code: 500 },
    { ...providers[0], error_code: 'upstream_internal_error' },
  ]) {
    const result = await lookupRequestDiagnostics(fixture({ providers: [mismatched] }).pool, id)
    assert.doesNotMatch(result.runs[0].guidance, /301（采集失败）/u)
  }
  const unknown = await lookupRequestDiagnostics(fixture({ status: 'unknown', providers }).pool, id)
  assert.match(unknown.runs[0].guidance, /未知调用结果/u)
})

test('TikHub HTTP 400 explains failed delivery without inventing a parameter or billing cause', async () => {
  const providers = [{ id: 'call', provider_key: 'tikhub', operation: 'social.posts.search',
    outcome: 'rejected', http_status: 400, business_code: null,
    error_code: 'upstream_request_rejected', upstream_request_id: null,
    billed: null, reviewed_message: 'private supplier message', has_restricted_archive: true }]
  const run = (await lookupRequestDiagnostics(fixture({ status: 'committed', providers }).pool, id)).runs[0]
  assert.match(run.guidance, /已保存失败响应/u)
  assert.match(run.guidance, /不能确定是参数问题还是上游内部错误/u)
  assert.match(run.guidance, /计费未知不等于免费/u)
  assert.match(run.guidance, /只读历史查询/u)
  assert.match(run.guidance, /POST.*各接口幂等规则与回放窗口限制/u)
  assert.match(run.guidance, /同一幂等标识也可能重新采集并再次计费/u)
  assert.equal(run.replayAvailable, true)
  assert.equal(run.providerCalls[0].businessCode, null)
  assert.equal(run.providerCalls[0].upstreamRequestId, null)
  assert.equal(run.providerCalls[0].billed, null)
  assert.doesNotMatch(JSON.stringify(run), /private supplier message/u)
  const fallback = (await lookupRequestDiagnostics(fixture({ status: 'committed', responseStatus: 200, providers }).pool, id)).runs[0]
  assert.doesNotMatch(fallback.guidance, /已保存失败响应/u)
  assert.match(fallback.guidance, /存量回退/u)
  const unknown = (await lookupRequestDiagnostics(fixture({ status: 'unknown', providers }).pool, id)).runs[0]
  assert.match(unknown.guidance, /未知调用结果/u)
})

test('committed error responses are distinguished from successful deliveries without changing replay', async () => {
  const failure = (await lookupRequestDiagnostics(fixture({ status: 'committed', providers: [] }).pool, id)).runs[0]
  assert.match(failure.guidance, /已保存失败响应/u)
  assert.match(failure.guidance, /只读历史查询/u)
  assert.match(failure.guidance, /POST.*各接口幂等规则与回放窗口限制/u)
  assert.match(failure.guidance, /同一幂等标识也可能重新采集并再次计费/u)
  assert.equal(failure.replayAvailable, true)
  const success = (await lookupRequestDiagnostics(fixture({ status: 'committed', responseStatus: 200, providers: [] }).pool, id)).runs[0]
  assert.doesNotMatch(success.guidance, /已保存失败响应/u)
  assert.equal(success.replayAvailable, true)
})

test('arbitrary archive messages never cross the diagnostic boundary; unknown outcomes remain unknown', async () => {
  const f = fixture({ status: 'unknown', providers: [{ id: 'call', provider_key: 'qixin', outcome: 'unknown', reviewed_message: 'appkey=SECRET https://private.test', has_restricted_archive: true }] })
  const run = (await lookupRequestDiagnostics(f.pool, id)).runs[0]
  assert.equal(run.providerCalls[0].message, null)
  assert.equal(run.providerCalls[0].messageEvidence, 'restricted_message_not_exposed')
  assert.match(run.guidance, /不自动重发/)
  assert.doesNotMatch(JSON.stringify(run), /SECRET|private.test/)
})

test('connector failures preserve correlation while committed fallback remains a submitted response', async () => {
  const f = fixture({ status: 'committed', providers: [], connectors: [{ id: 'connector', outcome: 'failed', error_code: 'night_all_http_502', upstream_request_id: 'req_abc_123', upstream_trace_id: 'trace_123', http_status: 502 }] })
  const run = (await lookupRequestDiagnostics(f.pool, id)).runs[0]
  assert.equal(run.replayAvailable, true)
  assert.equal(run.connectorCalls[0].upstreamRequestId, 'req_abc_123')
  assert.match(run.guidance, /正文未接入/)
})

test('diagnostics exposes a projected connector error chain without raw fields from stored JSON', async () => {
  const f = fixture({ providers: [], connectors: [{ id: 'connector', failure_evidence: {
    version: 1, requestId: 'req_nested', rawBody: 'SECRET',
    errors: [{ path: '$.error', code: 'TIKHUB_ALL_ENDPOINTS_FAILED', message: 'SECRET', headers: { token: 'SECRET' } }],
  } }] })
  const run = (await lookupRequestDiagnostics(f.pool, id)).runs[0]
  assert.equal(run.connectorCalls[0].failureEvidence.errors[0].code, 'TIKHUB_ALL_ENDPOINTS_FAILED')
  assert.match(run.guidance, /结构化错误链/)
  assert.doesNotMatch(JSON.stringify(run), /SECRET|rawBody|headers/)
})

test('missing records return empty results, and both match and call limits disclose truncation', async () => {
  assert.deepEqual((await lookupRequestDiagnostics(fixture({ matches: [] }).pool, id)).runs, [])
  const f = fixture({ matches: Array.from({ length: 21 }, () => ({ id })), providers: Array.from({ length: 51 }, (_, i) => ({ id: String(i) })) })
  const result = await lookupRequestDiagnostics(f.pool, id)
  assert.equal(result.runs.length, 20)
  assert.equal(result.truncated, true)
  assert.equal(result.runs[0].providerCalls.length, 50)
  assert.equal(result.runs[0].callsTruncated, true)
})

test('invalid input never accesses the database; errors roll back and release without revealing DB details', async () => {
  for (const value of ['', 'a/b', "x' OR 1=1", 'a'.repeat(192)]) {
    await assert.rejects(lookupRequestDiagnostics({ connect() { assert.fail('database accessed') } }, value), { status: 400 })
  }
  for (const fail of ['57014', '42501', '42P01']) {
    const f = fixture({ fail })
    await assert.rejects(lookupRequestDiagnostics(f.pool, id), error => error.status === 503 && !error.message.includes('secret'))
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
    assert.ok(f.released())
  }
})


test('historical Hub busy rejection uses gateway HTTP evidence without inventing a response or upstream limit', async () => {
  const gateway = { id: 'gateway', provider_key: 'qixin', source_mode: 'unavailable', succeeded: false,
    response_status: 429, error_code: 'external_platform_busy', provider_call_id: null }
  const options = { errorCode: 'external_platform_busy', responseStatus: null, hasResponseBody: false, providers: [], gateway }
  const f = fixture(options)
  const run = (await lookupRequestDiagnostics(f.pool, id)).runs[0]
  assert.equal(run.responseStatus, 429)
  assert.equal(run.responseStatusSource, 'gateway_request')
  assert.equal(run.hasResponseBody, false)
  assert.equal(run.replayAvailable, false)
  assert.equal(run.customerCharge.chargedMinor, '0')
  assert.match(run.guidance, /企业数据.*自身并发准入限制/u)
  assert.match(run.guidance, /不能据此认定供应商限流/u)
  assert.match(f.queries.find(q => q.sql.includes('request-diagnostics:gateway')).sql, /source_mode <> 'idempotent_replay'/u)
  for (const override of [
    { gateway: null }, { gateway: { ...gateway, provider_call_id: 'call' } },
    { providers: [{ id: 'call', outcome: 'unknown' }] },
    { gateway: { ...gateway, error_code: 'upstream_rate_limited' } },
    { status: 'committed', responseStatus: 200 },
  ]) {
    const result = (await lookupRequestDiagnostics(fixture({ ...options, ...override }).pool, id)).runs[0]
    assert.doesNotMatch(result.guidance, /未进入上游调用阶段/u)
    if (override.status === 'committed') {
      assert.equal(result.responseStatus, 200)
      assert.equal(result.responseStatusSource, 'usage_request')
    }
  }
})
