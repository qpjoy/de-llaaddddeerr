import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'
import { canonicalJson, sha256 } from './normalizers.mjs'
import { applyMapping, refreshMappedPayloadSha256 } from './external/mapping.mjs'

export const TIEBA_DATASET_ID = 'tieba.posts.v1'
export const TIEBA_PLATFORM = 'tieba'
export const TIEBA_CONNECTOR_ID = 'collect:tieba-post-search'
export const TIEBA_INGESTION_KIND = 'tieba-post-search-result'
export const TIEBA_PARSER_VERSION = 'mx-insight-hub.tieba-post.v1'
const PARTIAL_REASONS = new Set(['page_limit', 'repeated_page', 'pagination_metadata_missing',
  'empty_page_after_has_more', 'auth_required', 'auth_expired', 'verification_required',
  'rate_limited', 'upstream_error', 'upstream_unavailable', 'schema_drift', 'timeout', 'credential_missing'])

const FIELD_MAP = {
  externalId: { from: 'id' }, contentType: { from: 'contentType' },
  url: { from: 'url' }, title: { from: 'title' }, body: { from: 'body' },
  authorExternalId: { from: 'author.id' }, authorName: { from: 'author.name' },
  eventTime: { from: 'publishedAt', type: 'timestamp' },
  collectedAt: { from: 'collectedAt', type: 'timestamp' },
  'metrics.likes': { from: 'metrics.likes' }, 'metrics.comments': { from: 'metrics.comments' },
  'metrics.shares': { from: 'metrics.shares' }, 'relations.threadId': { from: 'id' },
  media: { from: 'media' }, _drop: { from: ['author', 'metrics', 'forum'] },
}

const invalid = () => { throw new AppError(502, 'invalid_tieba_result', 'The Tieba result does not match the reviewed thread-search contract') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const positiveId = value => typeof value === 'string' && /^[1-9][0-9]{0,127}$/u.test(value) ? value : null
const label = (value, max = 256) => typeof value === 'string' && value.trim().length <= max
  && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() || null : null

function metric(value) {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) value = Number(value)
  return count(value) ? value : null
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function context({ input, taskId, runId, capturedAt } = {}) {
  if (!object(input) || typeof input.query !== 'string' || !input.query.trim() || [...input.query].length > 200
    || !Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 100
    || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000
    || !Number.isSafeInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 10
    || !Number.isSafeInteger(taskId) || taskId < 1 || !Number.isSafeInteger(runId) || runId < 1) invalid()
  const observed = capturedAt instanceof Date && Number.isFinite(capturedAt.getTime())
    ? capturedAt.toISOString() : timestamp(capturedAt)
  if (!observed) invalid()
  return { input: { query: input.query, maxResults: input.maxResults, page: input.page, maxPages: input.maxPages },
    taskId, runId, capturedAt: observed }
}

function threadUrl(value, id) {
  if (typeof value !== 'string') invalid()
  let url
  try { url = new URL(value) } catch { invalid() }
  if (url.protocol !== 'https:' || url.hostname !== 'tieba.baidu.com' || url.username || url.password || url.port
    || url.pathname !== `/p/${id}` || url.search || url.hash) invalid()
  return url.href
}

function mediaImages(value) {
  if (!Array.isArray(value)) return []
  const images = []
  for (const item of value.slice(0, 50)) {
    if (!object(item) || item.type !== 'image' || typeof item.url !== 'string' || item.url.length > 2048) continue
    let url
    try { url = new URL(item.url) } catch { continue }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.hash
      || !['baidu.com', 'bdimg.com', 'bdstatic.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) continue
    if (!images.includes(url.href)) images.push(url.href)
  }
  return images
}

function projectThread(raw, input) {
  if (!object(raw) || raw.record_type !== 'tieba.thread' || raw.quality_status === 'rejected') invalid()
  const id = positiveId(raw.source_id)
  if (!id || typeof raw.title !== 'string' || typeof raw.text !== 'string'
    || (!raw.title.trim() && !raw.text.trim())) invalid()
  const attrs = object(raw.attributes) ? raw.attributes : {}
  if (attrs.query !== input.query || !Number.isSafeInteger(attrs.page) || attrs.page < input.page
    || attrs.page > Math.min(1000, input.page + input.maxPages - 1)
    || (attrs.thread_id != null && attrs.thread_id !== id)) invalid()
  const author = object(raw.author) ? raw.author : {}
  const metrics = object(raw.metrics) ? raw.metrics : {}
  return {
    id, contentType: 'tieba.thread', url: threadUrl(raw.source_url, id),
    title: raw.title, body: raw.text,
    author: { id: positiveId(author.id), name: label(author.name) },
    forum: { id: positiveId(attrs.forum_id), name: label(attrs.forum ?? attrs.forum_name) },
    metrics: { likes: metric(metrics.likes), comments: metric(metrics.replies), shares: metric(metrics.shares) },
    media: { images: mediaImages(raw.media) }, publishedAt: timestamp(raw.published_at),
  }
}

function projectItems(items, input) {
  if (!Array.isArray(items) || items.length > input.maxResults || items.length > 100) invalid()
  const projected = items.map(raw => projectThread(raw, input))
  if (new Set(projected.map(item => item.id)).size !== projected.length) invalid()
  return projected
}

/** Only successful, request-bound thread envelopes enter this dedicated product.
 * The caller separately verifies the terminal run and source persistence counters.
 * Historical saved_records_forum identities and publication rules are untouched.
 */
export function projectTiebaSearchResult(nativeResult, options) {
  const meta = context(options)
  if (!isPostgresSafeJsonValue(nativeResult) || !object(nativeResult)) invalid()
  const items = projectItems(nativeResult.items, meta.input)
  const metrics = nativeResult.metrics
  const collection = metrics?.collection
  if (!object(metrics) || metrics.count !== items.length || !object(collection)
    || collection.requested !== meta.input.maxResults || collection.returned !== items.length
    || typeof collection.complete !== 'boolean' || typeof collection.stop_reason !== 'string'
    || !/^[a-z][a-z0-9_]{0,79}$/u.test(collection.stop_reason)) invalid()
  if (collection.complete && !['requested_limit', 'end_of_results'].includes(collection.stop_reason)) invalid()
  if (collection.stop_reason === 'requested_limit' && (!collection.complete || items.length !== meta.input.maxResults)) invalid()
  if (collection.stop_reason === 'end_of_results' && !collection.complete) invalid()
  const dataStatus = !collection.complete ? 'partial' : items.length ? 'success' : 'no_data'
  const result = {
    platform: TIEBA_PLATFORM, items,
    completeness: { scope: 'request', complete: collection.complete,
      requested: meta.input.maxResults, returned: items.length,
      stopReason: collection.complete || PARTIAL_REASONS.has(collection.stop_reason) ? collection.stop_reason : 'upstream_partial' },
  }
  return { result, itemCount: items.length, dataStatus,
    ingestion: { kind: TIEBA_INGESTION_KIND, version: 1, items: structuredClone(nativeResult.items), ...meta } }
}

/** Revalidate the restricted queue payload, then produce ordinary canonical
 * records. Raw source values remain in rawItem, never canonical extensions.
 */
export function normalizeTiebaIngestion(payload) {
  if (!isPostgresSafeJsonValue(payload) || payload?.kind !== TIEBA_INGESTION_KIND || payload.version !== 1) invalid()
  const meta = context(payload)
  const items = projectItems(payload.items, meta.input)
  return items.map((item, index) => {
    const { record } = applyMapping({ ...item, collectedAt: meta.capturedAt }, FIELD_MAP,
      { platform: TIEBA_PLATFORM, objectType: 'post' })
    if (!record) invalid()
    record.extensions = {}
    record.parserVersion = TIEBA_PARSER_VERSION
    record.stableFields.forum = item.forum
    record.stableFields.tieba = { contractVersion: TIEBA_PARSER_VERSION, threadId: item.id, contentExtent: 'search_result' }
    record.rawItem = { item: payload.items[index], source: { connectorId: 'tieba', capability: 'content.search',
      taskId: meta.taskId, runId: meta.runId }, input: meta.input, capturedAt: meta.capturedAt }
    record.rawPayloadSha256 = sha256(canonicalJson(record.rawItem))
    delete record.payloadSha256
    refreshMappedPayloadSha256(record)
    // Rank belongs to this observation, not to the thread's content revision.
    record.rank = index + 1
    return record
  })
}
