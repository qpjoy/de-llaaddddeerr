import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { diagnosePlatformAccess, INCIDENT_REQUEST_ID, platformAccessArguments, platformContractEvidence } from '../../server/ops/diagnose-platform-access.mjs'

const tenantId = '11111111-1111-4111-8111-111111111111', consumerId = '22222222-2222-4222-8222-222222222222'
const secondConsumerId = '33333333-3333-4333-8333-333333333333'
const keyId = '44444444-4444-4444-8444-444444444444', dynamicKey = '55555555-5555-4555-8555-555555555555'
const secondKey = '66666666-6666-4666-8666-666666666666'

test('platform access arguments accept only explicit bounded identifiers, with no credentials or implicit names', () => {
  assert.deepEqual(platformAccessArguments([]), { keyId: null, consumerId: null, platform: 'tieba', requestId: INCIDENT_REQUEST_ID })
  assert.equal(platformAccessArguments(['--key-id', keyId, '--consumer-id', consumerId]).keyId, keyId)
  for (const args of [['--key-id', 'lcy-delta'], ['--api-key', 'secret'], ['--key-id'], ['--key-id', keyId, '--key-id', keyId],
    ['--platform', '../tieba'], ['--request-id', "' OR true --"], ['--platform', 'x'.repeat(65)]]) {
    assert.throws(() => platformAccessArguments(args), { diagnosticCode: 'invalid_arguments' })
  }
})

test('installed platform contracts distinguish absence from unverified generic fallback and live readiness', async () => {
  const tieba = await platformContractEvidence('tieba')
  assert.equal(tieba.standardV2Registered, false)
  assert.equal(tieba.tikhubContentSearchRecipeRegistered, false)
  assert.equal(tieba.legacyRawDeclared, false)
  assert.equal(tieba.v1GenericFallbackAvailability, 'not_verified')
  assert.equal(tieba.readinessVerified, false)
  const twitter = await platformContractEvidence('twitter')
  assert.equal(twitter.standardV2Registered, true)
  assert.equal(twitter.legacyRawDeclared, true)
})

test('actual PostgreSQL diagnostic separates current grants from request evidence, works on old schemas and never writes', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control;
    CREATE TABLE tenants(id uuid PRIMARY KEY,status text);
    CREATE TABLE consumers(id uuid PRIMARY KEY,tenant_id uuid,status text,name text);
    CREATE TABLE api_keys(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,status text,environment text,scope_mode text,
      expires_at timestamptz,name text,key_hash text,sealed_secret text);
    CREATE TABLE platform_grants(consumer_id uuid,platform text);
    CREATE TABLE api_key_platform_entitlements(api_key_id uuid,platform text);
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,tenant_id uuid,consumer_id uuid,api_key_id uuid);`)
  await db.query("INSERT INTO tenants VALUES($1,'active')", [tenantId])
  for (const id of [consumerId, secondConsumerId]) await db.query("INSERT INTO consumers VALUES($1,$2,'active','sensitive-consumer-name')", [id, tenantId])
  const addKey = (id, owner = consumerId, mode = 'snapshot', expires = '2099-01-01') => db.query(`INSERT INTO api_keys
    VALUES($1,$2,$3,'active','live',$4,$5,'sensitive-key-name','sensitive-key-hash','sensitive-key-secret')`, [id, tenantId, owner, mode, expires])
  await addKey(keyId); await addKey(dynamicKey, consumerId, 'legacy_dynamic'); await addKey(secondKey, secondConsumerId)
  const queries = []
  const pool = { async connect() { return { async query(sql, values) { queries.push(sql); return db.query(sql, values) }, release() {} } } }
  const run = options => diagnosePlatformAccess(pool, options)

  const missing = await run()
  assert.equal(missing.errorCode, 'identity_required')
  assert.equal(missing.requestEvidence.authorizationRejectionTableInstalled, false)
  assert.equal(missing.identitySource, 'none')
  const absentConsumer = await run({ consumerId: '99999999-9999-4999-8999-999999999999' })
  assert.equal(absentConsumer.errorCode, 'identity_not_found')

  await db.query("INSERT INTO platform_grants VALUES($1,'tieba')", [consumerId])
  const snapshot = await run({ keyId })
  assert.equal(snapshot.mode, 'current_state_not_historical')
  assert.equal(snapshot.identitySource, 'explicit_key')
  assert.equal(snapshot.keys[0].consumerGranted, true)
  assert.equal(snapshot.keys[0].keyEntitlementPresent, false)
  assert.equal(snapshot.keys[0].effectivePlatformGranted, false)
  assert.equal(snapshot.keys[0].identityActive, true)
  assert.equal((await run({ keyId: dynamicKey })).keys[0].effectivePlatformGranted, true)
  await db.query("INSERT INTO api_key_platform_entitlements VALUES($1,'tieba')", [keyId])
  assert.equal((await run({ keyId })).keys[0].effectivePlatformGranted, true)
  await db.query('DELETE FROM platform_grants WHERE consumer_id=$1', [consumerId])
  assert.equal((await run({ keyId })).keys[0].effectivePlatformGranted, false, 'key snapshot cannot override consumer revoke')
  assert.equal((await run({ keyId: dynamicKey })).keys[0].effectivePlatformGranted, false)

  await db.query('INSERT INTO usage_requests VALUES($1,$2,$3,$4)', [INCIDENT_REQUEST_ID, tenantId, consumerId, keyId])
  const stored = await run()
  assert.equal(stored.identitySource, 'saved_usage')
  assert.equal(stored.keys.length, 1)
  assert.equal(stored.keys[0].id, keyId)
  await db.exec('DELETE FROM usage_requests')
  await db.exec(`CREATE TABLE control.request_authorization_rejections(request_id text,tenant_id uuid,consumer_id uuid,api_key_id uuid)`)
  const rejectedOwner = (owner, key) => db.query('INSERT INTO control.request_authorization_rejections VALUES($1,$2,$3,$4)',
    [INCIDENT_REQUEST_ID, tenantId, owner, key])
  await rejectedOwner(consumerId, keyId); await rejectedOwner(consumerId, keyId)
  assert.equal((await run()).identitySource, 'saved_authorization_rejection', 'duplicate events from the same owner are not ambiguous')
  await rejectedOwner(secondConsumerId, secondKey)
  const ambiguous = await run()
  assert.equal(ambiguous.errorCode, 'identity_ambiguous')
  assert.equal(ambiguous.keys.length, 0)
  const conflict = await run({ keyId, consumerId: secondConsumerId })
  assert.equal(conflict.errorCode, 'explicit_identity_mismatch')
  assert.equal(conflict.keys.length, 0)
  const exact = await run({ keyId, consumerId })
  assert.equal(exact.identitySource, 'explicit_key', 'explicit key has priority over a consumer-wide lookup')
  assert.deepEqual(exact.keys.map(row => row.id), [keyId])
  assert.equal(exact.requestEvidence.ownerAmbiguous, true)
  assert.equal(exact.requestEvidence.matchesExplicitIdentity, true)

  await db.query("UPDATE api_keys SET expires_at='2000-01-01' WHERE id=$1", [keyId])
  assert.equal((await run({ keyId })).keys[0].identityActive, false)
  await db.query('UPDATE api_keys SET expires_at=NULL WHERE id=$1', [dynamicKey])
  const missingExpiry = await run({ keyId: dynamicKey })
  assert.equal(missingExpiry.keys[0].expiresAt, null)
  assert.equal(missingExpiry.keys[0].identityActive, false, 'authentication requires expires_at > now(), including legacy keys')
  await db.query("UPDATE consumers SET status='suspended' WHERE id=$1", [secondConsumerId])
  const suspended = await run({ keyId: secondKey })
  assert.equal(suspended.consumer.status, 'suspended')
  assert.equal(suspended.keys[0].identityActive, false)
  for (let index = 0; index < 21; index++) await addKey(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`)
  const many = await run({ consumerId })
  assert.equal(many.keys.length, 20)
  assert.equal(many.truncated, true)
  assert.ok(many.keys.every(row => row.consumerId === consumerId))
  assert.equal(many.supplierHttpCallsMade, 0)
  assert.equal(many.writes, 0)
  for (const report of [missing, snapshot, stored, ambiguous, exact, many]) {
    assert.doesNotMatch(JSON.stringify(report), /sensitive-|key_hash|sealed_secret/u)
  }
  assert.ok(queries.every(sql => !/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|COMMIT)\b/u.test(sql)))
  assert.ok(queries.every(sql => !/key_hash|sealed_secret|\.name\b/u.test(sql)))
  assert.ok(queries.some(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.equal(queries.at(-1), 'ROLLBACK')
})
