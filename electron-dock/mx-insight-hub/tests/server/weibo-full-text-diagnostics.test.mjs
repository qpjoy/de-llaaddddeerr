import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { weiboRow } from '../../server/contracts/raw-search.mjs'
import { inspectWeiboFullText, diagnoseWeiboFullText } from '../../server/ops/diagnose-weibo-full-text.mjs'

const capturedAt = '2026-10-08T13:02:09.696Z'
const post = { weibo_id: '5349464142003762', content: 'private-post beginning 展开c', user_url: 'https://weibo.com/u/7742161132' }
const row = weiboRow(post, capturedAt)
const full = 'private-post beginning with the complete verified continuation and ending'
const detail = { idstr: post.weibo_id, user: { idstr: row.author_id }, text_raw: full, longText: { content: full }, text: post.content }
const fingerprint = id => createHash('sha256').update(JSON.stringify({ version: 'weibo-full-text.v1', id })).digest('hex')
function archive(data, code = 200) {
  const bytes = Buffer.from(JSON.stringify({ code, token: 'private-token-echo', data }))
  return { body_bytes: bytes, body_size: bytes.length, body_sha256: createHash('sha256').update(bytes).digest('hex'), captured_at: capturedAt }
}

test('full-text diagnostics identify merge rejection branches without exposing body or credentials', () => {
  const before = structuredClone(row)
  assert.equal(inspectWeiboFullText(row, archive(detail)).state, 'current_merge_accepts')
  for (const [data, expected] of [
    [{ ...detail, longText: null, text_raw: null }, 'full_text_missing'],
    [{ ...detail, longText: { content: post.content } }, 'full_text_not_longer'],
    [{ ...detail, longText: { content: full + ' 展开c' } }, 'full_text_still_preview'],
    [{ ...detail, longText: { content: 'different-prefix ' + full } }, 'prefix_mismatch'],
    [{ ...detail, idstr: '999' }, 'post_id_mismatch'],
    [{ ...detail, user: { idstr: '999' } }, 'author_id_mismatch'],
    [{ nested: detail }, 'invalid_detail_identity'],
  ]) {
    const result = inspectWeiboFullText(row, archive(data))
    assert.equal(result.state, 'current_merge_rejects')
    assert.ok(result.reasons.includes(expected), JSON.stringify(result))
    assert.doesNotMatch(JSON.stringify(result), /private-|different-prefix/)
  }
  assert.deepEqual(row, before)
  const response = archive(detail)
  const bytes = Buffer.from(response.body_bytes)
  inspectWeiboFullText(row, response)
  assert.deepEqual(response.body_bytes, bytes)
})

test('missing, oversized, corrupt, non-JSON and unsuccessful archives cannot prove a merge failure', () => {
  assert.equal(inspectWeiboFullText(row, null).state, 'archive_missing')
  assert.equal(inspectWeiboFullText(row, { body_size: 8388609 }).state, 'archive_too_large')
  const corrupt = { ...archive(detail), body_bytes: Buffer.from('changed') }
  assert.equal(inspectWeiboFullText(row, corrupt).state, 'archive_integrity_failed')
  const invalid = { ...archive(detail), body_bytes: Buffer.from('not-json') }
  invalid.body_sha256 = createHash('sha256').update(invalid.body_bytes).digest('hex')
  assert.equal(inspectWeiboFullText(row, invalid).state, 'archive_not_json')
  assert.equal(inspectWeiboFullText(row, archive(null, 429)).state, 'not_success_envelope')
})

test('opt-in text diff keeps the original mismatch visible while reporting the deployed comparison rule', () => {
  const preview = weiboRow({ ...post, content: '话题超话内容开头 展开c' }, capturedAt)
  const source = archive({ ...detail, longText: { content: '#话题[超话]#内容开头以及后续完整正文' },
    text: '<a href="https://example.test/private-token">话题超话</a>内容开头以及后续完整正文' })
  const ordinary = inspectWeiboFullText(preview, source)
  assert.equal(ordinary.textComparison, undefined)
  const comparison = inspectWeiboFullText(preview, source, { textDiff: true })
  assert.equal(comparison.state, 'current_merge_accepts')
  assert.deepEqual(comparison.prefixComparison, { policy: 'weibo_display_v1', matches: true })
  assert.equal(comparison.textComparison.fullText.prefixMatches, false)
  assert.equal(comparison.textComparison.fullText.previewCodePoint, 'U+E627')
  assert.equal(comparison.textComparison.fullText.detailCodePoint, 'U+0023')
  assert.equal(comparison.textComparison.renderedText.prefixMatches, true)
  assert.doesNotMatch(JSON.stringify(comparison), /private-token|https:|<a /)
  const long = inspectWeiboFullText(weiboRow({ ...post, content: 'x'.repeat(300) + '…' }, capturedAt),
    archive({ ...detail, longText: { content: 'x'.repeat(200) + 'y'.repeat(400) } }), { textDiff: true })
  assert.equal(long.textComparison.fullText.commonPrefixCodePoints, 200)
  assert.equal(long.textComparison.fullText.previewExcerpt.length, 64)
  assert.equal(long.textComparison.fullText.detailExcerpt.length, 64)
})

test('stdin entry loads the existing runtime imports without requiring a new image', async () => {
  const source = (await readFile(new URL('../../server/ops/diagnose-weibo-full-text.mjs', import.meta.url), 'utf8'))
    .replace("from 'pg'", `from '${import.meta.resolve('pg')}'`)
    .replaceAll("from '../contracts/", `from '${new URL('../../server/contracts/', import.meta.url).href}`)
    .replace('import.meta.url === pathToFileURL(process.argv[1]).href', "process.argv[1] === '-'")
  const env = { ...process.env }
  delete env.DATABASE_URL
  const child = spawnSync(process.execPath, ['--input-type=module', '-', '34bc80a6-a208-49f8-b260-6c7985b36139'],
    { input: source, encoding: 'utf8', env })
  assert.equal(child.status, 1)
  assert.deepEqual(JSON.parse(child.stderr), { error: 'database_url_required' })
})

const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('database diagnosis correlates receipts by dispatch fingerprint in a read-only transaction', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,platform text,status text,reserved_at timestamptz,
      completed_at timestamptz,acquisition_request jsonb,response_body jsonb);
    CREATE TABLE external_platform.provider_calls(id uuid,usage_request_id uuid,provider_key text,operation text,
      endpoint_key text,contract_version text,call_ordinal int,dispatch_fingerprint text,outcome text,
      http_status int,business_code int,error_code text,billed boolean,upstream_request_id text,completed_at timestamptz);
    CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid,body_bytes bytea,
      body_sha256 text,body_size int,captured_at timestamptz);`)
  const target = '34bc80a6-a208-49f8-b260-6c7985b36139'
  const searchId = '00000000-0000-4000-8000-000000000001'
  const detailId = '00000000-0000-4000-8000-000000000002'
  const failedId = '00000000-0000-4000-8000-000000000003'
  await db.query(`INSERT INTO usage_requests VALUES($1,'weibo','committed',$2,$2,$3,$4)`,
    [target, capturedAt, { path: '/api/v1/data/search' }, { data: { status: 'partial' } }])
  const secondPost = { ...post, weibo_id: '5349464142003763' }
  const skippedPost = { ...post, weibo_id: '5349464142003764' }
  for (const [id, ordinal, operation, dispatch, outcome, payload] of [
    [searchId, 1, 'native.t.weibo_web_v2_fetch_realtime_search', null, 'succeeded', { parsed_data: { results: [post, secondPost, skippedPost] } }],
    // Ordinal order deliberately differs from search order.
    [failedId, 2, 'native.t.api_4f35621a9c07e539', fingerprint(secondPost.weibo_id), 'rejected', null],
    [detailId, 3, 'native.t.api_4f35621a9c07e539', fingerprint(post.weibo_id), 'succeeded', { ...detail, longText: null, text_raw: null }],
  ]) {
    await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,'tikhub',$3,$3,
      'mx-insight-hub.native-forwarding.v1',$4,$5,$6,200,200,'private-error',true,'private-request-id',$7)`,
    [id, target, operation, ordinal, dispatch, outcome, capturedAt])
    if (payload) {
      const a = archive(payload)
      await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4,$5)`,
        [id, a.body_bytes, a.body_sha256, a.body_size, capturedAt])
    }
  }
  const statements = []
  const pool = { async connect() { return { release() {}, query(sql, args) { statements.push(sql); return db.query(sql, args) } } } }
  const report = await diagnoseWeiboFullText(pool, target)
  assert.match(statements[0], /READ ONLY$/)
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(report.responseStatus, 'partial')
  assert.equal(report.search.resultCount, 3)
  assert.equal(report.details[0].validation.state, 'detail_call_not_successful')
  assert.deepEqual(report.details[0].matchedPostIds, [secondPost.weibo_id])
  assert.deepEqual(report.details[1].validation[0].reasons, ['full_text_missing'])
  assert.equal(report.details[1].validation[0].rowIndex, 0)
  assert.equal(report.previews[2].detailEvidence, 'no_correlated_call_recorded')
  assert.doesNotMatch(JSON.stringify(report), /private-/)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM external_platform.provider_calls')).rows[0].count, 3)
})
