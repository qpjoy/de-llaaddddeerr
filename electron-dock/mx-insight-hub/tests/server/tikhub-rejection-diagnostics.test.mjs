import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { inspectTikHubRejectionArchive, summarizeRejectionRequest, diagnoseTikHubRejection }
  from '../../server/ops/diagnose-tikhub-rejection.mjs'

const requestId = '10000000-0000-4000-8000-000000000001'
const callId = '10000000-0000-4000-8000-000000000002'
const upstreamId = '10000000-0000-4000-8000-000000000003'
const instagramOperation = 'native.t.instagram_v3_general_search'
const nativeContract = 'mx-insight-hub.native-forwarding.v1'
const secret = 'private-credential-keyword-cursor-body'
const noChargeClaim = "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."
function archive(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))
  return { body_bytes: bytes, body_size: bytes.length, body_sha256: createHash('sha256').update(bytes).digest('hex') }
}
const snapshot = { path: '/api/v1/data/search', body: { query: secret, page: 1, pageSize: 20,
  cursor: secret, authorization: secret, body: secret } }

test('verified root and nested detail evidence retains only integer codes and strict request UUIDs', () => {
  const report = inspectTikHubRejectionArchive(archive({ code: 400, request_id: upstreamId, message: 'Bad Request',
    detail: { code: 422, request_id: requestId, message: secret, msg: secret, id: secret,
      url: `https://example.invalid/?token=${secret}`, authorization: secret }, token: secret, [secret]: secret }))
  assert.equal(report.state, 'archive_verified')
  assert.equal(report.hashVerified, true)
  assert.equal(report.root.code, 400)
  assert.equal(report.root.requestId, upstreamId)
  assert.equal(report.root.message.classification, 'bad_request')
  assert.equal(report.detail.code, 422)
  assert.equal(report.detail.requestId, requestId)
  assert.deepEqual(report.detail.message, { type: 'string', length: secret.length, classification: 'other_text' })
  assert.doesNotMatch(JSON.stringify(report), /private-|https:|authorization|token/)
})

test('only the exact verified no-charge message produces a fixed claim classification without emitting text', () => {
  for (const [message, classification] of [[noChargeClaim, 'request_failed_no_charge_claim'],
    [`${noChargeClaim} ${secret}`, 'other_text']]) {
    const saved = archive({ detail: { code: 400, request_id: upstreamId, message } })
    const originalBytes = Buffer.from(saved.body_bytes)
    const originalHash = saved.body_sha256
    const report = inspectTikHubRejectionArchive(saved)
    assert.equal(report.state, 'archive_verified')
    assert.equal(report.hashVerified, true)
    assert.deepEqual(report.detail.message, { type: 'string', length: message.length, classification })
    assert.equal(report.detail.code, 400)
    assert.equal(report.detail.requestId, upstreamId)
    assert.doesNotMatch(JSON.stringify(report), /Request failed|Please retry|charged for this request|private-/)
    assert.deepEqual(saved.body_bytes, originalBytes)
    assert.equal(saved.body_sha256, originalHash)
    assert.deepEqual(inspectTikHubRejectionArchive({ ...saved, body_sha256: '0'.repeat(64) }),
      { state: 'archive_integrity_failed' })
  }
})

test('non-integer codes, arbitrary IDs and nested bodies cannot escape the fixed schema', () => {
  for (const id of [secret, ` ${upstreamId}`, `${upstreamId}${secret}`, 42, { request_id: upstreamId }]) {
    const report = inspectTikHubRejectionArchive(archive({ code: '400', request_id: id, message: { [secret]: secret },
      detail: { code: 0.5, request_id: id, message: [secret], id: upstreamId, data: { request_id: upstreamId } } }))
    assert.equal(report.root.code, null)
    assert.equal(report.detail.code, null)
    assert.equal(report.root.requestId, null)
    assert.equal(report.detail.requestId, null)
    assert.equal(report.root.message.type, 'object')
    assert.equal(report.detail.message.type, 'array')
    assert.doesNotMatch(JSON.stringify(report), /private-|10000000-/)
  }
  const scalar = inspectTikHubRejectionArchive(archive(secret))
  assert.equal(scalar.root.type, 'string')
  assert.equal(scalar.detail.type, 'missing')
  assert.doesNotMatch(JSON.stringify(scalar), /private-/)
})

test('archives require matching bytes, size, hash, bounded size and valid UTF-8 JSON', () => {
  assert.equal(inspectTikHubRejectionArchive(null).state, 'archive_missing')
  const saved = archive({ code: 400, detail: { message: secret } })
  for (const changed of [{ ...saved, body_bytes: Buffer.from(secret) }, { ...saved, body_sha256: '0'.repeat(64) },
    { ...saved, body_size: saved.body_size + 1 }, { ...saved, body_bytes: null }]) {
    assert.deepEqual(inspectTikHubRejectionArchive(changed), { state: 'archive_integrity_failed' })
  }
  assert.deepEqual(inspectTikHubRejectionArchive({ ...saved, body_size: 8388609 }), { state: 'archive_too_large' })
  for (const bytes of [Buffer.from(secret), Buffer.from([0xff, 0xfe])]) {
    assert.deepEqual(inspectTikHubRejectionArchive(archive(bytes)), { state: 'archive_not_json', hashVerified: true })
  }
})

test('Instagram echoed params expose only fixed field types, string lengths and empty state after hash verification', () => {
  const saved = archive({ detail: { code: 400, request_id: upstreamId, params: {
    query: secret, next_max_id: '', rank_token: null, enable_metadata: true,
    authorization: secret, [secret]: { token: secret },
  } }, params: { query: 'wrong-root-location' } })
  const bytes = Buffer.from(saved.body_bytes)
  const report = inspectTikHubRejectionArchive(saved, { instagramSearch: true })
  assert.equal(report.state, 'archive_verified')
  assert.deepEqual(report.detail.params, { type: 'object', fields: {
    query: { type: 'string', length: secret.length, empty: false },
    next_max_id: { type: 'string', length: 0, empty: true },
    rank_token: { type: 'null', length: null, empty: null },
    enable_metadata: { type: 'boolean', length: null, empty: null },
  } })
  assert.doesNotMatch(JSON.stringify(report), /private-|authorization|wrong-root-location/)
  assert.deepEqual(saved.body_bytes, bytes)
  assert.equal(inspectTikHubRejectionArchive(saved).detail.params, undefined, 'existing XHS output remains unchanged')
  assert.deepEqual(inspectTikHubRejectionArchive({ ...saved, body_sha256: '0'.repeat(64) }, { instagramSearch: true }),
    { state: 'archive_integrity_failed' })
  for (const params of [undefined, null, secret, [secret], { query: { [secret]: secret }, rank_token: [secret], enable_metadata: 'true' }]) {
    const result = inspectTikHubRejectionArchive(archive({ detail: { params } }), { instagramSearch: true })
    assert.deepEqual(Object.keys(result.detail.params.fields), ['query', 'next_max_id', 'rank_token', 'enable_metadata'])
    assert.doesNotMatch(JSON.stringify(result), /private-/)
    if (params == null || typeof params !== 'object' || Array.isArray(params)) {
      assert.ok(Object.values(result.detail.params.fields).every(field => field.type === 'missing'))
    } else {
      assert.equal(result.detail.params.fields.query.type, 'object')
      assert.equal(result.detail.params.fields.rank_token.type, 'array')
      assert.deepEqual(result.detail.params.fields.enable_metadata, { type: 'string', length: 4, empty: false })
    }
  }
  for (const payload of [{ params: { query: secret } }, { detail: { request: { params: { query: secret } } } },
    { detail: JSON.stringify({ params: { query: secret } }) }]) {
    const result = inspectTikHubRejectionArchive(archive(payload), { instagramSearch: true })
    assert.equal(result.detail.params.type, 'missing', 'unreviewed nesting is never reinterpreted')
    assert.doesNotMatch(JSON.stringify(result), /private-/)
  }
})

test('request snapshot emits only known paths, numeric page fields and value-free keyword/cursor metadata', () => {
  const report = summarizeRejectionRequest({ ...snapshot, body: { ...snapshot.body, keyword: secret, count: 10 } })
  assert.equal(report.path, snapshot.path)
  assert.equal(report.page, 1)
  assert.equal(report.pageSize, 20)
  assert.equal(report.count, 10)
  assert.equal(report.keyword.present, true)
  assert.equal(report.keyword.length, secret.length)
  assert.equal(report.cursorPresent, true)
  assert.doesNotMatch(JSON.stringify(report), /private-|authorization/)
  const unknown = summarizeRejectionRequest({ path: `/${secret}`, body: { page: secret, count: '10', pageSize: NaN } })
  assert.equal(unknown.path, 'other')
  assert.equal(unknown.page, null)
  assert.equal(unknown.count, null)
  assert.equal(unknown.pageSize, null)
  assert.equal(unknown.cursorPresent, false)
})

function mockPool({ calls = 1, failQuery = false, missingRequest = false, message = secret, billed = null,
  requestOverrides = {}, callOverrides = {}, archivePayload = null } = {}) {
  const statements = []
  let released = false
  const client = { async query(sql, values) {
    statements.push({ sql, values })
    if (/FROM public.usage_requests/.test(sql)) {
      if (failQuery) throw new Error(secret)
      return { rows: missingRequest ? [] : [{ platform: 'xiaohongshu', status: 'committed', response_status: 502,
        error_code: 'upstream_request_rejected', acquisition_request: snapshot, ...requestOverrides }] }
    }
    if (/FROM external_platform.provider_calls/.test(sql)) return { rows: Array.from({ length: calls }, () => ({
      id: callId, operation: 'social.posts.search', endpoint_key: 'xiaohongshu.app-v2.search-notes.v1',
      contract_version: 'night-all.data-search.v1', outcome: 'rejected', http_status: 400,
      business_code: null, error_code: 'upstream_request_rejected', upstream_request_id: null, billed,
      authorization: secret, ...callOverrides,
    })) }
    if (/FROM control.external_platform_restricted_raw_responses/.test(sql)) return { rows: [archive(archivePayload ?? {
      detail: { code: 400, request_id: upstreamId, message }, token: secret,
    })] }
    return { rows: [] }
  }, release() { released = true } }
  return { pool: { async connect() { return client } }, statements, get released() { return released } }
}

test('database diagnosis reads one exact request and bounded TikHub calls in a read-only transaction, then rolls back', async () => {
  const db = mockPool({ calls: 11 })
  const report = await diagnoseTikHubRejection(db.pool, requestId)
  assert.match(db.statements[0].sql, /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/)
  assert.ok(db.statements.some(({ sql }) => /statement_timeout = '5s'/.test(sql)))
  assert.ok(db.statements.some(({ sql }) => /lock_timeout = '1s'/.test(sql)))
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  const usage = db.statements.find(({ sql }) => /FROM public.usage_requests/.test(sql))
  assert.match(usage.sql, /WHERE id = \$1/)
  assert.deepEqual(usage.values, [requestId])
  const calls = db.statements.find(({ sql }) => /FROM external_platform.provider_calls/.test(sql))
  assert.match(calls.sql, /WHERE usage_request_id = \$1 AND provider_key = 'tikhub'/)
  assert.match(calls.sql, /LIMIT 10/)
  assert.deepEqual(calls.values, [requestId])
  const archives = db.statements.filter(({ sql }) => /FROM control.external_platform_restricted_raw_responses/.test(sql))
  assert.equal(archives.length, 10)
  assert.ok(archives.every(({ sql, values }) => /octet_length\(body_bytes\) <= 8388608/.test(sql) && values[0] === callId))
  assert.ok(db.statements.every(({ sql }) => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)))
  assert.equal(report.evidence.length, 10)
  assert.equal(report.callLimitReached, true)
  assert.equal(report.evidence[0].businessCode, null)
  assert.equal(report.evidence[0].upstreamRequestId, null)
  assert.equal(report.evidence[0].billed, null)
  assert.equal(report.evidence[0].archive.detail.code, 400)
  assert.doesNotMatch(JSON.stringify(report), /private-|authorization/)
})

test('Instagram diagnosis recognizes only registered provenance and keeps unknown calls and routes restricted', async () => {
  const options = { requestOverrides: { platform: 'instagram', acquisition_request: {
    ...snapshot, path: '/api/v1/data/native/t.instagram_v3_general_search' } },
  callOverrides: { operation: instagramOperation, endpoint_key: instagramOperation, contract_version: nativeContract },
  archivePayload: { detail: { code: 400, request_id: upstreamId, params: { query: secret } } } }
  const db = mockPool(options)
  const report = await diagnoseTikHubRejection(db.pool, requestId)
  assert.equal(report.platform, 'instagram')
  assert.equal(report.request.path, options.requestOverrides.acquisition_request.path)
  assert.equal(report.evidence[0].operation, instagramOperation)
  assert.equal(report.evidence[0].endpoint, instagramOperation)
  assert.equal(report.evidence[0].contract, nativeContract)
  assert.equal(report.evidence[0].archive.detail.params.fields.query.length, secret.length)
  assert.equal(report.evidence[0].billed, null)
  assert.equal(report.evidence[0].businessCode, null, 'archive metadata never rewrites historical call metadata')
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.ok(db.statements.every(({ sql }) => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)))
  assert.doesNotMatch(JSON.stringify(report), /private-/)
  for (const field of ['operation', 'endpoint_key', 'contract_version']) {
    const unknown = await diagnoseTikHubRejection(mockPool({ ...options,
      requestOverrides: { platform: secret, acquisition_request: { ...snapshot, path: `/${secret}` } },
      callOverrides: { ...options.callOverrides, [field]: secret } }).pool, requestId)
    assert.equal(unknown.platform, 'other')
    assert.equal(unknown.request.path, 'other')
    assert.equal(unknown.evidence[0].archive.detail.params, undefined)
    assert.doesNotMatch(JSON.stringify(unknown), /private-/)
  }
})

test('supplier no-charge claim does not override any saved billing state or issue writes', async () => {
  for (const billed of [null, false, true]) {
    const db = mockPool({ message: noChargeClaim, billed })
    const report = await diagnoseTikHubRejection(db.pool, requestId)
    assert.equal(report.evidence[0].archive.detail.message.classification, 'request_failed_no_charge_claim')
    assert.equal(report.evidence[0].billed, billed)
    assert.equal(report.evidence[0].businessCode, null)
    assert.equal(report.evidence[0].upstreamRequestId, null)
    assert.ok(db.statements.every(({ sql }) => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
    assert.doesNotMatch(JSON.stringify(report), /Request failed|Please retry|charged for this request|private-/)
  }
})

test('failed reads and absent requests also roll back and release; invalid IDs never connect', async () => {
  for (const options of [{ failQuery: true }, { missingRequest: true }]) {
    const db = mockPool(options)
    await assert.rejects(diagnoseTikHubRejection(db.pool, requestId))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
  }
  await assert.rejects(diagnoseTikHubRejection({ connect() { assert.fail('must not connect') } }, secret),
    { message: 'invalid_request_id' })
})

test('standalone source works through stdin without runtime imports and sanitizes CLI errors', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-tikhub-rejection.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\//)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
  const env = { ...process.env }
  delete env.DATABASE_URL
  for (const [argument, expected] of [[requestId, 'database_url_required'], [secret, 'invalid_request_id']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', argument], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: expected })
    assert.doesNotMatch(result.stderr, /private-|Error:|at /)
  }
})

test('standalone stdin Instagram report preserves the restricted schema with an offline database fixture', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-tikhub-rejection.mjs', import.meta.url), 'utf8')
  const payload = JSON.stringify({ detail: { code: 400, request_id: upstreamId, params: {
    query: secret, next_max_id: '', rank_token: secret, enable_metadata: 'true', password: secret,
  } } })
  const saved = archive(Buffer.from(payload))
  const request = { platform: 'instagram', status: 'committed', error_code: 'upstream_request_rejected',
    response_status: 502, acquisition_request: snapshot }
  const call = { id: callId, operation: instagramOperation, endpoint_key: instagramOperation,
    contract_version: nativeContract, outcome: 'rejected', http_status: 400, business_code: 400,
    error_code: 'upstream_request_rejected', upstream_request_id: upstreamId, billed: null }
  const importPg = "const { default: pg } = await import('pg')"
  assert.ok(source.includes(importPg))
  const offlinePg = `const pg = { Pool: class {
    async connect() { return { release() {}, async query(sql) {
      if (!/^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\\b/.test(sql)) throw new Error('write_forbidden')
      if (sql.includes('FROM public.usage_requests')) return { rows: [${JSON.stringify(request)}] }
      if (sql.includes('FROM external_platform.provider_calls')) return { rows: [${JSON.stringify(call)}] }
      if (sql.includes('FROM control.external_platform_restricted_raw_responses')) return { rows: [{
        body_bytes: Buffer.from(${JSON.stringify(payload)}), body_size: ${saved.body_size}, body_sha256: ${JSON.stringify(saved.body_sha256)} }] }
      return { rows: [] }
    } } }
    async end() {}
  } }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-', requestId], {
    input: source.replace(importPg, offlinePg), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'offline-fixture-no-network' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.platform, 'instagram')
  assert.equal(report.evidence[0].archive.hashVerified, true)
  assert.equal(report.evidence[0].archive.detail.params.fields.next_max_id.empty, true)
  assert.equal(report.evidence[0].archive.detail.params.fields.enable_metadata.type, 'string')
  assert.doesNotMatch(result.stdout, /private-|password|offline-fixture|Request failed/)
})
