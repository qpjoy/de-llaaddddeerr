import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CRAWLER_SOURCE_TYPES } from '../../server/ingest/crawler/source-contract.mjs'

const sql = readFileSync(new URL('../../scripts/night-all-saved-records-index-status.sql', import.meta.url), 'utf8')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to an installed local PGlite module' }

async function database(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  return db
}

async function audit(db) {
  const rows = (await db.exec(sql)).flatMap(result => result.rows || [])
  assert.equal(rows.length, 1)
  const report = rows[0].index_status
  assert.equal(report.target.readOnly, true)
  assert.equal(report.scope.businessRowsRead, false)
  assert.equal(report.scope.sqlTextIncluded, false)
  assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off')
  return report
}

async function parent(db, types = [...CRAWLER_SOURCE_TYPES, 'tender']) {
  await db.exec(`CREATE TABLE public.saved_records(
    source_type varchar(64) NOT NULL, id int4 NOT NULL,
    last_seen_at timestamptz NOT NULL, body text) PARTITION BY LIST(source_type)`)
  for (const type of types) {
    await db.exec(`CREATE TABLE public.saved_records_${type} PARTITION OF public.saved_records FOR VALUES IN ('${type}')`)
  }
}

test('index status is bounded read-only SQL and never selects session SQL text or changes state', () => {
  const statements = sql.replace(/--[^\n]*/gu, '').split(';').map(value => value.trim()).filter(Boolean)
  assert.equal(statements[0], 'BEGIN TRANSACTION READ ONLY')
  assert.equal(statements.at(-1), 'ROLLBACK')
  // A semicolon inside a literal is not an SQL statement separator.
  const code = sql.replace(/--[^\n]*/gu, '').replace(/'(?:[^']|'')*'/gu, "''")
  assert.ok(code.split(';').map(value => value.trim()).filter(Boolean)
    .every(statement => /^(BEGIN|SET LOCAL|WITH|ROLLBACK)\b/u.test(statement)))
  assert.doesNotMatch(code, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO|COMMIT)\b/iu)
  assert.doesNotMatch(code, /\b(?:query|usename|application_name|client_addr|query_start|pg_cancel_backend|pg_terminate_backend)\b/iu)
  assert.doesNotMatch(code, /(?:FROM|JOIN)\s+(?:public\.)?saved_records\b/iu)
  assert.match(sql, /SET LOCAL statement_timeout = '10s'/u)
  assert.match(sql, /SET LOCAL lock_timeout = '1s'/u)
  assert.match(sql, /SET LOCAL idle_in_transaction_session_timeout = '15s'/u)
  assert.match(sql, /FROM pg_stat_progress_create_index/u)
  assert.match(sql, /pg_blocking_pids\(pid\)/u)
  assert.match(sql, /current_locker_pid::integer/u)
})

test('actual SQL distinguishes healthy alternate names, interrupted builds and conflicting managed names without changing records', postgres, async t => {
  const db = await database(t)
  await parent(db)
  await db.exec(`CREATE UNIQUE INDEX existing_news_cursor ON public.saved_records_news(last_seen_at,id);
    CREATE UNIQUE INDEX finance_cursor ON public.saved_records_finance(last_seen_at,id);
    CREATE INDEX saved_records_finance_last_seen_at_id_uidx ON public.saved_records_forum(id);
    CREATE UNIQUE INDEX wrong_order ON public.saved_records_forum(id,last_seen_at);
    CREATE UNIQUE INDEX saved_records_tender_last_seen_at_id_uidx ON public.saved_records_tender(last_seen_at,id);
    UPDATE pg_index SET indisvalid=false WHERE indexrelid='public.saved_records_tender_last_seen_at_id_uidx'::regclass;
    INSERT INTO public.saved_records VALUES ('news',1,'2026-10-16T00:00:00Z','private-business-body');`)
  const before = await db.query('SELECT row_to_json(r) AS value FROM public.saved_records r')
  const report = await audit(db)
  assert.equal(report.parentFound, true)
  assert.equal(report.parentPartitionKey, 'LIST (source_type)')
  assert.equal(report.directPartitionCount, 14)
  assert.equal(report.partitionsComplete, true)
  assert.equal(report.relations.length, 15)
  const leaves = Object.fromEntries(report.relations.filter(row => !row.isParent).map(row => [row.sourceType, row]))
  assert.equal(leaves.news.cursorIndexReady, true)
  assert.equal(leaves.news.managedNameObject, null)
  assert.equal(leaves.finance.cursorIndexReady, true)
  assert.equal(leaves.finance.managedNameObject.compatible, false)
  assert.equal(leaves.finance.managedNameObject.indexedTableOid, leaves.forum.oid)
  assert.equal(leaves.forum.cursorIndexReady, false)
  assert.equal(leaves.tender.cursorIndexReady, false)
  assert.equal(leaves.tender.managedNameObject.compatible, false)
  assert.equal(leaves.tender.indexes[0].valid, false)
  assert.equal(leaves.tender.indexes[0].ready, true)
  assert.equal(leaves.tender.indexes[0].live, true)
  assert.equal(leaves.tender.indexes[0].firstColumn, 'last_seen_at')
  assert.equal(leaves.tender.indexes[0].secondColumn, 'id')
  assert.deepEqual((await db.query('SELECT row_to_json(r) AS value FROM public.saved_records r')).rows, before.rows)
  assert.equal((await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid='public.saved_records_tender_last_seen_at_id_uidx'::regclass")).rows[0].indisvalid, false)
  assert.doesNotMatch(JSON.stringify(report), /private-business-body/u)
  // PGlite executes the real statistics query but cannot reproduce other-backend lock waits.
  assert.deepEqual(report.progress, [])
  assert.deepEqual(report.sessions, [])
  assert.equal(report.progressComplete, true)
  assert.equal(report.sessionsComplete, true)
})

test('actual SQL reports target identity and a missing parent rather than pretending the source is ready', postgres, async t => {
  const db = await database(t)
  const report = await audit(db)
  const current = (await db.query('SELECT current_database() AS name')).rows[0].name
  assert.equal(report.target.database, current)
  assert.equal(report.target.expectedDatabase, 'agent_data_crawler_platform')
  assert.equal(report.target.databaseMatches, current === 'agent_data_crawler_platform')
  assert.equal(typeof report.target.serverVersion, 'string')
  assert.ok(Object.hasOwn(report.target, 'serverAddress'))
  assert.ok(Object.hasOwn(report.target, 'serverPort'))
  assert.equal(report.parentFound, false)
  assert.equal(report.directPartitionCount, 0)
  assert.deepEqual(report.relations, [])
  assert.deepEqual(report.progress, [])
  assert.deepEqual(report.locks, [])
  assert.equal(typeof report.scope.hasReadAllStats, 'boolean')
})

test('actual SQL keeps long managed names within PostgreSQL limits and never treats DEFAULT or shared partitions as supported leaves', postgres, async t => {
  const db = await database(t)
  const long = 'a'.repeat(38)
  await parent(db, ['news', long])
  await db.exec(`CREATE TABLE public.saved_records_shared PARTITION OF public.saved_records FOR VALUES IN ('one','two');
    CREATE TABLE public.saved_records_default PARTITION OF public.saved_records DEFAULT;`)
  const report = await audit(db)
  const named = report.relations.find(row => row.sourceType === long)
  assert.equal(named.supportedLeaf, true)
  assert.ok(Buffer.byteLength(named.expectedIndexName) <= 63)
  assert.match(named.expectedIndexName, /^saved_records_a{15}_[a-f0-9]{12}_last_seen_at_id_uidx$/u)
  for (const name of ['saved_records_shared', 'saved_records_default']) {
    const relation = report.relations.find(row => row.table === name)
    assert.equal(relation.supportedLeaf, false)
    assert.equal(relation.expectedIndexName, null)
    assert.equal(relation.managedNameObject, null)
  }
})

test('actual SQL bounds the child inventory and reports truncation explicitly', postgres, async t => {
  const db = await database(t)
  await parent(db, Array.from({ length: 501 }, (_, index) => `type_${String(index).padStart(3, '0')}`))
  const report = await audit(db)
  assert.equal(report.directPartitionCount, 501)
  assert.equal(report.partitionsComplete, false)
  assert.equal(report.relations.filter(row => !row.isParent).length, 500)
  assert.equal(report.scope.directPartitionLimit, 500)
})
