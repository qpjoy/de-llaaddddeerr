export const MOBILE_COMMERCE_PIPELINE_KEY = 'mobile-commerce'
export const MOBILE_COMMERCE_SOURCE_KEY = 'mobile-commerce-collected-items'
export const MOBILE_COMMERCE_DATASET_ID = 'mobile-commerce.collected-items.v1'
export const MOBILE_COMMERCE_PLATFORM = 'mobile_commerce'
export const MOBILE_COMMERCE_OBJECT_TYPE = 'commerce_capture'
export const MOBILE_COMMERCE_MAPPING_ID = '2900ddcf-a7d9-4714-92df-28148c70459f'
export const MOBILE_COMMERCE_MAPPING_VERSION = 1

export const MOBILE_COMMERCE_SOURCE_LOCATOR = Object.freeze({
  schema: 'public',
  table: 'mb_collected_items',
  cursorColumn: 'collected_at',
  idColumn: 'id',
})

export const MOBILE_COMMERCE_COLUMNS = Object.freeze([
  'id',
  'platform',
  'task_run_id',
  'task_id',
  'keyword',
  'brand',
  'title',
  'product_link',
  'shop_name',
  'shop_link',
  'goods_id',
  'shop_id',
  'price',
  'sales',
  'ship_from',
  'shop_level',
  'shop_fans',
  'shop_reputation',
  'comment_count',
  'good_rate',
  'tags',
  'collected_at',
  'metadata_json',
  'device_serial',
  'is_reported',
])

const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz'])
const ID_TYPES = new Set(['int2', 'int4', 'int8', 'uuid', 'text', 'varchar', 'bpchar'])
const ALLOWED_INLINE_CONNECTION_FIELDS = new Set([
  ...Object.keys(MOBILE_COMMERCE_SOURCE_LOCATOR),
  'host', 'port', 'database', 'username', 'password', 'sslMode',
])

export function isMobileCommerceSourceKey(sourceKey) {
  return sourceKey === MOBILE_COMMERCE_SOURCE_KEY
}

export function mobileCommerceSourceContractIssues(source) {
  const expected = [
    ['sourceKey', MOBILE_COMMERCE_SOURCE_KEY],
    ['sourceKind', 'database'],
    ['datasetId', MOBILE_COMMERCE_DATASET_ID],
    ['platform', MOBILE_COMMERCE_PLATFORM],
    ['objectType', MOBILE_COMMERCE_OBJECT_TYPE],
  ]
  const issues = expected.flatMap(([field, value]) => (
    source?.[field] === value ? [] : [`Fixed mobile-commerce source ${field} must be ${value}`]
  ))
  for (const [field, value] of Object.entries(MOBILE_COMMERCE_SOURCE_LOCATOR)) {
    if (source?.connection?.[field] !== value) {
      issues.push(`Fixed mobile-commerce source connection.${field} must be ${value}`)
    }
  }
  for (const field of Object.keys(source?.connection || {})) {
    if (!ALLOWED_INLINE_CONNECTION_FIELDS.has(field)) {
      issues.push(`Fixed mobile-commerce source connection field ${field} is not allowed`)
    }
  }
  return issues
}

export function mobileCommerceColumnIssues(columns = []) {
  const byName = new Map(columns.map((column) => [column.name, column]))
  const issues = MOBILE_COMMERCE_COLUMNS.flatMap((name) => (
    byName.has(name) ? [] : [`required mobile-commerce column ${name} is missing`]
  ))
  const expected = new Set(MOBILE_COMMERCE_COLUMNS)
  for (const name of [...byName.keys()].filter((candidate) => !expected.has(candidate)).sort()) {
    issues.push(`unexpected mobile-commerce column ${name} requires mapping review`)
  }
  for (const name of ['id', 'platform', 'title', 'collected_at']) {
    if (byName.get(name)?.nullable === true) {
      issues.push(`required mobile-commerce column ${name} must be non-null`)
    }
  }
  const collectedAt = byName.get('collected_at')
  if (collectedAt && !TIMESTAMP_TYPES.has(collectedAt.databaseType)) {
    issues.push('collected_at must be timestamp or timestamptz')
  }
  const id = byName.get('id')
  if (id && !ID_TYPES.has(id.databaseType)) {
    issues.push('id must be an integer, UUID, or text scalar')
  }
  return issues
}

export function mobileCommerceCursorIsFinite(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime())
  if (typeof value !== 'string' || !value.trim()) return false
  return Number.isFinite(new Date(value).getTime())
}

export function mobileCommerceProbeIssues(description) {
  return [...new Set([
    ...(description?.issues || []),
    ...mobileCommerceColumnIssues(description?.columns || []),
  ])]
}
