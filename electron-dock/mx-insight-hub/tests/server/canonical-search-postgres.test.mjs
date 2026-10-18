import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { SearchQueries } from '../../server/search/queries.mjs'

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for actual PostgreSQL queries and plans' }
const id = number => `50000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const timestamp = fraction => `2026-10-19T00:00:00.${fraction}Z`

test('canonical PostgreSQL search preserves exact totals and filters while hydrating a bounded page', postgres, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA core;
    CREATE TABLE core.canonical_records (
      id uuid PRIMARY KEY, dataset_id text, platform text, object_type text,
      external_id text, url text, title text, body text, author_external_id text, author_name text,
      event_time timestamptz, collected_at timestamptz, deleted_at timestamptz,
      stable_fields jsonb NOT NULL DEFAULT '{}', current_revision integer NOT NULL DEFAULT 1
    );
    CREATE TABLE core.public_opinion_current_state (
      record_id uuid PRIMARY KEY, canonical_revision integer, source_stage text, status text,
      quality_score integer, display_admin1_code text, geography_verified boolean,
      location_label text, location_type text, country_name text, country_code text
    );`)
  let captured
  const queries = new SearchQueries({ client: null, pool: { query(sql, values) {
    captured = { sql, values }
    return db.query(sql, values)
  } } })
  const scope = { platforms: ['telegram'], datasetIds: ['tg.messages'], objectType: 'message', size: 1, trackTotalHits: true }
  async function insert(number, { platform = 'telegram', dataset = 'tg.messages', event = timestamp('000500'),
    title = 'needle', body = 'retained full body', stable = {}, deleted = null, revision = 1 } = {}) {
    await db.query(`INSERT INTO core.canonical_records
      (id,platform,dataset_id,object_type,external_id,event_time,collected_at,title,body,stable_fields,deleted_at,current_revision)
      VALUES ($1,$2,$3,'message',$4,$5,'2026-10-19T01:00:00Z',$6,$7,$8,$9,$10)`,
    [id(number), platform, dataset, String(number), event, title, body, stable, deleted, revision])
  }
  await insert(1, { event: timestamp('000900') })
  await insert(9, { event: timestamp('000800') })
  await insert(8, { event: timestamp('000800') })
  await insert(7, { event: null })
  await insert(6, { event: null })
  await insert(20, { platform: 'private' })
  await insert(21, { dataset: 'private-dataset' })
  await insert(22, { deleted: timestamp('000999') })
  await insert(23, { title: 'no match', body: 'no match' })

  await t.test('keyset pages retain microseconds, null order and whole-filter exact counts', async () => {
    let cursor = null
    const seen = []
    do {
      const result = await queries.searchContent('needle', { ...scope, cursor })
      assert.equal(result.total, 5)
      assert.equal(result.totalRelation, 'eq')
      assert.equal(result.items.length, 1)
      assert.equal(result.items[0].body, 'retained full body')
      seen.push(result.items[0].id)
      cursor = result.nextCursor
      if (seen.length === 1) assert.equal(cursor.searchAfter[0], timestamp('000900'))
      assert.ok(seen.length <= 5)
    } while (cursor)
    assert.deepEqual(seen, [1, 9, 8, 7, 6].map(id))
    const offset = await queries.searchContent('needle', { ...scope, size: 2, offset: 2 })
    assert.deepEqual(offset.items.map(row => row.id), [8, 7].map(id))
    assert.equal(offset.total, 5); assert.equal(offset.hasMore, true)
    const empty = await queries.searchContent('needle', { ...scope, offset: 10 })
    assert.equal(empty.total, 5); assert.deepEqual(empty.items, []); assert.equal(empty.hasMore, false)
  })

  await t.test('bounded time and literal substring matching stay unchanged', async () => {
    const result = await queries.searchContent('needle', { ...scope, size: 10, fromTime: timestamp('000800'), toTime: timestamp('000800') })
    assert.deepEqual(result.items.map(row => row.id), [9, 8].map(id)); assert.equal(result.total, 2)
    await insert(24, { title: '100% a_b a\\b' })
    for (const term of ['100%', 'a_b', 'a\\b']) {
      const page = await queries.searchContent(term, scope)
      assert.deepEqual(page.items.map(row => row.id), [id(24)]); assert.equal(page.total, 1)
    }
  })

  await t.test('publication and crawler eligibility are checked before counting and paging', async () => {
    const crawler = 'data_center_saved_records_news'
    await insert(30, { platform: crawler, stable: { crawler: { publication: { eligibility: 'candidate' } } } })
    await insert(31, { platform: crawler })
    for (const number of [40, 41, 42]) {
      await insert(number, { platform: 'public_opinion' })
      await db.query(`INSERT INTO core.public_opinion_current_state
        (record_id,canonical_revision,source_stage,status,quality_score,display_admin1_code,country_code)
        VALUES ($1,$2,'candidate','qualified',$3,'11','CN')`, [id(number), number === 42 ? 0 : 1, number === 41 ? 20 : 90])
    }
    const result = await queries.searchContent('needle', {
      platforms: [crawler, 'public_opinion'], size: 10, trackTotalHits: true,
      crawlerPublicationVisibility: { eligibility: 'candidate' },
      publicOpinionVisibility: { candidateMode: 'qualified', minQualityScore: 80, provinceCode: '11', countryCode: 'CN' },
    })
    assert.deepEqual(result.items.map(row => row.id), [40, 30].map(id)); assert.equal(result.total, 2)
    assert.equal(result.items[0].publication.qualityScore, 90)
    assert.equal(result.items[0].publication.stage, 'candidate')
  })

  await t.test('large corpus count and sort carry identities instead of full record bodies', async () => {
    await db.exec(`INSERT INTO core.canonical_records
      (id,platform,dataset_id,object_type,external_id,event_time,title,body,stable_fields)
      SELECT md5('canonical-large-' || n)::uuid, 'telegram','large','message', n::text,
             '2026-10-19T00:00:00Z'::timestamptz + n * interval '1 microsecond', 'needle',
             repeat(md5(n::text), 200), jsonb_build_object('preserved',repeat(md5(n::text), 50))
        FROM generate_series(1,12000) n;
      ANALYZE core.canonical_records;`)
    const result = await queries.searchContent('needle', { platforms: ['telegram'], datasetId: 'large', size: 2, trackTotalHits: true })
    assert.equal(result.total, 12000); assert.equal(result.items.length, 2); assert.equal(result.items[0].body.length, 6400)
    const { rows } = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured.sql}`, captured.values)
    const nodes = []
    function visit(node) { nodes.push(node); for (const child of node.Plans || []) visit(child) }
    visit(rows[0]['QUERY PLAN'][0].Plan)
    const window = nodes.find(node => node['Node Type'] === 'WindowAgg')
    assert.equal(window['Actual Rows'], 12000)
    assert.ok(window['Plan Width'] <= 32, `exact-count window must be narrow; received ${window['Plan Width']} bytes`)
    const page = nodes.find(node => node['Subplan Name'] === 'CTE page')
    assert.equal(page?.['Actual Rows'], 3)
    assert.ok(nodes.some(node => node['Index Name'] === 'canonical_records_pkey' && node['Actual Loops'] === 3), 'only page IDs fetch complete records')
  })
})

test('publication visibility and profile readiness share one alias lookup per search without caching future requests', async () => {
  let aliasCalls = 0
  const queries = new SearchQueries({
    client: {
      async getAlias() { aliasCalls++; return { 'content-v6-active': { aliases: { content: {} } } } },
      async request(method, path) {
        if (path.startsWith('/content/_pit')) return { id: 'fixture-pit' }
        if (path === '/_search') return { hits: { total: { value: 0, relation: 'eq' }, hits: [] } }
        if (method === 'DELETE' && path === '/_pit') return {}
        throw new Error(`Unexpected request ${method} ${path}`)
      },
    },
    pool: { query() { throw new Error('must not fall back') } },
    segmenter: { async segment(value) { return [value] } }, indexSet: { readAlias: 'content' },
  })
  for (let count = 1; count <= 2; count++) {
    const result = await queries.searchContent('fixture', { platforms: ['data_center_saved_records_news'], searchProfile: 'canonical.zh-recall.v1', crawlerPublicationVisibility: { eligibility: 'candidate' } })
    assert.equal(result.mode, 'elasticsearch')
    assert.equal(aliasCalls, count)
  }
})
