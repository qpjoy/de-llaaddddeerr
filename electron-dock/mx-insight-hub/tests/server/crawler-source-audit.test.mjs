import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CRAWLER_SOURCE_COLUMN_CONTRACT, CRAWLER_OPTIONAL_SOURCE_COLUMN_CONTRACT, CRAWLER_SOURCE_TYPES,
  crawlerCursorIndexIssues, crawlerColumnIssues, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'

const sql = readFileSync(new URL('../../scripts/night-all-saved-records-source-audit.sql', import.meta.url), 'utf8')
const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
const postgres = { skip: modulePath ? false : 'Set MX_INSIGHT_TEST_PGLITE_MODULE to a local PGlite module' }

// Independent source-catalog receipt from 2026-10-18, including the 14 additions.
const liveColumns = [
  ['id', 'int4', false],
  ['source_type', 'varchar', false],
  ['connector_id', 'varchar', false],
  ['run_id', 'int4', true],
  ['source_family', 'varchar', true],
  ['collection_mode', 'varchar', true],
  ['evidence', 'jsonb', false],
  ['quality_status', 'varchar', false],
  ['record_type', 'varchar', false],
  ['source_id', 'varchar', false],
  ['record_key', 'varchar', false],
  ['source_url', 'text', false],
  ['title', 'varchar', false],
  ['text', 'text', false],
  ['author', 'jsonb', false],
  ['published_at', 'varchar', true],
  ['metrics', 'jsonb', false],
  ['media', 'jsonb', false],
  ['attributes', 'jsonb', false],
  ['raw', 'jsonb', true],
  ['first_seen_at', 'timestamptz', false],
  ['last_seen_at', 'timestamptz', false],
  ['created_at', 'timestamptz', false],
  ['tag', 'varchar', true],
  ['storage_schema_version', 'int4', false],
  ['source_key', 'text', true],
  ['source_name', 'text', true],
  ['publisher_name', 'text', true],
  ['content_kind', 'varchar', true],
  ['content_status', 'varchar', true],
  ['has_full_text', 'bool', true],
  ['summary', 'text', true],
  ['published_at_utc', 'timestamptz', true],
  ['published_date', 'date', true],
  ['published_at_precision', 'varchar', true],
  ['published_at_status', 'varchar', true],
  ['fetch_transport', 'varchar', true],
  ['standardization_warnings', 'jsonb', true],
].map(([name, databaseType, nullable]) => ({ name, databaseType, nullable }))

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

async function parent(db, { live = false } = {}) {
  const columns = (live ? liveColumns : CRAWLER_SOURCE_COLUMN_CONTRACT).map(column =>
    `"${column.name}" ${column.name === 'tag' ? 'varchar(128)' : column.databaseType}${column.nullable ? '' : ' NOT NULL'}`)
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

test('runtime audit embeds the same catalog SQL and optional column contract', () => {
  const runtime = readFileSync(new URL('../../scripts/night-all-a-runtime-audit.py', import.meta.url), 'utf8')
  const embedded = runtime.match(/SOURCE_AUDIT_SQL = r"""([\s\S]*?)"""/u)?.[1]
  assert.ok(embedded)
  assert.equal(embedded.trim(), sql.replace(/\s*ROLLBACK;\s*$/u, '').trim())
})

test('actual source audit accepts the live 38-column schema on all 14 leaves and matches runtime contracts without reading or changing records', postgres, async t => {
  const db = await database(t)
  await parent(db, { live: true })
  for (const type of [...CRAWLER_SOURCE_TYPES, 'tender']) {
    await db.exec(`CREATE TABLE public.saved_records_${type} PARTITION OF public.saved_records FOR VALUES IN ('${type}')`)
  }
  await db.exec(`CREATE UNIQUE INDEX news_cursor ON public.saved_records_news(last_seen_at, id);
    CREATE INDEX finance_nonunique ON public.saved_records_finance(last_seen_at, id);
    CREATE UNIQUE INDEX forum_wrong_order ON public.saved_records_forum(id, last_seen_at);
    CREATE UNIQUE INDEX social_desc ON public.saved_records_social(last_seen_at DESC, id);
    CREATE UNIQUE INDEX web_partial ON public.saved_records_web(last_seen_at, id) WHERE id > 0;
    CREATE UNIQUE INDEX media_include ON public.saved_records_media(last_seen_at, id) INCLUDE(title);`)
  const values = Object.fromEntries(liveColumns.map(column => [column.name,
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
  assert.equal(report.expectedColumnContract.filter(column => column.optional).length, 15)
  const expectedContract = liveColumns.map((column, index) => ({ ...column, optional: index >= 23 }))
    .sort((left, right) => left.name.localeCompare(right.name))
  assert.deepEqual(report.expectedColumnContract, expectedContract)
  assert.deepEqual([...CRAWLER_SOURCE_COLUMN_CONTRACT, ...CRAWLER_OPTIONAL_SOURCE_COLUMN_CONTRACT], liveColumns)
  for (const relation of [report.parent, ...report.partitions]) {
    assert.equal(relation.columnCount, 38)
    assert.equal(relation.columnsComplete, true)
    assert.deepEqual(relation.columns.map(({ name, databaseType, nullable }) => ({ name, databaseType, nullable })), liveColumns)
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

test('actual source audit and runtime both reject optional-column type, nullability and unknown-column drift on all 14 leaves', postgres, async t => {
  const db = await database(t)
  await parent(db, { live: true })
  for (const type of [...CRAWLER_SOURCE_TYPES, 'tender']) {
    await db.exec(`CREATE TABLE public.saved_records_${type} PARTITION OF public.saved_records FOR VALUES IN ('${type}')`)
  }
  const cases = [
    {
      change: 'ALTER TABLE public.saved_records ALTER COLUMN storage_schema_version TYPE bigint',
      restore: 'ALTER TABLE public.saved_records ALTER COLUMN storage_schema_version TYPE int4',
      mismatches: [{ name: 'storage_schema_version', expectedType: 'int4', actualType: 'int8',
        actualTypeSchema: 'pg_catalog', expectedNullable: false, actualNullable: false }],
      unexpected: [],
      issues: ['crawler column storage_schema_version must use PostgreSQL int4'],
    },
    {
      change: `ALTER TABLE public.saved_records ALTER COLUMN storage_schema_version DROP NOT NULL;
        ALTER TABLE public.saved_records ALTER COLUMN has_full_text SET NOT NULL`,
      restore: `ALTER TABLE public.saved_records ALTER COLUMN storage_schema_version SET NOT NULL;
        ALTER TABLE public.saved_records ALTER COLUMN has_full_text DROP NOT NULL`,
      mismatches: [
        { name: 'has_full_text', expectedType: 'bool', actualType: 'bool',
          actualTypeSchema: 'pg_catalog', expectedNullable: true, actualNullable: false },
        { name: 'storage_schema_version', expectedType: 'int4', actualType: 'int4',
          actualTypeSchema: 'pg_catalog', expectedNullable: false, actualNullable: true },
      ],
      unexpected: [],
      issues: ['crawler column has_full_text must be nullable', 'crawler column storage_schema_version must be non-null'],
    },
    {
      change: 'ALTER TABLE public.saved_records ADD COLUMN extra_review_required text',
      restore: 'ALTER TABLE public.saved_records DROP COLUMN extra_review_required',
      mismatches: [],
      unexpected: ['extra_review_required'],
      issues: ['unexpected crawler column extra_review_required requires mapping review'],
    },
  ]
  for (const scenario of cases) {
    await db.exec(scenario.change)
    const report = await audit(db)
    assert.equal(report.partitions.length, 14)
    for (const relation of [report.parent, ...report.partitions]) {
      assert.deepEqual(relation.missingColumns, [], relation.table)
      assert.deepEqual(relation.columnMismatches, scenario.mismatches, relation.table)
      assert.deepEqual(relation.unexpectedColumns, scenario.unexpected, relation.table)
      assert.deepEqual(crawlerColumnIssues(relation.columns).sort(), scenario.issues, relation.table)
    }
    await db.exec(scenario.restore)
  }
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
