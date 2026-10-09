import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inspectInstagramArchive, diagnoseInstagramSearch } from '../../server/ops/diagnose-instagram-search.mjs'

const capturedAt = '2026-10-09T06:51:23.835Z'
const snapshot = { path: '/api/v1/data/search', body: { platform: 'instagram', query: 'private-query', pageSize: 20 } }
const row = { pk: '123456789012345678', code: 'private-shortcode', caption: { text: 'private-post-body' } }
function archive(data) {
  const bytes = Buffer.from(JSON.stringify({ code: 200, token: 'private-credential-echo', data }))
  return { body_bytes: bytes, body_sha256: createHash('sha256').update(bytes).digest('hex'), captured_at: capturedAt }
}

test('offline diagnostics distinguish Instagram shape, layout, identity, overflow and pagination without leaking values', () => {
  for (const [data, reason] of [
    [{ 'private-field': 'private-value' }, 'invalid_instagram_search_shape'],
    [{ media_grid: { sections: [{ layout_content: { medias: {} } }] } }, 'invalid_instagram_media_grid'],
    [{ items: [{ ...row, pk: 123456789012345678 }] }, 'invalid_instagram_post_identity'],
    [{ items: Array.from({ length: 21 }, (_, i) => ({ ...row, pk: String(i + 1) })) }, 'instagram_page_exceeds_requested_count'],
    [{ items: [row], has_more: true }, 'missing_instagram_continuation'],
    [{ items: [row], next_max_id: 'private-cursor', rank_token: {} }, 'invalid_instagram_continuation'],
    [{ items: [row], has_more: 'private-value' }, 'invalid_instagram_pagination'],
    [{ items: [null] }, 'unexpected_projection_error'],
  ]) {
    const result = inspectInstagramArchive(archive(data), snapshot)
    assert.equal(result.state, 'current_projection_rejects')
    assert.equal(result.reason, reason)
    if (reason === 'invalid_instagram_post_identity') {
      assert.deepEqual(result.invalidRowIndexes, [0])
      assert.equal(result.invalidRows[0].unsafeNumericId, true)
    }
    if (reason === 'instagram_page_exceeds_requested_count') assert.equal(result.uniqueValidIdentityCount, 21)
    assert.doesNotMatch(JSON.stringify(result), /private-|123456789012345678/)
  }
})

test('media grid, nested items, duplicates and keyword-only responses replay without provider calls', () => {
  const grid = { status: 'ok', rank_token: 'private-rank', media_grid: {
    sections: [{ layout_content: { medias: [{ media: row }, { media: row }] } }],
    more_available: true, next_max_id: 'private-next' } }
  const result = inspectInstagramArchive(archive(grid), snapshot)
  assert.equal(result.state, 'current_projection_accepts')
  assert.equal(result.resultCount, 2)
  assert.equal(result.returnedCount, 1)
  assert.equal(result.hasMore, true)
  assert.equal(result.shape.sectionShapes[0].mediasCount, 2)
  assert.equal(result.shape.gridPagination.nextMaxId.type, 'string')
  const nested = inspectInstagramArchive(archive({ data: { items: [row], has_more: false } }), snapshot)
  assert.equal(nested.state, 'current_projection_accepts')
  assert.equal(nested.shape.nestedData, 'object')
  const keywords = inspectInstagramArchive(archive({ status: 'ok',
    other_results: { keyword_recommendations: { keywords: [{ id: 'private-id', name: 'private-name' }] } } }), snapshot)
  assert.equal(keywords.returnedCount, 0)
  assert.equal(keywords.hasMore, false)
  assert.doesNotMatch(JSON.stringify([result, nested, keywords]), /private-|123456789012345678/)
})

test('diagnostic output bounds section and row evidence and protects saved request provenance', () => {
  const result = inspectInstagramArchive(archive({ media_grid: { sections: Array.from({ length: 25 }, () => ({
    layout_content: { medias: [{ media: { code: 'private-code' } }] } })) } }), snapshot)
  assert.equal(result.shape.sectionShapes.length, 20)
  assert.equal(result.shape.sectionsTruncated, true)
  assert.equal(result.invalidRowCount, 25)
  assert.equal(result.invalidRows.length, 20)
  assert.equal(result.invalidRowsTruncated, true)
  const valid = archive({ items: [row] })
  for (const body of [{ ...snapshot.body, cursor: 'private-cursor' }, { ...snapshot.body, page: 2 }, { platform: 'weibo' }]) {
    assert.equal(inspectInstagramArchive(valid, { ...snapshot, body }).state, 'replay_requires_original_first_page_request')
  }
  assert.equal(inspectInstagramArchive(valid, { ...snapshot, body: { ...snapshot.body, pageSize: 101 } }).state, 'invalid_saved_page_size')
  const raw = inspectInstagramArchive(valid, { path: '/api/v1/night-all/search/raw',
    body: { platform: 'instagram', count: 30, pageSize: 20, limit: 10 } })
  assert.equal(raw.pageSize, 30)
})

test('list-only evidence shows bounded field types and replays accounts without exposing identity or rank tokens', () => {
  const data = { status: 'ok', list: [{ position: 0,
    user: { id: '12345', pk: '12345', username: 'private-name', full_name: 'private-full-name' } }],
    has_more: false, rank_token: 'r'.repeat(78) }
  const report = inspectInstagramArchive(archive(data), snapshot)
  assert.equal(report.state, 'current_projection_accepts')
  assert.equal(report.returnedCount, 0)
  assert.equal(report.hasMore, false)
  assert.equal(report.shape.listCount, 1)
  assert.equal(report.shape.listEntries[0].fields.user, 'object')
  assert.equal(report.shape.listEntries[0].user.pk, 'string')
  assert.equal(report.shape.pagination.rankToken.length, 78)
  assert.doesNotMatch(JSON.stringify(report), /private-|12345|rrrr/)
  data.list = Array(25).fill(data.list[0])
  const bounded = inspectInstagramArchive(archive(data), snapshot)
  assert.equal(bounded.shape.listEntries.length, 20)
  assert.equal(bounded.shape.listEntriesTruncated, true)
  data.list = [{ name: 'private-unknown-kind' }]
  assert.equal(inspectInstagramArchive(archive(data), snapshot).state, 'current_projection_rejects')
  data.list = [{ media: row }, row]
  const posts = inspectInstagramArchive(archive(data), snapshot)
  assert.equal(posts.resultCount, 2)
  assert.equal(posts.uniqueValidIdentityCount, 1)
  assert.equal(posts.returnedCount, 1)
})

test('missing, corrupt, invalid JSON and non-success archives cannot imply parser compatibility', () => {
  assert.equal(inspectInstagramArchive(null, snapshot).state, 'archive_missing')
  const corrupt = archive({})
  corrupt.body_bytes = Buffer.from('corrupt')
  assert.equal(inspectInstagramArchive(corrupt, snapshot).state, 'archive_integrity_failed')
  const invalid = archive({})
  invalid.body_bytes = Buffer.from('not-json')
  invalid.body_sha256 = createHash('sha256').update(invalid.body_bytes).digest('hex')
  assert.equal(inspectInstagramArchive(invalid, snapshot).state, 'archive_not_json')
  const failed = archive({})
  failed.body_bytes = Buffer.from(JSON.stringify({ code: 429, data: { items: [] } }))
  failed.body_sha256 = createHash('sha256').update(failed.body_bytes).digest('hex')
  assert.equal(inspectInstagramArchive(failed, snapshot).state, 'not_success_envelope')
})

const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('read-only database diagnosis traces an endpoint-wide blocker instead of treating the 409 as a paid call', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE usage_requests (id uuid PRIMARY KEY, platform text, status text, error_code text,
      reserved_at timestamptz, completed_at timestamptz, acquisition_request jsonb);
    CREATE TABLE external_platform.provider_calls (id uuid, usage_request_id uuid, outcome text, http_status int,
      business_code int, error_code text, completed_at timestamptz, upstream_request_id text, billed boolean,
      provider_key text, operation text, endpoint_key text, contract_version text, started_at timestamptz);
    CREATE TABLE control.external_platform_restricted_raw_responses (provider_call_id uuid, body_bytes bytea,
      body_sha256 text, captured_at timestamptz, body_size int);`)
  const target = '112fad2d-a78e-4959-9328-d3fdfb7d0c94'
  const original = '00000000-0000-4000-8000-000000000001'
  const callId = '00000000-0000-4000-8000-000000000002'
  await db.query(`INSERT INTO usage_requests VALUES ($1, 'instagram', 'released', 'external_platform_response_unusable',
    '2026-10-09T07:04:27.480Z', '2026-10-09T07:04:27.490Z', $2),
    ($3, 'instagram', 'released', 'external_platform_response_unusable', $4, $4, $2)`,
  [target, JSON.stringify(snapshot), original, capturedAt])
  await db.query(`INSERT INTO external_platform.provider_calls VALUES ($1, $2, 'succeeded_unusable', 200, 200,
    'invalid_instagram_search_contract', $3, 'not-an-id-private-value', true, 'tikhub',
    'native.t.instagram_v3_general_search', 'native.t.instagram_v3_general_search',
    'mx-insight-hub.native-forwarding.v1', $3)`, [callId, original, capturedAt])
  const evidence = archive({ items: [row], has_more: true })
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES ($1, $2, $3, $4, $5)`,
    [callId, evidence.body_bytes, evidence.body_sha256, capturedAt, evidence.body_bytes.length])
  const statements = []
  const pool = { async connect() { return { release() {}, query(sql, args) { statements.push(sql); return db.query(sql, args) } } } }
  const report = await diagnoseInstagramSearch(pool, target, { blockedUntil: '2026-10-09T07:06:23.835Z' })
  assert.match(statements[0], /READ ONLY$/)
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(report.evidence.length, 1)
  assert.equal(report.evidence[0].requestId, original)
  assert.equal(report.evidence[0].relation, 'endpoint_quarantine_candidate')
  assert.equal(report.evidence[0].matchesReportedDeadline, true)
  assert.equal(report.evidence[0].projection.reason, 'missing_instagram_continuation')
  assert.equal(report.evidence[0].projection.shape.pagination.nextMaxId.type, 'missing')
  assert.doesNotMatch(JSON.stringify(report), /private-/)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls')).rows[0].count, 1)
})
