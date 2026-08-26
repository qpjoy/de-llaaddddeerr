import { AppError } from '../core/errors.mjs'

export const SOURCE_KINDS = Object.freeze([
  'platform',
  'platform_module',
  'source_class',
  'registry',
  'provider',
  'dataset',
  'other',
])

export const COVERAGE_STATUSES = Object.freeze(['unknown', 'not_covered', 'partial', 'covered'])
export const DELIVERY_STATUSES = Object.freeze([
  'exploring',
  'planned',
  'doing',
  'blocked',
  'complete',
  'paused',
  'retired',
])
export const REVIEW_STATUSES = Object.freeze(['needs_review', 'verified', 'rejected'])
export const RUNTIME_STATUSES = Object.freeze([
  'not_configured',
  'unknown',
  'healthy',
  'degraded',
  'failed',
])
export const SOURCE_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3'])

const SOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const EVIDENCE_TYPES = new Set(['document', 'pipeline', 'dataset', 'external_source', 'plan', 'url'])
const PRIVATE_CUSTOM_FIELD = /(?:password|passwd|secret|token|credential|authori[sz]ation|api.?key|access.?key|private.?key|cookie|session|dsn|connection.?string)/iu
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_source_catalog_entry', 'Source catalog entry must be a JSON object')
  }
  return value
}

function text(value, field, { required = false, maximum = 4_000 } = {}) {
  if (value == null || value === '') {
    if (required) throw new AppError(400, 'invalid_source_catalog_field', `${field} is required`)
    return null
  }
  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_source_catalog_field', `${field} must be text`)
  }
  const normalized = value.normalize('NFKC').trim()
  if (!normalized) {
    if (required) throw new AppError(400, 'invalid_source_catalog_field', `${field} is required`)
    return null
  }
  if (normalized.length > maximum) {
    throw new AppError(400, 'invalid_source_catalog_field', `${field} must be at most ${maximum} characters`)
  }
  return normalized
}

function stringArray(value, field, { maximumItems = 64, maximumLength = 240 } = {}) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_source_catalog_field', `${field} must be an array`)
  }
  if (value.length > maximumItems) {
    throw new AppError(400, 'invalid_source_catalog_field', `${field} has too many values`)
  }
  const normalized = value.map((item) => text(item, field, { required: true, maximum: maximumLength }))
  return [...new Set(normalized)]
}

function choice(value, field, choices, { required = true } = {}) {
  if (value == null || value === '') {
    if (required) throw new AppError(400, 'invalid_source_catalog_field', `${field} is required`)
    return null
  }
  if (!choices.includes(value)) {
    throw new AppError(400, 'invalid_source_catalog_field', `${field} must be one of ${choices.join(', ')}`)
  }
  return value
}

function sequence(value) {
  if (value == null || value === '') return null
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(400, 'invalid_source_catalog_field', 'legacySequence must be a positive integer')
  }
  return value
}

function parentId(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_source_catalog_field', 'parentSourceId must be a UUID')
  }
  return value.toLowerCase()
}

function evidenceRefs(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 32) {
    throw new AppError(400, 'invalid_source_catalog_field', 'evidenceRefs must contain at most 32 entries')
  }
  return value.map((raw, index) => {
    const entry = asObject(raw)
    const type = text(entry.type, `evidenceRefs[${index}].type`, { required: true, maximum: 32 })
    if (!EVIDENCE_TYPES.has(type)) {
      throw new AppError(400, 'invalid_source_catalog_field', `Unsupported evidence type: ${type}`)
    }
    const key = text(entry.key, `evidenceRefs[${index}].key`, { required: true, maximum: 512 })
    const label = text(entry.label, `evidenceRefs[${index}].label`, { maximum: 160 })
    return { type, key, ...(label ? { label } : {}) }
  })
}

function customFields(value) {
  if (value == null) return {}
  const object = asObject(value)
  const visit = (node, path = 'customFields') => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (PRIVATE_CUSTOM_FIELD.test(key)) {
        throw new AppError(
          400,
          'source_catalog_private_field_forbidden',
          `${path}.${key} cannot store credentials or connection secrets`,
        )
      }
      visit(child, `${path}.${key}`)
    }
  }
  visit(object)
  const serialized = JSON.stringify(object)
  if (Buffer.byteLength(serialized) > 32 * 1_024) {
    throw new AppError(400, 'invalid_source_catalog_field', 'customFields exceeds 32 KiB')
  }
  return structuredClone(object)
}

const ARRAY_FIELDS = Object.freeze({
  aliases: { maximumItems: 32, maximumLength: 160 },
  scenarios: { maximumItems: 32, maximumLength: 160 },
  regions: { maximumItems: 16, maximumLength: 120 },
  entryModules: { maximumItems: 64, maximumLength: 240 },
  monitorableContent: { maximumItems: 64, maximumLength: 240 },
  extractableClues: { maximumItems: 64, maximumLength: 240 },
  trackingFields: { maximumItems: 64, maximumLength: 240 },
  suggestedAccess: { maximumItems: 64, maximumLength: 240 },
  connectorHints: { maximumItems: 32, maximumLength: 160 },
  tags: { maximumItems: 64, maximumLength: 120 },
})

const TEXT_FIELDS = Object.freeze({
  canonicalName: { required: true, maximum: 160 },
  majorCategory: { required: true, maximum: 160 },
  complianceBoundary: { maximum: 8_000 },
  owner: { maximum: 160 },
  notes: { maximum: 8_000 },
})

function normalizeKnownFields(input, { partial }) {
  const source = asObject(input)
  const normalized = {}

  for (const [field, options] of Object.entries(TEXT_FIELDS)) {
    if (!partial || hasOwn(source, field)) normalized[field] = text(source[field], field, options)
  }
  for (const [field, options] of Object.entries(ARRAY_FIELDS)) {
    if (!partial || hasOwn(source, field)) normalized[field] = stringArray(source[field], field, options)
  }

  if (!partial || hasOwn(source, 'sourceKind')) {
    normalized.sourceKind = choice(source.sourceKind ?? 'platform', 'sourceKind', SOURCE_KINDS)
  }
  if (!partial || hasOwn(source, 'parentSourceId')) normalized.parentSourceId = parentId(source.parentSourceId)
  if (!partial || hasOwn(source, 'priority')) {
    normalized.priority = choice(source.priority ?? 'P2', 'priority', SOURCE_PRIORITIES)
  }
  if (!partial || hasOwn(source, 'coverageStatus')) {
    normalized.coverageStatus = choice(source.coverageStatus ?? 'unknown', 'coverageStatus', COVERAGE_STATUSES)
  }
  if (!partial || hasOwn(source, 'deliveryStatus')) {
    normalized.deliveryStatus = choice(source.deliveryStatus ?? 'exploring', 'deliveryStatus', DELIVERY_STATUSES)
  }
  if (!partial || hasOwn(source, 'reviewStatus')) {
    normalized.reviewStatus = choice(source.reviewStatus ?? 'needs_review', 'reviewStatus', REVIEW_STATUSES)
  }
  if (!partial || hasOwn(source, 'runtimeStatus')) {
    normalized.runtimeStatus = choice(source.runtimeStatus ?? 'not_configured', 'runtimeStatus', RUNTIME_STATUSES)
  }
  if (!partial || hasOwn(source, 'evidenceRefs')) normalized.evidenceRefs = evidenceRefs(source.evidenceRefs)
  if (!partial || hasOwn(source, 'customFields')) normalized.customFields = customFields(source.customFields)

  return normalized
}

export function normalizeSourceCatalogCreate(input) {
  const source = asObject(input)
  const allowed = new Set([
    'sourceKey',
    'legacySequence',
    'importedFrom',
    ...Object.keys(TEXT_FIELDS),
    ...Object.keys(ARRAY_FIELDS),
    'sourceKind',
    'parentSourceId',
    'priority',
    'coverageStatus',
    'deliveryStatus',
    'reviewStatus',
    'runtimeStatus',
    'evidenceRefs',
    'customFields',
  ])
  const unsupported = Object.keys(source).filter((field) => !allowed.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported source catalog fields: ${unsupported.join(', ')}`)
  }
  const sourceKey = text(source.sourceKey, 'sourceKey', { required: true, maximum: 128 })
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) {
    throw new AppError(400, 'invalid_source_catalog_field', 'sourceKey must use lowercase letters, numbers, dots, underscores or hyphens')
  }
  const normalized = {
    sourceKey,
    legacySequence: sequence(source.legacySequence),
    ...normalizeKnownFields(source, { partial: false }),
    importedFrom: text(source.importedFrom, 'importedFrom', { maximum: 160 }),
  }
  if (normalized.scenarios.length === 0) {
    throw new AppError(400, 'invalid_source_catalog_field', 'scenarios must contain at least one value')
  }
  if (normalized.regions.length === 0) {
    throw new AppError(400, 'invalid_source_catalog_field', 'regions must contain at least one value')
  }
  return normalized
}

export function normalizeSourceCatalogPatch(input) {
  const source = asObject(input)
  const allowed = new Set([
    ...Object.keys(TEXT_FIELDS),
    ...Object.keys(ARRAY_FIELDS),
    'sourceKind',
    'parentSourceId',
    'priority',
    'coverageStatus',
    'deliveryStatus',
    'reviewStatus',
    'runtimeStatus',
    'evidenceRefs',
    'customFields',
  ])
  const unsupported = Object.keys(source).filter((field) => field !== 'revision' && !allowed.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported source catalog fields: ${unsupported.join(', ')}`)
  }
  const patch = normalizeKnownFields(source, { partial: true })
  if (hasOwn(patch, 'scenarios') && patch.scenarios.length === 0) {
    throw new AppError(400, 'invalid_source_catalog_field', 'scenarios must contain at least one value')
  }
  if (hasOwn(patch, 'regions') && patch.regions.length === 0) {
    throw new AppError(400, 'invalid_source_catalog_field', 'regions must contain at least one value')
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, 'empty_source_catalog_patch', 'At least one editable field is required')
  }
  return patch
}

export function sourceCatalogRevision(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(400, 'invalid_source_catalog_revision', 'revision must be a positive integer')
  }
  return value
}

export function sourceCatalogId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_source_catalog_id', 'Source catalog id must be a UUID')
  }
  return value.toLowerCase()
}

function counts(values, field) {
  const result = {}
  for (const item of values) {
    const value = item[field] || 'unknown'
    result[value] = (result[value] || 0) + 1
  }
  return result
}

function distinct(values, selector) {
  return [...new Set(values.flatMap((item) => {
    const value = selector(item)
    return Array.isArray(value) ? value : value ? [value] : []
  }))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function sourceCatalogSnapshot(items) {
  const ordered = [...(items || [])].sort((left, right) => (
    Number(left.legacySequence || Number.MAX_SAFE_INTEGER) - Number(right.legacySequence || Number.MAX_SAFE_INTEGER)
      || left.canonicalName.localeCompare(right.canonicalName, 'zh-CN')
  ))
  const active = ordered.filter((item) => !item.archivedAt)
  const coverage = counts(active, 'coverageStatus')
  const delivery = counts(active, 'deliveryStatus')
  const priorities = counts(active, 'priority')
  const review = counts(active, 'reviewStatus')
  const covered = Number(coverage.covered || 0)
  const categories = new Map()
  for (const item of active) {
    const current = categories.get(item.majorCategory) || {
      category: item.majorCategory,
      total: 0,
      covered: 0,
      partial: 0,
      complete: 0,
      doing: 0,
    }
    current.total += 1
    if (item.coverageStatus === 'covered') current.covered += 1
    if (item.coverageStatus === 'partial') current.partial += 1
    if (item.deliveryStatus === 'complete') current.complete += 1
    if (item.deliveryStatus === 'doing') current.doing += 1
    categories.set(item.majorCategory, current)
  }
  return {
    items: ordered,
    summary: {
      total: active.length,
      archived: ordered.length - active.length,
      covered,
      uncovered: Number(coverage.not_covered || 0),
      partial: Number(coverage.partial || 0),
      unknownCoverage: Number(coverage.unknown || 0),
      coverageRate: active.length ? Number(((covered / active.length) * 100).toFixed(2)) : 0,
      complete: Number(delivery.complete || 0),
      inProgress: Number(delivery.doing || 0),
      exploring: Number(delivery.exploring || 0),
      blocked: Number(delivery.blocked || 0),
      unassigned: active.filter((item) => !item.owner).length,
      coverage,
      delivery,
      priorities,
      review,
      categories: [...categories.values()].sort((left, right) => right.total - left.total),
    },
    facets: {
      majorCategories: distinct(active, (item) => item.majorCategory),
      scenarios: distinct(active, (item) => item.scenarios),
      regions: distinct(active, (item) => item.regions),
      owners: distinct(active, (item) => item.owner),
      connectorHints: distinct(active, (item) => item.connectorHints),
      tags: distinct(active, (item) => item.tags),
    },
  }
}
