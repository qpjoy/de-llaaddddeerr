import test from 'node:test'
import assert from 'node:assert/strict'
import { runOneShot, ORIGINAL, IDEMPOTENCY } from '../../server/ops/revalidate-instagram-incident.mjs'

const key = '10000000-0000-4000-8000-000000000001', consumer = '10000000-0000-4000-8000-000000000002'
const freshId = '10000000-0000-4000-8000-000000000003', tenant = '10000000-0000-4000-8000-000000000004'
const privateText = 'NEVER-PRINT-QUERY-CURSOR-SECRET'
const snapshot = { method: 'POST', path: '/api/v1/data/search', body: { platform: 'instagram',
  query: privateText, pageSize: 20, type: 'raw', cursor: privateText } }
function fixture({ already = false, expired = false, timeout = false, badHistory = false, badCall = false, incomplete = false, concurrent = false } = {}) {
  let saved = already || expired ? { id: freshId, api_key_id: key, status: expired ? 'committed' : 'reserved',
    response_status: expired ? 200 : null, expires_at: '2000-01-01T00:00:00Z' } : null
  const requests = [], sql = []
  const original = { id: ORIGINAL, api_key_id: key, consumer_id: consumer, tenant_id: tenant,
    platform: 'instagram', status: 'committed', acquisition_request: incomplete ? { ...snapshot, bodyOmitted: 'oversize' } : snapshot }
  const client = { release() {}, async query(statement, values) {
    sql.push(statement)
    assert.match(statement, /^(BEGIN|SELECT|ROLLBACK)\b/)
    if (statement.includes('WHERE id=$1') && statement.includes('public.usage_requests')) return { rows: [original] }
    if (statement.includes('idempotency_key=$2')) { assert.equal(values[1], IDEMPOTENCY)
      assert.doesNotMatch(statement, /expires|completed_at|status\s*=/i)
      return { rows: saved ? [saved] : [] } }
    if (statement.includes('http_status=400')) return { rows: badCall ? [] : [{ id: '9618f10d-be5f-49ea-a529-0974de5109f7' }] }
    if (statement.includes('external_platform.provider_calls')) return { rows: [] }
    return { rows: [] }
  } }
  const options = { pool: { connect: async () => client }, execute: true,
    env: { MX_INSIGHT_ADMIN_TOKEN: privateText.repeat(2), MX_INSIGHT_PUBLIC_URL: 'https://hub.example.test/' },
    async fetchImpl(url, request) {
      requests.push({ url, ...request })
      assert.equal(request.redirect, 'error')
      if (url.includes('/acquisitions/')) return Response.json({ data: { requestId: ORIGINAL, scope: { platform: 'instagram' },
        owner: { apiKeyId: badHistory ? consumer : key, consumerId: consumer, tenantId: tenant }, requestEvidence: { request: snapshot } } })
      if (url.endsWith('/demo-credentials')) {
        assert.deepEqual(JSON.parse(request.body), { keyId: key })
        if (concurrent) saved = { id: freshId, api_key_id: key, status: 'reserved', response_status: null }
        return Response.json({ data: { keyId: key, consumerId: consumer, secret: `mih_demo_${privateText}` } })
      }
      assert.equal(url, 'https://hub.example.test/api/v1/data/search')
      assert.equal(request.headers['idempotency-key'], IDEMPOTENCY)
      assert.deepEqual(JSON.parse(request.body), snapshot.body)
      saved = { id: freshId, api_key_id: key, status: timeout ? 'reserved' : 'committed', response_status: timeout ? null : 200 }
      if (timeout) throw new Error(privateText)
      return Response.json({ requestId: freshId, data: { items: [{ secret: privateText }], raw_data: privateText } })
    } }
  return { options, requests, sql }
}

test('one exact body, original identity, fixed idempotency, no secret output and repeated execution stops at stored identity', async () => {
  const f = fixture()
  const report = await runOneShot(f.options)
  assert.equal(report.attempted, true); assert.equal(report.httpStatus, 200)
  assert.equal(report.saved.requestId, freshId); assert.equal(report.responseShape.itemCount, 1)
  assert.doesNotMatch(JSON.stringify(report), /NEVER-PRINT|mih_demo_|Bearer|admin-token/)
  assert.equal(f.requests.length, 3)
  const again = await runOneShot(f.options)
  assert.equal(again.attempted, false); assert.equal(f.requests.length, 3)
})
test('unknown HTTP result never retries and is reported alongside the durable reservation', async () => {
  const f = fixture({ timeout: true }), report = await runOneShot(f.options)
  assert.equal(report.outcome, 'unknown_http_result'); assert.equal(report.doNotRetry, true)
  assert.equal(report.saved.status, 'reserved'); assert.equal(f.requests.length, 3)
  assert.doesNotMatch(JSON.stringify(report), /NEVER-PRINT/)
})
test('existing or concurrent request, read-only mode, source mismatch and incomplete snapshot never dispatch publicly', async () => {
  for (const options of [{ already: true }, { expired: true }, { concurrent: true }, { badHistory: true }, { badCall: true }, { incomplete: true }, { inspect: true }]) {
    const f = fixture(options)
    if (options.inspect) f.options.execute = false
    const report = await runOneShot(f.options)
    assert.equal(report.attempted, false)
    assert.equal(f.requests.filter(r => r.url.startsWith('https:')).length, 0)
    assert.doesNotMatch(JSON.stringify(report), /NEVER-PRINT/)
    if (options.badHistory) assert.equal(report.error, 'history_identity_or_snapshot_mismatch')
    if (options.badCall) assert.equal(report.error, 'original_provider_evidence_mismatch')
    if (options.incomplete) assert.equal(report.error, 'original_snapshot_incomplete')
  }
})
test('only the configured strict HTTPS origin can receive the public credential', async () => {
  for (const url of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test/?token=bad']) {
    const f = fixture(); f.options.env.MX_INSIGHT_PUBLIC_URL = url
    assert.equal((await runOneShot(f.options)).attempted, false)
    assert.equal(f.requests.length, 0)
  }
})
