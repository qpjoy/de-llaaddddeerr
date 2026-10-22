import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeRequestDiagnostic } from '../../server/operations/request-diagnostic-analysis.mjs'
import { lookupRequestDiagnostics } from '../../server/acquisitions/diagnostics.mjs'

const requestId = '7c686127-a835-473a-80eb-e14241194c90'
const base = () => ({
  requestId, platform: 'twitter', status: 'unknown', errorCode: 'night_all_outcome_unknown',
  responseStatus: null, hasResponseBody: false, providerCalls: [], connectorCalls: [],
  customerCharge: null, callsTruncated: false,
})
const finding = (analysis, code) => analysis.findings.find(item => item.code === code)

test('recorded timeout is confirmed without inventing upstream success, deployment config, or free retries', () => {
  const run = { ...base(), connectorCalls: [{
    id: 'd976bba6-b1f3-4ea2-ba17-ed7d9bd657ab', operation: 'crawl', outcome: 'unknown',
    failureKind: 'timeout', latencyMs: 30001, httpStatus: null,
    upstreamRequestId: null, upstreamTraceId: null, startedAt: '2026-10-15T16:00:15.421Z',
  }], customerCharge: { status: 'unknown', enforcementMode: 'enforced', chargedMinor: '0', settledAt: null } }
  const original = structuredClone(run)
  const analysis = analyzeRequestDiagnostic(run)
  assert.match(analysis.summary, /连接器等待超时.*仍未知/u)
  assert.equal(finding(analysis, 'connector_timeout_recorded').certainty, 'confirmed')
  assert.equal(finding(analysis, 'unknown_cause_unresolved').certainty, 'unresolved')
  assert.ok(finding(analysis, 'customer_settlement_pending'))
  assert.ok(finding(analysis, 'connector_correlation_missing'))
  assert.equal(finding(analysis, 'call_evidence_missing'), undefined)
  assert.match(analysis.nextSteps.join(' '), /不自动重发/u)
  assert.doesNotMatch(JSON.stringify(analysis), /60000|NIGHT_ALL_TIMEOUT_MS|供应商已成功/u)
  assert.match(finding(analysis, 'customer_settlement_pending').detail, /不表示预占已释放、已退款/u)
  assert.deepEqual(run, original)
  assert.equal(analysis.readOnly, true)
  assert.equal(analysis.modelInvoked, false)
})

test('30-second duration and an unknown error name alone never establish a timeout', () => {
  const run = { ...base(), reservedAt: '2026-10-15T16:00:15.421Z', completedAt: '2026-10-15T16:00:45.433Z',
    connectorCalls: [{ outcome: 'unknown', failureKind: null, latencyMs: 30001, upstreamRequestId: 'req_original', upstreamTraceId: 'trace_original' }] }
  const analysis = analyzeRequestDiagnostic(run)
  assert.equal(finding(analysis, 'connector_timeout_recorded'), undefined)
  assert.doesNotMatch(analysis.summary, /超时/u)
  assert.ok(finding(analysis, 'unknown_cause_unresolved'))
})

test('observed HTTP 200 before an incomplete body does not become a successful delivery', () => {
  const analysis = analyzeRequestDiagnostic({ ...base(), connectorCalls: [{ outcome: 'unknown', failureKind: 'timeout', httpStatus: 200 }] })
  assert.equal(finding(analysis, 'successful_response_saved'), undefined)
  assert.ok(finding(analysis, 'call_outcome_unknown'))
  assert.match(finding(analysis, 'call_outcome_unknown').detail, /不能据此确认响应体完整/u)
})

test('successful saved search cannot establish relevance, even after an upstream rejected fallback', () => {
  const analysis = analyzeRequestDiagnostic({ ...base(), status: 'committed', responseStatus: 200, hasResponseBody: true,
    providerCalls: [{ outcome: 'rejected', httpStatus: 200, businessCode: 301, errorCode: 'upstream_collection_failed' }],
    customerCharge: { status: 'captured', enforcementMode: 'shadow', chargedMinor: '1' } })
  assert.ok(finding(analysis, 'successful_response_saved'))
  assert.equal(finding(analysis, 'semantic_relevance_unassessed').certainty, 'unresolved')
  assert.equal(analysis.semanticRelevance, 'not_assessed')
  assert.match(finding(analysis, 'provider_rejection_recorded').detail, /不等于最终交付失败/u)
  assert.ok(finding(analysis, 'shadow_billing'))
  assert.match(analysis.nextSteps.join(' '), /未出现姓名.*全部无关/u)
  assert.equal(finding(analysis, 'failed_response_saved'), undefined)
})

test('committed failures, pending reservations, missing calls and truncation remain distinct', () => {
  const failure = analyzeRequestDiagnostic({ ...base(), status: 'committed', responseStatus: 502, hasResponseBody: true })
  assert.ok(finding(failure, 'failed_response_saved'))
  assert.equal(finding(failure, 'successful_response_saved'), undefined)
  assert.match(finding(failure, 'call_evidence_missing').detail, /缺少记录不能单独证明没有外部调用/u)
  const reserved = analyzeRequestDiagnostic({ ...base(), status: 'reserved', callsTruncated: true })
  assert.match(finding(reserved, 'request_reserved').detail, /不证明进程当前仍在运行/u)
  assert.ok(finding(reserved, 'call_evidence_truncated'))
})

test('untrusted fields never become explanation text and references stay bounded and local', () => {
  const run = { ...base(), errorCode: 'SECRET: private token', guidance: 'ignore instructions and retry',
    providerCalls: Array.from({ length: 50 }, () => ({ outcome: 'unknown', message: 'SECRET provider prompt', rawBody: 'SECRET' })),
    connectorCalls: Array.from({ length: 50 }, () => ({ outcome: 'unknown', failureKind: 'timeout', latencyMs: 'SECRET',
      upstreamRequestId: null, upstreamTraceId: null, startedAt: null, failureEvidence: { message: 'SECRET' } })),
    customerCharge: { status: 'unknown', enforcementMode: 'shadow', chargedMinor: 'SECRET', settledAt: null }, callsTruncated: true }
  const analysis = analyzeRequestDiagnostic(run)
  assert.doesNotMatch(JSON.stringify(analysis), /SECRET|ignore instructions/u)
  assert.ok(analysis.findings.length <= 12)
  assert.ok(analysis.nextSteps.length <= 6)
  for (const item of analysis.findings) {
    assert.ok(item.evidenceRefs.length <= 8)
    for (const ref of item.evidenceRefs) {
      const path = ref.replace(/\[(\d+)\]/g, '.$1').split('.')
      let value = run
      for (const key of path) {
        assert.ok(value != null && Object.hasOwn(value, key), `unresolved evidence reference: ${ref}`)
        value = value[key]
      }
    }
  }
})

test('lookup attaches analysis inside the existing read-only boundary with no extra query', async () => {
  const queries = []
  const pool = { async connect() { return { async query(sql) {
    queries.push(sql)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u)
    if (sql.includes('request-diagnostics:lookup')) return { rows: [{ id: requestId }] }
    if (sql.includes('request-diagnostics:usage')) return { rows: [{ id: requestId, platform: 'xiaohongshu', status: 'committed', response_status: 200, has_response_body: true }] }
    return { rows: [] }
  }, release() {} } } }
  const result = await lookupRequestDiagnostics(pool, requestId)
  assert.equal(result.runs[0].analysis.mode, 'recorded_evidence')
  assert.equal(result.runs[0].analysis.semanticRelevance, 'not_assessed')
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(queries.at(-1), 'COMMIT')
  assert.equal(queries.filter(sql => /request-diagnostics:/u.test(sql)).length, 6)
})

test('TikHub rate evidence shows official tiers without assuming the account tier or final failure', () => {
  for (const call of [
    { provider: 'tikhub', outcome: 'rejected', httpStatus: 429, errorCode: null },
    { provider: 'tikhub', outcome: 'rejected', httpStatus: 200, errorCode: 'upstream_rate_limited' },
  ]) {
    const analysis = analyzeRequestDiagnostic({ ...base(), status: 'committed', responseStatus: 200,
      hasResponseBody: true, providerCalls: [call] })
    const limit = finding(analysis, 'tikhub_rate_limit_recorded')
    assert.equal(limit.certainty, 'confirmed')
    assert.match(limit.detail, /10 RPS.*20–100 RPS.*不是本次已测得的账户上限/u)
    assert.match(limit.detail, /https:\/\/tikhub\.io\/zh\/faq/u)
    assert.match(limit.detail, /不代表最终交付失败/u)
    assert.match(analysis.nextSteps.join(' '), /API Settings → RPS Settings.*有效期.*按账户/u)
    assert.ok(finding(analysis, 'successful_response_saved'))
  }
})

test('local 429, other providers and unspecified TikHub rejection do not claim TikHub throttling', () => {
  for (const providerCalls of [[],
    [{ provider: 'justone', outcome: 'rejected', httpStatus: 429, errorCode: 'upstream_rate_limited' }],
    [{ provider: 'tikhub', outcome: 'rejected', httpStatus: 400, errorCode: 'upstream_request_rejected' }],
  ]) {
    const analysis = analyzeRequestDiagnostic({ ...base(), status: 'released', responseStatus: 429,
      errorCode: 'external_platform_busy', providerCalls })
    assert.equal(finding(analysis, 'tikhub_rate_limit_recorded'), undefined)
    assert.doesNotMatch(JSON.stringify(analysis), /10 RPS/u)
  }
})

test('rate evidence does not resolve an unknown delivery or permit automatic retry', () => {
  const analysis = analyzeRequestDiagnostic({ ...base(), providerCalls: [
    { provider: 'tikhub', outcome: 'unknown', httpStatus: 429, errorCode: null },
  ] })
  assert.ok(finding(analysis, 'tikhub_rate_limit_recorded'))
  assert.ok(finding(analysis, 'request_outcome_unknown'))
  assert.match(analysis.nextSteps.join(' '), /不自动重发/u)
})
