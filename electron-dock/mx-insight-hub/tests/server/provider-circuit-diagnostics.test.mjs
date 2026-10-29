import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { diagnoseProviderCircuit } from '../../server/ops/diagnose-provider-circuit.mjs'

const requestId = '0a92d464-e219-4a26-8db6-b2dd2a237490'
const secret = 'private-query-credential-customer-body'
function fixture({ privateValues = false, ecommerce = false, ownCallCount = 1 } = {}) {
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
    if (ecommerce && !privateValues) Object.assign(row, { provider_key: 'justone', marketplace: 'xianyu',
      operation: 'ecommerce.products.search', endpoint_key: 'xianyu.product-search.v1',
      outcome: 'rejected', http_status: 200, business_code: 601, billed: false,
      error_code: 'external_platform_capacity_unavailable' })
    if (sql.includes('provider-circuit:usage')) return { rows: [{ ...row, platform: privateValues ? secret : ecommerce ? 'ecommerce' : 'xiaohongshu',
      has_contract_circuits: true, has_search_routes: true }] }
    if (sql.includes('provider-circuit:own-calls')) return { rows: Array.from({ length: ownCallCount }, () => ({ ...row,
      error_code: privateValues ? secret : ecommerce ? 'upstream_balance_exhausted' : 'invalid_content_search_contract' })) }
    if (sql.includes('provider-circuit:nearby')) return { rows: [{ ...row, error_code: privateValues ? secret : 'invalid_content_search_contract' }] }
    if (/provider-circuit:(gateways|states|contracts|policy)/u.test(sql)) return { rows: [row] }
    return { rows: [] }
  }, release() { released = true } } } }
  return { pool, queries, get released() { return released } }
}

test('provider circuit diagnostic works for any platform and names Hub-side failures near the refusal', async () => {
  const db = fixture()
  const result = await diagnoseProviderCircuit(db.pool, requestId)
  assert.equal(result.diagnosticRevision, 'provider-circuit-diagnostic.v2')
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

test('capacity refusal reports the exact request supplier response separately from nearby failures', async () => {
  const db = fixture({ ecommerce: true })
  const result = await diagnoseProviderCircuit(db.pool, requestId)
  assert.equal(result.platform, 'ecommerce')
  assert.equal(result.historical.errorCode, 'external_platform_capacity_unavailable')
  const [call] = result.historical.ownCalls
  assert.equal(call.provider, 'justone')
  assert.equal(call.marketplace, 'xianyu')
  assert.equal(call.outcome, 'rejected')
  assert.equal(call.httpStatus, 200)
  assert.equal(call.businessCode, 601)
  assert.equal(call.errorCode, 'upstream_balance_exhausted')
  assert.equal(call.billed, false)
  const query = db.queries.find(row => row.sql.includes('provider-circuit:own-calls'))
  assert.deepEqual(query.params, [requestId])
  assert.match(query.sql, /WHERE usage_request_id = \$1::uuid/u)
  assert.equal(result.historical.ownCallsTruncated, false)
})

test('own call evidence is bounded and missing rows are not presented as proof of no dispatch', async () => {
  const truncated = await diagnoseProviderCircuit(fixture({ ownCallCount: 21 }).pool, requestId)
  assert.equal(truncated.historical.ownCalls.length, 20)
  assert.equal(truncated.historical.ownCallsTruncated, true)
  const empty = await diagnoseProviderCircuit(fixture({ ownCallCount: 0 }).pool, requestId)
  assert.deepEqual(empty.historical.ownCalls, [])
  assert.match(empty.evidenceLimit, /Empty ownCalls alone does not prove no dispatch/u)
})
