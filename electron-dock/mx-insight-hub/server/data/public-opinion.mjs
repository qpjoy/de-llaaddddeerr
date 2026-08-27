import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { CHINA_PROVINCES, normalizeChinaProvince } from './china-provinces.mjs'

export const PUBLIC_OPINION_PLATFORM = 'public_opinion'
export const PUBLIC_OPINION_DATASET_ID = 'public-opinion.province.v1'
export const PUBLIC_OPINION_OBJECT_TYPE = 'opinion_item'
export const PUBLIC_OPINION_ALL_INGESTED_CAPABILITY = 'public_opinion.all_ingested.read'
export const PUBLIC_OPINION_DIAGNOSTICS_CAPABILITY = 'public_opinion.diagnostics.read'

const ALLOWED_QUERY_FIELDS = new Set([
  'cursor',
  'from',
  'includeCandidates',
  'minQualityScore',
  'pageSize',
  'sort',
  'to',
])
const ALLOWED_DETAIL_QUERY_FIELDS = new Set(['includeCandidates', 'minQualityScore'])
const ALLOWED_COVERAGE_QUERY_FIELDS = new Set([
  'from',
  'includeCandidates',
  'minQualityScore',
  'targetPerProvince',
  'to',
])
const ALLOWED_REGION_CATALOG_QUERY_FIELDS = new Set(['level', 'parentCode'])
const ALLOWED_REGION_FEED_QUERY_FIELDS = new Set([
  'cursor',
  'from',
  'pageSize',
  'sort',
  'to',
  'visibility',
])
const SORTS = new Set(['hot', 'latest'])
const CANDIDATE_MODES = new Set(['qualified', 'all'])
const DEFAULT_QUALITY_SCORE = 80
const CURSOR_VERSION = 2
const MAX_CURSOR_LENGTH = 8_192
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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

function pageSizeValue(value, maxPageSize) {
  if (value == null) return Math.min(20, maxPageSize)
  if (!/^\d+$/.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > Math.min(100, maxPageSize)) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must be between 1 and ${Math.min(100, maxPageSize)}`)
  }
  return pageSize
}

function boundedInteger(value, field, fallback, min, max) {
  if (value == null) return fallback
  if (!/^\d+$/.test(String(value))) {
    throw new AppError(400, 'invalid_request', `${field} must be an integer between ${min} and ${max}`)
  }
  const number = Number(value)
  if (number < min || number > max) {
    throw new AppError(400, 'invalid_request', `${field} must be between ${min} and ${max}`)
  }
  return number
}

function candidateModeValue(value) {
  if (value == null || value === false || value === 'false' || value === '') return 'formal'
  if (value === true || value === 'true') return 'qualified'
  const normalized = String(value).trim().toLowerCase()
  if (CANDIDATE_MODES.has(normalized)) return normalized
  throw new AppError(400, 'invalid_request', 'includeCandidates must be false, qualified or all')
}

function candidateSelection(input) {
  const candidateMode = candidateModeValue(input.includeCandidates)
  const explicitMinQualityScore = input.minQualityScore != null
  if (candidateMode === 'formal' && explicitMinQualityScore) {
    throw new AppError(400, 'invalid_request', 'minQualityScore requires includeCandidates=qualified or all')
  }
  return {
    candidateMode,
    minQualityScore: boundedInteger(
      input.minQualityScore,
      'minQualityScore',
      candidateMode === 'qualified' ? DEFAULT_QUALITY_SCORE : null,
      0,
      100,
    ),
  }
}

function assertAllCandidateWindow(candidateMode, from, to) {
  if (candidateMode === 'all' && (!from || !to)) {
    throw new AppError(
      400,
      'candidate_scope_required',
      'includeCandidates=all requires both from and to',
    )
  }
}

function bindingFor(query) {
  const binding = {
    v: CURSOR_VERSION,
    platform: PUBLIC_OPINION_PLATFORM,
    datasetId: PUBLIC_OPINION_DATASET_ID,
    objectType: PUBLIC_OPINION_OBJECT_TYPE,
    provinceCode: query.province.code,
    sort: query.sort,
    from: query.from,
    to: query.to,
    pageSize: query.pageSize,
  }
  // Preserve the exact v2 binding for legacy/default formal-only cursors.
  // Candidate modes are additive and bind their visibility controls.
  if (query.candidateMode !== 'formal') {
    binding.includeCandidates = query.candidateMode
    binding.minQualityScore = query.minQualityScore
  }
  return createHash('sha256').update(JSON.stringify(binding)).digest('base64url')
}

function regionBindingFor(query) {
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    contract: 'mx-insight-hub.public-opinion.region-feed.v1',
    platform: PUBLIC_OPINION_PLATFORM,
    datasetId: PUBLIC_OPINION_DATASET_ID,
    objectType: PUBLIC_OPINION_OBJECT_TYPE,
    regionCode: query.region.code,
    visibility: query.visibility,
    sort: query.sort,
    from: query.from,
    to: query.to,
    pageSize: query.pageSize,
  })).digest('base64url')
}

function signature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Province opinion cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function cursorPayload(position, binding) {
  return {
    v: CURSOR_VERSION,
    q: binding,
    h: position.heatScore ?? null,
    t: position.sortTime,
    c: position.collectedAt ?? null,
    id: position.id,
  }
}

export function encodePublicOpinionCursor(position, binding, secret) {
  const payload = cursorPayload(position, binding)
  return Buffer.from(JSON.stringify({ ...payload, s: signature(payload, secret) }), 'utf8').toString('base64url')
}

export function decodePublicOpinionCursor(value, { sort, binding, secret }) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = {
      v: parsed?.v,
      q: parsed?.q,
      h: parsed?.h,
      t: parsed?.t,
      c: parsed?.c,
      id: parsed?.id,
    }
    const validKeys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).sort().join(',') === 'c,h,id,q,s,t,v'
    const validSortTime = typeof parsed?.t === 'string'
      && new Date(parsed.t).toISOString() === parsed.t
    const validCollected = sort === 'latest'
      ? typeof parsed?.c === 'string' && new Date(parsed.c).toISOString() === parsed.c
      : parsed?.c === null
    const validHeat = sort === 'hot'
      ? typeof parsed?.h === 'string' && /^-?\d+(?:\.\d+)?$/.test(parsed.h)
      : parsed?.h === null
    if (
      !validKeys || parsed.v !== CURSOR_VERSION || parsed.q !== binding
      || !validSortTime || !validCollected || !validHeat || !UUID_PATTERN.test(parsed.id || '')
      || typeof parsed.s !== 'string' || !signaturesMatch(parsed.s, signature(payload, secret))
    ) throw new Error('bad cursor')
    return {
      heatScore: parsed.h,
      sortTime: parsed.t,
      collectedAt: parsed.c,
      id: parsed.id,
    }
  } catch {
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid; return the previous page cursor unchanged')
  }
}

export function normalizePublicOpinionQuery(provinceInput, input = {}, maxPageSize = 100, cursorSecret) {
  const province = normalizeChinaProvince(provinceInput)
  if (!province) {
    throw new AppError(400, 'invalid_province', 'province must be a supported ISO 3166-2:CN code or province name')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported province opinion fields: ${unsupported.join(', ')}`)
  }
  const sort = input.sort == null ? 'hot' : String(input.sort).trim()
  if (!SORTS.has(sort)) throw new AppError(400, 'invalid_sort', 'sort must be hot or latest')
  const from = timestampValue(input.from, 'from')
  const to = timestampValue(input.to, 'to')
  if (from && to && from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  const candidateSelectionValue = candidateSelection(input)
  assertAllCandidateWindow(candidateSelectionValue.candidateMode, from, to)
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const normalized = {
    province,
    sort,
    from,
    to,
    pageSize: pageSizeValue(input.pageSize, validPolicyMax),
    ...candidateSelectionValue,
  }
  const cursorBinding = bindingFor(normalized)
  if (input.cursor != null && typeof input.cursor !== 'string') {
    throw new AppError(400, 'invalid_request', 'cursor must be a string')
  }
  if (input.cursor?.length > MAX_CURSOR_LENGTH) {
    throw new AppError(400, 'invalid_cursor', `cursor must not exceed ${MAX_CURSOR_LENGTH} characters`)
  }
  const cursorToken = input.cursor == null ? null : input.cursor.trim()
  if (input.cursor != null && !cursorToken) {
    throw new AppError(400, 'invalid_request', 'cursor must be a non-blank string')
  }
  return {
    ...normalized,
    cursorBinding,
    cursorToken,
    cursor: decodePublicOpinionCursor(cursorToken, { sort, binding: cursorBinding, secret: cursorSecret }),
  }
}

export function normalizePublicOpinionDetailQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_DETAIL_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported public-opinion item fields: ${unsupported.join(', ')}`)
  }
  return candidateSelection(input)
}

export function normalizePublicOpinionCoverageQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_COVERAGE_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported province coverage fields: ${unsupported.join(', ')}`)
  }
  const from = timestampValue(input.from, 'from')
  const to = timestampValue(input.to, 'to')
  if (!from || !to) {
    throw new AppError(400, 'invalid_request', 'province coverage requires both from and to')
  }
  if (from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  return {
    from,
    to,
    targetPerProvince: boundedInteger(input.targetPerProvince, 'targetPerProvince', 10, 1, 100),
    ...candidateSelection(input),
  }
}

export function normalizePublicOpinionRegionsQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_REGION_CATALOG_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported public-opinion region fields: ${unsupported.join(', ')}`)
  }
  const parentCode = input.parentCode == null ? 'CN' : String(input.parentCode).trim().toUpperCase()
  const level = input.level == null ? 'province' : String(input.level).trim().toLowerCase()
  if (parentCode !== 'CN') {
    throw new AppError(400, 'invalid_parent_region', 'P1 region catalog only supports parentCode=CN')
  }
  if (level !== 'province') {
    throw new AppError(400, 'unsupported_region_level', 'P1 region catalog only supports level=province')
  }
  return { parentCode, level }
}

function normalizePublicOpinionRegion(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_region', 'region must be CN or a supported ISO 3166-2:CN province code')
  }
  const code = value.trim().toUpperCase()
  if (code === 'CN') {
    return {
      code: 'CN',
      name: '中国',
      officialName: '中华人民共和国',
      level: 'country',
      parentCode: null,
    }
  }
  const province = normalizeChinaProvince(code)
  if (!province || province.code !== code) {
    throw new AppError(400, 'invalid_region', 'region must be CN or a supported ISO 3166-2:CN province code')
  }
  return { ...province, level: 'province', parentCode: 'CN' }
}

export function normalizePublicOpinionRegionQuery(
  regionInput,
  input = {},
  maxPageSize = 100,
  cursorSecret,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'query parameters must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_REGION_FEED_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported public-opinion region feed fields: ${unsupported.join(', ')}`)
  }
  const visibility = input.visibility == null ? null : String(input.visibility).trim().toLowerCase()
  if (visibility !== 'all_ingested') {
    throw new AppError(
      400,
      'invalid_visibility',
      'P1 region feed requires visibility=all_ingested; use the existing province feed for curated visibility',
    )
  }
  const sort = input.sort == null ? 'latest' : String(input.sort).trim().toLowerCase()
  if (sort !== 'latest') {
    throw new AppError(400, 'invalid_sort', 'all_ingested region feed currently supports sort=latest only')
  }
  const from = timestampValue(input.from, 'from')
  const to = timestampValue(input.to, 'to')
  if (!from || !to) {
    throw new AppError(400, 'all_ingested_scope_required', 'visibility=all_ingested requires both from and to')
  }
  if (from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  const validPolicyMax = Number.isInteger(maxPageSize) && maxPageSize > 0 ? maxPageSize : 100
  const normalized = {
    region: normalizePublicOpinionRegion(regionInput),
    visibility,
    sort,
    from,
    to,
    pageSize: pageSizeValue(input.pageSize, validPolicyMax),
  }
  const cursorBinding = regionBindingFor(normalized)
  if (input.cursor != null && typeof input.cursor !== 'string') {
    throw new AppError(400, 'invalid_request', 'cursor must be a string')
  }
  if (input.cursor?.length > MAX_CURSOR_LENGTH) {
    throw new AppError(400, 'invalid_cursor', `cursor must not exceed ${MAX_CURSOR_LENGTH} characters`)
  }
  const cursorToken = input.cursor == null ? null : input.cursor.trim()
  if (input.cursor != null && !cursorToken) {
    throw new AppError(400, 'invalid_request', 'cursor must be a non-blank string')
  }
  return {
    ...normalized,
    cursorBinding,
    cursorToken,
    cursor: decodePublicOpinionCursor(cursorToken, {
      sort,
      binding: cursorBinding,
      secret: cursorSecret,
    }),
  }
}

export function publicOpinionRegions(query) {
  return {
    contractVersion: 'mx-insight-hub.public-opinion.regions.v1',
    parentCode: query.parentCode,
    level: query.level,
    regions: CHINA_PROVINCES.map((province) => ({
      ...province,
      level: 'province',
      parentCode: 'CN',
    })),
  }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString()
}

function numberValue(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function publicOpinionItem(row, { includeQuality = false } = {}) {
  const province = normalizeChinaProvince(row.admin1_code)
  const attributes = row.stable_fields?.attributes || {}
  const candidate = row.source_stage === 'candidate'
  const item = {
    id: row.id,
    title: row.title ?? null,
    summary: row.body ?? null,
    url: row.url ?? null,
    publishedAt: iso(row.event_time),
    collectedAt: iso(row.collected_at),
    province: province ? { code: province.code, name: province.name } : null,
    heatScore: numberValue(row.heat_score),
    origin: {
      // Candidate source names may be transport engines or upstream provider
      // identifiers. Keep the established formal response unchanged, but do
      // not expose that identity on opt-in candidate reads.
      name: candidate ? null : row.author_name ?? null,
      type: candidate
        ? null
        : typeof attributes.sourceType === 'string' ? attributes.sourceType : row.content_type ?? null,
      platform: candidate
        ? null
        : typeof attributes.sourcePlatform === 'string' ? attributes.sourcePlatform : null,
    },
  }
  if (includeQuality) {
    item.quality = {
      stage: candidate ? 'candidate' : 'formal',
      status: typeof row.quality_status === 'string'
        ? row.quality_status
        : candidate ? 'pending' : 'formal',
      score: numberValue(row.quality_score),
      threshold: numberValue(row.qualification_threshold),
      geographyVerified: row.geography_verified === true,
    }
    if (row.location_label || row.country_name || row.country_code || row.geo_scope) {
      item.location = {
        label: row.location_label ?? null,
        type: row.location_type ?? null,
        country: row.country_name ?? null,
        countryCode: row.country_code ?? null,
        geoScope: row.geo_scope ?? null,
      }
    }
  }
  return item
}

export function publicOpinionPage(rows, query, cursorSecret) {
  const hasMore = rows.length > query.pageSize
  const pageRows = hasMore ? rows.slice(0, query.pageSize) : rows
  const last = pageRows.at(-1)
  const nextPosition = !last ? null : query.sort === 'hot'
    ? {
        heatScore: String(last.heat_score),
        sortTime: iso(last.sort_time ?? last.event_time ?? last.collected_at),
        collectedAt: null,
        id: last.id,
      }
    : {
        heatScore: null,
        sortTime: iso(last.sort_time ?? last.event_time ?? last.collected_at),
        collectedAt: iso(last.collected_at),
        id: last.id,
      }
  return {
    contractVersion: 'mx-insight-hub.public-opinion.v1',
    province: { code: query.province.code, name: query.province.name },
    sort: query.sort,
    items: pageRows.map((row) => publicOpinionItem(row, {
      includeQuality: query.candidateMode !== 'formal',
    })),
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && nextPosition
        ? encodePublicOpinionCursor(nextPosition, query.cursorBinding, cursorSecret)
        : null,
    },
  }
}

export function publicOpinionRegionPage(rows, query, cursorSecret) {
  const hasMore = rows.length > query.pageSize
  const pageRows = hasMore ? rows.slice(0, query.pageSize) : rows
  const last = pageRows.at(-1)
  const nextPosition = !last ? null : {
    heatScore: null,
    sortTime: iso(last.sort_time ?? last.event_time ?? last.collected_at),
    collectedAt: iso(last.collected_at),
    id: last.id,
  }
  return {
    contractVersion: 'mx-insight-hub.public-opinion.region-feed.v1',
    region: query.region,
    visibility: {
      mode: 'all_ingested',
      qualityFiltered: false,
      corpusDefinition: 'canonical_current_safe',
    },
    sort: query.sort,
    timeBasis: 'effective',
    from: query.from,
    to: query.to,
    items: pageRows.map((row) => publicOpinionItem(row, { includeQuality: true })),
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && nextPosition
        ? encodePublicOpinionCursor(nextPosition, query.cursorBinding, cursorSecret)
        : null,
    },
  }
}

export function publicOpinionCoverage(rows, query) {
  const byProvince = new Map((rows || []).map((row) => [row.province_code, row]))
  const provinces = CHINA_PROVINCES.map((province) => {
    const row = byProvince.get(province.code) || {}
    const formalCount = Number(row.formal_count || 0)
    const qualifiedCandidateCount = Number(row.qualified_candidate_count || 0)
    const candidateCount = Number(row.candidate_count || 0)
    const verifiedCount = Number(row.verified_count || 0)
    const availableCount = query.candidateMode === 'formal'
      ? formalCount
      : formalCount + (query.candidateMode === 'qualified' ? qualifiedCandidateCount : candidateCount)
    const qualifiedCandidateRate = candidateCount > 0
      ? Math.round((qualifiedCandidateCount / candidateCount) * 1_000) / 1_000
      : null
    const verifiedRate = availableCount > 0
      ? Math.round((verifiedCount / availableCount) * 1_000) / 1_000
      : null
    return {
      province: { code: province.code, name: province.name },
      formalCount,
      qualifiedCandidateCount,
      candidateCount,
      qualifiedCandidateRate,
      verifiedCount,
      verifiedRate,
      availableCount,
      shortfall: Math.max(0, query.targetPerProvince - availableCount),
      meetsTarget: availableCount >= query.targetPerProvince,
      averageQualityScore: numberValue(row.average_quality_score),
    }
  })
  const ranked = provinces.slice().sort((left, right) => (
    right.availableCount - left.availableCount
    || (right.verifiedRate ?? -1) - (left.verifiedRate ?? -1)
    || (right.averageQualityScore ?? -1) - (left.averageQualityScore ?? -1)
    || left.province.code.localeCompare(right.province.code)
  ))
  return {
    contractVersion: 'mx-insight-hub.public-opinion.coverage.v1',
    from: query.from,
    to: query.to,
    includeCandidates: query.candidateMode === 'formal' ? false : query.candidateMode,
    minQualityScore: query.minQualityScore,
    targetPerProvince: query.targetPerProvince,
    featuredProvinceCodes: ranked.slice(0, 8).map((item) => item.province.code),
    totals: {
      provinceCount: provinces.length,
      availableCount: provinces.reduce((total, item) => total + item.availableCount, 0),
      provincesMeetingTarget: provinces.filter((item) => item.meetsTarget).length,
      totalShortfall: provinces.reduce((total, item) => total + item.shortfall, 0),
    },
    provinces,
  }
}

export function normalizePublicOpinionItemId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', 'item id must be a UUID')
  }
  return value
}
