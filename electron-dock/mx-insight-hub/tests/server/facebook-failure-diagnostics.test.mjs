import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { diagnoseFacebookFailure, inspectFacebookFailureArchive } from '../../server/ops/diagnose-facebook-failure.mjs'
import { readFacebookFailureMessage, projectFacebookFailureMessage, redactFacebookErrorMessage } from '../../server/ops/read-facebook-failure-message.mjs'
import { facebookQuotaFixture } from '../helpers/facebook-quota.mjs'

const archive = payload => {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))
  return { body_bytes: bytes, body_size: bytes.length, body_sha256: createHash('sha256').update(bytes).digest('hex') }
}
const pg = { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }

test('Facebook rejection inspection verifies exact bytes and exposes only fixed reviewed messages', () => {
  const result = inspectFacebookFailureArchive(archive({ code: 301, message: '采集失败', requestId: '2b74548b0a604b22b885abf6dcddde88',
    data: null, msg: 'private-token-and-query', error: { message: 'private-cookie', reason: 'private-detail' },
    privateBody: 'private-response' }))
  assert.equal(result.state, 'archive_verified'); assert.equal(result.hashVerified, true)
  assert.equal(result.businessCode, 301); assert.equal(result.message.reviewedText, '采集失败')
  assert.equal(result.upstreamRequestId, '2b74548b0a604b22b885abf6dcddde88')
  assert.equal(result.msg.unreviewedText, true); assert.equal(result.errorMessage.unreviewedText, true)
  assert.equal(result.dataType, 'null')
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
})

test('missing, oversized, altered and invalid UTF-8 archives never yield a guessed reason', () => {
  assert.equal(inspectFacebookFailureArchive(null).state, 'archive_missing')
  assert.equal(inspectFacebookFailureArchive({ body_size: 65537 }).state, 'archive_too_large')
  assert.equal(inspectFacebookFailureArchive({ ...archive({ code: 301 }), body_sha256: '0'.repeat(64) }).state, 'archive_integrity_failed')
  assert.equal(inspectFacebookFailureArchive({ ...archive({ code: 301 }), body_size: 1 }).state, 'archive_integrity_failed')
  assert.equal(inspectFacebookFailureArchive(archive('not JSON')).state, 'archive_not_json')
  assert.equal(inspectFacebookFailureArchive(archive([])).state, 'archive_not_object')
  const bytes = Buffer.from([0xff])
  assert.equal(inspectFacebookFailureArchive({ body_bytes: bytes, body_size: 1,
    body_sha256: createHash('sha256').update(bytes).digest('hex') }).state, 'archive_not_json')
})

test('historical Facebook diagnostic runs read-only SQL and separates overlapping calls from prior quota observations', pg, async t => {
  const { db, pool } = await facebookQuotaFixture(t)
  await db.exec(`CREATE TABLE public.usage_requests(id uuid PRIMARY KEY,platform text,status text,error_code text,
    response_status int,reserved_at timestamptz,completed_at timestamptz);
    CREATE SCHEMA external_platform;
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,provider_key text,operation text,
      endpoint_key text,outcome text,http_status int,business_code int,error_code text,upstream_request_id text,billed boolean,
      started_at timestamptz,completed_at timestamptz);
    CREATE TABLE external_platform.response_archives(provider_call_id uuid UNIQUE,raw_payload jsonb);`)
  await db.exec(readFileSync(new URL('../../migrations/058_external_platform_restricted_raw_responses.sql', import.meta.url), 'utf8'))
  const requestId = randomUUID(), callId = randomUUID(), before = randomUUID(), overlap = randomUUID(), after = randomUUID()
  const reservedAt = Date.now() - 60000
  await db.query(`INSERT INTO public.usage_requests VALUES($1,'facebook','committed','upstream_collection_failed',502,$2,$3)`,
    [requestId, new Date(reservedAt), new Date(reservedAt + 950)])
  await db.exec("UPDATE control.platform_search_policy_events SET created_at=now()-interval '2 hours'")
  await db.query(`INSERT INTO control.platform_search_policy_events(platform,revision,actor,policy,created_at)
    VALUES('facebook',2,'fixture','{"mode":"justone","monthly_limit":900,"reason":"private-admin-note"}',now())`)
  const insertCall = async (id, provider, operation, start, end, code) => db.query(`INSERT INTO external_platform.provider_calls
    VALUES($1,$2,$3,$4,$5,$6,200,$7,$8,$9,$10,$11,$12)`, [id, id === callId ? requestId : randomUUID(), provider, operation,
    provider === 'rapidapi' ? 'facebook-scraper3.search' : operation, code === 301 ? 'rejected' : 'succeeded', code,
    code === 301 ? 'upstream_collection_failed' : null, code === 301 ? '2b74548b0a604b22b885abf6dcddde88' : null,
    code !== 301, new Date(reservedAt + start), new Date(reservedAt + end)])
  await insertCall(callId, 'justone', 'native.j.facebook_post_search_v1', 70, 920, 301)
  await insertCall(before, 'rapidapi', 'social.facebook.search', -20000, -15000, null)
  await insertCall(overlap, 'rapidapi', 'social.facebook.search', -240, 5000, null)
  await insertCall(after, 'rapidapi', 'social.facebook.search', 6000, 9000, null)
  const saved = archive({ code: 301, message: '采集失败', data: null, requestId: '2b74548b0a604b22b885abf6dcddde88' })
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses
    (id,provider_call_id,body_size,body_sha256,body_bytes,json_parsed,parsed_payload,captured_at)
    VALUES($1,$2,$3,$4,$5,false,NULL,now())`, [randomUUID(), callId, saved.body_size, saved.body_sha256, saved.body_bytes])
  for (const [id, remaining] of [[before, 1], [overlap, 0]]) await db.query(`INSERT INTO external_platform.response_archives VALUES($1,$2)`,
    [id, JSON.stringify({ privateBody: 'private-response', response: { quota: { remaining, limit: 1000,
      billingHeaderSource: 'x-ratelimit-requests', privateHeader: 'private-credential' } } })])
  let rolledBack = false
  const guarded = { connect: async () => {
    const client = await pool.connect()
    return { release: error => client.release(error), query: (sql, params) => {
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|WITH|ROLLBACK)\b/u)
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT)\b/u)
      if (sql === 'ROLLBACK') rolledBack = true
      return client.query(sql, params)
    } }
  } }
  const report = await diagnoseFacebookFailure(guarded, requestId)
  assert.equal(rolledBack, true); assert.equal(report.ownCalls.length, 1)
  assert.equal(report.ownCalls[0].archive.sha256, saved.body_sha256)
  assert.equal(report.ownCalls[0].archive.message.reviewedText, '采集失败')
  assert.equal(report.lastPolicyAuditBeforeRequest.mode, 'auto'); assert.equal(report.lastPolicyAuditBeforeRequest.revision, 1)
  assert.equal(report.precedingRapidCalls.length, 2)
  const first = report.precedingRapidCalls.find(row => row.callId === before)
  assert.equal(first.completedBeforeReservation, true); assert.equal(first.billingHeaders.remaining, 1)
  const concurrent = report.precedingRapidCalls.find(row => row.callId === overlap)
  assert.equal(concurrent.inFlightAtReservation, true); assert.equal(concurrent.completedBeforeReservation, false)
  assert.equal(concurrent.billingHeaders.remaining, 0, 'a later response is clearly marked as arriving after the decision')
  assert.match(report.routingEvidence, /original admission reason and quota snapshot are not present/)
  assert.doesNotMatch(JSON.stringify(report), /private-/u)
  const single = await readFacebookFailureMessage(guarded, { requestId, callId, sha256: saved.body_sha256 })
  assert.equal(single.hashVerified, true); assert.equal(single.message, '采集失败'); assert.equal(single.redacted, false)
  for (const identity of [{ requestId: randomUUID(), callId, sha256: saved.body_sha256 },
    { requestId, callId: before, sha256: saved.body_sha256 }, { requestId, callId, sha256: '0'.repeat(64) }]) {
    await assert.rejects(readFacebookFailureMessage(guarded, identity), /archive_missing_or_scope_mismatch/u)
  }
  const other = randomUUID()
  await db.query(`INSERT INTO public.usage_requests VALUES($1,'twitter','released',NULL,NULL,now(),now())`, [other])
  await assert.rejects(diagnoseFacebookFailure(guarded, other), /request_is_not_facebook/u)
  await assert.rejects(diagnoseFacebookFailure(guarded, randomUUID()), /request_not_found/u)
})

test('historical Facebook account refusals retain their precise stored reason in diagnostics', async () => {
  for (const [businessCode, errorCode] of [[100, 'upstream_auth_invalid'], [600, 'upstream_permission_denied'],
    [601, 'upstream_balance_exhausted'], [602, 'upstream_token_limit_exceeded']]) {
    const requestId = randomUUID(), callId = randomUUID()
    const pool = { async connect() { return { release() {}, async query(sql) {
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT)\b/u)
      if (sql.includes('FROM public.usage_requests')) return { rows: [{ id: requestId, platform: 'facebook',
        status: 'committed', response_status: 503, error_code: errorCode }] }
      if (sql.includes('WHERE usage_request_id=$1')) return { rows: [{ id: callId, usage_request_id: requestId,
        provider_key: 'justone', outcome: 'rejected', http_status: 200, business_code: businessCode, error_code: errorCode, billed: false }] }
      return { rows: [] }
    } } } }
    const result = await diagnoseFacebookFailure(pool, requestId)
    assert.equal(result.errorCode, errorCode)
    assert.equal(result.ownCalls[0].errorCode, errorCode)
    assert.equal(result.ownCalls[0].businessCode, businessCode)
    assert.equal(result.ownCalls[0].billed, false)
  }
})

test('validation and database failures are sanitized and failed rollback discards its connection', async () => {
  await assert.rejects(diagnoseFacebookFailure({ connect() { throw new Error('must not connect') } }, 'invalid'), /invalid_request_id/u)
  let released
  const pool = { connect: async () => ({ query: async sql => {
    if (sql === 'ROLLBACK') throw new Error('private-connection')
    throw new Error('private-database-secret')
  }, release: error => { released = error } }) }
  await assert.rejects(diagnoseFacebookFailure(pool, randomUUID()), error => {
    assert.equal(error.message, 'diagnostic_read_failed'); assert.doesNotMatch(JSON.stringify(error), /private-/u); return true
  })
  assert.ok(released)
})

test('standalone Facebook failure diagnostic supports stdin and validates before database access', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-facebook-failure.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[], 'invalid_arguments'], [['invalid'], 'invalid_request_id'], [[randomUUID()], 'database_url_required']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stderr), { error })
  }
})

test('explicit single-archive message projection keeps only the verified error message and rejects changed metadata', () => {
  const upstream = '2b74548b0a604b22b885abf6dcddde88'
  const saved = { ...archive({ code: 301, requestId: upstream, message: 'Synthetic collector rejected this query.',
    data: { privateBody: 'private-business-data' }, headers: { Authorization: 'private-credential' } }), upstream_request_id: upstream }
  const result = projectFacebookFailureMessage(saved)
  assert.equal(result.message, 'Synthetic collector rejected this query.')
  assert.equal(result.redacted, false); assert.doesNotMatch(JSON.stringify(result), /private-/u)
  assert.throws(() => projectFacebookFailureMessage({ ...saved, body_sha256: '0'.repeat(64) }), /archive_integrity_failed/u)
  assert.throws(() => projectFacebookFailureMessage({ ...saved, upstream_request_id: randomUUID() }), /archive_body_invalid/u)
  for (const payload of [{ code: 0, requestId: upstream, message: 'ignored' }, { code: 301, requestId: upstream, message: 'x'.repeat(513) }]) {
    assert.throws(() => projectFacebookFailureMessage({ ...archive(payload), upstream_request_id: upstream }))
  }
})

test('explicit error text redacts URL, credential, opaque-token and terminal-control content', () => {
  for (const value of ['failed at https://private.test/?token=private-value', 'Bearer private-bearer-value',
    'token=private-token-value', 'cookie="private-cookie-value"', 'key abcdefghijklmnopqrstuvwxyz123456', '\u001bprivate-control']) {
    const result = redactFacebookErrorMessage(value)
    assert.equal(result.redacted, true)
    assert.doesNotMatch(result.text, /https:\/\/private|private-(?:value|bearer|token|cookie)|abcdefghijklmnopqrstuvwxyz|\u001b/u)
  }
  assert.deepEqual(redactFacebookErrorMessage('采集失败，请稍后重试'), { text: '采集失败，请稍后重试', redacted: false })
})

test('single-message stdin command requires exact request/call/hash before accessing the database', () => {
  const source = readFileSync(new URL('../../server/ops/read-facebook-failure-message.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[], 'invalid_arguments'], [[randomUUID(), randomUUID(), 'bad-hash'], 'invalid_archive_identity'],
    [[randomUUID(), randomUUID(), '0'.repeat(64)], 'database_url_required']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stderr), { error })
  }
})
