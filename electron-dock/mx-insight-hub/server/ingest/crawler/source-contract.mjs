import { createHash } from 'node:crypto'

export const CRAWLER_PIPELINE_KEY = 'night-all-saved-records'
export const CRAWLER_MAPPING_VERSION = 1
export const CRAWLER_OBJECT_TYPE = 'saved_record'

export const CRAWLER_SOURCE_TYPES = Object.freeze([
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
])

const SOURCE_METADATA = Object.freeze({
  automotive: Object.freeze({
    sourceId: 'e367cc11-81af-5615-9a74-fc55004a55b1',
    mappingId: 'a37ef80d-58b2-531b-b222-f045c451d6fa',
    displayName: 'Night-All 汽车数据',
  }),
  finance: Object.freeze({
    sourceId: 'ce09c232-ec86-5ebc-9966-ca52d0d34c4c',
    mappingId: '3b0e9f93-f8d1-5f9e-bdc7-a7718b4746e7',
    displayName: 'Night-All 财经数据',
  }),
  forum: Object.freeze({
    sourceId: '1ecb7a63-b2e4-5adf-baa1-192628f00bfc',
    mappingId: '22285b5e-b60e-58e1-93fe-165ab9da82b9',
    displayName: 'Night-All 论坛数据',
  }),
  hotspot: Object.freeze({
    sourceId: 'b8be8442-6404-504a-a2cc-e922168e8b29',
    mappingId: '0525f183-d51a-5586-b6ec-598b09649e0e',
    displayName: 'Night-All 热点数据',
  }),
  local_news: Object.freeze({
    sourceId: '18e6aad2-02cc-5359-93e0-e731cbda76a7',
    mappingId: 'bab9f729-8730-578e-a111-48c96ad3ef47',
    displayName: 'Night-All 地方新闻',
  }),
  media: Object.freeze({
    sourceId: '9f1ba402-1509-5c61-9d5a-d3528be18151',
    mappingId: '7b13d483-2801-5377-9cab-d6ddeeed0e0a',
    displayName: 'Night-All 媒体数据',
  }),
  news: Object.freeze({
    sourceId: 'b7401a46-d327-5a22-bb81-f4a5b6aad83b',
    mappingId: '6ebf66f9-cd35-5df0-b321-0cb05e6bd8fe',
    displayName: 'Night-All 新闻资讯',
  }),
  other: Object.freeze({
    sourceId: 'c6f588d0-3d3a-5f2a-a57b-ee5d27177571',
    mappingId: '8182fa52-aed4-5026-b17e-c48750246ed4',
    displayName: 'Night-All 其他数据',
  }),
  recruitment: Object.freeze({
    sourceId: '3a1f65ed-0f76-58fc-a445-680b2f47f84d',
    mappingId: 'd428912d-8c4e-5236-8a6a-02f58a6ca4e4',
    displayName: 'Night-All 招聘数据',
  }),
  research: Object.freeze({
    sourceId: '2c5681d8-6126-575a-b978-db4806e5d64a',
    mappingId: '60b929c1-34ba-5e29-be33-e998dd17cff5',
    displayName: 'Night-All 研究数据',
  }),
  social: Object.freeze({
    sourceId: 'c0593cb0-08a4-5802-9792-09d8f6d73b6b',
    mappingId: '0b3fea27-2d9c-5f1b-a07d-ec5da495c2d7',
    displayName: 'Night-All 社交媒体',
  }),
  technology: Object.freeze({
    sourceId: '417bab60-fab3-523d-a1df-8e2bf7e6ae1e',
    mappingId: 'f221060d-7a3d-55ca-9622-fb0e290dc013',
    displayName: 'Night-All 科技数据',
  }),
  web: Object.freeze({
    sourceId: '5e378a73-09da-5724-8e56-d608d2e2e006',
    mappingId: '239adecc-c99d-5ad7-814e-ce5240bf0e60',
    displayName: 'Night-All 网页数据',
  }),
})

function sourceKey(sourceType) {
  return `night-all-saved-records-${sourceType.replaceAll('_', '-')}`
}

function sourceSpec(sourceType) {
  const metadata = SOURCE_METADATA[sourceType]
  return Object.freeze({
    sourceType,
    sourceId: metadata.sourceId,
    sourceKey: sourceKey(sourceType),
    // Public contracts name the Hub data product, never the internal
    // Night-All transport that happens to supply it.
    datasetId: `data-center.saved-records.${sourceType}.v1`,
    platform: `data_center_saved_records_${sourceType}`,
    objectType: CRAWLER_OBJECT_TYPE,
    mappingId: metadata.mappingId,
    locator: Object.freeze({
      schema: 'public',
      table: `saved_records_${sourceType}`,
      cursorColumn: 'last_seen_at',
      idColumn: 'id',
    }),
    displayName: metadata.displayName,
  })
}

export const CRAWLER_SOURCES = Object.freeze(CRAWLER_SOURCE_TYPES.map(sourceSpec))

export const CRAWLER_WRITER_CONTRACT_VERSION = 'night-all-saved-records.writer.v1'

export const CRAWLER_WRITER_CONTRACT_SUMMARY = Object.freeze({
  watermark: 'Every insert and every relevant update advances the finite, non-null last_seen_at value, including content, quality, metadata and soft-delete changes.',
  identity: 'Within every fixed source_type leaf, id is immutable and never reused, while record_key is the stable canonical source identity for the lifetime of the dataset.',
  deletion: 'Hard deletes are not used for rows visible to the Hub; removals remain observable through a watermarked source change or a future ordered change journal.',
  ordering: 'A later commit cannot expose last_seen_at at or behind a checkpoint already consumed by the Hub; an ordered journal or CDC replaces this contract when that cannot be guaranteed.',
  partitioning: 'Each fixed leaf contains only its declared source_type and is not replaced or rebound without pausing the source and resetting its checkpoint after review.',
  inputs: CRAWLER_SOURCES.map((spec) => ({
    sourceType: spec.sourceType,
    table: `${spec.locator.schema}.${spec.locator.table}`,
    cursor: [spec.locator.cursorColumn, spec.locator.idColumn],
  })),
})

export const CRAWLER_WRITER_CONTRACT_DIGEST = createHash('sha256')
  .update(JSON.stringify(CRAWLER_WRITER_CONTRACT_SUMMARY))
  .digest('hex')

const CRAWLER_SOURCE_KEYS = new Set(CRAWLER_SOURCES.map((source) => source.sourceKey))

const CRAWLER_SOURCE_BY_KEY = new Map(CRAWLER_SOURCES.map((source) => [source.sourceKey, source]))
const CRAWLER_DATASET_IDS = new Set(CRAWLER_SOURCES.map((source) => source.datasetId))
const CRAWLER_PLATFORMS = new Set(CRAWLER_SOURCES.map((source) => source.platform))

export const CRAWLER_SOURCE_COLUMN_CONTRACT = Object.freeze([
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
].map(([name, databaseType, nullable]) => Object.freeze({ name, databaseType, nullable })))

export const CRAWLER_SOURCE_COLUMNS = Object.freeze(
  CRAWLER_SOURCE_COLUMN_CONTRACT.map((column) => column.name),
)
const ALLOWED_CONNECTION_FIELDS = new Set([
  'schema',
  'table',
  'cursorColumn',
  'idColumn',
  'host',
  'port',
  'database',
  'username',
  'password',
  'sslMode',
])

export function isCrawlerSourceKey(value) {
  return CRAWLER_SOURCE_KEYS.has(value)
}

export function crawlerSourceSpecForKey(value) {
  return CRAWLER_SOURCE_BY_KEY.get(value) ?? null
}

export function crawlerReservedScopeIssue({ datasetId = null, platform = null } = {}) {
  if (CRAWLER_DATASET_IDS.has(datasetId)) {
    return { field: 'datasetId', value: datasetId }
  }
  if (CRAWLER_PLATFORMS.has(platform)) {
    return { field: 'platform', value: platform }
  }
  return null
}

export function crawlerSourceContractIssues(source, spec) {
  if (!spec || !CRAWLER_SOURCE_KEYS.has(spec.sourceKey)) {
    return ['Crawler source specification is missing or unknown']
  }
  const expected = [
    ['sourceKey', spec.sourceKey],
    ['sourceKind', 'database'],
    ['datasetId', spec.datasetId],
    ['platform', spec.platform],
    ['objectType', spec.objectType],
  ]
  const issues = expected.flatMap(([field, value]) => (
    source?.[field] === value ? [] : [`Fixed crawler source ${field} must be ${value}`]
  ))
  for (const [field, value] of Object.entries(spec.locator)) {
    if (source?.connection?.[field] !== value) {
      issues.push(`Fixed crawler source connection.${field} must be ${value}`)
    }
  }
  for (const field of Object.keys(source?.connection || {})) {
    if (!ALLOWED_CONNECTION_FIELDS.has(field)) {
      issues.push(`Fixed crawler source connection field ${field} is not allowed`)
    }
  }
  return issues
}

export function crawlerColumnIssues(columns = []) {
  const byName = new Map(columns.map((column) => [column.name, column]))
  const issues = CRAWLER_SOURCE_COLUMNS.flatMap((name) => (
    byName.has(name) ? [] : [`required crawler column ${name} is missing`]
  ))
  if (byName.size !== columns.length) {
    issues.push('crawler columns contain duplicate names')
  }
  const expected = new Set(CRAWLER_SOURCE_COLUMNS)
  for (const name of [...byName.keys()].filter((candidate) => !expected.has(candidate)).sort()) {
    issues.push(`unexpected crawler column ${name} requires mapping review`)
  }
  for (const contract of CRAWLER_SOURCE_COLUMN_CONTRACT) {
    const column = byName.get(contract.name)
    if (!column) continue
    if (column.databaseType !== contract.databaseType) {
      issues.push(`crawler column ${contract.name} must use PostgreSQL ${contract.databaseType}`)
    }
    if (column.nullable !== contract.nullable) {
      issues.push(`crawler column ${contract.name} must be ${contract.nullable ? 'nullable' : 'non-null'}`)
    }
  }
  return issues
}

export function crawlerLeafPartitionIssues(relation, spec) {
  if (!relation) return ['crawler leaf partition evidence is missing']
  const expectedBound = `FOR VALUES IN ('${spec.sourceType}')`
  return [
    ...(relation.relationKind === 'r' ? [] : ['crawler source relation must be an ordinary partition leaf']),
    ...(relation.isPartition === true ? [] : ['crawler source relation must be a declarative partition']),
    ...(relation.isLeaf === true ? [] : ['crawler source relation must not own child partitions']),
    ...(relation.parentSchema === 'public' && relation.parentTable === 'saved_records'
      ? []
      : ['crawler source relation must be a direct child of public.saved_records']),
    ...(relation.parentRelationKind === 'p'
      && String(relation.parentPartitionKey || '').replace(/["\s]/g, '') === 'LIST(source_type)'
      ? []
      : ['public.saved_records must be LIST partitioned by source_type']),
    ...(String(relation.partitionBound || '').trim() === expectedBound
      ? []
      : [`crawler source partition bound must be ${expectedBound}`]),
  ]
}

export function crawlerCursorIndexIssues(indexes = [], spec) {
  const ready = indexes.some((index) => (
    index.valid === true
    && index.ready === true
    && index.live === true
    && index.unique === true
    && index.accessMethod === 'btree'
    && index.noExpressions === true
    && index.noPredicate === true
    && Number(index.keyCount) === 2
    && Number(index.totalColumns) === 2
    && String(index.firstKey || '').replace(/[()"\s]/g, '') === spec.locator.cursorColumn
    && String(index.secondKey || '').replace(/[()"\s]/g, '') === spec.locator.idColumn
    && Number(index.firstOption) === 0
    && Number(index.secondOption) === 0
  ))
  return ready ? [] : [
    `crawler source requires an exact live unique btree (${spec.locator.cursorColumn}, ${spec.locator.idColumn}) index`,
  ]
}

export function crawlerSourceRowIssues(rows = [], spec) {
  return rows.some((row) => row?.source_type !== spec.sourceType)
    ? [`crawler source returned a row outside source_type ${spec.sourceType}`]
    : []
}

export function crawlerCursorIsFinite(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime())
  if (typeof value !== 'string' || !value.trim()) return false
  return Number.isFinite(new Date(value).getTime())
}

function crawlerProbeSourceIssues(source, spec) {
  if (!source) return []
  const expected = [
    ['sourceKey', spec.sourceKey],
    ['datasetId', spec.datasetId],
    ['platform', spec.platform],
    ['objectType', spec.objectType],
    ['schema', spec.locator.schema],
    ['table', spec.locator.table],
  ]
  return expected.flatMap(([field, value]) => (
    source[field] === value ? [] : [`Fixed crawler probe source ${field} must be ${value}`]
  ))
}

export function crawlerProbeIssues(description, spec) {
  if (!spec || !CRAWLER_SOURCE_KEYS.has(spec.sourceKey)) {
    return ['Crawler source specification is missing or unknown']
  }
  return [...new Set([
    ...(description?.issues || []),
    ...crawlerProbeSourceIssues(description?.source, spec),
    ...crawlerColumnIssues(description?.columns || []),
  ])]
}
