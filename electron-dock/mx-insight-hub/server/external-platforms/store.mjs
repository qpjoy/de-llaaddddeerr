import { quarantineRecoverySql } from '../core/admission-recovery.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'
import { INSTAGRAM_SEARCH_KEY } from '../contracts/instagram-search.mjs'
import { JUSTONE_INSTAGRAM_SEARCH_KEY } from '../contracts/instagram-justone-search.mjs'
import { NATIVE_FORWARDING_VERSION } from '../contracts/native-forwarding.mjs'
import { HUB_SOCIAL_VERSION } from '../contracts/hub-social.mjs'
import { canonicalPlatform } from '../hub-service.mjs'
import * as facebookSearchStore from './facebook-search-store.mjs'
import * as twitterRetryStore from './twitter-manual-retry.mjs'
import { twitterDeliveryLeases } from './twitter-delivery-leases.mjs'
import { getSearchAdmissionDispositionIds } from '../operations/search-admission-disposition.mjs'

const clone = (value) => value == null ? value : structuredClone(value)
const iso = (value = new Date()) => new Date(value).toISOString()
const number = (value) => value == null ? null : Number(value)
const FINISHED_PROVIDER_OUTCOMES = new Set(['succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const ownedSearchDelivery = (provider, operation) => provider === 'rapidapi'
  ? ['social.content.search', 'social.facebook.search'].includes(operation)
  : provider === 'justone' && operation === 'native.j.facebook_post_search_v1'
const twitterRetryInput = input => ({ ...input,
  retryOfRequestId: input.twitterManualRetry.retryOfRequestId,
  bufferCallId: input.twitterManualRetry.bufferCallId })
const memoryDispatchLeases = (store, operation) => store.usageStore && store.providerKey === 'rapidapi' && operation === 'social.content.search'
  ? twitterDeliveryLeases(store.usageStore) : store.leases

async function disposedTwitterDispatchIds(store, { consumerId, operation, fingerprint, ownerRequestId }) {
  if (!(store.providerKey === 'rapidapi' && operation === 'social.content.search'
    || store.providerKey === 'tikhub' && operation === 'native.t.twitter_web_fetch_search_timeline')) return []
  const candidates = (await store.pool.query(`SELECT DISTINCT usage_request_id FROM external_platform.provider_calls
    WHERE provider_key=$4 AND operation=$2 AND consumer_id=$1
      AND (dispatch_fingerprint=$3 OR (dispatch_fingerprint IS NULL AND request_fingerprint=$3))
      AND outcome='unknown' AND completed_at>now()-make_interval(secs=>$5::double precision)`,
  [consumerId,operation,fingerprint,store.providerKey,Math.ceil(store.uncertainCooldownMs / 1000)])).rows
  if (!candidates.length) return []
  // Only a distinct, reserved standard-search intent can use a historical
  // disposition. Same-key handling remains owned by the usage/protocol stores.
  const { rows } = await store.pool.query(`SELECT DISTINCT previous.id, owner.tenant_id, owner.api_key_id
    FROM usage_requests previous
    JOIN usage_requests owner ON owner.id=$4 AND owner.consumer_id=$1
      AND owner.status='reserved' AND owner.platform='twitter' AND owner.fingerprint=$3
      AND owner.acquisition_request->>'path'='/api/v1/data/search'
      AND owner.id<>previous.id AND owner.idempotency_key<>previous.idempotency_key
    WHERE previous.id=ANY($2::uuid[]) AND previous.status='unknown' AND previous.tenant_id=owner.tenant_id
      AND previous.consumer_id=owner.consumer_id AND previous.api_key_id=owner.api_key_id
      AND previous.platform='twitter' AND previous.acquisition_request->>'path'='/api/v1/data/search'`,
  [consumerId,candidates.map(row=>row.usage_request_id),fingerprint,ownerRequestId])
  if (!rows.length) return []
  return getSearchAdmissionDispositionIds(store.pool, rows, {
    tenantId: rows[0].tenant_id, consumerId, apiKeyId: rows[0].api_key_id, platform: 'twitter',
  })
}

const instagramOperation = provider => provider === 'tikhub' ? `native.${INSTAGRAM_SEARCH_KEY}`
  : provider === 'justone' ? `native.${JUSTONE_INSTAGRAM_SEARCH_KEY}` : null

function instagramArchivePage(archive, provider) {
  const bytes = archive?.bodyBytes
  if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024
    || createHash('sha256').update(bytes).digest('hex') !== archive.bodySha256) return null
  try {
    // Match acquisition parsing, including a legal leading UTF-8 BOM.
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!instagramOperation(provider) || payload?.code !== (provider === 'justone' ? 0 : 200) || !payload.data) return null
    return { publicBody: { data: payload.data, meta: { capturedAt: iso(archive.capturedAt) } } }
  } catch { return null }
}

const TWITTER_PAGE_PATH = '/api/v1/data/search'
const TWITTER_PAGE_MAX_BYTES = 4 * 1024 * 1024
const TWITTER_PAGE_MAX_AGE_MS = 86400000
const twitterPageIdentity = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const twitterPageTime = value => {
  const time = new Date(value).getTime(), age = Date.now() - time
  return value != null && Number.isFinite(time) && age >= 0 && age <= TWITTER_PAGE_MAX_AGE_MS
}

function twitterArchivePage(archive) {
  const bytes = archive?.bodyBytes
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(archive.bodySize)
    || archive.bodySize !== bytes.byteLength || bytes.byteLength === 0 || bytes.byteLength > TWITTER_PAGE_MAX_BYTES
    || !SHA256_PATTERN.test(archive.bodySha256 || '')
    || createHash('sha256').update(bytes).digest('hex') !== archive.bodySha256
    || !twitterPageTime(archive.capturedAt)) return null
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isPostgresSafeJsonValue(payload)) return null
    // Restricted, complete provider payload. The gateway must re-project and
    // verify its signed acquired-row hash before exposing a buffered slice.
    return { payload, capturedAt: iso(archive.capturedAt), bodySize: bytes.byteLength, bodySha256: archive.bodySha256 }
  } catch { return null }
}

function twitterPageInput(input) {
  return input?.path === TWITTER_PAGE_PATH
    && ['callId', 'tenantId', 'consumerId', 'apiKeyId'].every(key => twitterPageIdentity(input[key]))
}

async function postgresTwitterPage(queryable, input, lock = false, ownUsageRequestId = null) {
  if (!twitterPageInput(input)) return null
  const { rows: [row] } = await queryable.query(
    `SELECT raw.body_bytes, raw.body_sha256, raw.body_size, raw.captured_at, request.id AS source_usage_request_id
       FROM external_platform.provider_calls call
       JOIN usage_requests request ON request.id = call.usage_request_id
       JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id = call.id
      WHERE call.id = $1 AND call.provider_key = 'rapidapi'
        AND call.operation = 'social.content.search' AND call.endpoint_key = 'twitter-aio.search'
        AND call.endpoint_version = 'twitter-aio.hub.v1' AND call.contract_version = $5
        AND call.outcome = 'succeeded' AND call.http_status = 200
        AND call.completed_at BETWEEN now() - interval '24 hours' AND now()
        AND call.tenant_id = $2 AND call.consumer_id = $3 AND call.api_key_id = $4
        AND request.tenant_id = $2 AND request.consumer_id = $3 AND request.api_key_id = $4
        AND request.platform = 'twitter'
        AND ((request.status = 'committed' AND request.response_status = 200)
          OR (request.id = $6::uuid AND request.status = 'reserved'))
        AND request.acquisition_request->>'path' = '/api/v1/data/search'
        AND raw.captured_at BETWEEN now() - interval '24 hours' AND now()
        AND raw.body_size > 0 AND raw.body_size <= ${TWITTER_PAGE_MAX_BYTES}
        AND octet_length(raw.body_bytes) = raw.body_size
      ${lock ? 'FOR SHARE OF call, request, raw' : ''}`,
    [input.callId, input.tenantId, input.consumerId, input.apiKeyId, HUB_SOCIAL_VERSION, ownUsageRequestId],
  )
  const page = row ? twitterArchivePage({ bodyBytes: row.body_bytes, bodySha256: row.body_sha256,
    bodySize: Number(row.body_size), capturedAt: row.captured_at }) : null
  return page ? { ...page, sourceUsageRequestId: row.source_usage_request_id } : null
}

function memoryTwitterPage(store, input, ownUsageRequestId = null) {
  if (store.providerKey !== 'rapidapi' || !twitterPageInput(input)) return null
  const call = store.calls.get(input.callId)
  const usage = store.usageStore.requests.get(call?.usageRequestId)
  if (call?.providerKey !== 'rapidapi' || call.operation !== 'social.content.search'
    || call.endpointKey !== 'twitter-aio.search' || call.endpointVersion !== 'twitter-aio.hub.v1'
    || call.contractVersion !== HUB_SOCIAL_VERSION || call.outcome !== 'succeeded' || call.httpStatus !== 200
    || !twitterPageTime(call.completedAt)
    || call.tenantId !== input.tenantId || call.consumerId !== input.consumerId || call.apiKeyId !== input.apiKeyId
    || !usage || !(usage.status === 'committed' && usage.responseStatus === 200
      || usage.id === ownUsageRequestId && usage.status === 'reserved') || usage.platform !== 'twitter'
    || usage.tenantId !== input.tenantId || usage.consumerId !== input.consumerId || usage.apiKeyId !== input.apiKeyId
    || usage.acquisitionRequest?.path !== TWITTER_PAGE_PATH) return null
  const page = twitterArchivePage(store.restrictedResponseArchives.get(input.callId))
  return page ? { ...page, sourceUsageRequestId: usage.id } : null
}

const twitterHistoryError = () => new AppError(409, 'search_page_unavailable', 'The saved Twitter traversal does not match this request')
const twitterBodyMatches = (snapshot, input) => {
  try {
    return snapshot?.path === TWITTER_PAGE_PATH && canonicalPlatform(snapshot.body?.platform) === 'twitter'
      && snapshot.body?.query?.trim() === input.query && (snapshot.body.pageSize ?? 20) === input.pageSize
      && (snapshot.body.type ?? 'fresh') === input.type
  } catch { return false }
}

async function twitterDeliveredIds(read, input, rootId) {
  if (!SHA256_PATTERN.test(input.scopeHash || '') || !['fresh', 'stable'].includes(input.type)
    || !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100
    || typeof input.query !== 'string' || !input.query
    || !['tenantId', 'consumerId', 'apiKeyId'].every(key => twitterPageIdentity(input[key]))) throw twitterHistoryError()
  const visited = new Set(), ids = new Set()
  let previousDeliveryId = rootId
  while (previousDeliveryId != null) {
    if (!twitterPageIdentity(previousDeliveryId) || visited.has(previousDeliveryId) || visited.size >= 15) throw twitterHistoryError()
    visited.add(previousDeliveryId)
    const row = await read(previousDeliveryId)
    if (!row || row.status !== 'committed' || row.responseStatus !== 200 || row.platform !== 'twitter'
      || row.tenantId !== input.tenantId || row.consumerId !== input.consumerId || row.apiKeyId !== input.apiKeyId
      || !twitterBodyMatches(row.acquisitionRequest, input)
      || row.responseBody?.data?.platform !== 'twitter' || row.responseBody.data.query !== input.query
      || row.responseBody.data.pageInfo?.pageSize !== input.pageSize) throw twitterHistoryError()
    const items = row.responseBody.data.items
    if (!Array.isArray(items) || items.length > input.pageSize) throw twitterHistoryError()
    for (const item of items) {
      if (typeof item?.id !== 'string' || !/^[0-9]{1,30}$/u.test(item.id)) throw twitterHistoryError()
      ids.add(item.id)
      if (ids.size > 1500) throw twitterHistoryError()
    }
    const lineage = row.acquisitionRequest.twitterFill
    if (lineage == null) previousDeliveryId = null // Legacy compatibility window: only this known delivery.
    else {
      if (lineage.version !== 'twitter-fill.v1' || lineage.scopeHash !== input.scopeHash
        || !Number.isInteger(lineage.upstreamPages) || lineage.upstreamPages < 0 || lineage.upstreamPages > 15
        || lineage.previousDeliveryId != null && !twitterPageIdentity(lineage.previousDeliveryId)) throw twitterHistoryError()
      previousDeliveryId = lineage.previousDeliveryId
    }
  }
  return { ids: [...ids], previousDeliveryId: rootId ?? null, deliveries: visited.size }
}

function assertTwitterFill(input) {
  const { delivery, lineage, sources, responseBody, capturedAt, usageUnitsActual, sourceMode } = input
  assertTwitterPageDelivery('rapidapi', { ...input, sourceCallId: sources?.[0]?.callId ?? delivery?.usageRequestId,
    sourceMode: sourceMode === 'live' ? 'fresh_cache' : sourceMode })
  if (!lineage || lineage.version !== 'twitter-fill.v1' || !SHA256_PATTERN.test(lineage.scopeHash || '')
    || lineage.previousDeliveryId != null && !twitterPageIdentity(lineage.previousDeliveryId)
    || !Number.isInteger(lineage.upstreamPages) || lineage.upstreamPages < 0 || lineage.upstreamPages > 15
    || !Array.isArray(sources) || sources.length < 1 || sources.length > 16 || new Set(sources.map(source => source.callId)).size !== sources.length
    || !['live', 'fresh_cache', 'stored_fallback'].includes(sourceMode)
    || responseBody?.data?.platform !== 'twitter' || responseBody.data.query !== input.query
    || responseBody.data.pageInfo?.pageSize !== input.pageSize
    || !Array.isArray(responseBody.data.items) || responseBody.data.items.length !== usageUnitsActual
    || responseBody.data.items.some(item => typeof item?.id !== 'string' || !/^[0-9]{1,30}$/u.test(item.id))
    || new Set(responseBody.data.items.map(item => item.id)).size !== usageUnitsActual
    || !twitterPageTime(capturedAt)) throw twitterHistoryError()
  for (const source of sources) if (!twitterPageIdentity(source.callId)
    || !SHA256_PATTERN.test(source.bodySha256 || '') || !SHA256_PATTERN.test(source.rowsHash || '')
    || !Number.isSafeInteger(source.bodySize) || source.bodySize < 1 || source.bodySize > TWITTER_PAGE_MAX_BYTES
    || !twitterPageTime(source.capturedAt)) throw twitterHistoryError()
}

function assertTwitterPageDelivery(providerKey, { delivery, sourceCallId, sourceMode, capturedAt, usageUnitsActual }) {
  if (providerKey !== 'rapidapi' || !delivery || delivery.operation !== 'social.content.search'
    || !twitterPageInput({ ...delivery, callId: sourceCallId, path: TWITTER_PAGE_PATH })
    || !twitterPageIdentity(delivery.usageRequestId) || !SHA256_PATTERN.test(delivery.fingerprint || '')
    || !['fresh_cache', 'stored_fallback'].includes(sourceMode) || !twitterPageTime(capturedAt)
    || !Number.isSafeInteger(usageUnitsActual) || usageUnitsActual < 0 || usageUnitsActual > 100) {
    throw new AppError(409, 'search_page_unavailable', 'The saved Twitter search page cannot be delivered')
  }
}

function normalizedRestrictedResponseArchive(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('restrictedResponseArchive must be an object')
  }
  if (!Buffer.isBuffer(value.bodyBytes) && !(value.bodyBytes instanceof Uint8Array)) {
    throw new TypeError('restrictedResponseArchive.bodyBytes must contain exact response bytes')
  }
  const bodyBytes = Buffer.from(value.bodyBytes)
  if (!Number.isSafeInteger(value.bodySize) || value.bodySize < 0) {
    throw new TypeError('restrictedResponseArchive.bodySize must be a non-negative safe integer')
  }
  if (value.bodySize !== bodyBytes.byteLength) {
    throw new TypeError('restrictedResponseArchive.bodySize does not match bodyBytes')
  }
  if (!SHA256_PATTERN.test(value.bodySha256 || '')) {
    throw new TypeError('restrictedResponseArchive.bodySha256 must be a lowercase SHA-256 fingerprint')
  }
  const actualSha256 = createHash('sha256').update(bodyBytes).digest('hex')
  if (actualSha256 !== value.bodySha256) {
    throw new TypeError('restrictedResponseArchive.bodySha256 does not match bodyBytes')
  }
  if (value.bodyText != null && typeof value.bodyText !== 'string') {
    throw new TypeError('restrictedResponseArchive.bodyText must be a string or null')
  }
  let decodedBodyText = null
  try {
    // Match the adapters' exact-text view: fatal UTF-8 validation while
    // preserving an initial BOM. Bytes/hash remain the source of truth.
    decodedBodyText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bodyBytes)
  } catch {
    if (value.bodyText != null) {
      throw new TypeError('restrictedResponseArchive.bodyBytes are not valid UTF-8')
    }
  }
  const postgresBodyText = isPostgresSafeText(decodedBodyText) ? decodedBodyText : null
  if (postgresBodyText !== (value.bodyText ?? null)) {
    throw new TypeError('restrictedResponseArchive.bodyText does not match bodyBytes')
  }
  if (typeof value.jsonParsed !== 'boolean') {
    throw new TypeError('restrictedResponseArchive.jsonParsed must be a boolean')
  }
  const bodyText = value.bodyText ?? null
  const parsedPayload = value.jsonParsed
    && value.parsedPayload != null
    && isPostgresSafeJsonValue(value.parsedPayload)
    ? clone(value.parsedPayload)
    : null
  if (!value.jsonParsed && value.parsedPayload != null) {
    throw new TypeError('restrictedResponseArchive.parsedPayload requires jsonParsed=true')
  }
  if (value.jsonParsed) {
    if (bodyText == null) {
      if (parsedPayload != null) {
        throw new TypeError('restrictedResponseArchive.parsedPayload requires a text projection')
      }
    } else {
      let parsed
      try {
        parsed = JSON.parse(bodyText.replace(/^\uFEFF/u, ''))
      } catch {
        throw new TypeError('restrictedResponseArchive.bodyText is not valid JSON')
      }
      if (parsedPayload != null && !isDeepStrictEqual(parsed, parsedPayload)) {
        throw new TypeError('restrictedResponseArchive.parsedPayload does not match bodyText')
      }
    }
  }
  let capturedAt
  try {
    capturedAt = iso(value.capturedAt)
  } catch {
    throw new TypeError('restrictedResponseArchive.capturedAt must be a valid timestamp')
  }
  return {
    contentType: value.contentType ?? null,
    bodySize: value.bodySize,
    bodySha256: value.bodySha256,
    bodyBytes,
    bodyText,
    jsonParsed: value.jsonParsed,
    parsedPayload,
    capturedAt,
  }
}

const snapshotFingerprint = (delivery) => delivery.snapshotFingerprint ?? delivery.fingerprint

function snapshotKey(delivery) {
  return `${delivery.consumerId}\u0000${delivery.operation}\u0000${snapshotFingerprint(delivery)}`
}

function boundedRateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function normalizedCostControl(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('costControl must be an object')
  }
  const supported = new Set([
    'costMinor', 'costKind', 'currency', 'monthlyBudgetMinor',
    'monthlySubsidyBudgetMinor',
  ])
  if (Object.keys(value).some((field) => !supported.has(field))) {
    throw new TypeError('costControl contains unsupported fields')
  }
  if (!Number.isSafeInteger(value.costMinor) || value.costMinor <= 0) {
    throw new TypeError('costControl.costMinor must be a positive safe integer')
  }
  if (!['estimated', 'provider_reported'].includes(value.costKind)) {
    throw new TypeError('costControl.costKind must be estimated or provider_reported')
  }
  const currency = String(value.currency || '').toUpperCase()
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new TypeError('costControl.currency must be a three-letter code')
  }
  if (!Number.isSafeInteger(value.monthlyBudgetMinor) || value.monthlyBudgetMinor < 0) {
    throw new TypeError('costControl.monthlyBudgetMinor must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(value.monthlySubsidyBudgetMinor)
    || value.monthlySubsidyBudgetMinor < 0) {
    throw new TypeError('costControl.monthlySubsidyBudgetMinor must be a non-negative safe integer')
  }
  return { ...value, currency }
}

function normalizedOperationControl(value, { providerKey, operation }) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('operationControl must be an object')
  }
  const supported = new Set([
    'providerKey', 'operationKey', 'policyRevision', 'releaseRevision',
    'priceBookVersion', 'credentialRevision', 'desiredState', 'billing',
  ])
  if (Object.keys(value).some((field) => !supported.has(field))) {
    throw new TypeError('operationControl contains unsupported fields')
  }
  if (value.providerKey !== providerKey || value.operationKey !== operation) {
    throw new TypeError('operationControl does not match the provider call')
  }
  for (const field of ['policyRevision', 'priceBookVersion']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new TypeError(`operationControl.${field} must be a non-negative safe integer`)
    }
  }
  if (!Number.isSafeInteger(value.releaseRevision) || value.releaseRevision <= 0) {
    throw new TypeError('operationControl.releaseRevision must be a positive safe integer')
  }
  if (!Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 0) {
    throw new TypeError('operationControl.credentialRevision must be a non-negative safe integer')
  }
  return {
    policyRevision: value.policyRevision,
    releaseRevision: value.releaseRevision,
    priceBookVersion: value.priceBookVersion,
    credentialRevision: value.credentialRevision,
  }
}

function hasMatchingCustomerHold(usageStore, usage, charge) {
  return Array.isArray(usageStore?.creditLedgerEntries)
    && usageStore.creditLedgerEntries.some((entry) => (
      entry.chargeId === charge.id
      && entry.usageRequestId === usage.id
      && entry.accountId === charge.accountId
      && entry.tenantId === usage.tenantId
      && entry.kind === 'hold'
      && entry.amountMinor === charge.quotedMinor
      && entry.availableDeltaMinor === -charge.quotedMinor
      && entry.heldDeltaMinor === charge.quotedMinor
      && entry.currency === charge.currency
    ))
}

function hasTerminalCustomerHoldEntry(usageStore, charge) {
  return Array.isArray(usageStore?.creditLedgerEntries)
    && usageStore.creditLedgerEntries.some((entry) => (
      entry.chargeId === charge.id
      && ['capture', 'release'].includes(entry.kind)
    ))
}

function isCustomerChargeBackedByHold(usageStore, usage, charge, allowedStatuses) {
  return Boolean(
    usage
    && charge
    && typeof charge.id === 'string'
    && charge.id.length > 0
    && charge.usageRequestId === usage.id
    && charge.tenantId === usage.tenantId
    && charge.consumerId === usage.consumerId
    && charge.apiKeyId === usage.apiKeyId
    && charge.meterKey === usage.billingMeterKey
    && charge.enforcementMode === 'enforced'
    && allowedStatuses.includes(charge.status)
    && charge.billingUnit === 'request'
    && Number.isSafeInteger(charge.quotedMinor)
    && charge.quotedMinor > 0
    && typeof charge.accountId === 'string'
    && charge.accountId.length > 0
    && hasMatchingCustomerHold(usageStore, usage, charge)
  )
}

function isReservedCustomerBilledRequest(usageStore, usage, charge) {
  return isCustomerChargeBackedByHold(usageStore, usage, charge, ['reserved'])
    && !hasTerminalCustomerHoldEntry(usageStore, charge)
}

function utcMonthBounds(at = new Date()) {
  const date = new Date(at)
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  return {
    start,
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  }
}

function rateMoment({ at = new Date(), windowMs = 60_000 } = {}) {
  const duration = boundedRateLimit(windowMs, 'windowMs')
  if (duration < 1_000 || duration > 3_600_000) {
    throw new TypeError('windowMs must be between 1000 and 3600000')
  }
  const timestamp = new Date(at).getTime()
  if (!Number.isFinite(timestamp)) throw new TypeError('at must be a valid timestamp')
  return { windowMs: duration, timestamp }
}

function deliveredItemCount(body) {
  if (Array.isArray(body?.data?.items)) return body.data.items.length
  if (body?.data?.item && typeof body.data.item === 'object') return 1
  if (typeof body?.data?.raw_data === 'string') {
    try {
      const rows = JSON.parse(body.data.raw_data)
      if (Array.isArray(rows)) return rows.length
    } catch {
      // Compatibility bodies are validated before storage. Treat a malformed
      // historical snapshot conservatively as one delivered request unit.
    }
  }
  return 0
}

function normalizedEvidence(input) {
  return {
    httpStatus: input.responseArchive?.httpStatus ?? input.httpStatus ?? null,
    businessCode: input.responseArchive?.businessCode ?? input.businessCode ?? null,
    upstreamRequestId: input.upstreamEvidence?.requestId ?? null,
    upstreamRecordTime: input.upstreamEvidence?.recordTime ?? null,
    billed: input.billed ?? null,
    costMinor: input.costMinor ?? null,
    costKind: input.costKind ?? 'unknown',
    currency: input.currency ?? null,
    latencyMs: input.latencyMs ?? null,
    itemCount: input.itemCount ?? null,
    errorCode: input.errorCode ?? null,
    responseArchive: clone(input.responseArchive ?? null),
    restrictedResponseArchive: normalizedRestrictedResponseArchive(
      input.restrictedResponseArchive ?? null,
    ),
    archiveObjects: clone(input.archiveObjects ?? []),
  }
}

function cloneNormalizedEvidence(evidence) {
  return {
    ...clone(evidence),
    restrictedResponseArchive: normalizedRestrictedResponseArchive(
      evidence.restrictedResponseArchive ?? null,
    ),
  }
}

function validateStagedEvidence(input) {
  const evidence = normalizedEvidence(input)
  if (!evidence.responseArchive || !SHA256_PATTERN.test(evidence.responseArchive.payloadSha256 || '')) {
    throw new TypeError('stageProviderEvidence requires a response archive with a SHA-256 payload')
  }
  if (!evidence.restrictedResponseArchive) {
    throw new TypeError('stageProviderEvidence requires the exact restricted response bytes')
  }
  if (!Array.isArray(evidence.archiveObjects) || evidence.archiveObjects.length === 0) {
    throw new TypeError('stageProviderEvidence requires at least one archive object')
  }
  if (!evidence.archiveObjects.some((object) => (
    object?.kind === 'response'
    && object.payloadSha256 === evidence.responseArchive.payloadSha256
  ))) {
    throw new TypeError('stageProviderEvidence requires its response archive object')
  }
  const capturedDate = iso(evidence.responseArchive.capturedAt).slice(0, 10)
  for (const object of evidence.archiveObjects) {
    if (!SHA256_PATTERN.test(object?.payloadSha256 || '')) {
      throw new TypeError('archive object payloadSha256 must be a lowercase SHA-256 fingerprint')
    }
    if (object.capturedDate !== capturedDate) {
      throw new AppError(
        500,
        'external_platform_archive_date_invalid',
        'External platform archive date does not match its UTC capture time',
      )
    }
  }
  return evidence
}

function memoryCallScopeMatches(call, delivery, providerKey) {
  return call?.providerKey === providerKey
    && call.tenantId === delivery.tenantId
    && call.consumerId === delivery.consumerId
    && call.usageRequestId === delivery.usageRequestId
    && call.operation === delivery.operation
    && call.fingerprint === delivery.fingerprint
}

function evidenceConflict() {
  return new AppError(
    409,
    'external_platform_evidence_conflict',
    'Provider-call evidence does not match the existing durable record',
  )
}

function nullableNumber(value) {
  return value == null ? null : Number(value)
}

function nullableTime(value) {
  if (value == null) return null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function postgresCallScopeMatches(row, input, providerKey) {
  const delivery = input.delivery
  return row?.provider_key === providerKey
    && row.tenant_id === delivery.tenantId
    && row.consumer_id === delivery.consumerId
    && row.usage_request_id === delivery.usageRequestId
    && row.operation === delivery.operation
    && row.request_fingerprint === delivery.fingerprint
}

function postgresCallEvidenceMatches(row, input, { ignoreErrorCode = false } = {}) {
  const evidence = normalizedEvidence(input)
  return nullableNumber(row.http_status) === nullableNumber(evidence.httpStatus)
    && nullableNumber(row.business_code) === nullableNumber(evidence.businessCode)
    && (row.upstream_request_id ?? null) === evidence.upstreamRequestId
    && (row.upstream_record_time ?? null) === evidence.upstreamRecordTime
    && (row.billed ?? null) === evidence.billed
    && nullableNumber(row.cost_minor) === nullableNumber(evidence.costMinor)
    && row.cost_kind === evidence.costKind
    && (row.currency ?? null) === evidence.currency
    && nullableNumber(row.latency_ms) === nullableNumber(evidence.latencyMs)
    && nullableNumber(row.item_count) === nullableNumber(evidence.itemCount)
    && (ignoreErrorCode || (row.error_code ?? null) === evidence.errorCode)
}

function postgresResponseArchiveMatches(row, archive) {
  if (!archive) return row.response_archive_id == null
  return row.response_archive_id != null
    && row.archive_contract_state === (archive.contractState || 'unknown')
    && nullableNumber(row.archive_http_status) === nullableNumber(archive.httpStatus)
    && nullableNumber(row.archive_business_code) === nullableNumber(archive.businessCode)
    && (row.archive_content_type ?? null) === (archive.contentType ?? null)
    && nullableNumber(row.archive_body_size) === nullableNumber(archive.bodySize)
    && (row.archive_payload_sha256 ?? null) === (archive.payloadSha256 ?? null)
    && nullableTime(row.archive_captured_at) === nullableTime(archive.capturedAt)
    && isDeepStrictEqual(row.archive_raw_payload ?? null, archive.rawPayload ?? null)
}

function postgresRestrictedResponseArchiveMatches(row, input) {
  const archive = normalizedRestrictedResponseArchive(input ?? null)
  if (!archive) return row.restricted_response_id == null
  return row.restricted_response_id != null
    && (row.restricted_content_type ?? null) === archive.contentType
    && nullableNumber(row.restricted_body_size) === archive.bodySize
    && row.restricted_body_sha256 === archive.bodySha256
    && Buffer.isBuffer(row.restricted_body_bytes)
    && row.restricted_body_bytes.equals(archive.bodyBytes)
    && (row.restricted_body_text ?? null) === archive.bodyText
    && row.restricted_json_parsed === archive.jsonParsed
    && isDeepStrictEqual(row.restricted_parsed_payload ?? null, archive.parsedPayload)
    && nullableTime(row.restricted_captured_at) === nullableTime(archive.capturedAt)
}

function postgresArchiveObjectsMatch(rows, input, providerKey) {
  const expected = normalizedEvidence(input).archiveObjects
  if (rows.length !== expected.length) return false
  return rows.every((row, ordinal) => {
    const object = expected[ordinal]
    return Number(row.item_ordinal) === ordinal
      && row.provider_key === providerKey
      && row.object_kind === (object.kind === 'response' ? 'response' : 'item')
      && row.marketplace === object.marketplace
      && row.operation === input.delivery.operation
      && row.endpoint_version === object.endpointVersion
      && iso(row.captured_date).slice(0, 10) === object.capturedDate
      && row.archive_path === object.archivePath
      && row.response_pointer === (object.envelopePointer || '$')
      && row.source_key === object.sourceKey
      && row.payload_sha256 === object.payloadSha256
      && isDeepStrictEqual(row.raw_payload, object.rawPayload)
  })
}

function postgresSnapshotMatches(snapshot, expected, delivery, providerKey, callId) {
  if (!expected) return snapshot == null
  return snapshot?.providerKey === providerKey
    && snapshot.consumerId === delivery.consumerId
    && snapshot.operation === delivery.operation
    && snapshot.fingerprint === snapshotFingerprint(delivery)
    && snapshot.lastSuccessCallId === callId
    && nullableTime(snapshot.capturedAt) === nullableTime(expected.capturedAt)
    && nullableTime(snapshot.freshUntil) === nullableTime(expected.freshUntil)
    && nullableTime(snapshot.staleUntil) === nullableTime(expected.staleUntil)
    && isDeepStrictEqual(snapshot.responseBody, expected.responseBody)
}

function postgresIngestJobMatches(row, expected, defaultQueue) {
  if (!expected) return row == null
  return row?.queue === (expected.queue || defaultQueue)
    && (row.dedupe_key ?? null) === (expected.dedupeKey ?? null)
    && nullableNumber(row.priority) === nullableNumber(expected.priority ?? 100)
    // pg serializes object parameters as JSON. Canonical records contain Date
    // values, which return from JSONB as ISO strings; compare the persisted
    // representation rather than mistaking that conversion for corruption.
    && isDeepStrictEqual(row.payload, JSON.parse(JSON.stringify(expected.payload)))
}

function requestEvent(input, overrides = {}) {
  return {
    id: randomUUID(),
    providerKey: input.providerKey,
    tenantId: input.tenantId,
    consumerId: input.consumerId,
    usageRequestId: input.usageRequestId ?? null,
    fingerprint: input.fingerprint,
    sourceMode: input.sourceMode,
    succeeded: input.succeeded,
    responseStatus: input.responseStatus ?? null,
    providerCallId: input.providerCallId ?? null,
    snapshotId: input.snapshotId ?? null,
    errorCode: input.errorCode ?? null,
    createdAt: iso(),
    ...overrides,
  }
}

function rangeRows(rows, from) {
  const floor = new Date(from).getTime()
  return rows.filter((row) => new Date(row.createdAt ?? row.startedAt).getTime() >= floor)
}

export class MemoryExternalPlatformStore {
  constructor({
    usageStore,
    providerKey = 'justone',
    authorizationPlatform = 'ecommerce',
    circuitFailureThreshold = 3,
    circuitOpenMs = 60_000,
    rateLimitBurst = null,
    uncertainCooldownMs = 15 * 60_000,
    responseQuarantineCooldownMs = Math.min(uncertainCooldownMs, 5 * 60_000),
  } = {}) {
    this.usageStore = usageStore
    this.providerKey = providerKey
    this.authorizationPlatform = authorizationPlatform
    this.circuitFailureThreshold = circuitFailureThreshold
    this.circuitOpenMs = circuitOpenMs
    this.rateLimitBurst = rateLimitBurst == null ? null : boundedRateLimit(rateLimitBurst, 'rateLimitBurst')
    this.uncertainCooldownMs = uncertainCooldownMs
    this.responseQuarantineCooldownMs = responseQuarantineCooldownMs
    this.calls = new Map()
    this.costReservations = new Map()
    this.responseArchives = new Map()
    this.restrictedResponseArchives = new Map()
    this.snapshots = new Map()
    this.requests = []
    this.leases = new Map()
    this.rateBuckets = new Map()
    this.ingestJobs = []
    this.state = {
      providerKey,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastCallAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
    }
    // Keyed by marketplace; only contract failures land here.
    this.contractCircuits = new Map()
  }

  async instagramPageFor({ callId, tenantId, consumerId, apiKeyId, path }) {
    const call = this.calls.get(callId)
    const usage = this.usageStore.requests.get(call?.usageRequestId)
    if (!instagramOperation(this.providerKey) || call?.providerKey !== this.providerKey || call?.outcome !== 'succeeded'
      || call.operation !== instagramOperation(this.providerKey) || usage?.status !== 'committed'
      || call.endpointKey !== instagramOperation(this.providerKey) || call.contractVersion !== NATIVE_FORWARDING_VERSION
      || usage.responseStatus !== 200 || usage.platform !== 'instagram'
      || usage.tenantId !== tenantId || usage.consumerId !== consumerId || usage.apiKeyId !== apiKeyId
      || usage.acquisitionRequest?.path !== path
      || Date.now() - new Date(call.completedAt).getTime() > 86400000) return null
    return instagramArchivePage(this.restrictedResponseArchives.get(callId), this.providerKey)
  }

  async commitInstagramPage({ delivery, sourceCallId, sourceMode, responseBody, capturedAt, usageUnitsActual }) {
    await this.usageStore.commitRequest(delivery.usageRequestId, { responseStatus: 200, responseBody,
      unitsActual: Math.max(1, usageUnitsActual), upstreamLatencyMs: 0,
      deliverySourceMode: sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt })
    this.requests.push(requestEvent({ ...delivery, providerKey: this.providerKey, sourceMode,
      succeeded: true, responseStatus: 200, providerCallId: sourceCallId }))
  }

  async facebookPageFor(input) { return facebookSearchStore.facebookPageFor(this, input) }
  async facebookDeliveredIdsFor(input) { return facebookSearchStore.facebookDeliveredIdsFor(this, input) }
  async facebookFillUnknownFor(input) { return facebookSearchStore.facebookFillUnknownFor(this, input) }
  async acquireFacebookFillDeliveryLease(input) { return facebookSearchStore.acquireFacebookFillDeliveryLease(this, input) }
  async commitFacebookFillDelivery(input) { return facebookSearchStore.commitFacebookFillDelivery(this, input) }

  async twitterPageFor(input) {
    return memoryTwitterPage(this, input)
  }

  async twitterDeliveredIdsFor(input) {
    if (this.providerKey !== 'rapidapi') throw twitterHistoryError()
    const rootId = input.previousDeliveryId ?? (input.sourceCallId ? this.calls.get(input.sourceCallId)?.usageRequestId : null)
    if (input.sourceCallId && !rootId) throw twitterHistoryError()
    return twitterDeliveredIds(async id => this.usageStore.requests.get(id), input, rootId)
  }

  async twitterFillUnknownFor(delivery) {
    const excluded = delivery.twitterManualRetry
      ? (await this.validateTwitterManualRetry(twitterRetryInput(delivery))).ancestorRequestIds : []
    return [...this.usageStore.requests.values()].some(row => row.platform === 'twitter' && row.status === 'unknown'
      && row.tenantId === delivery.tenantId && row.consumerId === delivery.consumerId && row.apiKeyId === delivery.apiKeyId
      && row.fingerprint === delivery.fingerprint && row.acquisitionRequest?.path === TWITTER_PAGE_PATH
      && !excluded.includes(row.id)
      && Date.now()-new Date(row.reservedAt ?? row.createdAt ?? Date.now()).getTime() <= TWITTER_PAGE_MAX_AGE_MS)
  }

  async validateTwitterManualRetry(input) { return twitterRetryStore.validateTwitterManualRetry(this, input) }
  async twitterManualRetryOwnerFor(id) { return twitterRetryStore.twitterManualRetryOwnerFor(this, id) }
  async twitterManualRetryOriginalFor(id) { return twitterRetryStore.twitterManualRetryOriginalFor(this, id) }

  async acquireTwitterFillDeliveryLease(input) {
    if(this.providerKey!=='rapidapi' || input.operation!=='social.content.search'
      || !twitterPageIdentity(input.ownerRequestId) || !twitterPageIdentity(input.consumerId)
      || !SHA256_PATTERN.test(input.fingerprint || '') || new Date(input.expiresAt).getTime()<=Date.now()) throw twitterHistoryError()
    const leases=memoryDispatchLeases(this,input.operation),key=snapshotKey(input),current=leases.get(key)
    if(current && new Date(current.expiresAt).getTime()>Date.now()) return {kind:'busy',blockedUntil:current.expiresAt}
    leases.set(key,{ownerRequestId:input.ownerRequestId,expiresAt:iso(input.expiresAt)})
    return {kind:'acquired'}
  }

  async commitTwitterFillDelivery(input) {
    if (this.providerKey !== 'rapidapi') throw twitterHistoryError()
    assertTwitterFill(input)
    const { delivery, sources, lineage, capturedAt, responseBody, usageUnitsActual, sourceMode, latencyMs = 0 } = input
    const usage = this.usageStore.requests.get(delivery.usageRequestId)
    if (usage?.status !== 'reserved' || usage.tenantId !== delivery.tenantId || usage.consumerId !== delivery.consumerId
      || usage.apiKeyId !== delivery.apiKeyId || usage.fingerprint !== delivery.fingerprint || usage.platform !== 'twitter'
      || !twitterBodyMatches(usage.acquisitionRequest, input)) throw twitterHistoryError()
    for (const source of sources) {
      const page = memoryTwitterPage(this, { ...delivery, callId: source.callId, path: TWITTER_PAGE_PATH }, delivery.usageRequestId)
      if (!page || page.bodySha256 !== source.bodySha256 || page.bodySize !== source.bodySize || page.capturedAt !== iso(source.capturedAt)) throw twitterHistoryError()
      const sourceUsage = this.usageStore.requests.get(page.sourceUsageRequestId)
      if (!twitterBodyMatches(sourceUsage?.acquisitionRequest, input)) throw twitterHistoryError()
    }
    if (delivery.twitterManualRetry) await twitterRetryStore.claimTwitterManualRetry(this, twitterRetryInput(delivery))
    const manifest = { version: lineage.version, scopeHash: lineage.scopeHash, previousDeliveryId: lineage.previousDeliveryId ?? null,
      upstreamPages: lineage.upstreamPages, sources: clone(sources) }
    await this.usageStore.commitRequest(delivery.usageRequestId, { responseStatus: 200, responseBody,
      unitsActual: Math.max(1, usageUnitsActual), upstreamLatencyMs: latencyMs,
      deliverySourceMode: sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt })
    usage.acquisitionRequest = { ...usage.acquisitionRequest, twitterFill: manifest }
    const representative = [...sources].reverse().find(source => this.calls.get(source.callId)?.usageRequestId === delivery.usageRequestId) ?? sources[0]
    this.requests.push(requestEvent({ ...delivery, providerKey: this.providerKey, sourceMode,
      succeeded: true, responseStatus: 200, providerCallId: representative.callId }))
  }

  async commitTwitterPage(input) {
    assertTwitterPageDelivery(this.providerKey, input)
    const { delivery, sourceCallId, sourceMode, responseBody, capturedAt, usageUnitsActual } = input
    const page = await this.twitterPageFor({ ...delivery, callId: sourceCallId, path: TWITTER_PAGE_PATH })
    if (!page || page.capturedAt !== iso(capturedAt)) {
      throw new AppError(409, 'search_page_unavailable', 'The saved Twitter search page cannot be delivered')
    }
    const usage = this.usageStore.requests.get(delivery.usageRequestId)
    if (usage?.status !== 'reserved' || usage.platform !== 'twitter'
      || usage.tenantId !== delivery.tenantId || usage.consumerId !== delivery.consumerId || usage.apiKeyId !== delivery.apiKeyId
      || usage.fingerprint !== delivery.fingerprint || usage.acquisitionRequest?.path !== TWITTER_PAGE_PATH) {
      throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved for this Twitter delivery')
    }
    await this.usageStore.commitRequest(delivery.usageRequestId, { responseStatus: 200, responseBody,
      unitsActual: Math.max(1, usageUnitsActual), upstreamLatencyMs: 0,
      deliverySourceMode: sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt })
    this.requests.push(requestEvent({ ...delivery, providerKey: this.providerKey, sourceMode,
      succeeded: true, responseStatus: 200, providerCallId: sourceCallId }))
  }

  async snapshotFor(input, at = new Date()) {
    const found = this.snapshots.get(snapshotKey(input))
    if (!found || new Date(found.staleUntil) < new Date(at)) return null
    return clone(found)
  }

  async sharedDetailSnapshotFor(fingerprint, at = new Date()) {
    return clone([...this.snapshots.values()].filter(row => row.providerKey === this.providerKey
      && row.operation === 'social.posts.analytics' && row.fingerprint === fingerprint
      && new Date(row.staleUntil) >= at).sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0] || null)
  }

  async reapStaleCalls(at = new Date()) {
    let reaped = 0
    for (const call of this.calls.values()) {
      if (call.outcome !== 'pending') continue
      const usage = this.usageStore?.requests?.get(call.usageRequestId)
      if (usage?.status !== 'unknown') continue
      Object.assign(call, {
        outcome: 'unknown',
        errorCode: usage.errorCode || 'reservation_lease_expired',
        completedAt: iso(at),
      })
      reaped += 1
    }
    return reaped
  }

  async acquireDispatchLease({
    consumerId,
    operation,
    fingerprint,
    endpointKey,
    contractVersion,
    ownerRequestId,
    expiresAt,
    retryOfRequestId = null,
    ownedDeliveryLease = false,
    twitterManualRetry = null,
  }) {
    if (twitterManualRetry && (operation !== 'social.content.search' || twitterManualRetry.usageRequestId !== ownerRequestId
      || twitterManualRetry.consumerId !== consumerId || twitterManualRetry.fingerprint !== fingerprint)) throw twitterRetryStore.twitterRetryDenied()
    const excluded = twitterManualRetry
      ? (await this.validateTwitterManualRetry(twitterManualRetry)).ancestorRequestIds : []
    const now = Date.now()
    const blocker = [...this.calls.values()]
      .filter((call) => (
        call.operation === operation
        && (
          (
            call.consumerId === consumerId
            && call.dispatchFingerprint === fingerprint
            && call.outcome === 'pending'
          )
          || (
            (
              (
                call.consumerId === consumerId
                && call.dispatchFingerprint === fingerprint
                && call.outcome === 'unknown'
                && call.usageRequestId !== retryOfRequestId
                && !excluded.includes(call.usageRequestId)
              )
              || (
                call.endpointKey === endpointKey
                && call.contractVersion === contractVersion
                && call.outcome === 'succeeded_unusable'
                && call.errorCode !== 'upstream_note_unavailable'
              )
              || (
                call.consumerId === consumerId
                && call.dispatchFingerprint === fingerprint
                && call.outcome === 'succeeded_unusable'
                && call.errorCode === 'upstream_note_unavailable'
              )
            )
            && new Date(call.completedAt).getTime() + (call.outcome === 'succeeded_unusable'
              && call.errorCode !== 'upstream_note_unavailable' ? this.responseQuarantineCooldownMs : this.uncertainCooldownMs) > now
          )
        )
      ))
      .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt))[0]
    if (blocker) {
      return {
        kind: 'blocked',
        reason: blocker.errorCode === 'upstream_note_unavailable'
          ? blocker.errorCode
          : blocker.outcome,
        blockedUntil: blocker.outcome === 'pending'
          ? null
          : iso(new Date(blocker.completedAt).getTime() + (blocker.outcome === 'succeeded_unusable'
            && blocker.errorCode !== 'upstream_note_unavailable' ? this.responseQuarantineCooldownMs : this.uncertainCooldownMs)),
      }
    }
    const key = snapshotKey({ consumerId, operation, fingerprint })
    const leases = memoryDispatchLeases(this, operation)
    const current = leases.get(key)
    if (current && new Date(current.expiresAt).getTime() > now) {
      if(ownedDeliveryLease && ownedSearchDelivery(this.providerKey, operation)
        && current.ownerRequestId===ownerRequestId && current.expiresAt===iso(expiresAt)) return {kind:'acquired'}
      const previous = this.usageStore?.requests?.get(current.ownerRequestId)
      const replacement = this.usageStore?.requests?.get(ownerRequestId)
      // Final cleanup may have skipped a busy database. Only an exactly
      // scoped terminal owner can be replaced before lease expiry; missing or
      // uncertain evidence must retain the original dispatch protection.
      const completedOwner = previous && replacement
        && ['committed', 'released'].includes(previous.status) && replacement.status === 'reserved'
        && previous.tenantId != null && previous.tenantId === replacement.tenantId
        && previous.consumerId === consumerId && replacement.consumerId === consumerId
        && previous.platform && previous.platform === replacement.platform
        && previous.fingerprint === fingerprint && replacement.fingerprint === fingerprint
        && ![...this.calls.values()].some(call => call.usageRequestId === current.ownerRequestId
          && ['pending', 'unknown'].includes(call.outcome))
      if (!completedOwner) return { kind: 'busy', blockedUntil: current.expiresAt }
    }
    leases.set(key, { ownerRequestId, expiresAt: iso(expiresAt) })
    return { kind: 'acquired' }
  }

  async releaseDispatchLease({ consumerId, operation, fingerprint, ownerRequestId }) {
    const key = snapshotKey({ consumerId, operation, fingerprint })
    const leases = memoryDispatchLeases(this, operation)
    if (leases.get(key)?.ownerRequestId === ownerRequestId) leases.delete(key)
  }

  async providerState(providerKey = this.providerKey) {
    if (providerKey !== this.providerKey) return null
    return clone(this.state)
  }

  // The breaker for one marketplace's contract failures.
  //
  // A response the Hub cannot normalize is a gap in our own contract rather
  // than an upstream outage: the vendor answered, and answered for exactly one
  // marketplace. Counting those provider-wide suspended live dispatch for every
  // other marketplace too, which then degraded healthy traffic to stale
  // snapshots. Upstream faults still use the provider-wide breaker.
  async contractCircuitState(providerKey = this.providerKey, scope = null) {
    if (providerKey !== this.providerKey || !scope) return null
    const bucket = this.contractCircuits.get(scope)
    return bucket ? clone(bucket) : null
  }

  async acquireProviderRateLimit({ limit, tokens = 1, windowMs = 60_000, at = new Date() }) {
    const maximum = boundedRateLimit(limit, 'limit')
    const requested = boundedRateLimit(tokens, 'tokens')
    if (requested > maximum) throw new TypeError('tokens must not exceed limit')
    // Preserve atomic multi-call admission, but do not accumulate a whole
    // minute of idle capacity into one burst of single-call/enrichment work.
    const burst = Math.min(maximum, Math.max(requested, this.rateLimitBurst ?? maximum))
    const moment = rateMoment({ at, windowMs })
    const current = this.rateBuckets.get(this.providerKey)
    const elapsedMs = current
      ? Math.max(0, moment.timestamp - current.refilledAtMs)
      : 0
    const available = current
      ? Math.min(burst, current.tokens + (elapsedMs * maximum / moment.windowMs))
      : burst
    const refilledAtMs = current
      ? Math.max(current.refilledAtMs, moment.timestamp)
      : moment.timestamp
    if (available < requested) {
      this.rateBuckets.set(this.providerKey, {
        capacity: maximum,
        windowMs: moment.windowMs,
        tokens: available,
        refilledAtMs,
      })
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, Math.ceil((requested - available) * moment.windowMs / maximum)),
      }
    }
    const remainingTokens = available - requested
    this.rateBuckets.set(this.providerKey, {
      capacity: maximum,
      windowMs: moment.windowMs,
      tokens: remainingTokens,
      refilledAtMs,
    })
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(remainingTokens)),
      retryAfterMs: 0,
    }
  }

  #costState(costControl, { customerBilled = false, usageRequestId = null } = {}) {
    const month = utcMonthBounds()
    const monthlyCalls = [...this.calls.values()].filter((call) => {
      const startedAt = new Date(call.startedAt).getTime()
      return call.providerKey === this.providerKey
        // Operation price books can use different currencies. Account for
        // each original-currency ledger separately, without an implicit FX
        // conversion. Still inspect malformed currencies and all current-
        // request evidence so a workflow cannot switch currency mid-flight.
        && (call.currency === costControl.currency || call.usageRequestId === usageRequestId
          || !/^[A-Z]{3}$/u.test(call.currency || ''))
        && Number.isFinite(startedAt)
        && startedAt >= month.start
        && startedAt < month.end
    })
    // A positive enforced per-request hold makes aggregate financial caps
    // observe-only for this request. Scope the integrity check to this request
    // as well, so unrelated historical bookkeeping cannot turn paid traffic
    // into an apparent provider outage. The current request's own cost evidence
    // remains mandatory and is still persisted for every real dispatch.
    const calls = customerBilled
      ? monthlyCalls.filter((call) => call.usageRequestId === usageRequestId)
      : monthlyCalls
    const knownCalls = calls.filter((call) => (
      Number.isSafeInteger(call.costMinor) && call.costMinor >= 0
    ))
    const incompleteControlledCost = calls.some((call) => customerBilled
      ? !Number.isSafeInteger(call.costMinor)
        || call.costMinor <= 0
        || !['estimated', 'provider_reported'].includes(call.costKind)
      : call.costKind !== 'unknown'
        && call.costKind != null
        && (!Number.isSafeInteger(call.costMinor) || call.costMinor <= 0))
    const mixedCurrencyCost = knownCalls.some(
      (call) => call.currency !== costControl.currency,
    )
    const activeReservations = [...this.costReservations.values()].filter((reservation) => {
      const createdAt = new Date(reservation.createdAt).getTime()
      const usage = this.usageStore?.requests?.get(reservation.usageRequestId)
      const leaseExpiresAt = usage?.leaseExpiresAt == null
        ? null
        : new Date(usage.leaseExpiresAt).getTime()
      return reservation.providerKey === this.providerKey
        && (reservation.currency === costControl.currency || reservation.usageRequestId === usageRequestId
          || !/^[A-Z]{3}$/u.test(reservation.currency || ''))
        && (!customerBilled || reservation.usageRequestId === usageRequestId)
        && reservation.status === 'active'
        && usage?.status === 'reserved'
        && (leaseExpiresAt == null || (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()))
        && Number.isFinite(createdAt)
        && createdAt >= month.start
        && createdAt < month.end
    })
    const mixedReservation = activeReservations.some((reservation) => (
      reservation.currency !== costControl.currency
      || !Number.isSafeInteger(reservation.baseCostMinor)
      || reservation.baseCostMinor < 0
      || !Number.isSafeInteger(reservation.reservedCostMinor)
      || reservation.reservedCostMinor <= 0
      || !Number.isSafeInteger(reservation.reservedSubsidyMinor)
      || reservation.reservedSubsidyMinor < 0
      || (customerBilled && (
        !Number.isSafeInteger(reservation.monthlyBudgetMinor)
        || reservation.monthlyBudgetMinor < 0
        || !Number.isSafeInteger(reservation.monthlySubsidyBudgetMinor)
        || reservation.monthlySubsidyBudgetMinor < 0
      ))
    ))
    if (incompleteControlledCost || mixedCurrencyCost || mixedReservation) {
      throw new AppError(
        503,
        'external_platform_cost_evidence_incomplete',
        'External data cost evidence is incomplete; paid dispatch is disabled',
      )
    }
    // Pre-guard rows with cost_kind=unknown and no amount are intentionally
    // outside the guarded cohort: blocking on those rows would break an
    // existing provider for the rest of the month with no safe backfill.
    // Any known historical amount is still included, and a guarded estimate
    // (cost_kind != unknown) that loses its amount fails closed above.
    const knownCostMinor = knownCalls.reduce((sum, call) => sum + call.costMinor, 0)
    const costsByUsage = new Map()
    for (const known of knownCalls) {
      const total = (costsByUsage.get(known.usageRequestId) || 0) + known.costMinor
      if (!Number.isSafeInteger(total)) {
        throw new AppError(
          503,
          'external_platform_cost_evidence_incomplete',
          'External data cost evidence is incomplete; paid dispatch is disabled',
        )
      }
      costsByUsage.set(known.usageRequestId, total)
    }
    const coveredMinor = (usageRequestId) => {
      const usage = this.usageStore?.requests?.get?.(usageRequestId)
      const charge = this.usageStore?.customerCharges?.get?.(usageRequestId)
      if (!isCustomerChargeBackedByHold(
        this.usageStore,
        usage,
        charge,
        ['reserved', 'captured', 'unknown'],
      )
        || charge.currency !== costControl.currency
      ) return 0
      return charge.quotedMinor
    }
    let subsidyCostMinor = 0
    for (const [usageRequestId, costMinor] of costsByUsage) {
      subsidyCostMinor += Math.max(0, costMinor - coveredMinor(usageRequestId))
    }
    let reservedCostMinor = 0
    let reservedSubsidyMinor = 0
    for (const reservation of activeReservations) {
      const usageCostMinor = costsByUsage.get(reservation.usageRequestId) || 0
      if (usageCostMinor < reservation.baseCostMinor) {
        throw new AppError(
          503,
          'external_platform_cost_evidence_incomplete',
          'External data cost evidence is incomplete; paid dispatch is disabled',
        )
      }
      const consumedCostMinor = usageCostMinor - reservation.baseCostMinor
      reservedCostMinor += Math.max(0, reservation.reservedCostMinor - consumedCostMinor)
      const coverageMinor = coveredMinor(reservation.usageRequestId)
      const baseSubsidyMinor = Math.max(0, reservation.baseCostMinor - coverageMinor)
      const currentSubsidyMinor = Math.max(0, usageCostMinor - coverageMinor)
      const consumedSubsidyMinor = Math.max(0, currentSubsidyMinor - baseSubsidyMinor)
      reservedSubsidyMinor += Math.max(
        0,
        reservation.reservedSubsidyMinor - consumedSubsidyMinor,
      )
    }
    if (![knownCostMinor, reservedCostMinor, reservedSubsidyMinor, subsidyCostMinor]
      .every(Number.isSafeInteger)) {
      throw new AppError(
        503,
        'external_platform_cost_evidence_incomplete',
        'External data cost evidence is incomplete; paid dispatch is disabled',
      )
    }
    return {
      activeReservations,
      costsByUsage,
      coveredMinor,
      knownCostMinor,
      reservedCostMinor,
      reservedSubsidyMinor,
      subsidyCostMinor,
    }
  }

  // What the monthly procurement cap looks like right now, read-only.
  //
  // The cap is only ever evaluated while dispatching, so until now the console
  // could show an operation as "可调用" -- correctly, because configuration,
  // credential, release and price evidence were all fine -- while every call
  // was refused for having spent the month's budget. Reporting a readiness the
  // gateway does not honour is the failure this whole view exists to prevent.
  //
  // Deliberately non-throwing: #costState fails closed on incomplete evidence
  // because it guards real money, but a diagnostic that throws would blank the
  // very page an operator opened to find out what is wrong. Evidence problems
  // are reported as an unknown spend instead.
  describeCostBudget(costControl) {
    const budgetMinor = costControl?.monthlyBudgetMinor
    if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) return null
    let knownCostMinor = null
    let reservedCostMinor = null
    try {
      const state = this.#costState(costControl, { customerBilled: false })
      knownCostMinor = state.knownCostMinor
      reservedCostMinor = state.reservedCostMinor
    } catch {
      // Cost evidence is incomplete. The budget is still worth reporting; what
      // cannot be stated is how much of it is already committed.
      return { budgetMinor, currency: costControl.currency ?? null, spentMinor: null, remainingMinor: null, exhausted: null }
    }
    const spentMinor = knownCostMinor + reservedCostMinor
    return {
      budgetMinor,
      currency: costControl.currency ?? null,
      spentMinor,
      // Mirrors the admission comparison in reserveProviderCostWorkflow: a
      // request is refused when spend plus its own cost would exceed the cap,
      // so a budget with nothing left over admits nothing.
      remainingMinor: Math.max(0, budgetMinor - spentMinor),
      exhausted: spentMinor >= budgetMinor,
    }
  }

  #isCustomerBilledRequest(usageRequestId) {
    const usage = this.usageStore?.requests?.get?.(usageRequestId)
    const charge = this.usageStore?.customerCharges?.get?.(usageRequestId)
    return isReservedCustomerBilledRequest(this.usageStore, usage, charge)
  }

  async reserveProviderCostWorkflow(input) {
    const usage = this.usageStore?.requests?.get(input.usageRequestId)
    const leaseExpiresAt = usage?.leaseExpiresAt == null
      ? null
      : new Date(usage.leaseExpiresAt).getTime()
    if (!usage
      || usage.status !== 'reserved'
      || usage.tenantId !== input.tenantId
      || usage.consumerId !== input.consumerId
      || usage.apiKeyId !== input.apiKeyId
      || usage.fingerprint !== input.fingerprint
      || usage.platform !== this.authorizationPlatform
      || (leaseExpiresAt != null && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()))) {
      throw new AppError(
        409,
        'external_platform_usage_scope_mismatch',
        'Cost reservation does not match its reserved usage request',
      )
    }
    if (!Array.isArray(input.costControls) || input.costControls.length < 1
      || input.costControls.length > 64) {
      throw new TypeError('costControls must contain 1-64 provider dispatch costs')
    }
    const controls = input.costControls.map(normalizedCostControl)
    const policy = controls[0]
    if (controls.some((control) => (
      control.currency !== policy.currency
      || control.monthlyBudgetMinor !== policy.monthlyBudgetMinor
      || control.monthlySubsidyBudgetMinor !== policy.monthlySubsidyBudgetMinor
    ))) {
      throw new TypeError('workflow costs must share one currency and budget policy')
    }
    const costMinor = controls.reduce((sum, control) => sum + control.costMinor, 0)
    if (!Number.isSafeInteger(costMinor)) {
      throw new TypeError('workflow cost exceeds the safe-integer range')
    }
    const customerBilled = this.#isCustomerBilledRequest(input.usageRequestId)
    const state = this.#costState(policy, {
      customerBilled,
      usageRequestId: input.usageRequestId,
    })
    if (state.activeReservations.some(
      (reservation) => reservation.usageRequestId === input.usageRequestId,
    )) {
      throw new AppError(
        409,
        'external_platform_cost_reservation_exists',
        'Usage request already has an active provider cost reservation',
      )
    }
    if (!customerBilled
      && state.knownCostMinor + state.reservedCostMinor + costMinor > policy.monthlyBudgetMinor) {
      throw new AppError(
        429,
        'external_platform_cost_budget_exhausted',
        'External data monthly procurement budget is exhausted',
      )
    }
    const baseCostMinor = state.costsByUsage.get(input.usageRequestId) || 0
    const coverageMinor = state.coveredMinor(input.usageRequestId)
    const subsidyMinor = Math.max(0, baseCostMinor + costMinor - coverageMinor)
      - Math.max(0, baseCostMinor - coverageMinor)
    if (!customerBilled
      && state.subsidyCostMinor + state.reservedSubsidyMinor + subsidyMinor
      > policy.monthlySubsidyBudgetMinor) {
      throw new AppError(
        429,
        'external_platform_subsidy_budget_exhausted',
        'External data customer-price coverage or subsidy budget is exhausted',
      )
    }
    const reservation = {
      id: input.id ?? randomUUID(),
      providerKey: this.providerKey,
      tenantId: input.tenantId,
      consumerId: input.consumerId,
      apiKeyId: input.apiKeyId,
      usageRequestId: input.usageRequestId,
      fingerprint: input.fingerprint,
      currency: policy.currency,
      baseCostMinor,
      reservedCostMinor: costMinor,
      reservedSubsidyMinor: subsidyMinor,
      monthlyBudgetMinor: policy.monthlyBudgetMinor,
      monthlySubsidyBudgetMinor: policy.monthlySubsidyBudgetMinor,
      status: 'active',
      createdAt: iso(),
      releasedAt: null,
    }
    if (this.costReservations.has(reservation.id)) {
      throw new AppError(409, 'external_platform_cost_reservation_exists', 'Cost reservation already exists')
    }
    this.costReservations.set(reservation.id, reservation)
    return clone(reservation)
  }

  async releaseProviderCostWorkflow({ reservationId, usageRequestId }) {
    const reservation = this.costReservations.get(reservationId)
    if (!reservation
      || reservation.providerKey !== this.providerKey
      || reservation.usageRequestId !== usageRequestId) return false
    if (reservation.status === 'released') return true
    reservation.status = 'released'
    reservation.releasedAt = iso()
    return true
  }

  async beginProviderCall(input) {
    const usage = this.usageStore?.requests?.get(input.usageRequestId)
    const leaseExpiresAt = usage?.leaseExpiresAt == null
      ? null
      : new Date(usage.leaseExpiresAt).getTime()
    if (
      !usage
      || usage.status !== 'reserved'
      || usage.tenantId !== input.tenantId
      || usage.consumerId !== input.consumerId
      || usage.apiKeyId !== input.apiKeyId
      || usage.fingerprint !== input.fingerprint
      || usage.platform !== this.authorizationPlatform
      || (leaseExpiresAt != null && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()))
    ) {
      throw new AppError(
        409,
        'external_platform_usage_scope_mismatch',
        'Provider call does not match its reserved usage request',
      )
    }
    if (input.retryOfRequestId) {
      const retryTarget = this.usageStore?.requests?.get(input.retryOfRequestId)
      const retryAlreadyUsed = [...this.calls.values()].some(
        (call) => call.retryOfRequestId === input.retryOfRequestId,
      )
      if (
        !retryTarget
        || retryTarget.status !== 'unknown'
        || retryTarget.tenantId !== input.tenantId
        || retryTarget.consumerId !== input.consumerId
        || (input.twitterManualRetry && retryTarget.apiKeyId !== input.apiKeyId)
        || retryTarget.platform !== this.authorizationPlatform
        || retryTarget.fingerprint !== input.fingerprint
        || retryAlreadyUsed
      ) {
        throw new AppError(
          409,
          'uncertain_retry_not_allowed',
          'The referenced uncertain request cannot authorize this retry',
        )
      }
    }
    const costControl = normalizedCostControl(input.costControl)
    const operationControl = normalizedOperationControl(input.operationControl, {
      providerKey: this.providerKey,
      operation: input.operation,
    })
    if (costControl) {
      const customerBilled = this.#isCustomerBilledRequest(input.usageRequestId)
      const state = this.#costState(costControl, {
        customerBilled,
        usageRequestId: input.usageRequestId,
      })
      const existingUsageCostMinor = state.costsByUsage.get(input.usageRequestId) || 0
      const customerCoverageMinor = state.coveredMinor(input.usageRequestId)
      const reservation = input.costReservationId == null
        ? null
        : state.activeReservations.find((candidate) => candidate.id === input.costReservationId)
      if (input.costReservationId != null) {
        if (!reservation
          || reservation.usageRequestId !== input.usageRequestId
          || reservation.tenantId !== input.tenantId
          || reservation.consumerId !== input.consumerId
          || reservation.apiKeyId !== input.apiKeyId
          || reservation.fingerprint !== input.fingerprint
          || reservation.currency !== costControl.currency
          || reservation.monthlyBudgetMinor !== costControl.monthlyBudgetMinor
          || reservation.monthlySubsidyBudgetMinor !== costControl.monthlySubsidyBudgetMinor
          || existingUsageCostMinor + costControl.costMinor
            > reservation.baseCostMinor + reservation.reservedCostMinor) {
          throw new AppError(
            409,
            'external_platform_cost_reservation_mismatch',
            'Provider call does not match its active cost reservation',
          )
        }
        const baseSubsidyMinor = Math.max(
          0,
          reservation.baseCostMinor - customerCoverageMinor,
        )
        const projectedSubsidyMinor = Math.max(
          0,
          existingUsageCostMinor + costControl.costMinor - customerCoverageMinor,
        )
        if (projectedSubsidyMinor
          > baseSubsidyMinor + reservation.reservedSubsidyMinor) {
          throw new AppError(
            409,
            'external_platform_cost_reservation_mismatch',
            'Provider call exceeds its reserved subsidy exposure',
          )
        }
      } else {
        if (!customerBilled
          && state.knownCostMinor + state.reservedCostMinor + costControl.costMinor
          > costControl.monthlyBudgetMinor) {
          throw new AppError(
            429,
            'external_platform_cost_budget_exhausted',
            'External data monthly procurement budget is exhausted',
          )
        }
        const incrementalSubsidyMinor = Math.max(
          0,
          existingUsageCostMinor + costControl.costMinor - customerCoverageMinor,
        ) - Math.max(0, existingUsageCostMinor - customerCoverageMinor)
        if (!customerBilled
          && state.subsidyCostMinor + state.reservedSubsidyMinor + incrementalSubsidyMinor
          > costControl.monthlySubsidyBudgetMinor) {
          throw new AppError(
            429,
            'external_platform_subsidy_budget_exhausted',
            'External data customer-price coverage or subsidy budget is exhausted',
          )
        }
      }
    }
    const id = input.id ?? randomUUID()
    const callOrdinal = input.callOrdinal ?? 0
    if (!Number.isSafeInteger(callOrdinal) || callOrdinal < 0) {
      throw new TypeError('callOrdinal must be a non-negative safe integer')
    }
    const callRole = input.callRole ?? (callOrdinal === 0 ? 'primary' : 'enrichment')
    if (!['primary', 'enrichment', 'retry'].includes(callRole)) {
      throw new TypeError('callRole must be primary, enrichment or retry')
    }
    const dispatchFingerprint = input.dispatchFingerprint ?? input.fingerprint
    if (typeof dispatchFingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(dispatchFingerprint)) {
      throw new TypeError('dispatchFingerprint must be a lowercase SHA-256 fingerprint')
    }
    if (
      this.calls.has(id)
      || [...this.calls.values()].some((call) => (
        call.usageRequestId === input.usageRequestId && call.callOrdinal === callOrdinal
      ))
    ) {
      throw new AppError(409, 'external_platform_call_exists', 'Usage request call ordinal already exists')
    }
    const {
      costControl: _costControl,
      costReservationId: _costReservationId,
      operationControl: _operationControl,
      ...callInput
    } = input
    const call = {
      id,
      ...clone(callInput),
      callOrdinal,
      callRole,
      dispatchFingerprint,
      providerKey: this.providerKey,
      ...(operationControl ? {
        operationPolicyRevision: operationControl.policyRevision,
        operationReleaseRevision: operationControl.releaseRevision,
        providerPriceBookVersion: operationControl.priceBookVersion,
        providerCredentialRevision: operationControl.credentialRevision,
      } : {}),
      outcome: 'pending',
      ...(costControl ? {
        costMinor: costControl.costMinor,
        costKind: costControl.costKind,
        currency: costControl.currency,
      } : {}),
      startedAt: iso(),
      completedAt: null,
    }
    if (input.twitterManualRetry) await twitterRetryStore.claimTwitterManualRetry(this, twitterRetryInput(input))
    this.calls.set(call.id, call)
    this.state.lastCallAt = call.startedAt
    return clone(call)
  }

  async stageProviderEvidence(input) {
    const evidence = validateStagedEvidence(input)
    const call = this.calls.get(input.callId)
    if (!call || !memoryCallScopeMatches(call, input.delivery, this.providerKey)) {
      throw evidenceConflict()
    }
    if (call.stagedEvidence) {
      if (!isDeepStrictEqual(call.stagedEvidence, evidence)) throw evidenceConflict()
      return {
        staged: true,
        reconciled: true,
        alreadySettled: call.outcome !== 'pending',
      }
    }
    if (call.outcome !== 'pending') throw evidenceConflict()

    // Clone the entire receipt before mutating the call. This makes repeated
    // staging exact-idempotent and prevents a caller from changing archived
    // evidence after the method returns.
    Object.assign(call, {
      httpStatus: evidence.httpStatus,
      businessCode: evidence.businessCode,
      upstreamRequestId: evidence.upstreamRequestId,
      upstreamRecordTime: evidence.upstreamRecordTime,
      billed: evidence.billed,
      costMinor: evidence.costMinor,
      costKind: evidence.costKind,
      currency: evidence.currency,
      latencyMs: evidence.latencyMs,
      itemCount: evidence.itemCount,
      errorCode: evidence.errorCode,
      archiveObjects: clone(evidence.archiveObjects),
      stagedEvidence: cloneNormalizedEvidence(evidence),
    })
    this.responseArchives.set(input.callId, clone(evidence.responseArchive))
    if (evidence.restrictedResponseArchive) {
      this.restrictedResponseArchives.set(
        input.callId,
        normalizedRestrictedResponseArchive(evidence.restrictedResponseArchive),
      )
    }
    return { staged: true, reconciled: false, alreadySettled: false }
  }

  async commitLiveDelivery({
    callId,
    delivery,
    responseBody,
    snapshotBody = responseBody,
    capturedAt,
    freshUntil,
    staleUntil,
    itemCount,
    latencyMs,
    usageLatencyMs = latencyMs,
    usageUnitsActual = Math.max(1, itemCount),
    billed,
    costMinor,
    costKind,
    currency,
    archiveObjects = [],
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    ingestJob = null,
  }) {
    const exactArchive = normalizedRestrictedResponseArchive(restrictedResponseArchive)
    const call = this.calls.get(callId)
    if (!call || call.outcome !== 'pending') {
      throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
    }
    await this.usageStore.commitRequest(delivery.usageRequestId, {
      responseStatus: 200,
      responseBody,
      unitsActual: Math.max(1, usageUnitsActual),
      upstreamLatencyMs: usageLatencyMs,
      deliverySourceMode: 'live',
      capturedAt: iso(capturedAt),
    })
    Object.assign(call, {
      outcome: 'succeeded',
      httpStatus: responseArchive?.httpStatus ?? 200,
      businessCode: responseArchive?.businessCode ?? 0,
      upstreamRequestId: upstreamEvidence?.requestId ?? null,
      upstreamRecordTime: upstreamEvidence?.recordTime ?? null,
      billed,
      costMinor,
      costKind,
      currency,
      latencyMs,
      itemCount,
      archiveObjects: clone(archiveObjects),
      completedAt: iso(),
    })
    if (responseArchive) this.responseArchives.set(callId, clone(responseArchive))
    if (exactArchive) this.restrictedResponseArchives.set(callId, exactArchive)
    const key = snapshotKey(delivery)
    const snapshot = {
      id: this.snapshots.get(key)?.id ?? randomUUID(),
      providerKey: this.providerKey,
      consumerId: delivery.consumerId,
      operation: delivery.operation,
      fingerprint: snapshotFingerprint(delivery),
      responseBody: clone(snapshotBody),
      capturedAt: iso(capturedAt),
      freshUntil: iso(freshUntil),
      staleUntil: iso(staleUntil),
      lastSuccessCallId: callId,
    }
    this.snapshots.set(key, snapshot)
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode: 'live',
      succeeded: true,
      responseStatus: 200,
      providerCallId: callId,
      snapshotId: snapshot.id,
    }))
    if (ingestJob) {
      const queue = ingestJob.queue || 'mx-insight-hub:ingest'
      if (!ingestJob.dedupeKey || !this.ingestJobs.some((job) => (
        job.queue === queue && job.dedupeKey === ingestJob.dedupeKey
      ))) {
        this.ingestJobs.push(clone({
          queue,
          payload: ingestJob.payload,
          dedupeKey: ingestJob.dedupeKey ?? null,
          priority: ingestJob.priority ?? 100,
        }))
      }
    }
    this.#recordSuccess(call)
    return { snapshot: clone(snapshot) }
  }

  async finishProviderStep({
    callId,
    delivery,
    outcome,
    httpStatus = null,
    businessCode = null,
    billed = null,
    costMinor = null,
    costKind = 'unknown',
    currency = null,
    latencyMs = null,
    itemCount = null,
    errorCode = null,
    affectsCircuit = true,
    // Which breaker a failure belongs to: 'contract' faults are scoped to the
    // marketplace, everything else is provider-wide.
    circuitCategory = null,
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    archiveObjects = [],
    snapshot = null,
    ingestJob = null,
  }) {
    const exactArchive = normalizedRestrictedResponseArchive(restrictedResponseArchive)
    if (!FINISHED_PROVIDER_OUTCOMES.has(outcome)) {
      throw new TypeError('outcome must be a finished provider-call outcome')
    }
    if (snapshot && outcome !== 'succeeded') {
      throw new TypeError('only a succeeded provider step may write a snapshot')
    }
    const call = this.calls.get(callId)
    if (!call || call.outcome !== 'pending') {
      throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
    }
    Object.assign(call, {
      outcome,
      httpStatus: responseArchive?.httpStatus ?? httpStatus,
      businessCode: responseArchive?.businessCode ?? businessCode,
      upstreamRequestId: upstreamEvidence?.requestId ?? null,
      upstreamRecordTime: upstreamEvidence?.recordTime ?? null,
      billed,
      costMinor,
      costKind,
      currency,
      latencyMs,
      itemCount,
      errorCode,
      archiveObjects: clone(archiveObjects),
      completedAt: iso(),
    })
    if (responseArchive) this.responseArchives.set(callId, clone(responseArchive))
    if (exactArchive) this.restrictedResponseArchives.set(callId, exactArchive)

    let storedSnapshot = null
    if (snapshot) {
      const key = snapshotKey(delivery)
      storedSnapshot = {
        id: this.snapshots.get(key)?.id ?? randomUUID(),
        providerKey: this.providerKey,
        consumerId: delivery.consumerId,
        operation: delivery.operation,
        fingerprint: snapshotFingerprint(delivery),
        responseBody: clone(snapshot.responseBody),
        capturedAt: iso(snapshot.capturedAt),
        freshUntil: iso(snapshot.freshUntil),
        staleUntil: iso(snapshot.staleUntil),
        lastSuccessCallId: callId,
      }
      this.snapshots.set(key, storedSnapshot)
    }
    if (ingestJob) {
      const queue = ingestJob.queue || 'mx-insight-hub:ingest'
      if (!ingestJob.dedupeKey || !this.ingestJobs.some((job) => (
        job.queue === queue && job.dedupeKey === ingestJob.dedupeKey
      ))) {
        this.ingestJobs.push(clone({
          queue,
          payload: ingestJob.payload,
          dedupeKey: ingestJob.dedupeKey ?? null,
          priority: ingestJob.priority ?? 100,
        }))
      }
    }
    if (outcome === 'succeeded') {
      this.#recordSuccess(call)
      // A marketplace that parses again is no longer the one that was broken.
      const scoped = this.contractCircuits.get(call.marketplace)
      if (scoped && new Date(scoped.lastFailureAt) <= new Date(call.startedAt)) {
        this.contractCircuits.delete(call.marketplace)
      }
    } else if (affectsCircuit) {
      this.#recordFailure(errorCode, { circuitCategory, scope: call.marketplace ?? null })
    }
    return { snapshot: clone(storedSnapshot) }
  }

  async commitSnapshotDelivery({
    delivery,
    snapshot,
    sourceMode,
    shared = false,
    responseBody = snapshot.responseBody,
    usageUnitsActual = Math.max(1, deliveredItemCount(responseBody)),
  }) {
    const current = shared && delivery.operation === 'social.posts.analytics'
      ? [...this.snapshots.values()].find(row => row.id === snapshot.id && row.providerKey === this.providerKey
        && row.operation === delivery.operation && row.fingerprint === snapshotFingerprint(delivery) && new Date(row.staleUntil) >= new Date())
      : this.snapshots.get(snapshotKey(delivery))
    if (!current || current.id !== snapshot.id) {
      throw new AppError(409, 'external_platform_snapshot_unavailable', 'Stored response is unavailable')
    }
    await this.usageStore.commitRequest(delivery.usageRequestId, {
      responseStatus: 200,
      responseBody,
      unitsActual: Math.max(1, usageUnitsActual),
      upstreamLatencyMs: 0,
      deliverySourceMode: sourceMode === 'stored_fallback' ? 'stale' : 'live',
      capturedAt: current.capturedAt,
    })
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode,
      succeeded: true,
      responseStatus: 200,
      snapshotId: current.id,
    }))
  }

  #recordSuccess(call) {
    this.state.lastSuccessAt = call.completedAt
    // A search settles after its enrichment children. Its earlier success
    // cannot prove recovery from a failure observed since that call started.
    if (!this.state.lastFailureAt || new Date(this.state.lastFailureAt) <= new Date(call.startedAt)) {
      Object.assign(this.state, { consecutiveFailures: 0, circuitOpenUntil: null, lastErrorCode: null })
    }
  }

  #recordFailure(errorCode, { circuitCategory = null, scope = null } = {}) {
    // A contract failure is ours, and it is specific to the marketplace whose
    // response we could not read, so it opens only that marketplace's breaker.
    // Everything else -- authentication, capacity, balance, transport -- really
    // is a provider-wide condition and keeps the provider-wide breaker.
    if (circuitCategory === 'contract' && scope) {
      const current = this.contractCircuits.get(scope)
      const failures = (current?.consecutiveFailures ?? 0) + 1
      this.contractCircuits.set(scope, {
        providerKey: this.providerKey,
        scope,
        consecutiveFailures: failures,
        lastFailureAt: iso(),
        lastErrorCode: errorCode,
        circuitOpenUntil: failures >= this.circuitFailureThreshold
          ? iso(Date.now() + this.circuitOpenMs)
          : current?.circuitOpenUntil ?? null,
      })
      return
    }
    const failures = this.state.consecutiveFailures + 1
    Object.assign(this.state, {
      consecutiveFailures: failures,
      lastFailureAt: iso(),
      lastErrorCode: errorCode,
      ...(failures >= this.circuitFailureThreshold
        ? { circuitOpenUntil: iso(Date.now() + this.circuitOpenMs) }
        : {}),
    })
  }

  async finishFailure({
    callId,
    delivery,
    outcome,
    httpStatus,
    businessCode,
    billed,
    costMinor = null,
    costKind = 'unknown',
    currency = null,
    latencyMs,
    errorCode,
    failureResponseStatus = 502,
    failureResponseBody = null,
    affectsCircuit = true,
    // Which breaker a failure belongs to: 'contract' faults are scoped to the
    // marketplace, everything else is provider-wide.
    circuitCategory = null,
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    archiveObjects = [],
    snapshot = null,
    fallbackResponseBody = snapshot?.responseBody,
    usageUnitsActual = Math.max(1, deliveredItemCount(fallbackResponseBody)),
  }) {
    const exactArchive = normalizedRestrictedResponseArchive(restrictedResponseArchive)
    const call = this.calls.get(callId)
    if (!call || call.outcome !== 'pending') {
      throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
    }
    const currentSnapshot = snapshot ? this.snapshots.get(snapshotKey(delivery)) : null
    if (snapshot && (!currentSnapshot || currentSnapshot.id !== snapshot.id)) {
      throw new AppError(409, 'external_platform_snapshot_unavailable', 'Stored response is unavailable')
    }
    if (snapshot) {
      await this.usageStore.commitRequest(delivery.usageRequestId, {
        responseStatus: 200,
        responseBody: fallbackResponseBody,
        unitsActual: Math.max(1, usageUnitsActual),
        upstreamLatencyMs: latencyMs,
        deliverySourceMode: 'stale',
        capturedAt: currentSnapshot.capturedAt,
      })
    } else if ((this.providerKey === 'qixin' && outcome === 'rejected')
      || (this.providerKey === 'baidu-ip' && (outcome === 'rejected' || outcome === 'succeeded_unusable'))) {
      // No customer result was delivered. Keep the error for exact replay
      // while releasing the customer hold; supplier billing remains unknown.
      await this.usageStore.releaseRequest(delivery.usageRequestId, errorCode, {
        responseStatus: failureResponseStatus,
        responseBody: failureResponseBody || {
          error: { code: errorCode, message: 'External data platform rejected the request' },
        },
        upstreamLatencyMs: latencyMs,
        deliverySourceMode: 'live',
        capturedAt: iso(responseArchive?.capturedAt ?? new Date()),
      })
    } else if (this.providerKey === 'ipsearch' && (outcome === 'rejected' || outcome === 'succeeded_unusable')) {
      // A definitive failed IP query has no customer delivery to charge.
      await this.usageStore.releaseRequest(delivery.usageRequestId, errorCode)
    } else if (outcome === 'rejected' || outcome === 'succeeded_unusable') {
      await this.usageStore.commitRequest(delivery.usageRequestId, {
        responseStatus: failureResponseStatus,
        responseBody: failureResponseBody || {
          error: { code: errorCode, message: 'External data platform rejected the request' },
        },
        unitsActual: 0,
        upstreamLatencyMs: latencyMs,
        deliverySourceMode: 'live',
        capturedAt: iso(responseArchive?.capturedAt ?? new Date()),
      })
    } else {
      await this.usageStore.markRequestUnknown(delivery.usageRequestId, errorCode)
    }
    Object.assign(call, {
      outcome,
      httpStatus,
      businessCode,
      billed,
      costMinor,
      costKind,
      currency,
      upstreamRequestId: upstreamEvidence?.requestId ?? null,
      upstreamRecordTime: upstreamEvidence?.recordTime ?? null,
      latencyMs,
      errorCode,
      archiveObjects: clone(archiveObjects),
      completedAt: iso(),
    })
    if (responseArchive) this.responseArchives.set(callId, clone(responseArchive))
    if (exactArchive) this.restrictedResponseArchives.set(callId, exactArchive)
    if (affectsCircuit) {
      this.#recordFailure(errorCode, { circuitCategory, scope: delivery?.marketplace ?? null })
    }
    if (snapshot) {
      this.requests.push(requestEvent({
        ...delivery,
        providerKey: this.providerKey,
        sourceMode: 'stored_fallback',
        succeeded: true,
        responseStatus: 200,
        providerCallId: callId,
        snapshotId: currentSnapshot.id,
        errorCode,
      }))
      return
    }
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode: 'unavailable',
      succeeded: false,
      responseStatus: failureResponseStatus,
      providerCallId: callId,
      errorCode,
    }))
  }

  async rejectWithoutDispatch({ delivery, sourceMode, status, errorCode }) {
    await this.usageStore.releaseRequest(delivery.usageRequestId, errorCode)
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode,
      succeeded: false,
      responseStatus: status,
      errorCode,
    }))
  }

  async markPersistenceUnknown({
    callId,
    delivery,
    billed = null,
    costMinor = null,
    costKind = 'unknown',
    currency = null,
    latencyMs = null,
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    archiveObjects = [],
    errorCode = 'external_platform_persistence_unknown',
  }) {
    const exactArchive = normalizedRestrictedResponseArchive(restrictedResponseArchive)
    const call = this.calls.get(callId)
    if (!call || call.outcome !== 'pending') return false
    await this.usageStore.markRequestUnknown(delivery.usageRequestId, errorCode)
    Object.assign(call, {
      outcome: 'unknown',
      billed,
      costMinor,
      costKind,
      currency,
      latencyMs,
      upstreamRequestId: upstreamEvidence?.requestId ?? null,
      upstreamRecordTime: upstreamEvidence?.recordTime ?? null,
      errorCode,
      archiveObjects: clone(archiveObjects),
      completedAt: iso(),
    })
    if (responseArchive) this.responseArchives.set(callId, clone(responseArchive))
    if (exactArchive) this.restrictedResponseArchives.set(callId, exactArchive)
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode: 'unavailable',
      succeeded: false,
      responseStatus: 503,
      providerCallId: callId,
      errorCode,
    }))
    return true
  }

  async recordReplay({
    delivery,
    sourceMode = 'idempotent_replay',
    succeeded = true,
    status = 200,
    errorCode = null,
  }) {
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode,
      succeeded,
      responseStatus: status,
      errorCode,
    }))
  }

  async recordGatewayAttempt({ delivery, sourceMode, succeeded, status, errorCode = null }) {
    this.requests.push(requestEvent({
      ...delivery,
      providerKey: this.providerKey,
      sourceMode,
      succeeded,
      responseStatus: status,
      errorCode,
    }))
  }

  async analytics({ from }) {
    const requests = rangeRows(this.requests, from)
    const calls = rangeRows([...this.calls.values()], from)
    return analyticsFromRows(requests, calls, this.state)
  }
}

function canStartBestEffortCleanup(pool) {
  // Cleanup must not queue behind business reads/writes or open a connection.
  // pg-pool queues an idle checkout synchronously, so the next cleanup sees
  // waitingCount before attempting to use that same idle connection.
  return (typeof pool.idleCount !== 'number' || pool.idleCount > 0)
    && !(pool.waitingCount > 0)
}

// Folding finished usage requests into provider_cost_month_totals keeps the
// admission read small. It is opportunistic housekeeping: correctness never
// depends on it, so it only starts on a real pool with an idle connection, at
// most every few seconds per provider, and is never awaited by a request.
const COST_LEDGER_FOLD_INTERVAL_MS = 5_000
const COST_LEDGER_FOLD_LIMIT = 2_000
const costLedgerFolds = new WeakMap()

function costLedgerLockKey(providerKey) {
  return `external-platform-cost-ledger:${providerKey}`
}

// One statement, one snapshot. A usage request is folded only when nothing can
// change its contribution any more (see migration 163) and its evidence has no
// anomaly; the DELETE ... RETURNING set is exactly what is added to the totals.
const FOLD_PROVIDER_COST_LEDGER_SQL = `
  WITH candidates AS MATERIALIZED (
    SELECT open_usage.provider_key, open_usage.month, open_usage.usage_request_id
      FROM external_platform.provider_cost_open_usages open_usage
      JOIN usage_requests request ON request.id = open_usage.usage_request_id
      LEFT JOIN billing.customer_charges charge
        ON charge.usage_request_id = open_usage.usage_request_id
     WHERE open_usage.provider_key = $1
       -- Calls are only inserted for a reserved usage row; it never returns.
       AND request.status <> 'reserved'
       -- Coverage is final: charges are only created with the usage row, and
       -- pricing is immutable once captured or released.
       AND (charge.id IS NULL OR charge.enforcement_mode <> 'enforced'
         OR charge.status IN ('captured', 'released'))
       AND NOT EXISTS (
         SELECT 1
           FROM external_platform.provider_calls call
          WHERE call.usage_request_id = open_usage.usage_request_id
            AND call.provider_key = open_usage.provider_key
            AND call.started_at >= open_usage.month::timestamp AT TIME ZONE 'UTC'
            AND call.started_at < (open_usage.month + interval '1 month') AT TIME ZONE 'UTC'
            AND (
              -- Settlement may still rewrite this call's cost evidence.
              call.outcome = 'pending'
              -- Anomalies stay open so admission keeps counting them live.
              OR (call.cost_kind <> 'unknown'
                AND (call.cost_minor IS NULL OR call.cost_minor <= 0))
              OR (call.cost_minor IS NOT NULL
                AND (call.currency IS NULL OR call.currency !~ '^[A-Z]{3}$'))
            )
       )
     ORDER BY open_usage.month, open_usage.usage_request_id
     LIMIT $2
     FOR UPDATE OF open_usage SKIP LOCKED
  ), folded AS (
    DELETE FROM external_platform.provider_cost_open_usages open_usage
     USING candidates
     WHERE open_usage.provider_key = candidates.provider_key
       AND open_usage.month = candidates.month
       AND open_usage.usage_request_id = candidates.usage_request_id
    RETURNING open_usage.provider_key, open_usage.month, open_usage.usage_request_id
  ), usage_costs AS (
    SELECT folded.provider_key, folded.month, call.currency, folded.usage_request_id,
           sum(call.cost_minor)::bigint AS cost_minor
      FROM folded
      JOIN external_platform.provider_calls call
        ON call.usage_request_id = folded.usage_request_id
       AND call.provider_key = folded.provider_key
       AND call.started_at >= folded.month::timestamp AT TIME ZONE 'UTC'
       AND call.started_at < (folded.month + interval '1 month') AT TIME ZONE 'UTC'
     WHERE call.cost_minor IS NOT NULL
     GROUP BY folded.provider_key, folded.month, call.currency, folded.usage_request_id
  ), contributions AS (
    SELECT usage_cost.provider_key, usage_cost.month, usage_cost.currency,
           count(*)::bigint AS usages,
           sum(usage_cost.cost_minor)::bigint AS known_cost_minor,
           -- Same coverage rule as admission's subsidy exposure.
           sum(greatest(usage_cost.cost_minor - CASE
                 WHEN charge.enforcement_mode = 'enforced'
                  AND charge.status IN ('reserved', 'captured', 'unknown')
                  AND charge.currency = usage_cost.currency
                 THEN charge.quoted_minor
                 ELSE 0
               END, 0))::bigint AS subsidy_cost_minor
      FROM usage_costs usage_cost
      LEFT JOIN billing.customer_charges charge
        ON charge.usage_request_id = usage_cost.usage_request_id
     GROUP BY usage_cost.provider_key, usage_cost.month, usage_cost.currency
  ), totals AS (
    INSERT INTO external_platform.provider_cost_month_totals AS total
      (provider_key, month, currency, folded_usages, known_cost_minor, subsidy_cost_minor)
    SELECT provider_key, month, currency, usages, known_cost_minor, subsidy_cost_minor
      FROM contributions
    ON CONFLICT (provider_key, month, currency) DO UPDATE SET
      folded_usages = total.folded_usages + EXCLUDED.folded_usages,
      known_cost_minor = total.known_cost_minor + EXCLUDED.known_cost_minor,
      subsidy_cost_minor = total.subsidy_cost_minor + EXCLUDED.subsidy_cost_minor,
      updated_at = now()
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM folded)::integer AS folded_usages,
         (SELECT count(*) FROM totals)::integer AS updated_totals`

async function transaction(pool, operation) {
  const client = await pool.connect()
  let commitStarted = false
  let committed = false
  let releaseError = null
  try {
    await client.query('BEGIN')
    const result = await operation(client)
    commitStarted = true
    await client.query('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (commitStarted && !committed) releaseError = error
    else await client.query('ROLLBACK').catch(error => { releaseError = error })
    throw error
  } finally {
    client.release(releaseError)
  }
}

// The month's procurement exposure as admission reads it. Finished usage
// requests are folded into provider_cost_month_totals (migration 163); only
// open ones are aggregated from provider_calls, so the read is O(open + active
// reservations) instead of O(month). Folded requests have no anomalous
// evidence and are never the current reserved request or an active
// reservation, so every column equals the full-month aggregate.
export async function providerCostExposure(client, {
  providerKey,
  usageRequestId,
  currency,
  reservationId = null,
}) {
  const exposure = await client.query(
    `WITH month_bounds AS MATERIALIZED (
       SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date AS month,
              date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                AS starts_at,
              (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')
                AT TIME ZONE 'UTC' AS ends_at
     ), open_usages AS MATERIALIZED (
       SELECT open_usage.usage_request_id
         FROM external_platform.provider_cost_open_usages open_usage
         JOIN month_bounds ON open_usage.month = month_bounds.month
        WHERE open_usage.provider_key = $1
     ), monthly_calls AS MATERIALIZED (
       SELECT call.usage_request_id, call.cost_minor, call.cost_kind, call.currency
         FROM open_usages
         JOIN external_platform.provider_calls call
           ON call.usage_request_id = open_usages.usage_request_id
         JOIN month_bounds
           ON call.started_at >= month_bounds.starts_at
          AND call.started_at < month_bounds.ends_at
        WHERE call.provider_key = $1
          AND (call.currency = $2 OR call.usage_request_id = $3
            OR call.currency IS NULL OR call.currency !~ '^[A-Z]{3}$')
     ), current_calls AS MATERIALIZED (
       -- Read directly so the current request's own evidence never depends
       -- on whether it is still open.
       SELECT call.cost_minor, call.cost_kind, call.currency,
              EXISTS (SELECT 1 FROM open_usages WHERE usage_request_id = $3) AS open
         FROM external_platform.provider_calls call
         JOIN month_bounds
           ON call.started_at >= month_bounds.starts_at
          AND call.started_at < month_bounds.ends_at
        WHERE call.usage_request_id = $3 AND call.provider_key = $1
     ), folded AS MATERIALIZED (
       SELECT coalesce(sum(total.known_cost_minor), 0)::bigint AS known_cost_minor,
              coalesce(sum(total.subsidy_cost_minor), 0)::bigint AS subsidy_cost_minor
         FROM external_platform.provider_cost_month_totals total
         JOIN month_bounds ON total.month = month_bounds.month
        WHERE total.provider_key = $1 AND total.currency = $2
     ), usage_costs AS MATERIALIZED (
       SELECT usage_request_id, sum(cost_minor)::bigint AS cost_minor
         FROM monthly_calls
        WHERE cost_minor IS NOT NULL AND currency = $2
        GROUP BY usage_request_id
     ), subsidy_exposure AS (
       SELECT coalesce(sum(greatest(
                usage_cost.cost_minor - CASE
                  WHEN charge.enforcement_mode = 'enforced'
                   AND charge.status IN ('reserved', 'captured', 'unknown')
                   AND charge.currency = $2
                  THEN charge.quoted_minor
                  ELSE 0
                END,
                0
              )), 0)::bigint AS cost_minor
         FROM usage_costs usage_cost
         LEFT JOIN billing.customer_charges charge
           ON charge.usage_request_id = usage_cost.usage_request_id
     ), active_reservations AS MATERIALIZED (
       SELECT reservation.*,
              coalesce(usage_cost.cost_minor, 0)::bigint AS current_usage_cost_minor,
              CASE
                WHEN charge.enforcement_mode = 'enforced'
                 AND charge.status IN ('reserved', 'captured', 'unknown')
                 AND charge.currency = $2
                THEN charge.quoted_minor
                ELSE 0
              END::bigint AS customer_coverage_minor
         FROM external_platform.provider_cost_reservations reservation
         JOIN usage_requests request ON request.id = reservation.usage_request_id
         LEFT JOIN usage_costs usage_cost
           ON usage_cost.usage_request_id = reservation.usage_request_id
         LEFT JOIN billing.customer_charges charge
           ON charge.usage_request_id = reservation.usage_request_id
        WHERE reservation.provider_key = $1
          AND (reservation.currency = $2 OR reservation.usage_request_id = $3
            OR reservation.currency IS NULL OR reservation.currency !~ '^[A-Z]{3}$')
          AND reservation.status = 'active'
          AND request.status = 'reserved'
          AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
          AND reservation.created_at >= (
            date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
          AND reservation.created_at < (
            (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')
              AT TIME ZONE 'UTC'
          )
     )
     SELECT (
              SELECT coalesce(sum(cost_minor), 0)::bigint
                FROM monthly_calls
               WHERE cost_minor IS NOT NULL AND currency = $2
            ) + (SELECT known_cost_minor FROM folded) AS known_cost_minor,
            (
              SELECT count(*)::integer
                FROM monthly_calls
               WHERE (cost_kind <> 'unknown' AND (cost_minor IS NULL OR cost_minor <= 0))
                  OR (cost_minor IS NOT NULL AND currency IS DISTINCT FROM $2)
            ) + (
              SELECT count(*)::integer
                FROM current_calls
               WHERE NOT open
                 AND ((cost_kind <> 'unknown' AND (cost_minor IS NULL OR cost_minor <= 0))
                   OR (cost_minor IS NOT NULL AND currency IS DISTINCT FROM $2))
            ) AS unknown_cost_calls,
            (
              SELECT count(*)::integer
                FROM current_calls
               WHERE cost_kind IS NULL
                  OR cost_kind NOT IN ('estimated', 'provider_reported')
                  OR cost_minor IS NULL
                  OR cost_minor <= 0
                  OR currency IS DISTINCT FROM $2
            ) AS current_unknown_cost_calls,
            (SELECT cost_minor FROM subsidy_exposure)
              + (SELECT subsidy_cost_minor FROM folded) AS subsidy_cost_minor,
            (
              SELECT coalesce(sum(greatest(
                       reserved_cost_minor
                         - greatest(current_usage_cost_minor - base_cost_minor, 0),
                       0
                     )), 0)::bigint
                FROM active_reservations WHERE currency = $2
            ) AS reserved_cost_minor,
            (
              SELECT coalesce(sum(greatest(
                       reserved_subsidy_minor - greatest(
                         greatest(current_usage_cost_minor - customer_coverage_minor, 0)
                           - greatest(base_cost_minor - customer_coverage_minor, 0),
                         0
                       ),
                       0
                     )), 0)::bigint
                FROM active_reservations WHERE currency = $2
            ) AS reserved_subsidy_minor,
            (
              SELECT count(*)::integer
                FROM active_reservations
               WHERE currency <> $2
                  OR reserved_cost_minor <= 0
                  OR current_usage_cost_minor < base_cost_minor
            ) AS mixed_reservation_count,
            (
              SELECT count(*)::integer
                FROM active_reservations
               WHERE usage_request_id = $3
                 AND (
                   currency IS DISTINCT FROM $2
                   OR base_cost_minor < 0
                   OR reserved_cost_minor <= 0
                   OR reserved_subsidy_minor < 0
                   OR monthly_budget_minor < 0
                   OR monthly_subsidy_budget_minor < 0
                   OR current_usage_cost_minor < base_cost_minor
                 )
            ) AS current_mixed_reservation_count,
            coalesce((
              SELECT sum(cost_minor) FROM current_calls
               WHERE cost_minor IS NOT NULL AND currency = $2
            ), 0)::bigint AS usage_cost_minor,
            (
              SELECT quoted_minor FROM billing.customer_charges
               WHERE usage_request_id = $3
                 AND enforcement_mode = 'enforced'
                 AND status IN ('reserved', 'captured', 'unknown')
                 AND currency = $2
            ) AS customer_coverage_minor,
            EXISTS (
              SELECT 1
                FROM billing.customer_charges current_charge
                JOIN usage_requests current_request
                  ON current_request.id = current_charge.usage_request_id
                JOIN billing.credit_ledger_entries current_hold
                  ON current_hold.charge_id = current_charge.id
                 AND current_hold.usage_request_id = current_charge.usage_request_id
                 AND current_hold.account_id = current_charge.account_id
                 AND current_hold.tenant_id = current_charge.tenant_id
                 AND current_hold.kind = 'hold'
                 AND current_hold.amount_minor = current_charge.quoted_minor
                 AND current_hold.available_delta_minor = -current_charge.quoted_minor
                 AND current_hold.held_delta_minor = current_charge.quoted_minor
                 AND current_hold.currency = current_charge.currency
               WHERE current_charge.usage_request_id = $3
                 AND current_request.status = 'reserved'
                 AND current_charge.tenant_id = current_request.tenant_id
                 AND current_charge.consumer_id = current_request.consumer_id
                 AND current_charge.api_key_id = current_request.api_key_id
                 AND current_charge.meter_key = current_request.billing_meter_key
                 AND current_charge.enforcement_mode = 'enforced'
                 AND current_charge.status = 'reserved'
                 AND current_charge.billing_unit = 'request'
                 AND current_charge.quoted_minor > 0
                 AND current_charge.account_id IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                     FROM billing.credit_ledger_entries terminal_hold
                    WHERE terminal_hold.charge_id = current_charge.id
                      AND terminal_hold.kind IN ('capture', 'release')
                 )
            ) AS customer_billed,
            (SELECT id FROM active_reservations WHERE id = $4) AS reservation_id,
            (
              SELECT usage_request_id FROM active_reservations WHERE id = $4
            ) AS reservation_usage_request_id,
            (SELECT currency FROM active_reservations WHERE id = $4) AS reservation_currency,
            (
              SELECT base_cost_minor FROM active_reservations WHERE id = $4
            ) AS reservation_base_cost_minor,
            (
              SELECT reserved_cost_minor FROM active_reservations WHERE id = $4
            ) AS reservation_cost_minor,
            (
              SELECT reserved_subsidy_minor FROM active_reservations WHERE id = $4
            ) AS reservation_subsidy_minor,
            (
              SELECT monthly_budget_minor FROM active_reservations WHERE id = $4
            ) AS reservation_monthly_budget_minor,
            (
              SELECT monthly_subsidy_budget_minor FROM active_reservations WHERE id = $4
            ) AS reservation_monthly_subsidy_budget_minor`,
    [providerKey, currency, usageRequestId, reservationId],
  )
  return exposure.rows[0] || {}
}

// `serialize: false` is only for a call consuming its own reservation, which
// serializes on that reservation row instead (see beginProviderCall).
async function postgresProviderCostState(client, {
  providerKey,
  usageRequestId,
  currency,
  reservationId = null,
  serialize = true,
}) {
  if (serialize) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `external-platform-cost:${providerKey}`,
    ])
  }
  const row = await providerCostExposure(client, {
    providerKey, usageRequestId, currency, reservationId,
  })
  const customerBilled = row.customer_billed === true
  const knownCostMinor = customerBilled ? 0 : Number(row.known_cost_minor)
  const unknownCostCallsRaw = customerBilled
    ? row.current_unknown_cost_calls
    : row.unknown_cost_calls
  const mixedReservationCountRaw = customerBilled
    ? row.current_mixed_reservation_count
    : row.mixed_reservation_count
  const unknownCostCalls = unknownCostCallsRaw == null ? Number.NaN : Number(unknownCostCallsRaw)
  const mixedReservationCount = mixedReservationCountRaw == null
    ? Number.NaN
    : Number(mixedReservationCountRaw)
  const evidenceAnomalyCount = unknownCostCalls + mixedReservationCount
  if (![unknownCostCalls, mixedReservationCount, evidenceAnomalyCount]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    || evidenceAnomalyCount > 0
    || !Number.isSafeInteger(knownCostMinor)
    || knownCostMinor < 0) {
    throw new AppError(
      503,
      'external_platform_cost_evidence_incomplete',
      'External data cost evidence is incomplete; paid dispatch is disabled',
    )
  }
  const subsidyCostMinor = customerBilled ? 0 : Number(row.subsidy_cost_minor)
  const reservedCostMinor = customerBilled ? 0 : Number(row.reserved_cost_minor)
  const reservedSubsidyMinor = customerBilled ? 0 : Number(row.reserved_subsidy_minor)
  const usageCostMinor = Number(row.usage_cost_minor)
  const customerCoverageMinor = row.customer_coverage_minor == null
    ? 0
    : Number(row.customer_coverage_minor)
  if ([subsidyCostMinor, reservedCostMinor, reservedSubsidyMinor,
    usageCostMinor, customerCoverageMinor].some((value) => (
    !Number.isSafeInteger(value) || value < 0
  ))) {
    throw new AppError(
      503,
      'external_platform_cost_evidence_incomplete',
      'External data cost evidence is incomplete; paid dispatch is disabled',
    )
  }
  const reservation = row.reservation_id == null ? null : {
    id: row.reservation_id,
    usageRequestId: row.reservation_usage_request_id,
    currency: row.reservation_currency,
    baseCostMinor: Number(row.reservation_base_cost_minor),
    reservedCostMinor: Number(row.reservation_cost_minor),
    reservedSubsidyMinor: Number(row.reservation_subsidy_minor),
    monthlyBudgetMinor: Number(row.reservation_monthly_budget_minor),
    monthlySubsidyBudgetMinor: Number(row.reservation_monthly_subsidy_budget_minor),
  }
  if (reservation && [reservation.baseCostMinor, reservation.reservedCostMinor,
    reservation.reservedSubsidyMinor, reservation.monthlyBudgetMinor,
    reservation.monthlySubsidyBudgetMinor].some((value) => (
    !Number.isSafeInteger(value) || value < 0
  ))) {
    throw new AppError(
      503,
      'external_platform_cost_evidence_incomplete',
      'External data cost evidence is incomplete; paid dispatch is disabled',
    )
  }
  return {
    knownCostMinor,
    subsidyCostMinor,
    reservedCostMinor,
    reservedSubsidyMinor,
    usageCostMinor,
    customerCoverageMinor,
    customerBilled,
    reservation,
  }
}

function pgSnapshot(row) {
  if (!row) return null
  return {
    id: row.id,
    providerKey: row.provider_key,
    consumerId: row.consumer_id,
    operation: row.operation,
    fingerprint: row.request_fingerprint,
    responseBody: row.response_body,
    capturedAt: iso(row.captured_at),
    freshUntil: iso(row.fresh_until),
    staleUntil: iso(row.stale_until),
    lastSuccessCallId: row.last_success_call_id,
  }
}

export class PostgresExternalPlatformStore {
  constructor({
    pool,
    providerKey = 'justone',
    authorizationPlatform = 'ecommerce',
    queueName = 'mx-insight-hub:ingest',
    circuitFailureThreshold = 3,
    circuitOpenMs = 60_000,
    rateLimitBurst = null,
    uncertainCooldownMs = 15 * 60_000,
    responseQuarantineCooldownMs = Math.min(uncertainCooldownMs, 5 * 60_000),
  }) {
    this.pool = pool
    this.providerKey = providerKey
    this.authorizationPlatform = authorizationPlatform
    this.queueName = queueName
    this.circuitFailureThreshold = circuitFailureThreshold
    this.circuitOpenMs = circuitOpenMs
    this.rateLimitBurst = rateLimitBurst == null ? null : boundedRateLimit(rateLimitBurst, 'rateLimitBurst')
    this.uncertainCooldownMs = uncertainCooldownMs
    this.responseQuarantineCooldownMs = responseQuarantineCooldownMs
  }

  async instagramPageFor({ callId, tenantId, consumerId, apiKeyId, path }) {
    if (!instagramOperation(this.providerKey)) return null
    const { rows: [row] } = await this.pool.query(
      `SELECT raw.body_bytes, raw.body_sha256, raw.captured_at
         FROM external_platform.provider_calls call
         JOIN usage_requests request ON request.id = call.usage_request_id
         JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id = call.id
        WHERE call.id = $1 AND call.provider_key = $7 AND call.operation = $2
          AND call.endpoint_key = $2 AND call.contract_version = $8
          AND call.outcome = 'succeeded' AND call.completed_at >= now() - interval '24 hours'
          AND request.tenant_id = $3 AND request.consumer_id = $4 AND request.api_key_id = $5
          AND request.platform = 'instagram' AND request.status = 'committed' AND request.response_status = 200
          AND request.acquisition_request->>'path' = $6 AND raw.body_size <= 8388608`,
      [callId, instagramOperation(this.providerKey), tenantId, consumerId, apiKeyId, path, this.providerKey, NATIVE_FORWARDING_VERSION])
    return row ? instagramArchivePage({ bodyBytes: row.body_bytes, bodySha256: row.body_sha256, capturedAt: row.captured_at }, this.providerKey) : null
  }

  async commitInstagramPage({ delivery, sourceCallId, sourceMode, responseBody, capturedAt, usageUnitsActual }) {
    return transaction(this.pool, async client => {
      const usage = await client.query(
        `UPDATE usage_requests SET status = 'committed', response_status = 200, response_body = $2,
           units_actual = $3, upstream_latency_ms = 0, delivery_source_mode = $4,
           response_captured_at = $5, completed_at = now()
         WHERE id = $1 AND status = 'reserved' AND tenant_id = $6 AND consumer_id = $7 RETURNING id`,
        [delivery.usageRequestId, responseBody, Math.max(1, usageUnitsActual),
          sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt, delivery.tenantId, delivery.consumerId])
      if (!usage.rows[0]) throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')
      await this.#insertGatewayRequest(client, { ...delivery, sourceMode,
        succeeded: true, responseStatus: 200, providerCallId: sourceCallId })
    })
  }

  async facebookPageFor(input) { return facebookSearchStore.facebookPageFor(this, input) }
  async facebookDeliveredIdsFor(input) { return facebookSearchStore.facebookDeliveredIdsFor(this, input) }
  async facebookFillUnknownFor(input) { return facebookSearchStore.facebookFillUnknownFor(this, input) }
  async acquireFacebookFillDeliveryLease(input) { return facebookSearchStore.acquireFacebookFillDeliveryLease(this, input) }
  async commitFacebookFillDelivery(input) { return facebookSearchStore.commitFacebookFillDelivery(this, input) }

  async twitterPageFor(input) {
    return this.providerKey === 'rapidapi' ? postgresTwitterPage(this.pool, input) : null
  }

  async twitterDeliveredIdsFor(input) {
    if (this.providerKey !== 'rapidapi') throw twitterHistoryError()
    let rootId = input.previousDeliveryId
    if (!rootId && input.sourceCallId) {
      if (!twitterPageIdentity(input.sourceCallId)) throw twitterHistoryError()
      rootId = (await this.pool.query(`SELECT usage_request_id FROM external_platform.provider_calls
        WHERE id=$1 AND provider_key='rapidapi' AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4
          AND operation='social.content.search'`, [input.sourceCallId, input.tenantId, input.consumerId, input.apiKeyId])).rows[0]?.usage_request_id
      if (!rootId) throw twitterHistoryError()
    }
    return twitterDeliveredIds(async id => {
      // Return only delivered identities, never load prior content or raw archives.
      const row = (await this.pool.query(`SELECT id,tenant_id,consumer_id,api_key_id,platform,status,response_status,acquisition_request,
        jsonb_build_object('data',jsonb_build_object('platform',response_body->'data'->'platform',
          'query',response_body->'data'->'query','pageInfo',response_body->'data'->'pageInfo',
          'items',CASE WHEN jsonb_typeof(response_body->'data'->'items')='array' THEN
            (SELECT coalesce(jsonb_agg(jsonb_build_object('id',item->'id')),'[]'::jsonb)
              FROM (SELECT item FROM jsonb_array_elements(response_body->'data'->'items') item LIMIT 101) bounded_items)
            ELSE NULL END)) AS response_body
        FROM usage_requests WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4`,
      [id,input.tenantId,input.consumerId,input.apiKeyId])).rows[0]
      return row ? { id:row.id,tenantId:row.tenant_id,consumerId:row.consumer_id,apiKeyId:row.api_key_id,
        platform:row.platform,status:row.status,responseStatus:row.response_status,acquisitionRequest:row.acquisition_request,responseBody:row.response_body } : null
    }, input, rootId ?? null)
  }

  async twitterFillUnknownFor(delivery) {
    if (!['tenantId','consumerId','apiKeyId'].every(key=>twitterPageIdentity(delivery[key]))
      || !SHA256_PATTERN.test(delivery.fingerprint || '')) throw twitterHistoryError()
    // The quota index bounds this read by tenant, consumer, platform and time.
    // Buffer-only unknown deliveries have no owned provider call to join.
    const excluded = delivery.twitterManualRetry
      ? (await this.validateTwitterManualRetry(twitterRetryInput(delivery))).ancestorRequestIds : []
    const {rows}=await this.pool.query(`SELECT request.id FROM usage_requests request
      WHERE request.tenant_id=$1 AND request.consumer_id=$2 AND request.api_key_id=$3
        AND request.platform='twitter' AND request.fingerprint=$4 AND request.status='unknown'
        AND request.acquisition_request->>'path'='/api/v1/data/search'
        AND NOT (request.id = ANY($5::uuid[]))
        AND request.reserved_at >= now()-interval '24 hours'`,
    [delivery.tenantId,delivery.consumerId,delivery.apiKeyId,delivery.fingerprint,excluded])
    if (!rows.length) return false
    const disposed = await getSearchAdmissionDispositionIds(this.pool, rows.filter(row => row.id !== delivery.usageRequestId), {
      tenantId: delivery.tenantId, consumerId: delivery.consumerId, apiKeyId: delivery.apiKeyId, platform: 'twitter',
    })
    return rows.some(row => !disposed.includes(row.id))
  }

  async validateTwitterManualRetry(input) { return twitterRetryStore.validateTwitterManualRetry(this, input) }
  async twitterManualRetryOwnerFor(id) { return twitterRetryStore.twitterManualRetryOwnerFor(this, id) }
  async twitterManualRetryOriginalFor(id) { return twitterRetryStore.twitterManualRetryOriginalFor(this, id) }

  async acquireTwitterFillDeliveryLease(input) {
    if(this.providerKey!=='rapidapi' || input.operation!=='social.content.search'
      || !twitterPageIdentity(input.ownerRequestId) || !twitterPageIdentity(input.consumerId)
      || !SHA256_PATTERN.test(input.fingerprint || '') || new Date(input.expiresAt).getTime()<=Date.now()) throw twitterHistoryError()
    const {rows}=await this.pool.query(`INSERT INTO external_platform.dispatch_leases
      (consumer_id,operation,request_fingerprint,owner_request_id,expires_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(consumer_id,operation,request_fingerprint) DO UPDATE SET owner_request_id=EXCLUDED.owner_request_id,
        expires_at=EXCLUDED.expires_at,created_at=now()
      WHERE external_platform.dispatch_leases.expires_at<=now() RETURNING owner_request_id`,
    [input.consumerId,input.operation,input.fingerprint,input.ownerRequestId,input.expiresAt])
    return rows[0]?.owner_request_id===input.ownerRequestId?{kind:'acquired'}:{kind:'busy'}
  }

  async commitTwitterFillDelivery(input) {
    if (this.providerKey !== 'rapidapi') throw twitterHistoryError()
    assertTwitterFill(input)
    const { delivery, sources, lineage, capturedAt, responseBody, usageUnitsActual, sourceMode, latencyMs = 0 } = input
    return transaction(this.pool, async client => {
      const usage = (await client.query(`SELECT acquisition_request FROM usage_requests WHERE id=$1 AND status='reserved'
        AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4 AND fingerprint=$5 AND platform='twitter' FOR UPDATE`,
      [delivery.usageRequestId,delivery.tenantId,delivery.consumerId,delivery.apiKeyId,delivery.fingerprint])).rows[0]
      if (!usage || !twitterBodyMatches(usage.acquisition_request, input)) throw twitterHistoryError()
      let representative = sources[0].callId
      for (const source of sources) {
        const page = await postgresTwitterPage(client, { ...delivery, callId: source.callId, path: TWITTER_PAGE_PATH }, true, delivery.usageRequestId)
        if (!page || page.bodySha256 !== source.bodySha256 || page.bodySize !== source.bodySize || page.capturedAt !== iso(source.capturedAt)) throw twitterHistoryError()
        const owner = (await client.query('SELECT acquisition_request FROM usage_requests WHERE id=$1', [page.sourceUsageRequestId])).rows[0]
        if (!twitterBodyMatches(owner?.acquisition_request, input)) throw twitterHistoryError()
        if (page.sourceUsageRequestId === delivery.usageRequestId) representative = source.callId
      }
      if (delivery.twitterManualRetry) await twitterRetryStore.claimTwitterManualRetry(this, twitterRetryInput(delivery), client)
      const manifest = { version:lineage.version,scopeHash:lineage.scopeHash,previousDeliveryId:lineage.previousDeliveryId ?? null,
        upstreamPages:lineage.upstreamPages,sources }
      await client.query(`UPDATE usage_requests SET status='committed',response_status=200,response_body=$2,units_actual=$3,
        upstream_latency_ms=$4,delivery_source_mode=$5,response_captured_at=$6,completed_at=now(),
        acquisition_request=acquisition_request || jsonb_build_object('twitterFill',$7::jsonb) WHERE id=$1`,
      [delivery.usageRequestId,responseBody,Math.max(1,usageUnitsActual),latencyMs,
        sourceMode==='stored_fallback'?'stale':'live',capturedAt,JSON.stringify(manifest)])
      await this.#insertGatewayRequest(client, { ...delivery,sourceMode,succeeded:true,responseStatus:200,providerCallId:representative })
    })
  }

  async commitTwitterPage(input) {
    assertTwitterPageDelivery(this.providerKey, input)
    const { delivery, sourceCallId, sourceMode, responseBody, capturedAt, usageUnitsActual } = input
    return transaction(this.pool, async client => {
      const page = await postgresTwitterPage(client, { ...delivery, callId: sourceCallId, path: TWITTER_PAGE_PATH }, true)
      if (!page || page.capturedAt !== iso(capturedAt)) {
        throw new AppError(409, 'search_page_unavailable', 'The saved Twitter search page cannot be delivered')
      }
      // The ordinary status transition retains the existing customer-charge
      // settlement trigger; its gateway provenance is committed atomically.
      const usage = await client.query(
        `UPDATE usage_requests SET status = 'committed', response_status = 200, response_body = $2,
           units_actual = $3, upstream_latency_ms = 0, delivery_source_mode = $4,
           response_captured_at = $5, completed_at = now()
         WHERE id = $1 AND status = 'reserved' AND tenant_id = $6 AND consumer_id = $7
           AND api_key_id = $8 AND fingerprint = $9 AND platform = 'twitter'
           AND acquisition_request->>'path' = '/api/v1/data/search' RETURNING id`,
        [delivery.usageRequestId, responseBody, Math.max(1, usageUnitsActual),
          sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt,
          delivery.tenantId, delivery.consumerId, delivery.apiKeyId, delivery.fingerprint])
      if (!usage.rows[0]) throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved for this Twitter delivery')
      await this.#insertGatewayRequest(client, { ...delivery, sourceMode,
        succeeded: true, responseStatus: 200, providerCallId: sourceCallId })
    })
  }

  async snapshotFor(delivery, at = new Date()) {
    const { rows } = await this.pool.query(
      `SELECT * FROM external_platform.response_snapshots
        WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
          AND stale_until >= $4`,
      [
        delivery.consumerId,
        delivery.operation,
        snapshotFingerprint(delivery),
        at,
      ],
    )
    return pgSnapshot(rows[0])
  }

  async sharedDetailSnapshotFor(fingerprint, at = new Date()) {
    const { rows } = await this.pool.query(
      `SELECT * FROM external_platform.response_snapshots
        WHERE provider_key = $1 AND operation = 'social.posts.analytics'
          AND request_fingerprint = $2 AND stale_until >= $3
        ORDER BY captured_at DESC LIMIT 1`, [this.providerKey, fingerprint, at])
    return pgSnapshot(rows[0])
  }

  async reapStaleCalls() {
    // This second pass closes a narrow race where the usage reaper began before
    // beginProviderCall committed and therefore could not see the new call in
    // its original statement snapshot.
    const { rows } = await this.pool.query(
      `WITH candidates AS MATERIALIZED (
         SELECT call.id
           FROM external_platform.provider_calls call
           JOIN usage_requests request ON request.id = call.usage_request_id
          WHERE call.outcome = 'pending' AND request.status = 'unknown'
          ORDER BY call.id
          LIMIT 100
          FOR UPDATE OF call SKIP LOCKED
       )
       UPDATE external_platform.provider_calls call SET
         outcome = 'unknown', error_code = 'reservation_lease_expired',
         completed_at = now()
       FROM candidates
       WHERE call.id = candidates.id
         AND call.outcome = 'pending'
         AND EXISTS (SELECT 1 FROM usage_requests request
                      WHERE request.id = call.usage_request_id AND request.status = 'unknown')
       RETURNING call.id`,
    )
    return rows.length
  }

  async acquireDispatchLease({
    consumerId,
    operation,
    fingerprint,
    endpointKey,
    contractVersion,
    ownerRequestId,
    expiresAt,
    retryOfRequestId = null,
    ownedDeliveryLease = false,
    twitterManualRetry = null,
  }) {
    if (twitterManualRetry && (operation !== 'social.content.search' || twitterManualRetry.usageRequestId !== ownerRequestId
      || twitterManualRetry.consumerId !== consumerId || twitterManualRetry.fingerprint !== fingerprint)) throw twitterRetryStore.twitterRetryDenied()
    const excluded = twitterManualRetry
      ? (await this.validateTwitterManualRetry(twitterManualRetry)).ancestorRequestIds : []
    excluded.push(...await disposedTwitterDispatchIds(this, { consumerId, operation, fingerprint, ownerRequestId }))
    const { rows } = await this.pool.query(
      `INSERT INTO external_platform.dispatch_leases
         (consumer_id, operation, request_fingerprint, owner_request_id, expires_at)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1
            FROM external_platform.provider_calls call
           WHERE call.provider_key = $10
             AND call.operation = $2
             AND (
               (
                 call.consumer_id = $1
                 AND (
                   call.dispatch_fingerprint = $3
                   OR (call.dispatch_fingerprint IS NULL AND call.request_fingerprint = $3)
                 )
                 AND call.outcome = 'pending'
               )
               OR (
                 (
                   (
                     call.consumer_id = $1
                     AND (
                       call.dispatch_fingerprint = $3
                       OR (call.dispatch_fingerprint IS NULL AND call.request_fingerprint = $3)
                     )
                     AND call.outcome = 'unknown'
                     AND ($8::uuid IS NULL OR call.usage_request_id <> $8)
                     AND NOT (call.usage_request_id = ANY($13::uuid[]))
                   )
                   OR (
                     call.endpoint_key = $7
                     AND call.contract_version = $9
                     AND call.outcome = 'succeeded_unusable'
                     AND call.error_code IS DISTINCT FROM 'upstream_note_unavailable'
                     ${quarantineRecoverySql('call')}
                   )
                   OR (
                     call.consumer_id = $1
                     AND (
                       call.dispatch_fingerprint = $3
                       OR (call.dispatch_fingerprint IS NULL AND call.request_fingerprint = $3)
                     )
                     AND call.outcome = 'succeeded_unusable'
                     AND call.error_code = 'upstream_note_unavailable'
                   )
                 )
                 AND call.completed_at > now() - make_interval(secs => CASE
                   WHEN call.outcome='succeeded_unusable' AND call.error_code IS DISTINCT FROM 'upstream_note_unavailable'
                     THEN $11::double precision ELSE $6::double precision END)
               )
             )
        )
       ON CONFLICT (consumer_id, operation, request_fingerprint) DO UPDATE SET
         owner_request_id = EXCLUDED.owner_request_id,
         expires_at = EXCLUDED.expires_at,
         created_at = now()
       WHERE external_platform.dispatch_leases.expires_at <= now()
         OR ($12::boolean AND external_platform.dispatch_leases.owner_request_id=EXCLUDED.owner_request_id
           AND external_platform.dispatch_leases.expires_at=EXCLUDED.expires_at)
         OR EXISTS (
           SELECT 1 FROM usage_requests previous
           JOIN usage_requests replacement ON replacement.id = EXCLUDED.owner_request_id
            WHERE previous.id = external_platform.dispatch_leases.owner_request_id
              AND previous.status IN ('committed', 'released') AND replacement.status = 'reserved'
              AND previous.tenant_id = replacement.tenant_id
              AND previous.consumer_id = external_platform.dispatch_leases.consumer_id
              AND replacement.consumer_id = EXCLUDED.consumer_id
              AND previous.platform = replacement.platform
              AND previous.fingerprint = external_platform.dispatch_leases.request_fingerprint
              AND replacement.fingerprint = EXCLUDED.request_fingerprint
              AND NOT EXISTS (
                SELECT 1 FROM external_platform.provider_calls unsettled
                 WHERE unsettled.usage_request_id = previous.id AND unsettled.outcome IN ('pending', 'unknown')
              )
         )
       RETURNING owner_request_id, expires_at`,
      [
        consumerId, operation, fingerprint, ownerRequestId, expiresAt,
        Math.ceil(this.uncertainCooldownMs / 1_000),
        endpointKey,
        retryOfRequestId,
        contractVersion,
        this.providerKey,
        Math.ceil(this.responseQuarantineCooldownMs / 1_000),
        ownedDeliveryLease && ownedSearchDelivery(this.providerKey, operation),
        excluded,
      ],
    )
    if (rows[0]?.owner_request_id === ownerRequestId) return { kind: 'acquired' }

    const blocker = await this.pool.query(
      `SELECT outcome, error_code, completed_at,
              CASE
                WHEN outcome = 'pending' THEN NULL
                ELSE completed_at + make_interval(secs => CASE
                  WHEN outcome='succeeded_unusable' AND error_code IS DISTINCT FROM 'upstream_note_unavailable'
                    THEN $9::double precision ELSE $4::double precision END)
              END AS blocked_until
         FROM external_platform.provider_calls call
        WHERE provider_key = $8
          AND operation = $2
          AND (
            (
              consumer_id = $1
              AND (
                dispatch_fingerprint = $3
                OR (dispatch_fingerprint IS NULL AND request_fingerprint = $3)
              )
              AND outcome = 'pending'
            )
            OR (
              (
                (
                  consumer_id = $1
                  AND (
                    dispatch_fingerprint = $3
                    OR (dispatch_fingerprint IS NULL AND request_fingerprint = $3)
                  )
                  AND outcome = 'unknown'
                  AND ($6::uuid IS NULL OR usage_request_id <> $6)
                  AND NOT (usage_request_id = ANY($10::uuid[]))
                )
                OR (
                  endpoint_key = $5
                  AND contract_version = $7
                  AND outcome = 'succeeded_unusable'
                  AND error_code IS DISTINCT FROM 'upstream_note_unavailable'
                  ${quarantineRecoverySql('call')}
                )
                OR (
                  consumer_id = $1
                  AND (
                    dispatch_fingerprint = $3
                    OR (dispatch_fingerprint IS NULL AND request_fingerprint = $3)
                  )
                  AND outcome = 'succeeded_unusable'
                  AND error_code = 'upstream_note_unavailable'
                )
              )
              AND completed_at > now() - make_interval(secs => CASE
                WHEN outcome='succeeded_unusable' AND error_code IS DISTINCT FROM 'upstream_note_unavailable'
                  THEN $9::double precision ELSE $4::double precision END)
            )
          )
        ORDER BY started_at DESC
        LIMIT 1`,
      [
        consumerId, operation, fingerprint,
        Math.ceil(this.uncertainCooldownMs / 1_000), endpointKey, retryOfRequestId,
        contractVersion,
        this.providerKey,
        Math.ceil(this.responseQuarantineCooldownMs / 1_000),
        excluded,
      ],
    )
    if (blocker.rows[0]) {
      return {
        kind: 'blocked',
        reason: blocker.rows[0].error_code === 'upstream_note_unavailable'
          ? blocker.rows[0].error_code
          : blocker.rows[0].outcome,
        blockedUntil: blocker.rows[0].blocked_until ? iso(blocker.rows[0].blocked_until) : null,
      }
    }
    const lease = await this.pool.query(
      `SELECT expires_at FROM external_platform.dispatch_leases
        WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3`,
      [consumerId, operation, fingerprint],
    )
    return {
      kind: 'busy',
      blockedUntil: lease.rows[0]?.expires_at ? iso(lease.rows[0].expires_at) : null,
    }
  }

  async releaseDispatchLease({ consumerId, operation, fingerprint, ownerRequestId, bestEffortRelease = false }) {
    if (bestEffortRelease === true) {
      if (!canStartBestEffortCleanup(this.pool)) return false
      return transaction(this.pool, async client => {
        await client.query("SET LOCAL lock_timeout = '100ms'")
        await client.query("SET LOCAL statement_timeout = '500ms'")
        const released = await client.query(
          `WITH owned AS (
             SELECT ctid FROM external_platform.dispatch_leases
              WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
                AND owner_request_id = $4
              FOR UPDATE SKIP LOCKED
           )
           DELETE FROM external_platform.dispatch_leases lease USING owned
            WHERE lease.ctid = owned.ctid
            RETURNING lease.owner_request_id`,
          [consumerId, operation, fingerprint, ownerRequestId],
        )
        return released.rows.length > 0
      })
    }
    await this.pool.query(
      `DELETE FROM external_platform.dispatch_leases
        WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
          AND owner_request_id = $4`,
      [consumerId, operation, fingerprint, ownerRequestId],
    )
  }

  // See the memory store: contract failures are scoped to one marketplace so an
  // unparseable response cannot suspend live dispatch for the rest of the
  // provider. Kept in its own table so provider_state keeps meaning exactly
  // what it meant before -- the provider-wide breaker.
  async contractCircuitState(providerKey = this.providerKey, scope = null) {
    if (providerKey !== this.providerKey || !scope) return null
    const { rows } = await this.pool.query(
      `SELECT provider_key, scope, consecutive_failures, circuit_open_until,
              last_failure_at, last_error_code
         FROM external_platform.provider_contract_circuits
        WHERE provider_key = $1 AND scope = $2`,
      [providerKey, scope],
    )
    const row = rows[0]
    return row ? {
      providerKey: row.provider_key,
      scope: row.scope,
      consecutiveFailures: Number(row.consecutive_failures),
      circuitOpenUntil: row.circuit_open_until ? iso(row.circuit_open_until) : null,
      lastFailureAt: row.last_failure_at ? iso(row.last_failure_at) : null,
      lastErrorCode: row.last_error_code,
    } : null
  }

  async #recordContractFailure(client, scope, errorCode) {
    await client.query(
      `INSERT INTO external_platform.provider_contract_circuits AS circuit
         (provider_key, scope, consecutive_failures, last_failure_at, last_error_code, updated_at)
       VALUES ($1, $2, 1, now(), $3, now())
       ON CONFLICT (provider_key, scope) DO UPDATE SET
         consecutive_failures = circuit.consecutive_failures + 1,
         last_failure_at = now(),
         last_error_code = EXCLUDED.last_error_code,
         circuit_open_until = CASE
           WHEN circuit.consecutive_failures + 1 >= $4::integer
             THEN now() + ($5::integer * interval '1 millisecond')
           ELSE circuit.circuit_open_until
         END,
         updated_at = now()`,
      [this.providerKey, scope, errorCode, this.circuitFailureThreshold, this.circuitOpenMs],
    )
  }

  async #clearContractCircuit(client, scope, callId) {
    if (!scope) return
    await client.query(
      `DELETE FROM external_platform.provider_contract_circuits
        WHERE provider_key = $1 AND scope = $2
          AND last_failure_at <= (SELECT started_at FROM external_platform.provider_calls WHERE id = $3)`,
      [this.providerKey, scope, callId],
    )
  }

  async providerState(providerKey = this.providerKey) {
    if (providerKey !== this.providerKey) return null
    const { rows } = await this.pool.query(
      `SELECT provider_key, consecutive_failures, circuit_open_until, last_call_at,
              last_success_at, last_failure_at, last_error_code
         FROM external_platform.provider_state WHERE provider_key = $1`,
      [providerKey],
    )
    const row = rows[0]
    return row ? {
      providerKey: row.provider_key,
      consecutiveFailures: Number(row.consecutive_failures),
      circuitOpenUntil: row.circuit_open_until ? iso(row.circuit_open_until) : null,
      lastCallAt: row.last_call_at ? iso(row.last_call_at) : null,
      lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
      lastFailureAt: row.last_failure_at ? iso(row.last_failure_at) : null,
      lastErrorCode: row.last_error_code,
    } : null
  }

  async acquireProviderRateLimit({ limit, tokens = 1, windowMs = 60_000 }) {
    const maximum = boundedRateLimit(limit, 'limit')
    const requested = boundedRateLimit(tokens, 'tokens')
    if (requested > maximum) throw new TypeError('tokens must not exceed limit')
    const burst = Math.min(maximum, Math.max(requested, this.rateLimitBurst ?? maximum))
    const duration = boundedRateLimit(windowMs, 'windowMs')
    if (duration < 1_000 || duration > 3_600_000) {
      throw new TypeError('windowMs must be between 1000 and 3600000')
    }
    // Every dispatch of this provider updates this one row. A synchronous
    // COMMIT would keep the row locked until the WAL flush, so a slow disk
    // turns the limiter itself into the bottleneck. Losing the last few
    // admissions in a server crash only returns tokens to the bucket.
    const { rows } = await transaction(this.pool, async (client) => {
      await client.query('SET LOCAL synchronous_commit TO off')
      return client.query(
        `WITH db_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS observed_at
         )
         INSERT INTO external_platform.provider_rate_buckets AS bucket
           (provider_key, capacity, window_ms, tokens, last_admitted, refilled_at, updated_at)
         -- Capacity remains the refill rate. $5 bounds accumulated burst tokens;
         -- explicit operand types avoid ambiguous INSERT ... SELECT parameters.
         SELECT $1, $2, $3, ($5::double precision - $4::double precision), true,
                db_clock.observed_at, db_clock.observed_at
           FROM db_clock
         ON CONFLICT (provider_key) DO UPDATE SET
           capacity = EXCLUDED.capacity,
           window_ms = EXCLUDED.window_ms,
           tokens = CASE
             WHEN least(
               $5::double precision,
               bucket.tokens + greatest(
                 0::double precision,
                 extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
                   * 1000::double precision
                   * EXCLUDED.capacity::double precision
                   / EXCLUDED.window_ms::double precision
               )
             ) >= $4::double precision
               THEN least(
                 $5::double precision,
                 bucket.tokens + greatest(
                   0::double precision,
                   extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
                     * 1000::double precision
                     * EXCLUDED.capacity::double precision
                     / EXCLUDED.window_ms::double precision
                 )
               ) - $4::double precision
             ELSE least(
               $5::double precision,
               bucket.tokens + greatest(
                 0::double precision,
                 extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
                   * 1000::double precision
                   * EXCLUDED.capacity::double precision
                   / EXCLUDED.window_ms::double precision
               )
             )
           END,
           last_admitted = least(
             $5::double precision,
             bucket.tokens + greatest(
               0::double precision,
               extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
                 * 1000::double precision
                 * EXCLUDED.capacity::double precision
                 / EXCLUDED.window_ms::double precision
             )
           ) >= $4::double precision,
           refilled_at = greatest(bucket.refilled_at, EXCLUDED.refilled_at),
           updated_at = greatest(bucket.updated_at, EXCLUDED.refilled_at)
         RETURNING last_admitted AS allowed,
           floor(tokens)::bigint AS remaining,
           CASE WHEN last_admitted THEN 0::bigint ELSE greatest(
             1::bigint,
             ceil(($4::double precision - tokens) * window_ms::double precision
               / capacity::double precision)::bigint
           ) END AS retry_after_ms`,
        [this.providerKey, maximum, duration, requested, burst],
      )
    })
    if (!rows[0]) throw new Error('Provider rate bucket returned no state')
    return {
      allowed: rows[0].allowed === true,
      remaining: Math.max(0, Number(rows[0].remaining)),
      retryAfterMs: Math.max(0, Number(rows[0].retry_after_ms)),
    }
  }

  // The monthly procurement cap, read-only. See the memory store for why this
  // exists; the difference here is that it must not take the advisory lock the
  // transactional path uses -- a diagnostic has no business serialising against
  // live dispatch, and outside a transaction that lock would be released
  // immediately anyway.
  //
  // The two sums mirror the admission query's own predicates: provider, current
  // UTC month, costs in the policy currency, and reservations still held by a
  // live lease. A test drives real reservations until admission refuses and
  // asserts this reports exhausted at exactly that point, so the duplication
  // cannot drift silently.
  async describeCostBudget(costControl) {
    const budgetMinor = costControl?.monthlyBudgetMinor
    if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0) return null
    const currency = costControl.currency ?? null
    // Known cost is folded total + open requests, as in providerCostExposure.
    const { rows } = await this.pool.query(
      `WITH month_bounds AS MATERIALIZED (
         SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date AS month,
                date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS starts_at,
                (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS ends_at
       ), monthly_calls AS (
         SELECT call.cost_minor, call.currency
           FROM external_platform.provider_cost_open_usages open_usage
           JOIN month_bounds ON open_usage.month = month_bounds.month
           JOIN external_platform.provider_calls call
             ON call.usage_request_id = open_usage.usage_request_id
            AND call.started_at >= month_bounds.starts_at
            AND call.started_at < month_bounds.ends_at
          WHERE open_usage.provider_key = $1 AND call.provider_key = $1
       )
       SELECT (
                SELECT coalesce(sum(cost_minor), 0)::bigint
                  FROM monthly_calls
                 WHERE cost_minor IS NOT NULL AND currency = $2
              ) + (
                SELECT coalesce(sum(total.known_cost_minor), 0)::bigint
                  FROM external_platform.provider_cost_month_totals total
                  JOIN month_bounds ON total.month = month_bounds.month
                 WHERE total.provider_key = $1 AND total.currency = $2
              ) AS known_cost_minor,
              (
                SELECT coalesce(sum(reservation.reserved_cost_minor), 0)::bigint
                  FROM external_platform.provider_cost_reservations reservation
                  JOIN usage_requests request ON request.id = reservation.usage_request_id
                 WHERE reservation.provider_key = $1
                   AND reservation.currency = $2
                   AND reservation.status = 'active'
                   AND request.status = 'reserved'
                   AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
                   AND reservation.created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                   AND reservation.created_at < ((date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
              ) AS reserved_cost_minor`,
      [this.providerKey, currency],
    )
    const spentMinor = Number(rows[0].known_cost_minor) + Number(rows[0].reserved_cost_minor)
    return {
      budgetMinor,
      currency,
      spentMinor,
      remainingMinor: Math.max(0, budgetMinor - spentMinor),
      exhausted: spentMinor >= budgetMinor,
    }
  }

  async reserveProviderCostWorkflow(input) {
    if (!Array.isArray(input.costControls) || input.costControls.length < 1
      || input.costControls.length > 64) {
      throw new TypeError('costControls must contain 1-64 provider dispatch costs')
    }
    const controls = input.costControls.map((control) => {
      const normalized = normalizedCostControl(control)
      if (!normalized) throw new TypeError('workflow costs require costControl')
      return normalized
    })
    const policy = controls[0]
    if (controls.some((control) => (
      control.currency !== policy.currency
      || control.monthlyBudgetMinor !== policy.monthlyBudgetMinor
      || control.monthlySubsidyBudgetMinor !== policy.monthlySubsidyBudgetMinor
    ))) {
      throw new TypeError('workflow costs must share one currency and budget policy')
    }
    const reservedCostMinor = controls.reduce(
      (sum, control) => sum + control.costMinor,
      0,
    )
    if (!Number.isSafeInteger(reservedCostMinor)) {
      throw new TypeError('workflow cost exceeds the safe-integer range')
    }
    const id = input.id ?? randomUUID()
    let expectedBaseCostMinor = null
    let expectedReservedSubsidyMinor = null
    let expected
    try {
      expected = await transaction(this.pool, async (client) => {
        // Provider lock order is shared with standalone beginProviderCall:
        // provider first, then the usage row. This prevents a workflow
        // reservation racing a standalone call or a usage release on another
        // Hub replica.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `external-platform-cost:${this.providerKey}`,
        ])
        // The provider lock is held until COMMIT returns. A reservation is a
        // pre-dispatch hold, never call evidence, so it commits without
        // waiting for the WAL flush: the next admission sees it as soon as it
        // is visible. Nothing is dispatched until beginProviderCall commits
        // synchronously after reading this reservation, and that flush covers
        // this earlier commit record, so a crash can only lose a reservation
        // nobody has dispatched against (or that only made others stricter).
        await client.query('SET LOCAL synchronous_commit TO off')
        const owned = await client.query(
          `SELECT request.id
             FROM usage_requests request
            WHERE request.id = $1
              AND request.status = 'reserved'
              AND request.tenant_id = $2
              AND request.consumer_id = $3
              AND request.api_key_id = $4
              AND request.fingerprint = $5
              AND request.platform = $6
              AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
            FOR UPDATE`,
          [
            input.usageRequestId,
            input.tenantId,
            input.consumerId,
            input.apiKeyId,
            input.fingerprint,
            this.authorizationPlatform,
          ],
        )
        if (!owned.rows[0]) {
          throw new AppError(
            409,
            'external_platform_usage_scope_mismatch',
            'Cost reservation does not match its reserved usage request',
          )
        }
        const state = await postgresProviderCostState(client, {
          providerKey: this.providerKey,
          usageRequestId: input.usageRequestId,
          currency: policy.currency,
        })
        if (!state.customerBilled
          && state.knownCostMinor + state.reservedCostMinor + reservedCostMinor
          > policy.monthlyBudgetMinor) {
          throw new AppError(
            429,
            'external_platform_cost_budget_exhausted',
            'External data monthly procurement budget is exhausted',
          )
        }
        const reservedSubsidyMinor = Math.max(
          0,
          state.usageCostMinor + reservedCostMinor - state.customerCoverageMinor,
        ) - Math.max(0, state.usageCostMinor - state.customerCoverageMinor)
        if (!state.customerBilled
          && state.subsidyCostMinor + state.reservedSubsidyMinor + reservedSubsidyMinor
          > policy.monthlySubsidyBudgetMinor) {
          throw new AppError(
            429,
            'external_platform_subsidy_budget_exhausted',
            'External data customer-price coverage or subsidy budget is exhausted',
          )
        }
        expectedBaseCostMinor = state.usageCostMinor
        expectedReservedSubsidyMinor = reservedSubsidyMinor
        const reservation = {
          id,
          providerKey: this.providerKey,
          usageRequestId: input.usageRequestId,
          currency: policy.currency,
          baseCostMinor: expectedBaseCostMinor,
          reservedCostMinor,
          reservedSubsidyMinor,
          monthlyBudgetMinor: policy.monthlyBudgetMinor,
          monthlySubsidyBudgetMinor: policy.monthlySubsidyBudgetMinor,
        }
        const inserted = await client.query(
          `INSERT INTO external_platform.provider_cost_reservations
             (id, provider_key, usage_request_id, currency, base_cost_minor,
              reserved_cost_minor, reserved_subsidy_minor, monthly_budget_minor,
              monthly_subsidy_budget_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING created_at`,
          [
            reservation.id,
            reservation.providerKey,
            reservation.usageRequestId,
            reservation.currency,
            reservation.baseCostMinor,
            reservation.reservedCostMinor,
            reservation.reservedSubsidyMinor,
            reservation.monthlyBudgetMinor,
            reservation.monthlySubsidyBudgetMinor,
          ],
        )
        return {
          ...reservation,
          status: 'active',
          createdAt: iso(inserted.rows[0].created_at),
          releasedAt: null,
        }
      })
      this.#scheduleCostLedgerFold()
      return expected
    } catch (error) {
      if (error instanceof AppError) throw error
      let reconciled
      try {
        reconciled = await this.pool.query(
          `SELECT id, provider_key, usage_request_id, currency, base_cost_minor,
                  reserved_cost_minor, reserved_subsidy_minor, monthly_budget_minor,
                  monthly_subsidy_budget_minor, status, created_at, released_at
             FROM external_platform.provider_cost_reservations
            WHERE id = $1
              AND provider_key = $2
              AND usage_request_id = $3
              AND currency = $4
              AND base_cost_minor = $5
              AND reserved_cost_minor = $6
              AND reserved_subsidy_minor = $7
              AND monthly_budget_minor = $8
              AND monthly_subsidy_budget_minor = $9
              AND status = 'active'`,
          [
            id,
            this.providerKey,
            input.usageRequestId,
            policy.currency,
            expectedBaseCostMinor ?? -1,
            reservedCostMinor,
            expectedReservedSubsidyMinor ?? -1,
            policy.monthlyBudgetMinor,
            policy.monthlySubsidyBudgetMinor,
          ],
        )
      } catch {
        throw new AppError(
          503,
          'external_platform_cost_reservation_persistence_unknown',
          'Provider cost reservation could not be reconciled; do not dispatch',
        )
      }
      if (reconciled.rows[0]) {
        const row = reconciled.rows[0]
        return {
          id: row.id,
          providerKey: row.provider_key,
          usageRequestId: row.usage_request_id,
          currency: row.currency,
          baseCostMinor: Number(row.base_cost_minor),
          reservedCostMinor: Number(row.reserved_cost_minor),
          reservedSubsidyMinor: Number(row.reserved_subsidy_minor),
          monthlyBudgetMinor: Number(row.monthly_budget_minor),
          monthlySubsidyBudgetMinor: Number(row.monthly_subsidy_budget_minor),
          status: row.status,
          createdAt: iso(row.created_at),
          releasedAt: row.released_at ? iso(row.released_at) : null,
        }
      }
      if (error?.code === '23505' && [
        'external_platform_provider_cost_reservations_active_usage_idx',
        'provider_cost_reservations_pkey',
      ].includes(error?.constraint)) {
        throw new AppError(
          409,
          'external_platform_cost_reservation_exists',
          'Usage request already has an active provider cost reservation',
        )
      }
      throw new AppError(
        503,
        'external_platform_cost_reservation_persistence_unknown',
        'Provider cost reservation could not be proven; do not dispatch',
      )
    }
  }

  async releaseProviderCostWorkflow({ reservationId, usageRequestId, bestEffortRelease = false }) {
    if (bestEffortRelease === true && !canStartBestEffortCleanup(this.pool)) return false
    return transaction(this.pool, async (client) => {
      // Final cleanup must not delay an already-durable delivery behind budget
      // admission. A missed release remains conservative and expires with the
      // original request lease; customer holds and paid-call costs are intact.
      // Provider switches and pre-dispatch releases keep the strict path.
      if (bestEffortRelease === true) {
        await client.query("SET LOCAL lock_timeout = '100ms'")
        await client.query("SET LOCAL statement_timeout = '500ms'")
        const { rows } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [
          `external-platform-cost:${this.providerKey}`,
        ])
        if (rows[0]?.acquired !== true) return false
      } else {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `external-platform-cost:${this.providerKey}`,
        ])
      }
      // Either way the provider lock is released without waiting for the WAL
      // flush: losing a release in a crash only restores a conservative hold,
      // and any admission that relied on it flushes it with its own
      // synchronous call commit.
      await client.query('SET LOCAL synchronous_commit TO off')
      const released = await client.query(
        `UPDATE external_platform.provider_cost_reservations
            SET status = 'released', released_at = now()
          WHERE id = $1
            AND provider_key = $2
            AND usage_request_id = $3
            AND status = 'active'
          RETURNING id`,
        [reservationId, this.providerKey, usageRequestId],
      )
      if (released.rows[0]) return true
      const existing = await client.query(
        `SELECT id
           FROM external_platform.provider_cost_reservations
          WHERE id = $1
            AND provider_key = $2
            AND usage_request_id = $3
            AND status = 'released'`,
        [reservationId, this.providerKey, usageRequestId],
      )
      return Boolean(existing.rows[0])
    })
  }

  // Moves finished usage requests of this provider from the open set into the
  // monthly totals. Never takes the provider cost lock: admission reads the
  // totals and the open set in one snapshot, and a fold changes both in one
  // transaction. Losing a fold in a crash only leaves those requests open.
  async foldProviderCostLedger({ limit = COST_LEDGER_FOLD_LIMIT } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError('limit must be an integer between 1 and 10000')
    }
    return transaction(this.pool, async (client) => {
      await client.query('SET LOCAL synchronous_commit TO off')
      await client.query("SET LOCAL lock_timeout = '1s'")
      await client.query("SET LOCAL statement_timeout = '10s'")
      const { rows: [lock] } = await client.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
        [costLedgerLockKey(this.providerKey)],
      )
      if (lock?.acquired !== true) return { foldedUsages: 0, skipped: true }
      const { rows: [result] } = await client.query(
        FOLD_PROVIDER_COST_LEDGER_SQL,
        [this.providerKey, limit],
      )
      return { foldedUsages: Number(result?.folded_usages ?? 0), skipped: false }
    })
  }

  // Reconciliation repair: reopen every usage request with calls in the month
  // and drop that month's folded totals, in one transaction. Admission stays
  // exact throughout (it is then O(month) until folds catch up). `month` is
  // the first day of a UTC month, e.g. '2026-10-01'; default current month.
  async resetProviderCostLedger({ month = null } = {}) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        costLedgerLockKey(this.providerKey),
      ])
      const { rows: [bounds] } = await client.query(
        `SELECT coalesce($1::date, date_trunc('month', now() AT TIME ZONE 'UTC')::date) AS month`,
        [month],
      )
      const removed = await client.query(
        `DELETE FROM external_platform.provider_cost_month_totals
          WHERE provider_key = $1 AND month = $2`,
        [this.providerKey, bounds.month],
      )
      const reopened = await client.query(
        `INSERT INTO external_platform.provider_cost_open_usages
           (provider_key, month, usage_request_id)
         SELECT DISTINCT call.provider_key, $2::date, call.usage_request_id
           FROM external_platform.provider_calls call
          WHERE call.provider_key = $1
            AND call.started_at >= $2::date::timestamp AT TIME ZONE 'UTC'
            AND call.started_at < ($2::date + interval '1 month') AT TIME ZONE 'UTC'
         ON CONFLICT DO NOTHING`,
        [this.providerKey, bounds.month],
      )
      return { removedTotals: removed.rowCount, reopenedUsages: reopened.rowCount }
    })
  }

  #scheduleCostLedgerFold() {
    const pool = this.pool
    if (typeof pool?.totalCount !== 'number' || !canStartBestEffortCleanup(pool)) return
    let byProvider = costLedgerFolds.get(pool)
    if (!byProvider) {
      byProvider = new Map()
      costLedgerFolds.set(pool, byProvider)
    }
    const state = byProvider.get(this.providerKey) ?? { running: false, nextAt: 0 }
    byProvider.set(this.providerKey, state)
    const now = Date.now()
    if (state.running || now < state.nextAt) return
    state.running = true
    state.nextAt = now + COST_LEDGER_FOLD_INTERVAL_MS
    this.foldProviderCostLedger()
      .catch(() => { /* Housekeeping only; the next admission retries later. */ })
      .finally(() => { state.running = false })
  }

  async beginProviderCall(input) {
    const id = input.id ?? randomUUID()
    const callOrdinal = input.callOrdinal ?? 0
    if (!Number.isSafeInteger(callOrdinal) || callOrdinal < 0) {
      throw new TypeError('callOrdinal must be a non-negative safe integer')
    }
    const callRole = input.callRole ?? (callOrdinal === 0 ? 'primary' : 'enrichment')
    if (!['primary', 'enrichment', 'retry'].includes(callRole)) {
      throw new TypeError('callRole must be primary, enrichment or retry')
    }
    const costControl = normalizedCostControl(input.costControl)
    const operationControl = normalizedOperationControl(input.operationControl, {
      providerKey: this.providerKey,
      operation: input.operation,
    })
    const operationControlValues = operationControl
      ? [
          operationControl.policyRevision,
          operationControl.releaseRevision,
          operationControl.priceBookVersion,
          operationControl.credentialRevision,
        ]
      : []
    const operationControlOffset = 18
    const costControlOffset = operationControlOffset + operationControlValues.length
    const values = [
      id, input.tenantId, input.consumerId, input.apiKeyId, input.usageRequestId,
      input.operation, input.contractVersion, input.endpointKey,
      input.endpointVersion, input.marketplace, input.fingerprint,
      input.retryOfRequestId ?? null, this.providerKey, this.authorizationPlatform,
      callOrdinal, callRole, input.dispatchFingerprint ?? input.fingerprint,
      ...operationControlValues,
      ...(costControl ? [costControl.costMinor, costControl.costKind, costControl.currency] : []),
    ]
    try {
      return await transaction(this.pool, async (client) => {
        if (costControl) {
          const reserved = input.costReservationId != null
          if (reserved) {
            // The reservation was admitted under the provider lock, and its
            // headroom can only be consumed by this usage request: the call's
            // cost moves from reserved to known exposure, leaving every other
            // admission's inputs unchanged. So this call serializes on its own
            // reservation row (against a second call of the same request and
            // against release) rather than on the provider lock, which would
            // otherwise stay held through this synchronous COMMIT's flush.
            await client.query(
              `SELECT 1
                 FROM external_platform.provider_cost_reservations
                WHERE id = $1 AND provider_key = $2 AND usage_request_id = $3
                FOR UPDATE`,
              [input.costReservationId, this.providerKey, input.usageRequestId],
            )
          }
          const state = await postgresProviderCostState(client, {
            providerKey: this.providerKey,
            usageRequestId: input.usageRequestId,
            currency: costControl.currency,
            reservationId: input.costReservationId ?? null,
            serialize: !reserved,
          })
          if (input.costReservationId != null) {
            const reservation = state.reservation
            if (!reservation
              || reservation.usageRequestId !== input.usageRequestId
              || reservation.currency !== costControl.currency
              || reservation.monthlyBudgetMinor !== costControl.monthlyBudgetMinor
              || reservation.monthlySubsidyBudgetMinor
                !== costControl.monthlySubsidyBudgetMinor
              || state.usageCostMinor + costControl.costMinor
                > reservation.baseCostMinor + reservation.reservedCostMinor) {
              throw new AppError(
                409,
                'external_platform_cost_reservation_mismatch',
                'Provider call does not match its active cost reservation',
              )
            }
            const baseSubsidyMinor = Math.max(
              0,
              reservation.baseCostMinor - state.customerCoverageMinor,
            )
            const projectedSubsidyMinor = Math.max(
              0,
              state.usageCostMinor + costControl.costMinor - state.customerCoverageMinor,
            )
            if (projectedSubsidyMinor
              > baseSubsidyMinor + reservation.reservedSubsidyMinor) {
              throw new AppError(
                409,
                'external_platform_cost_reservation_mismatch',
                'Provider call exceeds its reserved subsidy exposure',
              )
            }
          } else {
            if (!state.customerBilled
              && state.knownCostMinor + state.reservedCostMinor + costControl.costMinor
              > costControl.monthlyBudgetMinor) {
              throw new AppError(
                429,
                'external_platform_cost_budget_exhausted',
                'External data monthly procurement budget is exhausted',
              )
            }
            const incrementalSubsidyMinor = Math.max(
              0,
              state.usageCostMinor + costControl.costMinor - state.customerCoverageMinor,
            ) - Math.max(0, state.usageCostMinor - state.customerCoverageMinor)
            if (!state.customerBilled
              && state.subsidyCostMinor + state.reservedSubsidyMinor
              + incrementalSubsidyMinor > costControl.monthlySubsidyBudgetMinor) {
              throw new AppError(
                429,
                'external_platform_subsidy_budget_exhausted',
                'External data customer-price coverage or subsidy budget is exhausted',
              )
            }
          }
        }
        if (input.twitterManualRetry) await twitterRetryStore.claimTwitterManualRetry(this, twitterRetryInput(input), client)
        const { rows } = await client.query(
          `WITH owned_request AS MATERIALIZED (
             SELECT request.id
               FROM usage_requests request
              WHERE request.id = $5
                AND request.status = 'reserved'
                AND request.tenant_id = $2
                AND request.consumer_id = $3
                AND request.api_key_id = $4
                AND request.fingerprint = $11
                AND request.platform = $14
                AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
              FOR UPDATE
           ), retry_target AS MATERIALIZED (
             SELECT retry.id
               FROM usage_requests retry
              WHERE retry.id = $12
                AND retry.status = 'unknown'
                AND retry.tenant_id = $2
                AND retry.consumer_id = $3
                ${input.twitterManualRetry ? 'AND retry.api_key_id = $4' : ''}
                AND retry.fingerprint = $11
                AND retry.platform = $14
                AND NOT EXISTS (
                  SELECT 1
                    FROM external_platform.provider_calls previous_retry
                   WHERE previous_retry.retry_of_usage_request_id = retry.id
                )
              FOR UPDATE
           )
           INSERT INTO external_platform.provider_calls
             (id, provider_key, tenant_id, consumer_id, api_key_id, usage_request_id,
              operation, contract_version, endpoint_key, endpoint_version, marketplace,
              request_fingerprint, retry_of_usage_request_id, call_ordinal, call_role,
              dispatch_fingerprint${operationControl
                ? `, operation_policy_revision, operation_release_revision,
                   provider_price_book_version, provider_credential_revision`
                : ''}${costControl ? ', cost_minor, cost_kind, currency' : ''})
           SELECT $1, $13, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                  $15, $16, $17${operationControl
                    ? `, $${operationControlOffset}, $${operationControlOffset + 1},
                       $${operationControlOffset + 2}, $${operationControlOffset + 3}`
                    : ''}${costControl
                      ? `, $${costControlOffset}, $${costControlOffset + 1}, $${costControlOffset + 2}`
                      : ''}
             FROM owned_request
            WHERE $12::uuid IS NULL OR EXISTS (SELECT 1 FROM retry_target)
           RETURNING id, started_at`,
          values,
        )
        if (!rows[0]) {
          throw new AppError(
            409,
            input.retryOfRequestId
              ? 'uncertain_retry_not_allowed'
              : 'external_platform_usage_scope_mismatch',
            input.retryOfRequestId
              ? 'The referenced uncertain request cannot authorize this retry'
              : 'Provider call does not match its reserved usage request',
          )
        }
        // provider_state is one row per provider. Locking it here would hold
        // every concurrent dispatch for this provider behind each COMMIT flush.
        // last_call_at is an observation (the call row is the evidence), so
        // refresh it at most every 5 seconds and never wait for its lock.
        await client.query(
          `UPDATE external_platform.provider_state
              SET last_call_at = $1, updated_at = now()
            WHERE provider_key = (
              SELECT provider_key FROM external_platform.provider_state
               WHERE provider_key = $2
                 AND (last_call_at IS NULL OR last_call_at < $1::timestamptz - interval '5 seconds')
               FOR UPDATE SKIP LOCKED
            )`,
          [rows[0].started_at, this.providerKey],
        )
        return { id, startedAt: iso(rows[0].started_at) }
      })
    } catch (error) {
      if (error instanceof AppError && [
        'external_platform_cost_evidence_incomplete',
        'external_platform_cost_budget_exhausted',
        'external_platform_subsidy_budget_exhausted',
        'external_platform_cost_reservation_mismatch',
      ].includes(error.code)) {
        throw error
      }
      // A lost COMMIT acknowledgement is not evidence that the INSERT failed.
      // Reconcile by the preselected call id before allowing the caller to
      // release or reuse the usage reservation.
      let reconciled
      try {
        reconciled = await this.pool.query(
          `SELECT call.id, call.started_at
           FROM external_platform.provider_calls call
           JOIN usage_requests request ON request.id = call.usage_request_id
          WHERE call.id = $1
            AND call.provider_key = $13
            AND call.tenant_id = $2
            AND call.consumer_id = $3
            AND call.api_key_id = $4
            AND call.usage_request_id = $5
            AND call.operation = $6
            AND call.contract_version = $7
            AND call.endpoint_key = $8
            AND call.endpoint_version = $9
            AND call.marketplace = $10
            AND call.request_fingerprint = $11
            AND call.retry_of_usage_request_id IS NOT DISTINCT FROM $12::uuid
            AND call.call_ordinal = $15
            AND call.call_role = $16
            AND call.dispatch_fingerprint = $17
            ${operationControl
              ? `AND call.operation_policy_revision = $${operationControlOffset}
            AND call.operation_release_revision = $${operationControlOffset + 1}
            AND call.provider_price_book_version = $${operationControlOffset + 2}
            AND call.provider_credential_revision IS NOT DISTINCT FROM $${operationControlOffset + 3}::bigint`
              : ''}
            ${costControl ? `AND call.cost_minor = $${costControlOffset}
            AND call.cost_kind = $${costControlOffset + 1}
            AND call.currency = $${costControlOffset + 2}` : ''}
            AND call.outcome = 'pending'
            AND request.status = 'reserved'
            AND request.platform = $14
            AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())`,
          values,
        )
      } catch {
        throw new AppError(
          503,
          'external_platform_call_persistence_unknown',
          'Provider-call persistence could not be reconciled; do not retry automatically',
        )
      }
      if (reconciled.rows[0]) {
        return { id, startedAt: iso(reconciled.rows[0].started_at) }
      }
      if (
        error?.code === '23505'
        && error?.constraint === 'external_platform_provider_calls_retry_of_idx'
      ) {
        throw new AppError(
          409,
          'uncertain_retry_not_allowed',
          'The referenced uncertain request cannot authorize this retry',
        )
      }
      if (
        error?.code === '23505'
        && [
          'external_platform_provider_calls_usage_ordinal_idx',
          'provider_calls_pkey',
        ].includes(error?.constraint)
      ) {
        throw new AppError(
          409,
          'external_platform_call_exists',
          'Usage request call ordinal already exists',
        )
      }
      throw error
    }
  }

  async #readProviderEvidence(queryable, input, {
    lockCall = false,
    includeSnapshot = false,
    includeIngestJob = false,
  } = {}) {
    const callResult = await queryable.query(
      `SELECT call.*,
              archive.id AS response_archive_id,
              archive.contract_state AS archive_contract_state,
              archive.http_status AS archive_http_status,
              archive.business_code AS archive_business_code,
              archive.content_type AS archive_content_type,
              archive.body_size AS archive_body_size,
              archive.payload_sha256 AS archive_payload_sha256,
              archive.raw_payload AS archive_raw_payload,
              archive.captured_at AS archive_captured_at,
              restricted.id AS restricted_response_id,
              restricted.content_type AS restricted_content_type,
              restricted.body_size AS restricted_body_size,
              restricted.body_sha256 AS restricted_body_sha256,
              restricted.body_bytes AS restricted_body_bytes,
              restricted.body_text AS restricted_body_text,
              restricted.json_parsed AS restricted_json_parsed,
              restricted.parsed_payload AS restricted_parsed_payload,
              restricted.captured_at AS restricted_captured_at
         FROM external_platform.provider_calls call
         LEFT JOIN external_platform.response_archives archive
           ON archive.provider_call_id = call.id
         LEFT JOIN control.external_platform_restricted_raw_responses restricted
           ON restricted.provider_call_id = call.id
        WHERE call.id = $1
          AND call.provider_key = $2
        ${lockCall ? 'FOR UPDATE OF call' : ''}`,
      [input.callId, this.providerKey],
    )
    const row = callResult.rows[0] || null
    if (!row) return { row: null, archiveObjects: [], snapshot: null, ingestJob: null }
    const objectResult = await queryable.query(
      `SELECT provider_key, object_kind, marketplace, operation, endpoint_version,
              captured_date, archive_path, response_pointer, source_key,
              payload_sha256, raw_payload, item_ordinal
         FROM external_platform.archive_objects
        WHERE provider_call_id = $1
        ORDER BY item_ordinal`,
      [input.callId],
    )
    let snapshot = null
    if (includeSnapshot && input.snapshot) {
      const snapshotResult = await queryable.query(
        `SELECT * FROM external_platform.response_snapshots
          WHERE provider_key = $1 AND consumer_id = $2 AND operation = $3
            AND request_fingerprint = $4 AND last_success_call_id = $5`,
        [
          this.providerKey,
          input.delivery.consumerId,
          input.delivery.operation,
          snapshotFingerprint(input.delivery),
          input.callId,
        ],
      )
      snapshot = pgSnapshot(snapshotResult.rows[0])
    }
    let ingestJob = null
    if (includeIngestJob && input.ingestJob) {
      // Settlement reads this before and after writing the job. `=` is
      // indexable where IS NOT DISTINCT FROM is not, so a keyed job is found
      // through jobs_dedupe_lookup_idx instead of scanning every done job inside
      // the settlement transaction. Same rows for a non-null key.
      const dedupeKey = input.ingestJob.dedupeKey ?? null
      const ingestResult = await queryable.query(
        `SELECT queue, payload, dedupe_key, priority
           FROM mxq.jobs
          WHERE queue = $1 AND ${dedupeKey === null ? 'dedupe_key IS NULL' : 'dedupe_key = $2'}
          ORDER BY created_at DESC
          LIMIT 1`,
        dedupeKey === null
          ? [input.ingestJob.queue || this.queueName]
          : [input.ingestJob.queue || this.queueName, dedupeKey],
      )
      ingestJob = ingestResult.rows[0] || null
    }
    return { row, archiveObjects: objectResult.rows, snapshot, ingestJob }
  }

  #providerEvidenceMatches(state, input, {
    outcome = null,
    includeSnapshot = false,
    includeIngestJob = false,
  } = {}) {
    if (!state.row || !postgresCallScopeMatches(state.row, input, this.providerKey)) return false
    if (outcome != null && state.row.outcome !== outcome) return false
    if (!postgresCallEvidenceMatches(state.row, input)) return false
    if (!postgresResponseArchiveMatches(state.row, input.responseArchive ?? null)) return false
    if (!postgresRestrictedResponseArchiveMatches(
      state.row,
      input.restrictedResponseArchive ?? null,
    )) return false
    if (!postgresArchiveObjectsMatch(state.archiveObjects, input, this.providerKey)) return false
    if (includeSnapshot && !postgresSnapshotMatches(
      state.snapshot,
      input.snapshot ?? null,
      input.delivery,
      this.providerKey,
      input.callId,
    )) return false
    return !includeIngestJob || postgresIngestJobMatches(
      state.ingestJob,
      input.ingestJob ?? null,
      this.queueName,
    )
  }

  #stagedProviderEvidenceMatches(state, input) {
    if (!state.row || !postgresCallScopeMatches(state.row, input, this.providerKey)) return false
    if (!postgresCallEvidenceMatches(state.row, input, {
      // A later terminalizer may replace the staging error marker while all
      // immutable provider evidence remains intact. That does not make a
      // previously durable stage receipt disappear.
      ignoreErrorCode: state.row.outcome !== 'pending',
    })) return false
    return postgresResponseArchiveMatches(state.row, input.responseArchive ?? null)
      && postgresRestrictedResponseArchiveMatches(
        state.row,
        input.restrictedResponseArchive ?? null,
      )
      && postgresArchiveObjectsMatch(state.archiveObjects, input, this.providerKey)
  }

  #providerEvidenceCanBeWritten(state, input) {
    if (!state.row || !postgresCallScopeMatches(state.row, input, this.providerKey)) return false
    if (state.row.outcome !== 'pending') return false
    const costOnly = state.row.http_status == null
      && state.row.business_code == null
      && state.row.upstream_request_id == null
      && state.row.upstream_record_time == null
      && state.row.billed == null
      && (
        (
          state.row.cost_minor == null
          && state.row.cost_kind === 'unknown'
          && state.row.currency == null
        )
        || (
          nullableNumber(state.row.cost_minor) === nullableNumber(input.costMinor)
          && state.row.cost_kind === input.costKind
          && state.row.currency === input.currency
        )
      )
      && state.row.latency_ms == null
      && state.row.item_count == null
      && state.row.error_code == null
      && state.row.response_archive_id == null
      && state.row.restricted_response_id == null
      && state.archiveObjects.length === 0
    return costOnly || this.#providerEvidenceMatches(state, input, { outcome: 'pending' })
  }

  async stageProviderEvidence(input) {
    validateStagedEvidence(input)
    const stageOnce = () => transaction(this.pool, async (client) => {
      const current = await this.#readProviderEvidence(client, input, { lockCall: true })
      if (this.#stagedProviderEvidenceMatches(current, input)) {
        return {
          staged: true,
          reconciled: true,
          alreadySettled: current.row.outcome !== 'pending',
        }
      }
      if (!this.#providerEvidenceCanBeWritten(current, input)) throw evidenceConflict()
      const evidence = normalizedEvidence(input)
      const updated = await client.query(
        `UPDATE external_platform.provider_calls SET
           http_status = $2, business_code = $3,
           upstream_request_id = $4, upstream_record_time = $5,
           billed = $6, cost_minor = $7, cost_kind = $8, currency = $9,
           latency_ms = $10, item_count = $11, error_code = $12
         WHERE id = $1 AND outcome = 'pending'
         RETURNING id`,
        [
          input.callId,
          evidence.httpStatus,
          evidence.businessCode,
          evidence.upstreamRequestId,
          evidence.upstreamRecordTime,
          evidence.billed,
          evidence.costMinor,
          evidence.costKind,
          evidence.currency,
          evidence.latencyMs,
          evidence.itemCount,
          evidence.errorCode,
        ],
      )
      if (!updated.rows[0]) throw evidenceConflict()
      await this.#insertResponseArchive(client, input.callId, evidence.responseArchive)
      await this.#insertRestrictedResponseArchive(
        client,
        input.callId,
        evidence.restrictedResponseArchive,
      )
      await this.#insertArchiveObjects(client, {
        callId: input.callId,
        delivery: input.delivery,
        capturedAt: evidence.responseArchive.capturedAt,
        archiveObjects: evidence.archiveObjects,
      })
      const staged = await this.#readProviderEvidence(client, input)
      if (!this.#providerEvidenceMatches(staged, input, { outcome: 'pending' })) {
        throw evidenceConflict()
      }
      return { staged: true, reconciled: false, alreadySettled: false }
    })

    try {
      return await stageOnce()
    } catch (firstError) {
      const reconciled = await this.#readProviderEvidence(this.pool, input).catch(() => null)
      if (reconciled && this.#stagedProviderEvidenceMatches(reconciled, input)) {
        return {
          staged: true,
          reconciled: true,
          alreadySettled: reconciled.row.outcome !== 'pending',
        }
      }
      if (!reconciled || !this.#providerEvidenceCanBeWritten(reconciled, input)) throw firstError
      try {
        return await stageOnce()
      } catch (retryError) {
        const retryReconciled = await this.#readProviderEvidence(this.pool, input).catch(() => null)
        if (retryReconciled && this.#stagedProviderEvidenceMatches(retryReconciled, input)) {
          return {
            staged: true,
            reconciled: true,
            alreadySettled: retryReconciled.row.outcome !== 'pending',
          }
        }
        throw retryError
      }
    }
  }

  async commitLiveDelivery({
    callId,
    delivery,
    responseBody,
    snapshotBody = responseBody,
    capturedAt,
    freshUntil,
    staleUntil,
    itemCount,
    latencyMs,
    usageLatencyMs = latencyMs,
    usageUnitsActual = Math.max(1, itemCount),
    billed,
    costMinor,
    costKind,
    currency,
    archiveObjects = [],
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    ingestJob = null,
  }) {
    return transaction(this.pool, async (client) => {
      const call = await client.query(
        `UPDATE external_platform.provider_calls SET
           outcome = 'succeeded', http_status = $2, business_code = $3,
           upstream_request_id = $4, upstream_record_time = $5,
           billed = $6, cost_minor = $7, cost_kind = $8, currency = $9,
           latency_ms = $10, item_count = $11, completed_at = now()
         WHERE id = $1 AND outcome = 'pending'
         RETURNING id`,
        [
          callId,
          responseArchive?.httpStatus ?? 200,
          responseArchive?.businessCode ?? 0,
          upstreamEvidence?.requestId ?? null,
          upstreamEvidence?.recordTime ?? null,
          billed,
          costMinor,
          costKind,
          currency,
          latencyMs,
          itemCount,
        ],
      )
      if (!call.rows[0]) {
        throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
      }
      await this.#insertResponseArchive(client, callId, responseArchive)
      await this.#insertRestrictedResponseArchive(client, callId, restrictedResponseArchive)

      const snapshotId = randomUUID()
      const snapshotResult = await client.query(
        `INSERT INTO external_platform.response_snapshots
           (id, provider_key, consumer_id, operation, request_fingerprint,
            response_body, captured_at, fresh_until, stale_until, last_success_call_id)
         VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (consumer_id, operation, request_fingerprint) DO UPDATE SET
           provider_key = EXCLUDED.provider_key,
           response_body = EXCLUDED.response_body,
           captured_at = EXCLUDED.captured_at,
           fresh_until = EXCLUDED.fresh_until,
           stale_until = EXCLUDED.stale_until,
           last_success_call_id = EXCLUDED.last_success_call_id,
           updated_at = now()
         RETURNING *`,
        [
          snapshotId, delivery.consumerId, delivery.operation, snapshotFingerprint(delivery),
          snapshotBody, capturedAt, freshUntil, staleUntil, callId,
          this.providerKey,
        ],
      )
      const snapshot = pgSnapshot(snapshotResult.rows[0])

      await this.#insertArchiveObjects(client, {
        callId,
        delivery,
        capturedAt,
        archiveObjects,
      })

      const usage = await client.query(
        `UPDATE usage_requests SET
           status = 'committed', response_status = 200, response_body = $2,
           units_actual = $3, upstream_latency_ms = $4,
           delivery_source_mode = 'live', response_captured_at = $5,
           completed_at = now()
         WHERE id = $1 AND status = 'reserved'
         RETURNING id`,
        [
          delivery.usageRequestId,
          responseBody,
          Math.max(1, usageUnitsActual),
          usageLatencyMs,
          capturedAt,
        ],
      )
      if (!usage.rows[0]) throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')

      await this.#insertGatewayRequest(client, {
        ...delivery,
        sourceMode: 'live',
        succeeded: true,
        responseStatus: 200,
        providerCallId: callId,
        snapshotId: snapshot.id,
      })
      await this.#recordProviderSuccess(client, callId)
      await this.#insertIngestJob(client, ingestJob)
      return { snapshot }
    })
  }

  async finishProviderStep({
    callId,
    delivery,
    outcome,
    httpStatus = null,
    businessCode = null,
    billed = null,
    costMinor = null,
    costKind = 'unknown',
    currency = null,
    latencyMs = null,
    itemCount = null,
    errorCode = null,
    affectsCircuit = true,
    // Which breaker this failure belongs to; see #advanceFailureState.
    circuitCategory = null,
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    archiveObjects = [],
    snapshot = null,
    ingestJob = null,
  }) {
    if (!FINISHED_PROVIDER_OUTCOMES.has(outcome)) {
      throw new TypeError('outcome must be a finished provider-call outcome')
    }
    if (snapshot && outcome !== 'succeeded') {
      throw new TypeError('only a succeeded provider step may write a snapshot')
    }
    const settlement = {
      callId,
      delivery,
      outcome,
      httpStatus,
      businessCode,
      billed,
      costMinor,
      costKind,
      currency,
      latencyMs,
      itemCount,
      errorCode,
      affectsCircuit,
      responseArchive,
      restrictedResponseArchive,
      upstreamEvidence,
      archiveObjects,
      snapshot,
      ingestJob,
    }
    const settleOnce = () => transaction(this.pool, async (client) => {
      const current = await this.#readProviderEvidence(client, settlement, {
        lockCall: true,
        includeSnapshot: true,
        includeIngestJob: true,
      })
      if (this.#providerEvidenceMatches(current, settlement, {
        outcome,
        includeSnapshot: true,
        includeIngestJob: true,
      })) {
        return { snapshot: current.snapshot, reconciled: true }
      }
      if (!this.#providerEvidenceCanBeWritten(current, settlement)) throw evidenceConflict()
      const completed = await client.query(
        `UPDATE external_platform.provider_calls SET
           outcome = $2, http_status = $3, business_code = $4,
           upstream_request_id = $5, upstream_record_time = $6,
           billed = $7, cost_minor = $8, cost_kind = $9, currency = $10,
           latency_ms = $11, item_count = $12, error_code = $13,
           completed_at = now()
         WHERE id = $1 AND outcome = 'pending'
         RETURNING id`,
        [
          callId, outcome,
          responseArchive?.httpStatus ?? httpStatus,
          responseArchive?.businessCode ?? businessCode,
          upstreamEvidence?.requestId ?? null,
          upstreamEvidence?.recordTime ?? null,
          billed, costMinor, costKind, currency, latencyMs, itemCount, errorCode,
        ],
      )
      if (!completed.rows[0]) {
        throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
      }
      await this.#insertResponseArchive(client, callId, responseArchive)
      await this.#insertRestrictedResponseArchive(client, callId, restrictedResponseArchive)
      await this.#insertArchiveObjects(client, {
        callId,
        delivery,
        capturedAt: responseArchive?.capturedAt ?? snapshot?.capturedAt ?? new Date(),
        archiveObjects,
      })

      let storedSnapshot = null
      if (snapshot) {
        const snapshotId = randomUUID()
        const snapshotResult = await client.query(
          `INSERT INTO external_platform.response_snapshots
             (id, provider_key, consumer_id, operation, request_fingerprint,
              response_body, captured_at, fresh_until, stale_until, last_success_call_id)
           VALUES ($1, $10, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (consumer_id, operation, request_fingerprint) DO UPDATE SET
             provider_key = EXCLUDED.provider_key,
             response_body = EXCLUDED.response_body,
             captured_at = EXCLUDED.captured_at,
             fresh_until = EXCLUDED.fresh_until,
             stale_until = EXCLUDED.stale_until,
             last_success_call_id = EXCLUDED.last_success_call_id,
             updated_at = now()
           RETURNING *`,
          [
            snapshotId, delivery.consumerId, delivery.operation,
            snapshotFingerprint(delivery), snapshot.responseBody, snapshot.capturedAt,
            snapshot.freshUntil, snapshot.staleUntil, callId, this.providerKey,
          ],
        )
        storedSnapshot = pgSnapshot(snapshotResult.rows[0])
      }

      if (outcome === 'succeeded') {
        await this.#recordProviderSuccess(client, callId)
        // A marketplace that parses again is no longer the broken one.
        await this.#clearContractCircuit(client, delivery?.marketplace ?? null, callId)
      } else if (affectsCircuit) {
        await this.#advanceFailureState(client, errorCode, {
          circuitCategory,
          scope: delivery?.marketplace ?? null,
        })
      }
      await this.#insertIngestJob(client, ingestJob)
      const settled = await this.#readProviderEvidence(client, settlement, {
        includeSnapshot: true,
        includeIngestJob: true,
      })
      if (!this.#providerEvidenceMatches(settled, settlement, {
        outcome,
        includeSnapshot: true,
        includeIngestJob: true,
      })) throw evidenceConflict()
      return { snapshot: settled.snapshot ?? storedSnapshot }
    })
    const reconcile = async () => {
      const state = await this.#readProviderEvidence(this.pool, settlement, {
        includeSnapshot: true,
        includeIngestJob: true,
      })
      if (this.#providerEvidenceMatches(state, settlement, {
        outcome,
        includeSnapshot: true,
        includeIngestJob: true,
      })) {
        return { kind: 'matched', snapshot: state.snapshot }
      }
      if (this.#providerEvidenceCanBeWritten(state, settlement)) return { kind: 'pending' }
      return { kind: 'conflict' }
    }

    try {
      return await settleOnce()
    } catch (firstError) {
      const firstState = await reconcile().catch(() => null)
      if (firstState?.kind === 'matched') {
        return { snapshot: firstState.snapshot, reconciled: true }
      }
      if (firstState?.kind !== 'pending') throw firstError
      try {
        return await settleOnce()
      } catch (retryError) {
        const retryState = await reconcile().catch(() => null)
        if (retryState?.kind === 'matched') {
          return { snapshot: retryState.snapshot, reconciled: true }
        }
        throw retryError
      }
    }
  }

  async commitSnapshotDelivery({
    delivery,
    snapshot,
    sourceMode,
    shared = false,
    responseBody = snapshot.responseBody,
    usageUnitsActual = Math.max(1, deliveredItemCount(responseBody)),
  }) {
    return transaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM external_platform.response_snapshots
          WHERE id = $1 AND (consumer_id = $2 OR ($5 AND operation = 'social.posts.analytics')) AND operation = $3
            AND request_fingerprint = $4 AND stale_until >= now() AND provider_key = $6
          FOR SHARE`,
        [snapshot.id, delivery.consumerId, delivery.operation, snapshotFingerprint(delivery), shared, this.providerKey],
      )
      const current = pgSnapshot(locked.rows[0])
      if (!current) throw new AppError(409, 'external_platform_snapshot_unavailable', 'Stored response is unavailable')
      const usage = await client.query(
        `UPDATE usage_requests SET
           status = 'committed', response_status = 200, response_body = $2,
           units_actual = $3, upstream_latency_ms = 0,
           delivery_source_mode = $4, response_captured_at = $5,
           completed_at = now()
         WHERE id = $1 AND status = 'reserved'
         RETURNING id`,
        [
          delivery.usageRequestId,
          responseBody,
          Math.max(1, usageUnitsActual),
          sourceMode === 'stored_fallback' ? 'stale' : 'live',
          current.capturedAt,
        ],
      )
      if (!usage.rows[0]) throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')
      await this.#insertGatewayRequest(client, {
        ...delivery,
        sourceMode,
        succeeded: true,
        responseStatus: 200,
        snapshotId: current.id,
      })
    })
  }

  async #recordProviderSuccess(client, callId) {
    // Settlement can lag acquisition (notably while search enriches its rows).
    // Only a call started after the latest failure is evidence of recovery.
    // A healthy provider would only move last_success_at here; writing it on
    // every settlement serialises all settlements of this provider on one row
    // until each COMMIT flush. Recovery fields are always applied.
    await client.query(
      `UPDATE external_platform.provider_state SET
         consecutive_failures = CASE WHEN last_failure_at > call.started_at THEN consecutive_failures ELSE 0 END,
         circuit_open_until = CASE WHEN last_failure_at > call.started_at THEN circuit_open_until ELSE NULL END,
         last_error_code = CASE WHEN last_failure_at > call.started_at THEN last_error_code ELSE NULL END,
         last_success_at = now(), updated_at = now()
       FROM external_platform.provider_calls AS call
       WHERE provider_state.provider_key = $1 AND call.id = $2
         AND call.provider_key = provider_state.provider_key
         AND (provider_state.consecutive_failures <> 0
           OR provider_state.circuit_open_until IS NOT NULL
           OR provider_state.last_error_code IS NOT NULL
           OR provider_state.last_success_at IS NULL
           OR provider_state.last_success_at < now() - interval '5 seconds')`,
      [this.providerKey, callId],
    )
  }

  async #advanceFailureState(client, errorCode, { circuitCategory = null, scope = null } = {}) {
    // Contract failures belong to one marketplace; everything else is a
    // provider-wide condition. Same split as the memory store.
    if (circuitCategory === 'contract' && scope) {
      await this.#recordContractFailure(client, scope, errorCode)
      return
    }
    await client.query(
      `UPDATE external_platform.provider_state SET
         consecutive_failures = consecutive_failures + 1,
         circuit_open_until = CASE
           WHEN consecutive_failures + 1 >= $1
             THEN now() + make_interval(secs => $2)
           ELSE circuit_open_until
         END,
         last_failure_at = now(), last_error_code = $3, updated_at = now()
       WHERE provider_key = $4`,
      [this.circuitFailureThreshold, Math.ceil(this.circuitOpenMs / 1_000), errorCode, this.providerKey],
    )
  }

  async finishFailure({
    callId,
    delivery,
    outcome,
    httpStatus,
    businessCode,
    billed,
    costMinor = null,
    costKind = 'unknown',
    currency = null,
    latencyMs,
    errorCode,
    failureResponseStatus = 502,
    failureResponseBody = null,
    affectsCircuit = true,
    // Which breaker this failure belongs to; see #advanceFailureState.
    circuitCategory = null,
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    archiveObjects = [],
    snapshot = null,
    fallbackResponseBody = snapshot?.responseBody,
    usageUnitsActual = Math.max(1, deliveredItemCount(fallbackResponseBody)),
  }) {
    return transaction(this.pool, async (client) => {
      const completed = await client.query(
        `UPDATE external_platform.provider_calls SET
           outcome = $2, http_status = $3, business_code = $4, billed = $5,
           cost_minor = $6, cost_kind = $7, currency = $8,
           upstream_request_id = $9, upstream_record_time = $10,
           latency_ms = $11, error_code = $12, completed_at = now()
         WHERE id = $1 AND outcome = 'pending'
         RETURNING id`,
        [
          callId, outcome, httpStatus, businessCode, billed, costMinor, costKind,
          currency, upstreamEvidence?.requestId ?? null,
          upstreamEvidence?.recordTime ?? null, latencyMs, errorCode,
        ],
      )
      if (!completed.rows[0]) {
        throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
      }
      await this.#insertResponseArchive(client, callId, responseArchive)
      await this.#insertRestrictedResponseArchive(client, callId, restrictedResponseArchive)
      await this.#insertArchiveObjects(client, {
        callId,
        delivery,
        capturedAt: responseArchive?.capturedAt ?? new Date(),
        archiveObjects,
      })
      if (affectsCircuit) {
        await this.#advanceFailureState(client, errorCode, {
          circuitCategory,
          scope: delivery?.marketplace ?? null,
        })
      }
      if (snapshot) {
        const locked = await client.query(
          `SELECT * FROM external_platform.response_snapshots
            WHERE id = $1 AND consumer_id = $2 AND operation = $3
              AND request_fingerprint = $4 AND stale_until >= now()
            FOR SHARE`,
          [snapshot.id, delivery.consumerId, delivery.operation, snapshotFingerprint(delivery)],
        )
        const current = pgSnapshot(locked.rows[0])
        if (!current) throw new AppError(409, 'external_platform_snapshot_unavailable', 'Stored response is unavailable')
        const usage = await client.query(
          `UPDATE usage_requests SET
             status = 'committed', response_status = 200, response_body = $2,
             units_actual = $3, upstream_latency_ms = $4,
             delivery_source_mode = 'stale', response_captured_at = $5,
             completed_at = now()
           WHERE id = $1 AND status = 'reserved'
           RETURNING id`,
          [
            delivery.usageRequestId,
            fallbackResponseBody,
            Math.max(1, usageUnitsActual),
            latencyMs,
            current.capturedAt,
          ],
        )
        if (!usage.rows[0]) throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')
        await this.#insertGatewayRequest(client, {
          ...delivery,
          sourceMode: 'stored_fallback',
          succeeded: true,
          responseStatus: 200,
          providerCallId: callId,
          snapshotId: current.id,
          errorCode,
        })
        return
      }

      // IP subscriptions accept one committed unit only for a usable delivery.
      // A definitive failure must release the hold, not commit zero units and
      // turn a known rejection into a persistence-unknown outcome.
      const usage = outcome === 'rejected' || outcome === 'succeeded_unusable'
        ? await client.query(
            `UPDATE usage_requests SET
               status = CASE WHEN $7::boolean THEN 'released' ELSE 'committed' END, response_status = $2, response_body = $3,
               units_actual = 0, upstream_latency_ms = $4,
               delivery_source_mode = 'live', response_captured_at = $5,
               error_code = $6, completed_at = now()
             WHERE id = $1 AND status = 'reserved'
             RETURNING id`,
            [
              delivery.usageRequestId,
              failureResponseStatus,
              failureResponseBody || {
                error: { code: errorCode, message: 'External data platform rejected the request' },
              },
              latencyMs,
              responseArchive?.capturedAt ?? new Date(),
              errorCode,
              this.providerKey === 'ipsearch' || this.providerKey === 'baidu-ip' || (this.providerKey === 'qixin' && outcome === 'rejected'),
            ],
          )
        : await client.query(
            `UPDATE usage_requests SET
               status = 'unknown', error_code = $2, completed_at = now()
             WHERE id = $1 AND status = 'reserved'
             RETURNING id`,
            [delivery.usageRequestId, errorCode],
          )
      if (!usage.rows[0]) {
        throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')
      }
      await this.#insertGatewayRequest(client, {
        ...delivery,
        sourceMode: 'unavailable',
        succeeded: false,
        responseStatus: failureResponseStatus,
        providerCallId: callId,
        errorCode,
      })
    })
  }

  async rejectWithoutDispatch({ delivery, sourceMode, status, errorCode }) {
    return transaction(this.pool, async (client) => {
      const usage = await client.query(
        `UPDATE usage_requests SET status = 'released', error_code = $2, completed_at = now()
          WHERE id = $1 AND status = 'reserved'
          RETURNING id`,
        [delivery.usageRequestId, errorCode],
      )
      if (!usage.rows[0]) {
        throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')
      }
      await this.#insertGatewayRequest(client, {
        ...delivery,
        sourceMode,
        succeeded: false,
        responseStatus: status,
        errorCode,
      })
    })
  }

  async markPersistenceUnknown({
    callId,
    delivery,
    billed = null,
    costMinor = null,
    costKind = 'unknown',
    currency = null,
    latencyMs = null,
    responseArchive = null,
    restrictedResponseArchive = null,
    upstreamEvidence = null,
    archiveObjects = [],
    errorCode = 'external_platform_persistence_unknown',
  }) {
    return transaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE external_platform.provider_calls SET
           outcome = 'unknown', billed = $2, cost_minor = $3, cost_kind = $4,
           currency = $5, upstream_request_id = $6, upstream_record_time = $7,
           latency_ms = $8, error_code = $9, completed_at = now()
         WHERE id = $1 AND outcome = 'pending'
         RETURNING id`,
        [
          callId, billed, costMinor, costKind, currency,
          upstreamEvidence?.requestId ?? null, upstreamEvidence?.recordTime ?? null,
          latencyMs, errorCode,
        ],
      )
      // A lost COMMIT acknowledgement may mean the primary transaction already
      // succeeded. In that case its non-pending row is authoritative.
      if (!updated.rows[0]) return false
      await this.#insertResponseArchive(client, callId, responseArchive)
      await this.#insertRestrictedResponseArchive(client, callId, restrictedResponseArchive)
      await this.#insertArchiveObjects(client, {
        callId,
        delivery,
        capturedAt: responseArchive?.capturedAt ?? new Date(),
        archiveObjects,
      })
      const usage = await client.query(
        `UPDATE usage_requests SET status = 'unknown', error_code = $2, completed_at = now()
          WHERE id = $1 AND status = 'reserved'
          RETURNING id`,
        [delivery.usageRequestId, errorCode],
      )
      if (!usage.rows[0]) {
        throw new AppError(409, 'usage_request_state_conflict', 'Usage request is not reserved')
      }
      await this.#insertGatewayRequest(client, {
        ...delivery,
        sourceMode: 'unavailable',
        succeeded: false,
        responseStatus: 503,
        providerCallId: callId,
        errorCode,
      })
      return true
    })
  }

  async recordReplay({
    delivery,
    sourceMode = 'idempotent_replay',
    succeeded = true,
    status = 200,
    errorCode = null,
  }) {
    await this.#insertGatewayRequest(this.pool, {
      ...delivery,
      sourceMode,
      succeeded,
      responseStatus: status,
      errorCode,
    })
  }

  async recordGatewayAttempt({ delivery, sourceMode, succeeded, status, errorCode = null }) {
    await this.#insertGatewayRequest(this.pool, {
      ...delivery,
      sourceMode,
      succeeded,
      responseStatus: status,
      errorCode,
    })
  }

  async #insertIngestJob(client, ingestJob) {
    if (!ingestJob) return
    await client.query(
      `INSERT INTO mxq.jobs (queue, payload, dedupe_key, priority)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (queue, dedupe_key)
         WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
       DO NOTHING`,
      [
        ingestJob.queue || this.queueName,
        ingestJob.payload,
        ingestJob.dedupeKey,
        ingestJob.priority ?? 100,
      ],
    )
  }

  async #insertGatewayRequest(client, input) {
    await client.query(
      `INSERT INTO external_platform.gateway_requests
         (id, provider_key, tenant_id, consumer_id, usage_request_id,
          request_fingerprint, source_mode, succeeded, response_status,
          provider_call_id, snapshot_id, error_code)
       VALUES ($1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(), input.tenantId, input.consumerId, input.usageRequestId,
        input.fingerprint, input.sourceMode, input.succeeded,
        input.responseStatus, input.providerCallId ?? null, input.snapshotId ?? null,
        input.errorCode ?? null, this.providerKey,
      ],
    )
  }

  async #insertResponseArchive(client, callId, archive) {
    if (!archive) return
    await client.query(
      `INSERT INTO external_platform.response_archives
         (id, provider_call_id, contract_state, http_status, business_code,
          content_type, body_size, payload_sha256, raw_payload, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (provider_call_id) DO NOTHING`,
      [
        randomUUID(), callId, archive.contractState || 'unknown', archive.httpStatus ?? null,
        archive.businessCode ?? null, archive.contentType ?? null,
        archive.bodySize ?? null, archive.payloadSha256 ?? null,
        archive.rawPayload ?? null, archive.capturedAt ?? new Date(),
      ],
    )
  }

  async #insertRestrictedResponseArchive(client, callId, input) {
    const archive = normalizedRestrictedResponseArchive(input)
    if (!archive) return
    await client.query(
      `INSERT INTO control.external_platform_restricted_raw_responses
         (id, provider_call_id, content_type, body_size, body_sha256,
          body_bytes, body_text, json_parsed, parsed_payload, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (provider_call_id) DO NOTHING`,
      [
        randomUUID(), callId, archive.contentType, archive.bodySize,
        archive.bodySha256, archive.bodyBytes, archive.bodyText,
        archive.jsonParsed, archive.parsedPayload, archive.capturedAt,
      ],
    )
  }

  async #insertArchiveObjects(client, { callId, delivery, capturedAt, archiveObjects }) {
    const capturedDate = iso(capturedAt).slice(0, 10)
    for (const object of archiveObjects) {
      if (object.capturedDate !== capturedDate) {
        throw new AppError(
          500,
          'external_platform_archive_date_invalid',
          'External platform archive date does not match its UTC capture time',
        )
      }
    }
    // One acquired page must not require a database round trip per item before
    // the caller receives it. Keep every object in this same transaction, but
    // bound each statement by encoded bytes/rows. At 14 parameters per row,
    // 1000 rows also stay well below PostgreSQL's parameter limit. An individual
    // large object stays whole in its own batch.
    const maxBatchBytes = 1024 * 1024
    const maxBatchRows = 1000
    let rows = []
    let batchBytes = 2
    const flush = async () => {
      if (!rows.length) return
      await client.query(
        `INSERT INTO external_platform.archive_objects
           (id, provider_key, object_kind, marketplace, operation, endpoint_version,
            captured_date, archive_path, response_pointer, source_key, payload_sha256,
            raw_payload, provider_call_id, item_ordinal)
         VALUES ${rows.map((_, index) => `(${Array.from({ length: 14 }, (_, column) =>
           `$${index * 14 + column + 1}${column === 6 ? '::date' : ''}`).join(', ')})`).join(', ')}
         ON CONFLICT (provider_call_id, item_ordinal) DO NOTHING`,
        rows.flat(),
      )
      rows = []
      batchBytes = 2
    }
    for (const [ordinal, object] of archiveObjects.entries()) {
      const row = [
        randomUUID(), this.providerKey, object.kind === 'response' ? 'response' : 'item',
        object.marketplace, delivery.operation, object.endpointVersion,
        capturedDate, object.archivePath, object.envelopePointer || '$', object.sourceKey,
        object.payloadSha256,
        // Keep node-postgres's original value encoding. An absent response
        // projection is JSON null; an item null must still fail NOT NULL.
        object.kind === 'response' && object.rawPayload === null ? 'null' : object.rawPayload,
        callId, ordinal,
      ]
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
      if (rows.length && (rows.length >= maxBatchRows || batchBytes + rowBytes + 1 > maxBatchBytes)) {
        await flush()
      }
      batchBytes += rowBytes + (rows.length ? 1 : 0)
      rows.push(row)
    }
    await flush()
  }

  async analytics({ from, bucket = 'hour' }) {
    const providerKey = this.providerKey
    const bucketSql = bucket === 'day' ? 'day' : 'hour'
    const [requestResult, callResult, trendResult, tenantResult, endpointResult, state] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::integer AS hub_requests,
                count(*) FILTER (WHERE succeeded)::integer AS successful_hub_requests,
                count(*) FILTER (WHERE source_mode = 'fresh_cache')::integer AS fresh_cache,
                count(*) FILTER (WHERE source_mode = 'stored_fallback')::integer AS stored_fallback,
                count(*) FILTER (
                  WHERE source_mode = 'stored_fallback' AND provider_call_id IS NULL
                )::integer AS stored_fallback_without_dispatch,
                count(*) FILTER (
                  WHERE source_mode = 'stored_fallback' AND provider_call_id IS NOT NULL
                )::integer AS stored_fallback_after_dispatch,
                count(*) FILTER (WHERE source_mode = 'idempotent_replay')::integer AS idempotent_replay,
                count(*) FILTER (WHERE source_mode = 'duplicate_suppressed')::integer AS duplicate_suppressed,
                count(*) FILTER (WHERE source_mode = 'circuit_rejected')::integer AS circuit_rejected
           FROM external_platform.gateway_requests
          WHERE provider_key = $2 AND created_at >= $1`,
        [from, providerKey],
      ),
      this.pool.query(
        `SELECT count(*)::integer AS upstream_calls,
                count(*) FILTER (
                  WHERE outcome IN ('succeeded', 'succeeded_unusable')
                )::integer AS successful_upstream_calls,
                count(*) FILTER (WHERE outcome = 'succeeded')::integer AS usable_upstream_calls,
                count(*) FILTER (WHERE outcome = 'succeeded_unusable')::integer AS unusable_successes,
                count(*) FILTER (WHERE billed IS TRUE)::integer AS billed_calls,
                count(*) FILTER (WHERE billed IS NULL)::integer AS indeterminate_billing_calls,
                count(*) FILTER (WHERE outcome = 'unknown')::integer AS unknown_outcomes,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                  FILTER (WHERE latency_ms IS NOT NULL) AS p95_latency_ms,
                sum(cost_minor) FILTER (WHERE cost_minor IS NOT NULL)::bigint AS known_cost_minor,
                count(*) FILTER (WHERE billed IS TRUE AND cost_minor IS NULL)::integer
                  AS unknown_cost_calls,
                max(started_at) AS last_call_at,
                max(completed_at) FILTER (WHERE outcome = 'succeeded') AS last_success_at
           FROM external_platform.provider_calls
          WHERE provider_key = $2 AND started_at >= $1`,
        [from, providerKey],
      ),
      this.pool.query(
        `WITH requests AS (
           SELECT date_trunc('${bucketSql}', created_at) AS bucket,
                  count(*)::integer AS hub_requests,
                  count(*) FILTER (WHERE source_mode = 'fresh_cache')::integer AS fresh_cache,
                  count(*) FILTER (WHERE source_mode = 'stored_fallback')::integer AS stored_fallback,
                  count(*) FILTER (
                    WHERE source_mode = 'stored_fallback' AND provider_call_id IS NULL
                  )::integer AS stored_fallback_without_dispatch,
                  count(*) FILTER (WHERE source_mode = 'idempotent_replay')::integer AS idempotent_replay,
                  count(*) FILTER (WHERE source_mode = 'duplicate_suppressed')::integer AS duplicate_suppressed,
                  count(*) FILTER (WHERE source_mode = 'circuit_rejected')::integer AS circuit_rejected,
                  count(*) FILTER (WHERE NOT succeeded)::integer AS rejected,
                  count(*) FILTER (WHERE succeeded)::integer AS succeeded
             FROM external_platform.gateway_requests
            WHERE provider_key = $2 AND created_at >= $1
            GROUP BY 1
         ), calls AS (
           SELECT date_trunc('${bucketSql}', started_at) AS bucket,
                  count(*)::integer AS upstream_calls,
                  sum(cost_minor) FILTER (WHERE cost_minor IS NOT NULL)::bigint AS cost_minor
             FROM external_platform.provider_calls
            WHERE provider_key = $2 AND started_at >= $1
            GROUP BY 1
         )
         SELECT coalesce(requests.bucket, calls.bucket) AS bucket,
                coalesce(requests.hub_requests, 0)::integer AS hub_requests,
                coalesce(requests.fresh_cache, 0)::integer AS fresh_cache,
                coalesce(requests.stored_fallback, 0)::integer AS stored_fallback,
                coalesce(requests.stored_fallback_without_dispatch, 0)::integer
                  AS stored_fallback_without_dispatch,
                coalesce(requests.idempotent_replay, 0)::integer AS idempotent_replay,
                coalesce(requests.duplicate_suppressed, 0)::integer AS duplicate_suppressed,
                coalesce(requests.circuit_rejected, 0)::integer AS circuit_rejected,
                coalesce(requests.rejected, 0)::integer AS rejected,
                coalesce(requests.succeeded, 0)::integer AS succeeded,
                coalesce(calls.upstream_calls, 0)::integer AS upstream_calls,
                calls.cost_minor
           FROM requests FULL OUTER JOIN calls USING (bucket)
          ORDER BY bucket`,
        [from, providerKey],
      ),
      this.pool.query(
        `WITH request_totals AS (
           SELECT tenant_id,
                  count(*)::integer AS hub_requests,
                  count(*) FILTER (WHERE succeeded)::integer AS succeeded
             FROM external_platform.gateway_requests
            WHERE provider_key = $2 AND created_at >= $1
            GROUP BY tenant_id
         ), call_totals AS (
           SELECT tenant_id,
                  count(*)::integer AS upstream_calls,
                  sum(cost_minor) FILTER (WHERE cost_minor IS NOT NULL)::bigint AS cost_minor
             FROM external_platform.provider_calls
            WHERE provider_key = $2 AND started_at >= $1
            GROUP BY tenant_id
         ), scoped_tenants AS (
           SELECT tenant_id FROM request_totals
           UNION
           SELECT tenant_id FROM call_totals
         )
         SELECT tenant.id, tenant.name,
                coalesce(requests.hub_requests, 0)::integer AS hub_requests,
                coalesce(requests.succeeded, 0)::integer AS succeeded,
                coalesce(calls.upstream_calls, 0)::integer AS upstream_calls,
                calls.cost_minor
           FROM scoped_tenants scope
           JOIN tenants tenant ON tenant.id = scope.tenant_id
           LEFT JOIN request_totals requests ON requests.tenant_id = tenant.id
           LEFT JOIN call_totals calls ON calls.tenant_id = tenant.id
          ORDER BY hub_requests DESC, tenant.name
          LIMIT 20`,
        [from, providerKey],
      ),
      this.pool.query(
        `SELECT endpoint_key, endpoint_version, marketplace,
                count(*)::integer AS calls,
                count(*) FILTER (
                  WHERE outcome IN ('succeeded', 'succeeded_unusable')
                )::integer AS succeeded,
                count(*) FILTER (WHERE outcome = 'succeeded')::integer AS usable,
                sum(cost_minor) FILTER (WHERE cost_minor IS NOT NULL)::bigint AS cost_minor
           FROM external_platform.provider_calls
          WHERE provider_key = $2 AND started_at >= $1
          GROUP BY endpoint_key, endpoint_version, marketplace
          ORDER BY calls DESC, endpoint_key`,
        [from, providerKey],
      ),
      this.providerState(providerKey),
    ])
    const request = requestResult.rows[0]
    const call = callResult.rows[0]
    return {
      totals: {
        hubRequests: Number(request.hub_requests),
        successfulHubRequests: Number(request.successful_hub_requests),
        freshCache: Number(request.fresh_cache),
        storedFallback: Number(request.stored_fallback),
        storedFallbackWithoutDispatch: Number(request.stored_fallback_without_dispatch),
        storedFallbackAfterDispatch: Number(request.stored_fallback_after_dispatch),
        idempotentReplay: Number(request.idempotent_replay),
        duplicateSuppressed: Number(request.duplicate_suppressed),
        circuitRejected: Number(request.circuit_rejected),
        upstreamCalls: Number(call.upstream_calls),
        successfulUpstreamCalls: Number(call.successful_upstream_calls),
        usableUpstreamCalls: Number(call.usable_upstream_calls),
        unusableSuccesses: Number(call.unusable_successes),
        billedCalls: Number(call.billed_calls),
        indeterminateBillingCalls: Number(call.indeterminate_billing_calls),
        unknownOutcomes: Number(call.unknown_outcomes),
        p95LatencyMs: call.p95_latency_ms == null ? null : Math.round(Number(call.p95_latency_ms)),
        knownCostMinor: call.known_cost_minor == null ? null : Number(call.known_cost_minor),
        unknownCostCalls: Number(call.unknown_cost_calls),
        lastCallAt: call.last_call_at ? iso(call.last_call_at) : state?.lastCallAt ?? null,
        lastSuccessAt: call.last_success_at ? iso(call.last_success_at) : state?.lastSuccessAt ?? null,
      },
      timeSeries: trendResult.rows.map((row) => ({
        bucket: iso(row.bucket),
        hubRequests: Number(row.hub_requests),
        successfulHubRequests: Number(row.succeeded),
        upstreamCalls: Number(row.upstream_calls),
        freshCache: Number(row.fresh_cache),
        storedFallback: Number(row.stored_fallback),
        storedFallbackWithoutDispatch: Number(row.stored_fallback_without_dispatch),
        idempotentReplay: Number(row.idempotent_replay),
        duplicateSuppressed: Number(row.duplicate_suppressed),
        circuitRejected: Number(row.circuit_rejected),
        rejected: Number(row.rejected),
        knownCostMinor: row.cost_minor == null ? null : Number(row.cost_minor),
      })),
      tenants: tenantResult.rows.map((row) => ({
        tenantId: row.id,
        tenantName: row.name,
        hubRequests: Number(row.hub_requests),
        successfulHubRequests: Number(row.succeeded),
        upstreamCalls: Number(row.upstream_calls),
        knownCostMinor: row.cost_minor == null ? null : Number(row.cost_minor),
      })),
      endpoints: endpointResult.rows.map((row) => ({
        endpointKey: row.endpoint_key,
        endpointVersion: row.endpoint_version,
        marketplace: row.marketplace,
        upstreamCalls: Number(row.calls),
        successfulUpstreamCalls: Number(row.succeeded),
        usableUpstreamCalls: Number(row.usable),
        knownCostMinor: row.cost_minor == null ? null : Number(row.cost_minor),
      })),
      state,
    }
  }
}

function analyticsFromRows(requests, calls, state) {
  const successfulHubRequests = requests.filter((row) => row.succeeded).length
  const usableCalls = calls.filter((row) => row.outcome === 'succeeded')
  const providerSuccessfulCalls = calls.filter((row) => (
    row.outcome === 'succeeded' || row.outcome === 'succeeded_unusable'
  ))
  const billedCalls = calls.filter((row) => row.billed === true)
  const latency = calls.map((row) => row.latencyMs).filter(Number.isFinite).sort((a, b) => a - b)
  const knownCosts = calls.map((row) => row.costMinor).filter(Number.isFinite)
  const sourceCount = (mode) => requests.filter((row) => row.sourceMode === mode).length
  const tenantMap = new Map()
  for (const request of requests) {
    const row = tenantMap.get(request.tenantId) || {
      tenantId: request.tenantId,
      tenantName: request.tenantName || request.tenantId,
      hubRequests: 0,
      successfulHubRequests: 0,
      upstreamCalls: 0,
      knownCostMinor: null,
    }
    row.hubRequests += 1
    row.successfulHubRequests += request.succeeded ? 1 : 0
    tenantMap.set(request.tenantId, row)
  }
  for (const call of calls) {
    if (!call.tenantId) continue
    const row = tenantMap.get(call.tenantId) || {
      tenantId: call.tenantId,
      tenantName: call.tenantName || call.tenantId,
      hubRequests: 0,
      successfulHubRequests: 0,
      upstreamCalls: 0,
      knownCostMinor: null,
    }
    row.upstreamCalls += 1
    if (Number.isFinite(call.costMinor)) {
      row.knownCostMinor = (row.knownCostMinor ?? 0) + call.costMinor
    }
    tenantMap.set(call.tenantId, row)
  }
  return {
    totals: {
      hubRequests: requests.length,
      successfulHubRequests,
      freshCache: sourceCount('fresh_cache'),
      storedFallback: sourceCount('stored_fallback'),
      storedFallbackWithoutDispatch: requests.filter((row) => (
        row.sourceMode === 'stored_fallback' && !row.providerCallId
      )).length,
      storedFallbackAfterDispatch: requests.filter((row) => (
        row.sourceMode === 'stored_fallback' && row.providerCallId
      )).length,
      idempotentReplay: sourceCount('idempotent_replay'),
      duplicateSuppressed: sourceCount('duplicate_suppressed'),
      circuitRejected: sourceCount('circuit_rejected'),
      upstreamCalls: calls.length,
      successfulUpstreamCalls: providerSuccessfulCalls.length,
      usableUpstreamCalls: usableCalls.length,
      unusableSuccesses: calls.filter((row) => row.outcome === 'succeeded_unusable').length,
      billedCalls: billedCalls.length,
      indeterminateBillingCalls: calls.filter((row) => row.billed == null).length,
      unknownOutcomes: calls.filter((row) => row.outcome === 'unknown').length,
      p95LatencyMs: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null,
      knownCostMinor: knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
      unknownCostCalls: billedCalls.filter((row) => row.costMinor == null).length,
      lastCallAt: calls.at(-1)?.startedAt ?? state.lastCallAt,
      lastSuccessAt: usableCalls.at(-1)?.completedAt ?? state.lastSuccessAt,
    },
    timeSeries: [],
    tenants: [...tenantMap.values()].sort((a, b) => b.hubRequests - a.hubRequests),
    endpoints: [],
    state: clone(state),
  }
}

export function createExternalPlatformStore({ pool, usageStore, ...options }) {
  return pool
    ? new PostgresExternalPlatformStore({ pool, ...options })
    : new MemoryExternalPlatformStore({ usageStore, ...options })
}
