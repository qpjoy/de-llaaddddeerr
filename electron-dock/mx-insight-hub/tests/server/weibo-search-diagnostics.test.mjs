import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { inspectWeiboArchive, inspectWeiboMetricCoverage, diagnoseWeiboSearch } from '../../server/ops/diagnose-weibo-search.mjs'

const capturedAt = '2026-10-08T07:44:13.288Z'
const snapshot = { path: '/api/v1/data/search', body: { platform: 'weibo', query: 'private-query', pageSize: 20 } }
const row = { weibo_id: '5351726865449966', content: 'private-post-body' }
function archive(data) {
  const bytes = Buffer.from(JSON.stringify({ code: 200, token: 'private-credential-echo', data }))
  return { body_bytes: bytes, body_sha256: createHash('sha256').update(bytes).digest('hex'), captured_at: capturedAt }
}

test('offline diagnostics distinguish pagination, identity and overflow without leaking payloads', () => {
  const pagination = inspectWeiboArchive(archive({ parsed_data: { results: [row],
    pagination: { has_next_page: 'false' }, 'private-key': 'private-value' } }), snapshot)
  assert.equal(pagination.reason, 'invalid_weibo_search_shape')
  assert.equal(pagination.shape.hasNextPage, 'string')
  const identity = inspectWeiboArchive(archive({ parsed_data: { results: [{ content: 'private-post-body' }],
    pagination: { has_next_page: false } } }), snapshot)
  assert.equal(identity.reason, 'invalid_weibo_identity')
  assert.deepEqual(identity.invalidRowIndexes, [0])
  const overflow = inspectWeiboArchive(archive({ parsed_data: { results: Array(21).fill(row),
    pagination: { has_next_page: true } } }), snapshot)
  assert.equal(overflow.reason, 'weibo_page_exceeds_requested_count')
  assert.equal(overflow.shape.resultCount, 21)
  assert.doesNotMatch(JSON.stringify([pagination, identity, overflow]), /private-|5351726865449966/)
})

test('empty results with explicit pagination are accepted; absent, corrupt and missing evidence stay distinct', () => {
  assert.equal(inspectWeiboArchive(archive({ parsed_data: { results: [], pagination: { has_next_page: false } } }), snapshot).state,
    'current_projection_accepts')
  assert.equal(inspectWeiboArchive(archive(null), snapshot).reason, 'invalid_weibo_search_shape')
  assert.equal(inspectWeiboArchive(null, snapshot).state, 'archive_missing')
  const corrupt = archive({})
  corrupt.body_bytes = Buffer.from('corrupt')
  assert.equal(inspectWeiboArchive(corrupt, snapshot).state, 'archive_integrity_failed')
  const invalid = archive({})
  invalid.body_bytes = Buffer.from('not-json')
  invalid.body_sha256 = createHash('sha256').update(invalid.body_bytes).digest('hex')
  assert.equal(inspectWeiboArchive(invalid, snapshot).state, 'archive_not_json')
  assert.equal(inspectWeiboArchive(archive({}), { ...snapshot, body: { ...snapshot.body, cursor: 'private-cursor' } }).state,
    'replay_requires_original_first_page_request')
})

test('legacy page size uses the original count before pageSize and limit', () => {
  const result = inspectWeiboArchive(archive({ parsed_data: { results: Array(21).fill(row), pagination: { has_next_page: false } } }),
    { path: '/api/v1/night-all/search/raw', body: { platform: 'weibo', count: 30, pageSize: 20, limit: 10 } })
  assert.equal(result.state, 'current_projection_accepts')
  assert.equal(result.pageSize, 30)
})

test('verified empty pagination accepts valid short pages and exposes bounded continuation without content', () => {
  for (const count of [0, 8, 10]) {
    const report = inspectWeiboArchive(archive({ parsed_data: { results: Array(count).fill(row),
      result_count: count, pagination: {}, search_stats: {}, parse_success: true } }), snapshot)
    assert.equal(report.state, 'current_projection_accepts')
    assert.equal(report.returnedCount, count)
    assert.equal(report.hasMore, count > 0)
    assert.equal(report.shape.emptyPagination, true)
    assert.equal(report.shape.hasNextPage, 'missing')
    assert.doesNotMatch(JSON.stringify(report), /private-|5351726865449966/)
  }
})

test('Weibo field coverage is bounded, value-free and distinguishes original zero from absent metrics', () => {
  const native = { ...row, post_url: '//weibo.com/private-id/private-path?private-signature',
    interaction: { like_count: '987654321', comment_count: 0, repost_count: '2', 'private-key': 'private-value' },
    view_count: ' ', collect_count: false }
  const payload = { data: { parsed_data: { results: [native, row] } } }
  const report = inspectWeiboMetricCoverage(payload, capturedAt)
  assert.equal(report.rowsExamined, 2)
  assert.deepEqual(report.fields['interaction.like_count'], { present: 1, numeric: 1, zero: 0 })
  assert.deepEqual(report.fields['interaction.comment_count'], { present: 1, numeric: 1, zero: 1 })
  assert.deepEqual(report.projected.likes, { provided: 1, zero: 0, missing: 1 })
  assert.deepEqual(report.projected.comments, { provided: 1, zero: 1, missing: 1 })
  assert.deepEqual(report.projected.views, { provided: 0, zero: 0, missing: 2 })
  assert.deepEqual(report.projected.bookmarks, { provided: 0, zero: 0, missing: 2 })
  assert.deepEqual(report.urls, { provided: 1, missing: 1, protocolRelativePostUrl: 1 })
  const attached = inspectWeiboArchive(archive(payload.data), snapshot)
  assert.deepEqual(attached.metricCoverage, report)
  assert.doesNotMatch(JSON.stringify(report), /private-|987654321|5351726865449966/)
  const bounded = inspectWeiboMetricCoverage({ data: { parsed_data: { results: Array(101).fill(native) } } }, capturedAt)
  assert.equal(bounded.rowsExamined, 100)
  assert.equal(bounded.truncated, true)
  const missing = inspectWeiboMetricCoverage({}, capturedAt)
  assert.equal(missing.available, false)
  assert.equal(missing.reason, 'results_not_array')
  assert.deepEqual(missing.rawHtmlCandidates.paths['payload.data.raw_html'], { present: false, kind: 'missing' })
})

test('Weibo nested coverage inspects all six declared stats containers without changing zeros in the projection', () => {
  const containers = ['stats', 'statistics', 'postStats', 'interact_info', 'interactInfo', 'counts']
  const rows = containers.map((name, index) => ({ ...row,
    interaction: { like_count: 0, comment_count: 0, repost_count: 0 },
    [name]: { like_count: String(987654321 + index), commentCount: 0, shareCount: '0', collect_count_v2: null,
      view_count: { count: '123456789' }, private_metric: 'private-value' },
  }))
  const report = inspectWeiboMetricCoverage({ data: { parsed_data: { results: rows } } }, capturedAt)
  assert.deepEqual(report.projected.likes, { provided: 6, zero: 6, missing: 0 })
  assert.deepEqual(Object.keys(report.knownNestedMetrics.containers), containers)
  assert.equal(report.knownNestedMetrics.scope, 'fixed_candidates_only')
  for (const name of containers) {
    const coverage = report.knownNestedMetrics.containers[name]
    assert.equal(coverage.kindCounts.object, 1)
    assert.equal(coverage.kindCounts.missing, 5)
    assert.deepEqual(coverage.fields.like_count, { present: 1, numeric: 1, zero: 0, nonzero: 1 })
    assert.deepEqual(coverage.fields.commentCount, { present: 1, numeric: 1, zero: 1, nonzero: 0 })
    assert.deepEqual(coverage.fields.shareCount, { present: 1, numeric: 1, zero: 1, nonzero: 0 })
    assert.deepEqual(coverage.fields.collect_count_v2, { present: 1, numeric: 0, zero: 0, nonzero: 0 })
    assert.deepEqual(coverage.fields['view_count.count'], { present: 1, numeric: 1, zero: 0, nonzero: 1 })
    assert.equal(coverage.fields.private_metric, undefined)
  }
  assert.doesNotMatch(JSON.stringify(report), /private-|private_metric|98765432|123456789|5351726865449966/)
})

test('Weibo raw/HTML candidate coverage reports only fixed kinds, even without parsed results, and never parses HTML', () => {
  const payload = { raw_html: '<div>private-body and 987654321 likes</div>', data: {
    raw_data: { 'private-dynamic-key': 'private-value' }, html: ['private-fragment'], unknown_html: 'private-alternative',
    parsed_data: { raw_response: null, results: [{ ...row, html_content: '<p>private-row-body</p>',
      unknown_html: 'private-row-alternative' }] },
  } }
  const report = inspectWeiboMetricCoverage(payload, capturedAt)
  assert.equal(report.rawHtmlCandidates.scope, 'fixed_candidates_only')
  assert.deepEqual(report.rawHtmlCandidates.paths['payload.raw_html'], { present: true, kind: 'string' })
  assert.deepEqual(report.rawHtmlCandidates.paths['payload.data.raw_data'], { present: true, kind: 'object' })
  assert.deepEqual(report.rawHtmlCandidates.paths['payload.data.html'], { present: true, kind: 'array' })
  assert.deepEqual(report.rawHtmlCandidates.paths['payload.data.parsed_data.raw_response'], { present: true, kind: 'null' })
  assert.equal(report.rawHtmlCandidates.rowFields.html_content.present, 1)
  assert.equal(report.rawHtmlCandidates.rowFields.html_content.kindCounts.string, 1)
  assert.deepEqual(report.projected.likes, { provided: 0, zero: 0, missing: 1 })
  const withoutResults = inspectWeiboMetricCoverage({ data: { raw_html: '<p>private-body</p>' } }, capturedAt)
  assert.equal(withoutResults.available, false)
  assert.deepEqual(withoutResults.rawHtmlCandidates.paths['payload.data.raw_html'], { present: true, kind: 'string' })
  assert.doesNotMatch(JSON.stringify([report, withoutResults]), /private-|unknown_html|987654321|5351726865449966/)
})

test('Weibo new coverage is bounded at 100 rows and distinguishes malformed containers and invalid numbers from genuine zero', () => {
  const invalid = { ...row, stats: { like_count: true, comment_count: ' ', share_count: -1, view_count: 'NaN' },
    statistics: null, postStats: [], interact_info: 'private-string', interactInfo: false, counts: 123,
    html: 'private-row-html' }
  const finalRow = { ...row, stats: { like_count: 987654321 }, raw_html: 'private-beyond-bound' }
  const report = inspectWeiboMetricCoverage({ data: { parsed_data: { results: [...Array(100).fill(invalid), finalRow] } } }, capturedAt)
  assert.equal(report.rowsExamined, 100)
  assert.equal(report.truncated, true)
  const coverage = report.knownNestedMetrics.containers
  for (const name of ['like_count', 'comment_count', 'share_count', 'view_count']) {
    assert.deepEqual(coverage.stats.fields[name], { present: 100, numeric: 0, zero: 0, nonzero: 0 })
  }
  assert.equal(coverage.statistics.kindCounts.null, 100)
  assert.equal(coverage.postStats.kindCounts.array, 100)
  assert.equal(coverage.interact_info.kindCounts.string, 100)
  assert.equal(coverage.interactInfo.kindCounts.boolean, 100)
  assert.equal(coverage.counts.kindCounts.number, 100)
  assert.equal(report.rawHtmlCandidates.rowsExamined, 100)
  assert.equal(report.rawHtmlCandidates.rowFields.html.present, 100)
  assert.equal(report.rawHtmlCandidates.rowFields.raw_html, undefined)
  assert.doesNotMatch(JSON.stringify(report), /private-|987654321|5351726865449966/)
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
  const target = '06f6157d-abc9-4341-ade8-fd08d9d7b142'
  const original = '00000000-0000-4000-8000-000000000001'
  const callId = '00000000-0000-4000-8000-000000000002'
  await db.query(`INSERT INTO usage_requests VALUES ($1, 'weibo', 'released', 'external_platform_response_unusable',
    '2026-10-08T07:57:55.172Z', '2026-10-08T07:57:55.199Z', $2),
    ($3, 'weibo', 'released', 'external_platform_response_unusable', $4, $4, $2)`,
  [target, JSON.stringify(snapshot), original, capturedAt])
  await db.query(`INSERT INTO external_platform.provider_calls VALUES ($1, $2, 'succeeded_unusable', 200, 200,
    'invalid_weibo_search_contract', $3, 'not-an-id-private-value', true, 'tikhub',
    'native.t.weibo_web_v2_fetch_realtime_search', 'native.t.weibo_web_v2_fetch_realtime_search',
    'mx-insight-hub.native-forwarding.v1', $3)`, [callId, original, capturedAt])
  const evidence = archive({ parsed_data: { results: [row] } })
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES ($1, $2, $3, $4, $5)`,
    [callId, evidence.body_bytes, evidence.body_sha256, capturedAt, evidence.body_bytes.length])
  const statements = []
  const pool = { async connect() { return { release() {}, query(sql, args) { statements.push(sql); return db.query(sql, args) } } } }
  const report = await diagnoseWeiboSearch(pool, target, { blockedUntil: '2026-10-08T07:59:13.288Z', cooldownMs: 900000 })
  assert.equal((await diagnoseWeiboSearch(pool, target)).cooldownMs, 300000)
  assert.match(statements[0], /READ ONLY$/)
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(report.evidence.length, 1)
  assert.equal(report.evidence[0].requestId, original)
  assert.equal(report.evidence[0].relation, 'endpoint_quarantine_candidate')
  assert.equal(report.evidence[0].matchesReportedDeadline, true)
  assert.equal(report.evidence[0].projection.reason, 'invalid_weibo_search_shape')
  assert.equal(report.evidence[0].projection.shape.hasNextPage, 'missing')
  assert.doesNotMatch(JSON.stringify(report), /private-/)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls')).rows[0].count, 1)
})
