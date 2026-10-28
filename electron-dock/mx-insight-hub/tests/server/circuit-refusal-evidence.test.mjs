import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { circuitOpenError, failureEvidence, openCircuitError, FAILURE_EVIDENCE_WINDOW_MS }
  from '../../server/external-platforms/availability-errors.mjs'
import { MemoryExternalPlatformStore, PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { lookupRequestDiagnostics } from '../../server/acquisitions/diagnostics.mjs'
import { searchAdmissionDispositionFixture, pgOptions } from '../fixtures/search-admission-disposition.mjs'

const config = { circuitFailureThreshold: 3, circuitOpenMs: 60000 }
const open = (lastErrorCode, extra = {}) => ({ circuitOpenUntil: new Date(Date.now() + 60000).toISOString(), lastErrorCode, ...extra })
const balance = { id: 'b23935f3-b09f-4975-ba19-da06ffa2af93', outcome: 'rejected', httpStatus: 200, businessCode: 601,
  errorCode: 'upstream_balance_exhausted', billed: false, marketplace: 'instagram',
  startedAt: '2026-10-28T12:05:36.208Z', completedAt: '2026-10-28T12:05:36.586Z' }

test('circuit refusals publish whose condition it is, the normalized reason and the recorded upstream codes', () => {
  const error = circuitOpenError(open('upstream_balance_exhausted'), config, 'protected', { evidence: failureEvidence(balance) })
  assert.equal(error.code, 'external_platform_circuit_open')
  assert.equal(error.details.cause, 'upstream')
  assert.equal(error.details.scope, 'shared_upstream')
  assert.equal(error.details.reason, 'upstream_balance_exhausted')
  assert.deepEqual(error.details.upstream, { errorCode: 'upstream_balance_exhausted', httpStatus: 200, businessCode: 601,
    outcome: 'rejected', billed: false, failedAt: '2026-10-28T12:05:36.586Z' })
  assert.equal(error.details.upstreamDispatched, false)
  const contract = circuitOpenError(open('invalid_upstream_contract'), config, 'protected', { scope: 'platform_contract' })
  assert.equal(contract.details.cause, 'hub_response_parsing')
  assert.equal(contract.details.reason, 'response_contract_unusable')
  assert.equal(contract.details.upstream, undefined)
  assert.equal(circuitOpenError(open('private supplier text'), config, 'protected').details.reason, 'upstream_failure')
  assert.equal(circuitOpenError(open('upstream_rate_limited', { internalCooldown: true }), config, 'protected').details.cause, 'hub_internal_cooldown')
})

test('failure evidence keeps only normalized codes and never stored text', () => {
  assert.equal(failureEvidence(null), null)
  const evidence = failureEvidence({ ...balance, errorCode: 'JustOne said: balance 0 for account 123' })
  assert.equal(evidence.errorCode, null)
  assert.equal(evidence.businessCode, 601)
  assert.equal(failureEvidence({ id: 'x', outcome: 'other', http_status: 'x', business_code: 1.5 }).outcome, null)
})

test('openCircuitError prefers the contract circuit, tolerates an unreadable ledger and is null when nothing is open', async () => {
  const state = open('upstream_balance_exhausted'), contract = open('invalid_upstream_contract')
  const asked = []
  const store = { latestFailureEvidence: async options => { asked.push(options); return failureEvidence(balance) } }
  const error = await openCircuitError({ store, state, contract, config, message: 'm', marketplace: 'instagram' })
  assert.equal(error.details.cause, 'hub_response_parsing')
  assert.deepEqual(asked, [{ marketplace: 'instagram', unusableOnly: true }])
  const failing = await openCircuitError({ store: { latestFailureEvidence: async () => { throw new Error('db down') } }, state, config, message: 'm' })
  assert.equal(failing.details.cause, 'upstream')
  assert.equal(failing.details.upstream, undefined)
  assert.equal(await openCircuitError({ store, state: { circuitOpenUntil: new Date(Date.now() - 1).toISOString() }, config, message: 'm' }), null)
})

test('memory store returns the latest failure within the window, filtered by platform and parse failures', async () => {
  const store = new MemoryExternalPlatformStore({ usageStore: { requests: new Map() }, providerKey: 'justone' })
  const at = offset => new Date(Date.now() - offset).toISOString()
  store.calls.set('old', { ...balance, id: 'old', startedAt: at(FAILURE_EVIDENCE_WINDOW_MS + 1000), completedAt: at(FAILURE_EVIDENCE_WINDOW_MS) })
  assert.equal(await store.latestFailureEvidence(), null)
  store.calls.set('ok', { id: 'ok', outcome: 'succeeded', marketplace: 'instagram', startedAt: at(1000), completedAt: at(900) })
  store.calls.set('taobao', { ...balance, id: 'taobao', marketplace: 'taobao', startedAt: at(5000), completedAt: at(4900) })
  store.calls.set('parse', { ...balance, id: 'parse', outcome: 'succeeded_unusable', errorCode: 'invalid_upstream_contract', startedAt: at(9000), completedAt: at(8900) })
  assert.equal((await store.latestFailureEvidence()).callId, 'taobao', 'a shared supplier circuit reports any platform')
  assert.equal((await store.latestFailureEvidence({ marketplace: 'instagram' })).callId, 'parse')
  assert.equal((await store.latestFailureEvidence({ marketplace: 'instagram', unusableOnly: true })).callId, 'parse')
  assert.equal(await store.latestFailureEvidence({ marketplace: 'taobao', unusableOnly: true }), null)
})

test('PostgreSQL latest-failure lookup reads the call ledger within the window', pgOptions, async t => {
  const f = await searchAdmissionDispositionFixture(t)
  const store = new PostgresExternalPlatformStore({ pool: f.pool, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const evidence = await store.latestFailureEvidence({ marketplace: 'twitter' })
  assert.equal(evidence.callId, f.callId)
  assert.equal(evidence.outcome, 'unknown')
  assert.equal(await store.latestFailureEvidence({ marketplace: 'twitter', unusableOnly: true }), null)
  assert.equal(await store.latestFailureEvidence({ before: new Date(Date.now() - FAILURE_EVIDENCE_WINDOW_MS - 60000) }), null)
})

function diagnosticsPool({ trigger }) {
  const queries = [], id = randomUUID()
  const pool = { async connect() { return {
    async query(sql, params) {
      queries.push({ sql, params })
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/)
      if (sql.includes('request-diagnostics:lookup')) return { rows: [{ id }] }
      if (sql.includes('request-diagnostics:usage')) return { rows: [{ id, platform: 'instagram', status: 'released', error_code: 'external_platform_circuit_open',
        response_status: null, has_response_body: false, delivery_source_mode: null, reserved_at: '2026-10-28T12:06:28.101Z', completed_at: '2026-10-28T12:06:28.119Z' }] }
      if (sql.includes('request-diagnostics:gateway')) return { rows: [{ id: randomUUID(), provider_key: 'justone', source_mode: 'circuit_rejected', succeeded: false,
        response_status: 503, error_code: 'external_platform_circuit_open', provider_call_id: null, created_at: '2026-10-28T12:06:28.119Z' }] }
      if (sql.includes('request-diagnostics:refusal')) return { rows: trigger ? [trigger] : [] }
      return { rows: [] }
    },
    release() {},
  } } }
  return { pool, queries, id }
}

test('Diagnostics Center explains a circuit refusal from the supplier failure recorded just before it', async () => {
  const f = diagnosticsPool({ trigger: { id: balance.id, outcome: 'rejected', http_status: 200, business_code: 601,
    error_code: 'upstream_balance_exhausted', billed: false, marketplace: 'instagram', started_at: balance.startedAt, completed_at: balance.completedAt } })
  const { runs: [run] } = await lookupRequestDiagnostics(f.pool, f.id)
  assert.equal(run.refusal.kind, 'circuit')
  assert.equal(run.refusal.cause, 'upstream')
  assert.equal(run.refusal.provider, 'justone')
  assert.equal(run.refusal.upstreamDispatched, false)
  assert.deepEqual({ ...run.refusal.trigger, failedAt: undefined }, { callId: balance.id, outcome: 'rejected', httpStatus: 200,
    businessCode: 601, errorCode: 'upstream_balance_exhausted', billed: false, marketplace: 'instagram', failedAt: undefined })
  assert.match(run.guidance, /供应商账户余额不足/u)
  assert.match(run.guidance, /业务码 601/u)
  assert.match(run.guidance, /上游问题/u)
  const refusalQuery = f.queries.find(q => q.sql.includes('request-diagnostics:refusal'))
  assert.deepEqual(refusalQuery.params, ['justone', '2026-10-28T12:06:28.119Z', FAILURE_EVIDENCE_WINDOW_MS / 1000])
  assert.equal(run.analysis.findings.some(finding => finding.code === 'circuit_refusal'), true)
  assert.equal(run.analysis.findings.some(finding => finding.code === 'call_evidence_missing'), false)
  assert.match(run.analysis.summary, /供应商连续失败/u)
})

test('Diagnostics Center attributes a parse-failure refusal to Hub and admits a missing trigger', async () => {
  const parse = diagnosticsPool({ trigger: { id: randomUUID(), outcome: 'succeeded_unusable', http_status: 200, business_code: 0,
    error_code: 'invalid_upstream_contract', billed: true, marketplace: 'instagram', started_at: balance.startedAt, completed_at: balance.completedAt } })
  const { runs: [hub] } = await lookupRequestDiagnostics(parse.pool, parse.id)
  assert.equal(hub.refusal.cause, 'hub_response_parsing')
  assert.match(hub.guidance, /Hub 侧问题/u)
  const none = diagnosticsPool({ trigger: null })
  const { runs: [missing] } = await lookupRequestDiagnostics(none.pool, none.id)
  assert.equal(missing.refusal.cause, null)
  assert.equal(missing.refusal.evidence, 'no_supplier_failure_in_window')
  assert.match(missing.guidance, /没有该供应商的失败调用/u)
})
