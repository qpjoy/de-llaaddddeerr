import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { PostgresAcquisitionHistoryStore } from '../../server/acquisitions/history-store.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { normalizeDataSearchV2, prepareDataSearchV2, DATA_SEARCH_V2_PATH } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL preparation' }
const pepper = 'twitter-v2-preparation-fixture-pepper-at-least-32-bytes'
const body = normalizeDataSearchV2({ platform: 'twitter', query: 'offline historical window', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })

async function fixture(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA ingest; CREATE SCHEMA control; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  for (const name of ['001_initial.sql', '004_reservation_lease.sql', '051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql', '094_acquisition_request_snapshot.sql', '152_twitter_manual_retry.sql',
    '158_data_search_v2_protocol.sql', '162_twitter_v2_retry_intents.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  const tenantId = randomUUID(), consumerId = randomUUID(), apiKeyId = randomUUID(), originalId = randomUUID()
  const codec = createDataSearchV2CursorCodec(pepper, `${consumerId}:${apiKeyId}`)
  const snapshot = { method: 'POST', path: '/api/v1/data/search', body: prepareDataSearchV2(body, codec).upstream }
  const fingerprint = requestFingerprint(snapshot)
  const v2Fingerprint = requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body })
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture')", [tenantId])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture',$3)", [consumerId, tenantId, consumerId])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Fixture',$4,'fixture','0000')", [apiKeyId, tenantId, consumerId, 'a'.repeat(64)])
  const addUsage = async (id, key, status) => db.query(`INSERT INTO usage_requests
    (id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,acquisition_request,lease_expires_at,response_status)
    VALUES($1,$2,$3,$4,$5,$6,'twitter',$7,$8,now()+interval '2 minutes',CASE WHEN $7='committed' THEN 200 ELSE NULL END)`,
  [id, tenantId, consumerId, apiKeyId, key, fingerprint, status, JSON.stringify(snapshot)])
  const addBinding = async (key, state, usageId = null) => db.query(`INSERT INTO control.data_search_protocol_bindings
    (consumer_id,idempotency_key,tenant_id,api_key_id,platform,query_hash,fingerprint,request_body,state,owner_id,lease_expires_at,usage_request_id)
    VALUES($1,$2,$3,$4,'twitter',$5,$6,$7,$8,$9,now()+interval '5 minutes',$10)`,
  [consumerId, key, tenantId, apiKeyId, 'b'.repeat(64), v2Fingerprint, JSON.stringify(body), state, randomUUID(), usageId])
  const addIntent = () => db.query(`INSERT INTO control.data_search_protocol_retries
    (original_usage_request_id,tenant_id,consumer_id,api_key_id,successor_idempotency_key,request_fingerprint)
    VALUES($1,$2,$3,$4,'new-v2-retry-key',$5)`, [originalId, tenantId, consumerId, apiKeyId, v2Fingerprint])
  await addUsage(originalId, 'original-v2-key', 'unknown')
  await addBinding('original-v2-key', 'unknown', originalId)
  await db.query(`INSERT INTO external_platform.provider_calls
    (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
      marketplace,request_fingerprint,outcome,completed_at)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'social.content.search','mx-insight-hub.social-data.v1','twitter-aio.search',
      'twitter-aio.hub.v1','twitter',$6,'unknown',now())`, [randomUUID(), tenantId, consumerId, apiKeyId, originalId, fingerprint])
  const statements = [], pool = { query: (...args) => db.query(...args), connect: async () => ({
    query: (sql, args) => { statements.push(sql); return db.query(sql, args) }, release() {},
  }) }
  return { db, history: new PostgresAcquisitionHistoryStore(pool, { apiKeyPepper: pepper }), originalId,
    tenantId, consumerId, apiKeyId, fingerprint, addUsage, addBinding, addIntent, statements }
}

test('PG v2 Admin preparation retains the complete original window and cannot mutate unknown history', options, async t => {
  const f = await fixture(t)
  const before = (await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [f.originalId])).rows[0]
  const result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
  assert.equal(result.eligibility.allowed, true)
  assert.equal(result.owner.apiKeyId, f.apiKeyId)
  assert.deepEqual(result.requestEvidence.request, { method: 'POST', path: DATA_SEARCH_V2_PATH, body })
  assert.equal(result.requestEvidence.contractVersion, 'mx-insight-hub.data-search.v2')
  assert.deepEqual((await f.db.query('SELECT * FROM usage_requests WHERE id=$1', [f.originalId])).rows[0], before)
  assert.equal(f.statements.some(sql => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(sql)), false)
})

test('PG v2 preparation shows a permanent pre-usage intent after refresh and does not authorize another key', options, async t => {
  const f = await fixture(t)
  await f.addIntent(); await f.addBinding('new-v2-retry-key', 'running')
  const result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.successor, null)
  assert.deepEqual(result.retryIntent, { idempotencyKey: 'new-v2-retry-key', apiKeyId: f.apiKeyId,
    state: 'running', requestId: null, usageStatus: null, resumeAllowed: false })
  assert.deepEqual(result.requestEvidence.request.body, body)
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 1)
})

test('PG v2 preparation distinguishes an unknown delivery from a committed inner retry', options, async t => {
  const f = await fixture(t), successorId = randomUUID()
  await f.addIntent(); await f.addUsage(successorId, 'new-v2-retry-key', 'committed')
  await f.addBinding('new-v2-retry-key', 'unknown', successorId)
  await f.db.query(`INSERT INTO external_platform.twitter_manual_retries
    (original_usage_request_id,successor_usage_request_id,tenant_id,consumer_id,api_key_id,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6)`, [f.originalId, successorId, f.tenantId, f.consumerId, f.apiKeyId, f.fingerprint])
  const result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.successor.requestId, successorId)
  assert.equal(result.successor.status, 'committed')
  assert.equal(result.retryIntent.state, 'unknown')
  assert.equal(result.retryIntent.requestId, successorId)
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [f.originalId])).rows[0].status, 'unknown')
})

test('PG v2 preparation rejects mismatched saved Key/platform evidence rather than falling back to v1', options, async t => {
  const f = await fixture(t), otherKeyId = randomUUID()
  await f.db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Other fixture',$4,'other','1111')",
    [otherKeyId, f.tenantId, f.consumerId, 'c'.repeat(64)])
  for (const patch of ["platform='facebook'", `api_key_id='${otherKeyId}'::uuid`]) {
    await f.db.query(`UPDATE control.data_search_protocol_bindings SET platform='twitter',api_key_id=$2 WHERE usage_request_id=$1`, [f.originalId, f.apiKeyId])
    await f.db.query(`UPDATE control.data_search_protocol_bindings SET ${patch} WHERE usage_request_id=$1`, [f.originalId])
    const result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
    assert.equal(result.eligibility.allowed, false)
    assert.equal(result.requestEvidence.request, null)
  }
})

test('PG expired running retry intent is read as unknown without changing its durable state', options, async t => {
  const f = await fixture(t)
  await f.addIntent(); await f.addBinding('new-v2-retry-key', 'running')
  await f.db.query("UPDATE control.data_search_protocol_bindings SET lease_expires_at=now()-interval '1 hour' WHERE idempotency_key='new-v2-retry-key'")
  const result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.retryIntent.state, 'unknown')
  assert.equal(result.retryIntent.requestId, null)
  assert.equal((await f.db.query("SELECT state FROM control.data_search_protocol_bindings WHERE idempotency_key='new-v2-retry-key'")).rows[0].state, 'running')
})

test('PG explicit resume proof excludes every own call, manual edge and unresolved usage before allowing the same key', options, async t => {
  const f = await fixture(t), ownId = randomUUID()
  await f.addIntent(); await f.addBinding('new-v2-retry-key', 'retryable')
  assert.equal((await f.history.getAdminTwitterRetryPreparation(f.originalId)).retryIntent.resumeAllowed, true)
  await f.addUsage(ownId, 'new-v2-retry-key', 'released')
  await f.db.query("UPDATE control.data_search_protocol_bindings SET usage_request_id=$1 WHERE idempotency_key='new-v2-retry-key'", [ownId])
  let result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
  assert.equal(result.retryIntent.resumeAllowed, true)
  assert.equal(result.retryIntent.usageStatus, 'released')
  await f.db.query(`INSERT INTO external_platform.twitter_manual_retries
    (original_usage_request_id,successor_usage_request_id,tenant_id,consumer_id,api_key_id,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6)`, [f.originalId, ownId, f.tenantId, f.consumerId, f.apiKeyId, f.fingerprint])
  assert.equal((await f.history.getAdminTwitterRetryPreparation(f.originalId)).retryIntent.resumeAllowed, false)
  await f.db.query('DELETE FROM external_platform.twitter_manual_retries WHERE successor_usage_request_id=$1', [ownId])
  await f.db.query("UPDATE usage_requests SET status='unknown' WHERE id=$1", [ownId])
  assert.equal((await f.history.getAdminTwitterRetryPreparation(f.originalId)).retryIntent.resumeAllowed, false)
  await f.db.query("UPDATE usage_requests SET status='released' WHERE id=$1", [ownId])
  await f.db.query(`INSERT INTO external_platform.provider_calls
    (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
      marketplace,request_fingerprint,outcome,completed_at)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'social.content.search','mx-insight-hub.social-data.v1','twitter-aio.search',
      'twitter-aio.hub.v1','twitter',$6,'rejected',now())`, [randomUUID(), f.tenantId, f.consumerId, f.apiKeyId, ownId, f.fingerprint])
  result = await f.history.getAdminTwitterRetryPreparation(f.originalId)
  assert.equal(result.retryIntent.resumeAllowed, false)
  assert.equal((await f.db.query('SELECT status FROM usage_requests WHERE id=$1', [f.originalId])).rows[0].status, 'unknown')
})
