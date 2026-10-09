import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { weiboRow, mergeWeiboDetail, rawSearchRecords } from '../../server/contracts/raw-search.mjs'
import { retainWeiboFullText } from '../../server/ingest/weibo-body.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const post = '5351931117044493', author = '7851053384'
const t0 = '2026-10-09T03:00:00.000Z', t1 = '2026-10-09T03:01:00.000Z', t2 = '2026-10-09T03:02:00.000Z'
function mapped(summary, full, capturedAt, authorId = author) {
  const row = weiboRow({ weibo_id: post, user_id: authorId, content: summary }, capturedAt)
  if (full != null) assert.equal(mergeWeiboDetail(row, { publicBody: { data: {
    idstr: post, user: { idstr: authorId }, longText: { content: full }, isLongText: true,
  }, meta: { capturedAt } } }), true)
  return rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify([row]) } }, 'weibo', 'tikhub')[0]
}
function current(record) {
  return { body: record.body, extensions: record.extensions, author_external_id: record.authorExternalId,
    collected_at: record.collectedAt, deleted_at: record.deletedAt, current_revision: 1, payload_sha256: record.payloadSha256 }
}

test('summary and detail freshness are independent, raw observation is immutable and edits can be shorter', () => {
  const first = mapped('旧摘要 展开c', '这是独立的完整正文[任意表情]。', t0)
  const preview = mapped('新版摘要与旧全文无前缀关系 展开c', null, t2)
  const raw = structuredClone(preview.rawItem), rawHash = preview.rawPayloadSha256
  const payload = retainWeiboFullText(preview, current(first))
  assert.equal(preview.body, first.body)
  assert.equal(payload.summary, raw.summary)
  assert.equal(payload.full_text, first.body)
  assert.equal(preview.extensions.weiboBody.provenance.fullText.capturedAt, t0)
  assert.deepEqual(preview.rawItem, raw)
  assert.equal(preview.rawPayloadSha256, rawHash)
  const edit = mapped('更早采集的摘要 展开c', '短编辑…', t1)
  retainWeiboFullText(edit, current(preview))
  assert.equal(edit.body, '短编辑…')
  assert.equal(edit.extensions.weiboBody.summary, raw.summary)
  assert.equal(edit.extensions.weiboBody.provenance.summary.capturedAt, t2)
  const delayed = mapped('旧摘要 展开c', '已过期的完整正文', t0)
  retainWeiboFullText(delayed, current(edit))
  assert.equal(delayed.body, '短编辑…')
  assert.equal(delayed.extensions.weiboBody.summary, raw.summary)
  const otherAuthor = mapped('另一作者 展开c', null, t2, '999')
  retainWeiboFullText(otherAuthor, current(edit))
  assert.equal(otherAuthor.body, '另一作者 展开c')
  const deletion = mapped('', null, t2)
  deletion.deletedAt = new Date(t2)
  retainWeiboFullText(deletion, current(edit))
  assert.equal(deletion.body, null)
  const legacy = mapped('新展示格式的摘要 展开c', null, t2)
  const legacyState = { ...current(first), extensions: { weiboLongTextRepair: {
    migration: '131_weibo_long_text_and_lcy_grants.sql', capturedAt: t0,
  } } }
  retainWeiboFullText(legacy, legacyState)
  assert.equal(legacy.body, first.body)
  assert.equal(legacy.extensions.weiboBody.provenance.fullText.source, 'legacy_verified')
  assert.equal(legacy.extensions.weiboBody.provenance.fullText.payloadSha256, first.payloadSha256)
  const earlierShort = mapped('完整短帖', null, t0)
  const latestPreview = mapped('新编辑的截断摘要 展开c', null, t2)
  retainWeiboFullText(earlierShort, current(latestPreview))
  assert.equal(earlierShort.body, latestPreview.body)
  assert.equal(earlierShort.extensions.rawSearch.bodyCompleteness, 'provider_preview')
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('actual migrations and ingest preserve independent text, hashes, source history and rolling-worker protection', {
  skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to local PGlite',
}, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const { pg_trgm } = await import(new URL('./contrib/pg_trgm.js', pathToFileURL(modulePath)))
  const db = new PGlite({ extensions: { pg_trgm } })
  t.after(() => db.close())
  for (const directory of [new URL('../../../mx-common/migrations/', import.meta.url), new URL('../../migrations/', import.meta.url)]) {
    for (const file of (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()) {
      await db.exec('BEGIN')
      await db.exec(await readFile(new URL(file, directory), 'utf8'))
      await db.exec('COMMIT')
    }
  }
  const query = async (sql, values) => {
    const result = await db.query(sql, values)
    return { ...result, rowCount: result.rows.length || result.affectedRows }
  }
  const store = new PostgresStore({ query, connect: async () => ({ query, release() {} }) })
  const ingest = async record => {
    // The worker rehydrates these timestamps after reading its JSON queue.
    record.collectedAt = new Date(record.collectedAt)
    return store.ingestExternalRecords({ datasetId: 'night-all.search.v1', platform: 'weibo',
      records: [record], importRunId: null, connectorId: 'external-platform:tikhub' })
  }
  const saved = async () => (await db.query("SELECT * FROM core.canonical_records WHERE platform='weibo' AND external_id=$1", [post])).rows[0]
  const first = mapped('搜索摘要 展开c', '最初的较长完整正文[兔子]。', t0)
  await ingest(first)
  assert.equal((await saved()).body, first.body)
  const search = mapped('编辑后的搜索摘要[其他表情] 展开c', null, t2)
  const acquired = structuredClone(search.rawItem)
  await ingest(search)
  let row = await saved()
  assert.equal(row.body, first.body)
  assert.equal(row.extensions.weiboBody.summary, acquired.summary)
  assert.equal(row.current_revision, 2)
  const snapshot = (await db.query('SELECT * FROM core.record_revisions WHERE record_id=$1 AND revision=2', [row.id])).rows[0]
  assert.equal(snapshot.payload_sha256, row.payload_sha256)
  assert.equal(snapshot.normalized_payload.full_text, first.body)
  const raw = (await db.query('SELECT raw_payload FROM ingest.source_objects WHERE source_key=$1', [post])).rows[0].raw_payload
  assert.deepEqual(raw, acquired, 'raw receipt stays a summary even when canonical retains earlier full text')
  const edit = mapped('旧摘要 展开c', '短编辑…', t1)
  await ingest(edit)
  row = await saved()
  assert.equal(row.body, '短编辑…')
  assert.equal(row.extensions.weiboBody.summary, acquired.summary)
  assert.equal(row.current_revision, 3)
  const older = mapped('旧摘要 展开c', '迟到的旧版全文', t0)
  await ingest(older)
  row = await saved()
  assert.equal(row.body, '短编辑…')
  assert.equal(row.extensions.weiboBody.provenance.fullText.capturedAt, t1)
  // Repeating identical observations does not churn revisions/outbox.
  const revision = row.current_revision
  await ingest(mapped('旧摘要 展开c', '迟到的旧版全文', t0))
  assert.equal((await saved()).current_revision, revision)
  const beforeLegacy = await saved()
  await db.query(`UPDATE core.canonical_records SET body='完全不同的摘要 展开c',
    extensions='{"body_completeness":"provider_preview"}',payload_sha256=repeat('0',64),
    current_revision=current_revision+1,projection_revision=projection_revision+1 WHERE id=$1`, [row.id])
  row = await saved()
  assert.equal(row.body, beforeLegacy.body)
  assert.equal(row.current_revision, beforeLegacy.current_revision)
  assert.equal(row.payload_sha256, beforeLegacy.payload_sha256)
  assert.deepEqual(row.extensions, beforeLegacy.extensions)
  // A genuine newer verified edit passes despite a matching shorter prefix.
  await ingest(mapped('摘要 展开c', '短…', '2026-10-09T03:03:00.000Z'))
  row = await saved()
  assert.equal(row.body, '短…')
  const latest = (await db.query('SELECT * FROM core.record_revisions WHERE record_id=$1 AND revision=$2', [row.id, row.current_revision])).rows[0]
  assert.equal(latest.payload_sha256, row.payload_sha256)
  assert.equal(latest.normalized_payload.text, '短…')
  const contentRevision = row.current_revision
  await ingest(mapped('摘要 展开c', '短…', '2026-10-09T03:04:00.000Z'))
  row = await saved()
  assert.equal(row.current_revision, contentRevision, 'capture time alone is not a content revision')
  assert.equal(row.extensions.weiboBody.provenance.fullText.capturedAt, '2026-10-09T03:04:00.000Z')
  const events = (await db.query('SELECT projection_revision FROM outbox.projection_events WHERE aggregate_id=$1 ORDER BY projection_revision', [row.id])).rows
  assert.equal(Number(events.at(-1).projection_revision), Number(row.projection_revision))
  // Migration 131's original repair predates rawSearch metadata. The rollout
  // guard still protects that exact evidence-backed identity from legacy jobs.
  await db.query(`INSERT INTO core.canonical_records(id,dataset_id,platform,object_type,external_id,
    schema_version,payload_sha256,body,author_external_id,extensions)
    VALUES('34c72b79-f291-4ef7-ad9b-fe62eb03912d','night-all.search.v1','weibo','post',
    '5351726865449966','external.v1',repeat('1',64),'历史已验证全文','2471317784',$1)`,
  [{ weiboLongTextRepair: { migration: '131_weibo_long_text_and_lcy_grants.sql',
    responseSha256: 'b05ecd61c51bb3e51a1fa464e0ffd78e41c10c0b47363a5b07806bee003444dc', capturedAt: t0 } }])
  const guarded = (await db.query(`UPDATE core.canonical_records SET body='不同的摘要 展开c',
    extensions='{"body_completeness":"provider_preview"}'
    WHERE id='34c72b79-f291-4ef7-ad9b-fe62eb03912d' RETURNING body`)).rows[0]
  assert.equal(guarded.body, '历史已验证全文')
})
