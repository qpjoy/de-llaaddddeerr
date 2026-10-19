import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { PostgresExternalPlatformStore } from '../../server/external-platforms/store.mjs'

const CAPTURED_AT = new Date('2026-10-19T01:02:03.456Z')
const CAPTURED_DATE = '2026-10-19'
const MAX_BATCH_BYTES = 1024 * 1024
const archiveSql = sql => /INSERT INTO external_platform\.archive_objects/u.test(sql)
const archiveRows = values => Array.from({ length: values.length / 14 }, (_, index) => ({
  provider_key: values[index * 14 + 1], operation: values[index * 14 + 4],
  captured_date: values[index * 14 + 6], payload_sha256: values[index * 14 + 10],
  raw_payload: values[index * 14 + 11], provider_call_id: values[index * 14 + 12],
  item_ordinal: values[index * 14 + 13],
}))

function archiveObject(index, rawPayload = { id: `item-${index}`, text: '完整正文', nested: { url: 'https://example.test/a?signature=complete' } }) {
  return {
    kind: 'item', marketplace: 'weibo', endpointVersion: 'weibo.search.v1',
    capturedDate: CAPTURED_DATE, archivePath: `external/weibo/${CAPTURED_DATE}/${index}.json`,
    envelopePointer: `$.items[${index}]`, sourceKey: `item-${index}`,
    payloadSha256: index.toString(16).padStart(64, '0'), rawPayload,
  }
}

function setup({ onArchive, db } = {}) {
  const callId = randomUUID(), usageRequestId = randomUUID()
  const statements = []
  const client = {
    async query(sql, values) {
      statements.push({ sql, values })
      if (archiveSql(sql)) {
        await onArchive?.(sql, values)
        return db ? db.query(sql, values) : { rows: [] }
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return db ? db.query(sql) : { rows: [] }
      }
      if (/UPDATE external_platform\.provider_calls SET/u.test(sql)) return { rows: [{ id: callId }] }
      if (/UPDATE usage_requests SET/u.test(sql)) return { rows: [{ id: usageRequestId }] }
      if (/INSERT INTO external_platform\.response_snapshots/u.test(sql)) return { rows: [{
        id: randomUUID(), provider_key: 'tikhub', consumer_id: values[1], operation: values[2],
        request_fingerprint: values[3], response_body: values[4], captured_at: values[5],
        fresh_until: values[6], stale_until: values[7], last_success_call_id: values[8],
      }] }
      return { rows: [] }
    },
    release() {},
  }
  const store = new PostgresExternalPlatformStore({ pool: { async connect() { return client } }, providerKey: 'tikhub' })
  const commit = archiveObjects => store.commitLiveDelivery({
    callId,
    delivery: {
      usageRequestId, tenantId: randomUUID(), consumerId: randomUUID(),
      operation: 'native.h.weibo.search', fingerprint: 'a'.repeat(64),
    },
    responseBody: { data: { items: [] } }, capturedAt: CAPTURED_AT,
    freshUntil: new Date(CAPTURED_AT.getTime() + 60_000),
    staleUntil: new Date(CAPTURED_AT.getTime() + 120_000),
    itemCount: archiveObjects.length, latencyMs: 1, billed: true,
    costMinor: 1, costKind: 'estimated', currency: 'CNY', archiveObjects,
    ingestJob: { payload: { kind: 'external-platform-result', providerCallId: callId, records: [] }, dedupeKey: `call:${callId}` },
  })
  return { statements, commit, callId }
}

test('a 50-item result batches complete archive objects before the durable ingest job and COMMIT', async () => {
  const { statements, commit, callId } = setup()
  const objects = Array.from({ length: 50 }, (_, index) => archiveObject(index))
  const original = structuredClone(objects)
  await commit(objects)
  const inserts = statements.filter(({ sql }) => archiveSql(sql))
  assert.equal(inserts.length, 1)
  const rows = archiveRows(inserts[0].values)
  assert.deepEqual(rows.map(row => row.item_ordinal), Array.from({ length: 50 }, (_, index) => index))
  assert.deepEqual(rows.map(row => row.raw_payload), objects.map(object => object.rawPayload))
  assert.deepEqual(rows.map(row => row.payload_sha256), objects.map(object => object.payloadSha256))
  assert.ok(rows.every(row => row.provider_key === 'tikhub' && row.operation === 'native.h.weibo.search'
    && row.captured_date === CAPTURED_DATE && row.provider_call_id === callId))
  assert.deepEqual(objects, original)
  assert.ok(statements.findIndex(({ sql }) => archiveSql(sql)) < statements.findIndex(({ sql }) => /INSERT INTO mxq\.jobs/u.test(sql)))
  assert.equal(statements.at(-1).sql, 'COMMIT')
})

test('archive batches bound rows and preserve ordinal identities across batches', async () => {
  const { statements, commit } = setup()
  const objects = Array.from({ length: 1005 }, (_, index) => archiveObject(index))
  await commit(objects)
  const inserts = statements.filter(({ sql }) => archiveSql(sql))
  assert.equal(inserts.length, 2)
  const batches = inserts.map(({ values }) => archiveRows(values))
  assert.deepEqual(batches.map(rows => rows.length), [1000, 5])
  assert.deepEqual(batches.flat().map(row => row.item_ordinal), objects.map((_, index) => index))
})

test('archive batching counts UTF-8 bytes and never splits or truncates a large object', async () => {
  const { statements, commit } = setup()
  const objects = [archiveObject(0, { text: '中'.repeat(200_000) }),
    archiveObject(1, { text: '文'.repeat(200_000) }),
    archiveObject(2, { text: '整'.repeat(400_000) })]
  await commit(objects)
  const batches = statements.filter(({ sql }) => archiveSql(sql)).map(({ values }) => values)
  assert.equal(batches.length, 3)
  assert.ok(Buffer.byteLength(JSON.stringify(batches[0]), 'utf8') <= MAX_BATCH_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify(batches[1]), 'utf8') <= MAX_BATCH_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify(batches[2]), 'utf8') > MAX_BATCH_BYTES)
  assert.deepEqual(batches.flatMap(batch => archiveRows(batch).map(row => row.raw_payload)), objects.map(object => object.rawPayload))
})

test('a failed archive batch rolls back instead of committing usage or the ingest job', async () => {
  let archiveStatements = 0
  const error = new Error('disk write failed')
  const { statements, commit } = setup({ onArchive() { if (++archiveStatements === 2) throw error } })
  await assert.rejects(commit(Array.from({ length: 1005 }, (_, index) => archiveObject(index))), error)
  assert.equal(statements.at(-1).sql, 'ROLLBACK')
  assert.equal(statements.some(({ sql }) => sql === 'COMMIT' || /UPDATE usage_requests SET|INSERT INTO mxq\.jobs/u.test(sql)), false)
})

test('an invalid later capture date prevents any archive batch insert', async () => {
  const { statements, commit } = setup()
  await assert.rejects(commit([archiveObject(0), { ...archiveObject(1), capturedDate: '2026-10-18' }]),
    error => error.code === 'external_platform_archive_date_invalid')
  assert.equal(statements.some(({ sql }) => archiveSql(sql)), false)
  assert.equal(statements.at(-1).sql, 'ROLLBACK')
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('PostgreSQL archive batch preserves JSON null, full payloads and first-write ordinal deduplication',
  { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module' }, async t => {
    const { PGlite } = await import(pathToFileURL(modulePath).href)
    const db = new PGlite()
    t.after(() => db.close())
    await db.exec(`CREATE SCHEMA external_platform;
      CREATE TABLE external_platform.archive_objects (
        id uuid PRIMARY KEY, provider_key text NOT NULL, object_kind text NOT NULL,
        marketplace text NOT NULL, operation text NOT NULL, endpoint_version text NOT NULL,
        captured_date date NOT NULL, archive_path text NOT NULL, response_pointer text NOT NULL,
        source_key text NOT NULL, payload_sha256 char(64) NOT NULL, raw_payload jsonb NOT NULL,
        provider_call_id uuid NOT NULL, item_ordinal integer NOT NULL,
        UNIQUE(provider_call_id,item_ordinal));`)
    const { commit } = setup({ db })
    const objects = [{ ...archiveObject(0, null), kind: 'response' }, archiveObject(1)]
    await commit(objects)
    const { rows } = await db.query('SELECT item_ordinal, raw_payload, raw_payload IS NULL AS sql_null FROM external_platform.archive_objects ORDER BY item_ordinal')
    assert.deepEqual(rows, [{ item_ordinal: 0, raw_payload: null, sql_null: false },
      { item_ordinal: 1, raw_payload: objects[1].rawPayload, sql_null: false }])
    await commit(objects.map(object => ({ ...object, rawPayload: { changed: true } })))
    assert.deepEqual((await db.query('SELECT item_ordinal, raw_payload, raw_payload IS NULL AS sql_null FROM external_platform.archive_objects ORDER BY item_ordinal')).rows, rows)
    for (const invalid of [{ ...archiveObject(0, null) }, { ...archiveObject(0), rawPayload: undefined, kind: 'response' }]) {
      const independent = setup({ db })
      await assert.rejects(independent.commit([invalid]), error => error.code === '23502')
    }
    assert.equal((await db.query('SELECT count(*)::integer AS total FROM external_platform.archive_objects')).rows[0].total, 2)
  })
