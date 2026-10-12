import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('PostgreSQL buffer reads enforce ownership, success, route, age and receipt integrity; delivery is atomic', {
  skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY, tenant_id uuid, consumer_id uuid, api_key_id uuid,
      platform text, status text, response_status int, acquisition_request jsonb, response_body jsonb,
      units_actual int, upstream_latency_ms int, delivery_source_mode text, response_captured_at timestamptz, completed_at timestamptz);
    CREATE TABLE external_platform.provider_calls (id uuid PRIMARY KEY, usage_request_id uuid REFERENCES usage_requests,
      provider_key text, operation text, outcome text, completed_at timestamptz);
    CREATE TABLE control.external_platform_restricted_raw_responses (provider_call_id uuid REFERENCES external_platform.provider_calls,
      body_bytes bytea, body_sha256 text, captured_at timestamptz, body_size int);
    CREATE TABLE external_platform.gateway_requests (id uuid, provider_key text, tenant_id uuid, consumer_id uuid,
      usage_request_id uuid REFERENCES usage_requests, request_fingerprint text, source_mode text, succeeded boolean,
      response_status int, provider_call_id uuid REFERENCES external_platform.provider_calls, snapshot_id uuid, error_code text);`)
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({
    query: (sql, args) => db.query(sql, args), release() {},
  }) }
  const store = new PostgresExternalPlatformStore({ pool, providerKey: 'tikhub' })
  const input = { callId: randomUUID(), tenantId: randomUUID(), consumerId: randomUUID(), apiKeyId: randomUUID(), path: '/api/v1/data/search' }
  const source = randomUUID(), request = randomUUID(), capturedAt = new Date().toISOString()
  const data = { items: [{ pk: '9007199254740993', code: 'fixture' }] }
  const bytes = Buffer.from('\uFEFF' + JSON.stringify({ code: 200, data }))
  const hash = createHash('sha256').update(bytes).digest('hex')
  await db.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,platform,status,response_status,acquisition_request)
    VALUES ($1,$2,$3,$4,'instagram','committed',200,$5),($6,$2,$3,$4,'instagram','reserved',NULL,$5)`,
  [source, input.tenantId, input.consumerId, input.apiKeyId, JSON.stringify({ path: input.path }), request])
  await db.query(`INSERT INTO external_platform.provider_calls VALUES ($1,$2,'tikhub','native.t.instagram_v3_general_search','succeeded',now())`, [input.callId, source])
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES ($1,$2,$3,$4,$5)`, [input.callId, bytes, hash, capturedAt, bytes.length])
  assert.deepEqual((await store.instagramPageFor(input)).publicBody.data, data)
  for (const field of ['callId', 'tenantId', 'consumerId', 'apiKeyId', 'path']) {
    assert.equal(await store.instagramPageFor({ ...input, [field]: field === 'path' ? '/api/v1/night-all/search/raw' : randomUUID() }), null)
  }
  for (const condition of ["outcome = 'succeeded_unusable'", "completed_at = now() - interval '25 hours'", "operation = 'native.other'"]) {
    await db.exec(`UPDATE external_platform.provider_calls SET ${condition}`)
    assert.equal(await store.instagramPageFor(input), null)
    await db.exec(`UPDATE external_platform.provider_calls SET outcome='succeeded', completed_at=now(), operation='native.t.instagram_v3_general_search'`)
  }
  await db.query(`UPDATE control.external_platform_restricted_raw_responses SET body_sha256=$1`, ['0'.repeat(64)])
  assert.equal(await store.instagramPageFor(input), null)
  await db.query(`UPDATE control.external_platform_restricted_raw_responses SET body_sha256=$1`, [hash])
  const delivery = { tenantId: input.tenantId, consumerId: input.consumerId, usageRequestId: request, fingerprint: 'a'.repeat(64) }
  const saved = { delivery, sourceCallId: input.callId, sourceMode: 'fresh_cache', responseBody: { data: 'fixture' }, capturedAt, usageUnitsActual: 1 }
  await assert.rejects(store.commitInstagramPage({ ...saved, sourceCallId: randomUUID() }))
  assert.equal((await db.query('SELECT status FROM usage_requests WHERE id=$1', [request])).rows[0].status, 'reserved')
  await store.commitInstagramPage(saved)
  const row = (await db.query('SELECT * FROM usage_requests WHERE id=$1', [request])).rows[0]
  assert.equal(row.status, 'committed')
  assert.equal(row.upstream_latency_ms, 0)
  assert.equal(row.units_actual, 1)
  assert.deepEqual(row.response_body, saved.responseBody)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls')).rows[0].n, 1)
  assert.equal((await db.query('SELECT provider_call_id FROM external_platform.gateway_requests')).rows[0].provider_call_id, input.callId)
  await assert.rejects(store.commitInstagramPage(saved), { code: 'usage_request_state_conflict' })
})
