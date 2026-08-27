import { AppError } from '../core/errors.mjs'
import {
  canonicalContextResponse,
  normalizeCanonicalContextQuery,
} from './canonical-context.mjs'
import {
  normalizePublicOpinionCoverageQuery,
  normalizePublicOpinionItemId,
  normalizePublicOpinionQuery,
  normalizePublicOpinionRegionsQuery,
  publicOpinionCoverage,
  publicOpinionItem,
  publicOpinionPage,
  publicOpinionRegions,
} from './public-opinion.mjs'
import {
  decodeTelegramCursor,
  encodeTelegramCursor,
  publicTelegramMonitorRecord,
} from './telegram-monitor.mjs'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHAT_KINDS = new Set(['all', 'channel', 'group', 'unknown'])
const TELEGRAM_SOURCE_SCOPES = new Set(['all', 'monitor', 'sqlite'])
const CHANNEL_TYPES = new Set(['broadcast', 'channel', 'public_channel'])
const GROUP_TYPES = new Set(['group', 'megagroup', 'public_group', 'supergroup'])
const CHAT_QUERY_FIELDS = new Set(['cursor', 'kind', 'pageSize', 'query', 'sourceScope'])
const HISTORY_QUERY_FIELDS = new Set(['cursor', 'pageSize', 'sourceScope'])
const SEARCH_FIELDS = new Set(['chatId', 'cursor', 'kind', 'pageSize', 'query', 'sourceScope'])
const CONTEXT_FIELDS = new Set(['after', 'before', 'sourceScope'])
const ADMIN_PROVINCE_FIELDS = new Set(['cursor', 'from', 'pageSize', 'sort', 'to'])
const ADMIN_COVERAGE_FIELDS = new Set(['from', 'targetPerProvince', 'to'])
const ADMIN_DETAIL_FIELDS = new Set()
const ADMIN_FUNNEL_FIELDS = new Set(['from', 'to'])
const ADMIN_BROWSE_FIELDS = new Set([
  'cursor', 'from', 'heat', 'pageSize', 'province', 'query', 'reason', 'scope',
  'stage', 'status', 'time', 'to',
])
const ADMIN_BROWSE_DETAIL_FIELDS = new Set(['from', 'to'])
const BROWSE_REASONS = new Set([
  'all', 'coverage_visible', 'hot_visible', 'missing_publication_state',
  'not_formal_stage', 'not_formal_status', 'missing_event_time', 'outside_window',
  'missing_province', 'missing_heat',
])
const BROWSE_STAGES = new Set(['all', 'formal', 'candidate', 'missing'])
const BROWSE_STATUSES = new Set([
  'all', 'formal', 'pending', 'qualified', 'rejected', 'failed', 'missing',
])
const BROWSE_SCOPES = new Set([
  'all', 'missing', 'national', 'nationwide', 'province', 'multi_province',
  'city', 'maritime', 'overseas', 'unknown',
])
const BROWSE_TIME_FILTERS = new Set(['all', 'within', 'outside', 'missing'])
const BROWSE_HEAT_FILTERS = new Set(['all', 'present', 'missing'])
const DEMO_NOW_MS = Date.now()

export const ADMIN_TELEGRAM_SOURCE_SCOPE = Object.freeze({
  mode: 'internal-mixed',
  datasets: Object.freeze([
    'telegram.monitor.chats.v1',
    'telegram.monitor.messages.v1',
    'telegram.sqlite.chats.v1',
    'telegram.sqlite.messages.v1',
  ]),
})

const TELEGRAM_DATASETS = Object.freeze({
  monitor: Object.freeze({
    chats: 'telegram.monitor.chats.v1',
    messages: 'telegram.monitor.messages.v1',
  }),
  sqlite: Object.freeze({
    chats: 'telegram.sqlite.chats.v1',
    messages: 'telegram.sqlite.messages.v1',
  }),
})

export const ADMIN_PUBLIC_OPINION_SOURCE_SCOPE = Object.freeze({
  mode: 'canonical',
  datasets: Object.freeze(['public-opinion.province.v1']),
})

function unsupportedFields(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', `${label} must be an object`)
  }
  const unsupported = Object.keys(input).filter((field) => !allowed.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported ${label} fields: ${unsupported.join(', ')}`)
  }
}

function requiredString(value, field, maxLength = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AppError(
      400,
      'invalid_request',
      `${field} must be a non-blank string of at most ${maxLength} characters`,
    )
  }
  return value.trim()
}

function optionalString(value, field, maxLength = 256) {
  return value == null ? null : requiredString(value, field, maxLength)
}

function pageSizeValue(value, fallback = 50) {
  if (value == null) return fallback
  if (!/^\d+$/.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > 100) {
    throw new AppError(400, 'page_size_exceeded', 'pageSize must be between 1 and 100')
  }
  return pageSize
}

function requiredUuid(value, field) {
  const id = requiredString(value, field, 64)
  if (!UUID_PATTERN.test(id)) {
    throw new AppError(400, 'invalid_request', `${field} must be a UUID`)
  }
  return id
}

function sourceScope(scope, selected = null) {
  return { mode: scope.mode, datasets: [...scope.datasets], ...(selected ? { selected } : {}) }
}

export function adminTelegramSourceScopeForDataset(datasetId) {
  if (datasetId === TELEGRAM_DATASETS.monitor.chats || datasetId === TELEGRAM_DATASETS.monitor.messages) {
    return 'monitor'
  }
  if (datasetId === TELEGRAM_DATASETS.sqlite.chats || datasetId === TELEGRAM_DATASETS.sqlite.messages) {
    return 'sqlite'
  }
  return null
}

function telegramSourceScopeValue(value) {
  const normalized = value == null ? 'all' : requiredString(value, 'sourceScope', 16).toLowerCase()
  if (!TELEGRAM_SOURCE_SCOPES.has(normalized)) {
    throw new AppError(400, 'invalid_request', 'sourceScope must be all, monitor, or sqlite')
  }
  return normalized
}

function ensureTelegramSelectorScope(chatId, selectedScope) {
  const qualified = /^(monitor|sqlite):/i.exec(chatId)
  if (qualified && selectedScope !== 'all' && qualified[1].toLowerCase() !== selectedScope) {
    throw new AppError(400, 'source_scope_mismatch', 'chatKey source does not match sourceScope')
  }
}

function enumValue(value, field, allowed, fallback = 'all') {
  if (value == null || value === '') return fallback
  const normalized = requiredString(value, field, 64).toLowerCase()
  if (!allowed.has(normalized)) {
    throw new AppError(400, 'invalid_request', `${field} is not supported`)
  }
  return normalized
}

function browseWindow(input, now) {
  const normalized = normalizeAdminPublicOpinionCoverageQuery({
    ...(input.from == null ? {} : { from: input.from }),
    ...(input.to == null ? {} : { to: input.to }),
  }, now)
  return { from: normalized.from, to: normalized.to }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString()
}

function boundedPublicText(value, maxLength) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : null
}

function safeBusinessUrl(value) {
  const bounded = boundedPublicText(value, 2_048)
  if (!bounded) return null
  try {
    const parsed = new URL(bounded)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(?:auth|credential|key|password|secret|signature|token)/i.test(key)) {
        parsed.searchParams.delete(key)
      }
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function safeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
      .slice(0, 100)
      .map((item) => item.trim().slice(0, 128))
    : []
}

function rawTelegramChatType(row) {
  return boundedPublicText(
    row?.stable_fields?.attributes?.chatType ?? row?.content_type,
    64,
  )?.toLowerCase() ?? null
}

export function adminTelegramChatKind(row) {
  const type = rawTelegramChatType(row)
  if (CHANNEL_TYPES.has(type)) return 'channel'
  if (GROUP_TYPES.has(type)) return 'group'
  return 'unknown'
}

function telegramUsername(row) {
  return boundedPublicText(row?.stable_fields?.attributes?.username, 128)
}

export function publicTelegramHandleUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'https:' || !['t.me', 'www.t.me'].includes(parsed.hostname.toLowerCase())) {
      return null
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length !== 1 || !/^[A-Za-z0-9_]{1,64}$/.test(segments[0])) return null
    if (segments[0].toLowerCase() === 'joinchat') return null
    return `https://t.me/${segments[0]}`
  } catch {
    return null
  }
}

export function adminTelegramChat(row) {
  const username = telegramUsername(row)
  const memberCount = row?.stable_fields?.metrics?.members
    ?? row?.stable_fields?.attributes?.memberCount
  const sourceDataset = boundedPublicText(row.dataset_id, 128)
  const itemSourceScope = adminTelegramSourceScopeForDataset(sourceDataset)
  const rawKind = rawTelegramChatType(row)
  const rawUrl = boundedPublicText(row.url, 2_048)
  const handleUrl = publicTelegramHandleUrl(rawUrl)
  const telegramInvite = rawUrl != null && /^https:\/\/(www[.])?t[.]me\/(?:\+|joinchat\/)/i.test(rawUrl)
  return {
    canonicalId: row.id,
    chatKey: itemSourceScope ? `${itemSourceScope}:${row.id}` : String(row.id),
    externalId: String(row.external_id),
    sourceDataset,
    sourceScope: itemSourceScope,
    kind: adminTelegramChatKind(row),
    rawKind,
    title: boundedPublicText(row.title, 500),
    username,
    url: rawUrl,
    visibilityEvidence: {
      hasUsername: username !== null,
      urlKind: handleUrl ? 'public-handle' : telegramInvite ? 'invite-link' : rawUrl ? 'other' : 'none',
      publicHandleUrl: handleUrl,
    },
    memberCount: typeof memberCount === 'number' && Number.isFinite(memberCount)
      ? memberCount
      : null,
    eventTime: iso(row.event_time),
    collectedAt: iso(row.collected_at),
  }
}

export function adminTelegramMessage(row) {
  const item = publicTelegramMonitorRecord(row)
  const sourceDataset = boundedPublicText(row.dataset_id, 128)
  return {
    canonicalId: row.id,
    sourceDataset,
    sourceScope: adminTelegramSourceScopeForDataset(sourceDataset),
    externalId: item.externalId,
    objectType: item.objectType,
    contentType: item.contentType,
    title: item.title,
    text: item.text,
    url: item.url,
    author: item.author,
    relations: item.relations,
    attributes: item.attributes,
    metrics: item.metrics,
    media: item.media,
    entities: item.entities,
    eventTime: item.eventTime,
    collectedAt: item.collectedAt,
    editedAt: item.editedAt,
    dataVersion: item.dataVersion,
  }
}

function pageInfo(rows, pageSize) {
  const hasMore = rows.length > pageSize
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows
  const last = pageRows.at(-1)
  return {
    pageRows,
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeTelegramCursor({ sortTime: last.sort_time, id: last.id })
        : null,
    },
  }
}

export function normalizeAdminTelegramChatsQuery(input = {}) {
  unsupportedFields(input, CHAT_QUERY_FIELDS, 'Telegram chat query')
  const kind = input.kind == null ? 'all' : requiredString(input.kind, 'kind', 16).toLowerCase()
  if (!CHAT_KINDS.has(kind)) {
    throw new AppError(400, 'invalid_request', 'kind must be all, channel, group, or unknown')
  }
  return {
    kind,
    sourceScope: telegramSourceScopeValue(input.sourceScope),
    query: optionalString(input.query, 'query', 200),
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
  }
}

export function normalizeAdminTelegramHistoryQuery(chatIdInput, input = {}) {
  unsupportedFields(input, HISTORY_QUERY_FIELDS, 'Telegram history query')
  const chatId = requiredString(chatIdInput, 'chatId')
  const selectedScope = telegramSourceScopeValue(input.sourceScope)
  ensureTelegramSelectorScope(chatId, selectedScope)
  return {
    chatId,
    sourceScope: selectedScope,
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
  }
}

export function normalizeAdminTelegramSearchQuery(input = {}) {
  unsupportedFields(input, SEARCH_FIELDS, 'Telegram search')
  const chatId = optionalString(input.chatId, 'chatId')
  const kind = input.kind == null ? 'all' : requiredString(input.kind, 'kind', 16).toLowerCase()
  if (!CHAT_KINDS.has(kind)) {
    throw new AppError(400, 'invalid_request', 'kind must be all, channel, group, or unknown')
  }
  const selectedScope = telegramSourceScopeValue(input.sourceScope)
  if (chatId) ensureTelegramSelectorScope(chatId, selectedScope)
  return {
    query: requiredString(input.query, 'query', 500),
    chatId,
    kind,
    sourceScope: selectedScope,
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
  }
}

export function normalizeAdminTelegramContextQuery(idInput, input = {}) {
  unsupportedFields(input, CONTEXT_FIELDS, 'Telegram context query')
  return {
    id: requiredUuid(idInput, 'id'),
    sourceScope: telegramSourceScopeValue(input.sourceScope),
    ...normalizeCanonicalContextQuery({ before: input.before, after: input.after }),
  }
}

export function adminTelegramChatsResponse(rows, query, { demoMode = false } = {}) {
  const safeRows = rows.filter((row) => query.kind === 'all' || adminTelegramChatKind(row) === query.kind)
  const page = pageInfo(safeRows, query.pageSize)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-chats.v2',
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE, query.sourceScope),
    kind: query.kind,
    query: query.query,
    items: page.pageRows.map(adminTelegramChat),
    pageInfo: page.pageInfo,
    demoMode,
  }
}

export function adminTelegramMessagesResponse(chatRow, rows, query, { demoMode = false } = {}) {
  const chat = adminTelegramChat(chatRow)
  if (!chat) throw new AppError(404, 'chat_not_found', 'Telegram chat not found')
  const page = pageInfo(rows, query.pageSize)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-messages.v2',
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE, query.sourceScope),
    chat,
    items: page.pageRows.map(adminTelegramMessage),
    pageInfo: page.pageInfo,
    demoMode,
  }
}

export function adminTelegramSearchResponse(rows, query, { demoMode = false } = {}) {
  const page = pageInfo(rows, query.pageSize)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-search.v2',
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE, query.sourceScope),
    query: query.query,
    chatId: query.chatId,
    kind: query.kind,
    items: page.pageRows.map((row) => ({
      ...adminTelegramMessage(row),
      score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null,
    })),
    pageInfo: page.pageInfo,
    searchMode: 'postgres-substring',
    warnings: [],
    demoMode,
  }
}

export function adminTelegramContextResponse(query, result, { demoMode = false } = {}) {
  const response = canonicalContextResponse({ query, result })
  return {
    ...response,
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-context.v2',
    items: response.items.map((item) => ({
      ...item,
      sourceDataset: item.datasetId,
      sourceScope: adminTelegramSourceScopeForDataset(item.datasetId),
    })),
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE, query.sourceScope),
    demoMode,
  }
}

export function normalizeAdminPublicOpinionRegionsQuery(input = {}) {
  return normalizePublicOpinionRegionsQuery(input)
}

export function normalizeAdminPublicOpinionCoverageQuery(input = {}, now = new Date()) {
  unsupportedFields(input, ADMIN_COVERAGE_FIELDS, 'public-opinion coverage')
  const hasFrom = input.from != null
  const hasTo = input.to != null
  if (hasFrom !== hasTo) {
    throw new AppError(400, 'invalid_request', 'from and to must be supplied together')
  }
  const to = hasTo ? input.to : now.toISOString()
  const from = hasFrom
    ? input.from
    : new Date(new Date(to).getTime() - 30 * 86_400_000).toISOString()
  return normalizePublicOpinionCoverageQuery({
    from,
    to,
    targetPerProvince: input.targetPerProvince,
  })
}

export function normalizeAdminPublicOpinionProvinceQuery(
  provinceInput,
  input = {},
  cursorSecret,
) {
  unsupportedFields(input, ADMIN_PROVINCE_FIELDS, 'public-opinion province')
  return normalizePublicOpinionQuery(provinceInput, input, 100, cursorSecret)
}

export function normalizeAdminPublicOpinionItemQuery(idInput, input = {}) {
  unsupportedFields(input, ADMIN_DETAIL_FIELDS, 'public-opinion item')
  return normalizePublicOpinionItemId(idInput)
}

export function normalizeAdminPublicOpinionFunnelQuery(input = {}, now = new Date()) {
  unsupportedFields(input, ADMIN_FUNNEL_FIELDS, 'public-opinion funnel')
  return browseWindow(input, now)
}

export function normalizeAdminPublicOpinionBrowseQuery(input = {}, now = new Date()) {
  unsupportedFields(input, ADMIN_BROWSE_FIELDS, 'public-opinion browse')
  const rawProvince = input.province == null ? 'all' : String(input.province).trim().toUpperCase()
  if (!['all', 'missing'].includes(rawProvince.toLowerCase()) && !/^CN-[A-Z]{2}$/.test(rawProvince)) {
    throw new AppError(400, 'invalid_request', 'province must be all, missing or an ISO 3166-2:CN code')
  }
  return {
    ...browseWindow(input, now),
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
    query: optionalString(input.query, 'query', 500),
    reason: enumValue(input.reason, 'reason', BROWSE_REASONS),
    stage: enumValue(input.stage, 'stage', BROWSE_STAGES),
    status: enumValue(input.status, 'status', BROWSE_STATUSES),
    province: /^CN-[A-Z]{2}$/.test(rawProvince) ? rawProvince : rawProvince.toLowerCase(),
    scope: enumValue(input.scope, 'scope', BROWSE_SCOPES),
    time: enumValue(input.time, 'time', BROWSE_TIME_FILTERS),
    heat: enumValue(input.heat, 'heat', BROWSE_HEAT_FILTERS),
  }
}

export function normalizeAdminPublicOpinionBrowseItemQuery(idInput, input = {}, now = new Date()) {
  unsupportedFields(input, ADMIN_BROWSE_DETAIL_FIELDS, 'public-opinion browse item')
  return { id: requiredUuid(idInput, 'id'), ...browseWindow(input, now) }
}

function numericCount(value) {
  return Number(value || 0)
}

function countObject(value, required = []) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries([
    ...required.map((key) => [key, numericCount(source[key])]),
    ...Object.entries(source)
      .filter(([key]) => !required.includes(key))
      .map(([key, count]) => [key, numericCount(count)]),
  ])
}

export function adminPublicOpinionFunnelResponse(row = {}, query, { demoMode = false } = {}) {
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.public-opinion-funnel.v1',
    sourceScope: sourceScope(ADMIN_PUBLIC_OPINION_SOURCE_SCOPE),
    window: { from: query.from, to: query.to },
    canonical: {
      total: numericCount(row.canonical_total),
      active: numericCount(row.active_count),
      deleted: numericCount(row.deleted_count),
    },
    publication: {
      withState: numericCount(row.with_publication_state_count),
      missingState: numericCount(row.missing_publication_state_count),
      stages: countObject(row.stage_counts, ['formal', 'candidate', 'unknown']),
      statuses: countObject(row.status_counts, [
        'formal', 'pending', 'qualified', 'rejected', 'failed', 'unknown',
      ]),
    },
    time: {
      withEventTime: numericCount(row.with_event_time_count),
      missingEventTime: numericCount(row.missing_event_time_count),
      withinWindow: numericCount(row.within_window_count),
      outsideWindow: numericCount(row.outside_window_count),
    },
    geography: {
      withProvince: numericCount(row.with_province_count),
      withoutProvince: numericCount(row.without_province_count),
      scopes: countObject(row.scope_counts, [
        'national', 'nationwide', 'province', 'multi_province', 'city', 'maritime',
        'overseas', 'unknown',
      ]),
    },
    heat: {
      withScore: numericCount(row.with_heat_score_count),
      missingScore: numericCount(row.missing_heat_score_count),
    },
    visibility: {
      coverageVisible: numericCount(row.coverage_visible_count),
      hotVisible: numericCount(row.hot_visible_count),
    },
    reasons: {
      missingPublicationState: numericCount(row.missing_publication_state_count),
      notFormalStage: numericCount(row.not_formal_stage_count),
      notFormalStatus: numericCount(row.not_formal_status_count),
      missingEventTime: numericCount(row.missing_event_time_count),
      outsideWindow: numericCount(row.outside_window_count),
      missingProvince: numericCount(row.without_province_count),
      missingHeat: numericCount(row.missing_heat_score_count),
    },
    demoMode,
  }
}

function browseDiagnostics(row, query) {
  const hasPublicationState = row.has_publication_state !== false
    && row.has_publication_state !== 'false'
    && row.publication_record_id !== null
  const sourceStage = row.source_stage ?? null
  const publicationStatus = row.quality_status ?? row.publication_status ?? null
  const eventTime = iso(row.event_time)
  const provinceCode = row.admin1_code ?? row.display_admin1_code ?? null
  const heatScore = row.heat_score == null ? null : Number(row.heat_score)
  const withinWindow = eventTime !== null && eventTime >= query.from && eventTime <= query.to
  const coverageVisible = hasPublicationState
    && sourceStage === 'formal'
    && publicationStatus === 'formal'
    && withinWindow
    && provinceCode !== null
  const hotVisible = coverageVisible && heatScore !== null && Number.isFinite(heatScore)
  const reasons = []
  if (!hasPublicationState) reasons.push('missing_publication_state')
  if (hasPublicationState && sourceStage !== 'formal') reasons.push('not_formal_stage')
  if (hasPublicationState && publicationStatus !== 'formal') reasons.push('not_formal_status')
  if (!eventTime) reasons.push('missing_event_time')
  else if (!withinWindow) reasons.push('outside_window')
  if (!provinceCode) reasons.push('missing_province')
  if (heatScore === null || !Number.isFinite(heatScore)) reasons.push('missing_heat')
  return { hasPublicationState, coverageVisible, hotVisible, reasons }
}

export function adminPublicOpinionBrowseItem(row, query) {
  const stableAttributes = row?.stable_fields?.attributes
  const sourceStage = row.source_stage ?? null
  const publicationStatus = row.quality_status ?? row.publication_status ?? null
  const heatScore = row.heat_score == null ? null : Number(row.heat_score)
  return {
    id: row.id,
    title: boundedPublicText(row.title, 1_000),
    summary: boundedPublicText(row.body, 8_000),
    url: safeBusinessUrl(row.url),
    contentType: boundedPublicText(row.content_type, 128),
    authorName: boundedPublicText(row.author_name, 500),
    eventTime: iso(row.event_time),
    collectedAt: iso(row.collected_at),
    heatScore: Number.isFinite(heatScore) ? heatScore : null,
    sourceStage,
    publicationStatus,
    qualityScore: row.quality_score == null ? null : Number(row.quality_score),
    qualificationThreshold: row.qualification_threshold == null
      ? null
      : Number(row.qualification_threshold),
    provinceCode: row.admin1_code ?? row.display_admin1_code ?? null,
    geography: {
      verified: row.geography_verified === true,
      scope: row.geo_scope ?? null,
      countryCode: row.country_code ?? null,
      countryName: boundedPublicText(row.country_name, 120),
      locationLabel: boundedPublicText(row.location_label, 160),
      locationType: row.location_type ?? null,
    },
    source: {
      type: boundedPublicText(row.source_type ?? stableAttributes?.sourceType, 128),
      platform: boundedPublicText(row.source_platform ?? stableAttributes?.sourcePlatform, 128),
    },
    qualityFlags: safeStringArray(row.quality_flags),
    rejectionCodes: safeStringArray(row.rejection_codes),
    diagnostics: browseDiagnostics(row, query),
  }
}

export function adminPublicOpinionBrowseResponse(rows, query, { demoMode = false } = {}) {
  const hasMore = rows.length > query.pageSize
  const pageRows = hasMore ? rows.slice(0, query.pageSize) : rows
  const last = pageRows.at(-1)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.public-opinion-records.v1',
    sourceScope: sourceScope(ADMIN_PUBLIC_OPINION_SOURCE_SCOPE),
    window: { from: query.from, to: query.to },
    filters: {
      query: query.query, reason: query.reason, stage: query.stage, status: query.status,
      province: query.province, scope: query.scope, time: query.time, heat: query.heat,
    },
    items: pageRows.map((row) => adminPublicOpinionBrowseItem(row, query)),
    pageInfo: {
      returnedCount: pageRows.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeTelegramCursor({ sortTime: last.sort_time, id: last.id })
        : null,
    },
    demoMode,
  }
}

export function adminPublicOpinionBrowseItemResponse(row, query, { demoMode = false } = {}) {
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.public-opinion-record.v1',
    sourceScope: sourceScope(ADMIN_PUBLIC_OPINION_SOURCE_SCOPE),
    window: { from: query.from, to: query.to },
    ...adminPublicOpinionBrowseItem(row, query),
    demoMode,
  }
}

function publicOpinionMeta(response, demoMode) {
  return {
    ...response,
    sourceScope: sourceScope(ADMIN_PUBLIC_OPINION_SOURCE_SCOPE),
    demoMode,
  }
}

export function adminPublicOpinionRegionsResponse(query, { demoMode = false } = {}) {
  return publicOpinionMeta(publicOpinionRegions(query), demoMode)
}

export function adminPublicOpinionCoverageResponse(rows, query, { demoMode = false } = {}) {
  return publicOpinionMeta(publicOpinionCoverage(rows, query), demoMode)
}

export function adminPublicOpinionProvinceResponse(
  rows,
  query,
  cursorSecret,
  { demoMode = false } = {},
) {
  return publicOpinionMeta(publicOpinionPage(rows, query, cursorSecret), demoMode)
}

export function adminPublicOpinionItemResponse(row, { demoMode = false } = {}) {
  return publicOpinionMeta(publicOpinionItem(row), demoMode)
}

function demoDate(daysAgo, minute = 0) {
  return new Date(DEMO_NOW_MS - daysAgo * 86_400_000 + minute * 60_000)
}

const DEMO_TELEGRAM_CHATS = Object.freeze([
  {
    id: '10000000-0000-4000-8000-000000000001',
    dataset_id: 'telegram.monitor.chats.v1', external_id: '-1001001', object_type: 'chat',
    content_type: 'channel', title: '全球科技观察', url: 'https://t.me/mx_global_tech',
    event_time: demoDate(30), collected_at: demoDate(0),
    stable_fields: { attributes: { username: 'mx_global_tech', chatType: 'channel' }, metrics: { members: 18240 } },
    sort_time: demoDate(30), current_revision: 3,
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    dataset_id: 'telegram.monitor.chats.v1', external_id: '-1001002', object_type: 'chat',
    content_type: 'broadcast', title: '区域新闻速递', url: null,
    event_time: demoDate(20), collected_at: demoDate(0, -2),
    stable_fields: { attributes: { username: 'mx_region_news', chatType: 'broadcast' }, metrics: { members: 9640 } },
    sort_time: demoDate(20), current_revision: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    dataset_id: 'telegram.monitor.chats.v1', external_id: '-1002001', object_type: 'chat',
    content_type: 'supergroup', title: '公开数据交流组', url: 'https://t.me/mx_open_data_group',
    event_time: demoDate(15), collected_at: demoDate(0, -4),
    stable_fields: { attributes: { username: 'mx_open_data_group', chatType: 'supergroup' }, metrics: { members: 3270 } },
    sort_time: demoDate(15), current_revision: 4,
  },
  // These records exercise the internal unknown/invite evidence projection.
  {
    id: '10000000-0000-4000-8000-000000000004',
    dataset_id: 'telegram.monitor.chats.v1', external_id: '-1002998', object_type: 'chat',
    content_type: 'group', title: '邀请链接群组', url: 'https://t.me/+privateInvite',
    event_time: demoDate(10), collected_at: demoDate(0, -6),
    stable_fields: { attributes: { chatType: 'group' }, secret: 'demo-private' },
    sort_time: demoDate(10), current_revision: 1,
  },
  {
    id: '10000000-0000-4000-8000-000000000005',
    dataset_id: 'telegram.monitor.chats.v1', external_id: '-1002999', object_type: 'chat',
    content_type: 'private', title: '未知私有会话', url: null,
    event_time: demoDate(8), collected_at: demoDate(0, -8),
    stable_fields: { attributes: { chatType: 'private' }, password: 'demo-private' },
    sort_time: demoDate(8), current_revision: 1,
  },
  {
    id: '10000000-0000-4000-8000-000000000006',
    dataset_id: 'telegram.monitor.chats.v1', external_id: '-1003001', object_type: 'chat',
    content_type: 'channel', title: 'Monitor 同号频道', url: null,
    event_time: demoDate(6), collected_at: demoDate(0, -9),
    stable_fields: { attributes: { chatType: 'channel' } },
    sort_time: demoDate(6), current_revision: 1,
  },
  {
    id: '10000000-0000-4000-8000-000000000101',
    dataset_id: 'telegram.sqlite.chats.v1', external_id: '-1001001', object_type: 'chat',
    content_type: 'channel', title: '全球科技观察（SQLite）', url: 'https://t.me/mx_global_tech',
    event_time: demoDate(29), collected_at: demoDate(0, -10),
    stable_fields: { attributes: { username: 'mx_global_tech', chatType: 'channel' }, metrics: { members: 18260 } },
    sort_time: demoDate(29), current_revision: 2,
  },
  {
    id: '10000000-0000-4000-8000-000000000102',
    dataset_id: 'telegram.sqlite.chats.v1', external_id: '-1003001', object_type: 'chat',
    content_type: 'private', title: '待判定会话（SQLite）', url: null,
    event_time: demoDate(7), collected_at: demoDate(0, -12),
    stable_fields: { attributes: { chatType: 'private' }, connection: { token: 'must-not-leak' } },
    sort_time: demoDate(7), current_revision: 1,
  },
])

function demoMessage(id, chatId, messageId, text, daysAgo, overrides = {}) {
  const eventTime = demoDate(daysAgo, Number(messageId))
  return {
    id,
    dataset_id: 'telegram.monitor.messages.v1',
    external_id: `${chatId}:${messageId}`,
    object_type: 'message', content_type: 'text', title: null, body: text,
    url: `https://t.me/c/${chatId.replace(/^-100/, '')}/${messageId}`,
    author_external_id: `demo-user-${messageId}`,
    author_name: Number(messageId) % 2 ? '观察员 A' : '观察员 B',
    event_time: eventTime, collected_at: new Date(eventTime.getTime() + 60_000),
    stable_fields: {
      relations: { chatId, messageId: String(messageId) },
      attributes: { username: Number(messageId) % 2 ? 'observer_a' : 'observer_b' },
      metrics: { views: 120 + Number(messageId), shares: Number(messageId) % 4 },
      source: { origin: 'database', credential: 'must-not-leak' },
    },
    sort_time: eventTime,
    current_revision: 1,
    score: 1,
    ...overrides,
  }
}

const DEMO_TELEGRAM_MESSAGES = Object.freeze([
  demoMessage('20000000-0000-4000-8000-000000000001', '-1001001', 1, '今日公开频道发布人工智能产业观察。', 3),
  demoMessage('20000000-0000-4000-8000-000000000002', '-1001001', 2, '相关报道补充了芯片供应链数据。', 2),
  demoMessage('20000000-0000-4000-8000-000000000003', '-1001001', 3, '讨论继续：请核验公开来源与发布时间。', 1),
  demoMessage('20000000-0000-4000-8000-000000000004', '-1001002', 4, '江苏区域新闻公开摘要已更新。', 2),
  demoMessage('20000000-0000-4000-8000-000000000005', '-1002001', 5, '公开群组分享了数据治理资料。', 2),
  demoMessage('20000000-0000-4000-8000-000000000006', '-1002001', 6, '群组成员讨论数据清洗与归档规则。', 1),
  demoMessage('20000000-0000-4000-8000-000000000007', '-1002998', 7, '该消息属于邀请群组，供内部业务展示。', 1, {
    stable_fields: { relations: { chatId: '-1002998', messageId: '7' }, password: 'must-not-leak' },
  }),
  demoMessage('20000000-0000-4000-8000-000000000101', '-1001001', 101, 'SQLite 采集的频道历史消息，包含开房归档索引。', 4, {
    dataset_id: 'telegram.sqlite.messages.v1',
  }),
  demoMessage('20000000-0000-4000-8000-000000000102', '-1003001', 102, '无法判定类型的 SQLite 会话消息。', 1, {
    dataset_id: 'telegram.sqlite.messages.v1',
    stable_fields: {
      relations: { chatId: '-1003001', messageId: '102' },
      source: { credential: 'must-not-leak' },
    },
  }),
])

function tupleBefore(row, cursor) {
  if (!cursor) return true
  const rowTime = iso(row.sort_time)
  return rowTime < cursor.sortTime || (rowTime === cursor.sortTime && row.id < cursor.id)
}

function demoMatchesSourceScope(row, selectedScope) {
  return selectedScope === 'all' || adminTelegramSourceScopeForDataset(row.dataset_id) === selectedScope
}

function demoChatById(chatId, selectedScope = 'all') {
  const qualified = /^(monitor|sqlite):([0-9a-f-]{36})$/i.exec(chatId)
  const selector = qualified?.[2] ?? chatId
  const selectorScope = qualified?.[1]?.toLowerCase() ?? selectedScope
  return DEMO_TELEGRAM_CHATS.find((row) => (
    demoMatchesSourceScope(row, selectorScope)
    && (row.id === selector
      || String(row.external_id) === selector
      || telegramUsername(row) === selector.replace(/^@/, ''))
  )) ?? null
}

export function demoAdminTelegramChats(query) {
  const needle = query.query?.toLocaleLowerCase('zh-CN') ?? null
  return DEMO_TELEGRAM_CHATS
    .filter((row) => demoMatchesSourceScope(row, query.sourceScope))
    .filter((row) => query.kind === 'all' || adminTelegramChatKind(row) === query.kind)
    .filter((row) => !needle || [row.title, telegramUsername(row)]
      .some((value) => value?.toLocaleLowerCase('zh-CN').includes(needle)))
    .filter((row) => tupleBefore(row, query.cursor))
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
    .slice(0, query.pageSize + 1)
}

export function demoAdminTelegramMessages(query) {
  const chat = demoChatById(query.chatId, query.sourceScope)
  if (!chat) return { chat: null, rows: [] }
  const rows = DEMO_TELEGRAM_MESSAGES
    .filter((row) => demoMatchesSourceScope(row, query.sourceScope))
    .filter((row) => row.stable_fields?.relations?.chatId === String(chat.external_id))
    .filter((row) => tupleBefore(row, query.cursor))
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
    .slice(0, query.pageSize + 1)
  return { chat, rows }
}

export function demoAdminTelegramSearch(query) {
  const chat = query.chatId ? demoChatById(query.chatId, query.sourceScope) : null
  if (query.chatId && !chat) return { chat: null, rows: [] }
  const needle = query.query.toLocaleLowerCase('zh-CN')
  const rows = DEMO_TELEGRAM_MESSAGES
    .filter((row) => demoMatchesSourceScope(row, query.sourceScope))
    .filter((row) => !chat || row.stable_fields?.relations?.chatId === String(chat.external_id))
    .filter((row) => {
      if (chat || query.kind === 'all') return true
      const rowScope = adminTelegramSourceScopeForDataset(row.dataset_id)
      const rowChat = DEMO_TELEGRAM_CHATS.find((candidate) => (
        adminTelegramSourceScopeForDataset(candidate.dataset_id) === rowScope
        && String(candidate.external_id) === row.stable_fields?.relations?.chatId
      ))
      return rowChat != null && adminTelegramChatKind(rowChat) === query.kind
    })
    .filter((row) => [row.title, row.body, row.author_name]
      .some((value) => value?.toLocaleLowerCase('zh-CN').includes(needle)))
    .filter((row) => tupleBefore(row, query.cursor))
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
    .slice(0, query.pageSize + 1)
  return { chat, rows }
}

export function demoAdminTelegramContext(query) {
  const current = DEMO_TELEGRAM_MESSAGES.find((row) => (
    row.id === query.id && demoMatchesSourceScope(row, query.sourceScope)
  )) ?? null
  if (!current) return null
  const chatId = current.stable_fields?.relations?.chatId
  const stream = DEMO_TELEGRAM_MESSAGES
    .filter((row) => row.dataset_id === current.dataset_id)
    .filter((row) => row.stable_fields?.relations?.chatId === chatId)
    .sort((left, right) => iso(left.event_time).localeCompare(iso(right.event_time)) || left.id.localeCompare(right.id))
  const index = stream.findIndex((row) => row.id === query.id)
  return {
    current: { ...current, context_id: chatId },
    before: stream.slice(Math.max(0, index - query.before), index).map((row) => ({ ...row, context_id: chatId })),
    after: stream.slice(index + 1, index + 1 + query.after).map((row) => ({ ...row, context_id: chatId })),
    hasMoreStoredBefore: index > query.before,
    hasMoreStoredAfter: stream.length - index - 1 > query.after,
    contextSupported: true,
  }
}

function demoOpinionRow({
  id, provinceCode, title, summary, heatScore, daysAgo, stage = 'formal',
  status = stage === 'formal' ? 'formal' : 'pending', hasPublicationState = true,
  geoScope = provinceCode ? 'province' : 'unknown',
}) {
  const eventTime = daysAgo == null ? null : demoDate(daysAgo)
  const collectedAt = eventTime
    ? new Date(eventTime.getTime() + 120_000)
    : demoDate(0, -20)
  return {
    id, title, body: summary, url: `https://example.invalid/public-opinion/${id}`,
    content_type: 'news', author_name: stage === 'formal' ? '公开新闻来源' : '候选采集源',
    event_time: eventTime, collected_at: collectedAt,
    admin1_code: provinceCode, heat_score: heatScore == null ? null : String(heatScore),
    stable_fields: { attributes: { sourceType: 'news', sourcePlatform: 'public-web' } },
    source_stage: hasPublicationState ? stage : null,
    quality_status: hasPublicationState ? status : null,
    quality_score: stage === 'formal' ? null : 72,
    qualification_threshold: stage === 'formal' ? null : 80,
    geography_verified: stage === 'formal',
    geo_scope: geoScope,
    country_code: provinceCode ? 'CN' : null,
    has_publication_state: hasPublicationState,
    publication_record_id: hasPublicationState ? id : null,
    quality_flags: stage === 'candidate' ? ['awaiting_review'] : [],
    rejection_codes: status === 'rejected' ? ['geography_unverified'] : [],
    sort_time: eventTime ?? collectedAt,
  }
}

const DEMO_PUBLIC_OPINION_ROWS = Object.freeze([
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000001', provinceCode: 'CN-JS',
    title: '江苏发布公共数据开放新进展', summary: '公开信息显示，江苏持续完善公共数据目录与授权运营机制。',
    heatScore: 92.4, daysAgo: 1,
  }),
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000002', provinceCode: 'CN-JS',
    title: '南京推进重点项目服务保障', summary: '南京公开通报重点项目服务保障与营商环境相关进展。',
    heatScore: 86.2, daysAgo: 2,
  }),
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000003', provinceCode: 'CN-JS',
    title: '苏州公布产业创新合作动态', summary: '苏州公开发布产业创新合作与人才服务动态。',
    heatScore: 78.8, daysAgo: 3,
  }),
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000004', provinceCode: 'CN-GD',
    title: '广东候选数据（不对外）', summary: '仅用于验证候选记录不会进入 Admin 对外展示。',
    heatScore: 70, daysAgo: 1, stage: 'candidate',
  }),
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000005', provinceCode: null,
    title: '候选记录尚未完成省份归属', summary: '该记录用于内部查看未归属省份与待审核原因。',
    heatScore: null, daysAgo: 2, stage: 'candidate', status: 'rejected', geoScope: 'unknown',
  }),
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000006', provinceCode: null,
    title: '当前版本缺少发布状态', summary: '该记录已进入 canonical，但当前 revision 尚无 publication state。',
    heatScore: null, daysAgo: 4, hasPublicationState: false, geoScope: 'unknown',
  }),
  demoOpinionRow({
    id: '30000000-0000-4000-8000-000000000007', provinceCode: 'CN-BJ',
    title: '缺少业务发布时间的候选记录', summary: '已采集但缺少 eventTime，因此不会进入时间窗覆盖。',
    heatScore: 66, daysAgo: null, stage: 'candidate',
  }),
])

function withinOpinionWindow(row, from, to) {
  const time = iso(row.event_time)
  return (!from || time >= from) && (!to || time <= to)
}

export function demoAdminPublicOpinionRows(query) {
  const formal = DEMO_PUBLIC_OPINION_ROWS
    .filter((row) => row.source_stage === 'formal')
    .filter((row) => row.admin1_code === query.province.code)
    .filter((row) => withinOpinionWindow(row, query.from, query.to))
    .sort((left, right) => query.sort === 'hot'
      ? Number(right.heat_score) - Number(left.heat_score) || right.id.localeCompare(left.id)
      : iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
  if (!query.cursor) return formal.slice(0, query.pageSize + 1)
  return formal.filter((row) => {
    if (query.sort === 'hot') {
      return Number(row.heat_score) < Number(query.cursor.heatScore)
        || (String(row.heat_score) === query.cursor.heatScore && row.id < query.cursor.id)
    }
    const rowTime = iso(row.sort_time)
    return rowTime < query.cursor.sortTime
      || (rowTime === query.cursor.sortTime && row.id < query.cursor.id)
  }).slice(0, query.pageSize + 1)
}

export function demoAdminPublicOpinionCoverageRows(query) {
  const counts = new Map()
  for (const row of DEMO_PUBLIC_OPINION_ROWS) {
    if (row.source_stage !== 'formal' || !withinOpinionWindow(row, query.from, query.to)) continue
    counts.set(row.admin1_code, (counts.get(row.admin1_code) || 0) + 1)
  }
  return [...counts].map(([provinceCode, count]) => ({
    province_code: provinceCode,
    formal_count: count,
    qualified_candidate_count: 0,
    candidate_count: 0,
    verified_count: count,
    average_quality_score: null,
  }))
}

export function demoAdminPublicOpinionItem(id) {
  return DEMO_PUBLIC_OPINION_ROWS.find((row) => row.id === id && row.source_stage === 'formal') ?? null
}

function demoBrowseRows(query) {
  const needle = query.query?.toLocaleLowerCase('zh-CN') ?? null
  return DEMO_PUBLIC_OPINION_ROWS
    .filter((row) => {
      const item = adminPublicOpinionBrowseItem(row, query)
      if (needle && ![
        item.title, item.summary, item.authorName, item.provinceCode,
        item.geography.locationLabel, item.geography.countryName,
        item.source.type, item.source.platform,
      ]
        .some((value) => value?.toLocaleLowerCase('zh-CN').includes(needle))) return false
      if (query.reason !== 'all' && query.reason === 'coverage_visible' && !item.diagnostics.coverageVisible) return false
      if (query.reason !== 'all' && query.reason === 'hot_visible' && !item.diagnostics.hotVisible) return false
      if (
        !['all', 'coverage_visible', 'hot_visible'].includes(query.reason)
        && !item.diagnostics.reasons.includes(query.reason)
      ) return false
      if (query.stage === 'missing' && item.sourceStage !== null) return false
      if (!['all', 'missing'].includes(query.stage) && item.sourceStage !== query.stage) return false
      if (query.status === 'missing' && item.publicationStatus !== null) return false
      if (!['all', 'missing'].includes(query.status) && item.publicationStatus !== query.status) return false
      if (query.province === 'missing' && item.provinceCode !== null) return false
      if (!['all', 'missing'].includes(query.province) && item.provinceCode !== query.province) return false
      if (query.scope === 'missing' && item.geography.scope !== null) return false
      if (!['all', 'missing'].includes(query.scope) && item.geography.scope !== query.scope) return false
      if (query.time === 'missing' && item.eventTime !== null) return false
      if (query.time === 'within' && (item.eventTime === null || item.eventTime < query.from || item.eventTime > query.to)) return false
      if (query.time === 'outside' && (item.eventTime === null || (item.eventTime >= query.from && item.eventTime <= query.to))) return false
      if (query.heat === 'missing' && item.heatScore !== null) return false
      if (query.heat === 'present' && item.heatScore === null) return false
      return tupleBefore(row, query.cursor)
    })
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
}

export function demoAdminPublicOpinionBrowseRows(query) {
  return demoBrowseRows(query).slice(0, query.pageSize + 1)
}

export function demoAdminPublicOpinionBrowseItem(id) {
  return DEMO_PUBLIC_OPINION_ROWS.find((row) => row.id === id) ?? null
}

export function demoAdminPublicOpinionFunnel(query) {
  const active = DEMO_PUBLIC_OPINION_ROWS
  const withState = active.filter((row) => row.has_publication_state !== false)
  const withEventTime = active.filter((row) => row.event_time != null)
  const withinWindow = withEventTime.filter((row) => withinOpinionWindow(row, query.from, query.to))
  const scopeCounts = {}
  for (const row of active) {
    const key = row.geo_scope ?? 'unknown'
    scopeCounts[key] = (scopeCounts[key] || 0) + 1
  }
  const countBy = (rows, field) => rows.reduce((counts, row) => {
    const key = row[field] ?? 'unknown'
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
  const diagnostics = active.map((row) => adminPublicOpinionBrowseItem(row, query).diagnostics)
  return {
    canonical_total: active.length,
    active_count: active.length,
    deleted_count: 0,
    with_publication_state_count: withState.length,
    missing_publication_state_count: active.length - withState.length,
    stage_counts: countBy(withState, 'source_stage'),
    status_counts: countBy(withState, 'quality_status'),
    with_event_time_count: withEventTime.length,
    missing_event_time_count: active.length - withEventTime.length,
    within_window_count: withinWindow.length,
    outside_window_count: withEventTime.length - withinWindow.length,
    with_province_count: active.filter((row) => row.admin1_code != null).length,
    without_province_count: active.filter((row) => row.admin1_code == null).length,
    scope_counts: scopeCounts,
    with_heat_score_count: active.filter((row) => row.heat_score != null).length,
    missing_heat_score_count: active.filter((row) => row.heat_score == null).length,
    coverage_visible_count: diagnostics.filter((value) => value.coverageVisible).length,
    hot_visible_count: diagnostics.filter((value) => value.hotVisible).length,
    not_formal_stage_count: withState.filter((row) => row.source_stage !== 'formal').length,
    not_formal_status_count: withState.filter((row) => row.quality_status !== 'formal').length,
  }
}
