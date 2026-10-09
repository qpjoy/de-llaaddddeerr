import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { weiboTextPrefixMatches } from '../../server/contracts/raw-search.mjs'

const migration = name => readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8')
const sql = await migration('136_weibo_emotion_full_text_repair.sql')
const sha = value => createHash('sha256').update(value).digest('hex')
const requestId = '7316edc1-9479-4c17-b8ae-7cf0796493af'
const searchCall = '02728998-f37a-4c8f-a35b-f9f48af00685'
const runId = '00000000-0000-4000-8000-000000000001'
// The post/call IDs and display mismatches are operator-provided evidence.
// These short excerpts plus synthetic continuations are NOT production bodies.
const targets = [
  { post: '5351931117044493', call: '869086b1-9f9b-4359-b9d4-ea42df24a873',
    upstream: 'f3ebb9cf-746c-4e2a-a428-30fdbce41769', id: '9f1e4dfb-a30d-411a-8219-edf2a1ce9d42',
    start: 'Q：有什么想对队友们说的？Leaf：持续递东西', emoji: '[兔子]', next: 'Jawgemo：我超爱这些家伙的。我们今年一起经历了可能是最糟糕的事情。' },
  { post: '5351932359082259', call: '88000ff3-0f4d-4076-b159-a91b588b06e3',
    upstream: 'a4494989-4efb-4526-a580-4a6641e87fb8', id: '00000000-0000-4000-8000-000000000002',
    start: '到教练！你们可以用自己的语言回答', emoji: '[哈哈]', next: '我们看到今天VIT输掉了很多eco局，你们有没有什么训练能让队员们更默契地配合。' },
].map(t => ({ ...t, preview: t.start + t.next + '展开c', full: t.start + t.emoji + t.next + '这里是合成测试的完整后文。' }))

const pgliteModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('archived emotion repair is bounded, atomic, repeatable and keeps matching previews from replacing full text', {
  skip: pgliteModule ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local @electric-sql/pglite module',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgliteModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  const one = async (text, params = []) => (await db.query(text, params)).rows[0]
  const apply = async () => {
    await db.exec('BEGIN')
    try { await db.exec(sql); await db.exec('COMMIT') }
    catch (error) { await db.exec('ROLLBACK'); throw error }
  }
  await db.exec(await migration('005_ingest_core_outbox.sql'))
  const firstRepair = await migration('131_weibo_long_text_and_lcy_grants.sql')
  await db.exec(firstRepair.slice(0, firstRepair.indexOf('-- Installed before')))
  for (const name of ['132_hub_raw_weibo_full_text_guard.sql', '133_hub_data_search_weibo_full_text_guard.sql',
    '134_weibo_display_full_text_guard.sql']) await db.exec(`BEGIN; ${await migration(name)} COMMIT;`)
  await db.exec(`CREATE SCHEMA external_platform; CREATE SCHEMA control;
    ALTER TABLE ingest.ingest_runs ADD COLUMN external_platform_call_id uuid;
    CREATE TABLE external_platform.provider_calls(id uuid PRIMARY KEY,usage_request_id uuid,provider_key text,
      operation text,endpoint_key text,contract_version text,dispatch_fingerprint text,outcome text,
      http_status int,business_code int,upstream_request_id text);
    CREATE TABLE usage_requests(id uuid PRIMARY KEY,response_body jsonb);
    CREATE TABLE control.external_platform_restricted_raw_responses(provider_call_id uuid PRIMARY KEY,
      body_bytes bytea,body_size int,body_sha256 char(64),captured_at timestamptz);`)
  const history = await migration('061_acquisition_query_run_history.sql')
  await db.exec(history.slice(history.indexOf('ALTER TABLE core.observations'), history.indexOf('-- The migration runner is transactional')))
  await apply() // Other environments: no target, no invented records/runs.
  assert.equal((await one('SELECT count(*)::int AS n FROM ingest.ingest_runs')).n, 0)
  await db.query('INSERT INTO usage_requests VALUES($1,$2)', [requestId, { data: { status: 'partial' } }])
  await db.query(`INSERT INTO ingest.ingest_runs(id,connector_id,stream_id,trigger,request_id,external_platform_call_id)
    VALUES($1,'external-platform:tikhub','weibo.external-platform.v1','api_search',$2,$3)`, [runId, requestId, searchCall])
  for (const item of targets) {
    item.bytes = Buffer.from(JSON.stringify({ code: 200, privateUnrelatedField: 'never-copy-this', data: {
      idstr: item.post, user: { idstr: '7851053384' }, longText: { content: item.full }, isLongText: true } }))
    await db.query(`INSERT INTO core.canonical_records(id,dataset_id,platform,object_type,external_id,
      schema_version,payload_sha256,body,author_external_id,extensions,stable_fields)
      VALUES($1,'night-all.search.v1','weibo','post',$2,'external.v1',$3,$4,'7851053384',$5,$6)`,
    [item.id, item.post, sha(item.preview), item.preview, { body_completeness: 'provider_preview', kept: 'field' }, { kept: 'media' }])
    await db.query(`INSERT INTO core.record_revisions(record_id,revision,payload_sha256,normalized_payload,parser_version)
      VALUES($1,1,$2,$3,'mx-insight-hub.raw-search.v1')`, [item.id, sha(item.preview), { body: item.preview }])
    await db.query(`INSERT INTO core.observations(id,record_id,connector_id,observation_hash,ingest_run_id)
      VALUES(gen_random_uuid(),$1,'external-platform:tikhub',$2,$3)`, [item.id, sha(item.preview), runId])
    await db.query(`INSERT INTO external_platform.provider_calls VALUES($1,$2,'tikhub',
      'native.t.api_4f35621a9c07e539','native.t.api_4f35621a9c07e539','mx-insight-hub.native-forwarding.v1',
      $3,'succeeded',200,200,$4)`, [item.call, requestId,
    sha(JSON.stringify({ version: 'weibo-full-text.v1', id: item.post })), item.upstream])
    await db.query(`INSERT INTO control.external_platform_restricted_raw_responses VALUES($1,$2,$3,$4,now())`,
      [item.call, item.bytes, item.bytes.length, sha(item.bytes)])
  }
  const originalCalls = (await db.query('SELECT * FROM external_platform.provider_calls ORDER BY id')).rows
  const originalArchives = (await db.query('SELECT * FROM control.external_platform_restricted_raw_responses ORDER BY provider_call_id')).rows
  const second = targets[1]
  await db.query('UPDATE control.external_platform_restricted_raw_responses SET body_sha256=$2 WHERE provider_call_id=$1', [second.call, '0'.repeat(64)])
  await assert.rejects(apply(), /integrity mismatch/)
  assert.equal((await one('SELECT current_revision FROM core.canonical_records WHERE id=$1', [targets[0].id])).current_revision, 1)
  assert.equal((await one('SELECT count(*)::int AS n FROM outbox.projection_events')).n, 0)
  await db.query('UPDATE control.external_platform_restricted_raw_responses SET body_sha256=$2 WHERE provider_call_id=$1', [second.call, sha(second.bytes)])

  // Changed authors/edits, absent lineage and mismatched receipts never qualify.
  for (const change of [
    "UPDATE core.canonical_records SET author_external_id='other'",
    "UPDATE core.canonical_records SET deleted_at=now()",
    "UPDATE core.canonical_records SET current_revision=2",
    "UPDATE ingest.ingest_runs SET request_id=NULL",
    "UPDATE external_platform.provider_calls SET dispatch_fingerprint='wrong'",
  ]) {
    await db.exec('BEGIN')
    await db.exec(change)
    await db.exec(sql)
    assert.equal((await one('SELECT count(*)::int AS n FROM outbox.projection_events')).n, 0)
    await db.exec('ROLLBACK')
  }
  for (const invalidData of [
    item => ({ idstr: 'different-post' }),
    item => ({ user: { idstr: 'different-author' } }),
    item => ({ longText: { content: item.full + '展开c' } }),
    item => ({ longText: { content: '<b>' + item.full + '</b>' } }),
    item => ({ longText: { content: '不同正文'.repeat(80) } }),
    item => ({ longText: { content: '[业务注释]' + item.full } }),
    item => ({ longText: { content: '' } }),
  ]) {
    await db.exec('BEGIN')
    for (const item of targets) {
      const value = JSON.parse(item.bytes)
      Object.assign(value.data, invalidData(item))
      const bytes = Buffer.from(JSON.stringify(value))
      await db.query(`UPDATE control.external_platform_restricted_raw_responses SET body_bytes=$2,
        body_size=$3,body_sha256=$4 WHERE provider_call_id=$1`, [item.call, bytes, bytes.length, sha(bytes)])
    }
    await db.exec(sql)
    assert.equal((await one('SELECT count(*)::int AS n FROM outbox.projection_events')).n, 0)
    await db.exec('ROLLBACK')
  }
  await apply()
  for (const item of targets) {
    const saved = await one('SELECT * FROM core.canonical_records WHERE id=$1', [item.id])
    assert.equal(saved.body, item.full)
    assert.equal(saved.title, null)
    assert.equal(saved.current_revision, 2)
    assert.equal(Number(saved.projection_revision), 2)
    assert.equal(saved.extensions.kept, 'field')
    assert.equal(saved.extensions.rawSearch.bodyCompleteness, 'full_text')
    assert.equal(saved.extensions.weiboLongTextRepair.providerCallId, item.call)
    assert.deepEqual(saved.stable_fields, { kept: 'media' })
    assert.doesNotMatch(JSON.stringify(saved), /never-copy-this/)
    assert.equal((await one('SELECT normalized_payload FROM core.record_revisions WHERE record_id=$1 AND revision=1', [item.id])).normalized_payload.body, item.preview)
    assert.equal((await one('SELECT normalized_payload FROM core.record_revisions WHERE record_id=$1 AND revision=2', [item.id])).normalized_payload.body, item.full)
    assert.equal(weiboTextPrefixMatches(item.preview, item.full), true)
    assert.equal((await one('SELECT core.weibo_display_preview_of($1,$2) AS matches', [item.full, item.preview])).matches, true)
    for (const extensions of [{ body_completeness: 'provider_preview' }, { rawSearch: { bodyCompleteness: 'provider_preview' } }]) {
      const kept = await one(`UPDATE core.canonical_records SET body=$2,extensions=$3,payload_sha256=$4,
        current_revision=current_revision+1,projection_revision=projection_revision+1 WHERE id=$1 RETURNING *`,
      [item.id, item.preview, extensions, sha(item.preview)])
      assert.deepEqual(kept, saved)
    }
  }
  await apply()
  assert.equal((await one('SELECT count(*)::int AS n FROM core.record_revisions')).n, 4)
  assert.equal((await one('SELECT count(*)::int AS n FROM outbox.projection_events')).n, 2)
  assert.equal((await one('SELECT count(*)::int AS n FROM ingest.ingest_runs WHERE request_id=$1', [requestId])).n, 1)
  assert.deepEqual((await db.query(`SELECT canonical_revision FROM core.observations WHERE ingest_run_id=$1`, [runId])).rows,
    [{ canonical_revision: 1 }, { canonical_revision: 1 }])
  assert.deepEqual((await one('SELECT response_body FROM usage_requests WHERE id=$1', [requestId])).response_body, { data: { status: 'partial' } })
  assert.deepEqual((await db.query('SELECT * FROM external_platform.provider_calls ORDER BY id')).rows, originalCalls)
  assert.deepEqual((await db.query('SELECT * FROM control.external_platform_restricted_raw_responses ORDER BY provider_call_id')).rows, originalArchives)
  for (const item of targets) {
    assert.equal((await one('UPDATE core.canonical_records SET body=$2 WHERE id=$1 RETURNING body', [item.id, '真实的编辑'])).body, '真实的编辑')
    await db.query('UPDATE core.canonical_records SET body=$2 WHERE id=$1', [item.id, item.full])
    assert.equal((await one(`UPDATE core.canonical_records SET body=$2,deleted_at=now(),
      extensions='{"body_completeness":"provider_preview"}' WHERE id=$1 RETURNING body`, [item.id, item.preview])).body, item.preview)
  }
})
