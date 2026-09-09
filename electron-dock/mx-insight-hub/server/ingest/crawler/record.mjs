import { isCrawlerSourceKey } from './source-contract.mjs'

const CRAWLER_RECORD_CONTRACT_VERSION = 'mx-insight-hub.crawler-saved-record.v1'
const SHANGHAI_TIMEZONE = 'Asia/Shanghai'
const SHANGHAI_OFFSET_MINUTES = 8 * 60
const PUBLICATION_CANDIDATE_TYPES = new Set(['news', 'news.article'])

const REVIEWED_COLLECTOR_SOURCE_KEYS = new Map([
  ['baijia', 'source-catalog-0013'],
  ['china-news', 'source-catalog-0149'],
  ['google-news', 'source-catalog-0147'],
  ['google-news-browser', 'source-catalog-0147'],
  ['toutiao', 'source-catalog-0010'],
])

function optionalValue(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function firstValue(...values) {
  for (const value of values) {
    const text = optionalValue(value)
    if (text) return text
  }
  return null
}

function normalizedLabel(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

function normalizedObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizedTags(value) {
  let candidates = value
  if (typeof candidates === 'string') {
    try {
      candidates = JSON.parse(candidates)
    } catch {
      candidates = candidates.split(/[;,，、]/u)
    }
  }
  if (!Array.isArray(candidates)) return []
  return [...new Set(candidates.map(optionalValue).filter(Boolean))].slice(0, 50)
}

function catalogView(entry, sourceValue) {
  return {
    status: 'mapped',
    sourceValue,
    entryId: entry.id,
    sourceKey: entry.sourceKey,
    revision: entry.revision,
    canonicalName: entry.canonicalName,
    majorCategory: entry.majorCategory,
    scenarios: [...(entry.scenarios || [])],
    regions: [...(entry.regions || [])],
  }
}

function unresolvedCatalogView(sourceValue) {
  return {
    status: 'unresolved',
    sourceValue,
    entryId: null,
    sourceKey: null,
    revision: null,
    canonicalName: null,
    majorCategory: null,
    scenarios: [],
    regions: [],
  }
}

/**
 * Build a deterministic classifier from one authoritative catalog snapshot.
 * Ambiguous aliases resolve to nothing instead of selecting whichever row the
 * database happened to return first.
 */
export function createCrawlerCatalogClassifier(entries = []) {
  const active = [...(entries || [])]
    .filter((entry) => entry && !entry.archivedAt)
    .sort((left, right) => (
      String(left.sourceKey || '').localeCompare(String(right.sourceKey || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ))
  const bySourceKey = new Map()
  const byLabel = new Map()

  for (const entry of active) {
    if (entry.sourceKey && !bySourceKey.has(entry.sourceKey)) {
      bySourceKey.set(entry.sourceKey, entry)
    }
    for (const label of [entry.canonicalName, ...(entry.aliases || [])]) {
      const normalized = normalizedLabel(label)
      if (!normalized) continue
      if (!byLabel.has(normalized)) byLabel.set(normalized, entry)
      else if (byLabel.get(normalized)?.id !== entry.id) byLabel.set(normalized, null)
    }
  }

  return (values, { preferredSourceKey = null } = {}) => {
    const candidates = (Array.isArray(values) ? values : [values])
      .map(optionalValue)
      .filter(Boolean)
    const sourceValue = candidates[0] ?? null
    if (preferredSourceKey) {
      const preferred = bySourceKey.get(preferredSourceKey)
      if (preferred) return catalogView(preferred, sourceValue)
    }
    for (const candidate of candidates) {
      const matched = byLabel.get(normalizedLabel(candidate))
      if (matched) return catalogView(matched, sourceValue)
    }
    return unresolvedCatalogView(sourceValue)
  }
}

function leapYear(year) {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
}

function validCalendar({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  if (year < 1 || year > 9999 || month < 1 || month > 12) return false
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
}

function utcMillis(parts, offsetMinutes) {
  const date = new Date(0)
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond)
  return date.getTime() - offsetMinutes * 60_000
}

function offsetDetails(value) {
  if (value === 'Z' || value === 'z') return { minutes: 0, label: '+00:00' }
  const matched = /^([+-])(\d{2})(?::?(\d{2}))?$/u.exec(value)
  if (!matched) return null
  const hours = Number(matched[2])
  const minutes = Number(matched[3] || 0)
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null
  const sign = matched[1] === '-' ? -1 : 1
  return {
    minutes: sign * (hours * 60 + minutes),
    label: `${matched[1]}${matched[2]}:${String(minutes).padStart(2, '0')}`,
  }
}

function descriptor(raw, normalized, {
  status,
  precision = null,
  timezone = null,
  timezoneSource = null,
  instant = null,
  issues = [],
} = {}) {
  const trimmed = raw !== null && raw.trim() !== raw
  return {
    raw,
    normalized,
    status,
    precision,
    timezone,
    timezoneSource,
    instant,
    trimmed,
    issues: [...(trimmed ? ['surrounding-whitespace'] : []), ...issues],
  }
}

/**
 * Parse the crawler's textual published_at without relying on process locale.
 * A calendar date is deliberately not promoted to midnight: it describes a
 * day, not an instant. Unsupported values remain visible in the descriptor.
 */
export function parseCrawlerPublishedAt(value) {
  const raw = value === null || value === undefined ? null : String(value)
  const normalized = raw?.trim() || null
  if (!normalized) return descriptor(raw, null, { status: 'missing' })

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized)
  if (dateOnly) {
    const parts = {
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
    }
    return validCalendar(parts)
      ? descriptor(raw, normalized, { status: 'date-only', precision: 'date' })
      : descriptor(raw, normalized, {
          status: 'invalid',
          precision: 'date',
          issues: ['invalid-calendar-date'],
        })
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/u.exec(normalized)
  if (!dateTime) {
    return descriptor(raw, normalized, { status: 'invalid', issues: ['unsupported-format'] })
  }
  const fraction = dateTime[7] || ''
  const parts = {
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6] || 0),
    millisecond: Number(`${fraction}000`.slice(0, 3)),
  }
  const precision = fraction ? 'fraction' : dateTime[6] ? 'second' : 'minute'
  if (!validCalendar(parts)) {
    return descriptor(raw, normalized, {
      status: 'invalid',
      precision,
      issues: ['invalid-calendar-date'],
    })
  }

  const explicitOffset = dateTime[8] ? offsetDetails(dateTime[8]) : null
  if (dateTime[8] && !explicitOffset) {
    return descriptor(raw, normalized, {
      status: 'invalid',
      precision,
      issues: ['invalid-timezone-offset'],
    })
  }
  const timezone = explicitOffset?.label ?? SHANGHAI_TIMEZONE
  const timezoneSource = explicitOffset ? 'explicit-offset' : 'assumed'
  const instant = new Date(utcMillis(
    parts,
    explicitOffset?.minutes ?? SHANGHAI_OFFSET_MINUTES,
  ))
  if (!Number.isFinite(instant.getTime())) {
    return descriptor(raw, normalized, {
      status: 'invalid',
      precision,
      issues: ['instant-out-of-range'],
    })
  }
  return descriptor(raw, normalized, {
    status: 'parsed',
    precision,
    timezone,
    timezoneSource,
    instant: instant.toISOString(),
  })
}

function sourceTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  return optionalValue(value)
}

function sourceDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value.trim())) return null
  const parsed = new Date(value.trim())
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function collectorPreferredSourceKey(connectorId) {
  return REVIEWED_COLLECTOR_SOURCE_KEYS.get(normalizedLabel(connectorId)) ?? null
}

function publication(recordType, record) {
  const candidateType = PUBLICATION_CANDIDATE_TYPES.has(recordType)
  const hasContent = Boolean(firstValue(record?.title, record?.body))
  const candidate = candidateType && hasContent
  return {
    eligibility: candidate ? 'candidate' : 'internal',
    reason: candidate
      ? 'record-type-candidate'
      : candidateType ? 'content-empty' : 'record-type-internal',
  }
}

function clearSourceUrlYear(value) {
  const sourceUrl = optionalValue(value)
  if (!sourceUrl) return null
  let pathname
  try {
    pathname = new URL(sourceUrl).pathname
  } catch {
    return null
  }
  const years = [...pathname.matchAll(/(?:^|[\/_-])((?:19|20)\d{2})(?=$|[\/_-])/gu)]
    .map((matched) => Number(matched[1]))
  const distinct = [...new Set(years)]
  return distinct.length === 1 ? distinct[0] : null
}

/**
 * Add the fixed crawler saved-record contract after declarative mapping.
 * Restricted raw/evidence payloads stay with mapping/archive lineage and are
 * never copied into these safe, typed facets.
 */
export function enrichCrawlerRecord(record, raw, source, { classifyCatalog } = {}) {
  if (!record || !isCrawlerSourceKey(source?.sourceKey)) return record
  const classify = typeof classifyCatalog === 'function'
    ? classifyCatalog
    : (values) => unresolvedCatalogView(firstValue(...(Array.isArray(values) ? values : [values])))
  const attributes = normalizedObject(raw?.attributes) || {}
  const connectorId = optionalValue(raw?.connector_id)
  const sourceFamily = optionalValue(raw?.source_family)
  const providerCode = firstValue(raw?.provider_code, attributes.platform)
  const providerName = firstValue(raw?.provider_name, attributes.platform_name)
  const sourceSection = firstValue(raw?.source_section, attributes.section)
  const author = normalizedObject(raw?.author) || {}
  const authorName = optionalValue(author.name)
  const authorOrganization = optionalValue(author.organization)
  const sourceType = optionalValue(raw?.source_type)
  const recordType = optionalValue(raw?.record_type)
  const recordKey = optionalValue(raw?.record_key)
  const firstSeenAt = sourceTimestamp(raw?.first_seen_at)
  const lastSeenAt = sourceTimestamp(raw?.last_seen_at)
  const createdAt = sourceTimestamp(raw?.created_at)
  let publishedAt = parseCrawlerPublishedAt(raw?.published_at)
  const tags = normalizedTags(raw?.source_tags ?? attributes.tags)

  const semanticIssues = []
  if (recordKey && optionalValue(record.externalId) !== recordKey) {
    semanticIssues.push('canonical-external-id-differs-from-record-key')
  }
  if (publishedAt.status === 'invalid') semanticIssues.push('published-at-invalid')
  const parsedPublishedDate = publishedAt.instant ? new Date(publishedAt.instant) : null
  const parsedPublishedYear = ['parsed', 'date-only'].includes(publishedAt.status)
    ? Number(publishedAt.normalized?.slice(0, 4))
    : null
  const urlYear = clearSourceUrlYear(raw?.source_url)
  const publishedYearConflict = Number.isInteger(parsedPublishedYear)
    && Number.isInteger(urlYear)
    && parsedPublishedYear !== urlYear
  if (publishedYearConflict) {
    publishedAt = {
      ...publishedAt,
      semanticStatus: 'conflict',
      conflict: {
        kind: 'source-url-year',
        publishedYear: parsedPublishedYear,
        sourceUrlYear: urlYear,
      },
      issues: [...new Set([...publishedAt.issues, 'source-url-year-conflict'])],
    }
    semanticIssues.push('published-year-conflicts-with-source-url')
  }
  const publishedDate = publishedYearConflict ? null : parsedPublishedDate
  const firstSeenDate = sourceDate(raw?.first_seen_at)
  const lastSeenDate = sourceDate(raw?.last_seen_at)
  const createdDate = sourceDate(raw?.created_at)
  const editedDate = firstSeenDate && lastSeenDate && lastSeenDate > firstSeenDate
    ? new Date(lastSeenDate)
    : null
  if (publishedDate && firstSeenDate && publishedDate > firstSeenDate) {
    semanticIssues.push('published-after-first-seen')
  }
  if (firstSeenDate && lastSeenDate && lastSeenDate < firstSeenDate) {
    semanticIssues.push('last-seen-before-first-seen')
  }
  if (firstSeenDate && createdDate && createdDate < firstSeenDate) {
    semanticIssues.push('created-before-first-seen')
  }

  record.eventTime = publishedDate
  if (authorName) record.authorName = authorName
  if (editedDate) record.editedAt = editedDate
  record.stableFields = {
    ...(record.stableFields || {}),
    author: {
      ...(normalizedObject(record.stableFields?.author) || {}),
      ...(authorName ? { name: authorName } : {}),
    },
    ...(editedDate ? { editedAt: editedDate } : {}),
    crawler: {
      contractVersion: CRAWLER_RECORD_CONTRACT_VERSION,
      identity: {
        rowId: optionalValue(raw?.id),
        sourceId: optionalValue(raw?.source_id),
        recordKey,
        canonicalExternalId: optionalValue(record.externalId),
      },
      lineage: {
        runId: optionalValue(raw?.run_id),
        sourceType,
        recordType,
        collectionMode: optionalValue(raw?.collection_mode),
        qualityStatus: optionalValue(raw?.quality_status),
        collector: { connectorId, sourceFamily },
        publisher: { code: providerCode, name: providerName, section: sourceSection },
        author: { name: authorName, organization: authorOrganization },
        firstSeenAt,
        lastSeenAt,
        createdAt,
      },
      publication: publication(recordType, record),
      publishedAt,
      semanticIssues: [...new Set(semanticIssues)],
    },
    sourceCatalog: {
      ...(record.stableFields?.sourceCatalog || {}),
      collector: classify(
        [connectorId, sourceFamily],
        { preferredSourceKey: collectorPreferredSourceKey(connectorId || sourceFamily) },
      ),
      publisher: classify([providerCode, providerName]),
    },
    tags,
  }
  return record
}
