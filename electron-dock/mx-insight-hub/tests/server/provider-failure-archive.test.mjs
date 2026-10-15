import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { TikHubAdapter, TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const options = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL constraints' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
const createTable = (source, name) => {
  const ddl = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replaceAll('.', '\\.')} \\([\\s\\S]*?\\n\\);`))?.[0]
  assert.ok(ddl, `Actual table DDL must exist: ${name}`)
  return ddl
}
const bodies = {
  invalid_json: 'not-json',
  unsafe_utf16: '{"code":200,"data":{"mixFeeds":[{"photoId":"fixture","caption":"\\ud800"}]}}',
  negative_zero: '{"code":200,"data":{"mixFeeds":[{"photoId":"fixture","caption":"body","likeCount":-0}]}}',
  deep_clone_fallback: '{"code":400,"data":' + '{"nested":'.repeat(12000) + 'null' + '}'.repeat(12000) + '}',
}

async function fixture(t, body = bodies.invalid_json) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA billing;
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,outcome text,http_status int,business_code int,billed boolean,
      cost_minor bigint,cost_kind text,currency text,upstream_request_id text,upstream_record_time text,latency_ms int,error_code text,completed_at timestamptz);
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,status text,error_code text,completed_at timestamptz,response_status int,response_body jsonb,
      units_actual int,upstream_latency_ms int,delivery_source_mode text,response_captured_at timestamptz);
    CREATE TABLE external_platform.gateway_requests(id uuid,provider_key text,tenant_id uuid,consumer_id uuid,usage_request_id uuid,
      request_fingerprint char(64),source_mode text,succeeded boolean,response_status int,provider_call_id uuid,snapshot_id uuid,error_code text);
    CREATE TABLE billing.customer_charges(id uuid,usage_request_id uuid,tenant_id uuid,account_id uuid,status text,
      enforcement_mode text,quoted_minor int,currency text,charged_minor int,settled_at timestamptz);
    CREATE TABLE billing.credit_ledger_entries(account_id uuid,tenant_id uuid,charge_id uuid,usage_request_id uuid,kind text,amount_minor int,
      available_delta_minor int,held_delta_minor int,currency text,idempotency_key text UNIQUE,actor text,reason text);`)
  const archiveMigration = await migration('051_external_platform_gateway.sql')
  await db.exec(createTable(archiveMigration, 'external_platform.response_archives'))
  await db.exec(createTable(archiveMigration, 'external_platform.archive_objects'))
  await db.exec(createTable(await migration('058_external_platform_restricted_raw_responses.sql'), 'control.external_platform_restricted_raw_responses'))
  const billing = (await migration('056_commercial_billing_ledger.sql')).match(/CREATE OR REPLACE FUNCTION billing\.settle_customer_charge\(\)[\s\S]*?EXECUTE FUNCTION billing\.settle_customer_charge\(\);/u)?.[0]
  assert.ok(billing); await db.exec(billing)
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  const store = new PostgresExternalPlatformStore({ pool, providerKey: 'tikhub', authorizationPlatform: 'kuaishou' })
  const callId = randomUUID(), usageId = randomUUID(), tenantId = randomUUID()
  await db.query("INSERT INTO external_platform.provider_calls(id,outcome,cost_kind) VALUES($1,'pending','unknown')", [callId])
  await db.query("INSERT INTO usage_requests(id,status) VALUES($1,'reserved')", [usageId])
  await db.query("INSERT INTO billing.customer_charges VALUES($1,$2,$3,$4,'reserved','enforced',9,'CNY',NULL,NULL)", [randomUUID(), usageId, tenantId, randomUUID()])
  let fetchCalls = 0, error
  const bytes = Buffer.from(body), adapter = new TikHubAdapter({ apiKey: 'synthetic-fixture-only', fetchImpl: async () => {
    fetchCalls++; return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  try { await adapter.forwardNative('t.kuaishou_app_search_comprehensive', { params: { keyword: 'fixture' } }) } catch (cause) { error = cause }
  assert.ok(error instanceof TikHubUpstreamError)
  assert.equal(error.archiveObjects[0].rawPayload, null)
  const delivery = { tenantId, consumerId: randomUUID(), apiKeyId: randomUUID(), usageRequestId: usageId,
    operation: 'native.t.kuaishou_app_search_comprehensive', fingerprint: 'a'.repeat(64) }
  const response = { error: { code: 'fixture_saved_failure', message: 'Saved provider failure' }, requestId: usageId }
  const evidence = { ...error.evidence, callId, delivery, costMinor: 1, costKind: 'estimated', currency: 'USD', latencyMs: 1, affectsCircuit: false,
    responseArchive: error.responseArchive, restrictedResponseArchive: error.restrictedResponseArchive,
    archiveObjects: error.archiveObjects, upstreamEvidence: error.upstreamEvidence, failureResponseStatus: 502, failureResponseBody: response }
  const state = async () => ({
    usage: (await db.query('SELECT status,response_status,response_body,error_code FROM usage_requests WHERE id=$1', [usageId])).rows[0],
    call: (await db.query('SELECT outcome,http_status,business_code,billed,error_code FROM external_platform.provider_calls WHERE id=$1', [callId])).rows[0],
    charge: (await db.query('SELECT status,charged_minor FROM billing.customer_charges WHERE usage_request_id=$1', [usageId])).rows[0],
    ledger: (await db.query('SELECT count(*)::int AS count,coalesce(sum(held_delta_minor),0)::int AS held_delta FROM billing.credit_ledger_entries')).rows[0],
    counts: (await db.query(`SELECT (SELECT count(*)::int FROM external_platform.response_archives) AS operational,
      (SELECT count(*)::int FROM control.external_platform_restricted_raw_responses) AS restricted,
      (SELECT count(*)::int FROM external_platform.archive_objects) AS objects,
      (SELECT count(*)::int FROM external_platform.gateway_requests) AS gateways`)).rows[0],
  })
  return { db, store, evidence, bytes, response, error, state, fetchCalls: () => fetchCalls }
}

async function assertExactArchive(f) {
  const raw = (await f.db.query('SELECT * FROM control.external_platform_restricted_raw_responses')).rows[0]
  assert.ok(Buffer.from(raw.body_bytes).equals(f.bytes))
  assert.equal(raw.body_size, f.bytes.length)
  assert.equal(raw.body_sha256, digest(f.bytes))
  const object = (await f.db.query("SELECT raw_payload IS NULL AS sql_null,jsonb_typeof(raw_payload) AS json_type,raw_payload FROM external_platform.archive_objects")).rows[0]
  assert.deepEqual(object, { sql_null: false, json_type: 'null', raw_payload: null })
  assert.equal((await f.db.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='external_platform' AND table_name='archive_objects' AND column_name='raw_payload'")).rows[0].is_nullable, 'NO')
}

for (const [name, body] of Object.entries(bodies)) test(`PG ${name} failure retains exact response evidence and original billing classification as stable 502`, options, async t => {
  const f = await fixture(t, body)
  await f.store.finishFailure(f.evidence)
  await assertExactArchive(f)
  const saved = await f.state()
  assert.equal(saved.usage.status, 'committed'); assert.equal(saved.usage.response_status, 502)
  assert.deepEqual(saved.usage.response_body, f.response)
  assert.equal(saved.call.outcome, f.error.evidence.outcome)
  assert.equal(saved.call.billed, f.error.evidence.billed)
  assert.equal(saved.call.error_code, f.error.evidence.errorCode)
  assert.deepEqual(saved.counts, { operational: 1, restricted: 1, objects: 1, gateways: 1 })
  assert.deepEqual(saved.charge, { status: 'captured', charged_minor: 9 })
  assert.deepEqual(saved.ledger, { count: 1, held_delta: -9 })
  await assert.rejects(f.store.finishFailure(f.evidence), { code: 'external_platform_call_state_conflict' })
  assert.deepEqual(await f.state(), saved)
  assert.equal(f.fetchCalls(), 1)
})

test('PG uncertainty persistence retains the same exact response but does not settle the unknown customer hold', options, async t => {
  const f = await fixture(t, bodies.unsafe_utf16)
  assert.equal(await f.store.markPersistenceUnknown(f.evidence), true)
  await assertExactArchive(f)
  const saved = await f.state()
  assert.equal(saved.usage.status, 'unknown'); assert.equal(saved.call.outcome, 'unknown')
  assert.deepEqual(saved.charge, { status: 'unknown', charged_minor: null })
  assert.deepEqual(saved.ledger, { count: 0, held_delta: 0 })
  assert.deepEqual(saved.counts, { operational: 1, restricted: 1, objects: 1, gateways: 1 })
  assert.equal(await f.store.markPersistenceUnknown(f.evidence), false)
  assert.deepEqual(await f.state(), saved)
  assert.equal(f.fetchCalls(), 1)
})

test('PG response-null exception does not allow null item payloads or undefined response payloads', options, async t => {
  const f = await fixture(t)
  const original = await f.state()
  for (const [kind, value] of [['item', null], ['response', undefined], ['item', undefined]]) {
    const archiveObjects = [{ ...f.evidence.archiveObjects[0], kind, rawPayload: value }]
    await assert.rejects(f.store.finishFailure({ ...f.evidence, archiveObjects }), error => error.code === '23502' && error.table === 'archive_objects' && error.column === 'raw_payload')
    assert.deepEqual(await f.state(), original)
  }
  assert.equal(f.fetchCalls(), 1)
})

test('PG downstream database failure rolls back all archives and billing capture, retaining the original reservation', options, async t => {
  const f = await fixture(t)
  await f.db.exec(`CREATE FUNCTION reject_fixture_gateway() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'Synthetic database failure' USING ERRCODE='23514'; END; $$;
    CREATE TRIGGER reject_fixture_gateway BEFORE INSERT ON external_platform.gateway_requests FOR EACH ROW EXECUTE FUNCTION reject_fixture_gateway();`)
  const original = await f.state()
  await assert.rejects(f.store.finishFailure(f.evidence), { code: '23514' })
  assert.deepEqual(await f.state(), original)
  assert.deepEqual(original.charge, { status: 'reserved', charged_minor: null })
  assert.deepEqual(original.ledger, { count: 0, held_delta: 0 })
  assert.deepEqual(original.counts, { operational: 0, restricted: 0, objects: 0, gateways: 0 })
  await assert.rejects(f.store.markPersistenceUnknown(f.evidence), { code: '23514' })
  assert.deepEqual(await f.state(), original)
  assert.equal(f.fetchCalls(), 1)
})
