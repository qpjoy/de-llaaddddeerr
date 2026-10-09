import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { runCommonMigrations } from '@qpjoy/mx-common'
import { runMigrations } from '../../server/migrate.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { normalizeNightAllLegacyPayload } from '../../server/ingest/legacy-night-all.mjs'
import { planCanonical, planDelivery, parseArgs, repairDouyinMedia } from '../../server/ops/repair-douyin-media.mjs'

const COVER = 'https://example.test/cover.jpg?original=1', VIDEO = 'https://example.test/video.mp4', PHOTO = 'https://example.test/photo.jpg'
const media = { images: [COVER, PHOTO], videos: [VIDEO], coverUrl: COVER }
const fixedMedia = { ...media, images: [PHOTO] }
const modernItem = { externalId: 'modern-post', contentType: '4', title: '标题', text: '正文', media,
  author: { id: 'author', name: '作者' }, publishedAt: '2026-10-09T01:00:00Z' }
const modern = { requestId: 'saved', data: { items: [modernItem], pageInfo: { hasMore: false } } }
const rawItem = { content_id: 'raw-post', content_type: '4', title: '标题', full_text: '正文',
  image_urls: JSON.stringify(media.images), video_urls: JSON.stringify(media.videos), cover_url: COVER }
const raw = { data: { raw_data: JSON.stringify([rawItem]), raw_info: '[{"name":"account"}]', meta: { resultCount: 1 } } }

test('migration arguments default to read-only canonical; legacy deliveries are explicitly selected', () => {
  assert.deepEqual(parseArgs([]), { apply: false, includeDeliveries: false, batchSize: 50 })
  assert.deepEqual(parseArgs(['--apply','--include-deliveries','--batch-size','2']), { apply: true, includeDeliveries: true, batchSize: 2 })
  for (const args of [['--all'],['--batch-size','0'],['--batch-size','201'],['--batch-size'],['--batch-size','1.5']]) assert.throws(() => parseArgs(args))
})

test('historical delivery repair preserves unrelated fields, JSON encodings, source objects and nonmatching whitespace', () => {
  const input = structuredClone({ modern, raw })
  assert.deepEqual(planDelivery(modern).data.items[0].media, fixedMedia)
  assert.equal(planDelivery(modern).data.items[0].cover_url, undefined)
  assert.equal(JSON.parse(planDelivery(raw).data.raw_data)[0].image_urls, JSON.stringify([PHOTO]))
  assert.equal(planDelivery(raw).data.raw_info, raw.data.raw_info)
  assert.deepEqual({ modern, raw }, input)
  assert.equal(planDelivery(planDelivery(raw)), null)
  const pretty = { data: { raw_data: JSON.stringify([{ ...rawItem, image_urls: JSON.stringify([PHOTO]) }], null, 2) } }
  assert.equal(planDelivery(pretty), null)
  assert.equal(planDelivery({ data: { raw_data: 'unrecognized optional evidence' } }), null)
  assert.equal(planCanonical({ stable_fields: { media }, content_type: 'mixed' }), null)
  assert.equal(planCanonical({ stable_fields: { media }, content_type: '68' }), null)
})

test('PostgreSQL one-off repair previews without writes, batches atomically, preserves billing/evidence, and repeats safely', {
  skip: process.env.MX_INSIGHT_TEST_DATABASE_URL ? false : 'Requires disposable PostgreSQL with CREATE DATABASE',
}, async t => {
  const admin = new pg.Pool({ connectionString: process.env.MX_INSIGHT_TEST_DATABASE_URL })
  const database = `douyin_repair_${randomUUID().replaceAll('-','')}`
  let pool
  try {
    await admin.query(`CREATE DATABASE ${database}`)
    const url = new URL(process.env.MX_INSIGHT_TEST_DATABASE_URL); url.pathname = `/${database}`
    await runCommonMigrations({ connectionString: url.href })
    await runMigrations({ connectionString: url.href })
    pool = new pg.Pool({ connectionString: url.href, max: 3, statement_timeout: 15000 })
    const store = new PostgresStore(pool)
    const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0]
    const readAll = async table => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows
    const ingestModern = () => store.ingestSearchResult({ platform: 'douyin', rawPayload: modern })
    const ingestRaw = () => store.ingestExternalRecords({ platform: 'douyin', datasetId: 'night-all.compat.v1',
      records: normalizeNightAllLegacyPayload(raw, 'douyin', 'raw').records, connectorId: 'night-all-legacy', importRunId: null })
    await ingestModern(); await ingestRaw()
    const originals = await readAll('core.canonical_records')
    for (const row of originals) {
      await pool.query(`UPDATE core.canonical_records SET stable_fields=jsonb_set(stable_fields,'{media}',$2),payload_sha256=$3 WHERE id=$1`, [row.id, media, '0'.repeat(64)])
      await pool.query('UPDATE core.record_revisions SET payload_sha256=$2 WHERE record_id=$1', [row.id, '0'.repeat(64)])
    }
    const beforeCanonical = await readAll('core.canonical_records')
    const beforeSource = await readAll('ingest.source_objects')
    const beforeRevisions = (await pool.query('SELECT * FROM core.record_revisions ORDER BY record_id,revision')).rows
    const beforeOutbox = await readAll('outbox.projection_events')
    const tenant = randomUUID(), consumer = randomUUID(), key = randomUUID()
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'test')", [tenant])
    await pool.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'test','test')", [consumer, tenant])
    await pool.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'test',$4,'fixture','0000')", [key, tenant, consumer, '1'.repeat(64)])
    const requests = []
    for (const [platform, body, status] of [['douyin',modern,'committed'],['douyin',raw,'committed'],['weibo',modern,'committed'],['douyin',modern,'unknown']]) {
      const id = randomUUID(); requests.push(id)
      await pool.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,units_reserved,units_actual,response_status,response_body)
        VALUES($1::uuid,$2,$3,$4,$1::text,$5,$6,$7,3,3,200,$8)`, [id,tenant,consumer,key,'2'.repeat(64),platform,status,body])
    }
    const call = randomUUID(), snapshot = randomUUID()
    await pool.query(`INSERT INTO serving.connector_calls(id,consumer_id,usage_request_id,operation,request_fingerprint,platform)
      VALUES($1,$2,$3,'raw',$4,'douyin')`, [call,consumer,requests[1],'3'.repeat(64)])
    await pool.query(`INSERT INTO serving.compatibility_snapshots(id,consumer_id,operation,request_fingerprint,platform,response_body,captured_at,stale_until,last_success_call_id)
      VALUES($1,$2,'raw',$3,'douyin',$4,now(),now()+interval '1 day',$5)`, [snapshot,consumer,'3'.repeat(64),raw,call])
    const beforeUsage = await readAll('usage_requests'), beforeSnapshots = await readAll('serving.compatibility_snapshots')

    await t.test('preview is read-only and gives exact candidate counts without printing source data', async () => {
      const progress = []
      const preview = await repairDouyinMedia(pool, { includeDeliveries: true, batchSize: 1, onProgress: v => progress.push(v) })
      assert.equal(preview.totals.canonical.matched, 2)
      assert.equal(preview.totals.deliveries.matched, 2)
      assert.equal(preview.totals.snapshots.matched, 1)
      assert.doesNotMatch(JSON.stringify(progress), /example\.test|正文|标题/)
      assert.equal((await one("SELECT to_regclass('control.douyin_media_repairs') AS table_name")).table_name, null)
      assert.deepEqual(await readAll('core.canonical_records'), beforeCanonical)
      assert.deepEqual(await readAll('usage_requests'), beforeUsage)
    })
    await t.test('an outbox failure rolls back the complete batch, including backups and revisions', async () => {
      await pool.query(`CREATE FUNCTION control.fail_media_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'fixture failure'; END $$;
        CREATE TRIGGER fail_media_test BEFORE INSERT ON outbox.projection_events FOR EACH ROW EXECUTE FUNCTION control.fail_media_test()`)
      await assert.rejects(repairDouyinMedia(pool, { apply: true }), /fixture failure/)
      assert.deepEqual(await readAll('core.canonical_records'), beforeCanonical)
      assert.equal((await one('SELECT count(*)::int AS n FROM control.douyin_media_repairs')).n, 0)
      assert.deepEqual((await pool.query('SELECT * FROM core.record_revisions ORDER BY record_id,revision')).rows, beforeRevisions)
      await pool.query('DROP TRIGGER fail_media_test ON outbox.projection_events; DROP FUNCTION control.fail_media_test()')
    })
    await t.test('canonical repair revisions once and matches the subsequent normal ingestion hashes', async () => {
      const result = await repairDouyinMedia(pool, { apply: true, batchSize: 1 })
      assert.equal(result.totals.canonical.updated, 2)
      assert.equal(result.totals.deliveries, undefined)
      assert.deepEqual(await readAll('usage_requests'), beforeUsage)
      for (const row of await readAll('core.canonical_records')) {
        assert.deepEqual(row.stable_fields.media, fixedMedia)
        assert.equal(row.current_revision, 2)
        const { stable_fields, payload_sha256, current_revision, projection_revision, ...kept } = row
        const { stable_fields: a, payload_sha256: b, current_revision: c, projection_revision: d, ...original } = beforeCanonical.find(r => r.id === row.id)
        assert.deepEqual(kept, original)
      }
      assert.equal((await readAll('outbox.projection_events')).length, beforeOutbox.length + 2)
      assert.deepEqual(await readAll('ingest.source_objects'), beforeSource)
      assert.equal((await ingestModern()).changed, 0)
      assert.equal((await ingestRaw()).changed, 0)
    })
    await t.test('explicit history repair changes only media bodies and retains complete original rows in audit', async () => {
      const result = await repairDouyinMedia(pool, { apply: true, includeDeliveries: true, batchSize: 1 })
      assert.equal(result.totals.canonical.updated, 0)
      assert.equal(result.totals.deliveries.updated, 2)
      assert.equal(result.totals.snapshots.updated, 1)
      for (const row of await readAll('usage_requests')) {
        const original = beforeUsage.find(r => r.id === row.id)
        const { response_body, ...kept } = row, { response_body: oldBody, ...oldFields } = original
        assert.deepEqual(kept, oldFields)
        assert.deepEqual(response_body, row.platform === 'douyin' && row.status === 'committed' ? planDelivery(oldBody) : oldBody)
      }
      const backups = await readAll('control.douyin_media_repairs')
      assert.equal(backups.length, 5)
      for (const backup of backups) {
        const original = (backup.target === 'canonical' ? beforeCanonical : backup.target === 'deliveries' ? beforeUsage : beforeSnapshots).find(r => r.id === backup.target_id)
        assert.deepEqual(backup.before_value, JSON.parse(JSON.stringify(original)))
      }
      assert.deepEqual((await one('SELECT response_body FROM serving.compatibility_snapshots WHERE id=$1',[snapshot])).response_body, planDelivery(raw))
      const again = await repairDouyinMedia(pool, { apply: true, includeDeliveries: true, batchSize: 1 })
      assert.ok(Object.values(again.totals).every(v => v.updated === 0))
      assert.equal((await readAll('control.douyin_media_repairs')).length, 5)
    })
    await t.test('another migration fails clearly; a busy ingest row times out instead of silently skipping', async () => {
      const lock = await pool.connect()
      try {
        await lock.query("SELECT pg_advisory_lock(hashtextextended('ops:douyin-media-repair',0))")
        await assert.rejects(repairDouyinMedia(pool, { apply: true }), /repair_already_running/)
        await lock.query("SELECT pg_advisory_unlock(hashtextextended('ops:douyin-media-repair',0))")
        await lock.query('BEGIN')
        await lock.query('SELECT id FROM core.canonical_records WHERE id=$1 FOR UPDATE', [originals[0].id])
        await assert.rejects(repairDouyinMedia(pool, { apply: true }), error => error.code === '55P03')
        await lock.query('ROLLBACK')
      } finally { lock.release() }
    })
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.end()
  }
})
