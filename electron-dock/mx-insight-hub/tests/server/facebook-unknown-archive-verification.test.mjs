import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createJustOneCallArchiveObject } from '../../server/contracts/justone.mjs'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { projectFacebookUnknownArchive, verifyFacebookUnknownArchive } from '../../server/ops/verify-facebook-unknown-archive.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const privateMarker = 'private-query-response-token'
const sha = value => createHash('sha256').update(value).digest('hex')
function evidence(raw = { code: 0, message: privateMarker, data: { business_data: [], cursor: null } }) {
  const body = Buffer.from(JSON.stringify(raw))
  const request = normalizeNativeForwardingRequest('j.facebook_post_search_v1', {
    params: { keyword: privateMarker, startDate: '2026-10-01', endDate: '2026-10-17' },
  })
  const archive = createJustOneCallArchiveObject(raw, request, {
    capturedAt: '2026-10-17T00:00:00.000Z', httpStatus: 200, businessCode: raw.code,
    billed: true, bodySha256: sha(body), bodySize: body.length, contractState: 'accepted',
  })
  // Model the pre-fix JS value. The real producer hash treats undefined as null;
  // pg JSON serialization drops the property. This stays valid after the producer fix.
  const historical = { ...archive.rawPayload, request: { ...archive.rawPayload.request, page: undefined } }
  const payload = JSON.parse(JSON.stringify(historical))
  return { body_size: body.length, actual_body_size: body.length, body_sha256: sha(body), body_bytes: body,
    operational_present: true, operational_payload: payload,
    operational_body_size: Buffer.byteLength(JSON.stringify(payload)), payload_sha256: archive.payloadSha256 }
}

test('real JustOne producer hash identifies a JSON-dropped page field without changing evidence or exposing content', () => {
  const row = evidence(), before = JSON.stringify(row), result = projectFacebookUnknownArchive(row)
  assert.equal(result.restricted.state, 'archive_verified')
  assert.equal(result.restricted.businessCode, 0)
  assert.deepEqual(result.restricted.arrayLengths, { data: null, businessData: 0, results: null })
  assert.equal(result.restricted.normalEmptyPage, true)
  assert.equal(result.restricted.emptyTerminalPage, true)
  assert.equal(result.operational.storedPayloadHashMatches, false)
  assert.equal(result.operational.requestPagePresent, false)
  assert.equal(result.operational.restoredMissingPageAsNullHashMatches, true)
  assert.equal(result.operational.restrictedBodyHashMatches, true)
  assert.equal(result.operational.restrictedBodySizeMatches, true)
  assert.equal(JSON.stringify(row), before)
  assert.doesNotMatch(JSON.stringify(result), /private-query-response-token|envelope|fingerprintSha256/u)
  row.operational_payload.request.page = null
  const withPage = projectFacebookUnknownArchive(row)
  assert.equal(withPage.operational.storedPayloadHashMatches, true)
  assert.equal(withPage.operational.restoredMissingPageAsNullHashMatches, null)
  row.operational_payload.response.billed = false
  assert.equal(projectFacebookUnknownArchive(row).operational.storedPayloadHashMatches, false)
})

test('raw integrity, bounds and nonempty/error shapes never claim a normal empty page', () => {
  for (const raw of [{ code: 301, data: { business_data: [] } }, { code: 0, data: {} },
    { code: 0, data: { business_data: [{ text: privateMarker }] } },
    { code: 0, data: { business_data: [], cursor: { secret: privateMarker } } }]) {
    const result = projectFacebookUnknownArchive(evidence(raw))
    assert.equal(result.restricted.normalEmptyPage, false)
    assert.doesNotMatch(JSON.stringify(result), /private-query-response-token/u)
  }
  const continuation = projectFacebookUnknownArchive(evidence({ code: 0, data: { results: [], cursor: privateMarker } }))
  assert.equal(continuation.restricted.normalEmptyPage, true)
  assert.equal(continuation.restricted.emptyTerminalPage, false)
  const row = evidence()
  assert.equal(projectFacebookUnknownArchive({ ...row, body_sha256: 'a'.repeat(64) }).restricted.state, 'archive_integrity_failed')
  assert.equal(projectFacebookUnknownArchive({ ...row, body_size: row.body_size + 1 }).restricted.state, 'archive_integrity_failed')
  assert.equal(projectFacebookUnknownArchive({ ...row, body_size: 4097 }).restricted.state, 'archive_too_large')
  assert.equal(projectFacebookUnknownArchive({ ...row, operational_body_size: 65537 }).operational.state, 'archive_too_large')
  const malformed = Buffer.from('{not json')
  assert.equal(projectFacebookUnknownArchive({ ...row, body_bytes: malformed, body_size: malformed.length,
    body_sha256: sha(malformed) }).restricted.state, 'archive_not_json')
})

test('actual PostgreSQL exact binding, JSONB fingerprint and read-only transaction; missing or wrong scope reads no archive',
  { skip: !modulePath }, async t => {
    const { PGlite } = await import(pathToFileURL(modulePath).href), db = new PGlite()
    t.after(() => db.close())
    // Real column names/types from migrations 001, 051 and 058.
    await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
      CREATE TABLE usage_requests(id uuid PRIMARY KEY,platform text,status text,acquisition_request jsonb);
      CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,
        provider_key text,operation text,endpoint_key text,outcome text);
      CREATE TABLE external_platform.response_archives(provider_call_id uuid PRIMARY KEY,
        contract_state text,http_status integer,payload_sha256 char(64),raw_payload jsonb);
      CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid PRIMARY KEY,
        body_size integer,body_sha256 char(64),body_bytes bytea);`)
    const row = evidence(), requestId = randomUUID(), callId = randomUUID()
    await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4)', [requestId,'facebook','unknown',
      JSON.stringify({ path: '/api/v1/data/search', body: { query: privateMarker } })])
    await db.query('INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$4,$5)',
      [callId,requestId,'justone','native.j.facebook_post_search_v1','unknown'])
    await db.query('INSERT INTO external_platform.response_archives VALUES($1,$2,$3,$4,$5)',
      [callId,'accepted',200,row.payload_sha256,JSON.stringify(row.operational_payload)])
    await db.query('INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4)',
      [callId,row.body_size,row.body_sha256,row.body_bytes])
    const tables = ['usage_requests','external_platform.provider_calls','external_platform.response_archives',
      'control.external_platform_restricted_raw_responses']
    const snapshot = async () => JSON.stringify(await Promise.all(tables.map(table => db.query(`SELECT * FROM ${table}`))))
    const queries = []; let releases = 0, probe = true
    const pool = { async connect() { return { async query(sql, params) {
      queries.push({ sql, params })
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
      if (probe && sql.includes('verify-exact-archive')) {
        probe = false
        const { rows: [settings] } = await db.query(`SELECT current_setting('transaction_read_only') AS ro,
          current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock`)
        assert.deepEqual(settings, { ro: 'on', isolation: 'repeatable read', statement: '5s', lock: '1s' })
        await db.query('SAVEPOINT readonly_probe')
        await assert.rejects(db.query('UPDATE usage_requests SET status=status WHERE false'), error => error.code === '25006')
        await db.query('ROLLBACK TO SAVEPOINT readonly_probe')
      }
      return db.query(sql, params)
    }, release() { releases++ } } } }
    const args = { requestId,callId,sha256: row.body_sha256 }, before = await snapshot()
    const result = await verifyFacebookUnknownArchive(pool, args)
    assert.equal(result.requestStatus, 'unknown')
    assert.equal(result.callOutcome, 'unknown')
    assert.equal(result.archiveHttpStatus, 200)
    assert.equal(result.operational.storedPayloadHashMatches, false)
    assert.equal(result.operational.restoredMissingPageAsNullHashMatches, true)
    assert.equal(result.restricted.normalEmptyPage, true)
    assert.doesNotMatch(JSON.stringify(result), /private-query-response-token|acquisition_request/u)
    assert.equal(await snapshot(), before)
    assert.equal(queries.at(-1).sql, 'ROLLBACK')
    assert.equal(releases, 1)
    for (const overrides of [{ requestId: randomUUID() },{ callId: randomUUID() },{ sha256: 'a'.repeat(64) }]) {
      await assert.rejects(verifyFacebookUnknownArchive(pool, { ...args,...overrides }), { message: 'bound_archive_not_found' })
      assert.equal(queries.at(-1).sql, 'ROLLBACK')
    }
    await db.query("UPDATE external_platform.provider_calls SET endpoint_key='wrong-endpoint'")
    await assert.rejects(verifyFacebookUnknownArchive(pool, args), { message: 'bound_archive_not_found' })
    assert.deepEqual(queries.find(entry => entry.sql.includes('verify-exact-archive')).params,
      [requestId,callId,row.body_sha256])
  })

test('query failure rolls back and the stdin CLI rejects unsafe arguments without exposing errors', async () => {
  const commands = []; let released = false
  const pool = { async connect() { return { async query(sql) {
    commands.push(sql)
    if (sql.startsWith('SELECT')) throw new Error(privateMarker)
    return { rows: [] }
  }, release() { released = true } } } }
  await assert.rejects(verifyFacebookUnknownArchive(pool, { requestId: randomUUID(),callId: randomUUID(),sha256: 'a'.repeat(64) }),
    { message: 'archive_verification_failed' })
  assert.equal(commands.at(-1), 'ROLLBACK')
  assert.equal(released, true)
  const input = readFileSync(new URL('../../server/ops/verify-facebook-unknown-archive.mjs', import.meta.url), 'utf8')
  const result = spawnSync(process.execPath, ['--input-type=module','-',privateMarker], { input, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), { error: 'invalid_arguments' })
})
