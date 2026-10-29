import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { diagnoseProviderCircuit } from '../../server/ops/diagnose-provider-circuit.mjs'

const requestId = '0a92d464-e219-4a26-8db6-b2dd2a237490'
const secret = 'private-query-credential-customer-body'
function fixture({ privateValues = false } = {}) {
  const queries = []
  let released = false
  const pool = { async connect() { return { async query(sql, params) {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/u)
    const row = { id: randomUUID(), provider_key: 'tikhub', status: 'released', response_status: 503,
      error_code: 'external_platform_circuit_open', source_mode: 'circuit_rejected', saved_search_provider: null,
      reserved_at: new Date('2026-10-29T03:48:03.350Z'), completed_at: new Date('2026-10-29T03:48:03.360Z'),
      observed_at: new Date('2026-10-29T04:00:00Z'), created_at: new Date('2026-10-29T03:48:03.360Z'),
      consecutive_failures: 3, circuit_open_until: new Date('2026-10-29T03:48:07.795Z'), open_now: false,
      last_error_code: 'invalid_content_search_contract', last_failure_at: new Date('2026-10-29T03:47:07.795Z'), updated_at: new Date(),
      marketplace: 'douyin', operation: 'native.t.douyin_search_fetch_video_search_v1', endpoint_key: 'native.t.douyin_search_fetch_video_search_v1',
      outcome: 'succeeded_unusable', http_status: 200, business_code: 200, billed: true,
      started_at: new Date('2026-10-29T03:47:03Z'), completed_before_target: true,
      mode: 'fixed', primary_provider: 'tikhub', fallback_provider: null, revision: 1 }
    if (privateValues) for (const key of Object.keys(row)) row[key] = secret
    if (sql.includes('provider-circuit:usage')) return { rows: [{ ...row, platform: privateValues ? secret : 'xiaohongshu',
      has_contract_circuits: true, has_search_routes: true }] }
    if (sql.includes('provider-circuit:nearby')) return { rows: [{ ...row, error_code: privateValues ? secret : 'invalid_content_search_contract' }] }
    if (/provider-circuit:(gateways|states|contracts|policy)/u.test(sql)) return { rows: [row] }
    return { rows: [] }
  }, release() { released = true } } } }
  return { pool, queries, get released() { return released } }
}

test('provider circuit diagnostic works for any platform and names Hub-side failures near the refusal', async () => {
  const db = fixture()
  const result = await diagnoseProviderCircuit(db.pool, requestId)
  assert.equal(result.diagnosticRevision, 'provider-circuit-diagnostic.v1')
  assert.equal(result.platform, 'xiaohongshu')
  assert.deepEqual(result.historical.gatewayProviders, ['tikhub'])
  assert.equal(result.current.providerCircuits[0].lastErrorCode, 'invalid_content_search_contract')
  const [failure] = result.nearbyHistoricalFailures
  assert.equal(failure.marketplace, 'douyin')
  assert.equal(failure.endpoint, 'native.t.douyin_search_fetch_video_search_v1')
  assert.equal(failure.errorCode, 'invalid_content_search_contract')
  assert.equal(failure.completedBeforeTarget, true)
  assert.deepEqual(db.queries.find(row => row.sql.includes('provider-circuit:contracts')).params, [['tikhub'], 'xiaohongshu'])
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  for (const query of db.queries) assert.doesNotMatch(query.sql, /SELECT\s+\*|response_body|body_bytes|tenant_id|consumer_id|api_key_id|credentials/u)
})

test('provider circuit diagnostic never echoes unrecognized stored values', async () => {
  const result = await diagnoseProviderCircuit(fixture({ privateValues: true }).pool, requestId)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
})
