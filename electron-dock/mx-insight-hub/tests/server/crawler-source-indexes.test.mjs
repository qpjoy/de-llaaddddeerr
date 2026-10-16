import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CRAWLER_SOURCE_TYPES, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'

const sql = readFileSync(new URL('../../scripts/night-all-saved-records-source-indexes.sql', import.meta.url), 'utf8')
const manage = readFileSync(new URL('../../scripts/manage.sh', import.meta.url), 'utf8')
const section = name => sql.split(`-- BEGIN ${name}\n`)[1].split(`-- END ${name}`)[0]
const preflight = section('CATALOG PREFLIGHT')
const plan = section('CONCURRENT INDEX PLAN').replace(/\\gexec\s*$/u, ';')
const verify = section('FINAL VERIFICATION')
const transportSql = manage.split('night_all_saved_records_source_mode() {')[1].split("<<'SQL'\n")[1].split('\nSQL\n')[0]
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to an installed local PGlite module' }

async function database(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(sql.match(/^SET search_path = [^;]+;/mu)[0])
  return db
}
async function leaves(db, { extra = [], omit = [], cursorType = 'timestamptz', nullable = false } = {}) {
  await db.exec(`CREATE TABLE public.saved_records(source_type varchar(64) NOT NULL, id int4 NOT NULL,
    last_seen_at ${cursorType}${nullable ? '' : ' NOT NULL'}) PARTITION BY LIST(source_type)`)
  for (const type of [...CRAWLER_SOURCE_TYPES.filter(value => !omit.includes(value)), ...extra]) {
    await db.exec(`CREATE TABLE public.saved_records_${type} PARTITION OF public.saved_records FOR VALUES IN ('${type}')`)
  }
}
async function planned(db) {
  return (await db.query(plan)).rows.map(row => Object.values(row)[0])
}
async function applyInMemory(db, statements) {
  // PGlite validates the actual generated index definitions. It cannot model
  // production concurrent builders or psql session/advisory-lock behavior.
  for (const statement of statements) {
    assert.ok(statement.startsWith('CREATE UNIQUE INDEX CONCURRENTLY '))
    await db.exec(statement.replace(' CONCURRENTLY ', ' '))
  }
}

test('only concurrent maintenance relaxes lock timeout, retains a bounded statement timeout and prints executed SQL', () => {
  const before = sql.split('-- BEGIN CONCURRENT INDEX PLAN')[0]
  const after = sql.split('-- END CONCURRENT INDEX PLAN')[1]
  assert.deepEqual([...before.matchAll(/^SET lock_timeout = '([^']+)';/gmu)].map(match => match[1]), ['2s', '0'])
  assert.deepEqual([...sql.matchAll(/^SET statement_timeout = '([^']+)';/gmu)].map(match => match[1]), ['30min'])
  assert.match(before, /\\set ECHO queries\s*$/u)
  assert.match(after, /^\s*\\set ECHO none\s*SET lock_timeout = '2s';/u)
  assert.match(sql, /^\\set ON_ERROR_STOP on/mu)
})

test('actual source index SQL includes tender, reuses a valid differently named index and becomes idempotent', postgres, async t => {
  const db = await database(t)
  await leaves(db, { extra: ['tender'] })
  await db.exec('CREATE UNIQUE INDEX existing_news_cursor ON public.saved_records_news(last_seen_at,id)')
  await db.exec(preflight)
  const statements = await planned(db)
  assert.equal(statements.length, 13)
  assert.ok(statements.some(value => value.includes('saved_records_tender')))
  assert.ok(statements.every(value => !value.includes('saved_records_news')))
  await applyInMemory(db, statements)
  await db.exec(verify)
  assert.deepEqual(await planned(db), [])
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crawler_source_index_contract WHERE contract_ready')).rows[0].count, 14)
})


test('wrong-order, descending, partial, expression and INCLUDE indexes do not satisfy the actual catalog view', postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec(`CREATE UNIQUE INDEX wrong_order ON public.saved_records_news(id,last_seen_at);
    CREATE UNIQUE INDEX wrong_direction ON public.saved_records_forum(last_seen_at DESC,id);
    CREATE UNIQUE INDEX partial_cursor ON public.saved_records_web(last_seen_at,id) WHERE id>0;
    CREATE UNIQUE INDEX extra_column ON public.saved_records_social(last_seen_at,id) INCLUDE(source_type);
    CREATE UNIQUE INDEX expression_cursor ON public.saved_records_finance(last_seen_at,(id+1));`)
  await db.exec(preflight)
  assert.equal((await planned(db)).length, 13)
  await applyInMemory(db, await planned(db))
  await db.exec(verify)
})

test('long canonical categories get distinct <=63-byte index names while the original thirteen names remain stable', postgres, async t => {
  const db = await database(t)
  const types = ['a'.repeat(38), 'a'.repeat(37) + 'b']
  await leaves(db, { extra: types })
  await db.exec(preflight)
  const rows = (await db.query('SELECT * FROM crawler_source_index_expected')).rows
  assert.equal(new Set(rows.map(row => row.index_name)).size, 15)
  for (const row of rows) {
    assert.ok(Buffer.byteLength(row.index_name) <= 63)
    if (CRAWLER_SOURCE_TYPES.includes(row.source_type)) assert.equal(row.index_name, `saved_records_${row.source_type}_last_seen_at_id_uidx`)
  }
  await applyInMemory(db, await planned(db))
  await db.exec(verify)
})

test('DEFAULT and multi-value partitions are observed but never included in source DDL', postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec("CREATE TABLE public.saved_records_default PARTITION OF public.saved_records DEFAULT; CREATE TABLE public.saved_records_shared PARTITION OF public.saved_records FOR VALUES IN ('one','two')")
  await db.exec(preflight)
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crawler_source_leaf_catalog')).rows[0].count, 15)
  assert.equal((await planned(db)).length, 13)
  assert.ok((await planned(db)).every(value => !/default|shared/u.test(value)))
})

for (const [name, setup, pattern] of [
  ['missing original leaf', async db => leaves(db, { omit: ['news'], extra: ['tender'] }), /required original/],
  ['wrong parent partition key', async db => db.exec('CREATE TABLE public.saved_records(source_type text,id int) PARTITION BY LIST(id)'), /LIST partitioned by source_type/],
  ['wrong singleton table name', async db => { await leaves(db); await db.exec("CREATE TABLE public.wrong_tender PARTITION OF public.saved_records FOR VALUES IN ('tender')") }, /canonical single-value/],
  ['nested partition', async db => { await leaves(db); await db.exec("CREATE TABLE public.saved_records_tender PARTITION OF public.saved_records FOR VALUES IN ('tender') PARTITION BY RANGE(id)") }, /canonical single-value/],
  ['wrong cursor type', async db => leaves(db, { cursorType: 'text' }), /cursor requires non-null/],
  ['nullable cursor', async db => leaves(db, { nullable: true }), /cursor requires non-null/],
  ['noncanonical source type', async db => { await leaves(db); await db.exec("CREATE TABLE public.saved_records_upper PARTITION OF public.saved_records FOR VALUES IN ('UPPER')") }, /canonical single-value/],
  ['more than 500 partitions', async db => leaves(db, { extra: Array.from({ length: 488 }, (_, index) => `type_${index}`) }), /13 to 500/],
]) test(`source preflight refuses ${name} before generating DDL`, postgres, async t => {
  const db = await database(t)
  await setup(db)
  await assert.rejects(() => db.exec(preflight), pattern)
  assert.equal((await db.query("SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname='public'")).rows[0].count, 0)
})

for (const [name, ddl] of [
  ['wrong definition', 'CREATE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_news(last_seen_at,id)'],
  ['dead invalid build', 'CREATE UNIQUE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_news(last_seen_at,id); UPDATE pg_index SET indisvalid=false,indislive=false WHERE indexrelid=\'public.saved_records_news_last_seen_at_id_uidx\'::regclass'],
  ['invalid constraint index', 'ALTER TABLE public.saved_records_news ADD CONSTRAINT saved_records_news_last_seen_at_id_uidx UNIQUE(last_seen_at,id); UPDATE pg_index SET indisvalid=false WHERE indexrelid=\'public.saved_records_news_last_seen_at_id_uidx\'::regclass'],
  ['same name on another table', 'CREATE UNIQUE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_forum(last_seen_at,id)'],
]) test(`source preflight refuses a managed index name with ${name}, even if another valid index exists`, postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec('CREATE UNIQUE INDEX already_correct ON public.saved_records_news(last_seen_at,id)')
  await db.exec(ddl)
  await assert.rejects(() => db.exec(preflight), /incompatible or invalid object/)
  assert.notEqual((await db.query("SELECT to_regclass('public.saved_records_news_last_seen_at_id_uidx') AS value")).rows[0].value, null)
})

for (const ready of [false, true]) test(`plans repair for an exact managed live invalid index (ready=${ready}) and requires a valid result`, postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec(`CREATE UNIQUE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_news(last_seen_at,id);
    CREATE UNIQUE INDEX already_correct ON public.saved_records_news(last_seen_at,id);
    UPDATE pg_index SET indisvalid=false,indisready=${ready} WHERE indexrelid='public.saved_records_news_last_seen_at_id_uidx'::regclass`)
  // Synthetic catalog state: PGlite does not exercise actual failed CIC phases.
  await db.exec(preflight)
  const statements = await planned(db)
  assert.deepEqual(statements.filter(value => value.includes('saved_records_news')), ['REINDEX INDEX CONCURRENTLY public.saved_records_news_last_seen_at_id_uidx'])
  await applyInMemory(db, statements.filter(value => value.startsWith('CREATE ')))
  await assert.rejects(() => db.exec(verify), /did not become ready/)
  // Change only the synthetic catalog fixture to test postconditions. This
  // does not validate REINDEX: PGlite cannot exercise its concurrent phases.
  await db.exec(`UPDATE pg_index SET indisvalid=true,indisready=true
    WHERE indexrelid='public.saved_records_news_last_seen_at_id_uidx'::regclass`)
  await db.exec(verify)
  assert.deepEqual(await planned(db), [])
})

for (const suffix of ['_ccnew', '_ccold2', '_other']) test(`an incomplete alternate index ${suffix} requires review even when the managed index is ready`, postgres, async t => {
  const db = await database(t)
  await leaves(db)
  const name = `saved_records_news_last_seen_at_id_uidx${suffix}`
  await db.exec(`CREATE UNIQUE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_news(last_seen_at,id);
    CREATE UNIQUE INDEX ${name} ON public.saved_records_news(last_seen_at,id);
    UPDATE pg_index SET indisvalid=false${suffix === '_ccold2' ? ',indislive=false' : ''} WHERE indexrelid='public.${name}'::regclass`)
  await assert.rejects(() => db.exec(preflight), new RegExp(`unmanaged incomplete cursor index ${name}`))
})

test('an invalid attached index is never automatically rebuilt', postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec(`CREATE INDEX parent_cursor ON public.saved_records(last_seen_at,id);
    ALTER INDEX public.saved_records_news_last_seen_at_id_idx RENAME TO saved_records_news_last_seen_at_id_uidx;
    UPDATE pg_index SET indisunique=true,indisvalid=false WHERE indexrelid='public.saved_records_news_last_seen_at_id_uidx'::regclass`)
  await assert.rejects(() => db.exec(preflight), /incompatible or invalid object/)
})

test('repair refuses hidden builder statistics and a visible active builder', postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec(`CREATE UNIQUE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_news(last_seen_at,id);
    UPDATE pg_index SET indisvalid=false WHERE indexrelid='public.saved_records_news_last_seen_at_id_uidx'::regclass`)
  await db.exec(preflight)
  await db.exec('CREATE ROLE index_operator')
  const grant = (await db.query("SELECT format('GRANT USAGE ON SCHEMA %I TO index_operator', nspname) AS sql FROM pg_namespace WHERE oid=pg_my_temp_schema()")).rows[0].sql
  await db.exec(grant)
  await db.exec(`GRANT SELECT ON crawler_source_index_contract, crawler_source_index_evidence, crawler_source_index_expected TO index_operator;
    SET ROLE index_operator`)
  await assert.rejects(() => db.exec('SELECT pg_temp.assert_crawler_source_index_maintenance()'), /requires visibility of all index builders/)
  await db.exec(`RESET ROLE;
    DROP VIEW pg_catalog.pg_stat_progress_create_index;
    CREATE VIEW pg_catalog.pg_stat_progress_create_index AS SELECT pg_backend_pid()+1 AS pid,
      'public.saved_records_news'::regclass::oid AS relid, 0::oid AS datid`)
  await db.exec('SELECT pg_temp.assert_crawler_source_index_maintenance()')
  await db.exec(`CREATE OR REPLACE VIEW pg_catalog.pg_stat_progress_create_index AS SELECT pg_backend_pid()+1 AS pid,
    'public.saved_records_news'::regclass::oid AS relid, (SELECT oid FROM pg_database WHERE datname=current_database()) AS datid`)
  await assert.rejects(() => db.exec('SELECT pg_temp.assert_crawler_source_index_maintenance()'), /index builder is active/)
})

test('final verification refuses a changed partition inventory and indexes not actually created', postgres, async t => {
  const db = await database(t)
  await leaves(db)
  await db.exec(preflight)
  await assert.rejects(() => db.exec(verify), /did not become ready/)
  await applyInMemory(db, await planned(db))
  await db.exec("CREATE TABLE public.saved_records_tender PARTITION OF public.saved_records FOR VALUES IN ('tender')")
  await assert.rejects(() => db.exec(verify), /inventory changed/)
})

async function transports(db) {
  await db.exec('CREATE SCHEMA catalog; CREATE TABLE catalog.external_sources(source_key text PRIMARY KEY, source_kind text, connection jsonb, database_connection_id uuid); CREATE TABLE catalog.database_connections(id uuid PRIMARY KEY, connection jsonb)')
  for (const type of [...CRAWLER_SOURCE_TYPES, 'tender']) {
    const spec = crawlerSourceSpec(type)
    const connection = { ...spec.locator, host: '127.0.0.1', port: 5432, database: 'agent_data_crawler_platform', username: 'test_user', password: 'private-test-secret', sslMode: 'require' }
    await db.query('INSERT INTO catalog.external_sources VALUES($1,$2,$3,NULL)', [spec.sourceKey, 'database', connection])
  }
}
async function mode(db) {
  const rows = (await db.query(transportSql)).rows
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]), ['case'])
  assert.doesNotMatch(JSON.stringify(rows), /private-test-secret|test_user|127\.0\.0\.1/u)
  return rows[0].case
}

test('actual deploy transport SQL includes dynamic categories, missing original rows, profiles and partial configuration without exposing secrets', postgres, async t => {
  const db = await database(t)
  await transports(db)
  assert.equal(await mode(db), 'local')
  await db.exec(`UPDATE catalog.external_sources SET connection=jsonb_set(connection,'{database}','"another_database"')`)
  assert.equal(await mode(db), 'drift', 'a consistent but different database must not direct DDL to the fixed source database')
  await db.exec(`UPDATE catalog.external_sources SET connection=jsonb_set(connection,'{database}','"agent_data_crawler_platform"')`)
  await db.exec(`UPDATE catalog.external_sources SET connection=jsonb_set(connection,'{host}','"different-source"') WHERE source_key='night-all-saved-records-tender'`)
  assert.equal(await mode(db), 'drift')
  await db.exec(`UPDATE catalog.external_sources SET connection=connection-'host'-'port'-'database'-'username'-'password'-'sslMode'`)
  assert.equal(await mode(db), 'unconfigured')
  await db.exec(`UPDATE catalog.external_sources SET connection=connection||'{"host":"127.0.0.1"}' WHERE source_key='night-all-saved-records-tender'`)
  assert.equal(await mode(db), 'drift')
  await db.exec(`INSERT INTO catalog.database_connections VALUES('00000000-0000-0000-0000-000000000001','{"host":"127.0.0.1","database":"agent_data_crawler_platform","username":"test_user","password":"private-test-secret"}'); UPDATE catalog.external_sources SET database_connection_id='00000000-0000-0000-0000-000000000001'`)
  assert.equal(await mode(db), 'local')
  await db.exec(`UPDATE catalog.database_connections SET connection='{"dsnEnv":"PRIVATE_DSN"}'`)
  assert.equal(await mode(db), 'external')
  await db.exec(`DELETE FROM catalog.external_sources WHERE source_key='night-all-saved-records-news'`)
  assert.equal(await mode(db), 'drift')
})
