import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyMapping,
  refreshMappedPayloadSha256,
} from '../../server/ingest/external/mapping.mjs'
import { DatabaseSourcePuller } from '../../server/ingest/external/database-source.mjs'
import {
  CRAWLER_SOURCE_COLUMN_CONTRACT,
  CRAWLER_WRITER_CONTRACT_DIGEST,
  CRAWLER_WRITER_CONTRACT_VERSION,
} from '../../server/ingest/crawler/source-contract.mjs'
import {
  createCrawlerCatalogClassifier,
  enrichCrawlerRecord,
  parseCrawlerPublishedAt,
} from '../../server/ingest/crawler/record.mjs'

const CRAWLER_SOURCE = { sourceKey: 'night-all-saved-records-news' }

function crawlerDatabaseColumns(transform = (column) => column) {
  const dataTypes = {
    int4: 'integer',
    varchar: 'character varying',
    text: 'text',
    jsonb: 'jsonb',
    timestamptz: 'timestamp with time zone',
  }
  return CRAWLER_SOURCE_COLUMN_CONTRACT.map((column, index) => {
    const value = transform({ ...column }, index)
    return {
      column_name: value.name,
      data_type: dataTypes[value.databaseType] ?? value.databaseType,
      udt_name: value.databaseType,
      is_nullable: value.nullable ? 'YES' : 'NO',
      ordinal_position: index + 1,
    }
  })
}

function crawlerLeafRelation(overrides = {}) {
  return {
    relation_kind: 'r',
    is_partition: true,
    is_leaf: true,
    parent_schema: 'public',
    parent_table: 'saved_records',
    parent_relation_kind: 'p',
    parent_partition_key: 'LIST (source_type)',
    partition_bound: "FOR VALUES IN ('news')",
    ...overrides,
  }
}

function crawlerCursorIndex(overrides = {}) {
  return {
    name: 'saved_records_news_last_seen_at_id_uidx',
    definition: 'CREATE UNIQUE INDEX saved_records_news_last_seen_at_id_uidx ON public.saved_records_news USING btree (last_seen_at, id)',
    valid: true,
    ready: true,
    live: true,
    unique_index: true,
    access_method: 'btree',
    no_expressions: true,
    no_predicate: true,
    key_count: 2,
    total_columns: 2,
    first_key: 'last_seen_at',
    second_key: 'id',
    first_option: 0,
    second_option: 0,
    ...overrides,
  }
}

function crawlerPullSource() {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    sourceKey: CRAWLER_SOURCE.sourceKey,
    sourceKind: 'database',
    datasetId: 'data-center.saved-records.news.v1',
    platform: 'data_center_saved_records_news',
    objectType: 'saved_record',
    status: 'active',
    connection: {
      host: 'crawler.internal',
      database: 'agent_data_crawler_platform',
      username: 'readonly',
      password: 'test-only',
      sslMode: 'disable',
      schema: 'public',
      table: 'saved_records_news',
      cursorColumn: 'last_seen_at',
      idColumn: 'id',
    },
  }
}

function crawlerPullMapping(source = crawlerPullSource()) {
  return {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    sourceId: source.id,
    version: 1,
    fieldMap: {
      externalId: { from: 'record_key' },
      url: { from: 'source_url' },
      title: { from: 'title' },
      body: { from: 'text' },
      eventTime: { from: 'published_at', type: 'timestamp', timezoneOffsetMinutes: 480 },
      collectedAt: { from: 'last_seen_at', type: 'timestamp' },
    },
  }
}

function crawlerRuntimeContractHarness({
  sourceOverrides = {},
  columns = crawlerDatabaseColumns(),
  relation = crawlerLeafRelation(),
  indexes = [crawlerCursorIndex()],
  rows = [rawFixture()],
  position = {},
  committedBatch = null,
  progressRow = null,
  watermarkEndpoints = {
    minimum_cursor: '2026-09-09 03:05:00+00',
    maximum_cursor: '2026-09-09 03:05:00+00',
  },
  attestation = {
    contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
    contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
  },
} = {}) {
  const baseSource = crawlerPullSource()
  const source = {
    ...baseSource,
    ...sourceOverrides,
    connection: { ...baseSource.connection, ...(sourceOverrides.connection || {}) },
  }
  const mapping = crawlerPullMapping(source)
  const state = { importStarts: 0, pageReads: 0, poolsOpened: 0, cursorWrites: [] }
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      getLatestPipelineWriterContractAttestation: async () => attestation,
      getImportBatch: async () => committedBatch,
      startImportRun: async () => {
        state.importStarts += 1
        return { id: 'unexpected-crawler-run', duplicateOf: null }
      },
      finishImportRun: async () => {},
    },
    queue: {
      getCursor: async () => ({ position }),
      saveCursor: async (_id, nextPosition, options) => {
        state.cursorWrites.push({ position: nextPosition, options })
        return { position: nextPosition, status: options.status }
      },
    },
    poolFactory: () => {
      state.poolsOpened += 1
      return {
        async query(sql) {
          if (sql.includes('information_schema.columns')) return { rows: columns }
          if (sql.includes('c.relkind AS relation_kind')) return { rows: relation ? [relation] : [] }
          if (sql.includes('i.indislive AS live')) return { rows: indexes }
          if (sql.includes('FROM pg_constraint')) return { rows: [] }
          if (sql.includes('information_schema.triggers')) return { rows: [] }
          if (sql.includes('AS minimum_cursor') && sql.includes('AS maximum_cursor')) {
            return { rows: [watermarkEndpoints] }
          }
          if (progressRow && sql.includes('count(*)::bigint AS total_rows')) {
            return { rows: [progressRow] }
          }
          state.pageReads += 1
          const alias = sql.match(/"last_seen_at"::text AS "([^"]+)"/u)?.[1]
          assert.ok(alias, sql)
          return { rows: rows.map((row) => ({
            ...row,
            [alias]: row.last_seen_at instanceof Date
              ? '2026-09-09 03:05:00+00'
              : String(row.last_seen_at),
          })) }
        },
        async end() {},
      }
    },
  })
  return { puller, source, state }
}

function catalogEntry({
  id,
  sourceKey,
  revision = 1,
  canonicalName,
  aliases = [],
  sourceKind = 'platform',
  majorCategory = '国内社媒与内容平台',
  archivedAt = null,
}) {
  return {
    id,
    sourceKey,
    revision,
    canonicalName,
    aliases,
    sourceKind,
    parentSourceId: null,
    majorCategory,
    scenarios: ['新闻/媒体'],
    regions: ['中国大陆'],
    archivedAt,
    privateCredential: 'must-not-leak',
  }
}

const NEWS_WEBSITE = catalogEntry({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceKey: 'source-catalog-0149',
  canonicalName: '新闻网站',
  sourceKind: 'source_class',
  majorCategory: '搜索引擎与开放网络',
})
const GOOGLE_NEWS = catalogEntry({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sourceKey: 'source-catalog-0147',
  canonicalName: 'Google News',
  sourceKind: 'source_class',
  majorCategory: '搜索引擎与开放网络',
})
const THE_PAPER = catalogEntry({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  sourceKey: 'source-catalog-0023',
  revision: 7,
  canonicalName: '澎湃新闻',
})
const BAIJIA = catalogEntry({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  sourceKey: 'source-catalog-0013',
  canonicalName: '百家号',
})

test('crawler published_at parsing is strict, deterministic, and preserves source precision', () => {
  assert.deepEqual(parseCrawlerPublishedAt(' 2026-09-09T01:41:00+00:00 '), {
    raw: ' 2026-09-09T01:41:00+00:00 ',
    normalized: '2026-09-09T01:41:00+00:00',
    status: 'parsed',
    precision: 'second',
    timezone: '+00:00',
    timezoneSource: 'explicit-offset',
    instant: '2026-09-09T01:41:00.000Z',
    trimmed: true,
    issues: ['surrounding-whitespace'],
  })
  assert.equal(
    parseCrawlerPublishedAt('2026-09-09T10:53:34+08:00').instant,
    '2026-09-09T02:53:34.000Z',
  )

  const minute = parseCrawlerPublishedAt('2026-09-09 11:00')
  assert.equal(minute.instant, '2026-09-09T03:00:00.000Z')
  assert.equal(minute.precision, 'minute')
  assert.equal(minute.timezone, 'Asia/Shanghai')
  assert.equal(minute.timezoneSource, 'assumed')

  const second = parseCrawlerPublishedAt('2026-09-09T08:26:25')
  assert.equal(second.instant, '2026-09-09T00:26:25.000Z')
  assert.equal(second.precision, 'second')
  assert.equal(second.timezone, 'Asia/Shanghai')

  const dateOnly = parseCrawlerPublishedAt(' 2026-09-08 ')
  assert.equal(dateOnly.status, 'date-only')
  assert.equal(dateOnly.precision, 'date')
  assert.equal(dateOnly.instant, null)
  assert.equal(dateOnly.timezone, null)
  assert.equal(dateOnly.raw, ' 2026-09-08 ')
  assert.equal(dateOnly.normalized, '2026-09-08')

  const invalidCalendar = parseCrawlerPublishedAt('2026-02-31 08:00:00')
  assert.equal(invalidCalendar.status, 'invalid')
  assert.equal(invalidCalendar.instant, null)
  assert.deepEqual(invalidCalendar.issues, ['invalid-calendar-date'])

  const unsupportedEpoch = parseCrawlerPublishedAt('1788436909000')
  assert.equal(unsupportedEpoch.status, 'invalid')
  assert.equal(unsupportedEpoch.raw, '1788436909000')
  assert.deepEqual(unsupportedEpoch.issues, ['unsupported-format'])
  assert.equal(parseCrawlerPublishedAt('   ').status, 'missing')
})

test('crawler catalog classification uses only the supplied active snapshot', () => {
  const classify = createCrawlerCatalogClassifier([
    NEWS_WEBSITE,
    GOOGLE_NEWS,
    THE_PAPER,
    { ...BAIJIA, archivedAt: '2026-09-01T00:00:00.000Z' },
  ])

  const publisher = classify(['thepaper', '澎湃新闻'])
  assert.equal(publisher.status, 'mapped')
  assert.equal(publisher.sourceValue, 'thepaper')
  assert.equal(publisher.entryId, THE_PAPER.id)
  assert.equal(publisher.sourceKey, THE_PAPER.sourceKey)
  assert.equal(publisher.revision, 7)
  assert.equal(JSON.stringify(publisher).includes('must-not-leak'), false)

  const collector = classify(['china-news'], { preferredSourceKey: NEWS_WEBSITE.sourceKey })
  assert.equal(collector.status, 'mapped')
  assert.equal(collector.entryId, NEWS_WEBSITE.id)

  assert.deepEqual(classify(['baijia'], { preferredSourceKey: BAIJIA.sourceKey }), {
    status: 'unresolved',
    sourceValue: 'baijia',
    entryId: null,
    sourceKey: null,
    revision: null,
    canonicalName: null,
    majorCategory: null,
    scenarios: [],
    regions: [],
  })
  assert.equal(classify(['unknown-provider']).status, 'unresolved')
})

test('crawler enrichment keeps identity and lineage while separating collector and publisher facets', () => {
  const classifyCatalog = createCrawlerCatalogClassifier([NEWS_WEBSITE, THE_PAPER])
  const record = {
    externalId: 'record-key-1',
    title: '测试新闻',
    eventTime: new Date('2026-09-09T11:00:00.000Z'),
    stableFields: { attributes: { existing: 'kept' } },
  }
  const raw = {
    id: 71,
    source_type: 'news',
    record_type: 'news.article',
    connector_id: 'china-news',
    source_family: 'china-news',
    collection_mode: 'protocol',
    quality_status: 'unverified',
    run_id: 9,
    source_id: 'thepaper:example',
    record_key: 'record-key-1',
    published_at: ' 2026-09-09 11:00 ',
    first_seen_at: new Date('2026-09-09T03:05:00.000Z'),
    last_seen_at: new Date('2026-09-09T03:20:00.000Z'),
    created_at: new Date('2026-09-09T03:05:00.100Z'),
    author: {
      name: '记者甲',
      organization: '澎湃新闻编辑部',
      privateCredential: 'must-not-leak',
    },
    attributes: {
      platform: 'thepaper',
      platform_name: '澎湃新闻',
      section: 'news',
      tags: ['china-news', 'thepaper'],
    },
    raw: { private: 'restricted-raw' },
    evidence: [{ private: 'restricted-evidence' }],
  }

  const enriched = enrichCrawlerRecord(record, raw, CRAWLER_SOURCE, { classifyCatalog })
  assert.equal(enriched, record)
  assert.equal(record.eventTime.toISOString(), '2026-09-09T03:00:00.000Z')
  assert.equal(record.stableFields.attributes.existing, 'kept')
  assert.deepEqual(record.stableFields.crawler.identity, {
    rowId: '71',
    sourceId: 'thepaper:example',
    recordKey: 'record-key-1',
    canonicalExternalId: 'record-key-1',
  })
  assert.equal(record.stableFields.crawler.publication.eligibility, 'candidate')
  assert.equal(record.authorName, '记者甲')
  assert.equal(record.stableFields.author.name, '记者甲')
  assert.deepEqual(record.stableFields.crawler.lineage.author, {
    name: '记者甲',
    organization: '澎湃新闻编辑部',
  })
  assert.equal(record.editedAt.toISOString(), '2026-09-09T03:20:00.000Z')
  assert.equal(record.stableFields.editedAt.toISOString(), '2026-09-09T03:20:00.000Z')
  assert.equal(record.stableFields.crawler.publishedAt.precision, 'minute')
  assert.equal(record.stableFields.crawler.publishedAt.timezone, 'Asia/Shanghai')
  assert.deepEqual(record.stableFields.crawler.publishedAt.issues, ['surrounding-whitespace'])
  assert.equal(record.stableFields.sourceCatalog.collector.entryId, NEWS_WEBSITE.id)
  assert.equal(record.stableFields.sourceCatalog.publisher.entryId, THE_PAPER.id)
  assert.deepEqual(record.stableFields.tags, ['china-news', 'thepaper'])
  const safeEnrichment = JSON.stringify({
    crawler: record.stableFields.crawler,
    sourceCatalog: record.stableFields.sourceCatalog,
  })
  assert.equal(safeEnrichment.includes('restricted-raw'), false)
  assert.equal(safeEnrichment.includes('restricted-evidence'), false)
  assert.equal(safeEnrichment.includes('must-not-leak'), false)
})

test('crawler enrichment keeps date-only and semantic anomalies without inventing publication instants', () => {
  const classifyCatalog = createCrawlerCatalogClassifier([BAIJIA])
  const record = {
    externalId: 'mapped-id-that-is-not-the-record-key',
    eventTime: new Date('2026-09-08T00:00:00.000Z'),
    stableFields: {},
  }
  enrichCrawlerRecord(record, {
    id: 8,
    source_type: 'news',
    record_type: 'account.check',
    connector_id: 'baijia',
    source_family: 'baijia',
    record_key: 'record-key-8',
    published_at: '2026-09-08',
    first_seen_at: new Date('2026-09-08T05:00:00.000Z'),
    last_seen_at: new Date('2026-09-08T05:00:00.000Z'),
    created_at: new Date('2026-09-08T05:00:00.100Z'),
    attributes: { tags: ['baijia'] },
  }, CRAWLER_SOURCE, { classifyCatalog })

  assert.equal(record.eventTime, null)
  assert.equal(record.stableFields.crawler.publishedAt.status, 'date-only')
  assert.equal(record.stableFields.crawler.publishedAt.instant, null)
  assert.equal(record.stableFields.crawler.publication.eligibility, 'internal')
  assert.deepEqual(record.stableFields.crawler.semanticIssues, [
    'canonical-external-id-differs-from-record-key',
  ])
  assert.equal(record.stableFields.sourceCatalog.collector.entryId, BAIJIA.id)
  assert.equal(record.stableFields.sourceCatalog.publisher.status, 'unresolved')

  const future = { externalId: 'future-key', title: '未来时间样本', stableFields: {} }
  enrichCrawlerRecord(future, {
    id: 9,
    source_type: 'news',
    record_type: 'news',
    connector_id: 'google-news',
    source_family: 'google-news',
    record_key: 'future-key',
    published_at: '2026-09-09T04:00:00+00:00',
    first_seen_at: new Date('2026-09-09T03:00:00.000Z'),
    last_seen_at: new Date('2026-09-09T03:00:00.000Z'),
    created_at: new Date('2026-09-09T03:00:00.100Z'),
    attributes: { tags: ['google-news'] },
  }, CRAWLER_SOURCE, { classifyCatalog })
  assert.equal(future.eventTime.toISOString(), '2026-09-09T04:00:00.000Z')
  assert.deepEqual(future.stableFields.crawler.semanticIssues, ['published-after-first-seen'])
  assert.equal(future.stableFields.crawler.publication.eligibility, 'candidate')

  const unrelated = { eventTime: 'unchanged', stableFields: {} }
  assert.equal(
    enrichCrawlerRecord(unrelated, rawFixture(), { sourceKey: 'warehouse-events' }, { classifyCatalog }),
    unrelated,
  )
  assert.deepEqual(unrelated, { eventTime: 'unchanged', stableFields: {} })
})

test('crawler enrichment quarantines clear URL-year conflicts and requires content for publication', () => {
  const conflict = {
    externalId: 'conflict-key',
    title: '年份冲突样本',
    url: 'https://news.example.test/2026/08/record.html',
    stableFields: {},
  }
  enrichCrawlerRecord(conflict, {
    id: 10,
    source_type: 'news',
    record_type: 'news.article',
    record_key: 'conflict-key',
    source_url: conflict.url,
    published_at: '2019-08-30 12:00:00',
    first_seen_at: new Date('2026-08-30T05:00:00.000Z'),
    last_seen_at: new Date('2026-08-30T05:00:00.000Z'),
    created_at: new Date('2026-08-30T05:00:00.100Z'),
  }, CRAWLER_SOURCE)

  assert.equal(conflict.eventTime, null)
  assert.equal(conflict.stableFields.crawler.publishedAt.status, 'parsed')
  assert.equal(conflict.stableFields.crawler.publishedAt.semanticStatus, 'conflict')
  assert.equal(conflict.stableFields.crawler.publishedAt.instant, '2019-08-30T04:00:00.000Z')
  assert.deepEqual(conflict.stableFields.crawler.publishedAt.conflict, {
    kind: 'source-url-year',
    publishedYear: 2019,
    sourceUrlYear: 2026,
  })
  assert.ok(conflict.stableFields.crawler.publishedAt.issues.includes('source-url-year-conflict'))
  assert.ok(conflict.stableFields.crawler.semanticIssues.includes(
    'published-year-conflicts-with-source-url',
  ))
  assert.equal(conflict.stableFields.crawler.publication.eligibility, 'candidate')

  const matchingHistory = {
    externalId: 'history-key',
    body: '历史新闻正文',
    url: 'https://news.example.test/archive/2024/07/record.html',
    stableFields: {},
  }
  enrichCrawlerRecord(matchingHistory, {
    id: 11,
    source_type: 'news',
    record_type: 'news',
    record_key: 'history-key',
    source_url: matchingHistory.url,
    published_at: '2024-07-15T09:30:00+08:00',
    first_seen_at: new Date('2026-08-30T05:00:00.000Z'),
    last_seen_at: new Date('2026-08-30T05:00:00.000Z'),
    created_at: new Date('2026-08-30T05:00:00.100Z'),
  }, CRAWLER_SOURCE)
  assert.equal(matchingHistory.eventTime.toISOString(), '2024-07-15T01:30:00.000Z')
  assert.equal(matchingHistory.stableFields.crawler.publishedAt.semanticStatus, undefined)
  assert.equal(matchingHistory.stableFields.crawler.publication.eligibility, 'candidate')

  const urlOnlyArticle = {
    externalId: 'url-only-key',
    title: '  ',
    body: null,
    url: 'https://news.example.test/2026/08/url-only.html',
    stableFields: {},
  }
  enrichCrawlerRecord(urlOnlyArticle, {
    id: 12,
    source_type: 'news',
    record_type: 'news.article',
    record_key: 'url-only-key',
    source_url: urlOnlyArticle.url,
    first_seen_at: new Date('2026-08-30T05:00:00.000Z'),
    last_seen_at: new Date('2026-08-30T05:00:00.000Z'),
    created_at: new Date('2026-08-30T05:00:00.100Z'),
  }, CRAWLER_SOURCE)
  assert.deepEqual(urlOnlyArticle.stableFields.crawler.publication, {
    eligibility: 'internal',
    reason: 'content-empty',
  })
})

test('crawler catalog revision and parsed publication semantics participate in payload hashing', () => {
  const fieldMap = {
    externalId: { from: 'record_key' },
    title: { from: 'title' },
    eventTime: { from: 'published_at', type: 'timestamp', timezoneOffsetMinutes: 480 },
  }
  const raw = rawFixture()
  const first = applyMapping(raw, fieldMap, { platform: 'crawler', objectType: 'saved_record' }).record
  const second = applyMapping(raw, fieldMap, { platform: 'crawler', objectType: 'saved_record' }).record
  enrichCrawlerRecord(first, raw, CRAWLER_SOURCE, {
    classifyCatalog: createCrawlerCatalogClassifier([{ ...THE_PAPER, revision: 1 }, NEWS_WEBSITE]),
  })
  enrichCrawlerRecord(second, raw, CRAWLER_SOURCE, {
    classifyCatalog: createCrawlerCatalogClassifier([{ ...THE_PAPER, revision: 2 }, NEWS_WEBSITE]),
  })
  refreshMappedPayloadSha256(first)
  refreshMappedPayloadSha256(second)
  assert.notEqual(first.payloadSha256, second.payloadSha256)
})

test('database crawler pull enriches from one governed catalog snapshot and refreshes its digest', async () => {
  const source = crawlerPullSource()
  const mapping = crawlerPullMapping(source)
  const catalogSnapshot = [{ ...NEWS_WEBSITE, revision: 4 }, { ...THE_PAPER, revision: 8 }]
  let catalogReads = 0
  let ingested = null
  const cursorWrites = []
  const puller = new DatabaseSourcePuller({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => mapping,
      getLatestPipelineWriterContractAttestation: async () => ({
        contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
        contractDigest: CRAWLER_WRITER_CONTRACT_DIGEST,
      }),
      listSourceCatalogEntries: async (options) => {
        catalogReads += 1
        assert.deepEqual(options, { includeArchived: false })
        return catalogSnapshot
      },
      startImportRun: async () => ({ id: 'crawler-run', duplicateOf: null }),
      finishImportRun: async () => {},
      ingestExternalRecords: async (input) => {
        ingested = input
        return { ingested: input.records.length, changed: input.records.length }
      },
    },
    queue: {
      getCursor: async () => ({ position: {} }),
      saveCursor: async (_id, position, options) => {
        cursorWrites.push({ position, options })
        return { position, status: options.status }
      },
    },
    poolFactory: () => ({
      async query(sql) {
        if (sql.includes('information_schema.columns')) {
          return { rows: crawlerDatabaseColumns() }
        }
        if (sql.includes('c.relkind AS relation_kind')) {
          return { rows: [crawlerLeafRelation()] }
        }
        if (sql.includes('i.indislive AS live')) {
          return { rows: [crawlerCursorIndex()] }
        }
        if (sql.includes('AS minimum_cursor') && sql.includes('AS maximum_cursor')) {
          return {
            rows: [{
              minimum_cursor: '2026-09-09 03:05:00+00',
              maximum_cursor: '2026-09-09 03:05:00+00',
            }],
          }
        }
        const alias = sql.match(/"last_seen_at"::text AS "([^"]+)"/u)?.[1]
        assert.ok(alias, sql)
        const raw = rawFixture()
        return { rows: [{ ...raw, [alias]: '2026-09-09 03:05:00+00' }] }
      },
      async end() {},
    }),
  })

  const result = await puller.pullBatch(source.sourceKey, { batchSize: 10 })
  assert.equal(result.pulled, 1)
  assert.equal(result.done, true)
  assert.equal(catalogReads, 1)
  assert.equal(ingested.records.length, 1)
  const record = ingested.records[0]
  assert.equal(record.eventTime.toISOString(), '2026-09-09T03:00:00.000Z')
  assert.equal(record.stableFields.sourceCatalog.collector.revision, 4)
  assert.equal(record.stableFields.sourceCatalog.publisher.revision, 8)
  assert.equal(record.stableFields.crawler.publication.eligibility, 'candidate')
  assert.match(record.payloadSha256, /^[a-f0-9]{64}$/u)
  const beforeEnrichment = applyMapping(rawFixture(), mapping.fieldMap, {
    platform: source.platform,
    objectType: source.objectType,
    source: { origin: 'database', sourceKey: source.sourceKey },
  }).record.payloadSha256
  assert.notEqual(record.payloadSha256, beforeEnrichment)
  assert.ok(cursorWrites.length >= 2)
})

test('every crawler pull rechecks its fixed logical source contract before opening PostgreSQL', async () => {
  const { puller, source, state } = crawlerRuntimeContractHarness({
    sourceOverrides: { platform: 'data_center_saved_records_finance' },
  })
  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
    (error) => (
      error?.status === 409
      && error?.code === 'source_contract_mismatch'
      && error?.details?.issues?.includes(
        'Fixed crawler source platform must be data_center_saved_records_news',
      )
    ),
  )
  assert.equal(state.poolsOpened, 0)
  assert.equal(state.cursorWrites.length, 0)
})

test('every crawler page requires the current writer contract attestation before source I/O', async () => {
  for (const attestation of [
    null,
    {
      contractVersion: CRAWLER_WRITER_CONTRACT_VERSION,
      contractDigest: 'stale-digest',
    },
  ]) {
    const { puller, source, state } = crawlerRuntimeContractHarness({ attestation })
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, { batchSize: 10, chunk: 7 }),
      (error) => error?.status === 409 && error?.code === 'writer_contract_attestation_required',
    )
    assert.equal(state.poolsOpened, 0)
    assert.equal(state.importStarts, 0)
    assert.equal(state.cursorWrites.length, 0)
  }
})

test('crawler checkpoints require a complete finite tuple before probe or pull', async () => {
  for (const position of [
    { cursor: '2026-09-09 03:05:00+00' },
    { lastId: '7' },
  ]) {
    const { puller, source, state } = crawlerRuntimeContractHarness({ position })
    await assert.rejects(
      () => puller.assertCheckpointCompatible(source.sourceKey),
      (error) => error?.status === 409 && error?.code === 'source_contract_mismatch',
    )
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
      (error) => error?.status === 409 && error?.code === 'source_contract_mismatch',
    )
    assert.equal(state.poolsOpened, 0)
    assert.equal(state.cursorWrites.length, 0)
  }
})

test('crawler describe reports the same strict leaf and exact-index gate used by activation', async () => {
  const valid = crawlerRuntimeContractHarness()
  const description = await valid.puller.describe(valid.source.sourceKey)
  assert.deepEqual(description.issues, [])
  assert.equal(Object.hasOwn(description, 'crawlerContractIssues'), false)

  const drifted = crawlerRuntimeContractHarness({
    indexes: [crawlerCursorIndex({ unique_index: false })],
  })
  const blocked = await drifted.puller.describe(drifted.source.sourceKey)
  assert.ok(blocked.issues.includes(
    'crawler source requires an exact live unique btree (last_seen_at, id) index',
  ))
})

test('crawler progress fails closed on strict schema drift without running a count', async () => {
  const { puller, source, state } = crawlerRuntimeContractHarness({
    columns: crawlerDatabaseColumns((column) => (
      column.name === 'text' ? { ...column, databaseType: 'varchar' } : column
    )),
  })
  const progress = await puller.progress(source.sourceKey)
  assert.equal(progress.blocker, 'source_contract_mismatch')
  assert.ok(progress.issues.includes('crawler column text must use PostgreSQL text'))
  assert.equal(progress.totalRows, null)
  assert.equal(state.pageReads, 0)
})

test('crawler progress uses one strict physical gate and reports finite matching rows', async () => {
  const { puller, source } = crawlerRuntimeContractHarness({
    progressRow: {
      total_rows: '17',
      invalid_cursor_rows: '0',
      invalid_source_type_rows: '0',
    },
  })
  const progress = await puller.progress(source.sourceKey)
  assert.equal(progress.blocker, null)
  assert.equal(progress.totalRows, 17)
  assert.equal(progress.completedRows, null)
})

test('crawler progress blocks non-finite or cross-leaf rows in its aggregate snapshot', async () => {
  const { puller, source } = crawlerRuntimeContractHarness({
    progressRow: {
      total_rows: '17',
      invalid_cursor_rows: '1',
      invalid_source_type_rows: '2',
    },
  })
  const progress = await puller.progress(source.sourceKey)
  assert.equal(progress.blocker, 'source_contract_mismatch')
  assert.equal(progress.totalRows, 17)
  assert.deepEqual(progress.issues, [
    'crawler source contains a non-finite last_seen_at watermark',
    'crawler source contains rows outside source_type news',
  ])
})

test('every crawler pull rejects any drift in its complete 23-column type and nullability contract', async () => {
  const cases = [
    {
      columns: crawlerDatabaseColumns().filter((column) => column.column_name !== 'title'),
      issue: 'required crawler column title is missing',
    },
    {
      columns: crawlerDatabaseColumns((column) => (
        column.name === 'source_url' ? { ...column, databaseType: 'varchar' } : column
      )),
      issue: 'crawler column source_url must use PostgreSQL text',
    },
    {
      columns: crawlerDatabaseColumns((column) => (
        column.name === 'raw' ? { ...column, nullable: false } : column
      )),
      issue: 'crawler column raw must be nullable',
    },
  ]

  for (const fixture of cases) {
    const { puller, source, state } = crawlerRuntimeContractHarness(fixture)
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
      (error) => (
        error?.status === 409
        && error?.code === 'source_contract_mismatch'
        && error?.details?.issues?.includes(fixture.issue)
      ),
      fixture.issue,
    )
    assert.equal(state.pageReads, 0)
    assert.equal(state.importStarts, 0)
  }
})

test('every crawler pull rechecks exact leaf-partition and unique cursor-index evidence', async () => {
  const cases = [
    {
      relation: crawlerLeafRelation({ parent_table: 'saved_records_archive' }),
      issue: 'crawler source relation must be a direct child of public.saved_records',
    },
    {
      indexes: [crawlerCursorIndex({ unique_index: false })],
      issue: 'crawler source requires an exact live unique btree (last_seen_at, id) index',
    },
  ]

  for (const fixture of cases) {
    const { puller, source, state } = crawlerRuntimeContractHarness(fixture)
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
      (error) => (
        error?.status === 409
        && error?.code === 'source_contract_mismatch'
        && error?.details?.issues?.includes(fixture.issue)
      ),
      fixture.issue,
    )
    assert.equal(state.pageReads, 0)
    assert.equal(state.importStarts, 0)
  }
})

test('crawler pull rejects a row whose source_type does not match its fixed leaf', async () => {
  const { puller, source, state } = crawlerRuntimeContractHarness({
    rows: [{ ...rawFixture(), source_type: 'finance' }],
  })
  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
    (error) => (
      error?.status === 409
      && error?.code === 'source_contract_mismatch'
      && error?.details?.issues?.includes('crawler source returned a row outside source_type news')
    ),
  )
  assert.equal(state.pageReads, 1)
  assert.equal(state.importStarts, 0)
})

test('crawler pull rejects positive or negative infinite source watermarks before checkpoint advance', async () => {
  for (const watermark of ['infinity', '-infinity']) {
    const { puller, source, state } = crawlerRuntimeContractHarness({
      rows: [{ ...rawFixture(), last_seen_at: watermark }],
    })
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
      (error) => (
        error?.status === 409
        && error?.code === 'source_contract_mismatch'
        && error?.message.includes('non-finite last_seen_at')
      ),
      watermark,
    )
    assert.equal(state.importStarts, 0)
    assert.equal(state.cursorWrites.at(-1)?.options?.status, 'failed')
    assert.equal(state.cursorWrites.some((write) => write.position?.cursor === watermark), false)
  }
})

test('crawler pull rejects a late negative-infinity watermark behind an advanced checkpoint', async () => {
  const checkpoint = '2026-09-09 04:00:00+00'
  const { puller, source, state } = crawlerRuntimeContractHarness({
    position: { cursor: checkpoint, lastId: '7' },
    watermarkEndpoints: {
      minimum_cursor: '-infinity',
      maximum_cursor: '2026-09-09 05:00:00+00',
    },
    // The ordinary keyset page cannot see the invalid row because it sorts
    // behind the already acknowledged checkpoint.
    rows: [],
  })
  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
    (error) => (
      error?.status === 409
      && error?.code === 'source_contract_mismatch'
      && error?.details?.issues?.includes(
        'crawler source minimum last_seen_at watermark is non-finite',
      )
    ),
  )
  assert.equal(state.pageReads, 0)
  assert.equal(state.importStarts, 0)
  assert.equal(state.cursorWrites.some((write) => write.position?.cursor !== checkpoint), false)
})

test('crawler pull rejects a persisted infinite watermark before opening the source', async () => {
  for (const watermark of ['infinity', '-infinity']) {
    const { puller, source, state } = crawlerRuntimeContractHarness({
      position: { cursor: watermark, lastId: '7' },
    })
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, { batchSize: 10 }),
      (error) => error?.status === 409 && error?.code === 'source_contract_mismatch',
      watermark,
    )
    assert.equal(state.poolsOpened, 0)
    assert.equal(state.cursorWrites.length, 0)
  }
})

test('crawler replay cannot advance an infinite cursor from committed batch evidence', async () => {
  const { puller, source, state } = crawlerRuntimeContractHarness({
    position: { importRunId: 'crawler-existing-run' },
    committedBatch: {
      status: 'succeeded',
      cursorEnd: { cursor: 'infinity', lastId: '7' },
      rowCount: 1,
      ingested: 1,
      changed: 1,
      deleted: 0,
      rejected: 0,
    },
  })
  await assert.rejects(
    () => puller.pullBatch(source.sourceKey, {
      batchSize: 10,
      importRunId: 'crawler-existing-run',
    }),
    (error) => (
      error?.status === 409
      && error?.code === 'source_contract_mismatch'
      && error?.message.includes('non-finite last_seen_at')
    ),
  )
  assert.equal(state.poolsOpened, 0)
  assert.equal(state.cursorWrites.length, 0)
})

test('crawler replay cannot advance an incomplete tuple from committed batch evidence', async () => {
  for (const cursorEnd of [
    { cursor: '2026-09-09 03:05:00+00' },
    { lastId: '7' },
  ]) {
    const { puller, source, state } = crawlerRuntimeContractHarness({
      position: { importRunId: 'crawler-existing-run' },
      committedBatch: {
        status: 'succeeded',
        cursorEnd,
        rowCount: 1,
        ingested: 1,
        changed: 1,
        deleted: 0,
        rejected: 0,
      },
    })
    await assert.rejects(
      () => puller.pullBatch(source.sourceKey, {
        batchSize: 10,
        importRunId: 'crawler-existing-run',
      }),
      (error) => error?.status === 409 && error?.code === 'source_contract_mismatch',
    )
    assert.equal(state.poolsOpened, 0)
    assert.equal(state.cursorWrites.length, 0)
  }
})

function rawFixture() {
  return {
    id: 1,
    source_type: 'news',
    connector_id: 'china-news',
    run_id: 91,
    source_family: 'china-news',
    collection_mode: 'protocol',
    evidence: [],
    quality_status: 'unverified',
    record_type: 'news.article',
    source_id: 'thepaper:1',
    record_key: 'record-key-1',
    source_url: 'https://news.example.test/2026/09/record-key-1.html',
    title: '测试新闻',
    text: '测试新闻正文',
    author: { name: '记者甲', organization: '澎湃新闻编辑部' },
    published_at: '2026-09-09 11:00',
    metrics: {},
    media: [],
    attributes: {
      platform: 'thepaper',
      platform_name: '澎湃新闻',
      section: 'news',
      tags: ['china-news', 'thepaper'],
    },
    raw: { producer: 'crawler-test' },
    first_seen_at: new Date('2026-09-09T03:05:00.000Z'),
    last_seen_at: new Date('2026-09-09T03:05:00.000Z'),
    created_at: new Date('2026-09-09T03:05:00.100Z'),
  }
}
