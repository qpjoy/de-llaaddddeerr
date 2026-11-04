import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { RapidApiAdapter, RapidApiUpstreamError } from '../../server/adapters/rapidapi.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'
import { createRapidApiProxyFetch } from '../../server/external-platforms/proxy.mjs'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { AppError } from '../../server/core/errors.mjs'

const SECRET = 'synthetic-rapidapi-transport-secret'
const request = () => normalizeHubSocialRequest('search', { platform: 'twitter', query: 'fixture #chipban' })
const causeWithCode = code => Object.assign(new Error(`private query and ${SECRET}`), { code })
async function failed(fetchImpl, timeoutMs = 30000) {
  let calls = 0
  const adapter = new RapidApiAdapter({ apiKey: SECRET, timeoutMs,
    fetchImpl: async (...args) => { calls++; return fetchImpl(...args) } })
  const error = await adapter.execute(request()).then(() => assert.fail('Expected failure'), error => error)
  assert.ok(error instanceof RapidApiUpstreamError)
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(error), /transportFailure|ENOTFOUND|private query|synthetic-rapidapi/)
  return error
}
function detail(error, phase, codes) {
  const saved = error.responseArchive.rawPayload.response.transportFailure
  assert.equal(saved.phase, phase)
  assert.deepEqual(saved.codes, codes)
  assert.ok(Number.isSafeInteger(saved.elapsedMs) && saved.elapsedMs >= 0)
  assert.equal(typeof saved.deadlineExceeded, 'boolean')
  assert.deepEqual(Object.keys(saved).sort(), ['codes','deadlineExceeded','elapsedMs','phase','timeoutMs'])
  assert.doesNotMatch(JSON.stringify(error.responseArchive), /private query|synthetic-rapidapi|stack|https?:/)
  return saved
}

test('RapidAPI preheader causes retain bounded safe metadata with no fabricated response body or changed unknown classification', async () => {
  const nested = new AggregateError([causeWithCode('ENOTFOUND'), causeWithCode(SECRET), causeWithCode('ENOTFOUND')], SECRET)
  nested.cause = causeWithCode('UND_ERR_CONNECT_TIMEOUT')
  nested.errors.push(nested)
  const error = await failed(async () => { throw new TypeError(SECRET, { cause: nested }) })
  assert.deepEqual(error.evidence, { outcome: 'unknown', billed: null, httpStatus: null, businessCode: null,
    errorCode: 'social_upstream_response_unusable' })
  const saved = detail(error, 'request', ['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND'])
  assert.equal(saved.timeoutMs, 30000); assert.equal(saved.deadlineExceeded, false)
  assert.equal(error.responseArchive.contractState, 'unknown')
  for (const key of ['httpStatus','contentType','bodySize','payloadSha256']) assert.equal(error.responseArchive[key], null)
  assert.equal(error.restrictedResponseArchive, null)
  assert.deepEqual(error.archiveObjects, [])
  assert.deepEqual(error.upstreamEvidence, { requestId: null })
})

test('RapidAPI metadata preserves a route-read SQLSTATE but does not assume the unknown call was sent', async () => {
  let businessCalls = 0
  const transport = createRapidApiProxyFetch({ route: async () => { throw causeWithCode('57P01') } }, {
    fetchImpl: async () => { businessCalls++; return new Response('{}') },
  })
  const error = await failed(transport)
  assert.equal(businessCalls, 0)
  assert.equal(error.evidence.outcome, 'unknown'); assert.equal(error.evidence.billed, null)
  detail(error, 'request', ['57P01'])
})

test('RapidAPI proxy rejection retains its known unbilled classification and safe preflight code', async () => {
  const error = await failed(async () => { throw new AppError(503, 'proxy_routes_unreachable', SECRET, { credential: SECRET }) })
  assert.deepEqual(error.evidence, { outcome: 'rejected', billed: false, httpStatus: null, businessCode: null,
    errorCode: 'social_egress_unavailable', affectsCircuit: false })
  assert.equal(error.responseArchive.contractState, 'not_dispatched')
  detail(error, 'request', ['proxy_routes_unreachable'])
})

test('RapidAPI preheader deadline retains unknown and does not redispatch', async () => {
  const error = await failed(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }), 10)
  assert.equal(error.evidence.outcome, 'unknown')
  assert.equal(error.evidence.errorCode, 'social_upstream_timeout_or_size_limit')
  const saved = detail(error, 'request', [])
  assert.equal(saved.deadlineExceeded, true); assert.equal(saved.timeoutMs, 10)
})

test('RapidAPI body failure keeps received status and existing outcome without inventing complete bytes', async () => {
  const error = await failed(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError(SECRET, { cause: causeWithCode('UND_ERR_SOCKET') })) },
  }), { status: 200, headers: { 'content-type': 'application/json', 'x-rapidapi-request-id': 'fixture-upstream' } }))
  assert.equal(error.evidence.outcome, 'succeeded_unusable'); assert.equal(error.evidence.httpStatus, 200)
  assert.equal(error.restrictedResponseArchive, null)
  assert.equal(error.responseArchive.bodySize, null); assert.equal(error.responseArchive.payloadSha256, null)
  assert.equal(error.upstreamEvidence.requestId, 'fixture-upstream')
  detail(error, 'body', ['UND_ERR_SOCKET'])
})

test('RapidAPI complete invalid JSON retains exact bytes and no transport diagnosis', async () => {
  const error = await failed(async () => new Response('not json', { status: 200 }))
  assert.equal(error.evidence.outcome, 'succeeded_unusable')
  assert.equal(error.responseArchive.rawPayload.response.transportFailure, undefined)
  assert.equal(error.restrictedResponseArchive.bodyBytes.toString(), 'not json')
})

test('Twitter HTTP 429 retains only fixed numeric rate headers before rejecting without changing public evidence', async () => {
  const started = Date.now()
  const error = await failed(async () => Response.json({ message: 'synthetic rejection' }, { status: 429, headers: {
    'retry-after': '12', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000',
    'x-ratelimit-requests-limit': '1000', 'x-ratelimit-requests-remaining': '700', 'x-ratelimit-requests-reset': '86400',
    'authorization': SECRET, 'set-cookie': SECRET, 'x-ratelimit-private-limit': SECRET,
    'x-rapidapi-requests-limit': '999',
  } }))
  assert.deepEqual(error.evidence, { outcome: 'rejected', billed: null, httpStatus: 429, businessCode: null,
    errorCode: 'social_upstream_rejected', affectsCircuit: false })
  const saved = error.responseArchive.rawPayload.response.rateLimit
  assert.ok(Date.parse(saved.observedAt) >= started && Date.parse(saved.observedAt) <= Date.now())
  assert.deepEqual({ ...saved, observedAt: null }, { observedAt: null, httpStatus: 429, retryAfterSeconds: 12, headers: {
    'x-ratelimit-limit': 10, 'x-ratelimit-remaining': 0, 'x-ratelimit-reset': 1790000000,
    'x-ratelimit-requests-limit': 1000, 'x-ratelimit-requests-remaining': 700, 'x-ratelimit-requests-reset': 86400,
  } })
  assert.doesNotMatch(JSON.stringify(error.responseArchive), /synthetic-rapidapi|authorization|cookie|private-limit|monthly|x-rapidapi-requests/u)
  assert.doesNotMatch(JSON.stringify(error), /rateLimit|retryAfterSeconds|ratelimit/u)
})

test('Twitter Retry-After date and rate headers survive a body read failure without changing its existing unknown outcome', async () => {
  const until = new Date(Date.now() + 60000).toUTCString()
  const error = await failed(async () => new Response(new ReadableStream({
    start(controller) { controller.error(causeWithCode('UND_ERR_SOCKET')) },
  }), { status: 429, headers: { 'retry-after': until, 'x-ratelimit-remaining': '0' } }))
  assert.equal(error.evidence.outcome, 'unknown'); assert.equal(error.evidence.httpStatus, 429)
  assert.equal(error.restrictedResponseArchive, null)
  const saved = error.responseArchive.rawPayload.response.rateLimit
  assert.equal(saved.retryAfterSeconds, Math.max(0, Math.ceil((Date.parse(until) - Date.parse(saved.observedAt)) / 1000)))
  assert.equal(saved.headers['x-ratelimit-remaining'], 0)
  detail(error, 'body', ['UND_ERR_SOCKET'])
})

test('Twitter malformed headers are null and invalid bodies keep their existing classification and exact archive', async () => {
  for (const invalid of [SECRET, '-1', '1.5', '1e3', '9007199254740992', '1'.repeat(256)]) {
    const error = await failed(async () => new Response('not json', { status: 429, headers: {
      'retry-after': invalid, 'x-ratelimit-limit': invalid, 'x-ratelimit-requests-remaining': invalid,
    } }))
    assert.equal(error.evidence.outcome, 'rejected'); assert.equal(error.evidence.affectsCircuit, false)
    assert.equal(error.restrictedResponseArchive.bodyBytes.toString(), 'not json')
    const saved = error.responseArchive.rawPayload.response.rateLimit
    assert.equal(saved.retryAfterSeconds, null)
    assert.ok(Object.values(saved.headers).every(value => value === null))
    assert.doesNotMatch(JSON.stringify(error.responseArchive), /synthetic-rapidapi/u)
  }
  const preheader = await failed(async () => { throw causeWithCode('ENOTFOUND') })
  assert.equal(preheader.responseArchive.rawPayload.response.rateLimit, undefined)
})

test('RapidAPI body-size abort is not reported as a deadline expiration', async () => {
  const error = await failed(async () => new Response('{}', {
    status: 200, headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
  }))
  assert.equal(error.evidence.outcome, 'succeeded_unusable')
  assert.equal(error.evidence.errorCode, 'social_upstream_timeout_or_size_limit')
  assert.equal(detail(error, 'body', []).deadlineExceeded, false)
  assert.equal(error.restrictedResponseArchive, null)
})

test('RapidAPI diagnostic exception accessors cannot replace the original unknown outcome', async () => {
  const error = await failed(async () => { throw Object.defineProperty(new Error(SECRET), 'code', {
    get() { throw new Error('Diagnostic accessor is unavailable') },
  }) })
  assert.equal(error.evidence.outcome, 'unknown')
  detail(error, 'request', [])
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('PG RapidAPI preheader metadata persists atomically while the production billing trigger retains the unknown hold', {
  skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL constraints',
}, async t => {
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
  const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
  const table = (sql, name) => {
    const ddl = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replaceAll('.', '\\.')} \\([\\s\\S]*?\\n\\);`))?.[0]
    assert.ok(ddl); return ddl
  }
  const archiveMigration = await migration('051_external_platform_gateway.sql')
  await db.exec(table(archiveMigration, 'external_platform.response_archives'))
  await db.exec(table(archiveMigration, 'external_platform.archive_objects'))
  await db.exec(table(await migration('058_external_platform_restricted_raw_responses.sql'), 'control.external_platform_restricted_raw_responses'))
  const settlement = (await migration('056_commercial_billing_ledger.sql')).match(/CREATE OR REPLACE FUNCTION billing\.settle_customer_charge\(\)[\s\S]*?EXECUTE FUNCTION billing\.settle_customer_charge\(\);/u)?.[0]
  assert.ok(settlement); await db.exec(settlement)
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  const store = new PostgresExternalPlatformStore({ pool, providerKey: 'rapidapi', authorizationPlatform: 'twitter' })
  const callId = randomUUID(), usageId = randomUUID(), tenantId = randomUUID()
  await db.query("INSERT INTO external_platform.provider_calls(id,outcome,cost_kind) VALUES($1,'pending','unknown')", [callId])
  await db.query("INSERT INTO usage_requests(id,status) VALUES($1,'reserved')", [usageId])
  await db.query("INSERT INTO billing.customer_charges VALUES($1,$2,$3,$4,'reserved','enforced',9,'CNY',NULL,NULL)", [randomUUID(), usageId, tenantId, randomUUID()])
  const error = await failed(async () => { throw new TypeError(SECRET, { cause: causeWithCode('ENOTFOUND') }) })
  const evidence = { ...error.evidence, callId,
    delivery: { tenantId, consumerId: randomUUID(), apiKeyId: randomUUID(), usageRequestId: usageId,
      operation: 'social.content.search', fingerprint: 'a'.repeat(64) },
    costMinor: 1, costKind: 'estimated', currency: 'USD', latencyMs: 1, affectsCircuit: false,
    responseArchive: error.responseArchive, restrictedResponseArchive: error.restrictedResponseArchive,
    archiveObjects: error.archiveObjects, upstreamEvidence: error.upstreamEvidence, failureResponseStatus: 502 }
  await store.finishFailure(evidence)
  const saved = (await db.query('SELECT * FROM external_platform.response_archives WHERE provider_call_id=$1', [callId])).rows[0]
  assert.deepEqual(saved.raw_payload, error.responseArchive.rawPayload)
  for (const field of ['http_status', 'content_type', 'body_size', 'payload_sha256']) assert.equal(saved[field], null)
  assert.deepEqual((await db.query('SELECT outcome,http_status,billed,error_code FROM external_platform.provider_calls')).rows[0],
    { outcome: 'unknown', http_status: null, billed: null, error_code: 'social_upstream_response_unusable' })
  assert.equal((await db.query('SELECT status FROM usage_requests')).rows[0].status, 'unknown')
  assert.deepEqual((await db.query('SELECT status,charged_minor FROM billing.customer_charges')).rows[0], { status: 'unknown', charged_minor: null })
  assert.deepEqual((await db.query(`SELECT (SELECT count(*)::int FROM billing.credit_ledger_entries) AS ledger,
    (SELECT count(*)::int FROM control.external_platform_restricted_raw_responses) AS restricted,
    (SELECT count(*)::int FROM external_platform.archive_objects) AS objects,
    (SELECT count(*)::int FROM external_platform.gateway_requests) AS gateways`)).rows[0], { ledger: 0, restricted: 0, objects: 0, gateways: 1 })
  await assert.rejects(store.finishFailure(evidence), { code: 'external_platform_call_state_conflict' })
  assert.equal((await db.query('SELECT count(*)::int AS n FROM external_platform.response_archives')).rows[0].n, 1)
})
