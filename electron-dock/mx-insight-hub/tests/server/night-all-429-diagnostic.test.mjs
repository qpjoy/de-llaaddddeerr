import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { INCIDENT_REQUEST_IDS, diagnoseNightAllSearch429, nightAllTargetPort, parseNightAll429Arguments } from '../../server/ops/diagnose-night-all-search-429.mjs'

const source = readFileSync(new URL('../../server/ops/diagnose-night-all-search-429.mjs', import.meta.url), 'utf8')
const callId = '05521c7c-f599-4299-9b7a-4156ada77447'
const at = '2026-10-13T08:01:40.000Z'
function fixture({ missing = false, unsupported = false, denied = false, fatal = false } = {}) {
  const queries = []
  let released = false
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (/^(BEGIN|SET LOCAL|SAVEPOINT|ROLLBACK|RELEASE)/u.test(sql)) return { rows: [] }
    assert.equal(values.length, 1)
    assert.ok(INCIDENT_REQUEST_IDS.includes(values[0]))
    if (sql.includes('night-all-429:usage')) {
      if (fatal) throw Object.assign(new Error('private-database-password'), { code: 'XX999' })
      return { rows: missing ? [] : [{ id: values[0], platform: 'reddit', status: 'released', error_code: 'night_all_http_429',
        response_status: 502, upstream_latency_ms: 19, reserved_at: at, completed_at: '2026-10-13T08:01:40.019Z', database_now: at }] }
    }
    if (sql.includes('night-all-429:path')) {
      if (unsupported) throw Object.assign(new Error('private-missing-column'), { code: '42703' })
      return { rows: missing ? [] : [{ request_path: '/api/v1/data/search' }] }
    }
    if (sql.includes('night-all-429:connectors')) return { rows: missing ? [] : Array.from({ length: 21 }, () => ({ id: callId,
      operation: 'data-search', platform: 'reddit', outcome: 'failed', http_status: 429, failure_kind: 'http', error_code: 'night_all_http_429',
      upstream_latency_ms: 19, upstream_request_id: 'private-token-in-url?secret=x', upstream_trace_id: 'a'.repeat(32),
      started_at: at, completed_at: at, ignored_private_field: 'private-secret' })) }
    if (sql.includes('night-all-429:rate-metadata')) {
      if (unsupported) throw Object.assign(new Error('private-missing-column'), { code: '42703' })
      return { rows: missing ? [] : [{ id: callId, rate_limited_code_present: true, layer: 'night_all_ingress', scope: 'data-search', key_type: 'ip',
        limit_value: '30', remaining: '0', window_ms: '60000', retry_seconds: '12', reset_at: at, dispatched: 'false' }] }
    }
    if (sql.includes('night-all-429:dispatch-presence')) {
      if (unsupported || denied) throw Object.assign(new Error('private-permission-denied'), { code: denied ? '42501' : '42P01' })
      return { rows: [{ recorded: false }] }
    }
    throw new Error('unexpected_query')
  }, release() { released = true } }
  return { pool: { async connect() { return client } }, queries, released: () => released }
}

test('429 diagnostic reads bounded exact-ID evidence in one read-only transaction and hides private values', async () => {
  const f = fixture()
  const report = await diagnoseNightAllSearch429(f.pool, INCIDENT_REQUEST_IDS, { NIGHT_ALL_BASE_URL: 'http://user:private-pass@private-host:13141/private?token=private-token' })
  assert.equal(report.requests.length, 3)
  assert.equal(report.nightAllTarget.port, 13141)
  assert.equal(report.nightAllTarget.historicalTargetVerified, false)
  const row = report.requests[0]
  assert.equal(row.usage.rows[0].errorCode, 'night_all_http_429')
  assert.equal(row.usage.rows[0].savedHttpStatus, 502)
  assert.equal(row.connectorCalls.rows[0].httpStatus, 429)
  assert.equal(row.connectorCalls.rows[0].operation, 'data-search')
  assert.equal(row.connectorCalls.rows[0].upstreamRequestId, null)
  assert.equal(row.connectorCalls.rows.length, 20)
  assert.equal(row.connectorCalls.truncated, true)
  assert.equal(row.rateLimitEvidence.rows[0].retryAfterSeconds, 12)
  assert.equal(row.rateLimitEvidence.rows[0].dispatched, false)
  assert.equal(row.hubProviderDispatchPresence.rows[0].recorded, false)
  assert.match(report.evidenceBoundary, /Missing rows\/metadata do not prove no upstream call/u)
  assert.equal(JSON.stringify(report).includes('private-'), false)
  assert.match(f.queries[0].sql, /REPEATABLE READ READ ONLY/u)
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(f.released(), true)
  const sql = f.queries.map(row => row.sql).join('\n')
  assert.doesNotMatch(sql, /\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|COMMIT)\b|response_body|body_bytes|raw_payload|query_text/iu)
  assert.doesNotMatch(source, /\bfetch\s*\(|import\s+.*(?:adapter|config|hub-service)/u)
  assert.equal(f.queries.filter(row => row.values).length, 15)
})

test('old columns/tables and denied reads are unavailable evidence, not empty-result or no-dispatch claims', async () => {
  for (const options of [{ unsupported: true }, { denied: true }]) {
    const f = fixture(options)
    const report = await diagnoseNightAllSearch429(f.pool, [INCIDENT_REQUEST_IDS[0]])
    const row = report.requests[0]
    assert.equal(row.usage.state, 'read')
    assert.equal(row.connectorCalls.state, 'read')
    assert.equal(row.hubProviderDispatchPresence.state, options.denied ? 'read_unavailable' : 'unsupported_schema')
    assert.equal(row.hubProviderDispatchPresence.rows, null)
    if (options.unsupported) assert.equal(row.rateLimitEvidence.state, 'unsupported_schema')
    assert.equal(JSON.stringify(report).includes('private-'), false)
    assert.ok(f.queries.some(row => row.sql === 'ROLLBACK TO SAVEPOINT diagnostic_section'))
    assert.equal(f.released(), true)
  }
  const f = fixture({ missing: true })
  const report = await diagnoseNightAllSearch429(f.pool, [INCIDENT_REQUEST_IDS[0]])
  assert.deepEqual(report.requests[0].usage.rows, [])
  assert.deepEqual(report.requests[0].connectorCalls.rows, [])
})

test('argument and port projections are allowlisted before a database connection', async () => {
  assert.deepEqual(parseNightAll429Arguments([]).requestIds, INCIDENT_REQUEST_IDS)
  assert.deepEqual(parseNightAll429Arguments(['--request-id', INCIDENT_REQUEST_IDS[0]]).requestIds, [INCIDENT_REQUEST_IDS[0]])
  for (const args of [['--sql', 'select 1'], ['--request-id', "x'; DELETE FROM usage_requests"], ['--request-id'],
    Array.from({ length: 11 }, () => ['--request-id', INCIDENT_REQUEST_IDS[0]]).flat()]) assert.throws(() => parseNightAll429Arguments(args))
  await assert.rejects(diagnoseNightAllSearch429({ connect() { throw new Error('must_not_connect') } }, ['not-a-uuid']), /invalid_request_id/u)
  assert.equal(nightAllTargetPort({}).port, 13141)
  assert.equal(nightAllTargetPort({ NIGHT_ALL_BASE_URL: 'https://private:private@private/path?secret' }).port, 443)
  assert.equal(nightAllTargetPort({ NIGHT_ALL_BASE_URL: 'file:///private/secret' }).configurationInvalid, true)
  const help = spawnSync(process.execPath, ['--input-type=module', '-', '--help'], { input: source, encoding: 'utf8', env: {} })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /stored read-only evidence only/u)
})
