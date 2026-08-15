import { createHash } from 'node:crypto'
import { AppError } from '../../core/errors.mjs'
import { canonicalJson } from '../normalizers.mjs'
import {
  applyMapping,
  validateFieldMap,
  CHUNKER_VERSION,
  isExactSafeIntegerToken,
} from './mapping.mjs'

const MAX_PAGE_SIZE = 500
const MAX_PREVIEW = 3
const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_OVERLAP_MS = 2 * 60 * 60 * 1_000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000
const DAY_MS = 24 * 60 * 60 * 1_000
const DAILY_WINDOW_START_HOUR = 2
const MAX_INTEGER_TOKEN_DIGITS = 128
const MAX_NUMERIC_TOKEN_CHARACTERS = 256
const JSON_INTEGER_TOKEN = /^-?(?:0|[1-9]\d*)$/u
export const SQLITE_JSON_DECODER_VERSION = 'lossless-integer-v1'
const CONNECTION_FIELDS = new Set(['baseUrl', 'token', 'resource', 'pageSize'])
const RESOURCES = new Set(['chats', 'messages'])
const REQUIRED_ROW_FIELDS = Object.freeze({
  chats: ['chat_id', 'updated_at'],
  messages: ['chat_id', 'message_id', 'message_at', 'captured_at', 'deleted_at'],
})
const ID_FIELDS = Object.freeze({
  chats: ['chat_id'],
  messages: [
    'chat_id', 'message_id', 'sender_id', 'reply_to_message_id',
    'thread_id', 'first_seen_account_id',
  ],
})

const RESOURCE_COLUMNS = Object.freeze({
  chats: [
    'chat_id', 'chat_type', 'title', 'username', 'participant_count',
    'updated_at', 'primary_url', 'message_count', 'last_message_at',
  ],
  messages: [
    'chat_id', 'message_id', 'sender_id', 'sender_name', 'sender_username',
    'text', 'message_at', 'edited_at', 'captured_at', 'message_kind',
    'media_type', 'reply_to_message_id', 'thread_id', 'is_outgoing',
    'deleted_at', 'first_seen_account_id', 'account_alias', 'account_phone',
    'chat_title', 'chat_username', 'message_url', 'metadata',
  ],
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeFailureCode(error) {
  for (const candidate of [error?.code, error?.name === 'Error' ? null : error?.name]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)) return candidate
  }
  return 'sqlite_api_pull_failed'
}

function withoutImportRun(position) {
  const { importRunId: _importRunId, ...rest } = position || {}
  return rest
}

function valueShape(value) {
  if (value === null || value === undefined) {
    return { jsonType: 'null', isNull: true, serializedLength: 4 }
  }
  let jsonType = typeof value
  if (Array.isArray(value)) jsonType = 'array'
  else if (typeof value === 'object') jsonType = 'object'
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = JSON.stringify(String(value))
  }
  return {
    jsonType,
    isNull: false,
    serializedLength: Buffer.byteLength(serialized ?? 'null'),
  }
}

function parseFiniteDate(value) {
  if (value == null || value === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function latestIso(...values) {
  let latest = null
  for (const value of values) {
    const date = parseFiniteDate(value)
    if (date && (!latest || date > latest)) latest = date
  }
  return latest?.toISOString() ?? null
}

function losslessNumberReviver(_key, value, context) {
  if (typeof value !== 'number') return value
  if (typeof context?.source !== 'string') {
    throw new AppError(
      503,
      'sqlite_api_lossless_json_unsupported',
      'The runtime cannot preserve large JSON integer tokens without precision loss',
    )
  }
  const source = context.source
  if (source.length > MAX_NUMERIC_TOKEN_CHARACTERS) {
    throw new AppError(
      503,
      'sqlite_api_numeric_token_too_large',
      `SQLite API numeric tokens may contain at most ${MAX_NUMERIC_TOKEN_CHARACTERS} characters`,
    )
  }
  if (JSON_INTEGER_TOKEN.test(source)) {
    const digitCount = source[0] === '-' ? source.length - 1 : source.length
    if (digitCount > MAX_INTEGER_TOKEN_DIGITS) {
      throw new AppError(
        503,
        'sqlite_api_numeric_token_too_large',
        `SQLite API integer tokens may contain at most ${MAX_INTEGER_TOKEN_DIGITS} digits`,
      )
    }
    return Number.isSafeInteger(value) ? value : source
  }

  // Decimal/exponent values remain ordinary numbers unless parsing turns one
  // into an integer. In that case compare the exact base-10 value with the
  // parsed safe integer so underflow or discarded fractional digits cannot
  // masquerade as a valid ID, timestamp, metric, or nested value.
  if (
    !Number.isFinite(value)
    || (Number.isInteger(value) && !isExactSafeIntegerToken(source, value))
  ) {
    throw new AppError(
      503,
      'sqlite_api_unsupported_numeric_token',
      'A JSON decimal or exponent token would lose value when converted to an integer',
    )
  }
  return value
}

export function parseLosslessJson(text, parseImpl = JSON.parse) {
  return parseImpl(text, losslessNumberReviver)
}

function safeBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length > 2_048) {
    throw new AppError(400, 'invalid_sqlite_api_base_url', 'connection.baseUrl must be a trimmed HTTP(S) URL')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, 'invalid_sqlite_api_base_url', 'connection.baseUrl must be a valid HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new AppError(
      400,
      'invalid_sqlite_api_base_url',
      'connection.baseUrl must use HTTP(S) and must not contain credentials, query parameters, or a fragment',
    )
  }
  if (['0.0.0.0', '::', '[::]'].includes(url.hostname)) {
    throw new AppError(
      400,
      'invalid_sqlite_api_base_url',
      'connection.baseUrl must use a reachable host, not an unspecified listen address',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.toString().replace(/\/$/u, '')
}

export function validateSqliteApiConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new AppError(400, 'invalid_connection', 'connection must be an object')
  }
  const unsupported = Object.keys(connection).filter((key) => !CONNECTION_FIELDS.has(key))
  if (unsupported.length > 0) {
    throw new AppError(
      400,
      'unsupported_connection_fields',
      `Unsupported SQLite API connection fields: ${unsupported.join(', ')}`,
    )
  }
  safeBaseUrl(connection.baseUrl)
  if (
    typeof connection.token !== 'string'
    || !connection.token
    || connection.token.trim() !== connection.token
    || /[\u0000-\u001f\u007f]/u.test(connection.token)
    || Buffer.byteLength(connection.token) > 4_096
  ) {
    throw new AppError(400, 'invalid_sqlite_api_token', 'connection.token must be a trimmed non-empty value of at most 4096 bytes')
  }
  if (!RESOURCES.has(connection.resource)) {
    throw new AppError(400, 'invalid_sqlite_api_resource', 'connection.resource must be chats or messages')
  }
  if (!Number.isInteger(connection.pageSize) || connection.pageSize < 1 || connection.pageSize > MAX_PAGE_SIZE) {
    throw new AppError(400, 'invalid_sqlite_api_page_size', 'connection.pageSize must be an integer between 1 and 500')
  }
  return true
}

function safeConnection(connection) {
  return {
    baseUrl: safeBaseUrl(connection.baseUrl),
    resource: connection.resource,
    pageSize: connection.pageSize,
    tokenConfigured: typeof connection.token === 'string' && connection.token.length > 0,
  }
}

function safeSource(source) {
  return {
    sourceKey: source.sourceKey,
    displayName: source.displayName,
    sourceKind: source.sourceKind,
    datasetId: source.datasetId,
    platform: source.platform,
    objectType: source.objectType,
    status: source.status,
    connection: safeConnection(source.connection || {}),
  }
}

function sourceContractHash(source, mapping) {
  const connection = source.connection || {}
  return sha256(canonicalJson({
    baseUrl: safeBaseUrl(connection.baseUrl),
    resource: connection.resource,
    pageSize: connection.pageSize,
    datasetId: source.datasetId,
    platform: source.platform,
    objectType: source.objectType,
    mappingVersion: mapping.version,
    jsonDecoderVersion: SQLITE_JSON_DECODER_VERSION,
  }))
}

function importRunKey({ source, contractHash, mappingVersion, position, cycle }) {
  return sha256(canonicalJson({
    sourceId: source.id,
    contractHash,
    mappingVersion,
    resetAt: position.resetAt ?? null,
    lastCompletedAt: position.lastCompletedAt ?? null,
    lastMessageAt: position.lastMessageAt ?? null,
    cycle,
  }))
}

function importBatchKey({ contractHash, cycle, page, pageSize }) {
  return sha256(canonicalJson({ contractHash, cycle, page, pageSize }))
}

function sourcePageFingerprint(rows) {
  return sha256(canonicalJson(rows))
}

function pullInputName(sourceKey, cycle) {
  return `sqlite-api-pull:${sourceKey}:${sha256(canonicalJson(cycle)).slice(0, 16)}`
}

export function sqliteApiDailyWindowAt(now) {
  const instant = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(instant.getTime())) throw new TypeError('now must be a valid date')
  const shanghai = new Date(instant.getTime() + SHANGHAI_OFFSET_MS)
  const endDate = shanghai.toISOString().slice(0, 10)
  const date = new Date(Date.parse(`${endDate}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10)
  return {
    date,
    startAt: `${date}T00:00:00.000+08:00`,
    endAt: `${endDate}T00:00:00.000+08:00`,
    available: shanghai.getUTCHours() >= DAILY_WINDOW_START_HOUR,
  }
}

function createCycle({ position, now, overlapMs, trigger, pageSize }) {
  const startedAt = now.toISOString()
  const dailyWindow = sqliteApiDailyWindowAt(now)
  const forceReconciliation = trigger === 'reconciliation'
  const mode = forceReconciliation || !position.lastCompletedAt
    ? 'reconciliation'
    : trigger === 'daily_window'
      ? 'daily_window'
      : 'incremental'
  const latestMessage = parseFiniteDate(position.lastMessageAt)
  const startAt = mode === 'incremental' && latestMessage
    ? new Date(latestMessage.getTime() - overlapMs).toISOString()
    : mode === 'daily_window' ? dailyWindow.startAt : null
  const endAt = mode === 'daily_window' ? dailyWindow.endAt : startedAt
  return {
    mode,
    startedAt,
    startAt,
    endAt,
    ...(mode === 'daily_window' || (mode === 'reconciliation' && dailyWindow.available)
      ? { dailyWindowDate: dailyWindow.date }
      : {}),
    page: 1,
    pageSize,
    processedRows: 0,
    totalRows: null,
    maxMessageAt: position.lastMessageAt ?? null,
  }
}

function completedPosition(position, cycle, contractHash, mappingVersion) {
  const result = {
    ...withoutImportRun(position),
    contractHash,
    mappingVersion,
    lastCompletedAt: cycle.startedAt ?? cycle.endAt,
    lastMessageAt: latestIso(position.lastMessageAt, cycle.maxMessageAt),
    lastSweepRows: Number(cycle.processedRows ?? 0),
    lastSweepTotal: Number(cycle.totalRows ?? cycle.processedRows ?? 0),
  }
  if (cycle.mode === 'reconciliation') result.lastReconciledAt = cycle.startedAt ?? cycle.endAt
  if (cycle.dailyWindowDate) result.lastDailyWindowDate = cycle.dailyWindowDate
  delete result.cycle
  return result
}

function safePullError(error) {
  if (error instanceof AppError) return error
  const wrapped = new AppError(
    503,
    safeFailureCode(error),
    'SQLite API source pull failed; retry from the last durable checkpoint',
  )
  if (error?.externalFinalizationAttempted === true) wrapped.externalFinalizationAttempted = true
  return wrapped
}

function isRetryableGetFailure(error) {
  if (error?.code === 'sqlite_api_unavailable') return true
  const status = Number(error?.status)
  return error?.code === 'sqlite_api_request_failed'
    && (status === 408 || status === 425 || status === 429 || status >= 500)
}

function isLosslessIntegerId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value)
  return typeof value === 'string' && /^-?\d+$/u.test(value)
}

function isValidResourceRow(resource, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const required = REQUIRED_ROW_FIELDS[resource]
  if (!required.every((field) => Object.hasOwn(row, field))) return false
  if (required.some((field) => field !== 'deleted_at' && row[field] == null)) return false
  if (!ID_FIELDS[resource].every((field) => (
    !Object.hasOwn(row, field)
    || row[field] == null
    || isLosslessIntegerId(row[field])
  ))) return false
  const requiredTimes = resource === 'chats' ? ['updated_at'] : ['message_at', 'captured_at']
  if (requiredTimes.some((field) => !parseFiniteDate(row[field]))) return false
  if (resource === 'messages') {
    if (['edited_at', 'deleted_at'].some((field) => row[field] != null && !parseFiniteDate(row[field]))) return false
    const metadata = row.metadata
    if (
      metadata
      && typeof metadata === 'object'
      && !Array.isArray(metadata)
      && Object.hasOwn(metadata, 'grouped_id')
      && metadata.grouped_id != null
      && !isLosslessIntegerId(metadata.grouped_id)
    ) return false
  }
  return true
}

export class SQLiteApiSourcePuller {
  constructor({
    store,
    queue,
    logger = console,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = REQUEST_TIMEOUT_MS,
    overlapMs = DEFAULT_OVERLAP_MS,
  }) {
    this.store = store
    this.queue = queue
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.now = now
    this.timeoutMs = timeoutMs
    this.overlapMs = overlapMs
    this.sourceLocks = new Set()
  }

  async #source(sourceKey, { requireMapping = false, mappingOverride = undefined } = {}) {
    const source = await this.store.getExternalSource(sourceKey)
    if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    if (source.sourceKind !== 'sqlite_api') {
      throw new AppError(400, 'wrong_source_kind', 'This source is not a SQLite API source')
    }
    validateSqliteApiConnection(source.connection || {})
    const mapping = mappingOverride === undefined
      ? await this.store.getActiveMapping(source.id)
      : mappingOverride
    if (mapping?.sourceId && mapping.sourceId !== source.id) {
      throw new AppError(409, 'mapping_source_mismatch', 'The field mapping belongs to another source')
    }
    if (requireMapping && !mapping) {
      throw new AppError(409, 'no_approved_mapping', 'This source has no approved field mapping')
    }
    if (mapping) {
      validateFieldMap(mapping.fieldMap)
      if (source.connection?.resource === 'messages' && mapping.fieldMap.deletedAt) {
        const deletionSources = Array.isArray(mapping.fieldMap.deletedAt.from)
          ? mapping.fieldMap.deletedAt.from
          : [mapping.fieldMap.deletedAt.from]
        if (deletionSources.length !== 1 || deletionSources[0] !== 'deleted_at') {
          throw new AppError(
            409,
            'unsafe_sqlite_api_delete_mapping',
            'SQLite API tombstones may only be mapped from the explicit deleted_at field',
          )
        }
      }
    }
    return { source, mapping, connection: source.connection || {} }
  }

  async #request(connection, pathname, { params = {}, authenticated = true } = {}) {
    validateSqliteApiConnection(connection)
    const url = new URL(`${safeBaseUrl(connection.baseUrl)}${pathname}`)
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    let response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: authenticated ? { Authorization: `Bearer ${connection.token}` } : {},
        redirect: 'error',
        signal: controller.signal,
      })
    } catch {
      throw new AppError(503, 'sqlite_api_unavailable', 'SQLite API did not return a response')
    } finally {
      clearTimeout(timer)
    }
    if (!response?.ok) {
      const status = Number(response?.status) || 503
      const code = status === 401
        ? 'sqlite_api_unauthorized'
        : status === 422
          ? 'sqlite_api_contract_rejected'
          : 'sqlite_api_request_failed'
      throw new AppError(status >= 400 && status < 600 ? status : 503, code, `SQLite API request failed with HTTP ${status}`)
    }
    try {
      return parseLosslessJson(await response.text())
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(503, 'sqlite_api_invalid_json', 'SQLite API returned an invalid JSON response')
    }
  }

  async #health(connection) {
    const health = await this.#request(connection, '/v1/health', { authenticated: false })
    if (health?.status !== 'ok') {
      throw new AppError(503, 'sqlite_api_unhealthy', 'SQLite API health status is not ok')
    }
    return health
  }

  async #page(connection, { page = 1, pageSize = connection.pageSize, cycle = null } = {}) {
    const params = { page, page_size: pageSize }
    if (connection.resource === 'messages') {
      params.include_deleted = true
      if (cycle?.startAt) params.start_at = cycle.startAt
      if (cycle?.endAt) params.end_at = cycle.endAt
    }
    const body = await this.#request(connection, `/v1/${connection.resource}`, { params })
    if (
      !body
      || !Array.isArray(body.items)
      || !Number.isSafeInteger(body.total)
      || body.total < 0
      || !Number.isSafeInteger(body.page)
      || body.page < 1
      || !body.items.every((row) => isValidResourceRow(connection.resource, row))
    ) {
      throw new AppError(503, 'sqlite_api_contract_mismatch', 'SQLite API page response does not match the documented contract')
    }
    if (body.page !== page) {
      throw new AppError(503, 'sqlite_api_page_mismatch', 'SQLite API returned a different page than requested')
    }
    return { items: body.items, total: body.total, page: body.page }
  }

  async withSourceLock(sourceKey, operation) {
    if (typeof this.store.withExternalSourceLock === 'function') {
      return this.store.withExternalSourceLock(
        sourceKey,
        (assertOwned = async () => {}, sessionClient = null) => operation(assertOwned, sessionClient),
      )
    }
    if (this.sourceLocks.has(sourceKey)) {
      throw new AppError(409, 'source_busy', `External source is currently being synchronized: ${sourceKey}`)
    }
    this.sourceLocks.add(sourceKey)
    try {
      return await operation(async () => {}, null)
    } finally {
      this.sourceLocks.delete(sourceKey)
    }
  }

  async withSourceLocks(sourceKeys, operation) {
    const keys = [...new Set(sourceKeys)].sort()
    const acquire = (index, guards, sessions) => index >= keys.length
      ? operation(async () => {
          for (const guard of guards) await guard()
        }, sessions)
      : this.withSourceLock(
          keys[index],
          (guard, session) => acquire(index + 1, [...guards, guard], [...sessions, session]),
        )
    return acquire(0, [], [])
  }

  async testConnection(connection) {
    await this.#health(connection)
    const stats = await this.#request(connection, '/v1/stats')
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      throw new AppError(503, 'sqlite_api_contract_mismatch', 'SQLite API stats response does not match the documented contract')
    }
    const safeStats = {
      chats: stats.chats,
      messages: stats.messages,
      activeMessages: stats.active_messages,
      last24Hours: stats.last_24_hours,
    }
    if (Object.values(safeStats).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new AppError(503, 'sqlite_api_contract_mismatch', 'SQLite API stats response does not match the documented contract')
    }
    const page = await this.#page(connection, { page: 1, pageSize: 1 })
    return {
      ...safeConnection(connection),
      status: 'ok',
      readOnly: true,
      totalRows: page.total,
      stats: safeStats,
    }
  }

  async testSource(sourceKey) {
    const { connection } = await this.#source(sourceKey)
    return this.testConnection(connection)
  }

  async describe(sourceKey, { mappingOverride = undefined } = {}) {
    const { source, mapping, connection } = await this.#source(sourceKey, { mappingOverride })
    const page = await this.#page(connection, { page: 1, pageSize: 1 })
    const knownColumns = RESOURCE_COLUMNS[connection.resource]
    const observed = new Set(page.items.flatMap((row) => Object.keys(row || {})))
    const columns = [...new Set([...knownColumns, ...observed])].map((name, index) => ({
      name,
      dataType: 'json',
      databaseType: 'http-json',
      nullable: true,
      ordinal: index + 1,
    }))
    const missingMappings = mapping
      ? Object.entries(mapping.fieldMap).flatMap(([target, rule]) => {
          const candidates = Array.isArray(rule.from) ? rule.from : [rule.from]
          const roots = candidates.map((candidate) => candidate.split('.')[0])
          const present = rule.type === 'composite'
            ? roots.every((name) => columns.some((column) => column.name === name))
            : roots.some((name) => columns.some((column) => column.name === name))
          return present ? [] : [`mapping ${target} has no matching source field (${candidates.join(', ')})`]
        })
      : []
    const issues = [
      ...(!mapping ? ['no approved mapping'] : []),
      ...(source.platform === 'telegram' && !mapping?.fieldMap?.eventTime
        ? ['mapping eventTime is required for telegram records']
        : []),
      ...missingMappings.filter((message) => message.startsWith('mapping externalId')),
    ]
    const warnings = [
      ...missingMappings.filter((message) => !message.startsWith('mapping externalId')),
      ...(connection.resource === 'messages'
        ? ['source API has no change sequence; synchronization uses overlap polling, a bounded previous-day window, and operator-triggered full alignment']
        : []),
    ]
    return {
      source: safeSource(source),
      columns,
      estimatedRows: page.total,
      totalBytes: null,
      indexes: [],
      constraints: connection.resource === 'messages'
        ? [{ name: 'documented_message_identity', type: 'unique', definition: '(chat_id, message_id)' }]
        : [{ name: 'documented_chat_identity', type: 'primary', definition: '(chat_id)' }],
      triggers: [],
      cursor: { mode: 'reconciliation_overlap', resource: connection.resource },
      mappingVersion: mapping?.version ?? null,
      issues,
      warnings,
    }
  }

  async preview(sourceKey, { limit = 3 } = {}) {
    const previewLimit = Number(limit)
    if (!Number.isInteger(previewLimit) || previewLimit < 1 || previewLimit > MAX_PREVIEW) {
      throw new AppError(400, 'invalid_preview_limit', `preview limit must be between 1 and ${MAX_PREVIEW}`)
    }
    const { source, mapping, connection } = await this.#source(sourceKey)
    const page = await this.#page(connection, { page: 1, pageSize: previewLimit })
    return {
      source: safeSource(source),
      columns: RESOURCE_COLUMNS[connection.resource].map((name, index) => ({
        name, dataType: 'json', databaseType: 'http-json', nullable: true, ordinal: index + 1,
      })),
      mappingVersion: mapping?.version ?? null,
      sampleShapes: page.items.map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, valueShape(value)]),
      )),
    }
  }

  #assertCheckpoint(position, { contractHash, mappingVersion }) {
    if (!position?.contractHash) return
    if (position.contractHash !== contractHash || Number(position.mappingVersion) !== Number(mappingVersion)) {
      throw new AppError(
        409,
        'checkpoint_contract_mismatch',
        'The saved checkpoint belongs to a different SQLite API connection, resource, dataset, or mapping',
      )
    }
  }

  async assertCheckpointCompatible(sourceKey, { mappingOverride = undefined } = {}) {
    if (!this.queue) throw new AppError(503, 'queue_unavailable', 'SQLite API pull requires a durable cursor store')
    const { source, mapping } = await this.#source(sourceKey, { requireMapping: true, mappingOverride })
    const contractHash = sourceContractHash(source, mapping)
    const cursor = await this.queue.getCursor(`external:${sourceKey}`)
    this.#assertCheckpoint(cursor?.position ?? {}, { contractHash, mappingVersion: mapping.version })
    return { compatible: true, contractHash, mappingVersion: mapping.version, cursor: cursor ?? null }
  }

  async resetCheckpoint(sourceKey) {
    return this.withSourceLock(sourceKey, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'SQLite API pull requires a durable cursor store')
      const { source, mapping } = await this.#source(sourceKey, { requireMapping: true })
      if (source.status !== 'paused') {
        throw new AppError(409, 'source_pause_required', 'Pause this source before resetting its checkpoint')
      }
      const cursorId = `external:${sourceKey}`
      const position = {
        contractHash: sourceContractHash(source, mapping),
        mappingVersion: mapping.version,
        resetAt: this.now().toISOString(),
      }
      await assertOwned()
      if (typeof this.store.resetExternalImportCheckpoint === 'function') {
        return (await this.store.resetExternalImportCheckpoint({ sourceId: source.id, cursorId, position })).cursor
      }
      return this.queue.saveCursor(cursorId, position, { status: 'idle', error: null })
    })
  }

  async resetCheckpoints(sourceKeys, { mappingOverrides = {} } = {}) {
    return this.withSourceLocks(sourceKeys, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'SQLite API pull requires a durable cursor store')
      const resetAt = this.now().toISOString()
      const resets = []
      for (const sourceKey of sourceKeys) {
        const mappingOverride = mappingOverrides instanceof Map
          ? mappingOverrides.get(sourceKey)
          : mappingOverrides[sourceKey]
        const { source, mapping } = await this.#source(sourceKey, { requireMapping: true, mappingOverride })
        if (source.status !== 'paused') {
          throw new AppError(409, 'source_pause_required', 'Pause every source before resetting checkpoints')
        }
        resets.push({
          sourceKey,
          sourceId: source.id,
          cursorId: `external:${sourceKey}`,
          position: {
            contractHash: sourceContractHash(source, mapping),
            mappingVersion: mapping.version,
            resetAt,
          },
        })
      }
      await assertOwned()
      if (typeof this.store.resetExternalImportCheckpointsBatch === 'function') {
        return this.store.resetExternalImportCheckpointsBatch(resets)
      }
      const results = []
      for (const reset of resets) {
        results.push({
          sourceKey: reset.sourceKey,
          cursor: await this.queue.saveCursor(reset.cursorId, reset.position, { status: 'idle', error: null }),
        })
      }
      return results
    })
  }

  async progress(sourceKey) {
    const { connection } = await this.#source(sourceKey)
    const cursor = await this.queue?.getCursor?.(`external:${sourceKey}`) ?? null
    const position = cursor?.position ?? {}
    const cycle = position.cycle ?? null
    const page = await this.#page(connection, { page: 1, pageSize: 1, cycle })
    const lastSweepTotal = Number(position.lastSweepTotal)
    const totalRows = !cycle && position.lastCompletedAt && Number.isSafeInteger(lastSweepTotal) && lastSweepTotal >= 0
      ? lastSweepTotal
      : page.total
    const completedRows = cycle
      ? Math.min(totalRows, Math.max(0, Number(cycle.processedRows ?? 0)))
      : position.lastCompletedAt
        ? Math.min(totalRows, Math.max(0, Number(position.lastSweepRows ?? 0)))
        : null
    const remainingRows = completedRows == null ? null : Math.max(0, totalRows - completedRows)
    return {
      totalRows,
      sourceTotalRows: page.total,
      completedRows,
      remainingRows,
      percent: completedRows == null
        ? null
        : totalRows === 0 ? 100 : Math.round((completedRows / totalRows) * 10_000) / 100,
      cursor,
      blocker: connection.resource === 'messages' ? 'source_has_no_exact_change_cursor' : null,
      issues: connection.resource === 'messages'
        ? ['message_at overlap needs operator-triggered reconciliation for older edits and deletions']
        : [],
    }
  }

  async #assertImportRun(source, importRunId) {
    if (!importRunId || typeof this.store.getImportRunState !== 'function') return
    const run = await this.store.getImportRunState(importRunId)
    if (!run || run.sourceId !== source.id || run.status !== 'running') {
      throw new AppError(
        409,
        'import_run_checkpoint_invalid',
        'The checkpoint import run is missing, terminal, or belongs to another source',
      )
    }
  }

  async #finalizeRun({ source, cursorId, importRunId, position, status, cursorStatus, processedDelta = 0, error = null, assertOwned }) {
    const finalPosition = withoutImportRun(position)
    if (typeof this.store.finalizeExternalImportRun === 'function') {
      try {
        await assertOwned()
        return (await this.store.finalizeExternalImportRun({
          importRunId,
          sourceId: source.id,
          cursorId,
          position: finalPosition,
          status,
          cursorStatus,
          processedDelta,
          error,
        })).cursor
      } catch (finalizeError) {
        finalizeError.externalFinalizationAttempted = true
        throw finalizeError
      }
    }
    let remainingDelta = processedDelta
    if (status === 'succeeded' && cursorStatus === 'idle' && processedDelta > 0) {
      await assertOwned()
      await this.queue.saveCursor(
        cursorId,
        { ...finalPosition, importRunId },
        { status: 'running', processedDelta, error: null },
      )
      remainingDelta = 0
    }
    await assertOwned()
    await this.store.finishImportRun(importRunId, {
      status, rowCount: null, rejectedCount: null, cursorEnd: finalPosition, error,
    })
    await assertOwned()
    return this.queue.saveCursor(cursorId, finalPosition, {
      status: cursorStatus, processedDelta: remainingDelta, error,
    })
  }

  async #acknowledgeBatch({ source, sourceKey, cursorId, importRunId, cursorEnd, ingested, assertOwned }) {
    const latestSource = await this.store.getExternalSource(sourceKey)
    const paused = latestSource?.status === 'paused'
    const done = paused || cursorEnd.cycle == null
    if (done) {
      await this.#finalizeRun({
        source, cursorId, importRunId, position: cursorEnd,
        status: 'succeeded', cursorStatus: 'idle', processedDelta: ingested,
        error: null, assertOwned,
      })
    } else {
      await assertOwned()
      await this.queue.saveCursor(
        cursorId,
        { ...withoutImportRun(cursorEnd), importRunId },
        { status: 'running', processedDelta: ingested, error: null },
      )
    }
    return { done, paused }
  }

  async markContinuationFailed(sourceKey, importRunId, error = 'continuation_enqueue_failed') {
    return this.withSourceLock(sourceKey, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'SQLite API pull requires a durable cursor store')
      const source = await this.store.getExternalSource(sourceKey)
      if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
      const cursorId = `external:${sourceKey}`
      const saved = await this.queue.getCursor(cursorId)
      const position = saved?.position ?? {}
      const checkpointRunId = position.importRunId ?? null
      if (!checkpointRunId || (importRunId && checkpointRunId !== importRunId)) {
        throw new AppError(409, 'import_run_checkpoint_mismatch', 'The failed continuation no longer owns this checkpoint')
      }
      await this.#assertImportRun(source, checkpointRunId)
      const failedPosition = { ...withoutImportRun(position), importRunId: checkpointRunId }
      await assertOwned()
      if (typeof this.store.markExternalImportCursorFailed === 'function') {
        const input = {
          importRunId: checkpointRunId,
          sourceId: source.id,
          cursorId,
          position: failedPosition,
          error,
        }
        try {
          return (await this.store.markExternalImportCursorFailed(input)).cursor
        } catch (markError) {
          if (markError?.code !== 'external_cursor_failure_outcome_unknown') throw markError
          await assertOwned()
          return (await this.store.markExternalImportCursorFailed(input)).cursor
        }
      }
      return this.queue.saveCursor(cursorId, failedPosition, { status: 'failed', error })
    })
  }

  async markSourceContractFailed(sourceKey, error = 'source_contract_mismatch') {
    return this.withSourceLock(sourceKey, async (assertOwned) => {
      if (!this.queue) throw new AppError(503, 'queue_unavailable', 'SQLite API pull requires a durable cursor store')
      const source = await this.store.getExternalSource(sourceKey)
      if (!source) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
      const cursorId = `external:${sourceKey}`
      const saved = await this.queue.getCursor(cursorId)
      const position = saved?.position ?? {}
      if (position.importRunId) {
        await this.#assertImportRun(source, position.importRunId)
        await assertOwned()
        if (typeof this.store.markExternalImportCursorFailed === 'function') {
          const input = {
            importRunId: position.importRunId,
            sourceId: source.id,
            cursorId,
            position,
            error,
          }
          try {
            return (await this.store.markExternalImportCursorFailed(input)).cursor
          } catch (markError) {
            if (markError?.code !== 'external_cursor_failure_outcome_unknown') throw markError
            await assertOwned()
            return (await this.store.markExternalImportCursorFailed(input)).cursor
          }
        }
      }
      await assertOwned()
      return this.queue.saveCursor(cursorId, position, { status: 'failed', error })
    })
  }

  async pullBatch(sourceKey, options = {}) {
    try {
      return await this.withSourceLock(
        sourceKey,
        (assertOwned) => this.#pullBatchUnlocked(sourceKey, options, assertOwned),
      )
    } catch (error) {
      throw safePullError(error)
    }
  }

  async #pullBatchUnlocked(
    sourceKey,
    { batchSize = 1_000, importRunId = null, trigger = 'manual' } = {},
    assertOwned = async () => {},
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new AppError(400, 'invalid_batch_size', 'batchSize must be a positive integer')
    }
    const { source, mapping, connection } = await this.#source(sourceKey, { requireMapping: true })
    if (!this.queue) throw new AppError(503, 'queue_unavailable', 'SQLite API pull requires a durable cursor store')
    const cursorId = `external:${sourceKey}`
    const saved = await this.queue.getCursor(cursorId)
    const position = saved?.position ?? {}
    const contractHash = sourceContractHash(source, mapping)
    this.#assertCheckpoint(position, { contractHash, mappingVersion: mapping.version })
    const checkpointRunId = position.importRunId ?? null
    if (importRunId && !checkpointRunId) {
      return {
        pulled: 0, ingested: 0, changed: 0, deleted: 0, rejected: 0,
        importRunId, done: true, stale: true,
      }
    }
    if (importRunId && importRunId !== checkpointRunId) {
      throw new AppError(409, 'import_run_checkpoint_mismatch', 'The queued import run no longer owns this checkpoint')
    }
    await this.#assertImportRun(source, checkpointRunId)

    let run = checkpointRunId ? { id: checkpointRunId } : null
    const idlePosition = withoutImportRun({ ...position, contractHash, mappingVersion: mapping.version })
    if (source.status !== 'active') {
      if (run) {
        await this.#finalizeRun({
          source, cursorId, importRunId: run.id, position: idlePosition,
          status: 'succeeded', cursorStatus: 'idle', error: null, assertOwned,
        })
      } else if (saved?.status === 'running' || saved?.status === 'paused') {
        await assertOwned()
        await this.queue.saveCursor(cursorId, idlePosition, { status: 'idle', error: null })
      }
      return {
        pulled: 0, ingested: 0, changed: 0, deleted: 0, rejected: 0,
        importRunId: run?.id ?? null, done: true, paused: true,
      }
    }

    let workingPosition = idlePosition
    let cycle = position.cycle
    if (!run) {
      cycle = cycle ?? createCycle({
        position,
        now: this.now(),
        overlapMs: this.overlapMs,
        trigger,
        pageSize: Math.min(batchSize, connection.pageSize, MAX_PAGE_SIZE),
      })
      workingPosition = { ...idlePosition, cycle }
      await assertOwned()
      run = await this.store.startImportRun({
        sourceId: source.id,
        mappingVersion: mapping.version,
        inputSha256: null,
        inputName: pullInputName(sourceKey, cycle),
        inputBytes: null,
        cursorStart: workingPosition,
        trigger,
        runKey: importRunKey({ source, contractHash, mappingVersion: mapping.version, position, cycle }),
      })
      await assertOwned()
      await this.queue.saveCursor(
        cursorId,
        { ...workingPosition, importRunId: run.id },
        { status: 'running', error: null },
      )
    }

    const pageNumber = Number(cycle.page || 1)
    const pageSize = Number(cycle.pageSize ?? Math.min(batchSize, connection.pageSize, MAX_PAGE_SIZE))
    const batchKey = importBatchKey({ contractHash, cycle, page: pageNumber, pageSize })
    if (typeof this.store.getImportBatch === 'function') {
      const committed = await this.store.getImportBatch(run.id, batchKey)
      if (committed) {
        if (committed.status !== 'succeeded') {
          throw new AppError(409, 'import_batch_failed', 'This import batch previously failed and must be reset')
        }
        const acknowledgement = await this.#acknowledgeBatch({
          source, sourceKey, cursorId, importRunId: run.id,
          cursorEnd: committed.cursorEnd,
          ingested: committed.ingested,
          assertOwned,
        })
        return {
          pulled: committed.rowCount,
          ingested: committed.ingested,
          changed: committed.changed,
          deleted: committed.deleted,
          rejected: committed.rejected,
          replayed: true,
          importRunId: run.id,
          done: acknowledgement.done,
          paused: acknowledgement.paused,
        }
      }
    }

    let batchCommitted = false
    let runFinished = false
    try {
      const page = await this.#page(connection, { page: pageNumber, pageSize, cycle })
      const rows = page.items
      if (rows.length === 0) {
        const finalPosition = completedPosition(
          workingPosition,
          { ...cycle, totalRows: page.total },
          contractHash,
          mapping.version,
        )
        await this.#finalizeRun({
          source, cursorId, importRunId: run.id, position: finalPosition,
          status: 'succeeded', cursorStatus: 'idle', error: null, assertOwned,
        })
        runFinished = true
        return { pulled: 0, ingested: 0, changed: 0, deleted: 0, rejected: 0, importRunId: run.id, done: true }
      }

      const mapped = []
      const rejections = []
      for (const [index, raw] of rows.entries()) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          rejections.push({ rowIndex: index + 1, reason: 'source row is not an object', raw })
          continue
        }
        const { record, rejected } = applyMapping(raw, mapping.fieldMap, {
          platform: source.platform,
          objectType: source.objectType,
          source: { origin: 'sqlite_api', sourceKey: source.sourceKey },
        })
        if (rejected) {
          rejections.push({ rowIndex: index + 1, reason: rejected, raw })
          continue
        }
        if (source.platform === 'telegram' && !record.eventTime) {
          rejections.push({ rowIndex: index + 1, reason: 'eventTime is required for Telegram serving', raw })
          continue
        }
        // Source values are retained without content filtering. Unsafe bare
        // JSON integers are represented as exact decimal strings by the
        // versioned decoder; rawItem is not a byte-for-byte response copy.
        record.rawItem = raw
        record.parserVersion = `${CHUNKER_VERSION}:sqlite-api:${SQLITE_JSON_DECODER_VERSION}:map${mapping.version}`
        mapped.push(record)
      }

      if (rejections.length > 0) {
        if (typeof this.store.recordRejectedImportBatch === 'function') {
          await assertOwned()
          await this.store.recordRejectedImportBatch(run.id, {
            sourceId: source.id,
            batchKey,
            cursorStart: workingPosition,
            rowCount: rows.length,
            rejections,
            pageFingerprint: sourcePageFingerprint(rows),
          })
        }
        await this.#finalizeRun({
          source, cursorId, importRunId: run.id, position: workingPosition,
          status: 'failed', cursorStatus: 'failed', error: 'row_rejections_detected', assertOwned,
        })
        runFinished = true
        throw new AppError(
          409,
          'row_rejections_detected',
          `Rejected ${rejections.length} of ${rows.length} rows; correct the mapping before resuming`,
        )
      }

      const maxMessageAt = connection.resource === 'messages'
        ? latestIso(cycle.maxMessageAt, ...rows.map((row) => row.message_at))
        : cycle.maxMessageAt
      const nextCycle = {
        ...cycle,
        page: pageNumber + 1,
        processedRows: Number(cycle.processedRows ?? 0) + rows.length,
        totalRows: page.total,
        maxMessageAt,
      }
      const hasMore = pageNumber * pageSize < page.total
      const nextPosition = hasMore
        ? { ...withoutImportRun(workingPosition), contractHash, mappingVersion: mapping.version, cycle: nextCycle }
        : completedPosition(workingPosition, nextCycle, contractHash, mapping.version)
      const pageFingerprint = sourcePageFingerprint(rows)
      await assertOwned()
      const result = await this.store.ingestExternalRecords({
        datasetId: source.datasetId,
        platform: source.platform,
        connectorId: `external:${source.sourceKey}`,
        records: mapped,
        importRunId: run.id,
        sourceId: source.id,
        batch: {
          key: batchKey,
          cursorStart: withoutImportRun(workingPosition),
          cursorEnd: nextPosition,
          rowCount: rows.length,
          pageFingerprint,
        },
      })
      batchCommitted = true
      const acknowledgedPosition = result.cursorEnd ?? nextPosition
      const acknowledgement = await this.#acknowledgeBatch({
        source, sourceKey, cursorId, importRunId: run.id,
        cursorEnd: acknowledgedPosition,
        ingested: result.ingested,
        assertOwned,
      })
      runFinished = acknowledgement.done
      return {
        pulled: rows.length,
        ingested: result.ingested,
        changed: result.changed,
        deleted: result.deleted ?? 0,
        replayed: result.replayed === true,
        rejected: 0,
        rejectionRate: 0,
        importRunId: run.id,
        done: acknowledgement.done,
        paused: acknowledgement.paused,
      }
    } catch (error) {
      const preserveForRetry = batchCommitted
        || error?.externalFinalizationAttempted === true
        || ['external_commit_outcome_unknown', 'external_finalize_outcome_unknown'].includes(error?.code)
        || isRetryableGetFailure(error)
      if (!preserveForRetry && run && !runFinished) {
        await this.#finalizeRun({
          source, cursorId, importRunId: run.id, position: workingPosition,
          status: 'failed', cursorStatus: 'failed', error: safeFailureCode(error), assertOwned,
        }).catch(() => {})
      }
      throw error
    }
  }
}
