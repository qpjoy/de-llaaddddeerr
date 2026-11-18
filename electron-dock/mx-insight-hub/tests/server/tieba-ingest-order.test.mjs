import assert from 'node:assert/strict'
import test from 'node:test'
import { createTiebaPostgresFixture } from '../helpers/tieba-postgres.mjs'
import { normalizeTiebaIngestion } from '../../server/ingest/tieba.mjs'

const payload = (text, capturedAt, runId = 1) => ({ kind: 'tieba-post-search-result', version: 1,
  input: { query: '测试', maxResults: 1, page: 1, maxPages: 1 }, taskId: runId, runId, capturedAt,
  items: [{ record_type: 'tieba.thread', source_id: '123', source_url: 'https://tieba.baidu.com/p/123',
    title: '帖子标题', text, author: { id: '5', name: '作者' }, published_at: null,
    metrics: { replies: 1 }, media: [], attributes: { query: '测试', page: 1 }, raw: { original: text } }] })

test('actual migrations: delayed Tieba cleaning preserves newer current data and all distinct raw evidence', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL SQL',
}, async t => {
  const { pool, store } = await createTiebaPostgresFixture(t)
  const ingest = value => store.ingestExternalRecords({ datasetId: 'tieba.posts.v1', platform: 'tieba',
    connectorId: 'collect:tieba-post-search', importRunId: null, records: normalizeTiebaIngestion(value) })
  const newer = payload('较新的摘要', '2026-11-18T02:00:00.000Z', 2)
  const older = payload('迟到的旧摘要', '2026-11-18T01:00:00.000Z', 1)
  older.items[0].published_at = '2026-11-18T03:00:00.000Z' // publication time cannot establish observation ordering
  const state = async () => ({
    canonical: (await pool.query("SELECT body,collected_at,current_revision,projection_revision FROM core.canonical_records WHERE dataset_id='tieba.posts.v1' AND external_id='123'")).rows[0],
    source: (await pool.query("SELECT raw_payload,source_updated_at,current_revision FROM ingest.source_objects WHERE connector_id='collect:tieba-post-search' AND source_key='123'")).rows[0],
    history: (await pool.query("SELECT revision,raw_payload FROM ingest.source_object_revisions ORDER BY revision")).rows,
    outbox: (await pool.query('SELECT count(*)::int AS n FROM outbox.projection_events')).rows[0].n,
  })
  assert.equal((await ingest(newer)).changed, 1)
  const before = await state()
  assert.equal((await ingest(older)).changed, 0)
  const after = await state()
  assert.deepEqual(after.canonical, before.canonical)
  assert.deepEqual(after.source, before.source)
  assert.equal(after.outbox, before.outbox)
  assert.equal(after.history.length, 2)
  assert.deepEqual(after.history.map(row => row.raw_payload.item.text), ['较新的摘要', '迟到的旧摘要'])
  await ingest(older)
  assert.equal((await state()).history.length, 2, 'retrying the same stale evidence does not create another revision')
  await ingest(newer)
  assert.equal((await state()).source.current_revision, 1, 'same current payload must not point to an archived stale revision')
  assert.equal((await state()).outbox, before.outbox)

  const latest = payload('最新摘要', '2026-11-18T04:00:00.000Z', 3)
  assert.equal((await ingest(latest)).changed, 1)
  const final = await state()
  assert.equal(final.canonical.body, '最新摘要')
  assert.equal(final.canonical.current_revision, 2)
  assert.equal(final.source.current_revision, 3, 'new source revision skips the retained stale evidence number')
  assert.equal(final.history.length, 3)
  assert.equal(final.outbox, before.outbox + 1)
})
