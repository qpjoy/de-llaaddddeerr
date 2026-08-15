import { sha256, canonicalJson } from '../normalizers.mjs'

// Declarative mapping from an arbitrary external record to a canonical one.
//
// The mapping is data, not code: it lives in `catalog.source_mappings`, is
// versioned, and is what an operator (or, once P5 lands, the agent) proposes and
// approves. Keeping it declarative is what makes "why is this field empty"
// answerable — the mapping in force when the row was written is still on record.
//
// Shape:
//   {
//     "externalId": { "from": "id" },
//     "title":      { "from": ["标题", "title"] },
//     "eventTime":  { "from": "发布时间", "type": "timestamp" },
//     "metrics.likes": { "from": "点赞数", "type": "number" }
//   }
//
// `from` may list several source columns; the first non-empty one wins, which is
// how one mapping absorbs a source that renamed a column halfway through its
// history without splitting into two mappings.

export const CHUNKER_VERSION = 'mxih-external.v1'

const SCALAR_TARGETS = new Set([
  'externalId', 'contentType', 'url', 'title', 'body',
  'authorExternalId', 'authorName', 'language',
  'countryCode', 'admin1Code', 'admin2Code',
])
const TIME_TARGETS = new Set(['eventTime', 'collectedAt', 'editedAt', 'deletedAt'])
const NUMBER_TARGETS = new Set(['latitude', 'longitude'])
const METRIC_TARGETS = new Set([
  'metrics.likes', 'metrics.comments', 'metrics.shares', 'metrics.views', 'metrics.bookmarks',
  'metrics.members',
])
const ATTRIBUTE_TARGETS = new Set(['attributes.username', 'attributes.chatType'])
const BOOLEAN_TARGETS = new Set(['attributes.isOutgoing'])
const JSON_TARGETS = new Set(['media', 'entities', 'links'])
const RELATION_TARGETS = new Set([
  'relations.chatId', 'relations.messageId', 'relations.replyToMessageId',
  'relations.threadId', 'relations.groupedId',
])
const DROP_TARGET = '_drop'

export class MappingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MappingError'
  }
}

/**
 * Validate a mapping before it can be approved.
 *
 * Rejecting an unknown target is the point: a typo like `titel` would otherwise
 * be accepted, map nothing, and produce a corpus of untitled records that looks
 * like a source-data problem rather than a configuration one.
 */
export function validateFieldMap(fieldMap) {
  if (!fieldMap || typeof fieldMap !== 'object' || Array.isArray(fieldMap)) {
    throw new MappingError('fieldMap must be an object')
  }
  const known = new Set([
    ...SCALAR_TARGETS, ...TIME_TARGETS, ...NUMBER_TARGETS, ...METRIC_TARGETS,
    ...ATTRIBUTE_TARGETS, ...BOOLEAN_TARGETS, ...JSON_TARGETS, ...RELATION_TARGETS,
    DROP_TARGET,
  ])
  const errors = []
  for (const [target, rule] of Object.entries(fieldMap)) {
    if (!known.has(target)) {
      errors.push(`unknown target field: ${target}`)
      continue
    }
    const sources = Array.isArray(rule?.from) ? rule.from : [rule?.from]
    if (sources.length === 0 || sources.some((column) => typeof column !== 'string' || !column)) {
      errors.push(`${target}.from must be a column name or a non-empty array of them`)
    }
    if (target === DROP_TARGET && rule?.type != null) {
      errors.push('_drop does not accept a type; it only marks source columns as intentionally omitted')
    } else if (rule?.type === 'composite') {
      if (target !== 'externalId' || sources.length < 2) {
        errors.push('type=composite is supported only for externalId with at least two source columns')
      }
      if (rule.separator != null && (typeof rule.separator !== 'string' || !rule.separator || rule.separator.length > 8)) {
        errors.push('externalId.separator must be a non-empty string of at most 8 characters')
      }
    }
  }
  // externalId is the dedup key. Without it every import would create new rows
  // for the same records, which is silent duplication rather than a visible
  // failure — so its absence is an error, not a default.
  if (!fieldMap.externalId) errors.push('externalId is required: it is the deduplication key')
  if (errors.length > 0) throw new MappingError(errors.join('; '))
  return true
}

function sourceValue(record, column) {
  // Prefer an exact column name so PostgreSQL identifiers that contain dots
  // keep their literal meaning. HTTP/JSON sources may then address a nested
  // value such as metadata.views without flattening or mutating the raw row.
  if (Object.prototype.hasOwnProperty.call(record, column)) return record[column]
  if (!column.includes('.')) return undefined
  let current = record
  for (const segment of column.split('.')) {
    if (
      current == null
      || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, segment)
    ) return undefined
    current = current[segment]
  }
  return current
}

function pick(record, rule) {
  const sources = Array.isArray(rule?.from) ? rule.from : [rule?.from]
  if (rule?.type === 'composite') {
    const values = sources.map((column) => sourceValue(record, column))
    if (values.some((value) => value === undefined || value === null || String(value).trim() === '')) return null
    return values.map((value) => String(value).trim()).join(rule.separator || ':')
  }
  for (const column of sources) {
    const value = sourceValue(record, column)
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    return value
  }
  return null
}

function asNumber(value) {
  if (value === null) return null
  // Spreadsheets routinely carry "1,234" and "12%". Strip grouping and trailing
  // symbols rather than yielding NaN, which would silently drop the metric.
  const cleaned = String(value).replace(/[,\s]/g, '').replace(/%$/, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

function asTimestamp(value) {
  if (value === null) return null
  const text = String(value).trim()

  // Scraped/social datasets commonly use Unix epoch values. Keep the accepted
  // shapes explicit: 10 digits are seconds and 13 digits are milliseconds.
  // Guessing by numeric magnitude would make malformed IDs look like dates.
  if (/^\d{10}$/u.test(text)) return new Date(Number(text) * 1_000)
  if (/^\d{13}$/u.test(text)) return new Date(Number(text))

  // Excel serial dates: days since 1899-12-30 (Lotus 1-2-3 leap-year bug and
  // all). A bare number in a date column is otherwise parsed as a year.
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text)
    if (serial > 20_000 && serial < 80_000) {
      return new Date(Math.round((serial - 25_569) * 86_400_000))
    }
  }
  // Normalise "2026-08-06 11:20:25" to ISO; bare-space form is not valid ISO
  // and parses inconsistently across engines.
  const parsed = new Date(text.includes(' ') && !text.includes('T') ? text.replace(' ', 'T') : text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false
  return null
}

/**
 * Apply a mapping to one raw record.
 *
 * Returns `{ record, rejected }`. A row missing its external id is rejected
 * rather than given a synthetic key: a synthetic key cannot deduplicate, so the
 * same row would be re-inserted on every import.
 */
export function applyMapping(raw, fieldMap, { platform, objectType = 'record', source = null }) {
  const mapped = {}
  const consumed = new Set()

  for (const [target, rule] of Object.entries(fieldMap)) {
    const sources = Array.isArray(rule?.from) ? rule.from : [rule?.from]
    for (const column of sources) consumed.add(column)
    if (target === DROP_TARGET) continue
    const value = pick(raw, rule)
    if (value === null) continue

    if (TIME_TARGETS.has(target)) mapped[target] = asTimestamp(value)
    else if (NUMBER_TARGETS.has(target) || METRIC_TARGETS.has(target)) mapped[target] = asNumber(value)
    else if (BOOLEAN_TARGETS.has(target)) mapped[target] = asBoolean(value)
    else if (JSON_TARGETS.has(target)) mapped[target] = value
    else mapped[target] = String(value).trim()
  }

  const externalId = mapped.externalId
  if (!externalId) {
    return { record: null, rejected: 'externalId is empty or missing in this row' }
  }

  // Everything the mapping did not consume is preserved under `extensions`
  // rather than dropped. This is the layer that makes "promote a field to a
  // real column later" possible without re-importing the source.
  const extensions = {}
  for (const [key, value] of Object.entries(raw)) {
    if (consumed.has(key)) continue
    if (value === null || value === undefined || String(value).trim() === '') continue
    extensions[key] = value
  }

  const metrics = {}
  for (const target of METRIC_TARGETS) {
    const value = mapped[target]
    if (typeof value === 'number') metrics[target.slice('metrics.'.length)] = value
  }

  const attributes = {}
  for (const target of [...ATTRIBUTE_TARGETS, ...BOOLEAN_TARGETS]) {
    const value = mapped[target]
    if (value !== undefined) attributes[target.slice('attributes.'.length)] = value
  }
  const relations = {}
  for (const target of RELATION_TARGETS) {
    const value = mapped[target]
    if (value !== undefined) relations[target.slice('relations.'.length)] = value
  }

  const record = {
    platform,
    objectType,
    externalId: String(externalId).trim(),
    contentType: mapped.contentType ?? null,
    url: mapped.url ?? null,
    title: mapped.title ?? null,
    body: mapped.body ?? null,
    authorExternalId: mapped.authorExternalId ?? null,
    authorName: mapped.authorName ?? null,
    eventTime: mapped.eventTime ?? null,
    collectedAt: mapped.collectedAt ?? new Date(),
    editedAt: mapped.editedAt ?? null,
    deletedAt: mapped.deletedAt ?? null,
    latitude: mapped.latitude ?? null,
    longitude: mapped.longitude ?? null,
    countryCode: mapped.countryCode ?? null,
    admin1Code: mapped.admin1Code ?? null,
    admin2Code: mapped.admin2Code ?? null,
    stableFields: {
      author: {
        externalId: mapped.authorExternalId ?? null,
        name: mapped.authorName ?? null,
        handle: attributes.username ?? null,
      },
      media: mapped.media ?? {},
      entities: Array.isArray(mapped.entities) ? mapped.entities : [],
      links: Array.isArray(mapped.links) ? mapped.links : [],
      metrics,
      attributes,
      relations,
      editedAt: mapped.editedAt ?? null,
      ...(source ? { source } : {}),
      language: mapped.language ?? null,
    },
    extensions,
    metrics,
    rawItem: raw,
  }

  // Collection time is observation metadata, not content. Metrics remain in
  // the hash: they are part of the public/search projection, so excluding them
  // would update PostgreSQL without incrementing projection_revision and leave
  // Elasticsearch/AI reads stale.
  record.payloadSha256 = sha256(canonicalJson(contentOnly(record)))
  return { record, rejected: null }
}

function contentOnly(record) {
  const { collectedAt: _collectedAt, metrics: _metrics, rawItem: _rawItem, ...rest } = record
  return rest
}

/**
 * Suggest a mapping by matching column names against known aliases.
 *
 * This is the deterministic baseline the agent improves on, not a replacement
 * for it — and it is worth having on its own, because most spreadsheets from a
 * known workflow have predictable headers and should not need a model call.
 * Every suggestion carries `origin: 'inferred'` and still requires approval.
 */
const COLUMN_ALIASES = {
  externalId: ['id', 'ID', '编号', 'external_id', 'externalId', 'note_id', 'uid', 'key'],
  title: ['title', '标题', '主题', 'name', '名称'],
  body: ['body', 'content', '正文', '内容', 'text', '描述', 'description'],
  url: ['url', 'link', '链接', '网址'],
  authorName: ['author', '作者', '昵称', 'nickname', 'user_name', 'username', '用户名'],
  authorExternalId: ['author_id', 'user_id', '用户id', 'uid'],
  eventTime: ['published_at', '发布时间', 'date', '日期', 'created_at', '时间', 'time'],
  contentType: ['type', '类型', 'category', '分类'],
  'metrics.likes': ['likes', '点赞', '点赞数', 'like_count'],
  'metrics.comments': ['comments', '评论', '评论数', 'comment_count'],
  'metrics.shares': ['shares', '转发', '分享', 'share_count'],
  'metrics.views': ['views', '播放', '浏览', 'view_count'],
  'metrics.bookmarks': ['bookmarks', '收藏', 'collect_count'],
}

export function inferFieldMap(columns) {
  const normalized = new Map(columns.map((column) => [String(column).trim().toLowerCase(), column]))
  const fieldMap = {}
  const used = new Set()
  for (const [target, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const match = normalized.get(alias.toLowerCase())
      // One source column maps to one target: letting "id" satisfy both
      // externalId and authorExternalId produces records that are their own
      // authors, which is worse than leaving the field null.
      if (match && !used.has(match)) {
        fieldMap[target] = { from: match }
        used.add(match)
        break
      }
    }
  }
  return fieldMap
}
