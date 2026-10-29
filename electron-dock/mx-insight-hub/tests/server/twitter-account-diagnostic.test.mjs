import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inspectTwitterAccountArchive, diagnoseTwitterAccount } from '../../server/ops/diagnose-twitter-account.mjs'

const receipt = value => {
  const body_bytes = Buffer.from(JSON.stringify(value))
  return { body_bytes, body_size: body_bytes.length, body_sha256: createHash('sha256').update(body_bytes).digest('hex') }
}
test('archive checks bytes and distinguishes an explicit not-found response from a malformed profile', () => {
  const raw = receipt({ data: {}, userExists: false })
  assert.equal(inspectTwitterAccountArchive(raw).explicitNotFoundEnvelope, true)
  assert.equal(inspectTwitterAccountArchive(receipt({ data: {} })).explicitNotFoundEnvelope, false)
  assert.equal(inspectTwitterAccountArchive(receipt({ data: {}, userExists: false, errors: ['secret'] })).explicitNotFoundEnvelope, false)
  assert.equal(inspectTwitterAccountArchive({ ...raw, body_size: 1 }).state, 'integrity_failed')
  assert.equal(inspectTwitterAccountArchive({ ...raw, body_sha256: '0'.repeat(64) }).state, 'integrity_failed')
  assert.equal(inspectTwitterAccountArchive({ body_size: 8388609 }).state, 'too_large')
  const invalid = receipt('placeholder'); invalid.body_bytes = Buffer.from('{')
  invalid.body_size = 1; invalid.body_sha256 = createHash('sha256').update(invalid.body_bytes).digest('hex')
  assert.equal(inspectTwitterAccountArchive(invalid).state, 'invalid_utf8_or_json')
})
test('shape never returns arbitrary property names or values from the restricted archive', () => {
  const result = inspectTwitterAccountArchive(receipt({ secret_key_name: 'secret-text', data: {
    result: { rest_id: 'private-id', legacy: { screen_name: 'private-name' }, __typename: 'private-type' },
  } }))
  assert.equal(result.parserReplayed, false)
  assert.doesNotMatch(JSON.stringify(result), /secret|private/u)
  assert.equal(result.profileCandidates[0].legacy.fields.screen_name, 'string')
})
test('actual SQL reads only the requested ledger and archive within a read-only transaction',
  { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
    const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
    const db = new PGlite(); t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
      CREATE TABLE usage_requests(id uuid PRIMARY KEY,platform text,status text,response_status integer,error_code text,
        reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb);
      CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,provider_key text,operation text,
        endpoint_key text,outcome text,http_status integer,business_code text,billed boolean,error_code text,item_count integer,
        started_at timestamptz,completed_at timestamptz);
      CREATE TABLE control.external_platform_restricted_raw_responses(id uuid PRIMARY KEY,provider_call_id uuid UNIQUE,
        body_size integer,json_parsed boolean,body_sha256 char(64),body_bytes bytea);`)
    const id = randomUUID(), call = randomUUID(), raw = receipt({ data: {}, userExists: false })
    await db.query(`INSERT INTO usage_requests VALUES($1,'twitter','committed',502,'social_upstream_response_unusable',now(),now(),
      '{"path":"/api/v1/data/social/crawl","body":{"username":"secret-account"}}')`, [id])
    for (const [callId, usage] of [[call,id], [randomUUID(),randomUUID()]]) {
      await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,'rapidapi','social.profile.get',
        'twitter-aio.user-info','succeeded_unusable',200,NULL,NULL,'social_upstream_response_unusable',0,now(),now())`, [callId,usage])
    }
    await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,true,$4,$5)`,
      [randomUUID(),call,raw.body_size,raw.body_sha256,raw.body_bytes])
    let releases = 0
    const pool = { connect: async () => ({ query: async (sql, params) => {
      assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
      if (sql.startsWith('SELECT id, platform')) {
        const { rows: [settings] } = await db.query("SELECT current_setting('transaction_read_only') AS ro")
        assert.equal(settings.ro, 'on')
      }
      return db.query(sql,params)
    }, release: () => { releases++ } }) }
    const result = await diagnoseTwitterAccount(pool,id)
    assert.equal(result.ownCalls.length,1)
    assert.equal(result.ownCalls[0].billed,null)
    assert.equal(result.ownCalls[0].archive.explicitNotFoundEnvelope,true)
    assert.doesNotMatch(JSON.stringify(result), /secret-account/u)
    assert.equal((await diagnoseTwitterAccount(pool,randomUUID())).found,false)
    assert.equal(releases,2)
    await assert.rejects(diagnoseTwitterAccount(pool,'invalid'), /invalid_request_id/u)
  })
