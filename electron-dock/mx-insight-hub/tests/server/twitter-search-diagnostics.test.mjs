import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { inspectTwitterArchive, diagnoseTwitterSearch, twitterInputShapes } from '../../server/ops/diagnose-twitter-search.mjs'

const REQUEST = '446a7664-028d-4dc8-940a-06baaff0c340'
const CALL = '00000000-0000-4000-8000-000000000001'
const capturedAt = '2026-10-15T01:00:00.000Z'
const snapshot = { path: '/api/v1/data/search', body: { platform: 'twitter', query: 'private-query', pageSize: 20 } }
const tweet = { __typename: 'Tweet', rest_id: '9223372036854775807', legacy: { full_text: 'private-body', favorite_count: 0 } }
const itemContent = { itemType: 'TimelineTweet', tweet_results: { result: tweet } }
const cursor = { entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: 'private-cursor' } }
function timeline(entries = []) {
  return { token: 'private-secret', data: { search_by_raw_query: { search_timeline: { timeline: {
    instructions: [{ type: 'TimelineAddEntries', entries }],
  } } } } }
}
function archive(payload) {
  const bytes = Buffer.from(JSON.stringify(payload))
  return { body_bytes: bytes, body_size: bytes.length, body_sha256: createHash('sha256').update(bytes).digest('hex'), captured_at: capturedAt }
}
const noSecrets = report => assert.doesNotMatch(JSON.stringify(report), /private-|9223372036854775807/)

test('verified empty Twitter timeline is distinguished from missing or unusable data without exposing content', () => {
  const empty = inspectTwitterArchive(archive(timeline()), snapshot)
  assert.equal(empty.state, 'current_projection_accepts')
  assert.equal(empty.returnedCount, 0)
  assert.equal(empty.structure.instructionCount, 1)
  assert.equal(empty.structure.entryCount, 0)
  assert.equal(empty.mapping.category, 'Top')
  assert.equal(empty.mapping.providerCount, 20)
  assert.equal(empty.mapping.includeTimestamp, 'false')
  assert.equal(empty.mapping.evidence, 'current_mapping_from_saved_input')
  noSecrets(empty)
  const invalid = inspectTwitterArchive(archive({ data: { message: 'private-failure' } }), snapshot)
  assert.equal(invalid.state, 'current_projection_rejects')
  assert.equal(invalid.reason, 'invalid_timeline_shape')
  assert.equal(inspectTwitterArchive(archive(timeline()), snapshot, { httpStatus: 400 }).state, 'not_success_http')
  noSecrets(invalid)
})

test('saved effective options distinguish new Latest/overrides from historical implicit Top without printing filters', () => {
  for (const [patch, category, includeTimestamp] of [
    [{ twitterSearchParameters: { category: 'Latest', includeTimestamp: false } }, 'Latest', 'false'],
    [{ body: { ...snapshot.body, params: { filters: 'private-filter' } } }, 'Latest', 'false'],
    [{ body: { ...snapshot.body, params: { category: 'Videos', filters: 'private-filter', includeTimestamp: true } } }, 'Videos', 'true'],
  ]) {
    const result = inspectTwitterArchive(archive(timeline()), { ...snapshot, ...patch })
    assert.equal(result.state, 'current_projection_accepts')
    assert.equal(result.mapping.category, category)
    assert.equal(result.mapping.includeTimestamp, includeTimestamp)
    noSecrets(result)
  }
})

test('standard search previews a whole oversized paid page without losing buffered posts or changing the archive', () => {
  const entries = Array.from({ length: 24 }, (_, index) => ({ content: { itemContent: {
    ...itemContent, tweet_results: { result: { ...tweet, rest_id: String(index + 1) } },
  } } }))
  const receipt = archive({ entries: [{ type: 'TimelineAddEntries', entries: [...entries, cursor] }] })
  const originalBytes = Buffer.from(receipt.body_bytes), originalHash = receipt.body_sha256
  const report = inspectTwitterArchive(receipt, snapshot)
  assert.equal(report.state, 'current_projection_accepts')
  assert.equal(report.returnedCount, 20)
  assert.equal(report.acquiredCount, 24)
  assert.equal(report.bufferedCount, 4)
  assert.equal(report.hasMore, true)
  assert.deepEqual(report.bufferPreview, { returnedCount: 4, upstreamCallCount: 0, hasMore: true })
  assert.equal(report.hashVerified, true)
  assert.equal(report.structure.tweetResultCount, 24)
  assert.equal(report.mapping.providerCount, 20)
  assert.equal(receipt.body_sha256, originalHash)
  assert.ok(originalBytes.equals(receipt.body_bytes))
  const independent = inspectTwitterArchive(receipt, { path: '/api/v1/data/social/search', body: { platform: 'twitter', query: 'private-query', count: 20 } })
  assert.equal(independent.state, 'current_projection_rejects')
  assert.equal(independent.reason, 'upstream_page_exceeds_requested_count')
  noSecrets(report)
  noSecrets(independent)
})

test('known TimelineTimelineModule items are counted and parsed while unrelated quoted trees stay excluded', () => {
  const post = structuredClone(itemContent)
  post.tweet_results.result.quoted_status_result = { result: tweet }
  const payload = timeline([{ entryId: 'search-grid-0', content: { entryType: 'TimelineTimelineModule',
    items: [{ entryId: 'module-tweet-1', item: { itemContent: post } }] } }, cursor])
  const report = inspectTwitterArchive(archive(payload), snapshot)
  assert.equal(report.state, 'current_projection_accepts')
  assert.equal(report.structure.moduleCount, 1)
  assert.equal(report.structure.itemsCount, 1)
  assert.equal(report.structure.tweetResultCount, 1)
  assert.equal(report.structure.tweetStringIdentityCount, 1)
  assert.equal(report.structure.tweetLegacyCount, 1)
  assert.equal(report.returnedCount, 1)
  assert.equal(report.hasMore, true)
  assert.equal(report.structure.bottomCursorCount, 1)
  noSecrets(report)
})

test('diagnostic structural inventory can reveal fixed module wrappers the installed parser does not consume', () => {
  const payload = { data: { module: { entries: [{ content: { itemContent } }] } } }
  const report = inspectTwitterArchive(archive(payload), snapshot)
  assert.equal(report.structure.entryCount, 1)
  assert.equal(report.structure.tweetResultCount, 1)
  assert.equal(report.state, 'current_projection_rejects')
  assert.equal(report.reason, 'invalid_timeline_shape')
  noSecrets(report)
})

test('diagnostic locates nested entries wrappers without revealing arbitrary names or payload values', () => {
  const report = inspectTwitterArchive(archive({ entries: [{ type: 'TimelineAddEntries', entries: [
    { content: { itemContent } }, cursor,
  ] }] }), snapshot)
  assert.equal(report.structure.rootFields.entries, 'array')
  assert.equal(report.structure.rootFields.instructions, 'missing')
  assert.deepEqual(report.structure.entryContainers, [{ path: 'payload.entries', count: 1 }, { path: 'payload.entries[0].entries', count: 2 }])
  assert.equal(report.structure.entryWrapperTypes.TimelineAddEntries, 1)
  assert.equal(report.structure.entries[0].wrapperType, 'TimelineAddEntries')
  assert.equal(report.structure.entries[1].containerPath, 'payload.entries[0].entries')
  noSecrets(report)
})

test('archive integrity, saved inputs and structural limits fail closed before offline projection', () => {
  const valid = archive(timeline())
  assert.equal(inspectTwitterArchive(null, snapshot).state, 'archive_missing')
  assert.equal(inspectTwitterArchive({ ...valid, body_bytes: Buffer.from('changed') }, snapshot).state, 'archive_integrity_failed')
  assert.equal(inspectTwitterArchive({ ...valid, body_size: 4 * 1024 * 1024 + 1 }, snapshot).state, 'archive_too_large')
  const invalid = Buffer.from('invalid-json')
  assert.equal(inspectTwitterArchive({ ...valid, body_bytes: invalid, body_size: invalid.length,
    body_sha256: createHash('sha256').update(invalid).digest('hex') }, snapshot).state, 'archive_not_json')
  assert.equal(inspectTwitterArchive(valid, { ...snapshot, body: { ...snapshot.body, cursor: 'private-cursor' } }).state,
    'projection_requires_original_first_page_request')
  assert.equal(inspectTwitterArchive(valid, { ...snapshot, body: { ...snapshot.body, pageSize: 101 } }).state,
    'invalid_saved_search_parameters')
  assert.equal(inspectTwitterArchive({ ...valid, captured_at: 'invalid-date' }, snapshot).state, 'invalid_archive_timestamp')
  const large = inspectTwitterArchive(archive(timeline(Array.from({ length: 10020 }, () => ({ content: {} })))), snapshot)
  assert.equal(large.structure.truncated, true)
  assert.equal(large.structure.entries.length, 20)
  assert.ok(large.structure.nodesInspected <= 10000)
  noSecrets(twitterInputShapes({ body: { query: 'private-query', cursor: 'private-cursor', sort: 'private-value', params: { token: 'private-secret' } } }))
})

function databaseFixture({ fail = false, provider = 'rapidapi' } = {}) {
  const statements = [], release = []
  const request = { id: REQUEST, platform: 'twitter', status: 'committed', response_status: 200,
    reserved_at: capturedAt, completed_at: capturedAt, acquisition_request: snapshot,
    delivery_contract_version: 'night-all.data-search.v1', delivery_status: 'ok', delivery_source_mode: 'live',
    delivered_item_count: 0, declared_returned_count: 0, delivery_has_more: false }
  const call = { id: CALL, provider_key: provider, operation: 'social.content.search', endpoint_key: 'twitter-aio.search',
    endpoint_version: 'twitter-aio.hub.v1', contract_version: 'mx-insight-hub.social-data.v1',
    outcome: 'succeeded', http_status: 200, business_code: null, billed: null, item_count: 0,
    started_at: capturedAt, completed_at: capturedAt }
  return { statements, release, request,
    pool: { async connect() { return { release() { release.push(true) }, async query(sql, values) {
      statements.push({ sql, values })
      if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
      if (sql.includes('FROM public.usage_requests')) return { rows: [request] }
      if (sql.includes('FROM external_platform.provider_calls')) {
        if (fail) throw new Error('private-database-connection-string')
        return { rows: [call] }
      }
      if (sql.includes('FROM control.external_platform_restricted_raw_responses')) return { rows: [archive(timeline())] }
      assert.fail('Unexpected diagnostic SQL')
    } } } } }
}

test('request diagnostic joins only its stored provider calls under a read-only transaction', async () => {
  const h = databaseFixture(), report = await diagnoseTwitterSearch(h.pool, REQUEST)
  assert.equal(report.diagnosticRevision, 'twitter-search-diagnostic.v3')
  assert.equal(report.projectionImplementation, 'installed_hub_contract')
  assert.equal(report.parserSha256, null)
  assert.match(h.statements[0].sql, /READ ONLY$/)
  assert.equal(h.statements.at(-1).sql, 'COMMIT')
  assert.ok(h.statements.every(({ sql }) => /^(BEGIN|SET LOCAL|SELECT|COMMIT)/.test(sql)))
  assert.match(h.statements.find(({ sql }) => sql.includes('FROM external_platform.provider_calls')).sql, /usage_request_id = \$1/)
  assert.deepEqual(h.statements.find(({ sql }) => sql.includes('FROM external_platform.provider_calls')).values, [REQUEST])
  assert.equal(report.delivery.itemCount, 0)
  assert.equal(report.delivery.sourceMode, 'live')
  assert.equal(report.evidence[0].endpointVersion, 'twitter-aio.hub.v1')
  assert.equal(report.evidence[0].billed, null)
  assert.equal(report.evidence[0].businessCode, null)
  assert.equal(report.evidence[0].outcome, 'succeeded')
  assert.equal(report.evidence[0].projection.state, 'current_projection_accepts')
  assert.equal(report.evidence[0].deliveredCountMatchesCurrent, true)
  assert.equal(h.release.length, 1)
  noSecrets(report)
  const absent = databaseFixture()
  absent.request.delivery_source_mode = undefined
  assert.equal((await diagnoseTwitterSearch(absent.pool, REQUEST)).delivery.sourceMode, 'other_or_missing')
})

test('unsupported routes are not projected as Twitter AIO and read errors roll back without writes', async () => {
  const unsupported = databaseFixture({ provider: 'tikhub' })
  const report = await diagnoseTwitterSearch(unsupported.pool, REQUEST)
  assert.equal(report.evidence[0].projection.state, 'not_current_twitter_aio_search_contract')
  assert.equal(unsupported.statements.some(({ sql }) => sql.includes('restricted_raw_responses')), false)
  const failing = databaseFixture({ fail: true })
  await assert.rejects(diagnoseTwitterSearch(failing.pool, REQUEST))
  assert.equal(failing.statements.at(-1).sql, 'ROLLBACK')
  assert.equal(failing.release.length, 1)
  await assert.rejects(diagnoseTwitterSearch(failing.pool, 'invalid'), /invalid_request_id/)
})

test('operator stdin command runs the unmodified script without requiring filesystem writes or revealing configuration', () => {
  const source = readFileSync(new URL('../../server/ops/diagnose-twitter-search.mjs', import.meta.url), 'utf8')
  const env = { ...process.env }
  delete env.DATABASE_URL
  const cwd = new URL('../../', import.meta.url)
  for (const args of [[REQUEST], ['invalid'], [REQUEST, 'extra']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', ...args], { cwd, env, input: source, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.deepEqual(JSON.parse(result.stderr), { error: args.length > 1 ? 'invalid_arguments' : args[0] === REQUEST ? 'database_url_required' : 'invalid_request_id' })
  }
})

const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('isolated PostgreSQL executes the diagnostic JSON and restricted archive reads without changing saved evidence', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE usage_requests (id uuid, platform text, status text, response_status int, error_code text,
      reserved_at timestamptz, completed_at timestamptz, acquisition_request jsonb, response_body jsonb);
    CREATE TABLE external_platform.provider_calls (id uuid, usage_request_id uuid, provider_key text,
      operation text, endpoint_key text, endpoint_version text, contract_version text, outcome text,
      http_status int, business_code int, billed boolean, item_count int, started_at timestamptz, completed_at timestamptz);
    CREATE TABLE control.external_platform_restricted_raw_responses (provider_call_id uuid,
      body_sha256 text, body_size int, captured_at timestamptz, body_bytes bytea);`)
  const delivered = { data: { contractVersion: 'night-all.data-search.v1', status: 'ok', items: [],
    pageInfo: { returnedCount: 0, hasMore: false } }, meta: { sourceMode: 'live' } }
  await db.query(`INSERT INTO usage_requests VALUES ($1, 'twitter', 'committed', 200, NULL, $2, $2, $3, $4)`,
    [REQUEST, capturedAt, JSON.stringify(snapshot), JSON.stringify(delivered)])
  await db.query(`INSERT INTO external_platform.provider_calls VALUES ($1, $2, 'rapidapi', 'social.content.search',
    'twitter-aio.search', 'twitter-aio.hub.v1', 'mx-insight-hub.social-data.v1', 'succeeded', 200, NULL, NULL, 0, $3, $3)`,
  [CALL, REQUEST, capturedAt])
  const receipt = archive(timeline())
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES ($1, $2, $3, $4, $5)`,
    [CALL, receipt.body_sha256, receipt.body_size, capturedAt, receipt.body_bytes])
  const statements = [], pool = { async connect() { return { release() {}, query(sql, values) {
    statements.push(sql); return db.query(sql, values)
  } } } }
  const report = await diagnoseTwitterSearch(pool, REQUEST)
  assert.equal(report.delivery.itemCount, 0)
  assert.equal(report.delivery.declaredReturnedCount, 0)
  assert.equal(report.evidence[0].projection.hashVerified, true)
  assert.equal(report.evidence[0].projection.state, 'current_projection_accepts')
  assert.equal(report.evidence[0].deliveredCountMatchesCurrent, true)
  assert.match(statements[0], /READ ONLY$/)
  assert.ok(statements.every(sql => /^(BEGIN|SET LOCAL|SELECT|COMMIT)/.test(sql)))
  const saved = await db.query('SELECT response_body FROM usage_requests WHERE id = $1', [REQUEST])
  assert.deepEqual(saved.rows[0].response_body, delivered)
  noSecrets(report)
})
