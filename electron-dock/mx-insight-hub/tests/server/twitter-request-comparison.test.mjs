import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { compareTwitterRequests, diagnoseTwitterRequest, inspectTwitterRejectedArchive, projectTwitterSavedInput } from '../../server/ops/compare-twitter-requests.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'

const ids = { originalRequestId: 'ced3bb03-709d-438b-8d80-4deada7f8476',
  failedRequestId: '03d6c41f-88c4-42dd-a7f7-eb502d0b148b', successRequestId: '8cef2ac9-69ea-426b-9c36-1864d87def47' }
const source = readFileSync(new URL('../../server/ops/compare-twitter-requests.mjs', import.meta.url), 'utf8')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const hash = value => createHash('sha256').update(value).digest('hex')
const query = '("US semiconductor export" OR "semiconductor export controls" OR SMIC) AND #chipban'
const snapshot = body => ({ method: 'POST', path: '/api/v1/data/search', body })
const normalizers = { normalizeStandard: normalizeHubDataSearch, normalizeSocial: normalizeHubSocialRequest }
const receipt = value => {
  const body_bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  return { body_bytes, body_size: body_bytes.length, body_sha256: hash(body_bytes) }
}

test('saved request projection preserves explicitly requested query parameters while withholding cursor and arbitrary values', () => {
  const cursor = 'mxds1.private-cursor-fixture', hidden = 'private-arbitrary-extra-value'
  const result = projectTwitterSavedInput(snapshot({ platform: 'twitter', query, pageSize: 20, type: 'fresh', cursor,
    params: { token: hidden }, privateField: hidden }))
  assert.equal(result.state, 'saved_request')
  assert.deepEqual(result.fields.query, { value: query, length: query.length, sha256: hash(query) })
  assert.equal(result.fields.pageSize, 20)
  assert.deepEqual(result.fields.cursor, { present: true, length: cursor.length, sha256: hash(cursor) })
  assert.equal(result.fields.params.state, 'values_withheld')
  assert.equal(result.unsupportedFieldCount, 1)
  assert.doesNotMatch(JSON.stringify(result), /private-cursor|private-arbitrary|privateField/u)
  for (const value of [null, [], {}, { ...snapshot({ query }), method: 'GET' },
    { ...snapshot({ query }), path: '/unrelated/path' }, { ...snapshot({ query }), bodyOmitted: true }]) {
    assert.deepEqual(projectTwitterSavedInput(value), { state: 'saved_request_unavailable' })
  }
  for (const value of ['[redacted]', 'x'.repeat(501), { arbitrary: 'private' }]) {
    assert.deepEqual(projectTwitterSavedInput(snapshot({ query: value })).fields.query, { state: 'unavailable_or_oversize' })
  }
})

test('verified HTTP400 archive projection reads only bounded error fields and withholds credential-bearing text and codes', () => {
  const payload = { code: 'opaqueCredentialCode1234567890', message: 'Invalid query near https://supplier.invalid/example/path',
    msg: 'x-rapidapi-key: private-api-value', detail: 'Syntax error\u0000 at operator\u202e',
    error: { code: 'privateRawErrorCode9876543210', message: 'Authorization Bearer private-bearer-value', data: 'private-nested-data' },
    errors: [{ message: 'Cookie session private-cookie-value' }, { msg: 'Parameter count invalid' },
      { message: 'opaqueabcdefghijklmnopqrstuvxyz0123456789' }, { message: 'secret not in assignment syntax' },
      { message: 'fifth permitted message' }, { message: 'private-sixth-array-entry' }], data: { tweets: ['private-business-content'] } }
  const saved = receipt(payload), result = inspectTwitterRejectedArchive(saved)
  assert.equal(result.state, 'verified_http400_error_fields')
  assert.equal(result.hashVerified, true)
  assert.equal(result.sha256, saved.body_sha256)
  assert.equal(result.messages.message.text, 'Invalid query near [URL redacted]')
  assert.equal(result.messages.msg.state, 'credential_related_text_withheld')
  assert.equal(result.messages['error.message'].state, 'credential_related_text_withheld')
  assert.equal(result.messages['errors[0].message'].state, 'credential_related_text_withheld')
  assert.equal(result.messages['errors[1].msg'].text, 'Parameter count invalid')
  assert.equal(result.messages['errors[2].message'].text, '[opaque value redacted]')
  assert.equal(result.messages['errors[3].message'].state, 'credential_related_text_withheld')
  assert.equal(result.code.state, 'unreviewed_code_withheld')
  assert.equal(result.errorCode.state, 'unreviewed_code_withheld')
  assert.equal(result.arraysTruncated, true)
  assert.match(result.scope, /supplier error statement only/u)
  assert.doesNotMatch(JSON.stringify(result), /private-|supplier\.invalid|opaqueCredentialCode|privateRawErrorCode|\u202e|\u0000/u)
  const markedUrl = inspectTwitterRejectedArchive(receipt({ code: 'BAD_REQUEST', error: { code: 400 },
    message: 'Invalid query near https://supplier.invalid?token=private-url-value' }))
  assert.equal(markedUrl.code, 'BAD_REQUEST')
  assert.equal(markedUrl.errorCode, 400)
  assert.equal(markedUrl.messages.message.state, 'credential_related_text_withheld')
  assert.doesNotMatch(JSON.stringify(markedUrl), /private-url-value/u)
})

test('archive corruption, oversize, malformed UTF8/JSON and non-object payload never produce unverified error text', () => {
  assert.equal(inspectTwitterRejectedArchive(null).state, 'archive_missing')
  const valid = receipt({ message: 'Invalid query' })
  for (const bad of [{ ...valid, body_sha256: '0'.repeat(64) }, { ...valid, body_size: valid.body_size + 1 },
    { ...valid, body_bytes: null }, { ...valid, body_bytes: valid.body_bytes.subarray(1) }]) {
    assert.equal(inspectTwitterRejectedArchive(bad).state, 'archive_integrity_failed')
  }
  const big = receipt(Buffer.alloc(16385, 120))
  assert.equal(inspectTwitterRejectedArchive(big).state, 'archive_too_large')
  for (const bytes of [Buffer.from('private non-JSON error body'), Buffer.from([0xc3,0x28])]) {
    const result = inspectTwitterRejectedArchive(receipt(bytes))
    assert.equal(result.state, 'archive_not_json'); assert.equal(result.hashVerified, true)
    assert.doesNotMatch(JSON.stringify(result), /private non-JSON/u)
  }
  assert.equal(inspectTwitterRejectedArchive(receipt(['private-business-content'])).state, 'archive_not_error_object')
  const oversizedText = inspectTwitterRejectedArchive(receipt({ message: 'x'.repeat(1025) }))
  assert.equal(oversizedText.messages.message.state, 'oversize_text_withheld')
  assert.equal(oversizedText.messages.message.sha256, hash('x'.repeat(1025)))
})

function mockPool({ failure = null, crossKeySuccess = false, method = 'POST', callCount = 1 } = {}) {
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), callIds = new Map(Object.values(ids).map(id => [id,randomUUID()]))
  const queries = [], raw = receipt({ code: 400, message: 'Invalid query syntax' })
  let releaseError, released = false
  const pool = { connect: async () => ({ query: async (sql, params) => {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    if (failure && sql.includes(failure)) throw new Error('private database connection details')
    if (sql.includes('twitter-compare:usage')) {
      assert(Object.values(ids).includes(params[0]))
      const success = params[0] === ids.successRequestId, original = params[0] === ids.originalRequestId
      return { rows: [{ id: params[0], tenant_id: tenant, consumer_id: consumer,
        api_key_id: success && crossKeySuccess ? randomUUID() : key, platform: 'twitter',
        status: original ? 'unknown' : 'committed', response_status: original ? null : success ? 200 : 502,
        fingerprint: (success ? 'b' : 'a').repeat(64), reserved_at: new Date('2026-10-15T09:31:28Z'),
        acquisition_request: success ? { method, path: '/api/v1/data/social/search', body: { platform: 'twitter', query: 'timo', count: 20 } }
          : { ...snapshot({ platform: 'twitter', query, pageSize: 20, type: 'fresh' }), method },
        returned_count: success ? 20 : null, has_more: success ? false : null }] }
    }
    if (sql.includes('twitter-compare:calls')) {
      const success = params[0] === ids.successRequestId, original = params[0] === ids.originalRequestId
      return { rows: Array.from({ length: callCount }, (_, ordinal) => ({ id: callIds.get(params[0]), provider_key: 'rapidapi',
        operation: 'social.content.search', endpoint_key: 'twitter-aio.search', endpoint_version: 'twitter-aio.hub.v1',
        contract_version: 'mx-insight-hub.social-data.v1', outcome: original ? 'unknown' : success ? 'succeeded' : 'rejected',
        http_status: original ? null : success ? 200 : 400, billed: null, item_count: success ? 20 : null,
        call_ordinal: ordinal, call_role: ordinal ? 'enrichment' : 'primary' })) }
    }
    if (sql.includes('twitter-compare:rejected-archive')) {
      assert.equal(params[0], callIds.get(ids.failedRequestId)); assert.equal(params[1], 16384)
      return { rows: [raw] }
    }
    return { rows: [] }
  }, release: error => { released = true; releaseError = error } }) }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('comparison reads exactly three selected requests and distinguishes saved evidence from current Top/Latest reconstruction', async () => {
  const f = mockPool({ crossKeySuccess: true }), result = await compareTwitterRequests(f.pool, ids, normalizers)
  assert.equal(result.requests.original.status, 'unknown')
  assert.equal(result.requests.failed.httpStatus, 502)
  assert.equal(result.requests.failed.ownCalls[0].httpStatus, 400)
  assert.equal(result.requests.failed.ownCalls[0].billed, null)
  assert.equal(result.requests.success.returnedCount, 20)
  assert.equal(result.comparisons.originalVsRetry.sameFingerprint, true)
  assert.equal(result.comparisons.retryVsSuccess.sameApiKey, false)
  assert.equal(result.comparisons.retryVsSuccess.samePath, false)
  assert(result.comparisons.retryVsSuccess.differentSavedFields.includes('query'))
  assert.equal(result.requests.failed.currentFirstCall.queryParameters.category, 'Latest')
  assert.equal(result.requests.success.currentFirstCall.queryParameters.category, 'Latest')
  assert.equal(result.requests.failed.currentFirstCall.queryParameters.count, 20)
  assert.match(result.requests.failed.currentFirstCall.evidence, /not historical outgoing URL capture/u)
  assert.equal(f.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, true)
  assert.equal(f.queries.filter(row => row.sql.includes('twitter-compare:usage')).length, 3)
  assert.equal(f.queries.filter(row => row.sql.includes('twitter-compare:rejected-archive')).length, 1)
  for (const row of f.queries.filter(row => row.sql.includes('twitter-compare:'))) assert.match(row.sql, /(?:id|usage_request_id|provider_call_id)=\$1::uuid/u)
})

test('single request mode reads only that request and its verified 400 archive without inventing comparison roles', async () => {
  const f = mockPool(), result = await diagnoseTwitterRequest(f.pool, ids.failedRequestId, normalizers)
  assert.equal(result.diagnosticRevision, 'twitter-request-diagnostic.v1')
  assert.equal(result.readOnly, true); assert.equal(result.businessCalls, 0)
  assert.equal(result.request.requestId, ids.failedRequestId)
  assert.equal(result.request.httpStatus, 502)
  assert.equal(result.request.savedInput.path, '/api/v1/data/search')
  assert.equal(result.request.savedInput.fields.query.value, query)
  assert.equal(result.request.ownCalls[0].httpStatus, 400)
  assert.equal(result.request.ownCalls[0].billed, null)
  assert.equal(result.request.ownCalls[0].rejectedArchive.hashVerified, true)
  assert.equal(result.request.ownCalls[0].rejectedArchive.messages.message.text, 'Invalid query syntax')
  assert.equal(result.request.currentFirstCall.queryParameters.category, 'Latest')
  assert.equal(result.requests, undefined); assert.equal(result.comparisons, undefined)
  assert.equal(f.queries.filter(row => row.sql.includes('twitter-compare:usage')).length, 1)
  assert.equal(f.queries.filter(row => row.sql.includes('twitter-compare:calls')).length, 1)
  assert.equal(f.queries.filter(row => row.sql.includes('twitter-compare:rejected-archive')).length, 1)
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK'); assert.equal(f.released, true)
  const withoutInstalledContract = await diagnoseTwitterRequest(mockPool().pool, ids.failedRequestId)
  assert.equal(withoutInstalledContract.request.currentFirstCall.state, 'installed_normalizer_unavailable')
  assert.equal(withoutInstalledContract.request.ownCalls[0].rejectedArchive.hashVerified, true)
  await assert.rejects(diagnoseTwitterRequest({ connect() { assert.fail('must validate before connecting') } }, 'not-a-uuid'),
    { message: 'invalid_request_id' })
})

test('comparison bounds owned calls and safely closes failed queries or rollback without exposing errors', async () => {
  const f = mockPool({ callCount: 16 }), result = await compareTwitterRequests(f.pool, ids)
  assert.equal(result.requests.failed.ownCalls.length, 15)
  assert.equal(result.requests.failed.callsTruncated, true)
  assert.equal(result.requests.failed.currentFirstCall.state, 'installed_normalizer_unavailable')
  const invalidMethod = await compareTwitterRequests(mockPool({ method: 'GET' }).pool, ids, normalizers)
  for (const request of Object.values(invalidMethod.requests)) {
    assert.equal(request.savedInput.state, 'saved_request_unavailable')
    assert.equal(request.currentFirstCall.state, 'saved_request_unavailable')
  }
  assert.equal(invalidMethod.comparisons.originalVsRetry.state, 'saved_parameters_incomplete')
  for (const failure of ['twitter-compare:calls', 'ROLLBACK']) {
    const broken = mockPool({ failure })
    await assert.rejects(compareTwitterRequests(broken.pool, ids), { message: 'diagnostic_read_failed' })
    assert.equal(broken.released, true)
    assert.equal(Boolean(broken.releaseError), failure === 'ROLLBACK')
  }
  await assert.rejects(compareTwitterRequests({ connect() { assert.fail('must validate before connecting') } },
    { ...ids, failedRequestId: 'private-invalid-id' }), { message: 'invalid_request_id' })
})

test('standalone CLI validates the selected UUIDs before pg import and emits only fixed errors', () => {
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[], 'invalid_arguments'], [['private-invalid'], 'invalid_arguments'],
    [[...Object.values(ids), 'extra'], 'invalid_arguments'], [Object.values(ids).slice(0, 2), 'invalid_arguments'],
    [[ids.failedRequestId], 'database_url_required'], [Object.values(ids), 'database_url_required']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error })
  }
})

test('actual PostgreSQL comparison uses a readonly snapshot and reads only the selected HTTP400 archive', {
  skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL execution',
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  for (const name of ['001_initial.sql','004_reservation_lease.sql','051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql','055_external_platform_multi_call_rate_limit.sql',
    '058_external_platform_restricted_raw_responses.sql','094_acquisition_request_snapshot.sql']) {
    await db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  await db.exec(`ALTER TABLE usage_requests ADD COLUMN delivery_source_mode text;
    ALTER TABLE external_platform.provider_calls ADD COLUMN provider_credential_revision bigint, ADD COLUMN operation_policy_revision bigint`)
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), unrelated = randomUUID()
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture')", [tenant])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture','fixture')", [consumer,tenant])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Fixture',$4,'fixture','0000')",
    [key,tenant,consumer,'a'.repeat(64)])
  const failedCall = randomUUID(), receiptBytes = receipt({ message: 'Invalid query syntax', data: 'private-business-data' })
  for (const requestId of [...Object.values(ids), unrelated]) {
    const success = requestId === ids.successRequestId, original = requestId === ids.originalRequestId
    const saved = snapshot({ platform: 'twitter', query: success ? 'timo' : requestId === unrelated ? 'private-unrelated-query' : query,
      pageSize: 20, type: 'fresh' })
    await db.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,
      response_status,acquisition_request,response_body) VALUES($1,$2,$3,$4,$5,$6,'twitter',$7,$8,$9,$10)`,
    [requestId,tenant,consumer,key,requestId,'a'.repeat(64),original ? 'unknown' : 'committed',original ? null : success ? 200 : 502,
      JSON.stringify(saved),JSON.stringify({ data: { pageInfo: { returnedCount: success ? 20 : 0, hasMore: false }, items: ['private-business-body'] } })])
    const callId = requestId === ids.failedRequestId ? failedCall : randomUUID()
    await db.query(`INSERT INTO external_platform.provider_calls(id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,
      operation,contract_version,endpoint_key,endpoint_version,marketplace,request_fingerprint,outcome,http_status,completed_at)
      VALUES($1,'rapidapi',$2,$3,$4,$5,'social.content.search','mx-insight-hub.social-data.v1','twitter-aio.search','twitter-aio.hub.v1',
      'twitter',$6,$7,$8,now())`, [callId,tenant,consumer,key,requestId,'a'.repeat(64),original ? 'unknown' : success ? 'succeeded' : 'rejected',
      original ? null : success ? 200 : 400])
    if (requestId === ids.failedRequestId || requestId === unrelated) {
      const raw = requestId === unrelated ? receipt({ message: 'private-unrelated-response' }) : receiptBytes
      await db.query(`INSERT INTO control.external_platform_restricted_raw_responses
        (id,provider_call_id,body_size,body_sha256,body_bytes,json_parsed,captured_at) VALUES($1,$2,$3,$4,$5,true,now())`,
      [randomUUID(),callId,raw.body_size,raw.body_sha256,raw.body_bytes])
    }
  }
  const archiveIds = []; let readOnly = false, rollback = false
  const pool = { connect: async () => ({ release() {}, query: async (sql, args) => {
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    if (sql.includes('twitter-compare:usage')) {
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS state")).rows[0].state, 'on')
      readOnly = true
    }
    if (sql.includes('twitter-compare:rejected-archive')) archiveIds.push(args[0])
    if (sql === 'ROLLBACK') rollback = true
    return db.query(sql,args)
  } }) }
  const report = await compareTwitterRequests(pool, ids, normalizers)
  assert.equal(readOnly, true); assert.equal(rollback, true)
  assert.deepEqual(archiveIds, [failedCall])
  assert.equal(report.requests.failed.ownCalls[0].rejectedArchive.hashVerified, true)
  assert.equal(report.requests.failed.ownCalls[0].rejectedArchive.sha256, receiptBytes.body_sha256)
  assert.equal(report.requests.failed.ownCalls[0].rejectedArchive.messages.message.text, 'Invalid query syntax')
  assert.equal(report.requests.success.returnedCount, 20)
  assert.doesNotMatch(JSON.stringify(report), /private-business|private-unrelated/u)
  archiveIds.length = 0
  const single = await diagnoseTwitterRequest(pool, ids.failedRequestId, normalizers)
  assert.equal(single.request.owner.apiKeyId, key)
  assert.equal(single.request.savedInput.fields.query.value, query)
  assert.equal(single.request.ownCalls[0].rejectedArchive.sha256, receiptBytes.body_sha256)
  assert.equal(single.request.ownCalls[0].rejectedArchive.messages.message.text, 'Invalid query syntax')
  assert.deepEqual(archiveIds, [failedCall])
  assert.doesNotMatch(JSON.stringify(single), /private-business|private-unrelated/u)
  assert.equal(single.requests, undefined); assert.equal(single.comparisons, undefined)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 4)
})
