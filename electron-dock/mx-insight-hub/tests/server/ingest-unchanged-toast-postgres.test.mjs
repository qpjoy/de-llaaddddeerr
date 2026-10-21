// A re-sighted item used to rewrite its raw and canonical TOAST columns on
// every upsert even when nothing changed, costing about twice the value in
// WAL. These cases prove an unchanged sighting now keeps the stored TOAST
// chunks, while a changed value is still replaced and still revised.

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { normalizeNightAllLegacyPayload } from '../../server/ingest/legacy-night-all.mjs'
import { normalizeSearchPayload } from '../../server/ingest/normalizers.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: connectionString ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL' }

// A random 4-letter sequence compresses poorly, so each value is stored out of
// line, yet it has few distinct trigrams. Every canonical upsert is a non-HOT
// update (last_seen_at is indexed) and re-inserts the body's trigrams into
// canonical_records_body_trgm_idx; ordinary text would make that GIN cost
// swamp the TOAST WAL this test measures.
const bulky = () => Array.from(randomBytes(24_000), (byte) => 'acgt'[byte & 3]).join('')

function legacyPayload(ids, texts) {
  const rows = ids.map((id, index) => ({
    content_id: id, platform_name: 'douyin', content_type: 'video', title: `标题 ${index}`,
    text: texts[index], full_text: texts[index], author_id: `author-${index}`, author_name: '作者',
    published_at: 1791511200, collected_at: 1791511210,
  }))
  return { data: { raw_info: '[]', raw_data: JSON.stringify(rows),
    page: { page: 1, pageSize: 20, returnedCount: rows.length, hasMore: false, nextCursor: null },
    meta: { resultCount: rows.length } } }
}

function modernPayload(ids, texts) {
  const items = ids.map((id, index) => ({
    id: `douyin:${id}`, externalId: id, platform: 'douyin', contentType: 'video',
    url: `https://www.douyin.com/video/${index + 1}`, title: `标题 ${index}`, text: texts[index],
    publishedAt: '2026-10-09T02:00:00.000Z', collectedAt: '2026-10-09T02:00:10.000Z',
    author: { id: `author-${index}`, name: '作者', avatarUrl: null },
    metrics: { likes: 3, comments: 0, shares: 0, views: null, bookmarks: null },
    media: { coverUrl: null, images: [], videos: [] }, source: { provider: null, endpointId: null },
  }))
  return { data: { contractVersion: 'night-all.data-search.v1', platform: 'douyin', query: '汽车', items,
    pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: items.length, hasMore: false, nextCursor: null, cursorType: 'none' },
    status: 'ok', warnings: [], meta: { providerCalls: 1 } } }
}

const paths = {
  // ingestExternalRecords: external-platform results, Night-All compat and imports.
  external: {
    payload: legacyPayload,
    externalIds: (payload) => normalizeNightAllLegacyPayload(payload, 'douyin', 'raw').records.map((record) => record.externalId),
    ingest: (store, payload) => store.ingestExternalRecords({
      datasetId: 'night-all.compat.v1', platform: 'douyin', connectorId: 'night-all-legacy', importRunId: null,
      records: normalizeNightAllLegacyPayload(payload, 'douyin', 'raw').records,
    }),
  },
  // ingestSearchResult: queued `search-result` jobs.
  search: {
    payload: modernPayload,
    externalIds: (payload) => normalizeSearchPayload(payload, 'douyin').records.map((record) => record.externalId),
    ingest: (store, payload) => store.ingestSearchResult({ platform: 'douyin', rawPayload: payload }),
  },
}

async function stored(pool, externalIds) {
  const { rows } = await pool.query(
    `SELECT source.source_key AS external_id,
            pg_column_toast_chunk_id(source.raw_payload) AS raw_chunk,
            pg_column_size(source.raw_payload) AS raw_bytes,
            source.current_revision AS source_revision,
            pg_column_toast_chunk_id(canonical.body) AS body_chunk,
            pg_column_size(canonical.body) AS body_bytes,
            pg_column_toast_chunk_id(canonical.stable_fields) AS stable_chunk,
            pg_column_toast_chunk_id(canonical.extensions) AS extensions_chunk,
            canonical.body, canonical.current_revision, canonical.last_seen_at,
            (SELECT count(*)::int FROM core.record_revisions revision WHERE revision.record_id = canonical.id) AS revisions
       FROM ingest.source_objects source
       JOIN core.canonical_records canonical
         ON canonical.platform = 'douyin' AND canonical.external_id = source.source_key
      WHERE source.source_key = ANY($1::text[])
      ORDER BY source.source_key`,
    [externalIds],
  )
  return new Map(rows.map((row) => [row.external_id, row]))
}

const walPosition = async (pool) => (await pool.query('SELECT pg_current_wal_lsn() AS lsn')).rows[0].lsn
const walSince = async (pool, lsn) => Number((await pool.query(
  'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1)::bigint AS bytes', [lsn],
)).rows[0].bytes)

for (const [name, path] of Object.entries(paths)) {
  test(`${name} ingest keeps unchanged TOAST values and still replaces and revises changed ones`, native, async (t) => {
    const pool = new pg.Pool({ connectionString, statement_timeout: 15_000 })
    t.after(() => pool.end())
    const toastChunks = (await pool.query("SELECT to_regproc('pg_column_toast_chunk_id') IS NOT NULL AS available")).rows[0].available
    if (!toastChunks) return t.skip('pg_column_toast_chunk_id needs PostgreSQL 17')
    const store = new PostgresStore(pool)
    const ids = Array.from({ length: 8 }, () => `toast-${randomUUID()}`)
    const texts = ids.map(bulky)
    const first = path.payload(ids, texts)
    const externalIds = path.externalIds(first)
    assert.equal(externalIds.length, ids.length)

    assert.equal((await path.ingest(store, first)).changed, ids.length)
    const before = await stored(pool, externalIds)
    assert.equal(before.size, ids.length)
    for (const row of before.values()) {
      assert.ok(row.raw_chunk, 'raw payload is stored out of line')
      assert.ok(row.body_chunk, 'canonical body is stored out of line')
    }
    const storedBytes = [...before.values()].reduce((sum, row) => sum + row.raw_bytes + row.body_bytes, 0)

    // The same sighting again: no new TOAST copy, revisions untouched.
    const lsn = await walPosition(pool)
    assert.equal((await path.ingest(store, path.payload(ids, texts))).changed, 0)
    const unchangedWal = await walSince(pool, lsn)
    const after = await stored(pool, externalIds)
    for (const [externalId, row] of after) {
      const old = before.get(externalId)
      assert.equal(row.raw_chunk, old.raw_chunk, 'unchanged raw payload keeps its TOAST chunk')
      assert.equal(row.body_chunk, old.body_chunk, 'unchanged body keeps its TOAST chunk')
      assert.equal(row.stable_chunk, old.stable_chunk)
      assert.equal(row.extensions_chunk, old.extensions_chunk)
      assert.equal(row.source_revision, old.source_revision)
      assert.equal(row.current_revision, old.current_revision)
      assert.equal(row.revisions, old.revisions)
      assert.ok(row.last_seen_at >= old.last_seen_at, 'the sighting itself is still recorded')
    }
    // Rewriting would log at least the stored bytes again; reuse logs only
    // tuple versions, index entries and the run row.
    assert.ok(unchangedWal < storedBytes / 4,
      `unchanged sighting wrote ${unchangedWal} WAL bytes for ${storedBytes} stored bytes`)

    // One changed item: replaced and revised; the rest keep their chunks.
    const changedTexts = [bulky(), ...texts.slice(1)]
    const changed = path.payload(ids, changedTexts)
    assert.equal((await path.ingest(store, changed)).changed, 1)
    const revised = await stored(pool, externalIds)
    const target = revised.get(externalIds[0])
    const previous = after.get(externalIds[0])
    assert.notEqual(target.raw_chunk, previous.raw_chunk, 'a changed raw payload is rewritten')
    assert.notEqual(target.body_chunk, previous.body_chunk, 'a changed body is rewritten')
    assert.ok(target.body.includes(changedTexts[0]), 'the new body is stored')
    assert.equal(target.current_revision, previous.current_revision + 1)
    assert.equal(target.revisions, previous.revisions + 1)
    for (const externalId of externalIds.slice(1)) {
      assert.equal(revised.get(externalId).raw_chunk, after.get(externalId).raw_chunk)
      assert.equal(revised.get(externalId).body_chunk, after.get(externalId).body_chunk)
      assert.equal(revised.get(externalId).current_revision, after.get(externalId).current_revision)
    }
  })
}
