import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CRAWLER_SOURCE_COLUMN_CONTRACT, CRAWLER_SOURCE_TYPES,
  crawlerCursorIndexIssues, crawlerColumnIssues, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'

const sql = readFileSync(new URL('../../scripts/night-all-saved-records-source-audit.sql', import.meta.url), 'utf8')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module' }

async function database(t) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  return db
}

async function audit(db) {
  const results = await db.exec(sql)
  const rows = results.flatMap(result => result.rows || [])
  assert.equal(rows.length, 1)
  const report = rows[0].source_audit
  assert.equal(report.scope.readOnly, true)
  assert.equal(report.scope.catalogOnly, true)
  assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off')
  return report
}

async function parent(db, { tag = false } = {}) {
  const columns = CRAWLER_SOURCE_COLUMN_CONTRACT.map(column =>
    `"${column.name}" ${column.databaseType}${column.nullable ? '' : ' NOT NULL'}`)
  if (tag) columns.push('tag varchar(128)')
  await db.exec(`CREATE TABLE public.saved_records (${columns.join(',')}) PARTITION BY LIST (source_type)`)
}

test('source audit is standalone catalog SQL with a read-only transaction and bounded timeouts', () => {
  const statements = sql.replace(/--[^\n]*/gu, '').split(';').map(value => value.trim()).filter(Boolean)
  assert.match(statements[0], /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.ok(statements.every(statement => /^(BEGIN|SET LOCAL|WITH|ROLLBACK)\b/u.test(statement)))
  assert.match(sql, /SET LOCAL statement_timeout = '10s'/u)
  assert.match(sql, /SET LOCAL lock_timeout = '1s'/u)
  const syntax = statements.join('\n').replace(/'(?:[^']|'')*'/gu, "''")
  assert.doesNotMatch(syntax, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO|COMMIT)\b/iu)
  assert.doesNotMatch(sql, /(?:FROM|JOIN)\s+(?:public\.)?saved_records\b/iu)
})

test('actual source audit discovers 13 leaves plus tender, nullable tag and exact cursor index evidence without reading or changing records', postgres, async t => {
  const db = await database(t)
  await parent(db, { tag: true })
  for (const type of [...CRAWLER_SOURCE_TYPES, 'tender']) {
    await db.exec(`CREATE TABLE public.saved_records_${type} PARTITION OF public.saved_records FOR VALUES IN ('${type}')`)
  }
  await db.exec(`CREATE UNIQUE INDEX news_cursor ON public.saved_records_news(last_seen_at, id);
    CREATE INDEX finance_nonunique ON public.saved_records_finance(last_seen_at, id);
    CREATE UNIQUE INDEX forum_wrong_order ON public.saved_records_forum(id, last_seen_at);
    CREATE UNIQUE INDEX social_desc ON public.saved_records_social(last_seen_at DESC, id);
    CREATE UNIQUE INDEX web_partial ON public.saved_records_web(last_seen_at, id) WHERE id > 0;
    CREATE UNIQUE INDEX media_include ON public.saved_records_media(last_seen_at, id) INCLUDE(title);`)
  const values = Object.fromEntries(CRAWLER_SOURCE_COLUMN_CONTRACT.map(column => [column.name,
    column.nullable ? null : column.databaseType === 'int4' ? 1 : column.databaseType === 'jsonb' ? {} :
      column.databaseType === 'timestamptz' ? '2026-10-16T00:00:00Z' : 'private-business-body']))
  values.source_type = 'news'
  const names = Object.keys(values)
  await db.query(`INSERT INTO public.saved_records(${names.map(name => `"${name}"`).join(',')})
    VALUES(${names.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(values))
  const before = await db.query('SELECT row_to_json(r) AS value FROM public.saved_records r')
  const report = await audit(db)
  assert.deepEqual((await db.query('SELECT row_to_json(r) AS value FROM public.saved_records r')).rows, before.rows)
  assert.doesNotMatch(JSON.stringify(report), /private-business-body/u)
  assert.equal(report.status, 'catalog_observed')
  assert.equal(typeof report.database, 'string')
  assert.equal(typeof report.serverVersion, 'string')
  assert.ok(report.serverVersionNumber >= 120000)
  assert.equal(report.parent.relationKind, 'p')
  assert.equal(report.parent.partitionKey, 'LIST (source_type)')
  assert.equal(report.directPartitionCount, 14)
  assert.equal(report.returnedPartitionCount, 14)
  assert.equal(report.partitionsComplete, true)
  assert.equal(report.parent.tag.declaredType, 'character varying(128)')
  assert.equal(report.parent.tag.nullable, true)
  assert.equal(report.expectedColumnContract.filter(column => !column.optional).length, 23)
  for (const relation of [report.parent, ...report.partitions]) {
    assert.deepEqual(relation.missingColumns, [])
    assert.deepEqual(relation.unexpectedColumns, [])
    assert.deepEqual(relation.columnMismatches, [])
    assert.deepEqual(crawlerColumnIssues(relation.columns), [])
  }
  const byType = Object.fromEntries(report.partitions.map(relation => [relation.table.replace('saved_records_', ''), relation]))
  assert.equal(byType.tender.partitionBound, "FOR VALUES IN ('tender')")
  assert.equal(byType.tender.isLeaf, true)
  assert.equal(byType.news.cursorIndexReady, true)
  for (const type of ['finance', 'forum', 'social', 'web', 'media', 'tender']) {
    assert.equal(byType[type].cursorIndexReady, false, type)
  }
  for (const [type, relation] of Object.entries(byType)) {
    assert.equal(crawlerCursorIndexIssues(relation.indexes, crawlerSourceSpec(type)).length === 0, relation.cursorIndexReady)
  }
  assert.equal(byType.finance.indexes[0].unique, false)
  assert.equal(byType.forum.indexes[0].firstKey, 'id')
  assert.notEqual(byType.social.indexes[0].firstOption, 0)
  assert.equal(byType.web.indexes[0].noPredicate, false)
  assert.equal(byType.media.indexes[0].totalColumns, 3)
})

test('actual source audit distinguishes missing parent and legacy schema from column drift', postgres, async t => {
  const db = await database(t)
  const missing = await audit(db)
  assert.equal(missing.status, 'parent_missing')
  assert.equal(missing.parentFound, false)
  assert.equal(missing.parent, null)
  assert.equal(missing.directPartitionCount, 0)
  assert.deepEqual(missing.partitions, [])
  await parent(db)
  const legacy = await audit(db)
  assert.deepEqual(legacy.parent.tag, { present: false })
  assert.deepEqual(legacy.parent.missingColumns, [])
  assert.deepEqual(crawlerColumnIssues(legacy.parent.columns), [])
  await db.exec(`ALTER TABLE public.saved_records DROP COLUMN title;
    ALTER TABLE public.saved_records ADD COLUMN tag text NOT NULL;
    ALTER TABLE public.saved_records ADD COLUMN extra_review_required text;`)
  const drift = await audit(db)
  assert.deepEqual(drift.parent.missingColumns, ['title'])
  assert.deepEqual(drift.parent.unexpectedColumns, ['extra_review_required'])
  assert.deepEqual(drift.parent.columnMismatches, [{ name: 'tag', expectedType: 'varchar', actualType: 'text',
    actualTypeSchema: 'pg_catalog', expectedNullable: true, actualNullable: false }])
  await db.exec('DROP TABLE public.saved_records; CREATE TABLE public.saved_records(id int)')
  const ordinary = await audit(db)
  assert.equal(ordinary.status, 'parent_not_partitioned')
  assert.equal(ordinary.parent.relationKind, 'r')
  assert.equal(ordinary.parent.partitionKey, null)
})

test('actual source audit bounds direct children at 500 and does not claim nested descendants are leaves', postgres, async t => {
  const db = await database(t)
  await db.exec('CREATE TABLE public.saved_records(source_type text, id int) PARTITION BY LIST (source_type)')
  await db.exec(Array.from({ length: 501 }, (_, index) =>
    `CREATE TABLE public.saved_records_${String(index).padStart(3, '0')} PARTITION OF public.saved_records
      FOR VALUES IN ('type_${index}')${index === 0 ? ' PARTITION BY RANGE (id)' : ''};`).join('\n'))
  await db.exec('CREATE TABLE public.saved_records_nested PARTITION OF public.saved_records_000 FOR VALUES FROM (0) TO (100)')
  const report = await audit(db)
  assert.equal(report.directPartitionCount, 501)
  assert.equal(report.returnedPartitionCount, 500)
  assert.equal(report.partitions.length, 500)
  assert.equal(report.partitionsComplete, false)
  assert.equal(report.partitions[0].isLeaf, false)
  assert.equal(report.partitions.some(relation => relation.table === 'saved_records_nested'), false)
})
