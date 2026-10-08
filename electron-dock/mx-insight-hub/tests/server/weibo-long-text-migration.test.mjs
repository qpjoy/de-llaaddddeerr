import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { mergeWeiboDetail, weiboRow, rawSearchRecords } from '../../server/contracts/raw-search.mjs'

const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
const filename = '131_weibo_long_text_and_lcy_grants.sql'
const sql = await migration(filename)
const raw = Buffer.from(sql.match(/\$evidence\$([\s\S]+?)\$evidence\$/)[1], 'base64')
const response = JSON.parse(raw)
const full = response.data.longText.content.trim()
const short = '在名利场中心，我们习惯了看车企用“全链路冗余”的宏大叙事来堆砌安全感，却很少去审视那些维持运转的最底层逻辑。尊界V800在懂车帝的测试中，3台新车在100km/h紧急制动时刹车踏板支架全部断裂，这种在极限拉锯下瞬间崩塌的物理秩序，透着对工业底线失守的讽刺。当宣传里的华为途灵龙行平台还在强调 \u200b展开c'
const recordId = '34c72b79-f291-4ef7-ad9b-fe62eb03912d'
const tenant = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
const consumer = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
const key = 'fd2f8cc9-0ff1-4000-8000-000000000001'
const sibling = '00000000-0000-4000-8000-000000000002'
const sha = value => createHash('sha256').update(value).digest('hex')

test('migration embeds exactly the verified response; native detail defaults to long text', () => {
  assert.equal(raw.length, 19417)
  assert.equal(sha(raw), 'b05ecd61c51bb3e51a1fa464e0ffd78e41c10c0b47363a5b07806bee003444dc')
  assert.equal(response.data.idstr, '5351726865449966')
  assert.equal(response.data.user.idstr, '2471317784')
  assert.equal(response.data.text_raw.trim(), full)
  assert.equal([...full].length, 411)
  assert.equal([...short].length, 150)
  assert.doesNotMatch(full, /展开c$/u)
  const request = normalizeNativeForwardingRequest('t.api_4f35621a9c07e539', { params: { id: response.data.idstr } })
  assert.equal(request.upstreamQuery.is_get_long_text, 'true')
  assert.equal(request.endpointPath, '/api/v1/weibo/web_v2/fetch_post_detail')
  assert.throws(() => normalizeNativeForwardingRequest('t.weibo_web_v2_fetch_realtime_search',
    { params: { query: '测试', page: 1, is_get_long_text: true } }), /undeclared/)
})

// A disposable PostgreSQL WASM instance executes the real migration, constraints,
// triggers and rollback. No production connection or supplier call is possible.
const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('Hub raw projection reuses the previously paid response offline and preserves its full body', () => {
  const row = weiboRow({ weibo_id: response.data.idstr, user_id: response.data.user.idstr, content: short }, '2026-10-08T05:56:31.007Z')
  assert.equal(mergeWeiboDetail(row, { publicBody: { data: response.data, meta: { capturedAt: '2026-10-08T05:56:31.007Z' } } }), true)
  assert.equal(row.full_text, full)
  assert.equal([...row.full_text].length, 411)
})

test('migration 132 protects only verified Hub raw full text during later preview upserts', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(await migration('005_ingest_core_outbox.sql'))
  await db.exec(sql.slice(0, sql.indexOf('-- Installed before')))
  const guard = await migration('132_hub_raw_weibo_full_text_guard.sql')
  await db.exec(`BEGIN; ${guard} COMMIT;`)
  await db.exec(`BEGIN; ${guard} COMMIT;`)
  const row = weiboRow({ ...response.data }, '2026-10-08T05:56:31.007Z')
  row.body_completeness = 'full_text'
  const record = rawSearchRecords({ data: { raw_info: '[]', raw_data: JSON.stringify([row]) } }, 'weibo', 'tikhub')[0]
  const insert = async (id, dataset, platform, extensions = record.extensions) => db.query(`INSERT INTO core.canonical_records
    (id,dataset_id,platform,object_type,external_id,schema_version,payload_sha256,body,title,author_external_id,extensions)
    VALUES($1,$2,$3,'post',$4,'external.v1',$5,$6,$6,$7,$8)`, [id,dataset,platform,record.externalId,record.payloadSha256,full,record.authorExternalId,extensions])
  await insert(recordId, 'night-all.compat.v1', 'weibo')
  const update = async (id, body, extra = '') => (await db.query(`UPDATE core.canonical_records SET
    body=$2,title=$2,payload_sha256=$3,current_revision=current_revision+1,projection_revision=projection_revision+1
    ${extra} WHERE id=$1 RETURNING *`, [id, body, 'b'.repeat(64)])).rows[0]
  const protectedRow = await update(recordId, short)
  assert.equal(protectedRow.body, full)
  assert.equal(protectedRow.payload_sha256, record.payloadSha256)
  assert.equal(protectedRow.current_revision, 1)
  assert.equal(Number(protectedRow.projection_revision), 1)
  assert.equal((await update(recordId, '独立的编辑正文')).body, '独立的编辑正文')
  for (const [index, dataset, platform, extensions] of [
    [1, 'night-all.search.v1', 'weibo', record.extensions],
    [2, 'night-all.compat.v1', 'twitter', record.extensions],
    [3, 'night-all.compat.v1', 'weibo', {}],
  ]) {
    const id = `00000000-0000-4000-8000-00000000000${index}`
    await db.query('DELETE FROM core.canonical_records WHERE id=$1', [recordId])
    await insert(id, dataset, platform, extensions)
    assert.equal((await update(id, short)).body, short)
    await db.query('DELETE FROM core.canonical_records WHERE id=$1', [id])
  }
  await insert(recordId, 'night-all.compat.v1', 'weibo')
  assert.equal((await update(recordId, short, ',deleted_at=now()')).body, short)
})

test('migration 133 extends verified full-text protection to data/search while allowing edits and keeping the empty title', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(await migration('005_ingest_core_outbox.sql'))
  await db.exec(sql.slice(0, sql.indexOf('-- Installed before')))
  await db.exec(`BEGIN; ${await migration('132_hub_raw_weibo_full_text_guard.sql')} COMMIT;`)
  const guard = await migration('133_hub_data_search_weibo_full_text_guard.sql')
  await db.exec(`BEGIN; ${guard} COMMIT;`)
  await db.exec(`BEGIN; ${guard} COMMIT;`)
  for (const dataset of ['night-all.search.v1', 'night-all.compat.v1']) {
    await db.query(`INSERT INTO core.canonical_records
      (id,dataset_id,platform,object_type,external_id,schema_version,payload_sha256,body,title,author_external_id,extensions)
      VALUES($1,$2,'weibo','post','5351726865449966','external.v1',$3,$4,NULL,'2471317784',$5)`,
    [recordId, dataset, 'a'.repeat(64), full, { rawSearch: { version: 'mx-insight-hub.raw-search.v1', bodyCompleteness: 'full_text' } }])
    const update = async (body, extra = '') => (await db.query(`UPDATE core.canonical_records SET
      body=$2,title=$2,payload_sha256=$3,current_revision=current_revision+1 ${extra} WHERE id=$1 RETURNING *`,
    [recordId, body, 'b'.repeat(64)])).rows[0]
    const kept = await update(short)
    assert.equal(kept.body, full)
    assert.equal(kept.title, null)
    assert.equal(kept.payload_sha256, 'a'.repeat(64))
    assert.equal(kept.current_revision, 1)
    assert.equal((await update('edited body')).body, 'edited body')
    assert.equal((await update(short, ',deleted_at=now()')).body, short)
    await db.query('DELETE FROM core.canonical_records WHERE id=$1', [recordId])
  }
})

test('PostgreSQL migration repairs once, preserves sibling keys/history, protects against old workers and rolls back atomically', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  // Use actual table definitions from the earlier migrations. Only unrelated
  // tables/FKs are omitted so the test needs no external services/extensions.
  for (const name of ['001_initial.sql', '002_api_key_environment.sql',
    '003_consumer_platform_policies.sql', '005_ingest_core_outbox.sql',
    '016_api_key_expiry.sql', '018_public_capabilities.sql']) await db.exec(await migration(name))
  await db.exec((await migration('054_api_key_entitlements_plans_and_tikhub.sql')).split('-- Keep the caller-visible')[0])
  await db.exec(await migration('079_api_key_scope_events.sql'))
  await db.exec("ALTER TABLE api_keys ADD COLUMN web_search_order text[] NOT NULL DEFAULT '{}'; CREATE TABLE ingest.import_runs(id uuid PRIMARY KEY)")
  await db.exec((await migration('034_agent_analysis_pipelines.sql')).split('CREATE INDEX IF NOT EXISTS source_object_revisions_payload_idx')[0])
  const one = async (text, params = []) => (await db.query(text, params)).rows[0]
  const apply = async () => { await db.exec('BEGIN'); try { await db.exec(sql); await db.exec('COMMIT') }
    catch (error) { await db.exec('ROLLBACK'); throw error } }

  // Unrelated/new environments do not invent this customer's records or Key.
  await apply()
  assert.equal((await one('SELECT count(*)::int AS n FROM api_keys')).n, 0)
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, 'LCY'])
  await db.query('INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,$3,$4)', [consumer, tenant, 'LCY-delta', 'weibo-migration-test'])
  for (const [id, name, digest] of [[key, 'LCY-delta', '1'], [sibling, 'tenxun', '2']]) {
    await db.query(`INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,environment,scope_mode,expires_at)
      VALUES($1,$2,$3,$4,$5,'test-prefix','test','live','snapshot','2099-01-01')`, [id, tenant, consumer, name, digest.repeat(64)])
    await db.query("INSERT INTO api_key_platform_entitlements(api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES($1,'weibo',80,60,15)", [id])
    await db.query("INSERT INTO api_key_capability_entitlements(api_key_id,capability,max_requests,window_seconds) VALUES($1,'existing',7,60)", [id])
  }
  await db.query("INSERT INTO platform_grants(consumer_id,platform) VALUES($1,'weibo')", [consumer])
  // Existing native limits must never be reset by an additive grant.
  await db.query(`INSERT INTO consumer_capability_policies(tenant_id,consumer_id,capability,max_requests,window_seconds)
    VALUES($1,$2,'native.t.api_4f35621a9c07e539',3,120)`, [tenant, consumer])
  await db.query(`INSERT INTO core.canonical_records(id,dataset_id,platform,object_type,external_id,schema_version,payload_sha256,
    title,body,author_external_id,stable_fields,extensions) VALUES($1,'night-all.search.v1','weibo','post','5351726865449966',
    'content.v1',$2,$3,$3,'2471317784',$4,$5)`, [recordId, 'a'.repeat(64), short,
    { media: { images: ['https://example.invalid/kept.png'] }, author: { name: 'kept' } }, { source: { endpointId: 'weibo_web_v2_fetch_realtime_search' } }])
  await db.query(`INSERT INTO core.record_revisions(record_id,revision,payload_sha256,normalized_payload,parser_version)
    VALUES($1,1,$2,$3,'original')`, [recordId, 'a'.repeat(64), { text: short }])
  const before = await one('SELECT * FROM core.canonical_records WHERE id=$1', [recordId])
  const keysBefore = (await db.query('SELECT * FROM api_keys ORDER BY id')).rows
  const snapshotSibling = async () => (await db.query('SELECT * FROM api_key_capability_entitlements WHERE api_key_id=$1', [sibling])).rows
  const siblingBefore = await snapshotSibling()

  // Fail in the grant block, AFTER the repair block: all repair rows roll back.
  await db.query("UPDATE api_keys SET scope_mode='legacy_dynamic' WHERE id=$1", [sibling])
  await assert.rejects(apply(), /sibling dynamic/)
  assert.equal((await one('SELECT body FROM core.canonical_records WHERE id=$1', [recordId])).body, short)
  assert.equal((await one('SELECT count(*)::int AS n FROM ingest.ingest_runs')).n, 0)
  await db.query("UPDATE api_keys SET scope_mode='snapshot' WHERE id=$1", [sibling])
  await apply()
  const after = await one('SELECT * FROM core.canonical_records WHERE id=$1', [recordId])
  assert.equal(after.body, full); assert.equal(after.title, full)
  assert.equal(after.current_revision, 2); assert.equal(Number(after.projection_revision), 2)
  for (const field of ['stable_fields', 'author_external_id', 'url', 'event_time', 'collected_at', 'first_seen_at']) assert.deepEqual(after[field], before[field])
  assert.deepEqual(after.extensions.source, before.extensions.source)
  assert.equal((await one('SELECT normalized_payload FROM core.record_revisions WHERE record_id=$1 AND revision=1', [recordId])).normalized_payload.text, short)
  const rawRow = await one('SELECT raw_payload FROM ingest.source_object_revisions')
  assert.deepEqual(Buffer.from(rawRow.raw_payload.exactResponseBase64, 'base64'), raw)
  assert.equal((await one('SELECT count(*)::int AS n FROM outbox.projection_events')).n, 1)
  assert.equal((await one('SELECT count(*)::int AS n FROM api_key_scope_events')).n, 1)
  assert.deepEqual((await db.query('SELECT * FROM api_keys ORDER BY id')).rows, keysBefore)
  assert.deepEqual(await snapshotSibling(), siblingBefore)
  const scopes = (await db.query('SELECT * FROM api_key_capability_entitlements WHERE api_key_id=$1 ORDER BY capability', [key])).rows
  assert.deepEqual(scopes.map(row => row.capability), ['existing','native.t.api_4f35621a9c07e539','native.t.weibo_web_v2_fetch_realtime_search'])
  assert.equal(scopes[1].max_requests, 3); assert.equal(scopes[1].window_seconds, 120)
  assert.equal(scopes[0].max_requests, 7)
  await apply() // Raw replay is also safe beyond schema_migrations' normal skip.
  assert.equal((await one('SELECT current_revision FROM core.canonical_records WHERE id=$1', [recordId])).current_revision, 2)
  assert.equal((await one('SELECT count(*)::int AS n FROM core.record_revisions')).n, 2)
  assert.equal((await one('SELECT count(*)::int AS n FROM api_key_scope_events')).n, 1)

  // Simulate old-worker ON CONFLICT update: the trigger returns the old revision
  // so its subsequent revision/outbox ON CONFLICT writes also remain no-ops.
  const retained = await one(`UPDATE core.canonical_records SET body=$2,title=$2,payload_sha256=$3,
    current_revision=current_revision+1,projection_revision=projection_revision+1 WHERE id=$1 RETURNING *`, [recordId, short, 'b'.repeat(64)])
  assert.equal(retained.body, full); assert.equal(retained.current_revision, 2)
  assert.equal(retained.payload_sha256, after.payload_sha256)
  const client = { release() {}, async query(text, values) {
    const result = await db.query(text, values)
    return { ...result, rowCount: result.affectedRows ?? result.rows.length }
  } }
  const store = new PostgresStore({ connect: async () => client })
  const ingested = await store.ingestSearchResult({ platform: 'weibo', rawPayload: { data: { items: [{
    externalId: response.data.idstr, text: short, title: short, author: { id: response.data.user.idstr }, metrics: { likes: 99 },
  }] } } })
  assert.equal(ingested.changed, 0)
  assert.equal((await one('SELECT body FROM core.canonical_records WHERE id=$1', [recordId])).body, full)
  assert.equal((await one('SELECT count(*)::int AS n FROM core.record_revisions')).n, 2)
  assert.equal((await one('SELECT count(*)::int AS n FROM outbox.projection_events')).n, 1)
  assert.equal((await one("SELECT metrics FROM core.observations WHERE connector_id='night-all'")).metrics.likes, 99)
  assert.equal((await one("SELECT core.weibo_long_text_preview_of($1,$2) AS matches", [full, short.replace('展开c', '… 展开全文')])).matches, true)
  await db.query('UPDATE core.canonical_records SET body=$2 WHERE id=$1', [recordId, '完全不同的编辑正文'])
  assert.equal((await one('SELECT body FROM core.canonical_records WHERE id=$1', [recordId])).body, '完全不同的编辑正文')
  await assert.rejects(apply(), /no longer the verified preview/)
})
