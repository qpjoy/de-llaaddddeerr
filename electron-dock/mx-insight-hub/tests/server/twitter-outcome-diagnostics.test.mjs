import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { diagnoseTwitterOutcome, projectTwitterTransportFailure, twitterOutcomeRuntime } from '../../server/ops/diagnose-twitter-outcome.mjs'

const requestId = 'ced3bb03-709d-438b-8d80-4deada7f8476'
const secret = 'private-query-token-proxy-url-body'
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const source = readFileSync(new URL('../../server/ops/diagnose-twitter-outcome.mjs', import.meta.url), 'utf8')
const transport = { phase: 'request', codes: ['UND_ERR_CONNECT_TIMEOUT', '42P01'], deadlineExceeded: false,
  elapsedMs: 10003, timeoutMs: 30000, message: secret, url: secret, stack: secret }
const migrationTable = (migration, name) => {
  const sql = readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8')
    .match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replaceAll('.', '\\.')} \\([\\s\\S]*?\\n\\);`))?.[0]
  assert.ok(sql); return sql
}

function fixture({ missing = false, platform = 'twitter', path = '/api/v1/data/search', hostile = false, count = 1, fail = '' } = {}) {
  const queries = []
  let released = false, releaseError
  const row = { id: randomUUID(), provider_key: 'rapidapi', operation: 'social.content.search', endpoint_key: 'twitter-aio.search',
    endpoint_version: 'twitter-aio.hub.v1', contract_version: 'mx-insight-hub.social-data.v1', outcome: 'unknown',
    error_code: 'social_upstream_response_unusable', http_status: null, billed: null, item_count: 0, latency_ms: 10005,
    started_at: new Date('2026-10-15T09:31:28Z'), completed_at: new Date('2026-10-15T09:31:38Z'),
    operational_archive_present: true, contract_state: 'unknown', archive_body_size: null, archive_sha256: null,
    restricted_archive_present: false, transport_failure: transport, raw_payload: secret, upstream_request_id: secret }
  if (hostile) for (const key of Object.keys(row)) row[key] = secret
  const pool = { connect: async () => ({ query: async (sql, params) => {
    queries.push({ sql, params })
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT|TRUNCATE)\b/u)
    if (fail && sql.includes(fail)) throw new Error(secret)
    if (sql.includes('twitter-outcome:usage')) return { rows: missing ? [] : [{ platform, request_path: path,
      status: hostile ? secret : 'unknown', error_code: hostile ? secret : 'social_upstream_outcome_unknown',
      response_status: 502, reserved_at: new Date('2026-10-15T09:31:27Z'), completed_at: row.completed_at,
      database_now: new Date('2026-10-15T10:00:00Z') }] }
    if (sql.includes('twitter-outcome:')) return { rows: Array.from({ length: count }, () => row) }
    return { rows: [] }
  }, release: error => { released = true; releaseError = error } }) }
  return { pool, queries, get released() { return released }, get releaseError() { return releaseError } }
}

test('Twitter unknown diagnostic reports only supplied request metadata with preserved null billing and bounded transport evidence', async () => {
  const db = fixture(), result = await diagnoseTwitterOutcome(db.pool, requestId)
  assert.equal(result.errorCode, 'social_upstream_outcome_unknown')
  assert.equal(result.savedHttpStatus, 502)
  assert.equal(result.diagnosticRevision, 'twitter-outcome-diagnostic.v4')
  assert.equal(result.failureDiagnostic.tablePresent, false)
  assert.equal(result.failureDiagnostic.present, false)
  assert.equal(result.failureDiagnostic.record, null)
  assert.deepEqual(result.searchProtocol.tables, { bindings: false, leases: false })
  assert.deepEqual(result.searchProtocol.bindings, [])
  assert.equal(result.legacyConnector.tablePresent, false)
  assert.deepEqual(result.legacyConnector.calls, [])
  assert.equal(result.ownCalls[0].errorCode, 'social_upstream_response_unusable')
  assert.equal(result.ownCalls[0].billed, null)
  assert.equal(result.ownCalls[0].httpStatus, null)
  assert.equal(result.ownCalls[0].latencyMs, 10005)
  assert.equal(result.ownCalls[0].restrictedArchive.present, false)
  assert.equal(result.ownCalls[0].restrictedArchive.integrity, 'metadata_only_not_verified')
  assert.deepEqual(result.ownCalls[0].operationalArchive.transportFailure.codes, ['UND_ERR_CONNECT_TIMEOUT', '42P01'])
  assert.equal(result.ownCalls[0].operationalArchive.transportFailure.deadlineExceeded, false)
  assert.doesNotMatch(JSON.stringify(result), /private-|raw_payload|upstream_request_id/u)
  assert.equal(db.queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  for (const query of db.queries.filter(row => row.sql.includes('twitter-outcome:'))) {
    if (query.sql.includes('twitter-outcome:usage')) {
      assert.deepEqual(query.params.slice(0, 2), [requestId, null])
      assert.ok(query.params[2].includes('night_all_outcome_unknown'))
      assert.ok(query.params[3].includes('twitter'))
    } else assert.deepEqual(query.params, [requestId])
    assert.match(query.sql, /(?:usage_request_)?id = \$1::uuid/u)
    assert.doesNotMatch(query.sql, /body_bytes|body_text|parsed_payload|response_body|SELECT \*/u)
  }
})

test('historical missing archives stay unknown, lists are capped, and hostile fields do not leave report', async () => {
  const result = await diagnoseTwitterOutcome(fixture({ hostile: true, count: 21 }).pool, requestId)
  assert.equal(result.ownCalls.length, 20); assert.equal(result.gateways.length, 20)
  assert.equal(result.ownCallsTruncated, true); assert.equal(result.gatewaysTruncated, true)
  assert.equal(result.status, 'other')
  assert.equal(result.ownCalls[0].callId, null)
  assert.equal(result.ownCalls[0].billed, null)
  assert.equal(result.ownCalls[0].operationalArchive.transportFailure, null)
  assert.doesNotMatch(JSON.stringify(result), /private-/u)
  const malformed = projectTwitterTransportFailure({ phase: secret, codes: ['ECONNRESET', secret, 'ECONNRESET', ...Array(40).fill(secret)],
    deadlineExceeded: secret, elapsedMs: -1, timeoutMs: secret, message: secret })
  assert.deepEqual(malformed, { phase: 'other', codes: ['ECONNRESET'], unrecognizedCodes: true,
    codesTruncated: true, deadlineExceeded: null, elapsedMs: null, timeoutMs: null })
  assert.equal(projectTwitterTransportFailure(null), null)
  assert.equal(projectTwitterTransportFailure([]), null)
})

test('durable failure metadata is UUID scoped, safely projected, and never inferred when absent', async () => {
  for (const state of ['saved', 'absent', 'hostile']) {
    const base = fixture(), client = await base.pool.connect(), original = client.query
    client.query = async (sql, args) => {
      if (sql.includes('twitter-failure:table')) return { rows: [{ failures: true }] }
      if (sql.includes('twitter-failure:record')) {
        assert.deepEqual(args, [requestId])
        assert.match(sql, /WHERE request_id = \$1::uuid/u)
        assert.doesNotMatch(sql, /SELECT \*|response_body|raw_payload/u)
        if (state === 'absent') return { rows: [] }
        const row = { request_id: requestId, phase: 'commit_delivery', sql_state: '55P03',
          call_id: null, error_class: 'Error', recorded_at: new Date('2026-10-19T00:00:00Z'), message: secret }
        if (state === 'hostile') for (const key of Object.keys(row)) row[key] = secret
        return { rows: [row] }
      }
      return original(sql, args)
    }
    const report = await diagnoseTwitterOutcome({ connect: async () => client }, requestId)
    assert.equal(report.failureDiagnostic.tablePresent, true)
    assert.equal(report.failureDiagnostic.present, state !== 'absent')
    if (state === 'absent') assert.equal(report.failureDiagnostic.record, null)
    if (state === 'saved') assert.deepEqual(report.failureDiagnostic.record, {
      requestId, phase: 'commit_delivery', sqlState: '55P03', callId: null,
      errorClass: 'Error', recordedAt: '2026-10-19T00:00:00.000Z',
    })
    if (state === 'hostile') assert.deepEqual(report.failureDiagnostic.record, {
      requestId: null, phase: 'other', sqlState: null, callId: null, errorClass: 'other', recordedAt: null,
    })
    assert.doesNotMatch(JSON.stringify(report), /private-/u)
    assert.equal(base.queries.at(-1).sql, 'ROLLBACK')
  }
  await assert.rejects(diagnoseTwitterOutcome(fixture({ fail: 'twitter-failure:table' }).pool, requestId),
    { message: 'diagnostic_read_failed' })
})

test('wrong request scope and database failures stop safely and discard failed rollback connections', async () => {
  await assert.rejects(diagnoseTwitterOutcome({ connect() { assert.fail('must not connect') } }, secret), /invalid_request_id/u)
  for (const compareQuery of ['', 1, {}, 'a'.repeat(501), 'query\0suffix']) {
    await assert.rejects(diagnoseTwitterOutcome({ connect() { assert.fail('must not connect') } }, requestId, { compareQuery }), /invalid_arguments/u)
  }
  for (const [options, message] of [[{ missing: true }, 'request_not_found'], [{ platform: 'facebook' }, 'request_not_twitter_search'],
    [{ path: '/api/v1/data/social/crawl' }, 'request_not_twitter_search'], [{ fail: 'twitter-outcome:calls' }, 'diagnostic_read_failed'],
    [{ fail: 'ROLLBACK' }, 'diagnostic_read_failed']]) {
    const db = fixture(options)
    await assert.rejects(diagnoseTwitterOutcome(db.pool, requestId), { message })
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK'); assert.equal(db.released, true)
    assert.equal(Boolean(db.releaseError), options.fail === 'ROLLBACK')
  }
  for (const path of ['/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/social/search']) {
    assert.equal((await diagnoseTwitterOutcome(fixture({ path }).pool, requestId)).requestPath, path)
  }
  const pathless = await diagnoseTwitterOutcome(fixture({ path: null }).pool, requestId)
  assert.equal(pathless.requestPath, null)
  assert.equal(pathless.requestPathUnknown, true)
})

test('standalone stdin validates before loading pg or touching runtime and emits only fixed errors', () => {
  assert.doesNotMatch(source, /from ['"]\.\.?\/|\bfetch\s*\(/u)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[], 'invalid_arguments'], [[secret], 'invalid_request_id'], [[requestId], 'database_url_required'],
    [[requestId, secret], 'invalid_arguments'], [[requestId, '--compare-query'], 'invalid_arguments'],
    [[requestId, '--compare-query', ''], 'invalid_arguments'], [[requestId, '--compare-query', secret, 'extra'], 'invalid_arguments'],
    [[requestId, '--compare-query', '台湾'], 'database_url_required']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error })
  }
})

test('runtime fingerprint reads only fixed source files and emits hashes rather than content', () => {
  const runtime = twitterOutcomeRuntime()
  assert.equal(runtime.nodeVersion, process.version)
  assert.equal(runtime.scope, 'diagnostic_container_only_not_public_serving_version')
  assert.equal(runtime.installedSources.length, 4)
  for (const item of runtime.installedSources) {
    assert.equal(item.state, 'hashed')
    const bytes = readFileSync(new URL(`../../${item.file}`, import.meta.url))
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
})

test('legacy connector diagnostic caps evidence and never returns free text or fingerprints', async () => {
  const base = fixture(), client = await base.pool.connect(), original = client.query
  client.query = async (sql, args) => {
    if (sql.includes('twitter-connector:tables')) return { rows: [{ calls: true }] }
    if (sql.includes('twitter-connector:calls')) {
      assert.equal(args[0], requestId)
      assert.match(sql, /c\.usage_request_id=u\.id AND c\.consumer_id=u\.consumer_id/u)
      assert.match(sql, /WHERE u\.id = \$1::uuid/u)
      assert.doesNotMatch(sql, /response_body|failure_evidence|c\.request_fingerprint\s*,|SELECT \*/u)
      return { rows: Array.from({ length: 21 }, () => ({ id: secret, operation: secret, platform: secret,
        source_mode: secret, outcome: secret, http_status: secret, failure_kind: secret, error_code: secret,
        upstream_latency_ms: secret, started_at: secret, completed_at: secret,
        request_fingerprint_present: secret, fingerprint_matches_usage: secret, platform_matches_usage: secret,
        upstream_request_id_present: secret, upstream_trace_id_present: secret,
        request_fingerprint: secret, upstream_request_id: secret, upstream_trace_id: secret })) }
    }
    return original(sql, args)
  }
  const report = await diagnoseTwitterOutcome({ connect: async () => client }, requestId, { compareQuery: secret })
  assert.equal(report.legacyConnector.calls.length, 20)
  assert.equal(report.legacyConnector.callsTruncated, true)
  assert.equal(report.legacyConnector.calls[0].operation, 'other')
  assert.equal(report.legacyConnector.calls[0].errorCode, 'other')
  assert.equal(report.legacyConnector.calls[0].requestFingerprintPresent, null)
  assert.equal(report.legacyConnector.calls[0].fingerprintMatchesUsage, null)
  assert.equal(report.requestEvidence.comparisonProvided, true)
  assert.doesNotMatch(JSON.stringify(report), /private-|request_fingerprint|upstream_request_id|upstream_trace_id/u)
})

test('legacy SQL finds exact historical Night-All attempts without assuming timeout, billing or recoverable query', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA serving;
    CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY); CREATE TABLE api_keys(id uuid PRIMARY KEY);
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,consumer_id uuid,platform text,status text,error_code text,response_status int,
      reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb,fingerprint char(64),upstream_latency_ms int,
      UNIQUE(id,consumer_id));
    CREATE TABLE external_platform.response_snapshots(id uuid PRIMARY KEY);`)
  for (const name of ['provider_calls', 'response_archives', 'gateway_requests']) {
    await db.exec(migrationTable('051_external_platform_gateway.sql', `external_platform.${name}`))
  }
  await db.exec(migrationTable('058_external_platform_restricted_raw_responses.sql', 'control.external_platform_restricted_raw_responses'))
  await db.exec(migrationTable('031_night_all_compatibility_cache.sql', 'serving.connector_calls'))
  const consumer = randomUUID(), other = randomUUID(), callId = randomUUID(), otherCall = randomUUID(), digest = 'd'.repeat(64)
  await db.query('INSERT INTO consumers VALUES($1)', [consumer])
  for (const id of [requestId, other]) await db.query(`INSERT INTO usage_requests VALUES($1,$2,'twitter','unknown','night_all_outcome_unknown',502,
    '2026-09-15T09:31:27Z','2026-09-15T09:31:57.014Z',NULL,$3,NULL)`, [id, consumer, digest])
  for (const [call, usage] of [[callId, requestId], [otherCall, other]]) await db.query(`INSERT INTO serving.connector_calls
    (id,consumer_id,usage_request_id,operation,request_fingerprint,platform,outcome,failure_kind,error_code,
      upstream_latency_ms,started_at,completed_at,upstream_request_id,upstream_trace_id)
    VALUES($1,$2,$3,'data-search',$4,'twitter','unknown','timeout','night_all_outcome_unknown',30012,
      '2026-09-15T09:31:27.002Z','2026-09-15T09:31:57.014Z',$5,$5)`, [call, consumer, usage, digest, secret])
  await db.exec("ALTER TABLE usage_requests ADD COLUMN billing_meter_key text DEFAULT 'twitter', ADD COLUMN capability text")
  let readOnly = false, rolledBack = false
  const pool = { connect: async () => ({ release() {}, query: async (sql, args) => {
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|COMMIT|TRUNCATE)\b|SELECT \*|response_body|failure_evidence/u)
    if (sql.includes('twitter-connector:calls')) {
      readOnly = (await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value === 'on'
    }
    if (sql === 'ROLLBACK') rolledBack = true
    const result = await db.query(sql, args)
    assert.doesNotMatch(JSON.stringify(result.rows), /private-query-token-proxy-url-body|dddddddddddddddd|台湾/u,
      'saved query, request fingerprint and upstream identifiers must never leave SQL')
    return result
  } }) }
  const read = options => diagnoseTwitterOutcome(pool, requestId, options)
  const report = await read({ compareQuery: '台湾' })
  assert.equal(readOnly, true); assert.equal(rolledBack, true)
  assert.equal(report.errorCode, 'night_all_outcome_unknown')
  assert.equal(report.billingMeterKey, 'twitter'); assert.equal(report.capability, null)
  assert.equal(report.elapsedMs, 30014); assert.equal(report.upstreamLatencyMs, null)
  assert.equal(report.requestPathUnknown, true)
  assert.equal(report.requestEvidence.requestFingerprintPresent, true)
  assert.equal(report.requestEvidence.acquisitionRequestPresent, false)
  assert.equal(report.requestEvidence.bodyPresent, false)
  assert.equal(report.requestEvidence.queryPresent, false)
  assert.equal(report.requestEvidence.queryEqualsComparison, null)
  assert.deepEqual(report.ownCalls, []); assert.deepEqual(report.gateways, [])
  assert.equal(report.legacyConnector.calls.length, 1)
  const call = report.legacyConnector.calls[0]
  assert.equal(call.callId, callId); assert.equal(call.operation, 'data-search'); assert.equal(call.outcome, 'unknown')
  assert.equal(call.errorCode, 'night_all_outcome_unknown'); assert.equal(call.failureKind, 'timeout')
  assert.equal(call.upstreamLatencyMs, 30012); assert.equal(call.elapsedMs, 30012)
  assert.equal(call.requestFingerprintPresent, true); assert.equal(call.upstreamRequestIdPresent, true)
  assert.equal(call.fingerprintMatchesUsage, true); assert.equal(call.platformMatchesUsage, true)
  assert.equal(call.upstreamTraceIdPresent, true); assert.equal(call.httpStatus, null)
  assert.doesNotMatch(JSON.stringify(report), /private-|dddddddddddddddd|台湾/u)
  for (const [saved, present, string, equals] of [[{}, false, false, null], [{ body: null }, false, false, null],
    [{ body: { query: null } }, false, false, null], [{ body: { query: 12 } }, true, false, null],
    [{ body: { query: '台湾' } }, true, true, true], [{ body: { query: ' 台湾' } }, true, true, false],
    [{ body: { query: secret } }, true, true, false]]) {
    await db.query('UPDATE usage_requests SET acquisition_request=$2 WHERE id=$1', [requestId, JSON.stringify(saved)])
    const result = await read({ compareQuery: '台湾' })
    assert.equal(result.requestEvidence.acquisitionRequestPresent, true)
    assert.equal(result.requestEvidence.queryPresent, present)
    assert.equal(result.requestEvidence.queryIsString, string)
    assert.equal(result.requestEvidence.queryEqualsComparison, equals)
  }
  assert.equal((await read()).requestEvidence.queryEqualsComparison, null)
  for (const [meter, capability] of [['raw', null], ['crawl', 'social.content.crawl'], ['user-info', 'social.profile.get'], [secret, secret]]) {
    await db.query('UPDATE usage_requests SET billing_meter_key=$2,capability=$3 WHERE id=$1', [requestId, meter, capability])
    const result = await read()
    assert.equal(result.billingMeterKey, meter === secret ? 'other' : meter)
    assert.equal(result.capability, capability === secret ? 'other' : capability)
  }
  await db.query('UPDATE serving.connector_calls SET request_fingerprint=$2,platform=$3 WHERE id=$1', [callId, 'e'.repeat(64), 'facebook'])
  const mismatch = await read()
  assert.equal(mismatch.legacyConnector.calls[0].fingerprintMatchesUsage, false)
  assert.equal(mismatch.legacyConnector.calls[0].platformMatchesUsage, false)
  await db.query('UPDATE serving.connector_calls SET platform=NULL WHERE id=$1', [callId])
  await db.query('UPDATE usage_requests SET fingerprint=NULL WHERE id=$1', [requestId])
  const absent = await read()
  assert.equal(absent.legacyConnector.calls[0].fingerprintMatchesUsage, null)
  assert.equal(absent.legacyConnector.calls[0].platformMatchesUsage, null)
  for (const code of ['night_all_http_429', 'night_all_invalid_upstream_json', 'compatibility_commit_ambiguous', 'usage_commit_ambiguous', secret]) {
    await db.query('UPDATE usage_requests SET error_code=$2 WHERE id=$1', [requestId, code])
    await db.query('UPDATE serving.connector_calls SET error_code=$2,failure_kind=NULL WHERE id=$1', [callId, code])
    const result = await read()
    assert.equal(result.errorCode, code === secret ? 'other' : code)
    assert.equal(result.legacyConnector.calls[0].errorCode, code === secret ? 'other' : code)
    assert.equal(result.legacyConnector.calls[0].failureKind, null, 'elapsed time alone must not be labelled timeout')
    assert.doesNotMatch(JSON.stringify(result), /private-/u)
  }
  assert.equal((await db.query('SELECT status FROM usage_requests WHERE id=$1', [requestId])).rows[0].status, 'unknown')
  assert.equal((await db.query('SELECT count(*)::int n FROM serving.connector_calls')).rows[0].n, 2)
  assert.equal((await read()).failureDiagnostic.tablePresent, false)
  await db.exec(readFileSync(new URL('../../migrations/161_usage_request_failures.sql', import.meta.url), 'utf8'))
  assert.equal((await read()).failureDiagnostic.present, false)
  await db.query(`INSERT INTO public.usage_request_failures(request_id,phase,sql_state,call_id,error_class)
    VALUES($1,'finish_step','40P01',$2,'Error'),($3,'commit_delivery',NULL,NULL,'TypeError')`, [requestId, callId, other])
  const savedFailure = (await read()).failureDiagnostic
  assert.equal(savedFailure.tablePresent, true); assert.equal(savedFailure.present, true)
  assert.equal(savedFailure.record.requestId, requestId)
  assert.equal(savedFailure.record.phase, 'finish_step'); assert.equal(savedFailure.record.sqlState, '40P01')
  assert.equal(savedFailure.record.callId, callId); assert.equal(savedFailure.record.errorClass, 'Error')
  assert.ok(savedFailure.record.recordedAt)
  assert.equal((await db.query('SELECT count(*)::int n FROM public.usage_request_failures')).rows[0].n, 2)
  assert.equal((await db.query('SELECT status FROM usage_requests WHERE id=$1', [requestId])).rows[0].status, 'unknown')
})

test('protocol diagnostic caps and projects hostile metadata without outputting scope or saved payloads', async () => {
  const base = fixture(), client = await base.pool.connect(), original = client.query
  client.query = async (sql, args) => {
    if (sql.includes('twitter-protocol:tables')) return { rows: [{ bindings: true, leases: true }] }
    if (sql.includes('twitter-protocol:bindings')) return { rows: Array.from({ length: 21 }, () => ({
      state: secret, usage_request_id: secret, created_at: secret, updated_at: secret,
      lease_expires_at: secret, lease_expired: secret, result_present: secret,
      error_code: secret, request_body: secret, result: secret, error: secret,
      query_hash: secret, idempotency_key: secret, owner_id: secret,
    })) }
    if (sql.includes('twitter-protocol:leases')) return { rows: Array.from({ length: 21 }, () => ({
      version: secret, expires_at: secret, expired: secret, idempotency_key: secret, query_hash: secret,
    })) }
    return original(sql, args)
  }
  const report = await diagnoseTwitterOutcome({ connect: async () => client }, requestId)
  assert.equal(report.searchProtocol.bindings.length, 20)
  assert.equal(report.searchProtocol.leases.length, 20)
  assert.equal(report.searchProtocol.bindingsTruncated, true)
  assert.equal(report.searchProtocol.leasesTruncated, true)
  assert.equal(report.searchProtocol.bindings[0].errorCode, 'other')
  assert.equal(report.searchProtocol.bindings[0].usageRequestId, null)
  assert.doesNotMatch(JSON.stringify(report), /private-|query_hash|idempotency_key|owner_id|request_body/u)
})

test('actual protocol SQL preserves old deployments, matches exact caller identity before finish, and separates acquisition from delivery', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY); CREATE TABLE api_keys(id uuid PRIMARY KEY);
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY, tenant_id uuid, consumer_id uuid, api_key_id uuid,
      idempotency_key text, platform text,status text,error_code text,response_status int,
      reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb);
    CREATE TABLE external_platform.response_snapshots(id uuid PRIMARY KEY);`)
  for (const name of ['provider_calls', 'response_archives', 'gateway_requests']) {
    await db.exec(migrationTable('051_external_platform_gateway.sql', `external_platform.${name}`))
  }
  await db.exec(migrationTable('058_external_platform_restricted_raw_responses.sql', 'control.external_platform_restricted_raw_responses'))
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), otherTenant = randomUUID(), otherConsumer = randomUUID(), otherKey = randomUUID()
  for (const [name, ids] of [['tenants', [tenant, otherTenant]], ['consumers', [consumer, otherConsumer]], ['api_keys', [key, otherKey]]]) {
    for (const id of ids) await db.query(`INSERT INTO ${name} VALUES($1)`, [id])
  }
  await db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,$4,$5,'twitter','committed',NULL,200,
    now(),now(),$6)`, [requestId, tenant, consumer, key, secret, JSON.stringify({ path: '/api/v1/data/search', body: { query: secret } })])
  await db.exec('ALTER TABLE usage_requests ADD COLUMN fingerprint char(64), ADD COLUMN upstream_latency_ms int, ADD COLUMN billing_meter_key text, ADD COLUMN capability text')
  let reads = 0
  const pool = { connect: async () => ({ release() {}, query: async (sql, args) => {
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|COMMIT|FOR UPDATE)\b/u)
    if (sql.includes('twitter-protocol:')) {
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value, 'on')
      assert.doesNotMatch(sql, /SELECT \*|b\.request_body|b\.result\s*,|b\.error\s*,/u)
      reads++
    }
    return db.query(sql, args)
  } }) }
  const read = () => diagnoseTwitterOutcome(pool, requestId)
  const old = await read()
  assert.deepEqual(old.searchProtocol.tables, { bindings: false, leases: false })
  await db.exec(readFileSync(new URL('../../migrations/158_data_search_v2_protocol.sql', import.meta.url), 'utf8'))
  const unrelated = await read()
  assert.deepEqual(unrelated.searchProtocol.tables, { bindings: true, leases: true })
  assert.deepEqual(unrelated.searchProtocol.bindings, [])
  const insert = async ({ tenantId = tenant, consumerId = consumer, keyId = key, platform = 'twitter', usageId = requestId, savedKey = secret } = {}) => {
    const owner = randomUUID()
    await db.query(`INSERT INTO control.data_search_protocol_bindings
      (consumer_id,idempotency_key,tenant_id,api_key_id,platform,query_hash,fingerprint,request_body,state,owner_id,lease_expires_at,error,usage_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,now()-interval '1 hour',$10,$11)`,
    [consumerId, savedKey, tenantId, keyId, platform, 'b'.repeat(64), 'c'.repeat(64), JSON.stringify({ query: secret }), owner,
      JSON.stringify({ code: 'search_v2_projection_unavailable', message: secret, details: { token: secret } }), usageId])
    await db.query(`INSERT INTO control.data_search_protocol_leases VALUES($1,$2,$3,$4,$5,$6,$7,2,now()-interval '1 hour')`,
      [owner, tenantId, consumerId, keyId, platform, 'b'.repeat(64), savedKey])
  }
  const clear = async () => db.exec('DELETE FROM control.data_search_protocol_leases; DELETE FROM control.data_search_protocol_bindings;')
  for (const patch of [{ tenantId: otherTenant }, { consumerId: otherConsumer }, { keyId: otherKey }, { platform: 'facebook' }]) {
    await insert(patch)
    const isolated = await read()
    assert.deepEqual(isolated.searchProtocol.bindings, [], JSON.stringify(patch))
    assert.deepEqual(isolated.searchProtocol.leases, [], JSON.stringify(patch))
    await clear()
  }
  await insert({ usageId: null })
  const pending = await read()
  assert.equal(pending.status, 'committed')
  assert.equal(pending.savedHttpStatus, 200)
  assert.equal(pending.searchProtocol.bindings[0].usageRequestId, null)
  assert.equal(pending.searchProtocol.bindings[0].state, 'running')
  assert.equal(pending.searchProtocol.bindings[0].effectiveState, 'unknown')
  assert.equal(pending.searchProtocol.bindings[0].leaseExpired, true)
  assert.equal(pending.searchProtocol.bindings[0].resultPresent, false)
  assert.equal(pending.searchProtocol.leases[0].expired, true)
  await db.query(`UPDATE control.data_search_protocol_bindings SET state='unknown',usage_request_id=$1`, [requestId])
  const unknown = await read()
  assert.equal(unknown.status, 'committed')
  assert.equal(unknown.searchProtocol.bindings[0].state, 'unknown')
  assert.equal(unknown.searchProtocol.bindings[0].errorCode, 'search_v2_projection_unavailable')
  assert.doesNotMatch(JSON.stringify(unknown), /private-|query_hash|idempotency_key|owner_id|request_body/u)
  assert.equal((await db.query('SELECT state FROM control.data_search_protocol_bindings')).rows[0].state, 'unknown')
  assert.equal((await db.query('SELECT count(*)::int n FROM control.data_search_protocol_leases')).rows[0].n, 1)
  await clear()
  // Direct usage lineage is independently sufficient, but still requires all
  // caller identities. Its owned lease follows the same foreign-key evidence.
  await insert({ savedKey: 'other-saved-key-same-usage' })
  const direct = await read()
  assert.equal(direct.searchProtocol.bindings[0].usageRequestId, requestId)
  assert.equal(direct.searchProtocol.leases.length, 1)
  await db.query(`UPDATE control.data_search_protocol_bindings SET state='complete',result=$1,error=NULL`, [JSON.stringify({ body: secret })])
  await db.exec('DROP TABLE control.data_search_protocol_leases')
  const partialSchema = await read()
  assert.deepEqual(partialSchema.searchProtocol.tables, { bindings: true, leases: false })
  assert.equal(partialSchema.searchProtocol.bindings[0].resultPresent, true)
  assert.equal(partialSchema.searchProtocol.bindings[0].state, 'complete')
  assert.equal(partialSchema.searchProtocol.bindings[0].effectiveState, 'complete', 'lease age does not change a completed binding')
  assert.deepEqual(partialSchema.searchProtocol.leases, [])
  assert.doesNotMatch(JSON.stringify(partialSchema), /private-/u)
  assert.ok(reads > 20)
})

test('diagnostic actual SQL reads real archive schemas in a read-only transaction and cannot mix another request', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY); CREATE TABLE api_keys(id uuid PRIMARY KEY);
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY,platform text,status text,error_code text,response_status int,
      reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb);
    CREATE TABLE external_platform.response_snapshots(id uuid PRIMARY KEY);`)
  for (const name of ['provider_calls', 'response_archives', 'gateway_requests']) {
    await db.exec(migrationTable('051_external_platform_gateway.sql', `external_platform.${name}`))
  }
  await db.exec(migrationTable('058_external_platform_restricted_raw_responses.sql', 'control.external_platform_restricted_raw_responses'))
  const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID(), other = randomUUID(), call = randomUUID(), unrelated = randomUUID()
  for (const [name, id] of [['tenants', tenant], ['consumers', consumer], ['api_keys', key]]) await db.query(`INSERT INTO ${name} VALUES($1)`, [id])
  for (const id of [requestId, other]) await db.query(`INSERT INTO usage_requests VALUES($1,'twitter','unknown','social_upstream_outcome_unknown',502,
    '2026-10-15T09:31:27Z','2026-10-15T09:31:38Z',$2)`, [id, JSON.stringify({ path: '/api/v1/data/search', body: secret })])
  await db.exec('ALTER TABLE usage_requests ADD COLUMN fingerprint char(64), ADD COLUMN upstream_latency_ms int, ADD COLUMN billing_meter_key text, ADD COLUMN capability text')
  for (const [id, usage] of [[call, requestId], [unrelated, other]]) await db.query(`INSERT INTO external_platform.provider_calls
    (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
      marketplace,request_fingerprint,outcome,error_code,latency_ms,started_at,completed_at)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'social.content.search','mx-insight-hub.social-data.v1','twitter-aio.search','twitter-aio.hub.v1',
      'twitter',$6,'unknown','social_upstream_response_unusable',10005,'2026-10-15T09:31:28Z','2026-10-15T09:31:38Z')`,
  [id, tenant, consumer, key, usage, 'a'.repeat(64)])
  await db.query(`INSERT INTO external_platform.response_archives(id,provider_call_id,contract_state,raw_payload,captured_at)
    VALUES($1,$2,'unknown',$3,now())`, [randomUUID(), call, JSON.stringify({ body: secret, response: { transportFailure: transport, token: secret } })])
  const bytes = Buffer.from(secret), sha = createHash('sha256').update(bytes).digest('hex')
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses
    (id,provider_call_id,body_size,body_sha256,body_bytes,json_parsed,captured_at) VALUES($1,$2,$3,$4,$5,false,now())`,
  [randomUUID(), unrelated, bytes.length, sha, bytes])
  await db.query(`INSERT INTO external_platform.gateway_requests
    (id,provider_key,tenant_id,consumer_id,usage_request_id,request_fingerprint,source_mode,succeeded,response_status,provider_call_id,error_code)
    VALUES($1,'rapidapi',$2,$3,$4,$5,'unavailable',false,502,$6,'social_upstream_outcome_unknown')`,
  [randomUUID(), tenant, consumer, requestId, 'a'.repeat(64), call])
  let readOnlyVerified = false, rolledBack = false
  const pool = { connect: async () => ({ release() {}, query: async (sql, args) => {
    assert.match(sql, /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/u)
    if (sql.includes('twitter-outcome:usage')) {
      assert.equal((await db.query("SELECT current_setting('transaction_read_only') AS value")).rows[0].value, 'on')
      readOnlyVerified = true
    }
    if (sql === 'ROLLBACK') rolledBack = true
    return db.query(sql, args)
  } }) }
  const report = await diagnoseTwitterOutcome(pool, requestId)
  assert.equal(readOnlyVerified, true); assert.equal(rolledBack, true)
  assert.equal(report.ownCalls.length, 1); assert.equal(report.ownCalls[0].callId, call)
  assert.equal(report.gateways[0].providerCallId, call)
  assert.equal(report.ownCalls[0].restrictedArchive.present, false)
  assert.equal(report.ownCalls[0].billed, null)
  assert.equal(report.ownCalls[0].operationalArchive.present, true)
  assert.deepEqual(report.ownCalls[0].operationalArchive.transportFailure.codes, transport.codes)
  assert.doesNotMatch(JSON.stringify(report), /private-/u)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM usage_requests')).rows[0].n, 2)
  // A retained HTTP response is metadata only: no bytes are fetched or claimed verified.
  const otherReport = await diagnoseTwitterOutcome(pool, other)
  assert.equal(otherReport.ownCalls[0].restrictedArchive.sha256, sha)
  assert.equal(otherReport.ownCalls[0].restrictedArchive.bodySize, bytes.length)
  assert.equal(otherReport.ownCalls[0].restrictedArchive.integrity, 'metadata_only_not_verified')
  assert.equal(otherReport.ownCalls[0].operationalArchive.transportFailure, null)
  await db.query(`UPDATE external_platform.response_archives SET raw_payload=$1 WHERE provider_call_id=$2`,
    [JSON.stringify({ response: { transportFailure: { ...transport, message: secret.repeat(200) } } }), call])
  const oversized = await diagnoseTwitterOutcome(pool, requestId)
  assert.equal(oversized.ownCalls[0].operationalArchive.transportFailure, null)
  assert.equal(oversized.ownCalls[0].operationalArchive.transportFailureTooLarge, true)
})
