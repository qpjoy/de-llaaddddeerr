import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch } from '../../server/contracts/hub-social-compat.mjs'
import { diagnoseWeiboAccount } from '../../server/ops/diagnose-weibo-account.mjs'

const requestId = '00000000-0000-4000-8000-000000000001'
const id = '876543211'
const privateText = 'private-fixture-only-do-not-print'
const body = { platform: 'weibo', userId: id, count: 50 }
const job = normalizeHubSocialCompatRequest('crawl', body).jobs[0]
const dataStep = buildHubSocialCompatDispatch(job, { resolvedIdentity: { kind: 'id', value: id, profileReady: true, lookupComplete: true } })
const profileStep = buildHubSocialCompatDispatch(job)
function sample(step, ordinal, payload, outcome = 'succeeded') {
  const bytes = Buffer.from(JSON.stringify(payload))
  return { id: `internal-call-${ordinal}`, call_ordinal: ordinal, provider_key: 'tikhub', marketplace: 'weibo', outcome,
    operation: step.operation, endpoint_key: step.endpointKey, endpoint_version: step.endpointVersion, contract_version: step.endpointContractVersion,
    body_size: bytes.length, archive: { body_sha256: createHash('sha256').update(bytes).digest('hex'), body_size: bytes.length,
      body_bytes: bytes, captured_at: '2026-11-04T00:00:00Z' } }
}
const fixtures = () => [
  sample(profileStep, 0, { code: 200, data: { user: { idstr: id, id, screen_name: privateText } } }),
  sample(dataStep, 1, { code: 200, data: { list: [{ id: '1', text: privateText }], since_id: 'private-cursor' } }),
  sample(dataStep, 2, { code: 200, data: { list: [{ id: 9912345678901234, text: privateText },
      { id: 9912345678901234, idstr: '9912345678901234', text: privateText }],
    [privateText]: privateText } }, 'succeeded_unusable'),
]

function fixture(calls = fixtures(), data = body) {
  const trace = []
  const pool = { async connect() { return { async query(sql, args) {
    trace.push(sql)
    if (sql.includes('weibo-account:target')) {
      assert.deepEqual(args, [requestId])
      return { rows: [{ platform: 'weibo', acquisition_request: { method: 'POST', path: '/api/v1/data/social/crawl', body: data } }] }
    }
    if (sql.includes('weibo-account:calls')) return { rows: calls }
    if (sql.includes('weibo-account:archive')) {
      const [owner,callId,maxBytes,endpoint] = args
      assert.equal(owner,requestId)
      assert.equal(maxBytes,8388608)
      const row = calls.find(call => call.id === callId && call.endpoint_key === endpoint)
      return { rows: [row.archive] }
    }
    return { rows: [] }
  }, release() { trace.push('release') } } } }
  return { pool, trace }
}

test('reconstructs a single-job Weibo crawl and verifies the failed later page without printing archived values', async () => {
  const { pool, trace } = fixture()
  const result = await diagnoseWeiboAccount(pool,requestId)
  assert.deepEqual(result.calls.map(c => [c.stage,c.page,c.archive,c.projection]), [
    ['profile',null,'verified','accepted'], ['posts',1,'verified','accepted'], ['posts',2,'verified','unsafe_numeric_identity'] ])
  assert.equal(result.calls[2].structure[1].collections.list.unsafeWithStringId,1)
  for (const literal of [privateText,'private-cursor','9912345678901234',id,'internal-call']) assert.ok(!JSON.stringify(result).includes(literal))
  assert.match(trace[0],/READ ONLY/)
  assert.deepEqual(trace.slice(-2),['ROLLBACK','release'])
})
test('ambiguous jobs, unrelated platforms and damaged archive evidence cannot establish a page or replay', async () => {
  const multiple = fixture(fixtures(),{ ...body, userIds:[id, '12344'] })
  const result = await diagnoseWeiboAccount(multiple.pool,requestId)
  assert.equal(result.calls[2].page,null)
  assert.equal(result.calls[2].projection,'not_replayed')
  const rows = fixtures()
  rows[1].archive.body_sha256 = '0'.repeat(64)
  const damaged = await diagnoseWeiboAccount(fixture(rows).pool,requestId)
  assert.equal(damaged.calls[1].archive,'integrity_failed')
  assert.equal(damaged.calls[2].pageEvidence,'undetermined')
  const mismatch = fixtures()
  mismatch[2].marketplace = 'twitter'
  const blocked = fixture(mismatch)
  assert.equal((await diagnoseWeiboAccount(blocked.pool,requestId)).calls[2].state,'unsupported_call')
  assert.equal(blocked.trace.filter(sql=>sql.includes('weibo-account:archive')).length,2)
  const oversized = fixtures()
  oversized[0].body_size = 8388609
  assert.equal((await diagnoseWeiboAccount(fixture(oversized).pool,requestId)).calls[0].archive,'size_limit')
})
