import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  COVERAGE_STATUSES,
  DELIVERY_STATUSES,
  REVIEW_STATUSES,
  RUNTIME_STATUSES,
  SOURCE_CATALOG_TERM_KINDS,
  SOURCE_KINDS,
  SOURCE_PRIORITIES,
  sourceCatalogSnapshot,
  sourceCatalogTermNormalizedName,
} from './source-catalog.mjs'

export const SOURCE_CATALOG_PLATFORM = 'source_catalog'
export const PUBLIC_SOURCE_CATALOG_CONTRACT = 'source-catalog.public.v1'

const CURSOR_VERSION = 1
const DEFAULT_PAGE_SIZE = 50
const HARD_MAX_PAGE_SIZE = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const FILTER_FIELDS = Object.freeze([
  'query',
  'sourceKind',
  'majorCategory',
  'scenario',
  'region',
  'coverageStatus',
  'deliveryStatus',
  'reviewStatus',
  'runtimeStatus',
  'priority',
  'ownerId',
  'tag',
])
const ALLOWED_QUERY_FIELDS = new Set([...FILTER_FIELDS, 'cursor', 'pageSize'])
const PRIVATE_TEXT = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\bmih_(?:live|test)_[A-Za-z0-9._-]{8,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/_.~=-]{8,}/iu,
  /\b(?:password|passwd|pwd|secret|token|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|authori[sz]ation|cookie|session|dsn|connection[-_ ]?string)\s*[:=]\s*(?:"[^"]{4,}"|'[^']{4,}'|[^\s,;]{4,})/iu,
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|jdbc:[a-z0-9+.-]+|s3|gs|oss):\/\/\S+/iu,
  /\bhttps?:\/\/[^/\s:@]+:[^@\s]+@/iu,
  /[?&](?:access[-_ ]?key|api[-_ ]?key|authori[sz]ation|password|secret|signature|token)=[^&#\s]+/iu,
  /\b(?:host|hostname|database|db|username|user|port)\s*[:=]\s*[^\s,;]{2,}/iu,
  /\b(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{2,5})?\b/iu,
])

export const PUBLIC_SOURCE_CATALOG_FIELDS = Object.freeze([
  { key: 'id', label: '稳定标识', type: 'uuid' },
  { key: 'sourceKey', label: '稳定键', type: 'text' },
  { key: 'legacySequence', label: '序号', type: 'integer' },
  { key: 'canonicalName', label: '数据源 / 平台', type: 'text' },
  { key: 'aliases', label: '别名', type: 'text[]' },
  { key: 'sourceKind', label: '来源类型', type: 'enum', enum: 'sourceKinds' },
  { key: 'parentSourceId', label: '上级数据源', type: 'uuid' },
  { key: 'majorCategory', label: '大类', type: 'taxonomy', taxonomyKind: 'major_category' },
  { key: 'scenarios', label: '细分场景', type: 'taxonomy[]', taxonomyKind: 'scenario' },
  { key: 'regions', label: '区域', type: 'taxonomy[]', taxonomyKind: 'region' },
  { key: 'entryModules', label: '代表入口 / 模块', type: 'text[]' },
  { key: 'monitorableContent', label: '可监测内容', type: 'text[]' },
  { key: 'extractableClues', label: '可提取线索', type: 'text[]' },
  { key: 'trackingFields', label: '主体追踪字段', type: 'text[]' },
  { key: 'suggestedAccess', label: '建议接入方式', type: 'text[]' },
  { key: 'complianceBoundary', label: '合规边界', type: 'text' },
  { key: 'priority', label: '优先级', type: 'enum', enum: 'priorities' },
  { key: 'coverageStatus', label: '覆盖状态', type: 'enum', enum: 'coverageStatuses' },
  { key: 'deliveryStatus', label: '实施阶段', type: 'enum', enum: 'deliveryStatuses' },
  { key: 'reviewStatus', label: '校验状态', type: 'enum', enum: 'reviewStatuses' },
  { key: 'runtimeStatus', label: '运行状态', type: 'enum', enum: 'runtimeStatuses' },
  { key: 'ownerId', label: '负责人标识', type: 'owner' },
  { key: 'owner', label: '负责人', type: 'text' },
  { key: 'connectorHints', label: '接入线索', type: 'text[]' },
  { key: 'tags', label: '标签', type: 'taxonomy[]', taxonomyKind: 'tag' },
  { key: 'notes', label: '备注 / 待补充', type: 'text' },
  { key: 'redactedFields', label: '已脱敏字段', type: 'text[]' },
])

function containsPrivateText(value) {
  return typeof value === 'string' && PRIVATE_TEXT.some((pattern) => pattern.test(value))
}

function publicText(value, field, redacted, { required = false } = {}) {
  if (value == null) return null
  if (typeof value !== 'string') {
    redacted.add(field)
    return required ? '[redacted]' : null
  }
  if (containsPrivateText(value)) {
    redacted.add(field)
    return required ? '[redacted]' : null
  }
  return value
}

function publicTextArray(values, field, redacted) {
  if (!Array.isArray(values)) return []
  const published = values.filter((value) => {
    if (typeof value !== 'string') {
      redacted.add(field)
      return false
    }
    if (!containsPrivateText(value)) return true
    redacted.add(field)
    return false
  })
  return [...published]
}

function singleValue(input, field, maximum = 160) {
  const value = input[field]
  if (value == null || value === '') return null
  if (Array.isArray(value) || typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new AppError(
      400,
      'invalid_request',
      `${field} must be a non-blank string of at most ${maximum} characters`,
    )
  }
  return value.normalize('NFKC').trim()
}

function enumValue(input, field, values) {
  const value = singleValue(input, field)
  if (value == null) return null
  if (!values.includes(value)) {
    throw new AppError(400, 'invalid_request', `${field} must be one of ${values.join(', ')}`)
  }
  return value
}

function pageSizeValue(value, maxPageSize) {
  const maximum = Math.min(HARD_MAX_PAGE_SIZE, Math.max(1, Number(maxPageSize) || HARD_MAX_PAGE_SIZE))
  if (value == null || value === '') return Math.min(DEFAULT_PAGE_SIZE, maximum)
  if (Array.isArray(value) || !/^\d+$/u.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > maximum) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must be between 1 and ${maximum}`)
  }
  return pageSize
}

function cursorBinding(filters, pageSize) {
  return createHash('sha256')
    .update(JSON.stringify({ v: CURSOR_VERSION, filters, pageSize }))
    .digest('base64url')
}

function cursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Source catalog cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function validCursorPosition(position) {
  return position
    && typeof position === 'object'
    && !Array.isArray(position)
    && Object.keys(position).sort().join(',') === 'canonicalName,id,legacySequence'
    && (
      position.legacySequence === null
      || (Number.isSafeInteger(position.legacySequence) && position.legacySequence > 0)
    )
    && typeof position.canonicalName === 'string'
    && position.canonicalName.length > 0
    && position.canonicalName.length <= 160
    && UUID_PATTERN.test(position.id || '')
}

function decodeCursor(value, binding, secret) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = { v: parsed?.v, position: parsed?.position, binding: parsed?.binding }
    if (
      Object.keys(parsed || {}).sort().join(',') !== 'binding,position,s,v'
      || parsed.v !== CURSOR_VERSION
      || !validCursorPosition(parsed.position)
      || parsed.binding !== binding
      || typeof parsed.s !== 'string'
      || !signaturesMatch(parsed.s, cursorSignature(payload, secret))
    ) {
      throw new Error('invalid cursor')
    }
    return parsed.position
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous page cursor unchanged')
  }
}

function encodeCursor(position, binding, secret) {
  const payload = { v: CURSOR_VERSION, position, binding }
  return Buffer.from(JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }), 'utf8')
    .toString('base64url')
}

export function normalizePublicSourceCatalogQuery(input = {}, maxPageSize = HARD_MAX_PAGE_SIZE, cursorSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'Source catalog query must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported source catalog filters: ${unsupported.join(', ')}`)
  }
  const ownerId = singleValue(input, 'ownerId', 36)
  if (ownerId && !UUID_PATTERN.test(ownerId)) {
    throw new AppError(400, 'invalid_request', 'ownerId must be a UUID')
  }
  const filters = {
    query: singleValue(input, 'query', 240),
    sourceKind: enumValue(input, 'sourceKind', SOURCE_KINDS),
    majorCategory: singleValue(input, 'majorCategory'),
    scenario: singleValue(input, 'scenario'),
    region: singleValue(input, 'region'),
    coverageStatus: enumValue(input, 'coverageStatus', COVERAGE_STATUSES),
    deliveryStatus: enumValue(input, 'deliveryStatus', DELIVERY_STATUSES),
    reviewStatus: enumValue(input, 'reviewStatus', REVIEW_STATUSES),
    runtimeStatus: enumValue(input, 'runtimeStatus', RUNTIME_STATUSES),
    priority: enumValue(input, 'priority', SOURCE_PRIORITIES),
    ownerId: ownerId?.toLowerCase() || null,
    tag: singleValue(input, 'tag'),
  }
  const pageSize = pageSizeValue(input.pageSize, maxPageSize)
  const binding = cursorBinding(filters, pageSize)
  const cursorToken = singleValue(input, 'cursor', 4_096)
  return {
    filters,
    pageSize,
    cursorToken,
    cursor: decodeCursor(cursorToken, binding, cursorSecret),
    cursorBinding: binding,
  }
}

export function normalizePublicSourceCatalogMetadataQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'Source catalog metadata query must be an object')
  }
  const unsupported = Object.keys(input)
  if (unsupported.length > 0) {
    throw new AppError(
      400,
      'unsupported_fields',
      `Unsupported source catalog metadata fields: ${unsupported.join(', ')}`,
    )
  }
  return {}
}

function comparable(value) {
  return sourceCatalogTermNormalizedName(value)
}

function includesComparable(values, expected) {
  if (!expected) return true
  const normalized = comparable(expected)
  return (values || []).some((value) => comparable(value) === normalized)
}

function searchableText(entry) {
  return [
    entry.canonicalName,
    ...(entry.aliases || []),
    entry.majorCategory,
    ...(entry.scenarios || []),
    ...(entry.regions || []),
    ...(entry.entryModules || []),
    ...(entry.monitorableContent || []),
    ...(entry.extractableClues || []),
    ...(entry.trackingFields || []),
    ...(entry.suggestedAccess || []),
    entry.complianceBoundary,
    entry.owner,
    ...(entry.connectorHints || []),
    ...(entry.tags || []),
    entry.notes,
  ].filter(Boolean).join('\n').normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function matches(entry, filters) {
  return (!filters.query || searchableText(entry).includes(comparable(filters.query)))
    && (!filters.sourceKind || entry.sourceKind === filters.sourceKind)
    && (!filters.majorCategory || comparable(entry.majorCategory) === comparable(filters.majorCategory))
    && includesComparable(entry.scenarios, filters.scenario)
    && includesComparable(entry.regions, filters.region)
    && (!filters.coverageStatus || entry.coverageStatus === filters.coverageStatus)
    && (!filters.deliveryStatus || entry.deliveryStatus === filters.deliveryStatus)
    && (!filters.reviewStatus || entry.reviewStatus === filters.reviewStatus)
    && (!filters.runtimeStatus || entry.runtimeStatus === filters.runtimeStatus)
    && (!filters.priority || entry.priority === filters.priority)
    && (!filters.ownerId || entry.ownerId === filters.ownerId)
    && includesComparable(entry.tags, filters.tag)
}

export function publicSourceCatalogItem(entry) {
  const redacted = new Set()
  return {
    id: entry.id,
    sourceKey: publicText(entry.sourceKey, 'sourceKey', redacted, { required: true }),
    legacySequence: entry.legacySequence ?? null,
    canonicalName: publicText(entry.canonicalName, 'canonicalName', redacted, { required: true }),
    aliases: publicTextArray(entry.aliases, 'aliases', redacted),
    sourceKind: entry.sourceKind,
    parentSourceId: entry.parentSourceId ?? null,
    majorCategory: publicText(entry.majorCategory, 'majorCategory', redacted, { required: true }),
    scenarios: publicTextArray(entry.scenarios, 'scenarios', redacted),
    regions: publicTextArray(entry.regions, 'regions', redacted),
    entryModules: publicTextArray(entry.entryModules, 'entryModules', redacted),
    monitorableContent: publicTextArray(entry.monitorableContent, 'monitorableContent', redacted),
    extractableClues: publicTextArray(entry.extractableClues, 'extractableClues', redacted),
    trackingFields: publicTextArray(entry.trackingFields, 'trackingFields', redacted),
    suggestedAccess: publicTextArray(entry.suggestedAccess, 'suggestedAccess', redacted),
    complianceBoundary: publicText(entry.complianceBoundary, 'complianceBoundary', redacted),
    priority: entry.priority,
    coverageStatus: entry.coverageStatus,
    deliveryStatus: entry.deliveryStatus,
    reviewStatus: entry.reviewStatus,
    runtimeStatus: entry.runtimeStatus,
    ownerId: entry.ownerId ?? null,
    owner: publicText(entry.owner, 'owner', redacted),
    connectorHints: publicTextArray(entry.connectorHints, 'connectorHints', redacted),
    tags: publicTextArray(entry.tags, 'tags', redacted),
    notes: publicText(entry.notes, 'notes', redacted),
    redactedFields: [...redacted].sort(),
  }
}

function catalogSortKey(entry) {
  return {
    legacySequence: entry.legacySequence ?? null,
    canonicalName: entry.canonicalName,
    id: entry.id,
  }
}

function compareCatalogKeys(left, right) {
  const leftSequence = left.legacySequence ?? Number.MAX_SAFE_INTEGER
  const rightSequence = right.legacySequence ?? Number.MAX_SAFE_INTEGER
  return leftSequence - rightSequence
    || left.canonicalName.localeCompare(right.canonicalName, 'zh-CN')
    || left.id.localeCompare(right.id)
}

export function publicSourceCatalogPage(entries, query, cursorSecret) {
  const filtered = (entries || [])
    .filter((entry) => !entry.archivedAt)
    .map(publicSourceCatalogItem)
    .filter((entry) => matches(entry, query.filters))
    .sort((left, right) => compareCatalogKeys(catalogSortKey(left), catalogSortKey(right)))
  const startIndex = query.cursor
    ? filtered.findIndex((entry) => compareCatalogKeys(catalogSortKey(entry), query.cursor) > 0)
    : 0
  const pageStart = startIndex < 0 ? filtered.length : startIndex
  const page = filtered.slice(pageStart, pageStart + query.pageSize)
  const hasMore = pageStart + page.length < filtered.length
  return {
    contractVersion: PUBLIC_SOURCE_CATALOG_CONTRACT,
    items: page,
    filters: { ...query.filters },
    pageInfo: {
      returnedCount: page.length,
      totalCount: filtered.length,
      hasMore,
      nextCursor: hasMore && page.length > 0
        ? encodeCursor(catalogSortKey(page.at(-1)), query.cursorBinding, cursorSecret)
        : null,
    },
  }
}

function publicOwner(owner, entries) {
  const redacted = new Set()
  return {
    id: owner.id,
    displayName: publicText(owner.displayName, 'displayName', redacted, { required: true }),
    description: publicText(owner.description, 'description', redacted),
    usageCount: entries.filter((entry) => entry.ownerId === owner.id).length,
    ...(redacted.size > 0 ? { redactedFields: [...redacted].sort() } : {}),
  }
}

function termValues(entry, kind) {
  if (kind === 'major_category') return [entry.majorCategory]
  if (kind === 'scenario') return entry.scenarios || []
  if (kind === 'region') return entry.regions || []
  return entry.tags || []
}

function publicTerm(term, entries) {
  const redacted = new Set()
  return {
    id: term.id,
    termKey: publicText(term.termKey, 'termKey', redacted, { required: true }),
    kind: term.kind,
    displayName: publicText(term.displayName, 'displayName', redacted, { required: true }),
    description: publicText(term.description, 'description', redacted),
    color: publicText(term.color, 'color', redacted),
    sortOrder: Number(term.sortOrder || 0),
    usageCount: entries.filter((entry) => (
      termValues(entry, term.kind).some((value) => comparable(value) === comparable(term.displayName))
    )).length,
    ...(redacted.size > 0 ? { redactedFields: [...redacted].sort() } : {}),
  }
}

export function publicSourceCatalogMetadata(entries, taxonomyTerms, owners) {
  const activeEntries = (entries || []).filter((entry) => !entry.archivedAt)
  const activeTerms = (taxonomyTerms || []).filter((term) => !term.archivedAt)
  const activeOwners = (owners || []).filter((owner) => !owner.archivedAt)
  const projectedEntries = activeEntries.map(publicSourceCatalogItem)
  const projectedTerms = activeTerms.map((term) => {
    const redacted = new Set()
    return {
      ...term,
      termKey: publicText(term.termKey, 'termKey', redacted, { required: true }),
      displayName: publicText(term.displayName, 'displayName', redacted, { required: true }),
    }
  })
  const snapshot = sourceCatalogSnapshot(projectedEntries, projectedTerms)
  const { archived: _archived, ...activeSummary } = snapshot.summary
  return {
    contractVersion: PUBLIC_SOURCE_CATALOG_CONTRACT,
    fields: PUBLIC_SOURCE_CATALOG_FIELDS.map((field) => ({ ...field })),
    enums: {
      sourceKinds: [...SOURCE_KINDS],
      coverageStatuses: [...COVERAGE_STATUSES],
      deliveryStatuses: [...DELIVERY_STATUSES],
      reviewStatuses: [...REVIEW_STATUSES],
      runtimeStatuses: [...RUNTIME_STATUSES],
      priorities: [...SOURCE_PRIORITIES],
      taxonomyKinds: [...SOURCE_CATALOG_TERM_KINDS],
    },
    summary: activeSummary,
    facets: snapshot.facets,
    taxonomy: activeTerms.map((term) => publicTerm(term, activeEntries)),
    owners: activeOwners.map((owner) => publicOwner(owner, activeEntries)),
  }
}
