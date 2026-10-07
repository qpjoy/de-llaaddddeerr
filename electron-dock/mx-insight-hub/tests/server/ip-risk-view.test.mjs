import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIpRiskInput, ipRiskRows, ipRiskFailureRows, ipRiskBatchRows, filterIpRiskRows, ipRiskCsv, ipRiskSummary, riskTone } from '../../src/ip-risk-view.js'
import { ipRiskExample, ipRiskBatchExample } from '../../server/contracts/ip-risk-docs.mjs'

const result = payload => ({ payload, localId: 'test', status: 200, elapsedMs: 25, receivedAt: '2026-10-01T00:00:00.000Z', request: { ip: '1.1.1.1' } })
test('IP product input preserves duplicate/order, bounds batches and rejects ambiguous IPv4', () => {
  const parsed = parseIpRiskInput('1.1.1.1，8.8.8.8\n1.1.1.1;0.0.0.0', true)
  assert.equal(parsed.valid, true)
  assert.deepEqual(parsed.body.ips, ['1.1.1.1', '8.8.8.8', '1.1.1.1', '0.0.0.0'])
  assert.equal(parsed.duplicateCount, 1)
  for (const value of ['', '1.01.1.1', '256.1.1.1', '::1', 'example.com', '1.1.1.1/24', '1.1.1.1 8.8.8.8']) assert.equal(parseIpRiskInput(value).valid, false, value)
  assert.equal(parseIpRiskInput(Array(101).fill('1.1.1.1').join('\n'), true).valid, false)
  assert.equal(parseIpRiskInput(Array(100).fill('1.1.1.1').join('\n'), true).valid, true)
  assert.match(parseIpRiskInput('1.1.1.1\ninvalid\n8.8.8.8', true).message, /第 2 项/)
})
test('IP portrait preserves zero, nullable fields, original label times and nonstandard scores', () => {
  const envelope = structuredClone(ipRiskExample)
  envelope.data.data.risk_score = 910
  envelope.data.data.human_probability_percent = null
  const [row] = ipRiskRows(result(envelope))
  assert.equal(row.status, 'success')
  assert.equal(row.profile.rapid_rotation_probability_percent, 0)
  assert.equal(row.profile.risk_score, 910)
  assert.equal(row.profile.human_probability_percent, null)
  assert.match(ipRiskSummary(row), /秒拨概率：0%/)
  assert.match(ipRiskSummary(row), /真人概率：未提供/)
  assert.match(ipRiskSummary(row), /2024-05-10 12:17:26/)
  assert.equal(riskTone('定制评级'), 'neutral')
})
test('IP batch HTTP 200 distinguishes child outcomes, IDs, duplicates and replay', () => {
  const payload = structuredClone(ipRiskBatchExample)
  payload.meta.sourceMode = 'idempotent_replay'
  payload.data.push(
    { index: 2, ip: '1.1.1.1', status: 200, response: { ...ipRiskExample, data: { ip: '1.1.1.1', status: 'no_data', data: null, warnings: [] } } },
    { index: 3, ip: '2.2.2.2', status: 502, response: { requestId: 'unknown-request', error: { code: 'ip_query_outcome_unknown' } } },
    { index: 4, ip: '3.3.3.3', status: 504, error: { code: 'batch_deadline_not_dispatched' } },
    { index: 5, ip: '4.4.4.4', status: 502, response: { error: { code: 'ip_response_unusable' } } },
  )
  const rows = ipRiskRows(result(payload))
  assert.deepEqual(rows.map(row => row.status), ['success', 'limited', 'no_data', 'unknown', 'not_dispatched', 'unknown'])
  assert.equal(rows[3].requestId, 'unknown-request')
  assert.equal(rows[0].batchId, payload.batchId)
  assert.equal(rows[0].sourceMode, 'idempotent_replay')
  assert.notEqual(rows[0].id, rows[2].id)
  assert.equal(rows[2].profile, null)
})
test('IP network/auth/balance errors and whole-batch unknown retain reconciliation identity', () => {
  const [network] = ipRiskFailureRows(new TypeError('Failed to fetch'), { ip: '1.1.1.1' }, 'n', '')
  assert.equal(network.status, 'unknown')
  const rows = ipRiskFailureRows({ status: 409, code: 'batch_pending_or_unknown', details: { batchId: 'pending-batch' } }, { ips: ['1.1.1.1', '1.1.1.1'] }, 'b', '')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.status === 'unknown' && row.batchId === 'pending-batch'))
  for (const status of [500, 502, 503, 504]) {
    assert.equal(ipRiskFailureRows({ status }, { ip: '1.1.1.1' }, 'proxy', '')[0].status, 'unknown')
  }
  for (const [status, expected] of [[401, 'expired'], [402, 'balance'], [403, 'forbidden'], [429, 'limited'], [503, 'unavailable']]) {
    assert.equal(ipRiskFailureRows({ status, code: status === 503 ? 'ip_risk_unavailable' : undefined }, { ip: '1.1.1.1' }, 'e', '')[0].status, expected)
  }
})
test('batch navigation keeps input order, duplicates, failed items and original submission boundaries', () => {
  const payload = structuredClone(ipRiskBatchExample)
  payload.data.push({ ...payload.data[0], index: 2 })
  const first = ipRiskRows(result(payload))
  const replay = ipRiskRows({ ...result(payload), localId: 'replay' })
  const single = ipRiskRows({ ...result(ipRiskExample), localId: 'single' })
  const history = [...single, ...replay, ...first]
  assert.deepEqual(ipRiskBatchRows(history, first[1]).map(row => row.id), first.map(row => row.id))
  assert.deepEqual(ipRiskBatchRows(history, replay[2]).map(row => row.id), replay.map(row => row.id))
  assert.equal(first[2].ip, first[0].ip)
  assert.notEqual(first[2].id, first[0].id)
  assert.equal(first[0].batchSize, 3)
  assert.deepEqual(ipRiskBatchRows(history, single[0]), [])
  assert.deepEqual(ipRiskBatchRows([], undefined), [])
  const retained = first.slice(1)
  assert.equal(ipRiskBatchRows(retained, retained[0]).length, 2)
  assert.equal(retained[0].batchSize, 3, 'original batch size survives bounded history eviction')
  const failed = ipRiskFailureRows(new TypeError('network loss'), { ips: ['1.1.1.1', '8.8.8.8'] }, 'failure', '')
  assert.deepEqual(ipRiskBatchRows([...failed, ...history], failed[0]), failed)
})
test('IP local filters/CSV preserve tags and zeroes, and neutralize spreadsheet formulas', () => {
  const payload = structuredClone(ipRiskExample)
  payload.data.data.proxy_type = '=HYPERLINK("https://example.com")'
  const rows = ipRiskRows(result(payload))
  assert.equal(filterIpRiskRows(rows, '高危设备', 'success', '中风险').length, 1)
  assert.equal(filterIpRiskRows(rows, 'not-present').length, 0)
  const csv = ipRiskCsv(rows)
  assert.ok(csv.startsWith('\ufeff'))
  assert.match(csv, /'=HYPERLINK/)
  assert.match(csv, /,"0","51",/)
  assert.match(csv, /highRiskDevice/)
  assert.match(csv, /2024-05-10 12:17:26/)
})

test('Baidu throttling and pause are definite service states, not unknown paid outcomes',()=>{
  for(const code of ['ip_channel_rate_limited','ip_channel_cooling','ip_channel_daily_limit','ip_channel_busy'])assert.equal(ipRiskFailureRows({status:502,code},{ip:'1.1.1.1'},'fixture','')[0].status,'limited')
  assert.equal(ipRiskFailureRows({status:502,code:'ip_channel_paused'},{ip:'1.1.1.1'},'fixture','')[0].status,'unavailable')
})
