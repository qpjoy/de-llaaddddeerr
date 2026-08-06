import { createHash } from 'node:crypto'

// Bump when the mapping below changes so revisions record which parser produced
// them and historical rows can be recomputed selectively.
export const PARSER_VERSION = 'mxih-normalizer.v1'
export const SCHEMA_VERSION = 'content.v1'
export const DATASET_ID = 'night-all.search.v1'
export const CONNECTOR_ID = 'night-all'

export function streamId(platform, capability = 'search_posts') {
  return `${platform}.${capability}.v1`
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

// Stable stringify: sorted keys, so an identical payload always hashes the same.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function metrics(item) {
  const source = item?.metrics && typeof item.metrics === 'object' ? item.metrics : {}
  const result = {}
  for (const key of ['likes', 'comments', 'shares', 'views', 'bookmarks', 'collects', 'reposts']) {
    const value = number(source[key])
    if (value !== null) result[key] = value
  }
  return result
}

// Geo is best-effort: upstream shapes differ per platform and many posts carry
// none. Stored as redundant lat/lng per §3.5 until PostGIS is available.
function geo(item) {
  const candidate = item?.location && typeof item.location === 'object' ? item.location : item?.geo
  if (!candidate || typeof candidate !== 'object') return {}
  const latitude = number(candidate.latitude ?? candidate.lat)
  const longitude = number(candidate.longitude ?? candidate.lng ?? candidate.lon)
  return {
    latitude,
    longitude,
    countryCode: text(candidate.countryCode ?? candidate.country),
    admin1Code: text(candidate.admin1Code ?? candidate.province ?? candidate.state),
    admin2Code: text(candidate.admin2Code ?? candidate.city),
  }
}

// Fields the canonical columns already cover; anything else upstream sends is
// preserved under `extensions` so provider drift never silently drops data.
const MAPPED_KEYS = new Set([
  'id', 'externalId', 'platform', 'contentType', 'url', 'title', 'text',
  'publishedAt', 'collectedAt', 'author', 'metrics', 'media', 'location', 'geo',
])

function extensions(item) {
  const result = {}
  for (const [key, value] of Object.entries(item)) {
    if (!MAPPED_KEYS.has(key)) result[key] = value
  }
  return result
}

// Shared mapping for the Night-All data-search stable envelope. Platform hooks
// below only override what genuinely differs, so a new platform is a small diff
// rather than a parallel parser.
function baseNormalizer(item, platform) {
  const externalId = text(item?.externalId) || text(item?.id)
  if (!externalId) return null

  const author = item?.author && typeof item.author === 'object' ? item.author : {}
  const location = geo(item)

  return {
    platform,
    objectType: 'post',
    externalId,
    contentType: text(item?.contentType),
    url: text(item?.url),
    title: text(item?.title),
    body: text(item?.text),
    authorExternalId: text(author.id),
    authorName: text(author.name),
    eventTime: timestamp(item?.publishedAt),
    collectedAt: timestamp(item?.collectedAt),
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    countryCode: location.countryCode ?? null,
    admin1Code: location.admin1Code ?? null,
    admin2Code: location.admin2Code ?? null,
    stableFields: {
      author: {
        externalId: text(author.id),
        name: text(author.name),
        avatarUrl: text(author.avatarUrl),
      },
      media: item?.media && typeof item.media === 'object' ? item.media : {},
      metrics: metrics(item),
    },
    extensions: extensions(item || {}),
    metrics: metrics(item),
  }
}

// Per-platform hooks. Each receives the shared result and may adjust it.
// Keep these narrow: anything general belongs in baseNormalizer.
const PLATFORM_HOOKS = {
  xiaohongshu(record, item) {
    // XHS notes are image-first; treat a missing contentType as a note and
    // fall back to the cover image when no explicit media type is present.
    if (!record.contentType) record.contentType = 'note'
    const title = record.title || text(item?.noteTitle)
    if (title) record.title = title
    return record
  },
  twitter(record, item) {
    // Tweets have no title; surface a trimmed body prefix so list views and the
    // ES `title` field are not empty.
    if (!record.title && record.body) {
      record.title = record.body.length > 80 ? `${record.body.slice(0, 80)}…` : record.body
    }
    if (!record.contentType) record.contentType = 'tweet'
    const handle = text(item?.author?.handle) || text(item?.author?.username)
    if (handle) record.stableFields.author.handle = handle
    return record
  },
  douyin(record, item) {
    if (!record.contentType) record.contentType = 'video'
    const duration = number(item?.duration ?? item?.media?.duration)
    if (duration !== null) record.stableFields.durationSeconds = duration
    return record
  },
}

export const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_HOOKS)

export function normalizeItem(item, platform) {
  if (!item || typeof item !== 'object') return null
  const record = baseNormalizer(item, platform)
  if (!record) return null
  const hook = PLATFORM_HOOKS[platform]
  return hook ? hook(record, item) : record
}

// Fields that describe *this sighting* rather than the object itself. They must
// stay out of the content hash: `collectedAt` changes on every crawl and
// `metrics` drift constantly, so including them would create a new revision for
// an unchanged post and flood the outbox. Their history lives in `observations`.
const NON_CONTENT_KEYS = new Set(['collectedAt', 'metrics'])

function contentPayload(item) {
  const result = {}
  for (const [key, value] of Object.entries(item)) {
    if (!NON_CONTENT_KEYS.has(key)) result[key] = value
  }
  return result
}

// Items whose external ID is missing cannot be deduplicated, so they are
// reported rather than written with a synthetic key.
export function normalizeSearchPayload(payload, platform) {
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
  const records = []
  let skipped = 0
  for (const [index, item] of items.entries()) {
    const record = normalizeItem(item, platform)
    if (!record) {
      skipped += 1
      continue
    }
    record.rank = index + 1
    record.rawItem = item
    record.payloadSha256 = sha256(canonicalJson(contentPayload(item)))
    records.push(record)
  }
  return { records, skipped }
}

// Observation identity: same batch replayed => same hash => idempotent insert.
// A later crawl has a different collectedAt/metrics, so it is a new sighting.
export function observationHash(record, queryFingerprint) {
  return sha256(
    canonicalJson({
      externalId: record.externalId,
      platform: record.platform,
      queryFingerprint: queryFingerprint || null,
      rank: record.rank ?? null,
      metrics: record.metrics || {},
      collectedAt: record.collectedAt ? record.collectedAt.toISOString() : null,
    }),
  )
}
