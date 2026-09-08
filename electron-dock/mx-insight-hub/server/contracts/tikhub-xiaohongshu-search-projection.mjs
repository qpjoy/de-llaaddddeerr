import { isNightAllDataSearchV1Envelope } from './night-all-data-search.mjs'
import { isNightAllLegacyEnvelope } from './night-all-legacy.mjs'
import {
  needsXiaohongshuDetail,
  xiaohongshuBodyLengths,
} from './tikhub-xiaohongshu-search.mjs'

const PLATFORM = 'xiaohongshu'
const MAX_BODY_CODE_POINTS = 50_000
const NOTE_ID_PATTERN = /^[0-9a-f]{24}$/iu
const DETAIL_REQUIRED_WARNING = 'xiaohongshu_detail_required'
const SAFETY_LIMIT_WARNING = 'text_safety_limit_applied'

export class TikHubXiaohongshuSearchProjectionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TikHubXiaohongshuSearchProjectionError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new TikHubXiaohongshuSearchProjectionError(code, message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`invalid_${name}`, `${name} must be a non-negative safe integer`)
  }
  return value
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function publicBodyOf(value) {
  const body = value?.publicBody ?? value?.payload ?? value
  if (!isNightAllDataSearchV1Envelope(body) || body.data.platform !== PLATFORM) {
    invalid('invalid_search_result', 'a valid Xiaohongshu night-all.data-search.v1 result is required')
  }
  return body
}

function stableHttpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2_048) return null
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.port && url.port !== '443')
      || !hostname
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.svc')
    ) return null
    url.hostname = hostname
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function uniqueUrls(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(stableHttpsUrl)
    .filter(Boolean))]
}

function boundedBody(value) {
  if (typeof value !== 'string') {
    return { text: null, safetyLimited: false }
  }
  const points = []
  let safetyLimited = false
  for (const point of value) {
    if (points.length === MAX_BODY_CODE_POINTS) {
      safetyLimited = true
      break
    }
    const codePoint = point.codePointAt(0)
    points.push(codePoint >= 0xD800 && codePoint <= 0xDFFF ? '\uFFFD' : point)
  }
  return {
    text: points.join(''),
    safetyLimited,
  }
}

function detailItemOf(result) {
  const item = result?.publicBody?.data?.item
    ?? result?.payload?.data?.item
    ?? result?.data?.item
    ?? result?.item
    ?? result
  if (
    !isRecord(item)
    || item.platform !== PLATFORM
    || typeof item.externalId !== 'string'
    || !NOTE_ID_PATTERN.test(item.externalId)
  ) {
    invalid('invalid_detail_result', 'each successful detail result must contain a normalized Xiaohongshu item')
  }
  return {
    item,
    safetyLimited: typeof result?.safetyLimited === 'boolean' ? result.safetyLimited : null,
  }
}

function canonicalSearchItem(item) {
  const bounded = boundedBody(item.text)
  const images = uniqueUrls(item.media?.images)
  const videos = uniqueUrls(item.media?.videos)
  const coverUrl = stableHttpsUrl(item.media?.coverUrl) || images[0] || null
  return {
    id: item.id,
    externalId: item.externalId,
    platform: item.platform,
    contentType: item.contentType,
    url: stableHttpsUrl(item.url),
    title: item.title,
    text: bounded.text,
    publishedAt: item.publishedAt,
    collectedAt: item.collectedAt,
    author: {
      id: item.author.id,
      name: item.author.name,
      avatarUrl: stableHttpsUrl(item.author.avatarUrl),
    },
    metrics: { ...item.metrics },
    media: { coverUrl, images, videos },
    source: { provider: null, endpointId: null },
    safetyLimited: bounded.safetyLimited,
  }
}

function detailFields({ item, safetyLimited }) {
  const bounded = boundedBody(item.text)
  const images = uniqueUrls((Array.isArray(item.media) ? item.media : [])
    .filter((entry) => entry?.type === 'image')
    .map((entry) => entry.url))
  return {
    externalId: item.externalId.toLowerCase(),
    url: stableHttpsUrl(item.url),
    title: typeof item.title === 'string' ? item.title : null,
    text: bounded.text,
    publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : null,
    author: {
      id: typeof item.author?.id === 'string' ? item.author.id : null,
      name: typeof item.author?.name === 'string' ? item.author.name : null,
      avatarUrl: stableHttpsUrl(item.author?.avatarUrl),
    },
    images,
    // Fresh adapter results carry an authoritative internal signal. Snapshots
    // intentionally persist only the public schema, so an exact-limit cached
    // body is conservatively treated as having reached the safety boundary.
    safetyLimited: bounded.safetyLimited
      || safetyLimited === true
      || (safetyLimited == null
        && xiaohongshuBodyLengths(bounded.text).codePoints === MAX_BODY_CODE_POINTS),
  }
}

function missing(value) {
  return value === null || value === undefined || value === ''
}

function fill(current, candidate) {
  return missing(current) && !missing(candidate) ? candidate : current
}

function mergeLongerDetail(searchItem, detail) {
  const searchLength = xiaohongshuBodyLengths(searchItem.text).codePoints
  const detailLength = xiaohongshuBodyLengths(detail.text).codePoints
  if (!detail.text || detailLength <= searchLength) {
    return { item: searchItem, detailUsed: false, detailSafetyLimited: false }
  }

  const images = searchItem.media.images.length > 0
    ? searchItem.media.images
    : detail.images
  return {
    item: {
      ...searchItem,
      url: fill(searchItem.url, detail.url),
      title: fill(searchItem.title, detail.title),
      text: detail.text,
      publishedAt: fill(searchItem.publishedAt, detail.publishedAt),
      author: {
        id: fill(searchItem.author.id, detail.author.id),
        name: fill(searchItem.author.name, detail.author.name),
        avatarUrl: fill(searchItem.author.avatarUrl, detail.author.avatarUrl),
      },
      // Search-card counters describe the ranked result at search time. A
      // later detail response must not silently change that observation.
      metrics: { ...searchItem.metrics },
      media: {
        coverUrl: searchItem.media.coverUrl || images[0] || null,
        images,
        videos: searchItem.media.videos,
      },
    },
    detailUsed: true,
    detailSafetyLimited: detail.safetyLimited,
  }
}

function initialState(searchResult, item, index, searchSafetyLimited) {
  const supplied = Array.isArray(searchResult?.bodyStates) ? searchResult.bodyStates[index] : null
  return {
    safetyLimited: searchSafetyLimited || supplied?.safetyLimited === true
      || supplied?.completeness === 'safety_limited',
    detailRequired: supplied?.detailRequired === true || needsXiaohongshuDetail(item.text),
  }
}

function warning(code, message) {
  return { code, message }
}

/**
 * Merge normalized TikHub search cards with successful normalized detail
 * results. This function is deliberately pure: it never schedules or performs
 * a detail request.
 */
export function projectTikHubXiaohongshuSearch(searchResult, {
  detailResults = [],
  detailFailureCount = 0,
  durationMs = 0,
  providerCalls,
} = {}) {
  if (!Array.isArray(detailResults)) {
    invalid('invalid_detail_results', 'detailResults must be an array')
  }
  nonNegativeInteger(detailFailureCount, 'detail_failure_count')
  nonNegativeInteger(durationMs, 'duration_ms')

  const sourceBody = publicBodyOf(searchResult)
  const sourceData = sourceBody.data
  const baseProviderCalls = sourceData.meta.providerCalls ?? 0
  const resolvedProviderCalls = providerCalls === undefined
    ? baseProviderCalls + detailResults.length + detailFailureCount
    : providerCalls
  nonNegativeInteger(resolvedProviderCalls, 'provider_calls')

  const detailByExternalId = new Map()
  for (const result of detailResults) {
    const detail = detailFields(detailItemOf(result))
    const prior = detailByExternalId.get(detail.externalId)
    if (!prior || xiaohongshuBodyLengths(detail.text).codePoints
      > xiaohongshuBodyLengths(prior.text).codePoints) {
      detailByExternalId.set(detail.externalId, detail)
    }
  }

  let enrichedCount = 0
  let matchedDetailCount = 0
  const items = []
  const bodyCompleteness = []
  for (const [index, sourceItem] of sourceData.items.entries()) {
    const canonical = canonicalSearchItem(sourceItem)
    const state = initialState(searchResult, sourceItem, index, canonical.safetyLimited)
    const detail = typeof canonical.externalId === 'string'
      ? detailByExternalId.get(canonical.externalId.toLowerCase())
      : null
    if (detail) matchedDetailCount += 1
    const merged = detail ? mergeLongerDetail(canonical, detail) : {
      item: canonical,
      detailUsed: false,
      detailSafetyLimited: false,
    }
    if (merged.detailUsed) enrichedCount += 1

    const finalSafetyLimited = state.safetyLimited || merged.detailSafetyLimited
    const unresolvedPreview = state.detailRequired && !merged.detailUsed
    const completeness = finalSafetyLimited
      ? 'safety_limited'
      : merged.detailUsed ? 'detail_enriched'
        : unresolvedPreview ? 'provider_preview' : 'unverified_complete'
    const { safetyLimited: _safetyLimited, ...item } = merged.item
    items.push(item)
    bodyCompleteness.push({
      externalId: item.externalId,
      completeness,
      detailUsed: merged.detailUsed,
      searchLengths: xiaohongshuBodyLengths(canonical.text),
      finalLengths: xiaohongshuBodyLengths(item.text),
    })
  }

  const unresolvedCount = bodyCompleteness
    .filter((state) => state.completeness === 'provider_preview').length
  const safetyLimitedCount = bodyCompleteness
    .filter((state) => state.completeness === 'safety_limited').length
  const warnings = sourceData.warnings
    .filter((entry) => ![DETAIL_REQUIRED_WARNING, SAFETY_LIMIT_WARNING].includes(entry.code))
    .map((entry) => ({ ...entry }))
  if (unresolvedCount > 0) warnings.push(warning(
    'xiaohongshu_detail_incomplete',
    `${unresolvedCount} note bodies could not be expanded beyond the provider preview boundary`,
  ))
  if (detailFailureCount > 0) warnings.push(warning(
    'xiaohongshu_detail_unavailable',
    `${detailFailureCount} note detail candidates were not expanded within the bounded budget or available evidence`,
  ))
  if (safetyLimitedCount > 0) warnings.push(warning(
    SAFETY_LIMIT_WARNING,
    `${safetyLimitedCount} note bodies reached the 50000-code-point safety limit`,
  ))

  const status = sourceData.status === 'failed'
    ? 'failed'
    : warnings.length > 0 ? 'partial' : 'ok'
  const publicBody = {
    ...('requestId' in sourceBody ? { requestId: sourceBody.requestId } : {}),
    ...('traceId' in sourceBody ? { traceId: sourceBody.traceId } : {}),
    data: {
      contractVersion: sourceData.contractVersion,
      platform: sourceData.platform,
      query: sourceData.query,
      items,
      pageInfo: { ...sourceData.pageInfo, returnedCount: items.length },
      status,
      warnings,
      meta: {
        ...sourceData.meta,
        ...(sourceData.meta.error ? { error: { ...sourceData.meta.error } } : {}),
        capabilityStatus: status === 'ok' ? 'ready' : status === 'partial' ? 'degraded'
          : sourceData.meta.capabilityStatus,
        providerCalls: resolvedProviderCalls,
        durationMs,
      },
    },
  }
  if (!isNightAllDataSearchV1Envelope(publicBody)) {
    invalid('invalid_projection', 'the merged result could not satisfy night-all.data-search.v1')
  }

  const projection = {
    publicBody,
    payload: publicBody,
    items: publicBody.data.items,
    bodyCompleteness,
    detailSummary: {
      successful: detailResults.length,
      matched: matchedDetailCount,
      enriched: enrichedCount,
      failed: detailFailureCount,
      unresolved: unresolvedCount,
      providerCalls: resolvedProviderCalls,
    },
  }
  return deepFreeze(projection)
}

function unixSeconds(value) {
  if (value == null || value === '') return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? Math.floor(time / 1_000) : null
}

function metricOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bodyStateMap(projection) {
  if (!Array.isArray(projection?.bodyCompleteness)) return new Map()
  return new Map(projection.bodyCompleteness
    .filter((entry) => typeof entry?.externalId === 'string')
    .map((entry) => [entry.externalId, entry]))
}

function legacyRow(item, bodyState) {
  const text = typeof item.text === 'string' && item.text.length > 0
    ? item.text
    : typeof item.title === 'string' ? item.title : ''
  const coverUrl = stableHttpsUrl(item.media?.coverUrl)
  const videos = uniqueUrls(item.media?.videos)
  let images = uniqueUrls(item.media?.images)
  if (videos.length > 0 && coverUrl) images = images.filter((url) => url !== coverUrl)
  else if (coverUrl && !images.includes(coverUrl)) images.push(coverUrl)
  const avatarUrl = stableHttpsUrl(item.author?.avatarUrl) || ''
  const url = stableHttpsUrl(item.url) || ''
  return {
    content_id: item.externalId || item.id,
    platform_name: PLATFORM,
    url,
    original_url: url,
    title: typeof item.title === 'string' ? item.title : '',
    text,
    full_text: text,
    content: text,
    published_at: unixSeconds(item.publishedAt),
    collected_at: unixSeconds(item.collectedAt),
    source: 'mx-insight-hub',
    forward_count: metricOr(item.metrics?.shares, 0),
    reply_count: metricOr(item.metrics?.comments, 0),
    like_count: metricOr(item.metrics?.likes, 0),
    quote_count: 0,
    view_count: metricOr(item.metrics?.views, null),
    bookmark_count: metricOr(item.metrics?.bookmarks, 0),
    lang: '',
    is_forward: false,
    author_id: typeof item.author?.id === 'string' ? item.author.id : '',
    user_name: typeof item.author?.name === 'string' ? item.author.name : '',
    author_name: typeof item.author?.name === 'string' ? item.author.name : '',
    author_avatar_url: avatarUrl,
    profile_image_url: avatarUrl,
    cover_url: coverUrl || '',
    image_urls: JSON.stringify(images),
    video_urls: JSON.stringify(videos),
    metadata: JSON.stringify({
      body_completeness: bodyState?.completeness || 'unverified_complete',
      detail_used: bodyState?.detailUsed === true,
    }),
  }
}

function completenessSummary(items, states) {
  const summary = {
    detailEnriched: 0,
    providerPreview: 0,
    safetyLimited: 0,
    unverifiedComplete: 0,
  }
  for (const item of items) {
    const state = states.get(item.externalId)?.completeness || 'unverified_complete'
    if (state === 'detail_enriched') summary.detailEnriched += 1
    else if (state === 'provider_preview') summary.providerPreview += 1
    else if (state === 'safety_limited') summary.safetyLimited += 1
    else summary.unverifiedComplete += 1
  }
  return summary
}

/** Build Night-All's JSON-string raw compatibility envelope from a final modern projection. */
export function toNightAllXiaohongshuRawEnvelope(projectionOrPublicBody, {
  requestId,
  traceId,
} = {}) {
  const publicBody = publicBodyOf(projectionOrPublicBody)
  const data = publicBody.data
  const states = bodyStateMap(projectionOrPublicBody)
  const rows = data.items.map((item) => legacyRow(item, states.get(item.externalId)))
  const warnings = data.warnings.map((entry) => ({ ...entry }))
  if (rows.length === 0 && !warnings.some((entry) => entry.code === 'STANDARD_PAYLOAD_EMPTY')) {
    warnings.push(warning(
      'STANDARD_PAYLOAD_EMPTY',
      'Provider call completed but no usable standard raw_info/raw_data rows were produced.',
    ))
  }
  const nextCursor = data.pageInfo.nextCursor
  const envelope = {
    data: {
      platform: PLATFORM,
      keyword: data.query,
      query: data.query,
      source: 'mx-insight-hub',
      raw_info: '[]',
      raw_data: JSON.stringify(rows),
      page: {
        page: data.pageInfo.pageIndex,
        pageSize: data.pageInfo.pageSize,
        returnedCount: rows.length,
        hasMore: data.pageInfo.hasMore,
        nextCursor,
        providerCursor: null,
        // The direct continuation is an authenticated opaque Hub cursor. Do
        // not advertise page/params forms that the compatibility selector
        // would intentionally route back to the historical provider.
        nextParams: null,
        nextPage: null,
        paginationMode: 'cursor',
      },
      meta: {
        responseShape: 'standard_raw_payload',
        rawInfoCount: 0,
        rawDataCount: rows.length,
        resultCount: rows.length,
        status: data.status,
        providerCalls: data.meta.providerCalls ?? 0,
        durationMs: data.meta.durationMs ?? 0,
        bodyCompleteness: completenessSummary(data.items, states),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    ...(typeof (requestId ?? publicBody.requestId) === 'string'
      ? { requestId: requestId ?? publicBody.requestId } : {}),
    ...(typeof (traceId ?? publicBody.traceId) === 'string'
      ? { traceId: traceId ?? publicBody.traceId } : {}),
  }
  if (!isNightAllLegacyEnvelope(envelope)) {
    invalid('invalid_legacy_projection', 'the result could not satisfy the Night-All legacy envelope')
  }
  return deepFreeze(envelope)
}
