import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeRequestDiagnostic } from '../../server/operations/request-diagnostic-analysis.mjs'
import { DIAGNOSTIC_PLATFORMS, REDDIT_DIAGNOSTIC_ISSUES } from '../../shared/platform-diagnostic-catalog.mjs'

const call = { provider: 'tikhub', operation: 'native.t.reddit_app_fetch_dynamic_search',
  outcome: 'succeeded_unusable', httpStatus: 200, businessCode: 200, errorCode: 'invalid_content_search_contract', billed: true }
const run = { platform: 'reddit', status: 'committed', responseStatus: 502, hasResponseBody: true,
  errorCode: 'invalid_content_search_contract', providerCalls: [call], connectorCalls: [] }

test('Reddit parser failure prioritizes known categories without asserting uninspected widget content', () => {
  const before = structuredClone(run), analysis = analyzeRequestDiagnostic(run)
  assert.equal(analysis.platformAnalysis.issueIds[0], 'reddit_widget_telemetry')
  assert.equal(analysis.platformAnalysis.certainty, 'unresolved')
  assert.equal(analysis.platformAnalysis.issueIds.length, 4)
  assert.ok(analysis.findings.some(item => item.code === 'failed_response_saved'))
  assert.deepEqual(run, before)
  assert.equal(analysis.readOnly, true)
  assert.equal(analysis.modelInvoked, false)
})

test('specific Reddit evidence chooses notice, pagination, identity, rate limit and quarantine separately', () => {
  for (const [errorCode, expected] of [['upstream_search_error_message', ['reddit_search_notice']],
    ['contradictory_content_search_continuation', ['reddit_relay_pagination']],
    ['invalid_content_search_identity', ['reddit_unknown_widget']]]) {
    assert.deepEqual(analyzeRequestDiagnostic({ ...run, errorCode, providerCalls: [] }).platformAnalysis.issueIds, expected)
  }
  assert.deepEqual(analyzeRequestDiagnostic({ ...run, responseStatus: 429, errorCode: null,
    providerCalls: [{ ...call, httpStatus: 429, outcome: 'rejected', errorCode: 'upstream_rate_limited' }] }).platformAnalysis.issueIds,
  ['reddit_upstream_failure'])
  const quarantine = analyzeRequestDiagnostic({ ...run, status: 'released', responseStatus: 409,
    errorCode: 'external_platform_pre_dispatch_failed', providerCalls: [] })
  assert.deepEqual(quarantine.platformAnalysis.issueIds, ['reddit_response_quarantine'])
  assert.equal(quarantine.platformAnalysis.certainty, 'unresolved')
  assert.ok(quarantine.findings.some(item => item.code === 'call_evidence_missing'))
})

test('non-Reddit platforms never inherit Reddit rules and future platform entries remain usable generic guides', () => {
  for (const platform of ['facebook', 'instagram', 'youtube', 'twitter', 'unknown']) {
    assert.equal(analyzeRequestDiagnostic({ ...run, platform }).platformAnalysis, null)
  }
  assert.equal(new Set(DIAGNOSTIC_PLATFORMS.map(row => row.id)).size, DIAGNOSTIC_PLATFORMS.length)
  assert.deepEqual(DIAGNOSTIC_PLATFORMS.filter(row => row.specialized).map(row => row.id), ['reddit'])
  assert.equal(new Set(REDDIT_DIAGNOSTIC_ISSUES.map(row => row.id)).size, REDDIT_DIAGNOSTIC_ISSUES.length)
})

test('successful fallback and unrelated or arbitrary evidence never become an asserted Reddit failure', () => {
  const analysis = analyzeRequestDiagnostic({ ...run, responseStatus: 200, errorCode: null })
  assert.ok(analysis.findings.some(item => item.code === 'successful_response_saved'))
  assert.equal(analysis.platformAnalysis.certainty, 'unresolved')
  const untrusted = analyzeRequestDiagnostic({ ...run, errorCode: 'SECRET', providerCalls: [
    { ...call, operation: 'other', message: 'SECRET' }, { ...call, provider: 'other', rawBody: 'SECRET' }] })
  assert.deepEqual(untrusted.platformAnalysis.issueIds, [])
  assert.doesNotMatch(JSON.stringify(untrusted.platformAnalysis), /SECRET/u)
})
