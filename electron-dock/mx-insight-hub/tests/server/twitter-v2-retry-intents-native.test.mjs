import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { DATA_SEARCH_V2_PATH, normalizeDataSearchV2, prepareDataSearchV2, projectDataSearchV2, dataSearchQueryHash } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'
import { claimTwitterManualRetry } from '../../server/external-platforms/twitter-manual-retry.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL
const native = { skip: !connectionString && 'Requires disposable native PostgreSQL', timeout: 30000 }
const pepper = 'native-twitter-retry-fixture-pepper-at-least-32-bytes'
const body = normalizeDataSearchV2({ platform: 'twitter', query: 'synthetic concurrency fixture', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-18T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })

async function fixture(t) {
  const admin = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 3000 })
  const database = `twitter_retry_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(connectionString); url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.href, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 5000, lock_timeout: 3000 })
  t.after(async () => {
    await pool.end()
    try { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) } finally { await admin.end() }
  })
  await pool.query('CREATE SCHEMA control; CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  for (const name of ['001_initial.sql', '004_reservation_lease.sql', '051_external_platform_gateway.sql',
    '053_external_platform_uncertain_retry.sql', '094_acquisition_request_snapshot.sql', '152_twitter_manual_retry.sql',
    '158_data_search_v2_protocol.sql', '162_twitter_v2_retry_intents.sql']) {
    await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'))
  }
  await pool.query('CREATE UNIQUE INDEX fixture_owned_usage ON usage_requests(id,tenant_id,consumer_id,api_key_id,fingerprint)')
  const bindingsDdl = (await readFile(new URL('../../migrations/054_api_key_entitlements_plans_and_tikhub.sql', import.meta.url), 'utf8'))
    .match(/CREATE TABLE IF NOT EXISTS usage_idempotency_bindings \([\s\S]*?\n\);/u)?.[0]
  assert.ok(bindingsDdl)
  await pool.query(bindingsDdl)
  const context = { tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }
  const originalId = randomUUID(), oldKey = 'native-original-unknown-key'
  const snapshot = { method: 'POST', path: '/api/v1/data/search', body: prepareDataSearchV2(body,
    createDataSearchV2CursorCodec(pepper, `${context.consumer.id}:${context.apiKey.id}`)).upstream }
  const fingerprint = requestFingerprint(snapshot)
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Fixture')", [context.tenant.id])
  await pool.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Fixture',$3)", [context.consumer.id, context.tenant.id, context.consumer.id])
  await pool.query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four)
    VALUES($1,$2,$3,'Fixture',$4,'fixture','0000')`, [context.apiKey.id, context.tenant.id, context.consumer.id, 'a'.repeat(64)])
  const addUsage = async (id, key, status) => pool.query(`INSERT INTO usage_requests
    (id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,acquisition_request,lease_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,'twitter',$7,$8,now()+interval '2 minutes')`,
  [id, context.tenant.id, context.consumer.id, context.apiKey.id, key, fingerprint, status, JSON.stringify(snapshot)])
  await addUsage(originalId, oldKey, 'unknown')
  await pool.query(`INSERT INTO control.data_search_protocol_bindings
    (consumer_id,idempotency_key,tenant_id,api_key_id,platform,query_hash,fingerprint,request_body,state,owner_id,lease_expires_at,usage_request_id)
    VALUES($1,$2,$3,$4,'twitter',$5,$6,$7,'unknown',$8,now()+interval '5 minutes',$9)`,
  [context.consumer.id, oldKey, context.tenant.id, context.apiKey.id, dataSearchQueryHash(body.query),
    requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body }), JSON.stringify(body), randomUUID(), originalId])
  await pool.query(`INSERT INTO external_platform.provider_calls
    (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
      marketplace,request_fingerprint,outcome,completed_at)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'social.content.search','mx-insight-hub.social-data.v1','twitter-aio.search',
      'twitter-aio.hub.v1','twitter',$6,'unknown',now())`,
  [randomUUID(), context.tenant.id, context.consumer.id, context.apiKey.id, originalId, fingerprint])
  const store = { pool }, protocol = new SearchProtocolStore(store), retryStore = { pool, providerKey: 'rapidapi' }
  const input = key => ({ version: 2, body, idempotencyKey: key, retryOfRequestId: originalId, retryStore, apiKeyPepper: pepper })
  return { pool, protocol, context, originalId, fingerprint, retryStore, input, addUsage }
}

test('native PG binds only one rival successor key before any new usage or provider call', native, async t => {
  const f = await fixture(t)
  const before = (await f.pool.query('SELECT * FROM usage_requests WHERE id=$1', [f.originalId])).rows[0]
  const attempts = await Promise.allSettled(['native-rival-retry-one', 'native-rival-retry-two'].map(key => f.protocol.begin(f.context, f.input(key))))
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1,
    attempts.filter(value => value.status === 'rejected').map(value => value.reason.stack).join('\n'))
  const winner = attempts.find(value => value.status === 'fulfilled').value
  const intent = (await f.pool.query('SELECT * FROM control.data_search_protocol_retries')).rows
  assert.equal(intent.length, 1)
  assert.equal(intent[0].successor_idempotency_key, winner.input.idempotencyKey)
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 1)
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n, 1)
  assert.deepEqual((await f.pool.query('SELECT * FROM usage_requests WHERE id=$1', [f.originalId])).rows[0], before)
})

test('native PG same-key overlap never duplicates the intent and only its retryable identity can resume', native, async t => {
  const f = await fixture(t), key = 'native-same-retry-key'
  const attempts = await Promise.allSettled([f.protocol.begin(f.context, f.input(key)), f.protocol.begin(f.context, f.input(key))])
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1,
    attempts.filter(value => value.status === 'rejected').map(value => value.reason.stack).join('\n'))
  const lease = attempts.find(value => value.status === 'fulfilled').value
  await f.protocol.finish(lease.input, { state: 'retryable' })
  const { retryOfRequestId: _, ...sameKeyWithoutHeader } = f.input(key)
  const resumed = await f.protocol.begin(f.context, sameKeyWithoutHeader)
  assert.equal(resumed.retryOfRequestId, f.originalId)
  assert.equal(resumed.input.idempotencyKey, key)
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM control.data_search_protocol_retries')).rows[0].n, 1)
  await assert.rejects(f.protocol.begin(f.context, f.input('native-another-key')), error => error.status === 409)
})

test('native PG v1 paid-claim and v2 intent arbitration cannot fork the same unknown', native, async t => {
  const f = await fixture(t), legacyId = randomUUID(), legacyKey = 'native-legacy-rival-key'
  await f.addUsage(legacyId, legacyKey, 'reserved')
  const legacyClaim = async () => {
    const client = await f.pool.connect()
    try {
      await client.query('BEGIN')
      await claimTwitterManualRetry(f.retryStore, { retryOfRequestId: f.originalId, usageRequestId: legacyId,
        tenantId: f.context.tenant.id, consumerId: f.context.consumer.id, apiKeyId: f.context.apiKey.id,
        fingerprint: f.fingerprint, idempotencyKey: legacyKey }, client)
      await client.query('COMMIT')
      return 'v1'
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  const attempts = await Promise.allSettled([legacyClaim(), f.protocol.begin(f.context, f.input('native-v2-rival-key'))])
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1)
  const { rows: [counts] } = await f.pool.query(`SELECT
    (SELECT count(*)::int FROM control.data_search_protocol_retries) AS intents,
    (SELECT count(*)::int FROM external_platform.twitter_manual_retries) AS paid_claims`)
  assert.equal(counts.intents + counts.paid_claims, 1)
  assert.equal((await f.pool.query('SELECT status FROM usage_requests WHERE id=$1', [f.originalId])).rows[0].status, 'unknown')
})

test('native PG recovery reads the exact completed v2 successor without rewriting original evidence', native, async t => {
  const f = await fixture(t), key = 'native-completed-retry-key', successorId = randomUUID()
  const lease = await f.protocol.begin(f.context, f.input(key))
  await f.addUsage(successorId, key, 'committed')
  const codec = createDataSearchV2CursorCodec(pepper, `${f.context.consumer.id}:${f.context.apiKey.id}`)
  const result = projectDataSearchV2({ status: 200, requestId: successorId, replay: false, sourceMode: 'live',
    body: { data: { platform: 'twitter', query: body.query, items: [], status: 'ok', warnings: [],
      pageInfo: { pageSize: 20, returnedCount: 0, hasMore: false, nextCursor: null, cursorType: 'none' } } } },
  body, prepareDataSearchV2(body, codec), codec)
  await f.protocol.finish(lease.input, { state: 'complete', result, usageRequestId: successorId })
  const before = (await f.pool.query('SELECT * FROM usage_requests ORDER BY id')).rows
  const queries = []
  const readPool = { connect: async () => {
    const client = await f.pool.connect()
    return { query: (sql, args) => { queries.push(sql); return client.query(sql, args) }, release: error => client.release(error) }
  } }
  const receipt = await new SearchProtocolStore({ pool: readPool }).twitterRecovery(f.context, f.originalId, { apiKeyPepper: pepper })
  assert.equal(receipt.originalRequestId, f.originalId)
  assert.equal(receipt.state, 'unknown')
  assert.equal(receipt.successor.requestId, successorId)
  assert.equal(receipt.successor.state, 'complete')
  assert.deepEqual(receipt.delivery, { requestId: successorId, status: 200, body: result.body })
  assert.deepEqual((await f.pool.query('SELECT * FROM usage_requests ORDER BY id')).rows, before)
  assert.equal(queries.some(sql => /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(sql)), false)
  await assert.rejects(f.protocol.twitterRecovery({ ...f.context, apiKey: { id: randomUUID() } }, f.originalId,
    { apiKeyPepper: pepper }), error => error.status === 404)
})
