import { AppError } from '../core/errors.mjs'
import { publicStoredSearchItem } from './stored-search.mjs'

const CONTEXT_QUERY_FIELDS = new Set(['after', 'before'])
const EVENT_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/
export const DEFAULT_CANONICAL_CONTEXT_WINDOW = 10
export const MAX_CANONICAL_CONTEXT_WINDOW = 50

export const CANONICAL_CONTEXT_DATASETS = Object.freeze({
  'telegram.monitor.messages.v1': Object.freeze({
    objectType: 'message',
    streamType: 'chat',
    servingIndexName: 'canonical_monitor_tg_messages_chat_time_idx',
    upstreamCompleteness: Object.freeze({ status: 'unknown', basis: null, through: null }),
  }),
  'telegram.sqlite.messages.v1': Object.freeze({
    objectType: 'message',
    streamType: 'chat',
    servingIndexName: 'canonical_sqlite_tg_messages_chat_time_idx',
    upstreamCompleteness: Object.freeze({
      status: 'bounded',
      basis: 'append_only_overlap',
      through: null,
    }),
  }),
})

export const CANONICAL_CONTEXT_DATASET_IDS = Object.freeze(Object.keys(CANONICAL_CONTEXT_DATASETS))

function windowValue(value, field) {
  if (value == null || value === '') return DEFAULT_CANONICAL_CONTEXT_WINDOW
  const normalized = typeof value === 'number' ? String(value) : value
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) {
    throw new AppError(400, 'invalid_request', `${field} must be an integer between 0 and ${MAX_CANONICAL_CONTEXT_WINDOW}`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_CANONICAL_CONTEXT_WINDOW) {
    throw new AppError(400, 'invalid_request', `${field} must be an integer between 0 and ${MAX_CANONICAL_CONTEXT_WINDOW}`)
  }
  return parsed
}

export function canonicalContextCapability(servingIndexes) {
  return {
    contractVersion: 'mx-insight-hub.canonical-context.v1',
    ready: servingIndexes?.ready === true,
    defaultBefore: DEFAULT_CANONICAL_CONTEXT_WINDOW,
    defaultAfter: DEFAULT_CANONICAL_CONTEXT_WINDOW,
    maxBefore: MAX_CANONICAL_CONTEXT_WINDOW,
    maxAfter: MAX_CANONICAL_CONTEXT_WINDOW,
    datasets: Object.entries(CANONICAL_CONTEXT_DATASETS).map(([datasetId, dataset]) => ({
      datasetId,
      objectType: dataset.objectType,
      streamType: dataset.streamType,
      ordering: ['eventTime', 'canonicalId'],
      upstreamCompleteness: { ...dataset.upstreamCompleteness },
    })),
  }
}

export function normalizeCanonicalContextQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'Context query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((key) => !CONTEXT_QUERY_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported context fields: ${unsupported.join(', ')}`)
  }
  return {
    before: windowValue(input.before, 'before'),
    after: windowValue(input.after, 'after'),
  }
}

export function canonicalEventTimeCursor(value) {
  if (value == null) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : `${value.toISOString().slice(0, -1)}000Z`
  }
  if (typeof value !== 'string') return null
  const match = EVENT_TIME_PATTERN.exec(value)
  if (!match) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return `${parsed.toISOString().slice(0, 19)}.${(match[1] || '').padEnd(6, '0')}Z`
}

export function publicCanonicalContextItem(row) {
  const item = publicStoredSearchItem({
    id: row.id,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    contentType: row.content_type,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    body: row.body,
    authorExternalId: row.author_external_id,
    authorName: row.author_name,
    authorHandle: row.stable_fields?.attributes?.username,
    metrics: row.stable_fields?.metrics,
    eventTime: row.event_time,
    collectedAt: row.collected_at,
    score: null,
  })
  const exactEventTime = canonicalEventTimeCursor(row.event_time_cursor)
  return exactEventTime ? { ...item, eventTime: exactEventTime } : item
}

export function canonicalContextUpstreamWarning(upstreamCompleteness) {
  if (upstreamCompleteness.status === 'bounded') {
    return {
      code: 'upstream_completeness_bounded',
      message: 'The source uses bounded overlap/reconciliation and may not represent every upstream historical change.',
    }
  }
  if (upstreamCompleteness.status === 'unknown') {
    return {
      code: 'upstream_completeness_unknown',
      message: 'No public upstream-capture completeness attestation is available for this dataset.',
    }
  }
  return null
}

export function canonicalContextResponse({ query, result }) {
  const current = result.current
  const dataset = CANONICAL_CONTEXT_DATASETS[current.dataset_id]
  const before = result.before.map(publicCanonicalContextItem)
  const currentItem = publicCanonicalContextItem(current)
  const after = result.after.map(publicCanonicalContextItem)
  const upstreamCompleteness = { ...dataset.upstreamCompleteness }
  return {
    contractVersion: 'mx-insight-hub.canonical-context.v1',
    source: 'hub',
    anchorId: current.id,
    anchorIndex: before.length,
    stream: {
      platform: current.platform,
      datasetId: current.dataset_id,
      objectType: current.object_type,
      type: dataset.streamType,
      id: current.context_id,
    },
    items: [...before, currentItem, ...after],
    storedWindow: {
      beforeRequested: query.before,
      afterRequested: query.after,
      beforeReturned: before.length,
      afterReturned: after.length,
      returnedCount: before.length + 1 + after.length,
      hasMoreStoredBefore: result.hasMoreStoredBefore,
      hasMoreStoredAfter: result.hasMoreStoredAfter,
    },
    ordering: {
      fields: ['eventTime', 'canonicalId'],
      direction: 'ascending',
      quality: 'deterministic',
    },
    upstreamCompleteness,
    warnings: [canonicalContextUpstreamWarning(upstreamCompleteness)].filter(Boolean),
  }
}
