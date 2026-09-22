import assert from 'node:assert/strict'
import test from 'node:test'
import { nightAllFailureEvidence, projectNightAllFailureEvidence } from '../../server/data/night-all-failure-evidence.mjs'
import { UpstreamRejectedError } from '../../server/core/errors.mjs'
import { NightAllAdapter } from '../../server/adapters/night-all.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

test('candidate error chains retain codes, endpoint and HTTP evidence without arbitrary text or credentials', () => {
  const input = new UpstreamRejectedError(502, { requestId: 'req_example', error: {
    code: 'TIKHUB_ALL_ENDPOINTS_FAILED', message: 'secret https://private.test', details: {
      errors: [{ endpointId: 'douyin_search_fetch_video_search_v1', code: 'TIKHUB_HTTP_ERROR', message: 'token=private', details: { statusCode: 400, apiKey: 'secret' } }],
      headers: { authorization: 'Bearer private' }, bodyPreview: 'secret',
    },
  } })
  const result = nightAllFailureEvidence(input)
  assert.equal(result.requestId, 'req_example')
  assert.ok(result.errors.some(e => e.code === 'TIKHUB_ALL_ENDPOINTS_FAILED'))
  assert.ok(result.errors.some(e => e.endpointId === 'douyin_search_fetch_video_search_v1'))
  assert.ok(result.errors.some(e => e.httpStatus === 400))
  assert.doesNotMatch(JSON.stringify(result), /secret|private|authorization|bodyPreview/)
  assert.deepEqual(projectNightAllFailureEvidence(result), result)
})

test('unknown codes are preserved without fabricated explanations and oversized chains disclose truncation', () => {
  const result = nightAllFailureEvidence(new UpstreamRejectedError(502, {
    error: { code: 'NEW_PROVIDER_ERROR', message: 'sensitive', details: { errors: Array.from({ length: 40 }, (_, i) => ({ code: `ERROR_${i}`, message: 'sensitive' })) } },
  }))
  assert.equal(result.errors[0].message, null)
  assert.equal(result.truncated, true)
  assert.ok(result.errors.length <= 16)
  assert.doesNotMatch(JSON.stringify(result), /sensitive/)
  assert.equal(projectNightAllFailureEvidence({ version: 1, errors: [{ code: '__proto__', message: 'injected' }] }).errors[0].message, null)
})

test('adapter preserves response-header correlation for JSON and non-JSON rejection without changing rejection classification', async () => {
  for (const [contentType, body] of [['application/json', '{"error":{"code":"TIKHUB_ALL_ENDPOINTS_FAILED"}}'], ['text/html', '<h1>private</h1>'], ['application/json', 'invalid']]) {
    const adapter = new NightAllAdapter({ baseUrl: 'http://synthetic.invalid', fetchImpl: async () => new Response(body, { status: 502, headers: { 'content-type': contentType, 'x-request-id': 'req_header', 'x-trace-id': 'trace_header' } }) })
    await assert.rejects(adapter.legacySearch({ operation: 'raw', body: { platform: 'douyin', keyword: 'AI', count: 1 }, businessId: 'test' }), error => {
      assert.ok(error instanceof UpstreamRejectedError)
      const evidence = nightAllFailureEvidence(error)
      assert.equal(evidence.httpStatus, 502)
      assert.equal(evidence.requestId, 'req_header')
      assert.equal(evidence.traceId, 'trace_header')
      assert.doesNotMatch(JSON.stringify(evidence), /private/)
      return true
    })
  }
})

test('Postgres evidence write is bounded, immutable and projected before SQL', async () => {
  const calls = []
  const pool = { async connect() { return { async query(sql, params) { calls.push({ sql, params }); return { rows: [] } }, release() {} } } }
  const store = new PostgresStore(pool)
  await store.recordConnectorFailureEvidence('call-id', { version: 1, errors: [{ code: 'TIKHUB_HTTP_ERROR', message: 'SECRET', httpStatus: 400 }], raw: 'SECRET' })
  const update = calls.find(c => c.sql.includes('UPDATE serving.connector_calls'))
  assert.match(update.sql, /failure_evidence IS NULL/)
  assert.doesNotMatch(update.params[1], /SECRET/)
  assert.ok(calls.some(c => c.sql.includes("statement_timeout = '1s'")))
  assert.equal(calls.at(-1).sql, 'COMMIT')
})
