import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { KUAISHOU_VERIFICATION_SOURCE as pin, isPinnedKuaishouSource, inspectKuaishouCandidate,
  verifySavedKuaishouSearch, kuaishouVerificationFailure } from '../../server/ops/verify-kuaishou-search-49814.mjs'

const card = () => ({ itemType: 9, position: 5, atmosphereType: 0, rank: 5, isSingleColumnMode: true,
  relatedSearches: Array.from({ length: 8 }, (_, index) => ({ expTag: 'private-tag', keyword: `private-word-${index}`, iconText: '',
    subtagType: 0, type: 'private-type', iconColor: 'private-color',
    extParams: JSON.stringify({ reco_reason: 'private-reason', sever_path: 'private-path', module: 'private-module', request_source: 'private-source' }) })),
  itemTransferInfo: '{"refer_single_double_type":0}', extInfo: { styleType: 0, screenItemKey: 'private-screen', lines: 2, rsType: 0 } })
const fixture = () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ itemType: 5, feed: { photoId: `private-id-${index}`, caption: `private-body-${index}`,
    like_count: 0, user_id: 'private-author', main_mv_url: `https://private.example/video-${index}.mp4?signature=private-token` } }))
  rows.splice(5, 0, card())
  return { code: 200, data: { mixFeeds: rows, pcursor: 'private-next', has_more: true }, unused: '\0' }
}
const snapshot = { path: '/api/v1/data/search', body: { platform: 'kuaishou', query: 'private-query', pageSize: 20 } }
const invoke = payload => inspectKuaishouCandidate({ bodyBytes: Buffer.from(JSON.stringify(payload)), capturedAt: '2026-10-14T23:23:48.000Z', acquisitionRequest: snapshot })
const sourceRow = () => ({ request_id: pin.requestId, call_id: pin.callId, usage_request_id: pin.requestId,
  tenant_id: 'tenant-fixture', call_tenant_id: 'tenant-fixture', consumer_id: 'consumer-fixture', call_consumer_id: 'consumer-fixture',
  api_key_id: 'key-fixture', call_api_key_id: 'key-fixture', platform: 'kuaishou', provider_key: 'tikhub', operation: pin.operation,
  endpoint_key: pin.endpointKey, endpoint_version: pin.endpointVersion, contract_version: pin.contractVersion,
  status: 'committed', response_status: 502, outcome: 'succeeded_unusable', http_status: 200, business_code: 200,
  billed: true, body_size: pin.bodySize, body_sha256: pin.bodySha256, acquisition_request: snapshot })

test('verification replays original bytes through actual adapter and workflow guard with zero supplier HTTP and private output', async t => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('Forbidden actual HTTP') }
  t.after(() => { globalThis.fetch = originalFetch })
  const payload = fixture(), original = structuredClone(payload), report = await invoke(payload)
  assert.equal(report.mode, 'offline_original_bytes_replay')
  assert.equal(report.upstreamCallCount, 0); assert.equal(report.syntheticAdapterInvocations, 1)
  assert.equal(report.fullRawPostgresSafe, false)
  assert.deepEqual(report.adapterCandidate, { state: 'candidate_accepts' })
  assert.equal(report.projection.state, 'candidate_accepts')
  assert.equal(report.projection.acquiredCount, 10); assert.equal(report.projection.nonPostCount, 1)
  assert.equal(report.projection.uniqueIdentityCount, 10); assert.equal(report.projection.hasMore, true)
  assert.deepEqual(report.projection.postgresSafe, { rows: true, modern: true, providerPage: true, ingestFields: true })
  assert.equal(report.relatedSearchCardCount, 1)
  assert.deepEqual(report.relatedSearchCards, [{ metadataAccepted: true, relatedSearchCount: 8, inspectedCount: 8, invalidIndexes: [], truncated: false }])
  assert.equal(report.candidateArchive.parsedPayloadState, 'null')
  assert.equal(report.candidateArchive.originalBytesMatch, true); assert.equal(report.candidateArchive.originalByteHashMatches, true)
  assert.doesNotMatch(JSON.stringify(report), /private-|private\.example/)
  assert.deepEqual(payload, original)
})

test('verification preserves all recommendation coverage on eighth-row rejection and rejects unsafe served content', async () => {
  const badCard = fixture(); badCard.data.mixFeeds[5].relatedSearches[7].extParams = '{"hidden":"private-post"}'
  const rejected = await invoke(badCard)
  assert.equal(rejected.adapterCandidate.state, 'candidate_accepts')
  assert.equal(rejected.projection.reason, 'invalid_content_search_identity')
  assert.deepEqual(rejected.relatedSearchCards[0].invalidIndexes, [7])
  assert.equal(rejected.relatedSearchCards[0].inspectedCount, 8)
  const unsafe = fixture(); unsafe.data.mixFeeds[0].feed.caption = 'private-\0-body'
  const invalid = await invoke(unsafe)
  assert.equal(invalid.projection.reason, 'invalid_content_search_projection')
  assert.equal(invalid.upstreamCallCount, 0)
  assert.doesNotMatch(JSON.stringify([rejected, invalid]), /private-/)
})

test('verification source pins exact ownership, archive fingerprint, source contract and original paid failure', () => {
  const row = sourceRow()
  assert.equal(isPinnedKuaishouSource(row), true)
  for (const changes of [{ request_id: randomUUID() }, { call_id: randomUUID() }, { usage_request_id: randomUUID() },
    { call_tenant_id: 'other' }, { call_consumer_id: 'other' }, { call_api_key_id: 'other' }, { provider_key: 'other' },
    { endpoint_key: 'other' }, { endpoint_version: 'other' }, { contract_version: 'other' }, { operation: 'other' },
    { body_size: pin.bodySize + 1 }, { body_sha256: '0'.repeat(64) }, { status: 'unknown' }, { response_status: 200 },
    { outcome: 'succeeded' }, { http_status: 201 }, { business_code: 0 }, { billed: false },
    { acquisition_request: { ...snapshot, body: { ...snapshot.body, cursor: 'private-cursor' } } }]) {
    assert.equal(isPinnedKuaishouSource({ ...row, ...changes }), false)
  }
})

test('verification fails closed before replay on missing source or mismatched bytes and only uses readonly SQL', async () => {
  for (const row of [null, { ...sourceRow(), body_bytes: Buffer.alloc(pin.bodySize), captured_at: new Date() }]) {
    const sql = [], client = { release() {}, async query(query, args) {
      sql.push(query)
      if (query.startsWith('SELECT')) { assert.deepEqual(args, [pin.requestId, pin.callId, pin.bodySize]); return { rows: row ? [row] : [] } }
      return { rows: [] }
    } }
    let error
    try { await verifySavedKuaishouSearch({ connect: async () => client }) } catch (cause) { error = cause }
    assert.equal(kuaishouVerificationFailure(error).reason, row ? 'archive_integrity_failed' : 'source_identity_mismatch')
    assert.equal(sql[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(sql.at(-1), 'ROLLBACK')
    assert.ok(sql.every(query => /^(?:BEGIN|SET LOCAL|SELECT|ROLLBACK)/u.test(query)))
  }
  assert.deepEqual(kuaishouVerificationFailure(Object.assign(new Error('private SQL'), { code: '23502' })),
    { error: 'kuaishou_verification_failed', reason: 'read_or_verification_failed', sqlState: '23502' })
})

test('verification exact SELECT executes in actual PGlite and leaves the paid failure and evidence untouched',
  { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
    const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
    const db = new PGlite(); t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control; CREATE SCHEMA mxq;
      CREATE TABLE usage_requests(id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,platform text,status text,response_status int,acquisition_request jsonb);
      CREATE TABLE external_platform.provider_calls(id uuid,usage_request_id uuid,tenant_id uuid,consumer_id uuid,api_key_id uuid,
        provider_key text,operation text,endpoint_key text,endpoint_version text,contract_version text,outcome text,http_status int,business_code int,billed boolean);
      CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid,body_bytes bytea,body_size int,body_sha256 text,captured_at timestamptz,parsed_payload jsonb);
      CREATE TABLE external_platform.response_archives(provider_call_id uuid);
      CREATE TABLE external_platform.archive_objects(provider_call_id uuid);
      CREATE TABLE mxq.jobs(queue text,dedupe_key text);`)
    const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID()
    await db.query(`INSERT INTO usage_requests VALUES($1,$2,$3,$4,'kuaishou','committed',502,$5)`, [pin.requestId, tenant, consumer, key, JSON.stringify(snapshot)])
    await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,$3,$4,$5,'tikhub',$6,$6,$7,$8,'succeeded_unusable',200,200,true)`,
      [pin.callId, pin.requestId, tenant, consumer, key, pin.operation, pin.endpointVersion, pin.contractVersion])
    await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4,now(),NULL)`,
      [pin.callId, Buffer.alloc(pin.bodySize), pin.bodySize, pin.bodySha256])
    await db.query('INSERT INTO external_platform.response_archives VALUES($1)', [pin.callId])
    await db.query('INSERT INTO external_platform.archive_objects VALUES($1)', [pin.callId])
    let connections = 0, released = 0
    const pool = { connect: async () => { connections++; return { query: (sql, args) => db.query(sql, args), release() { released++ } } } }
    await assert.rejects(verifySavedKuaishouSearch(pool), error => error.verificationCode === 'archive_integrity_failed')
    assert.equal(connections, 1); assert.equal(released, 1)
    const saved = (await db.query(`SELECT request.status,request.response_status,call.outcome,call.billed,
      (SELECT count(*)::int FROM external_platform.archive_objects) AS archive_count,(SELECT count(*)::int FROM mxq.jobs) AS jobs
      FROM usage_requests request JOIN external_platform.provider_calls call ON call.usage_request_id=request.id`)).rows[0]
    assert.deepEqual(saved, { status: 'committed', response_status: 502, outcome: 'succeeded_unusable', billed: true, archive_count: 1, jobs: 0 })
  })
