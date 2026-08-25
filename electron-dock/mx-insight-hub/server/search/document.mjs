import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'
import { DATASET_ID } from '../ingest/normalizers.mjs'

// Fields the projection must never carry into a customer-facing index. The
// canonical row keeps provider lineage under `extensions` as ingest evidence
// (see adapters/night-all.mjs `keepRaw`); the search projection is customer
// facing, so that evidence is stripped again here rather than relying on it
// having been stripped upstream.
const LINEAGE_KEY = /(provider|credential|upstream|endpoint|business.?id|availability|billing|token|secret|password|auth)/i
const COLLECTOR_OPERATION_KEYS = new Set([
  'account_alias', 'account_phone', 'first_seen_account_id',
  'source_disposition', 'source_stage', 'sourcedisposition', 'sourcestage',
])

function customerSafeExtensionKey(key) {
  return !LINEAGE_KEY.test(key) && !COLLECTOR_OPERATION_KEYS.has(String(key).toLowerCase())
}

function safeExtensionValue(value) {
  if (Array.isArray(value)) return value.map(safeExtensionValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => customerSafeExtensionKey(key))
      .map(([key, nested]) => [key, safeExtensionValue(nested)]),
  )
}

function safeExtensions(extensions) {
  if (!extensions || typeof extensions !== 'object') return {}
  const result = {}
  for (const [key, value] of Object.entries(extensions)) {
    if (!customerSafeExtensionKey(key)) continue
    const safeValue = safeExtensionValue(value)
    // `flattened` indexes leaf values as keywords; deep objects still work but
    // arrays of objects lose structure. Stringify anything non-scalar rather
    // than pretending it stayed queryable.
    result[key] = safeValue && typeof safeValue === 'object' ? JSON.stringify(safeValue) : safeValue
  }
  return result
}

function publicationOf(row) {
  const stage = asText(row.publication_source_stage)
  if (!stage) return null
  const locationLabel = asText(row.publication_location_label)
  const locationType = asText(row.publication_location_type)
  const countryName = asText(row.publication_country_name)
  const countryCode = asText(row.publication_country_code)
  return {
    stage,
    status: asText(row.publication_status),
    qualityScore: finiteNonNegative(row.publication_quality_score),
    displayAdmin1: asText(row.publication_display_admin1_code),
    geographyVerified: row.publication_geography_verified === true,
    // Candidate sources may not have a defensible event timestamp. Their
    // bounded search window uses collection time as a fallback; formal records
    // retain the historical event-time semantics.
    effectiveTime: stage === 'candidate'
      ? (row.event_time ?? row.collected_at ?? null)
      : (row.event_time ?? null),
    ...(locationLabel ? { locationLabel } : {}),
    ...(locationType ? { locationType } : {}),
    ...(countryName ? { countryName } : {}),
    ...(countryCode ? { countryCode } : {}),
  }
}

function metricsOf(stableFields) {
  const metrics = stableFields?.metrics
  if (!metrics || typeof metrics !== 'object') return {}
  const result = {}
  for (const key of ['likes', 'comments', 'shares', 'views', 'bookmarks', 'members']) {
    if (typeof metrics[key] === 'number' && Number.isFinite(metrics[key])) result[key] = metrics[key]
  }
  return result
}

function asText(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function telegramMediaKind(mediaType) {
  const suffix = asText(mediaType)?.match(/^MessageMedia(.+)$/u)?.[1]
  if (!suffix) return null
  const kind = suffix
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
  if (kind === 'empty') return null
  if (kind === 'photo') return 'image'
  if (['geo', 'geo_live', 'venue'].includes(kind)) return 'location'
  return kind
}

function mediaOf(stableFields) {
  const media = stableFields?.media
  const mediaType = asText(stableFields?.attributes?.mediaType)
  const inferredKind = telegramMediaKind(mediaType)
  const images = Array.isArray(media?.images) ? media.images : []
  const videos = Array.isArray(media?.videos) ? media.videos : []
  if (images.length > 0 || videos.length > 0) {
    return {
      mediaType,
      mediaCount: images.length + videos.length,
      hasVideo: videos.length > 0,
      mediaKind: videos.length > 0 ? 'video' : 'image',
      mediaMimeType: null,
      mediaExtension: null,
      mediaFileName: null,
      mediaSizeBytes: null,
    }
  }
  const kind = asText(media?.media_kind ?? media?.mediaKind)?.toLowerCase() ?? inferredKind
  return {
    mediaType,
    mediaCount: kind ? 1 : 0,
    hasVideo: kind === 'video',
    mediaKind: kind,
    mediaMimeType: asText(media?.mime_type ?? media?.mimeType),
    mediaExtension: asText(media?.extension)?.toLowerCase() ?? null,
    mediaFileName: asText(media?.file_name ?? media?.fileName),
    mediaSizeBytes: finiteNonNegative(media?.size_bytes ?? media?.sizeBytes),
  }
}

function entitiesOf(stableFields) {
  const entities = Array.isArray(stableFields?.entities) ? stableFields.entities : []
  const unique = (values) => [...new Set(values.filter(Boolean))].slice(0, 100)
  return {
    entityTypes: unique(entities.map((entity) => asText(entity?.type)?.toLowerCase() ?? null)),
    entityUserIds: unique(entities.map((entity) => asText(entity?.user_id ?? entity?.userId))),
    entityUrls: unique(entities.map((entity) => asText(entity?.url))),
  }
}

// Elasticsearch expects [lon, lat]; the canonical row stores them as separate
// columns. Emitting the array only when both are present avoids indexing a
// half-known point at the equator.
function locationOf(row) {
  if (typeof row.latitude !== 'number' || typeof row.longitude !== 'number') return null
  return [row.longitude, row.latitude]
}

async function segmentFields(segmenter, values) {
  const tokens = []
  let fallbackSegmenter = null
  for (const value of values) {
    if (fallbackSegmenter) {
      tokens.push(await fallbackSegmenter.segment(value))
      continue
    }
    if (typeof segmenter.segmentWithMeta === 'function') {
      const result = await segmenter.segmentWithMeta(value)
      tokens.push(result.tokens)
      if (result.degraded && typeof segmenter.fallbackSegmenter?.segment === 'function') {
        fallbackSegmenter = segmenter.fallbackSegmenter
      }
      continue
    }
    tokens.push(await segmenter.segment(value))
  }
  return tokens
}

/**
 * Build the Elasticsearch document for one canonical record.
 *
 * Segmentation is awaited one field at a time. The local HanLP deployment has
 * one inference slot, so parallelising fields only fills its short queue and
 * turns otherwise valid work into 429 fallbacks; serial calls preserve the
 * same throughput while keeping HanLP, rather than Jieba, as the normal path.
 * Once a field degrades, the remaining fields use that segmenter's local
 * fallback directly instead of paying another remote timeout per field.
 */
export async function buildContentDocument(row, { segmenter }) {
  const stableFields = row.stable_fields || {}
  const authorName = row.author_name ?? stableFields.author?.name ?? null
  const username = stableFields.attributes?.username ?? stableFields.author?.handle ?? null
  const chatUsername = stableFields.attributes?.chatUsername ?? null
  const [titleTokens, bodyTokens, authorNameTokens, usernameTokens, chatUsernameTokens] = await segmentFields(
    segmenter,
    [row.title || '', row.body || '', authorName || '', username || '', chatUsername || ''],
  )
  const media = mediaOf(stableFields)
  const entities = entitiesOf(stableFields)
  const location = locationOf(row)
  const publication = publicationOf(row)

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
    authorName,
    authorNameHanlp: toPresegmentedText(authorNameTokens),
    authorHandle: stableFields.author?.handle ?? null,
    authorHandleSubstring: stableFields.author?.handle ?? null,
    authorAvatarUrl: stableFields.author?.avatarUrl ?? null,
    username,
    usernameHanlp: toPresegmentedText(usernameTokens),
    usernameSubstring: username,
    chatUsername,
    chatUsernameHanlp: toPresegmentedText(chatUsernameTokens),
    chatUsernameSubstring: chatUsername,
    chatId: asText(stableFields.relations?.chatId),
    messageId: asText(stableFields.relations?.messageId),
    replyToMessageId: asText(stableFields.relations?.replyToMessageId),
    threadId: asText(stableFields.relations?.threadId),
    groupedId: asText(stableFields.relations?.groupedId),
    chatType: asText(stableFields.attributes?.chatType),
    isOutgoing: typeof stableFields.attributes?.isOutgoing === 'boolean'
      ? stableFields.attributes.isOutgoing
      : null,

    // Union of both segmented fields: a cheap keyword facet for "what is this
    // corpus about" aggregations without re-analyzing text at query time.
    tokens: [...new Set([...titleTokens, ...bodyTokens])].slice(0, 512),
    tags: Array.isArray(stableFields.tags) ? stableFields.tags : [],
    entityIds: entities.entityUserIds,
    ...entities,
    language: stableFields.language ?? null,

    metrics: metricsOf(stableFields),
    ...media,

    ...(location ? { location } : {}),
    countryCode: row.country_code,
    admin1Code: row.admin1_code,
    admin2Code: row.admin2_code,
    ...(publication ? { publication } : {}),

    eventTime: row.event_time,
    editedAt: stableFields.editedAt ?? null,
    publishedAt: row.event_time,
    collectedAt: row.collected_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,

    source: {
      connectorId: stableFields.source?.sourceKey
        ? `external:${stableFields.source.sourceKey}`
        : stableFields.connectorId ?? 'night-all',
      streamId: ['database', 'sqlite_api'].includes(stableFields.source?.origin)
        ? `${row.platform}.external.v1`
        : `${row.platform}.search_posts.v1`,
      sourceKey: row.external_id,
      payloadSha256: row.payload_sha256,
    },
    extensions: safeExtensions(row.extensions),
  }
}
