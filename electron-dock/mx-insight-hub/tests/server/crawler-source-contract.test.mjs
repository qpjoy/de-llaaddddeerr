import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  CRAWLER_MAPPING_VERSION,
  CRAWLER_PIPELINE_KEY,
  CRAWLER_SOURCES,
  CRAWLER_SOURCE_COLUMN_CONTRACT,
  CRAWLER_SOURCE_COLUMNS,
  CRAWLER_SOURCE_TYPES,
  crawlerCursorIndexIssues,
  crawlerCursorIsFinite,
  crawlerLeafPartitionIssues,
  crawlerProbeIssues,
  crawlerReservedScopeIssue,
  crawlerSourceRowIssues,
  crawlerSourceContractIssues,
  isCrawlerSourceKey,
} from '../../server/ingest/crawler/source-contract.mjs'

const SOURCE_TYPES = [
  'automotive',
  'finance',
  'forum',
  'hotspot',
  'local_news',
  'media',
  'news',
  'other',
  'recruitment',
  'research',
  'social',
  'technology',
  'web',
]

const REQUIRED_NON_NULL_COLUMNS = new Set([
  'id',
  'source_type',
  'connector_id',
  'evidence',
  'quality_status',
  'record_type',
  'source_id',
  'record_key',
  'source_url',
  'title',
  'text',
  'author',
  'metrics',
  'media',
  'attributes',
  'first_seen_at',
  'last_seen_at',
  'created_at',
])
const NULLABLE_COLUMNS = new Set([
  'run_id',
  'source_family',
  'collection_mode',
  'published_at',
  'raw',
])
function sourceFor(spec) {
  return {
    sourceKey: spec.sourceKey,
    sourceKind: 'database',
    datasetId: spec.datasetId,
    platform: spec.platform,
    objectType: spec.objectType,
    connection: {
      host: 'source.internal',
      port: 5432,
      database: 'agent_data_crawler_platform',
      username: 'crawler_reader',
      password: 'not-returned-by-the-contract',
      sslMode: 'require',
      ...spec.locator,
    },
  }
}

function describedSource(spec) {
  return {
    sourceKey: spec.sourceKey,
    displayName: spec.displayName,
    datasetId: spec.datasetId,
    platform: spec.platform,
    objectType: spec.objectType,
    status: 'paused',
    schema: spec.locator.schema,
    table: spec.locator.table,
  }
}

function validColumns() {
  return CRAWLER_SOURCE_COLUMN_CONTRACT.map((column) => ({ ...column }))
}

test('crawler source constants fix thirteen independently authorized leaf contracts', () => {
  assert.equal(CRAWLER_PIPELINE_KEY, 'night-all-saved-records')
  assert.equal(CRAWLER_MAPPING_VERSION, 1)
  assert.deepEqual(CRAWLER_SOURCE_TYPES, SOURCE_TYPES)
  assert.equal(CRAWLER_SOURCES.length, 13)
  assert.equal(new Set(CRAWLER_SOURCES.map((spec) => spec.sourceKey)).size, 13)
  assert.equal(new Set(CRAWLER_SOURCES.map((spec) => spec.sourceId)).size, 13)
  assert.equal(new Set(CRAWLER_SOURCES.map((spec) => spec.mappingId)).size, 13)
  assert.equal(new Set(CRAWLER_SOURCES.map((spec) => spec.datasetId)).size, 13)
  assert.equal(new Set(CRAWLER_SOURCES.map((spec) => spec.platform)).size, 13)

  for (const spec of CRAWLER_SOURCES) {
    const urlType = spec.sourceType.replaceAll('_', '-')
    assert.equal(spec.sourceKey, `night-all-saved-records-${urlType}`)
    assert.equal(spec.datasetId, `data-center.saved-records.${spec.sourceType}.v1`)
    assert.equal(spec.platform, `data_center_saved_records_${spec.sourceType}`)
    assert.equal(spec.objectType, 'saved_record')
    assert.deepEqual(spec.locator, {
      schema: 'public',
      table: `saved_records_${spec.sourceType}`,
      cursorColumn: 'last_seen_at',
      idColumn: 'id',
    })
    assert.equal(isCrawlerSourceKey(spec.sourceKey), true)
    assert.equal(isCrawlerSourceKey(`night-all-saved-records-${spec.sourceType}-other`), false)
    assert.deepEqual(crawlerReservedScopeIssue({ datasetId: spec.datasetId }), {
      field: 'datasetId', value: spec.datasetId,
    })
    assert.deepEqual(crawlerReservedScopeIssue({ platform: spec.platform }), {
      field: 'platform', value: spec.platform,
    })
    assert.equal(crawlerReservedScopeIssue({
      datasetId: `${spec.datasetId}.archive`,
      platform: `${spec.platform}_archive`,
    }), null)
    assert.equal(Object.isFrozen(spec), true)
    assert.equal(Object.isFrozen(spec.locator), true)
  }
  assert.equal(isCrawlerSourceKey('night-all-saved-records-local_news'), false)
  assert.equal(isCrawlerSourceKey('night-all-saved-records-local-news'), true)
})

test('crawler source and value-free probe contracts reject fixed identity drift', () => {
  for (const spec of CRAWLER_SOURCES) {
    assert.deepEqual(crawlerSourceContractIssues(sourceFor(spec), spec), [])
    assert.deepEqual(crawlerProbeIssues({
      source: describedSource(spec),
      columns: validColumns(),
      issues: [],
    }, spec), [])
  }

  const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceType === 'local_news')
  assert.deepEqual(crawlerSourceContractIssues({
    ...sourceFor(spec),
    platform: 'data_center_saved_records_news',
    connection: { ...sourceFor(spec).connection, table: 'saved_records', token: 'not-allowed' },
  }, spec), [
    `Fixed crawler source platform must be ${spec.platform}`,
    'Fixed crawler source connection.table must be saved_records_local_news',
    'Fixed crawler source connection field token is not allowed',
  ])
  assert.deepEqual(crawlerProbeIssues({
    source: { ...describedSource(spec), table: 'saved_records' },
    columns: validColumns(),
  }, spec), [
    'Fixed crawler probe source table must be saved_records_local_news',
  ])
  assert.deepEqual(crawlerProbeIssues({}, null), [
    'Crawler source specification is missing or unknown',
  ])
})

test('crawler probe fixes the reviewed 23-column types and nullability', () => {
  const spec = CRAWLER_SOURCES[0]
  const columns = validColumns()
  assert.equal(columns.length, 23)
  assert.equal(REQUIRED_NON_NULL_COLUMNS.size, 18)
  assert.equal(NULLABLE_COLUMNS.size, 5)
  assert.deepEqual(new Set([...REQUIRED_NON_NULL_COLUMNS, ...NULLABLE_COLUMNS]), new Set(CRAWLER_SOURCE_COLUMNS))

  for (const name of REQUIRED_NON_NULL_COLUMNS) {
    const nullable = columns.map((column) => (
      column.name === name ? { ...column, nullable: true } : column
    ))
    assert.deepEqual(crawlerProbeIssues({ columns: nullable }, spec), [
      `crawler column ${name} must be non-null`,
    ], name)
  }
  for (const name of NULLABLE_COLUMNS) {
    assert.equal(columns.find((column) => column.name === name).nullable, true)
  }

  assert.deepEqual(crawlerProbeIssues({
    issues: ['no unique index proves (last_seen_at, id) is a total order'],
    columns: [
      ...columns.filter((column) => column.name !== 'title'),
      { name: 'new_column', databaseType: 'text', nullable: true },
    ],
  }, spec), [
    'no unique index proves (last_seen_at, id) is a total order',
    'required crawler column title is missing',
    'unexpected crawler column new_column requires mapping review',
  ])

  const wrongTypes = columns.map((column) => {
    if (column.name === 'id') return { ...column, databaseType: 'uuid' }
    if (column.name === 'last_seen_at') return { ...column, databaseType: 'text' }
    if (column.name === 'record_key') return { ...column, databaseType: 'jsonb' }
    if (column.name === 'evidence') return { ...column, databaseType: 'text' }
    return column
  })
  assert.deepEqual(crawlerProbeIssues({ columns: wrongTypes }, spec), [
    'crawler column id must use PostgreSQL int4',
    'crawler column evidence must use PostgreSQL jsonb',
    'crawler column record_key must use PostgreSQL varchar',
    'crawler column last_seen_at must use PostgreSQL timestamptz',
  ])

  const tightenedNullable = columns.map((column) => (
    column.name === 'raw' ? { ...column, nullable: false } : column
  ))
  assert.deepEqual(crawlerProbeIssues({ columns: tightenedNullable }, spec), [
    'crawler column raw must be nullable',
  ])
})

test('crawler physical contract fixes leaf identity, cursor index, row values, and finite watermarks', () => {
  const spec = CRAWLER_SOURCES.find((candidate) => candidate.sourceType === 'news')
  const relation = {
    relationKind: 'r',
    isPartition: true,
    isLeaf: true,
    parentSchema: 'public',
    parentTable: 'saved_records',
    parentRelationKind: 'p',
    parentPartitionKey: 'LIST (source_type)',
    partitionBound: "FOR VALUES IN ('news')",
  }
  const index = {
    valid: true,
    ready: true,
    live: true,
    unique: true,
    accessMethod: 'btree',
    noExpressions: true,
    noPredicate: true,
    keyCount: 2,
    totalColumns: 2,
    firstKey: 'last_seen_at',
    secondKey: 'id',
    firstOption: 0,
    secondOption: 0,
  }

  assert.deepEqual(crawlerLeafPartitionIssues(relation, spec), [])
  assert.deepEqual(crawlerCursorIndexIssues([index], spec), [])
  assert.deepEqual(crawlerSourceRowIssues([{ source_type: 'news' }], spec), [])
  assert.equal(crawlerCursorIsFinite('2026-09-09 03:05:00+00'), true)
  assert.equal(crawlerCursorIsFinite(new Date('2026-09-09T03:05:00.000Z')), true)
  assert.equal(crawlerCursorIsFinite('infinity'), false)
  assert.equal(crawlerCursorIsFinite('-infinity'), false)

  assert.deepEqual(crawlerLeafPartitionIssues({
    ...relation,
    parentTable: 'saved_records_archive',
    partitionBound: "FOR VALUES IN ('finance')",
  }, spec), [
    'crawler source relation must be a direct child of public.saved_records',
    "crawler source partition bound must be FOR VALUES IN ('news')",
  ])
  assert.deepEqual(crawlerCursorIndexIssues([{ ...index, unique: false }], spec), [
    'crawler source requires an exact live unique btree (last_seen_at, id) index',
  ])
  assert.deepEqual(crawlerSourceRowIssues([{ source_type: 'finance' }], spec), [
    'crawler source returned a row outside source_type news',
  ])
})

test('migration 066 seeds only paused credential-free sources and unapproved narrow mappings', async () => {
  const sql = await readFile(
    new URL('../../migrations/066_night_all_saved_records_sources.sql', import.meta.url),
    'utf8',
  )

  assert.equal((sql.match(/^\s*'paused',$/gmu) || []).length, 13)
  assert.doesNotMatch(sql, /"(?:host|port|database|username|password|dsnEnv)"/u)
  assert.doesNotMatch(
    sql,
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:platform_grants|api_key_platform_entitlements)\b/iu,
  )
  assert.match(sql, /FROM platform_grants grant_record/u)
  assert.match(sql, /FROM api_key_platform_entitlements entitlement/u)
  assert.match(sql, /api_key_record\.scope_mode = 'snapshot'/u)
  assert.match(sql, /api_key_record\.status = 'active'/u)
  assert.match(sql, /api_key_record\.expires_at > now\(\)/u)
  assert.match(sql, /reserved crawler public authorization scope already exists/u)
  assert.match(
    sql,
    /LOCK TABLE platform_grants, api_key_platform_entitlements IN SHARE MODE/u,
  )
  assert.ok(
    sql.indexOf('LOCK TABLE platform_grants') < sql.indexOf('FROM platform_grants grant_record'),
  )
  for (const spec of CRAWLER_SOURCES) {
    for (const value of [
      spec.sourceId,
      spec.mappingId,
      spec.sourceKey,
      spec.datasetId,
      spec.platform,
      spec.locator.table,
    ]) assert.ok(sql.includes(value), value)
  }

  const mappingInsert = sql.slice(
    sql.indexOf('INSERT INTO catalog.source_mappings'),
    sql.indexOf('-- The four populated canonical-record catalog indexes'),
  )
  assert.doesNotMatch(mappingInsert, /\bapproved_at\b|\bapproved_by\b/u)
  assert.match(mappingInsert, /"externalId":\{"from":"record_key"\}/u)
  assert.doesNotMatch(mappingInsert, /"eventTime"\s*:/u)
  for (const field of ['raw', 'evidence', 'author', 'published_at', 'metrics', 'media', 'attributes']) {
    assert.match(mappingInsert, new RegExp(`"${field}"`, 'u'), field)
  }
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX/iu)
  assert.match(sql, /dataset_id = ANY/u)
  assert.match(sql, /platform = ANY/u)
  assert.match(sql, /id = ANY/u)
  assert.match(sql, /scripts\/night-all-saved-records-hub-indexes\.sql/u)
})

test('source index operation builds and verifies thirteen exact concurrent indexes', async () => {
  const sql = await readFile(
    new URL('../../scripts/night-all-saved-records-source-indexes.sql', import.meta.url),
    'utf8',
  )

  assert.equal((sql.match(/^\s*CREATE UNIQUE INDEX CONCURRENTLY /gmu) || []).length, 13)
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START TRANSACTION|COMMIT)\b/gimu)
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS/u)
  for (const spec of CRAWLER_SOURCES) {
    const indexName = `${spec.locator.table}_last_seen_at_id_uidx`
    assert.match(sql, new RegExp(
      `CREATE UNIQUE INDEX CONCURRENTLY ${indexName}\\s+ON public\\.${spec.locator.table} \\(last_seen_at, id\\)`,
      'u',
    ))
  }
  for (const evidence of [
    'index_state.indisvalid',
    'index_state.indisready',
    'index_state.indislive',
    'index_state.indisunique',
    "access_method.amname = 'btree'",
    'index_state.indnkeyatts = 2',
    'index_state.indnatts = 2',
    'index_state.indexprs IS NULL',
    'index_state.indpred IS NULL',
    'index_state.indoption[0] = 0',
    'index_state.indoption[1] = 0',
    'count(*) = 13 AND bool_and(contract_ready)',
  ]) assert.ok(sql.includes(evidence), evidence)
  assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS public\.%I/u)
  assert.match(sql, /WHERE repairable_invalid_build/u)
  assert.doesNotMatch(sql, /WHERE index_exists\s+AND NOT contract_ready/u)
})

test('Hub catalog index operation builds four exact online indexes outside migration 066', async () => {
  const sql = await readFile(
    new URL('../../scripts/night-all-saved-records-hub-indexes.sql', import.meta.url),
    'utf8',
  )

  assert.equal((sql.match(/^\s*CREATE INDEX CONCURRENTLY /gmu) || []).length, 4)
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|START TRANSACTION|COMMIT)\b/gimu)
  assert.doesNotMatch(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/u)
  for (const indexName of [
    'canonical_crawler_publisher_catalog_idx',
    'canonical_crawler_collector_catalog_idx',
    'canonical_source_catalog_commerce_entry_idx',
    'canonical_source_catalog_platform_idx',
  ]) assert.ok(sql.includes(indexName), indexName)
  for (const expression of [
    "stable_fields #>> '{sourceCatalog,publisher,entryId}'",
    "stable_fields #>> '{sourceCatalog,collector,entryId}'",
    "stable_fields #>> '{commerce,marketplace,entryId}'",
    'lower(btrim(normalize(platform, NFKC)))',
  ]) assert.ok(sql.includes(expression), expression)
  assert.match(sql, /i\.indnkeyatts = 1/u)
  assert.match(sql, /i\.indnatts = 1/u)
  assert.match(sql, /'lowerbtrimNORMALIZEplatform,NFKC'/u)
  assert.match(sql, /count\(\*\) = 4 AND bool_and\(contract_ready\)/u)
  assert.match(sql, /DROP INDEX CONCURRENTLY IF EXISTS core\.%I/u)
  assert.match(sql, /WHERE repairable_invalid_build/u)
  assert.doesNotMatch(sql, /deleted_at IS NULL/u)
})
