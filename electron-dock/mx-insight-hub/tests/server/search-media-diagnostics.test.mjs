import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describeMediaUrl, diagnosticErrorReport, diagnoseSearchMedia, extractSearchRows, inspectSearchRow, parseArgs } from '../../server/ops/diagnose-search-media.mjs'

const ID = '87977322-77d9-4251-8171-31e88213c868'
const SNAPSHOT = '6f7844ea-ab15-44a9-96c6-284ecf994f27'
const COVER = 'https://media.example.test/private-signed-path/poster.jpg?signature=never-print-me&width=320'
const VIDEO = 'https://media.example.test/private-signed-path/video.mp4?token=never-print-video'
const row = overrides => ({ content_id: 'post-1', author_id: 'author-1', content_type: '4', title: 'private-title',
  full_text: 'private-body needle', image_urls: JSON.stringify([COVER]), cover_url: COVER,
  video_urls: JSON.stringify([VIDEO]), ...overrides })

test('media reports distinguish exact posters from URL variants without exposing signed paths or values', () => {
  const descriptor = describeMediaUrl(COVER)
  assert.deepEqual(descriptor.queryKeys, ['signature', 'width'])
  const original = row({ image_urls: [COVER, COVER.replace('width=320', 'width=640'), 'https://other.example.test/photo.jpg'] })
  const before = structuredClone(original)
  const report = inspectSearchRow(original, 'douyin')
  assert.equal(report.postExternalId, 'post-1')
  assert.equal(report.authorExternalId, 'author-1')
  assert.equal(report.before.entries[0].exactCoverMatch, true)
  assert.equal(report.before.entries[1].samePathDifferentUrl, true)
  assert.equal(report.currentNormalization.mediaChanged, true)
  assert.equal(report.currentNormalization.after.counts.image_urls, 2)
  assert.doesNotMatch(JSON.stringify(report), /never-print|private-signed-path|poster\.jpg|private-title|private-body|width=320/)
  assert.deepEqual(original, before)
})

test('Reddit titles remain native titles while Twitter content titles follow the current policy', () => {
  const reddit = inspectSearchRow(row({ content_id: 't3_post', author_id: 't2_account', title: '[X] Native Reddit title', video_urls: '[]' }), 'reddit')
  assert.equal(reddit.authorExternalId, 't2_account')
  assert.equal(reddit.title.suppressedByCurrentPolicy, false)
  assert.equal(reddit.currentNormalization.mediaChanged, false)
  assert.equal(inspectSearchRow(row(), 'twitter').title.suppressedByCurrentPolicy, true)
  assert.equal(inspectSearchRow({ object_type: 'post', content_type: 'video', title: 'old', stable_fields: { media: { coverUrl: COVER, images: [COVER], videos: [VIDEO] } } }, 'douyin', 'canonical').currentNormalization.after.counts['media.images'], 0)
})

test('envelope extraction reads raw/data content and bounded nested results, never account rows', () => {
  const payload = { data: { raw_info: JSON.stringify([row({ content_id: 'account' })]), raw_data: JSON.stringify([row()]),
    results: [{ data: { items: [row({ content_id: 'nested' })] } }] } }
  const report = extractSearchRows(payload)
  assert.deepEqual(report.rows.map(item => [item.row.content_id, item.format]), [['post-1', 'raw'], ['nested', 'data']])
  assert.equal(report.truncated, false)
  assert.equal(extractSearchRows({ data: { raw_data: 'not-json' } }).rows.length, 0)
  assert.equal(extractSearchRows({ data: { items: Array(501).fill(row()) } }).truncated, true)
})

test('CLI requires a bounded explicit selector and rejects mutation or unknown arguments', () => {
  assert.deepEqual(parseArgs(['--platform', 'douyin', '--author-id', '7644956974627521593']), { platform: 'douyin', authorId: '7644956974627521593', recent: 50, limit: 20 })
  assert.deepEqual(parseArgs(['--platform', 'douyin', '--post-id', '7697057660088752010']), { platform: 'douyin', postId: '7697057660088752010', recent: 50, limit: 20 })
  for (const args of [[], ['--platform', 'douyin'], ['--platform', 'douyin', '--text', 'ab'], ['--platform', 'douyin', '--request-id', 'wrong'], ['--platform', 'douyin', '--author-id', 'a', '--recent', '201'], ['--apply']]) assert.throws(() => parseArgs(args))
  for (const postId of ['not an id', 'x'.repeat(201), "post';SELECT"]) {
    assert.throws(() => parseArgs(['--platform', 'douyin', '--post-id', postId]), /invalid_post_id/)
  }
  assert.throws(() => parseArgs(['--platform', 'douyin', '--post-id', 'a', '--post-id', 'b']), /invalid_arguments/)
  assert.equal(parseArgs(['--help']).help, true)
  const cli = new URL('../../server/ops/diagnose-search-media.mjs', import.meta.url)
  const help = spawnSync(process.execPath, [cli.pathname, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /\[--post-id ID\]/)
  assert.match(help.stdout, /canonical lookup is independent of request ID/)
  const invalid = spawnSync(process.execPath, [cli.pathname, '--platform', 'douyin', '--post-id', 'not an id'], { encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  assert.deepEqual(JSON.parse(invalid.stderr), { error: 'invalid_post_id', stage: 'arguments' })
})

test('database diagnostics use exact delivery identity and linked snapshot with read-only cleanup', async () => {
  const queries = []
  const client = { async query(sql, params) {
    queries.push({ sql, params })
    if (sql.startsWith('SELECT id, created_at') && sql.includes('public.usage_requests')) return { rows: [{ id: ID, created_at: '2026-10-12', captured_at: '2026-10-10', compatibility_snapshot_id: SNAPSHOT }] }
    if (sql.startsWith('SELECT id, created_at') && sql.includes('serving.compatibility_snapshots')) return { rows: [{ id: SNAPSHOT, created_at: '2026-10-11', captured_at: '2026-10-10' }] }
    if (sql.startsWith('SELECT response_body')) return { rows: [{ response_body: { data: { raw_data: JSON.stringify([row()]) } } }] }
    return { rows: [] }
  } }
  const report = await diagnoseSearchMedia(client, { platform: 'douyin', requestId: ID })
  assert.match(queries[0].sql, /READ ONLY$/)
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
  assert.deepEqual(queries.find(query => query.sql.includes('FROM serving.compatibility_snapshots') && query.sql.startsWith('SELECT id')).params, ['douyin', [SNAPSHOT], 50])
  assert.ok(queries.filter(query => query.sql.startsWith('SELECT response_body')).every(query => /8388608/.test(query.sql)))
  assert.ok(!queries.some(query => /INSERT|UPDATE|DELETE|CREATE|FOR UPDATE/.test(query.sql)))
  assert.ok(!queries.some(query => /core\.canonical_records/.test(query.sql)))
  assert.deepEqual(report.results.map(result => result.source), ['committed_delivery', 'compatibility_snapshot'])
  assert.equal(report.results[0].createdAt, '2026-10-12')
  assert.equal(report.results[0].capturedAt, '2026-10-10')
  assert.equal(report.rawProviderArchivesInspected, false)
  assert.equal(report.downstreamSavedCopiesInspected, false)
})

test('author and text selectors are ANDed and canonical evidence is separately identified', async () => {
  const queries = []
  const client = { async query(sql, params) {
    queries.push({ sql, params })
    if (sql.startsWith('SELECT id, created_at') && sql.includes('public.usage_requests')) return { rows: [{ id: ID, created_at: '2026-10-12', compatibility_snapshot_id: SNAPSHOT }] }
    if (sql.startsWith('SELECT response_body')) return { rows: [{ response_body: { data: { raw_data: [row({ author_id: 'other' }), row({ full_text: 'different body' }), row()] } } }] }
    if (sql.startsWith('SELECT id, collected_at')) return { rows: [{ id: ID, collected_at: null, feed_time: '2026-10-10' }] }
    if (sql.startsWith('SELECT id, external_id')) return { rows: [{ id: ID, external_id: 'post-1', author_external_id: 'author-1', body: 'needle', object_type: 'post', content_type: '4', current_revision: 3, dataset_id: 'night-all.compat.v1', stable_fields: { media: { coverUrl: COVER, images: [COVER], videos: [VIDEO] } } }] }
    return { rows: [] }
  } }
  const report = await diagnoseSearchMedia(client, { platform: 'douyin', authorId: 'author-1', text: 'needle', recent: 10 })
  assert.equal(report.results.length, 2)
  assert.equal(report.results[1].source, 'canonical_current')
  assert.equal(report.results[1].revision, 3)
  assert.equal(report.results[0].capturedAt, null)
  assert.equal(report.results[1].collectedAt, null)
  assert.equal(report.results[1].feedTime, '2026-10-10')
  assert.deepEqual(queries.find(query => query.sql.startsWith('SELECT id, collected_at')).params, [['night-all.search.v1', 'night-all.compat.v1'], 'douyin', 'author-1', null, 10])
  assert.match(queries.find(query => query.sql.startsWith('SELECT id, collected_at')).sql, /ORDER BY coalesce\(event_time, collected_at, last_seen_at, first_seen_at\) DESC, id DESC/)
  const snapshotQuery = queries.find(query => query.sql.includes('FROM serving.compatibility_snapshots') && query.sql.startsWith('SELECT id'))
  assert.deepEqual(snapshotQuery.params, ['douyin', [SNAPSHOT], 10])
  assert.match(snapshotQuery.sql, /id=ANY\(\$2::uuid\[\]\)/)
  assert.doesNotMatch(snapshotQuery.sql, /ORDER BY captured_at/)
  assert.match(report.scope, /zero matches does not prove absence/)
})

test('post ID intersects author/text filters and request ID does not suppress an independent canonical lookup', async () => {
  const queries = []
  const client = { async query(sql, params) {
    queries.push({ sql, params })
    if (sql.startsWith('SELECT id, created_at') && sql.includes('public.usage_requests')) return { rows: [{ id: ID }] }
    if (sql.startsWith('SELECT response_body')) return { rows: [{ response_body: { data: { raw_data: [
      row({ content_id: 'other-post' }), row({ author_id: 'other-author' }), row({ full_text: 'other text' }), row(),
    ], items: [{ externalId: 'post-1', author: { id: 'author-1' }, text: 'needle', media: { images: [], videos: [] } }] } } }] }
    if (sql.startsWith('SELECT id, collected_at')) return { rows: [{ id: ID }] }
    if (sql.startsWith('SELECT id, external_id')) return { rows: [{ id: ID, external_id: 'post-1', author_external_id: 'author-1',
      body: 'needle', object_type: 'post', content_type: '4', dataset_id: 'night-all.search.v1', stable_fields: { media: {} } }] }
    return { rows: [] }
  } }
  const report = await diagnoseSearchMedia(client, { platform: 'douyin', postId: 'post-1', authorId: 'author-1', text: 'needle', requestId: ID, recent: 7 })
  assert.deepEqual(report.results.map(result => [result.source, result.postExternalId]), [
    ['committed_delivery', 'post-1'], ['committed_delivery', 'post-1'], ['canonical_current', 'post-1'],
  ])
  assert.equal(report.postId, 'post-1')
  assert.deepEqual(queries.find(query => query.sql.includes('FROM public.usage_requests') && query.sql.startsWith('SELECT id')).params, ['douyin', ID, 7])
  const canonical = queries.find(query => query.sql.startsWith('SELECT id, collected_at'))
  assert.deepEqual(canonical.params, [['night-all.search.v1', 'night-all.compat.v1'], 'douyin', 'author-1', 'post-1', 7])
  assert.match(canonical.sql, /\(\$4::text IS NULL OR external_id=\$4\)/)
  assert.doesNotMatch(canonical.sql, /post-1/)
  assert.equal(report.sources.at(-1).selection, 'exact_external_id_within_search_datasets')
  assert.deepEqual(report.sources.at(-1).datasetIds, ['night-all.search.v1', 'night-all.compat.v1'])
})

test('actual PostgreSQL post lookup filters before the canonical limit while deliveries remain bounded and read-only', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA serving; CREATE SCHEMA core;
    CREATE TABLE public.usage_requests(id uuid PRIMARY KEY, created_at timestamptz, response_captured_at timestamptz,
      compatibility_snapshot_id uuid, platform text, status text, response_status int, response_body jsonb);
    CREATE TABLE serving.compatibility_snapshots(id uuid PRIMARY KEY, created_at timestamptz, captured_at timestamptz, platform text, response_body jsonb);
    CREATE TABLE core.canonical_records(id uuid PRIMARY KEY, collected_at timestamptz, event_time timestamptz,
      last_seen_at timestamptz, first_seen_at timestamptz, dataset_id text, platform text, object_type text,
      deleted_at timestamptz, author_external_id text, external_id text, content_type text, title text, body text,
      stable_fields jsonb, current_revision int);`)
  const recentId = randomUUID(), canonicalId = randomUUID(), postId = '7697057660088752010'
  const stored = { data: { raw_data: [row({ content_id: postId })] } }
  await db.query(`INSERT INTO public.usage_requests VALUES ($1,'2026-10-01',NULL,NULL,'douyin','committed',200,$2),
    ($3,'2026-10-16',NULL,NULL,'douyin','committed',200,$4)`, [ID, stored, recentId, { data: { raw_data: [row({ content_id: 'other-post' })] } }])
  const canonical = { id: canonicalId, externalId: postId, dataset: 'night-all.search.v1', platform: 'douyin', type: 'post',
    deleted: null, collected: '2026-10-01', author: 'author-1' }
  for (const candidate of [canonical, ...[
    { externalId: 'other-post' }, { platform: 'reddit' }, { dataset: 'other.dataset' }, { type: 'profile' },
    { deleted: '2026-10-16' },
  ].map(overrides => ({ ...canonical, id: randomUUID(), collected: '2026-10-16', ...overrides }))]) {
    await db.query(`INSERT INTO core.canonical_records(id,external_id,dataset_id,platform,object_type,deleted_at,collected_at,author_external_id,body,stable_fields,current_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'needle',$9,1)`, [candidate.id, candidate.externalId, candidate.dataset, candidate.platform,
      candidate.type, candidate.deleted, candidate.collected, candidate.author, { media: { coverUrl: COVER, images: [], videos: [VIDEO] } }])
  }
  const queries = [], client = { async query(sql, params) {
    queries.push({ sql, params })
    if (sql.startsWith('SELECT')) assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
    return db.query(sql, params)
  } }
  const options = { platform: 'douyin', postId, recent: 1 }
  const report = await diagnoseSearchMedia(client, options)
  assert.deepEqual(report.results.map(result => [result.source, result.sourceId]), [['canonical_current', canonicalId]])
  assert.equal(report.sources[0].selected, 1)
  assert.equal(report.sources[0].matched, 0)
  assert.match(report.scope, /zero matches does not prove absence/)
  const exact = await diagnoseSearchMedia(client, { ...options, requestId: ID, authorId: 'author-1', text: 'needle' })
  assert.deepEqual(exact.results.map(result => result.source), ['committed_delivery', 'canonical_current'])
  for (const filters of [{ authorId: 'other-author' }, { text: 'not present' }, { postId: 'missing-post' }]) {
    assert.equal((await diagnoseSearchMedia(client, { ...options, requestId: ID, ...filters })).results.length, 0)
  }
  assert.ok(!queries.some(({ sql }) => /INSERT|UPDATE|DELETE|CREATE|FOR UPDATE/.test(sql)))
  assert.equal((await db.query('SELECT count(*)::int AS count FROM core.canonical_records')).rows[0].count, 6)
})

test('diagnostics roll back on query failures without attempting any fallback query', async () => {
  const queries = []
  const client = { async query(sql) {
    queries.push(sql)
    if (sql.startsWith('SELECT')) throw new Error('private connection diagnostic')
    return { rows: [] }
  } }
  await assert.rejects(() => diagnoseSearchMedia(client, { platform: 'reddit', authorId: 't2_15nmkah' }), error => {
    assert.equal(error.diagnosticStage, 'select_deliveries')
    assert.deepEqual(diagnosticErrorReport(error), { error: 'diagnostic_read_failed', stage: 'select_deliveries' })
    return true
  })
  assert.equal(queries.at(-1), 'ROLLBACK')
  assert.equal(queries.filter(sql => sql.startsWith('SELECT')).length, 1)
})

test('failure summaries expose only bounded stages and allowlisted SQLSTATE categories', () => {
  for (const [code, reason] of [['57014', 'query_timeout_or_cancelled'], ['42501', 'insufficient_privilege'], ['42703', 'missing_column']]) {
    const error = Object.assign(new Error('postgres://private-user:private-password@private-host/private-db'), { code, diagnosticStage: 'read_canonical' })
    assert.deepEqual(diagnosticErrorReport(error), { error: 'diagnostic_read_failed', stage: 'read_canonical', sqlState: code, reason })
  }
  const report = diagnosticErrorReport({ message: 'private-message', code: 'private-code', diagnosticStage: 'private-stage' }, 'database_connection')
  assert.deepEqual(report, { error: 'diagnostic_read_failed', stage: 'database_connection' })
})
