import {
  PUBLIC_OPINION_DATASET_ID,
  PUBLIC_OPINION_OBJECT_TYPE,
  PUBLIC_OPINION_PLATFORM,
} from '../../data/public-opinion.mjs'

export const PROVINCE_OPINION_SOURCE_KEY = 'province-opinion-results'
export const PROVINCE_OPINION_SOURCE_LOCATOR = Object.freeze({
  schema: 'public',
  table: 'monitor_strategy_results',
  cursorColumn: 'updated_at',
  idColumn: 'id',
})

const REQUIRED_SOURCE_COLUMNS = Object.freeze([
  'id',
  'title',
  'summary',
  'link',
  'source_name',
  'source_type',
  'platform',
  'published_at',
  'province',
  'heat_score',
  'updated_at',
  'source_stage',
])
const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz'])
const NUMERIC_TYPES = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'decimal'])
const ALLOWED_CONNECTION_FIELDS = new Set([
  ...Object.keys(PROVINCE_OPINION_SOURCE_LOCATOR),
  'host', 'port', 'database', 'username', 'password', 'sslMode',
])

export function provinceOpinionSourceContractIssues(source) {
  const expected = [
    ['sourceKey', PROVINCE_OPINION_SOURCE_KEY],
    ['sourceKind', 'database'],
    ['datasetId', PUBLIC_OPINION_DATASET_ID],
    ['platform', PUBLIC_OPINION_PLATFORM],
    ['objectType', PUBLIC_OPINION_OBJECT_TYPE],
  ]
  const issues = expected.flatMap(([field, value]) => (
    source?.[field] === value ? [] : [`Fixed source ${field} must be ${value}`]
  ))
  for (const [field, value] of Object.entries(PROVINCE_OPINION_SOURCE_LOCATOR)) {
    if (source?.connection?.[field] !== value) {
      issues.push(`Fixed source connection.${field} must be ${value}`)
    }
  }
  for (const field of Object.keys(source?.connection || {})) {
    if (!ALLOWED_CONNECTION_FIELDS.has(field)) {
      issues.push(`Fixed source connection field ${field} is not allowed`)
    }
  }
  return issues
}

export function provinceOpinionColumnIssues(columns = []) {
  const issues = []
  const byName = new Map(columns.map((column) => [column.name, column]))
  for (const name of REQUIRED_SOURCE_COLUMNS) {
    if (!byName.has(name)) issues.push(`required province opinion column ${name} is missing`)
  }
  const updatedAt = byName.get('updated_at')
  if (updatedAt?.nullable === true) issues.push('cursor column updated_at must be non-null')
  const id = byName.get('id')
  if (id?.nullable === true) issues.push('id column id must be non-null')
  const sourceStage = byName.get('source_stage')
  if (sourceStage && sourceStage.nullable !== false) issues.push('source_stage column must be non-null')
  if (updatedAt && !TIMESTAMP_TYPES.has(updatedAt.databaseType)) {
    issues.push('cursor column updated_at must be timestamp or timestamptz; date cannot observe multiple same-day revisions')
  }
  const publishedAt = byName.get('published_at')
  if (publishedAt && !TIMESTAMP_TYPES.has(publishedAt.databaseType)) {
    issues.push('published_at must be timestamp or timestamptz')
  }
  const heatScore = byName.get('heat_score')
  if (heatScore && !NUMERIC_TYPES.has(heatScore.databaseType)) {
    issues.push('heat_score must use a PostgreSQL numeric type')
  }
  return issues
}

function normalizedSourceStageCheck(expression) {
  return String(expression || '')
    .toLowerCase()
    .replace(/["\s()]/g, '')
    .replace(/::text/g, '')
}

function isExactSourceStageCheck(constraint) {
  if (constraint.type !== 'c' || constraint.validated !== true) return false
  // PostgreSQL rewrites IN (...) to = ANY (ARRAY[...]) in pg_get_expr output.
  const expression = normalizedSourceStageCheck(constraint.expression)
  return expression === "source_stage=anyarray['formal','candidate']"
    || expression === "source_stage=anyarray['candidate','formal']"
    || expression === "source_stagein'formal','candidate'"
    || expression === "source_stagein'candidate','formal'"
}

export function provinceOpinionProbeIssues(description) {
  const issues = [
    ...(description?.issues || []),
    ...provinceOpinionColumnIssues(description?.columns || []),
  ]
  const finiteWatermark = (description?.constraints || []).some((constraint) => (
    constraint.type === 'c'
    && constraint.validated === true
    && String(constraint.expression || '').toLowerCase().replace(/["\s]/g, '') === 'isfinite(updated_at)'
  ))
  if (!finiteWatermark) {
    issues.push('updated_at requires a CHECK (isfinite(updated_at)) constraint')
  }
  const exactSourceStage = (description?.constraints || []).some(isExactSourceStageCheck)
  if (!exactSourceStage) {
    issues.push("source_stage requires a validated CHECK allowing only 'formal' and 'candidate'")
  }
  return [...new Set(issues)]
}

export function provinceOpinionCursorIsFinite(value) {
  return !/^[+-]?infinity$/i.test(String(value ?? '').trim())
}
