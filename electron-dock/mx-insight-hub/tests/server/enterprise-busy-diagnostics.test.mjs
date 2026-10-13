import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { diagnoseEnterpriseBusy } from '../../server/ops/diagnose-enterprise-busy.mjs'

const requestId = '7443d5db-d9b0-4d99-b204-eacd4e92df6c'
const callId = '11111111-1111-4111-8111-111111111111'
const secret = 'private-credential-and-keyword'
const started = new Date('2026-10-13T09:26:25.469Z')
function fixture({ platform = 'enterprise', missing = false, count = 1, fail, values = {} } = {}) {
  const queries = []
  let released = false
  let releaseError
  const pool = { async connect() { return {
    async query(sql, params) {
      queries.push({ sql, params })
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT)\b/)
      if (fail && sql.includes(fail)) throw new Error(secret)
      if (sql.includes('enterprise-busy:usage')) return { rows: missing ? [] : [{ platform,
        status: 'released', error_code: 'external_platform_busy', response_status: null,
        billing_meter_key: 'enterprise.api.43.3', request_method: 'POST',
        request_path: '/api/v1/data/enterprise/43.3/query', reserved_at: started,
        completed_at: new Date(started.getTime() + 9), acquisition_request: { body: secret }, ...values }] }
      if (sql.includes('enterprise-busy:gateways')) return { rows: Array.from({ length: count }, () => ({
        id: callId, provider_key: 'qixin', source_mode: 'unavailable', succeeded: false,
        response_status: 429, error_code: 'external_platform_busy', provider_call_id: null,
        created_at: started, private_message: secret, ...values })) }
      if (sql.includes('enterprise-busy:calls')) return { rows: Array.from({ length: count }, () => ({
        id: callId, usage_request_id: requestId, operation: 'enterprise.api.43.3', endpoint_key: 'enterprise.43.3',
        outcome: 'succeeded', http_status: 200, business_code: 200, error_code: null,
        started_at: started, completed_at: started, same_tenant: true, same_consumer: true,
        same_api_key: false, overlaps_target_window: true, api_key_id: secret, consumer_id: secret,
        response_body: secret, ...values })) }
      return { rows: [] }
    },
    release(error) { released = true; releaseError = error },
  } } }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('reads only the exact enterprise request and bounded gateway and overlapping Qixin calls, always rolling back', async () => {
  const db = fixture()
  const result = await diagnoseEnterpriseBusy(db.pool, requestId)
  assert.equal(result.savedHttpStatus, null)
  assert.equal(result.gateways[0].httpStatus, 429)
  assert.equal(result.billingMeterKey, 'enterprise.api.43.3')
  assert.equal(result.request.path, '/api/v1/data/enterprise/43.3/query')
  assert.equal(result.completedAt, '2026-10-13T09:26:25.478Z')
  assert.equal(result.nearbyCalls[0].sameConsumer, true)
  assert.equal(result.nearbyCalls[0].sameApiKey, false)
  assert.equal(result.nearbyCalls[0].overlapsTargetWindow, true)
  assert.equal(result.callsTruncated, false)
  assert.equal(result.gatewaysTruncated, false)
  assert.equal(result.concurrencyEvidence, 'historical_process_counters_not_recorded')
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  for (const setting of ["statement_timeout = '5s'", "lock_timeout = '1s'", "idle_in_transaction_session_timeout = '10s'"]) {
    assert.ok(db.queries.some(({ sql }) => sql.includes(setting)))
  }
  for (const { sql, params } of db.queries.filter(({ sql }) => /enterprise-busy:/.test(sql))) {
    assert.deepEqual(params, [requestId])
    assert.match(sql, /(?:usage_request_)?id = \$1::uuid/)
    assert.doesNotMatch(sql, /(?:response_body|body_bytes|parsed_payload|acquisition_request\s*[,\n]|acquisition_request->>'body')/)
  }
  const calls = db.queries.find(({ sql }) => sql.includes('enterprise-busy:calls')).sql
  assert.match(calls, /provider_key = 'qixin'/)
  assert.match(calls, /platform = 'enterprise'/)
  assert.match(calls, /\+ INTERVAL '30 seconds'/)
  assert.match(calls, /- INTERVAL '30 seconds'/)
  assert.match(calls, /LIMIT 101/)
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  assert.doesNotMatch(JSON.stringify(result), /private-|api_key_id|consumer_id|response_body|acquisition_request/)
})

test('truncation is explicit and projections reject arbitrary text in every output category', async () => {
  const db = fixture({ count: 101, values: { request_path: `https://example.test/${secret}`,
    request_method: secret, billing_meter_key: secret, error_code: secret, source_mode: secret,
    provider_key: secret, operation: secret, endpoint_key: secret, outcome: secret, status: secret,
    id: secret, usage_request_id: secret, started_at: secret, completed_at: secret, reserved_at: secret,
    response_status: secret, business_code: secret, same_consumer: secret, succeeded: secret } })
  const result = await diagnoseEnterpriseBusy(db.pool, requestId)
  assert.equal(result.nearbyCalls.length, 100)
  assert.equal(result.gateways.length, 100)
  assert.equal(result.callsTruncated, true)
  assert.equal(result.gatewaysTruncated, true)
  assert.equal(result.request.path, 'other')
  assert.equal(result.billingMeterKey, 'other')
  assert.equal(result.reservedAt, null)
  assert.equal(result.nearbyCalls[0].sameConsumer, null)
  assert.doesNotMatch(JSON.stringify(result), /private-|example\.test/)
  assert.equal((await diagnoseEnterpriseBusy(fixture({ count: 100 }).pool, requestId)).callsTruncated, false)
})

test('invalid IDs never connect; missing or non-enterprise requests stop before related reads', async () => {
  await assert.rejects(diagnoseEnterpriseBusy({ connect() { assert.fail('must not connect') } }, secret),
    { message: 'invalid_request_id' })
  for (const [options, message] of [[{ missing: true }, 'request_not_found'], [{ platform: 'xiaohongshu' }, 'request_not_enterprise']]) {
    const db = fixture(options)
    await assert.rejects(diagnoseEnterpriseBusy(db.pool, requestId), { message })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(db.queries.filter(({ sql }) => /enterprise-busy:/.test(sql)).length, 1)
    assert.equal(db.released, true)
  }
})

test('read, connection and rollback failures never reveal database details', async () => {
  for (const fail of ['enterprise-busy:usage', 'enterprise-busy:gateways', 'enterprise-busy:calls', 'ROLLBACK']) {
    const db = fixture({ fail })
    await assert.rejects(diagnoseEnterpriseBusy(db.pool, requestId), { message: 'diagnostic_read_failed' })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
    assert.equal(Boolean(db.releaseError), fail === 'ROLLBACK')
  }
  await assert.rejects(diagnoseEnterpriseBusy({ async connect() { throw new Error(secret) } }, requestId),
    { message: 'diagnostic_read_failed' })
})

test('standalone stdin mode requires no runtime imports and sanitizes CLI validation failures', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-enterprise-busy.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\//)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  const env = { ...process.env }
  delete env.DATABASE_URL
  for (const [args, expected] of [[[requestId], 'database_url_required'], [[secret], 'invalid_request_id'],
    [[requestId, secret], 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: expected })
    assert.doesNotMatch(result.stderr, /private-|Error:|at /)
  }
})
