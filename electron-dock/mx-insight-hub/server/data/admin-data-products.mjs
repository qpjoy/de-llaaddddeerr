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
const CHAT_KINDS = new Set(['channel', 'group'])
const CHANNEL_TYPES = new Set(['broadcast', 'channel', 'public_channel'])
const GROUP_TYPES = new Set(['group', 'megagroup', 'public_group', 'supergroup'])
const CHAT_QUERY_FIELDS = new Set(['cursor', 'kind', 'pageSize', 'query'])
const HISTORY_QUERY_FIELDS = new Set(['cursor', 'pageSize'])
const SEARCH_FIELDS = new Set(['chatId', 'cursor', 'pageSize', 'query'])
const ADMIN_PROVINCE_FIELDS = new Set(['cursor', 'from', 'pageSize', 'sort', 'to'])
const ADMIN_COVERAGE_FIELDS = new Set(['from', 'targetPerProvince', 'to'])
const ADMIN_DETAIL_FIELDS = new Set()
const DEMO_NOW_MS = Date.now()

export const ADMIN_TELEGRAM_SOURCE_SCOPE = Object.freeze({
  mode: 'monitor-only',
  datasets: Object.freeze([
    'telegram.monitor.chats.v1',
    'telegram.monitor.messages.v1',
  ]),
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

function sourceScope(scope) {
  return { mode: scope.mode, datasets: [...scope.datasets] }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString()
}

function boundedPublicText(value, maxLength) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : null
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
  return null
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

export function isPublicTelegramChat(row) {
  return adminTelegramChatKind(row) !== null
    && (telegramUsername(row) !== null || publicTelegramHandleUrl(row?.url) !== null)
}

function canonicalTelegramUrl(row, username) {
  const fromUrl = publicTelegramHandleUrl(row?.url)
  if (fromUrl) return fromUrl
  const handle = username?.replace(/^@/, '')
  return handle && /^[A-Za-z0-9_]{1,64}$/.test(handle)
    ? `https://t.me/${handle}`
    : null
}

export function adminTelegramChat(row) {
  if (!isPublicTelegramChat(row)) return null
  const username = telegramUsername(row)
  const memberCount = row?.stable_fields?.metrics?.members
    ?? row?.stable_fields?.attributes?.memberCount
  return {
    canonicalId: row.id,
    externalId: String(row.external_id),
    kind: adminTelegramChatKind(row),
    title: boundedPublicText(row.title, 500),
    username,
    url: canonicalTelegramUrl(row, username),
    memberCount: typeof memberCount === 'number' && Number.isFinite(memberCount)
      ? memberCount
      : null,
    eventTime: iso(row.event_time),
    collectedAt: iso(row.collected_at),
  }
}

export function adminTelegramMessage(row) {
  const item = publicTelegramMonitorRecord(row)
  return {
    canonicalId: row.id,
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
  const kind = requiredString(input.kind, 'kind', 16).toLowerCase()
  if (!CHAT_KINDS.has(kind)) {
    throw new AppError(400, 'invalid_request', 'kind must be channel or group')
  }
  return {
    kind,
    query: optionalString(input.query, 'query', 200),
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
  }
}

export function normalizeAdminTelegramHistoryQuery(chatIdInput, input = {}) {
  unsupportedFields(input, HISTORY_QUERY_FIELDS, 'Telegram history query')
  return {
    chatId: requiredString(chatIdInput, 'chatId'),
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
  }
}

export function normalizeAdminTelegramSearchQuery(input = {}) {
  unsupportedFields(input, SEARCH_FIELDS, 'Telegram search')
  return {
    query: requiredString(input.query, 'query', 500),
    chatId: optionalString(input.chatId, 'chatId'),
    pageSize: pageSizeValue(input.pageSize),
    cursor: decodeTelegramCursor(optionalString(input.cursor, 'cursor', 1_024)),
  }
}

export function normalizeAdminTelegramContextQuery(idInput, input = {}) {
  return {
    id: requiredUuid(idInput, 'id'),
    ...normalizeCanonicalContextQuery(input),
  }
}

export function adminTelegramChatsResponse(rows, query, { demoMode = false } = {}) {
  const safeRows = rows.filter((row) => {
    const chat = adminTelegramChat(row)
    return chat?.kind === query.kind
  })
  const page = pageInfo(safeRows, query.pageSize)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-chats.v1',
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE),
    kind: query.kind,
    query: query.query,
    items: page.pageRows.map(adminTelegramChat),
    pageInfo: page.pageInfo,
    demoMode,
  }
}

export function adminTelegramMessagesResponse(chatRow, rows, query, { demoMode = false } = {}) {
  const chat = adminTelegramChat(chatRow)
  if (!chat) throw new AppError(404, 'chat_not_found', 'Public Telegram chat not found')
  const page = pageInfo(rows, query.pageSize)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-messages.v1',
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE),
    chat,
    items: page.pageRows.map(adminTelegramMessage),
    pageInfo: page.pageInfo,
    demoMode,
  }
}

export function adminTelegramSearchResponse(rows, query, { demoMode = false } = {}) {
  const page = pageInfo(rows, query.pageSize)
  return {
    contractVersion: 'mx-insight-hub.admin-data-products.telegram-search.v1',
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE),
    query: query.query,
    chatId: query.chatId,
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
  return {
    ...canonicalContextResponse({ query, result }),
    sourceScope: sourceScope(ADMIN_TELEGRAM_SOURCE_SCOPE),
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
  // These two records deliberately exercise the fail-closed public-chat gate.
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
  demoMessage('20000000-0000-4000-8000-000000000007', '-1002998', 7, '该消息属于邀请群组，不应返回。', 1, {
    stable_fields: { relations: { chatId: '-1002998', messageId: '7' }, password: 'must-not-leak' },
  }),
])

function tupleBefore(row, cursor) {
  if (!cursor) return true
  const rowTime = iso(row.sort_time)
  return rowTime < cursor.sortTime || (rowTime === cursor.sortTime && row.id < cursor.id)
}

function demoChatById(chatId) {
  return DEMO_TELEGRAM_CHATS.find((row) => (
    row.id === chatId || String(row.external_id) === chatId || telegramUsername(row) === chatId.replace(/^@/, '')
  ) && isPublicTelegramChat(row)) ?? null
}

export function demoAdminTelegramChats(query) {
  const needle = query.query?.toLocaleLowerCase('zh-CN') ?? null
  return DEMO_TELEGRAM_CHATS
    .filter((row) => adminTelegramChatKind(row) === query.kind && isPublicTelegramChat(row))
    .filter((row) => !needle || [row.title, telegramUsername(row)]
      .some((value) => value?.toLocaleLowerCase('zh-CN').includes(needle)))
    .filter((row) => tupleBefore(row, query.cursor))
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
    .slice(0, query.pageSize + 1)
}

export function demoAdminTelegramMessages(query) {
  const chat = demoChatById(query.chatId)
  if (!chat) return { chat: null, rows: [] }
  const rows = DEMO_TELEGRAM_MESSAGES
    .filter((row) => row.stable_fields?.relations?.chatId === String(chat.external_id))
    .filter((row) => tupleBefore(row, query.cursor))
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
    .slice(0, query.pageSize + 1)
  return { chat, rows }
}

export function demoAdminTelegramSearch(query) {
  const chat = query.chatId ? demoChatById(query.chatId) : null
  if (query.chatId && !chat) return { chat: null, rows: [] }
  const publicChatIds = new Set(DEMO_TELEGRAM_CHATS.filter(isPublicTelegramChat).map((row) => String(row.external_id)))
  const needle = query.query.toLocaleLowerCase('zh-CN')
  const rows = DEMO_TELEGRAM_MESSAGES
    .filter((row) => publicChatIds.has(row.stable_fields?.relations?.chatId))
    .filter((row) => !chat || row.stable_fields?.relations?.chatId === String(chat.external_id))
    .filter((row) => [row.title, row.body, row.author_name]
      .some((value) => value?.toLocaleLowerCase('zh-CN').includes(needle)))
    .filter((row) => tupleBefore(row, query.cursor))
    .sort((left, right) => iso(right.sort_time).localeCompare(iso(left.sort_time)) || right.id.localeCompare(left.id))
    .slice(0, query.pageSize + 1)
  return { chat, rows }
}

export function demoAdminTelegramContext(query) {
  const current = DEMO_TELEGRAM_MESSAGES.find((row) => row.id === query.id) ?? null
  if (!current) return null
  const chatId = current.stable_fields?.relations?.chatId
  if (!demoChatById(chatId)) return null
  const stream = DEMO_TELEGRAM_MESSAGES
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

function demoOpinionRow({ id, provinceCode, title, summary, heatScore, daysAgo, stage = 'formal' }) {
  const eventTime = demoDate(daysAgo)
  return {
    id, title, body: summary, url: `https://example.invalid/public-opinion/${id}`,
    content_type: 'news', author_name: stage === 'formal' ? '公开新闻来源' : '候选采集源',
    event_time: eventTime, collected_at: new Date(eventTime.getTime() + 120_000),
    admin1_code: provinceCode, heat_score: String(heatScore),
    stable_fields: { attributes: { sourceType: 'news', sourcePlatform: 'public-web' } },
    source_stage: stage,
    quality_status: stage === 'formal' ? 'formal' : 'pending',
    quality_score: stage === 'formal' ? null : 72,
    qualification_threshold: stage === 'formal' ? null : 80,
    geography_verified: stage === 'formal',
    sort_time: eventTime,
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
