import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeChinaProvince } from './china-provinces.mjs'
import {
  DEFAULT_SEARCH_PROFILE,
  POSTGRES_SEARCH_PROFILE,
  resolveSearchProfile,
} from '../search/profiles.mjs'

const PUBLIC_OPINION_PLATFORM = 'public_opinion'
const PUBLIC_OPINION_SEARCH_FIELDS = [
  'countryCode', 'from', 'includeCandidates', 'location', 'minQualityScore', 'province', 'to',
]
const STORED_ALLOWED_FIELDS = new Set([
  // `type` selects result freshness and is consumed by the service layer; it is
  // accepted here so a strict body check does not reject it, and deliberately
  // excluded from the normalized query, which describes only what to search.
  'cursor', 'datasetId', 'objectType', 'pageSize', 'platform', 'query', 'type',
  ...PUBLIC_OPINION_SEARCH_FIELDS,
])
const CANONICAL_ALLOWED_FIELDS = new Set([...STORED_ALLOWED_FIELDS, 'searchProfile', 'sort'])
// `id` terminates every ordering, so all three are total and page deterministically.
const CANONICAL_SORTS = new Set(['newest', 'oldest', 'relevance'])
const CURSOR_VERSION = 2
const SORT_VERSION = 'score-eventTime-id-sharddoc-or-eventTime-id-v2'
const OPAQUE_EXTERNAL_ID_PLATFORMS = new Set(['public_opinion'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PUBLIC_METRICS = ['likes', 'comments', 'shares', 'views', 'bookmarks', 'members']
const PUBLICATION_STAGES = new Set(['formal', 'candidate'])
const PUBLICATION_STATUSES = new Set(['formal', 'pending', 'qualified', 'rejected', 'failed'])
const PUBLICATION_LOCATION_TYPES = new Set(['province', 'country', 'region', 'city', 'maritime', 'unknown'])
const SEARCH_ANALYSIS_STATE_VERSION = 1
const SEARCH_ANALYSIS_BACKENDS = new Set(['hanlp', 'jieba', 'bigram'])
const SEARCH_ANALYSIS_MAX_TOKENS = 512
const SEARCH_ANALYSIS_MAX_TOKEN_LENGTH = 512
const SEARCH_ANALYSIS_MAX_TOTAL_LENGTH = 2_048
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/

function timestampValue(value, field) {
  if (value == null) return null
  if (typeof value !== 'string' || !ISO_DATE_TIME_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time`)
  }
  return parsed.toISOString()
}

function qualityScoreValue(value, candidateMode) {
  if (value == null) return candidateMode === 'qualified' ? 80 : null
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new AppError(400, 'invalid_request', 'minQualityScore must be an integer between 0 and 100')
  }
  if (candidateMode === 'formal') {
    throw new AppError(
      400,
      'invalid_request',
      'minQualityScore requires includeCandidates=qualified or all',
    )
  }
  return value
}

function publicOpinionVisibility(input, platform) {
  const explicit = PUBLIC_OPINION_SEARCH_FIELDS.some((field) => Object.hasOwn(input, field))
  if (explicit && platform !== PUBLIC_OPINION_PLATFORM) {
    throw new AppError(
      400,
      'invalid_request',
      'Public-opinion search filters require explicit platform=public_opinion',
    )
  }

  let candidateMode = 'formal'
  if (input.includeCandidates != null) {
    candidateMode = String(input.includeCandidates).trim().toLowerCase()
    if (candidateMode !== 'qualified' && candidateMode !== 'all') {
      throw new AppError(400, 'invalid_request', 'includeCandidates must be qualified or all')
    }
  }
  const province = input.province == null ? null : normalizeChinaProvince(input.province)
  if (input.province != null && !province) {
    throw new AppError(
      400,
      'invalid_province',
      'province must be a supported ISO 3166-2:CN code or province name',
    )
  }
  let countryCode = null
  if (input.countryCode != null) {
    if (typeof input.countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(input.countryCode.trim())) {
      throw new AppError(400, 'invalid_request', 'countryCode must be an ISO alpha-2 country code')
    }
    countryCode = input.countryCode.trim().toUpperCase()
  }
  const location = input.location == null
    ? null
    : stringValue(input.location, 'location', 160)
  const from = timestampValue(input.from, 'from')
  const to = timestampValue(input.to, 'to')
  if (from && to && from > to) {
    throw new AppError(400, 'invalid_request', 'from must not be later than to')
  }
  const minQualityScore = qualityScoreValue(input.minQualityScore, candidateMode)
  if (candidateMode === 'all' && (!from || !to || !(province || countryCode || location))) {
    throw new AppError(
      400,
      'candidate_scope_required',
      'includeCandidates=all requires from, to and at least one of province, countryCode or location',
    )
  }
  return {
    candidateMode,
    minQualityScore,
    provinceCode: province?.code ?? null,
    countryCode,
    location,
    from,
    to,
    explicit,
  }
}

function withPublicOpinionBinding(binding, visibility) {
  if (!visibility?.explicit) return binding
  return {
    ...binding,
    includeCandidates: visibility.candidateMode === 'formal' ? false : visibility.candidateMode,
    minQualityScore: visibility.minQualityScore,
    province: visibility.provinceCode,
    countryCode: visibility.countryCode,
    location: visibility.location,
    from: visibility.from,
    to: visibility.to,
  }
}

function publicOpinionResponseFilters(visibility) {
  if (!visibility?.explicit) return {}
  return {
    includeCandidates: visibility.candidateMode === 'formal' ? false : visibility.candidateMode,
    minQualityScore: visibility.minQualityScore,
    province: visibility.provinceCode,
    countryCode: visibility.countryCode,
    location: visibility.location,
    from: visibility.from,
    to: visibility.to,
  }
}

function stringValue(value, field, maxLength, { required = false } = {}) {
  if (value == null) {
    if (required) throw new AppError(400, 'invalid_request', `${field} is required`)
    return null
  }
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AppError(
      400,
      'invalid_request',
      `${field} must be a non-blank string of at most ${maxLength} characters`,
    )
  }
  return value.trim()
}

function pageSizeValue(value, maxPageSize) {
  const pageSize = value == null ? Math.min(20, maxPageSize) : value
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  if (pageSize > maxPageSize) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must not exceed ${maxPageSize}`)
  }
  return pageSize
}

function queryBinding(query) {
  return createHash('sha256')
    .update(JSON.stringify(withPublicOpinionBinding({
      v: CURSOR_VERSION,
      sort: SORT_VERSION,
      query: query.query,
      platform: query.platform,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
    }, query.publicOpinionVisibility)))
    .digest('base64url')
}

function canonicalQueryBinding(query) {
  return createHash('sha256')
    .update(JSON.stringify(withPublicOpinionBinding({
      v: CURSOR_VERSION,
      sort: SORT_VERSION,
      query: query.query,
      platform: query.platform,
      platforms: query.platforms,
      datasetId: query.datasetId,
      objectType: query.objectType,
      pageSize: query.pageSize,
      searchProfile: query.searchProfile,
      // The requested ordering is part of what a cursor means. Omitting it would
      // let a caller flip the order and keep paging from a position computed
      // under the previous one, silently skipping and repeating rows.
      requestedSort: query.sort,
    }, query.publicOpinionVisibility)))
    .digest('base64url')
}

/**
 * Newest-first by default, matching the Data Center console.
 *
 * Relevance remains available by name. It is not the default because a caller
 * scanning a corpus reads an unexplained score order as unsorted data, and
 * because two surfaces over the same index answering differently is a trap.
 */
function sortValue(value) {
  if (value == null || value === '') return 'newest'
  const normalized = String(value).trim()
  if (!CANONICAL_SORTS.has(normalized)) {
    throw new AppError(400, 'invalid_sort', `sort must be one of ${[...CANONICAL_SORTS].join(', ')}`)
  }
  return normalized
}

function cursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Stored search cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function validSearchAfter(mode, value) {
  if (!Array.isArray(value)) return false
  if (mode === 'postgres') {
    if (value.length !== 2 || !UUID_PATTERN.test(value[1] || '')) return false
    if (value[0] === null) return true
    if (typeof value[0] !== 'string' || value[0].length > 128) return false
    return new Date(value[0]).toISOString() === value[0]
  }
  if (
    value.length !== 4 ||
    !Number.isFinite(value[0]) ||
    !UUID_PATTERN.test(value[2] || '') ||
    !Number.isFinite(value[3])
  ) {
    return false
  }
  return value[1] === null || Number.isFinite(value[1]) || (
    typeof value[1] === 'string' && value[1].length <= 128
  )
}

function validSearchAnalysisState(mode, value) {
  if (mode === 'postgres') return value === null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort().join(',')
  if (
    keys !== 'appliedProfile,backendUsed,degraded,errorCode,tokens,v' &&
    keys !== 'appliedProfile,backendUsed,degraded,errorCode,indexSchema,tokens,v'
  ) {
    return false
  }
  if (
    value.v !== SEARCH_ANALYSIS_STATE_VERSION ||
    typeof value.appliedProfile !== 'string' ||
    !value.appliedProfile.trim() ||
    value.appliedProfile.length > 128 ||
    typeof value.degraded !== 'boolean' ||
    !(value.backendUsed === null || SEARCH_ANALYSIS_BACKENDS.has(value.backendUsed)) ||
    !(value.errorCode === null || (typeof value.errorCode === 'string' && value.errorCode.length <= 64)) ||
    !(value.indexSchema === undefined || (
      typeof value.indexSchema === 'string' && /^content-v\d+$/.test(value.indexSchema)
    )) ||
    !Array.isArray(value.tokens) ||
    value.tokens.length > SEARCH_ANALYSIS_MAX_TOKENS
  ) {
    return false
  }
  let totalLength = 0
  for (const token of value.tokens) {
    if (typeof token !== 'string' || !token.trim()) return false
    const length = [...token].length
    if (length > SEARCH_ANALYSIS_MAX_TOKEN_LENGTH) return false
    totalLength += length
    if (totalLength > SEARCH_ANALYSIS_MAX_TOTAL_LENGTH) return false
  }
  return true
}

export function encodeStoredSearchCursor({
  mode,
  pitId = null,
  searchAfter,
  seen,
  analysisState = null,
}, binding, secret) {
  if (!validSearchAnalysisState(mode, analysisState)) {
    throw new AppError(
      500,
      'cursor_configuration_error',
      'Search cursor analysis state is missing or invalid',
    )
  }
  const payload = {
    v: CURSOR_VERSION,
    m: mode,
    p: pitId,
    a: searchAfter,
    n: seen,
    q: binding,
    r: analysisState,
  }
  return Buffer.from(
    JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }),
    'utf8',
  ).toString('base64url')
}

export function decodeStoredSearchCursor(value, binding, secret) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(',') === 'a,m,n,p,q,r,s,v'
    const payload = {
      v: parsed?.v,
      m: parsed?.m,
      p: parsed?.p,
      a: parsed?.a,
      n: parsed?.n,
      q: parsed?.q,
      r: parsed?.r,
    }
    const validMode = parsed?.m === 'elasticsearch' || parsed?.m === 'postgres'
    const validPit = parsed?.m === 'elasticsearch'
      ? typeof parsed?.p === 'string' && parsed.p.length > 0 && parsed.p.length <= 4_096
      : parsed?.p === null
    if (
      !validKeys || parsed?.v !== CURSOR_VERSION || !validMode || !validPit ||
      !validSearchAfter(parsed.m, parsed.a) || !Number.isSafeInteger(parsed?.n) || parsed.n < 1 ||
      !validSearchAnalysisState(parsed.m, parsed.r) ||
      parsed?.q !== binding || typeof parsed?.s !== 'string' ||
      !signaturesMatch(parsed.s, cursorSignature(payload, secret))
    ) {
      throw new Error('bad cursor')
    }
    return {
      mode: parsed.m,
      pitId: parsed.p,
      searchAfter: [...parsed.a],
      seen: parsed.n,
      analysisState: parsed.r == null
        ? null
        : { ...parsed.r, tokens: [...parsed.r.tokens] },
    }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous search cursor unchanged')
  }
}

export function normalizeStoredSearchQuery(input, maxPageSize = 100, cursorSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'JSON object body is required')
  }
  const unsupported = Object.keys(input).filter((field) => !STORED_ALLOWED_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported stored search fields: ${unsupported.join(', ')}`)
  }
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const platform = stringValue(input.platform, 'platform', 64, { required: true })
  const normalized = {
    query: stringValue(input.query, 'query', 500, { required: true }),
    platform,
    datasetId: stringValue(input.datasetId, 'datasetId', 200),
    objectType: stringValue(input.objectType, 'objectType', 100),
    pageSize: pageSizeValue(input.pageSize, Math.min(100, validPolicyMax)),
    publicOpinionVisibility: publicOpinionVisibility(input, platform),
  }
  const cursorBinding = queryBinding(normalized)
  const cursorToken = stringValue(input.cursor, 'cursor', 8_192)
  return {
    ...normalized,
    cursorBinding,
    cursorToken,
    cursor: decodeStoredSearchCursor(
      cursorToken,
      cursorBinding,
      cursorSecret,
    ),
  }
}

export function normalizeCanonicalSearchQuery(input, {
  platforms,
  maxPageSize = 100,
  cursorSecret,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'JSON object body is required')
  }
  const unsupported = Object.keys(input).filter((field) => !CANONICAL_ALLOWED_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported canonical search fields: ${unsupported.join(', ')}`)
  }
  const platformScope = [...new Set((platforms || []).map((value) => String(value).trim()).filter(Boolean))].sort()
  if (platformScope.length === 0) {
    throw new AppError(403, 'platform_not_granted', 'At least one platform grant is required')
  }
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const platform = stringValue(input.platform, 'platform', 64)
  if (platform && !platformScope.includes(platform)) {
    throw new AppError(403, 'platform_not_granted', 'Platform is not granted')
  }
  const normalized = {
    query: stringValue(input.query, 'query', 500, { required: true }),
    platform,
    platforms: platform ? [platform] : platformScope,
    datasetId: stringValue(input.datasetId, 'datasetId', 200),
    objectType: stringValue(input.objectType, 'objectType', 100),
    pageSize: pageSizeValue(input.pageSize, Math.min(100, validPolicyMax)),
    searchProfile: resolveSearchProfile(
      input.searchProfile ?? DEFAULT_SEARCH_PROFILE,
      { audience: 'public' },
    ).id,
    sort: sortValue(input.sort),
    publicOpinionVisibility: publicOpinionVisibility(input, platform),
  }
  const cursorBinding = canonicalQueryBinding(normalized)
  const cursorToken = stringValue(input.cursor, 'cursor', 8_192)
  return {
    ...normalized,
    cursorBinding,
    cursorToken,
    cursor: decodeStoredSearchCursor(cursorToken, cursorBinding, cursorSecret),
  }
}

function isoDate(value) {
  if (value == null) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function publicMetrics(metrics) {
  return Object.fromEntries(PUBLIC_METRICS.map((key) => {
    const value = metrics?.[key]
    return [key, typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null]
  }))
}

function publicCandidateMetadata(publication) {
  const stage = PUBLICATION_STAGES.has(publication?.stage) ? publication.stage : null
  const status = PUBLICATION_STATUSES.has(publication?.status) ? publication.status : null
  const score = publication?.qualityScore == null ? null : Number(publication.qualityScore)
  const text = (value) => {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    return normalized && normalized.length <= 256 ? normalized : null
  }
  const countryCode = text(publication?.countryCode)?.toUpperCase() ?? null
  return {
    quality: {
      stage,
      status,
      score: score != null && Number.isFinite(score) && score >= 0 && score <= 100 ? score : null,
      geographyVerified: publication?.geographyVerified === true,
    },
    location: {
      provinceCode: text(publication?.displayAdmin1),
      label: text(publication?.locationLabel),
      type: PUBLICATION_LOCATION_TYPES.has(publication?.locationType)
        ? publication.locationType
        : null,
      country: text(publication?.countryName),
      countryCode: countryCode && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
    },
  }
}

export function publicStoredSearchItem(row, { includeCandidateMetadata = false } = {}) {
  const suppressCandidateIdentity = includeCandidateMetadata || row.publication?.stage === 'candidate'
  const item = {
    id: row.id,
    datasetId: row.datasetId,
    platform: row.platform,
    objectType: row.objectType,
    ...(!suppressCandidateIdentity ? { contentType: row.contentType ?? null } : {}),
    // Preserve the generic item shape without exposing the upstream table row
    // identifier for corpora whose source coordinates are private evidence.
    externalId: OPAQUE_EXTERNAL_ID_PLATFORMS.has(row.platform) ? row.id : row.externalId,
    url: row.url ?? null,
    title: row.title ?? null,
    text: row.body ?? null,
    ...(!suppressCandidateIdentity ? {
      author: {
        id: row.authorExternalId ?? null,
        name: row.authorName ?? null,
        username: row.authorHandle ?? null,
      },
    } : {}),
    metrics: publicMetrics(row.metrics),
    eventTime: isoDate(row.eventTime),
    collectedAt: isoDate(row.collectedAt),
    score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    source: 'hub',
  }
  return includeCandidateMetadata
    ? { ...item, ...publicCandidateMetadata(row.publication) }
    : item
}

export function storedSearchResponse({ query, result, durationMs, cursorSecret }) {
  const includeCandidateMetadata = ['qualified', 'all']
    .includes(query.publicOpinionVisibility?.candidateMode)
  const items = (result.items || []).map((row) => (
    publicStoredSearchItem(row, { includeCandidateMetadata })
  ))
  const seen = query.cursor?.seen ?? 0
  const hasMore = Boolean(result.hasMore)
  const requestedProfile = result.searchExecution?.requestedProfile
  const appliedProfile = result.searchExecution?.appliedProfile
  const profileDegraded = result.mode === 'elasticsearch'
    && typeof requestedProfile === 'string'
    && typeof appliedProfile === 'string'
    && requestedProfile !== appliedProfile
  const warnings = result.mode === 'postgres'
    ? [{
        code: 'search_projection_degraded',
        message: 'Elasticsearch unavailable or disabled; PostgreSQL substring search was used.',
      }]
    : []
  if (profileDegraded) {
    warnings.push({
      code: 'search_profile_degraded',
      message: `Requested search profile ${requestedProfile} was not available; ${appliedProfile} was applied.`,
    })
  }
  return {
    data: {
      contractVersion: 'mx-insight-hub.stored-search.v1',
      source: 'hub',
      query: query.query,
      filters: {
        platform: query.platform,
        datasetId: query.datasetId,
        objectType: query.objectType,
        ...publicOpinionResponseFilters(query.publicOpinionVisibility),
      },
      items,
      pageInfo: {
        pageIndex: Math.floor(seen / query.pageSize) + 1,
        pageSize: query.pageSize,
        returnedCount: items.length,
        hasMore,
        nextCursor: hasMore
          ? encodeStoredSearchCursor(
              { ...result.nextCursor, seen: seen + items.length },
              query.cursorBinding,
              cursorSecret,
            )
          : null,
        cursorType: hasMore ? 'opaque' : 'none',
      },
      searchMode: result.mode,
      warnings,
      durationMs,
    },
  }
}

export function canonicalSearchResponse({ query, result, durationMs, cursorSecret }) {
  const includeCandidateMetadata = ['qualified', 'all']
    .includes(query.publicOpinionVisibility?.candidateMode)
  const items = (result.items || []).map((row) => (
    publicStoredSearchItem(row, { includeCandidateMetadata })
  ))
  const seen = query.cursor?.seen ?? 0
  const hasMore = Boolean(result.hasMore)
  const totalCount = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null
  const totalRelation = totalCount == null
    ? 'unknown'
    : result.totalRelation === 'gte' ? 'gte' : 'eq'
  const requestedProfile = query.searchProfile ?? DEFAULT_SEARCH_PROFILE
  const appliedProfile = result.searchExecution?.appliedProfile
    ?? (result.mode === 'postgres' ? POSTGRES_SEARCH_PROFILE : requestedProfile)
  const profileDegraded = appliedProfile !== requestedProfile
  const warnings = []
  if (result.mode === 'postgres') {
    warnings.push({
      code: 'search_projection_degraded',
      message: 'Elasticsearch unavailable or disabled; PostgreSQL substring search was used.',
    })
  }
  if (profileDegraded) {
    warnings.push({
      code: 'search_profile_degraded',
      message: `Requested search profile ${requestedProfile} was not available; ${appliedProfile} was applied.`,
    })
  }
  return {
    data: {
      contractVersion: 'mx-insight-hub.canonical-search.v1',
      source: 'hub',
      query: query.query,
      scope: { platforms: query.platforms },
      filters: {
        platform: query.platform,
        datasetId: query.datasetId,
        objectType: query.objectType,
        ...publicOpinionResponseFilters(query.publicOpinionVisibility),
      },
      search: {
        requestedProfile,
        appliedProfile,
        degraded: profileDegraded,
      },
      items,
      pageInfo: {
        pageIndex: Math.floor(seen / query.pageSize) + 1,
        pageSize: query.pageSize,
        returnedCount: items.length,
        totalCount,
        totalRelation,
        totalPages: totalRelation === 'eq' ? Math.ceil(totalCount / query.pageSize) : null,
        hasMore,
        nextCursor: hasMore
          ? encodeStoredSearchCursor(
              { ...result.nextCursor, seen: seen + items.length },
              query.cursorBinding,
              cursorSecret,
            )
          : null,
        cursorType: hasMore ? 'opaque' : 'none',
      },
      searchMode: result.mode,
      warnings,
      durationMs,
    },
  }
}
