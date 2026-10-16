import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { CASES, countEntityRows, summarizeRelevanceRequest, inspectRelevanceArchive, inspectRelevanceDelivery,
  diagnoseXiaohongshuRelevance } from '../../server/ops/diagnose-xiaohongshu-relevance.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'

const incident = CASES[0]
const hubId = '10000000-0000-4000-8000-000000000001'
const callId = '10000000-0000-4000-8000-000000000002'
const secret = 'private-credential-url-cursor-business-body'
const call = { id: callId, usage_request_id: hubId, provider_key: 'tikhub', operation: 'social.posts.search',
  endpoint_key: 'xiaohongshu.app-v2.search-notes.v1', contract_version: 'night-all.data-search.v1',
  outcome: 'succeeded', http_status: 200, business_code: 200, upstream_request_id: incident.id, billed: true, item_count: 2 }
const snapshot = { method: 'POST', path: '/api/v1/night-all/search/raw', body: {
  platform: 'xiaohongshu', query: incident.query, count: 20, authorization: secret } }
const providerPayload = { code: 200, request_id: incident.id, params: { keyword: incident.query,
  sort_type: 'time_descending', ai_mode: '0', credential: secret }, data: { page: 1, data: { items: [
  { model_type: 'note', note: { title: '杨幂声明', desc: `${secret} 杨小幂`, id: '675d277d000000000600e655' } },
  { model_type: 'note', note: { title: '论文辅导', desc: secret, id: '675d277d000000000600e658' } },
] } } }
const archive = payload => {
  const bytes = payload instanceof Uint8Array ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload))
  return { body_bytes: bytes, body_size: bytes.length, body_sha256: createHash('sha256').update(bytes).digest('hex') }
}

test('each reported query reaches the real TikHub adapter unchanged in one offline request', async () => {
  for (const { query } of CASES) {
    let calls = 0
    const adapter = new TikHubAdapter({ apiKey: 'offline-test-only', fetchImpl: async url => {
      calls++
      const parsed = new URL(url)
      assert.equal(parsed.pathname, '/api/v1/xiaohongshu/app_v2/search_notes')
      assert.equal(parsed.searchParams.get('keyword'), query)
      assert.equal(parsed.searchParams.get('sort_type'), 'time_descending')
      assert.equal(parsed.searchParams.get('ai_mode'), '0')
      assert.equal(parsed.searchParams.has('query'), false)
      return new Response(JSON.stringify({ code: 200, data: { page: 1, next_page: null, data: { items: [] } } }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    const result = await adapter.searchXiaohongshuNotes({ platform: 'xiaohongshu', query, pageSize: 20 })
    assert.equal(result.publicBody.data.query, query)
    assert.equal(calls, 1)
  }
})

test('snapshot comparison distinguishes exact, whitespace-only, conflicting aliases and unavailable evidence', () => {
  const exact = summarizeRelevanceRequest(snapshot, incident.query)
  assert.equal(exact.query.matchesExpected, true)
  assert.equal(exact.query.sha256, createHash('sha256').update(incident.query).digest('hex'))
  assert.equal(exact.count, 20)
  assert.equal(exact.path, snapshot.path)
  const padded = summarizeRelevanceRequest({ ...snapshot, body: { query: ` ${incident.query} `, keyword: secret } }, incident.query)
  assert.equal(padded.query.matchesExpected, false)
  assert.equal(padded.query.trimmedMatchesExpected, true)
  assert.equal(padded.keyword.matchesExpected, false)
  const other = summarizeRelevanceRequest({ method: secret, path: `/${secret}`, bodyOmitted: 'oversize' }, incident.query)
  assert.equal(other.path, 'other'); assert.equal(other.method, 'other'); assert.equal(other.available, false)
  assert.equal(other.bodyOmitted, true); assert.equal(other.query.matchesExpected, null)
  assert.doesNotMatch(JSON.stringify([exact, padded, other]), /private-|AI合成/)
})

test('fixed title/body counts preserve missing fields and distinguish text absence from relevance', () => {
  const result = countEntityRows([
    { title: '杨幂', text: '杨小幂', full_text: '杨小幂' },
    { title: '无关', text: secret }, { title: '杨', text: '幂' }, {}, null,
  ])
  assert.equal(result.totalRows, 5); assert.equal(result.recognizedRows, 4); assert.equal(result.unsupportedRows, 1)
  assert.deepEqual(result.terms['杨幂'], { titleRows: 1, bodyRows: 0, eitherRows: 1 })
  assert.deepEqual(result.terms['杨小幂'], { titleRows: 0, bodyRows: 1, eitherRows: 1 })
  assert.equal(result.anyEntityRows, 1); assert.equal(result.noEntityInInspectedTextRows, 3)
  assert.equal(result.missingBodyRows, 1)
  const bounded = countEntityRows(Array.from({ length: 101 }, () => ({ text: `${'x'.repeat(100_000)}杨幂` })))
  assert.equal(bounded.rowsTruncated, true); assert.equal(bounded.textTruncated, true)
  assert.equal(bounded.inspectedRows, 100); assert.equal(bounded.anyEntityRows, 0)
  assert.doesNotMatch(JSON.stringify(result), /private-/)
})

test('raw and modern delivery summaries inspect only fixed direct containers and do not recurse', () => {
  for (const raw_data of [JSON.stringify([{ title: '杨幂', content: secret }]), [{ title: '杨幂', content: secret }]]) {
    const raw = inspectRelevanceDelivery({ data: { raw_data, nested: { items: [secret] } } }, incident.query)
    assert.equal(raw.format, 'raw'); assert.equal(raw.anyEntityRows, 1)
  }
  const modern = inspectRelevanceDelivery({ data: { query: incident.query, items: [{ text: '杨小幂' }] } }, incident.query)
  assert.equal(modern.format, 'data'); assert.equal(modern.query.matchesExpected, true)
  assert.equal(inspectRelevanceDelivery({ data: { raw_data: '{' } }).state, 'invalid_raw_json')
  assert.equal(inspectRelevanceDelivery({ data: { results: [{ data: { raw_data: '[]' } }] } }).state, 'unsupported_delivery_shape')
  assert.doesNotMatch(JSON.stringify(modern), /AI合成|private-/)
})

test('original archive is counted only after byte length, SHA, UTF-8 and correlation verification', () => {
  const saved = archive(providerPayload), before = Buffer.from(saved.body_bytes)
  const report = inspectRelevanceArchive(saved, incident.query, call)
  assert.equal(report.state, 'archive_verified'); assert.equal(report.hashVerified, true)
  assert.equal(report.matchesSavedUpstreamId, true)
  assert.equal(report.echoedParams.root.keyword.matchesExpected, true)
  assert.equal(report.echoedParams.root.sortType, 'time_descending')
  assert.equal(report.rows.totalRows, 2); assert.equal(report.rows.anyEntityRows, 1)
  assert.deepEqual(saved.body_bytes, before)
  assert.doesNotMatch(JSON.stringify(report), /private-|AI合成|论文辅导/)
  for (const mutated of [{ ...saved, body_sha256: '0'.repeat(64) }, { ...saved, body_size: saved.body_size + 1 },
    { ...saved, body_bytes: null }]) assert.equal(inspectRelevanceArchive(mutated, incident.query, call).state, 'archive_integrity_failed')
  assert.equal(inspectRelevanceArchive(null, incident.query, call).state, 'archive_missing')
  assert.equal(inspectRelevanceArchive({ body_size: 8388609 }, incident.query, call).state, 'archive_too_large')
  assert.equal(inspectRelevanceArchive(archive(Buffer.from([0xff])), incident.query, call).state, 'archive_not_json')
  const mismatch = inspectRelevanceArchive(saved, incident.query, { ...call, upstream_request_id: hubId })
  assert.equal(mismatch.state, 'archive_correlation_mismatch'); assert.equal(mismatch.rows, undefined)
})

test('unreviewed endpoint and unrecognized nested rows never become provider search evidence', () => {
  const saved = archive(providerPayload)
  for (const field of ['provider_key', 'operation', 'endpoint_key', 'contract_version']) {
    assert.equal(inspectRelevanceArchive(saved, incident.query, { ...call, [field]: secret }).state, 'unreviewed_endpoint')
  }
  const wrongShape = inspectRelevanceArchive(archive({ code: 200, data: { items: providerPayload.data.data.items } }), incident.query, call)
  assert.equal(wrongShape.rows.state, 'unsupported_rows')
  const unsupported = inspectRelevanceArchive(archive({ data: { data: { items: [{ model_type: 'user', note: { title: '杨幂' } }] } } }), incident.query, call)
  assert.equal(unsupported.rows.unsupportedRows, 1); assert.equal(unsupported.rows.anyEntityRows, 0)
})

function fixture({ direct = false, missing = false, wrongPlatform = false, fail = false, extraMatches = false } = {}) {
  const statements = []
  let released = false
  const client = { async query(sql, values) {
    statements.push({ sql, values })
    if (sql.startsWith('SELECT id FROM public.usage_requests')) return { rows: direct ? [{ id: incident.id }] : [] }
    if (sql.includes('SELECT DISTINCT')) return { rows: missing ? [] : Array.from({ length: extraMatches ? 4 : 1 }, () => ({ id: hubId })) }
    if (sql.includes('FROM public.usage_requests WHERE')) {
      if (fail) throw new Error(secret)
      return { rows: [{ id: values[0], platform: wrongPlatform ? 'twitter' : 'xiaohongshu', status: 'committed', response_status: 200,
        acquisition_request: snapshot, delivery_bytes: 256, response_body: { data: { raw_data: '[{"title":"杨幂"}]' } } }] }
    }
    if (sql.includes('FROM external_platform.provider_calls c WHERE')) return { rows: [call] }
    if (sql.includes('FROM external_platform.gateway_requests g JOIN')) return { rows: [{ source_mode: 'live', provider_call_id: callId }] }
    if (sql.includes('FROM control.external_platform_restricted_raw_responses')) return { rows: [archive(providerPayload)] }
    return { rows: [] }
  }, release() { released = true } }
  return { pool: { async connect() { return client } }, statements, get released() { return released } }
}

test('exact UUID lookup falls back to bounded upstream lookup; transaction always rolls back', async () => {
  for (const direct of [true, false]) {
    const db = fixture({ direct }), report = await diagnoseXiaohongshuRelevance(db.pool, incident.id)
    assert.equal(report.matchedBy, direct ? 'hub_request_id' : 'provider_upstream_request_id')
    assert.equal(report.requests.length, 1)
    assert.equal(report.requests[0].request.query.matchesExpected, true)
    assert.equal(report.requests[0].evidence[0].archive.rows.totalRows, 2)
    assert.equal(db.statements.some(({ sql }) => sql.includes('SELECT DISTINCT')), !direct)
    assert.equal(db.statements[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK'); assert.equal(db.released, true)
    assert.ok(db.statements.every(({ sql }) => /^(SELECT|SET LOCAL|BEGIN|ROLLBACK)\b/.test(sql)))
    assert.ok(db.statements.filter(({ sql }) => sql.startsWith('SELECT')).every(({ values }) => values.length === 1 && UUID(values[0])))
    assert.doesNotMatch(JSON.stringify(report), /private-|AI合成|论文辅导/)
  }
  function UUID(value) { return /^[a-f0-9-]{36}$/i.test(value) }
})

test('missing, wrong-platform, truncated and failed evidence cannot imply a provider success', async () => {
  const absent = await diagnoseXiaohongshuRelevance(fixture({ missing: true }).pool, incident.id)
  assert.equal(absent.requests.length, 0); assert.equal(absent.matchedBy, null)
  const wrong = fixture({ wrongPlatform: true })
  assert.equal((await diagnoseXiaohongshuRelevance(wrong.pool, incident.id)).requests[0].state, 'not_xiaohongshu')
  assert.equal(wrong.statements.some(({ sql }) => sql.includes('restricted_raw_responses')), false)
  const bounded = await diagnoseXiaohongshuRelevance(fixture({ extraMatches: true }).pool, incident.id)
  assert.equal(bounded.lookupTruncated, true); assert.equal(bounded.requests.length, 3)
  const failure = fixture({ fail: true })
  await assert.rejects(diagnoseXiaohongshuRelevance(failure.pool, incident.id), { message: 'diagnostic_read_failed' })
  assert.equal(failure.statements.at(-1).sql, 'ROLLBACK'); assert.equal(failure.released, true)
  await assert.rejects(diagnoseXiaohongshuRelevance({ connect() { assert.fail('must not connect') } }, hubId),
    { message: 'unsupported_incident_id' })
})

test('stdin command defaults to fixed incidents, has no runtime imports and sanitizes errors', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-xiaohongshu-relevance.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\//); assert.doesNotMatch(source, /\bfetch\s*\(/)
  const env = { ...process.env }; delete env.DATABASE_URL
  for (const [args, error] of [[[], 'database_url_required'], [[secret], 'unsupported_incident_id'], [[incident.id, incident.id], 'unsupported_incident_id']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { input: source, env, encoding: 'utf8' })
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error }); assert.doesNotMatch(result.stderr, /private-|Error:|at /)
  }
  const offline = source.replace("const { default: pg } = await import('pg')", `const pg = { Pool: class {
    async connect() { return { release() {}, async query(sql) {
      if (!/^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\\b/.test(sql)) throw new Error('write_forbidden')
      return { rows: [] }
    } } }
    async end() {}
  } }`)
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: offline, env: { ...env, DATABASE_URL: 'offline-placeholder-only' }, encoding: 'utf8',
  })
  assert.equal(result.status, 0); assert.equal(result.stderr, '')
  const reports = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(reports.map(report => report.lookupId), CASES.map(entry => entry.id))
  assert.ok(reports.every(report => report.requests.length === 0 && report.matchedBy === null))
})

test('actual PostgreSQL queries retain linked cache provenance and execute read-only', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY,platform text,status text,response_status int,error_code text,
      reserved_at timestamptz,completed_at timestamptz,acquisition_request jsonb,response_body jsonb,consumer_id uuid,response_captured_at timestamptz);
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,provider_key text,operation text,
      endpoint_key text,contract_version text,outcome text,http_status int,business_code int,upstream_request_id text,billed boolean,
      item_count int,started_at timestamptz,completed_at timestamptz);
    CREATE TABLE external_platform.gateway_requests(id uuid,usage_request_id uuid,source_mode text,provider_call_id uuid,created_at timestamptz,
      snapshot_id uuid,consumer_id uuid,provider_key text);
    CREATE TABLE external_platform.response_snapshots(id uuid,provider_key text,consumer_id uuid,operation text,captured_at timestamptz,
      updated_at timestamptz,last_success_call_id uuid);
    CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid,body_size int,body_sha256 text,body_bytes bytea);`)
  const saved = archive(providerPayload)
  await db.query(`INSERT INTO public.usage_requests VALUES ($1,'xiaohongshu','committed',200,NULL,now(),now(),$2,$3,NULL,NULL)`,
    [hubId, snapshot, { data: { raw_data: '[{"title":"杨幂"}]' } }])
  await db.query(`INSERT INTO external_platform.provider_calls VALUES ($1,$2,'tikhub','social.posts.search',
    'xiaohongshu.app-v2.search-notes.v1','night-all.data-search.v1','succeeded',200,200,$3,true,2,now(),now())`,
  [callId, hubId, incident.id])
  await db.query('INSERT INTO control.external_platform_restricted_raw_responses VALUES ($1,$2,$3,$4)',
    [callId, saved.body_size, saved.body_sha256, saved.body_bytes])
  await db.query(`INSERT INTO public.usage_requests VALUES ($1,'xiaohongshu','committed',200,NULL,now(),now(),$2,$3,NULL,NULL)`,
    [CASES[1].id, { ...snapshot, body: { ...snapshot.body, query: CASES[1].query } }, { data: { raw_data: '[{"text":"杨小幂"}]' } }])
  await db.query(`INSERT INTO external_platform.gateway_requests VALUES ($1,$2,'fresh_cache',$3,now(),NULL,NULL,'tikhub')`, [callId, CASES[1].id, callId])
  const statements = []
  const pool = { async connect() { return { release() {}, async query(sql, params) {
    statements.push(sql)
    if (sql.startsWith('SELECT')) assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
    return db.query(sql, params)
  } } } }
  const upstream = await diagnoseXiaohongshuRelevance(pool, incident.id)
  assert.equal(upstream.matchedBy, 'provider_upstream_request_id')
  assert.equal(upstream.requests[0].evidence[0].archive.state, 'archive_verified')
  const cache = await diagnoseXiaohongshuRelevance(pool, CASES[1].id)
  assert.equal(cache.requests[0].gateways[0].sourceMode, 'fresh_cache')
  assert.equal(cache.requests[0].evidence[0].ownCall, false)
  assert.equal(cache.requests[0].evidence[0].archive.echoedParams.root.keyword.matchesExpected, false)
  // Reproduce real cache rows with snapshot_id but no provider_call_id. Current
  // mutable pointers must never be promoted to immutable historical origins.
  const snapshotId = '10000000-0000-4000-8000-000000000004'
  await db.query(`UPDATE public.usage_requests SET consumer_id=$1,response_captured_at='2026-09-14T09:16:20Z' WHERE id=$2`, [hubId, CASES[1].id])
  await db.query(`UPDATE external_platform.gateway_requests SET provider_call_id=NULL,snapshot_id=$1,consumer_id=$2,
    created_at='2026-09-14T09:16:21Z' WHERE usage_request_id=$3`, [snapshotId, hubId, CASES[1].id])
  await db.query(`INSERT INTO external_platform.response_snapshots VALUES ($1,'tikhub',$2,'social.posts.search',
    '2026-09-14T09:16:20Z','2026-09-14T09:16:20.999999Z',$3)`, [snapshotId, hubId, callId])
  for (const changed of [false, true]) {
    if (changed) await db.query(`UPDATE external_platform.response_snapshots SET captured_at='2026-10-16T00:00:00Z',
      updated_at='2026-10-16T00:00:00Z',last_success_call_id=$1`, [CASES[2].id])
    const before = statements.length
    const report = await diagnoseXiaohongshuRelevance(pool, CASES[1].id)
    assert.equal(report.diagnosticRevision, 'xiaohongshu-relevance.v2')
    assert.equal(report.requests[0].responseCapturedAt, '2026-09-14T09:16:20.000Z')
    assert.equal(report.requests[0].gateways[0].snapshotId, snapshotId)
    const current = report.requests[0].gateways[0].currentSnapshot
    assert.equal(current.state, 'mutable_current_snapshot')
    assert.equal(current.captureMatchesDelivery, !changed)
    assert.equal(current.notUpdatedAfterGateway, !changed)
    assert.equal(current.historicalOriginConfirmed, false)
    assert.equal(current.lastSuccessCallId, changed ? CASES[2].id : callId)
    assert.deepEqual(report.requests[0].evidence, [])
    assert.equal(statements.slice(before).some(sql => sql.includes('FROM control.external_platform_restricted_raw_responses')), false)
  }
  await db.query('UPDATE external_platform.response_snapshots SET consumer_id=$1', [callId])
  const wrongScope = await diagnoseXiaohongshuRelevance(pool, CASES[1].id)
  assert.deepEqual(wrongScope.requests[0].gateways[0].currentSnapshot, { state: 'snapshot_missing_or_scope_mismatch' })
  await db.exec('DELETE FROM external_platform.response_snapshots')
  const removed = await diagnoseXiaohongshuRelevance(pool, CASES[1].id)
  assert.deepEqual(removed.requests[0].gateways[0].currentSnapshot, { state: 'snapshot_missing_or_scope_mismatch' })
  assert.ok(statements.every(sql => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)))
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal((await db.query('SELECT count(*) FROM public.usage_requests')).rows[0].count, 2)
})
