import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'
import { DATASET_ID } from '../ingest/normalizers.mjs'

// Fields the projection must never carry into a customer-facing index. The
// canonical row keeps provider lineage under `extensions` as ingest evidence
// (see adapters/night-all.mjs `keepRaw`); the search projection is customer
// facing, so that evidence is stripped again here rather than relying on it
// having been stripped upstream.
const LINEAGE_KEY = /(provider|credential|upstream|endpoint|business.?id|availability|billing|token|secret|password|auth)/i

function safeExtensionValue(value) {
  if (Array.isArray(value)) return value.map(safeExtensionValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !LINEAGE_KEY.test(key))
      .map(([key, nested]) => [key, safeExtensionValue(nested)]),
  )
}

function safeExtensions(extensions) {
  if (!extensions || typeof extensions !== 'object') return {}
  const result = {}
  for (const [key, value] of Object.entries(extensions)) {
    if (LINEAGE_KEY.test(key)) continue
    const safeValue = safeExtensionValue(value)
    // `flattened` indexes leaf values as keywords; deep objects still work but
    // arrays of objects lose structure. Stringify anything non-scalar rather
    // than pretending it stayed queryable.
    result[key] = safeValue && typeof safeValue === 'object' ? JSON.stringify(safeValue) : safeValue
  }
  return result
}

function metricsOf(stableFields) {
  const metrics = stableFields?.metrics
  if (!metrics || typeof metrics !== 'object') return {}
  const result = {}
  for (const key of ['likes', 'comments', 'shares', 'views', 'bookmarks']) {
    if (typeof metrics[key] === 'number' && Number.isFinite(metrics[key])) result[key] = metrics[key]
  }
  return result
}

function mediaOf(stableFields) {
  const media = stableFields?.media
  const images = Array.isArray(media?.images) ? media.images : []
  const videos = Array.isArray(media?.videos) ? media.videos : []
  return { mediaCount: images.length + videos.length, hasVideo: videos.length > 0 }
}

// Elasticsearch expects [lon, lat]; the canonical row stores them as separate
// columns. Emitting the array only when both are present avoids indexing a
// half-known point at the equator.
function locationOf(row) {
  if (typeof row.latitude !== 'number' || typeof row.longitude !== 'number') return null
  return [row.longitude, row.latitude]
}

/**
 * Build the Elasticsearch document for one canonical record.
 *
 * Segmentation is awaited per document rather than batched because the HanLP
 * client already fails soft: a segmenter outage yields fallback tokens instead
 * of an exception, so there is no partial-batch state to unwind.
 */
export async function buildContentDocument(row, { segmenter }) {
  const stableFields = row.stable_fields || {}
  const [titleTokens, bodyTokens] = await Promise.all([
    segmenter.segment(row.title || ''),
    segmenter.segment(row.body || ''),
  ])
  const media = mediaOf(stableFields)
  const location = locationOf(row)

  return {
    id: row.id,
    datasetId: row.dataset_id || DATASET_ID,
    dataVersion: String(row.current_revision ?? 1),
    schemaVersion: row.schema_version,
    projectionRevision: Number(row.projection_revision),

    platform: row.platform,
    objectType: row.object_type,
    contentType: row.content_type,
    externalId: row.external_id,
    url: row.url,

    title: row.title,
    body: row.body,
    titleHanlp: toPresegmentedText(titleTokens),
    bodyHanlp: toPresegmentedText(bodyTokens),

    authorExternalId: row.author_external_id,
    authorName: row.author_name,
    authorHandle: stableFields.author?.handle ?? null,
    authorAvatarUrl: stableFields.author?.avatarUrl ?? null,

    // Union of both segmented fields: a cheap keyword facet for "what is this
    // corpus about" aggregations without re-analyzing text at query time.
    tokens: [...new Set([...titleTokens, ...bodyTokens])].slice(0, 512),
    tags: Array.isArray(stableFields.tags) ? stableFields.tags : [],
    entityIds: [],
    language: stableFields.language ?? null,

    metrics: metricsOf(stableFields),
    ...media,

    ...(location ? { location } : {}),
    countryCode: row.country_code,
    admin1Code: row.admin1_code,
    admin2Code: row.admin2_code,

    eventTime: row.event_time,
    publishedAt: row.event_time,
    collectedAt: row.collected_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,

    source: {
      connectorId: stableFields.connectorId ?? 'night-all',
      streamId: `${row.platform}.search_posts.v1`,
      sourceKey: row.external_id,
      payloadSha256: row.payload_sha256,
    },
    extensions: safeExtensions(row.extensions),
  }
}
