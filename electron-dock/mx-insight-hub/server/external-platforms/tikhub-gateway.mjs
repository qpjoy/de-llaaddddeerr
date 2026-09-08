import { createHash, randomUUID } from 'node:crypto'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { AppError } from '../core/errors.mjs'
import {
  normalizeXiaohongshuPostRequest,
  TikHubXiaohongshuContractError,
  TIKHUB_PROVIDER_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
  XIAOHONGSHU_PLATFORM,
  XIAOHONGSHU_POST_CONTRACT_VERSION,
  XIAOHONGSHU_POST_OPERATION,
} from '../contracts/tikhub-xiaohongshu.mjs'
import {
  normalizeXiaohongshuSearchRequest,
  TikHubXiaohongshuSearchContractError,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
  XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
  XIAOHONGSHU_SEARCH_OPERATION,
} from '../contracts/tikhub-xiaohongshu-search.mjs'
import {
  projectTikHubXiaohongshuSearch,
  toNightAllXiaohongshuRawEnvelope,
} from '../contracts/tikhub-xiaohongshu-search-projection.mjs'
import { createExternalPlatformCursorCodec } from './cursor.mjs'
import {
  TIKHUB_XIAOHONGSHU_CONNECTOR_ID,
  TIKHUB_XIAOHONGSHU_DATASET_ID,
} from '../ingest/tikhub-xiaohongshu.mjs'

const DEFAULT_POLICY = Object.freeze({ maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 })
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SOCIAL_POST_MEDIA_PATH = '/api/v1/data/posts/media'
const SOCIAL_POST_PATH = '/api/v1/data/post'
const SEARCH_SNAPSHOT_CONTRACT = 'mx-insight-hub.xiaohongshu-search-snapshot.v1'

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function date(value) {
  const result = value instanceof Date ? value : new Date(value)
  return Number.isNaN(result.getTime()) ? null : result
}

function hasStageableProviderEvidence({ responseArchive, archiveObjects }) {
  if (!responseArchive || !date(responseArchive.capturedAt)) return false
  if (!SHA256_PATTERN.test(responseArchive.payloadSha256 || '')) return false
  return Array.isArray(archiveObjects) && archiveObjects.some((object) => (
    object?.kind === 'response'
    && object.payloadSha256 === responseArchive.payloadSha256
  ))
}

function unitCostMinorForEndpoint(config, endpointKey) {
  const billing = config?.billing || {}
  const costs = billing.unitCostMinorByEndpoint
  const configured = costs && typeof costs === 'object' && !Array.isArray(costs)
    && Object.hasOwn(costs, endpointKey)
    ? costs[endpointKey]
    : billing.unitCostMinor
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : null
}

function freshDetailItem(snapshot, now = new Date()) {
  const freshUntil = date(snapshot?.freshUntil)
  if (!freshUntil || freshUntil < now) return null
  return snapshot?.responseBody?.data?.item ?? null
}

function deliveryBody(base, { requestId, sourceMode, capturedAt, fallbackReason = null }) {
  const servedAt = new Date()
  const captured = date(capturedAt) || servedAt
  return {
    ...structuredClone(base),
    requestId,
    meta: {
      ...(base?.meta || {}),
      capturedAt: captured.toISOString(),
      servedAt: servedAt.toISOString(),
      sourceMode,
      ageSeconds: Math.max(0, Math.floor((servedAt - captured) / 1_000)),
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  }
}

function result(body, requestId, replay, sourceMode, capturedAt, originSourceMode = null) {
  const captured = date(capturedAt)
  return {
    status: 200,
    body: publicDeliveryBody(body, requestId),
    requestId,
    replay,
    sourceMode,
    capturedAt: captured?.toISOString() || null,
    staleAgeSeconds: captured ? Math.max(0, Math.floor((Date.now() - captured) / 1_000)) : null,
    ...(originSourceMode ? { originSourceMode } : {}),
  }
}

function requestBoundSearchBody(body, requestId) {
  return { ...structuredClone(body), requestId }
}

function routeNeutralSearchBody(body) {
  const neutral = structuredClone(body)
  delete neutral.requestId
  delete neutral.traceId
  return neutral
}

function searchResult(body, requestId, replay, sourceMode, capturedAt, originSourceMode = null) {
  const captured = date(capturedAt)
  return {
    status: 200,
    body: requestBoundSearchBody(body, requestId),
    requestId,
    replay,
    sourceMode,
    capturedAt: captured?.toISOString() || null,
    staleAgeSeconds: captured ? Math.max(0, Math.floor((Date.now() - captured) / 1_000)) : null,
    ...(originSourceMode ? { originSourceMode } : {}),
  }
}

function rebindSearchCursor(body, sourceCodec, targetCodec) {
  const rebound = structuredClone(body)
  const page = rebound?.data?.pageInfo ?? rebound?.data?.page
  if (typeof page?.nextCursor === 'string' && page.nextCursor) {
    page.nextCursor = targetCodec.encode(sourceCodec.decode(page.nextCursor))
  }
  return rebound
}

function searchSnapshotBody(publicBody, legacyBody, { deliveryCodec, storedCodec }) {
  return {
    contractVersion: SEARCH_SNAPSHOT_CONTRACT,
    // One provider snapshot is shared by multiple Hub requests and route
    // projections. Bind request identity only when a delivery is committed.
    publicBody: routeNeutralSearchBody(rebindSearchCursor(publicBody, deliveryCodec, storedCodec)),
    legacyBody: routeNeutralSearchBody(rebindSearchCursor(legacyBody, deliveryCodec, storedCodec)),
  }
}

function searchSnapshotProjection(snapshot, responseMode, { storedCodec, deliveryCodec }) {
  const stored = snapshot?.responseBody
  if (stored?.contractVersion !== SEARCH_SNAPSHOT_CONTRACT) return null
  const body = responseMode === 'legacy' ? stored.legacyBody : stored.publicBody
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  try {
    return rebindSearchCursor(body, storedCodec, deliveryCodec)
  } catch {
    return null
  }
}

function searchEnrichmentPolicy(enrichment, config) {
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) {
    throw new TypeError('enrichment must be an object')
  }
  const configuredMaximum = Math.max(0, Math.min(
    20,
    Number.isInteger(config.searchMaxEnrichItems) ? config.searchMaxEnrichItems : 20,
  ))
  if (enrichment.maxEnrichItems != null && (
    !Number.isInteger(enrichment.maxEnrichItems)
    || enrichment.maxEnrichItems < 1
    || enrichment.maxEnrichItems > 20
  )) throw new TypeError('maxEnrichItems must be an integer between 1 and 20')
  const mode = enrichment.includeDetails === true
    ? 'all'
    : enrichment.disableAutoDetails === true ? 'none' : 'preview_boundary'
  return Object.freeze({
    mode,
    maxItems: mode === 'none'
      ? 0
      : Math.min(configuredMaximum, enrichment.maxEnrichItems ?? configuredMaximum),
  })
}

// Usage rows and snapshots deliberately retain the accepted source URLs so the
// authenticated media relay can fetch them later.  The customer response is a
// separate projection: it exposes only same-origin, request-bound locators and
// never an upstream avatar or media URL.
function publicDeliveryBody(body, requestId) {
  const projected = structuredClone(body)
  const item = projected?.data?.item
  if (!item || typeof item !== 'object' || Array.isArray(item)) return projected
  if (item.author && typeof item.author === 'object' && !Array.isArray(item.author)) {
    item.author.avatarUrl = null
  }
  if (Array.isArray(item.media)) {
    item.media = item.media.map((_media, mediaIndex) => ({
      type: 'image',
      url: `${SOCIAL_POST_MEDIA_PATH}?requestId=${encodeURIComponent(requestId)}&mediaIndex=${mediaIndex}`,
    }))
  }
  return projected
}

function withRequestId(error, requestId) {
  if (!requestId) return error
  if (!(error instanceof AppError)) {
    return new AppError(500, 'internal_error', 'Internal server error', { requestId })
  }
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details : {}
  return new AppError(error.status, error.code, error.message, { ...details, requestId })
}

function failureBody(error, requestId) {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: { ...(error.details || {}), requestId },
    },
    requestId,
  }
}

function replayedFailure(request) {
  if (!Number.isInteger(request?.responseStatus) || request.responseStatus < 400) return null
  const stored = request.responseBody?.error
  return new AppError(
    request.responseStatus,
    stored?.code || 'external_platform_rejected',
    stored?.message || 'External data platform rejected the request',
    stored?.details || {},
  )
}

function publicFailure(error) {
  const evidence = error.evidence || {}
  if (evidence.errorCode === 'upstream_note_unavailable') {
    return new AppError(404, 'post_not_found', 'The Xiaohongshu note is unavailable or the share link could not be resolved', {
      upstreamAccepted: true,
    })
  }
  if (evidence.httpStatus === 429 || evidence.errorCode === 'upstream_rate_limited') {
    return new AppError(429, 'external_platform_capacity_exceeded', 'External data capacity is temporarily exhausted')
  }
  if (evidence.errorCode === 'upstream_auth_or_balance_unavailable') {
    return new AppError(503, 'external_platform_capacity_unavailable', 'External data capacity is unavailable')
  }
  if (evidence.outcome === 'succeeded_unusable') {
    return new AppError(
      502,
      'external_platform_response_unusable',
      'The external call was accepted but its response could not be normalized; do not retry automatically',
      { upstreamAccepted: true, normalizationCode: evidence.errorCode || 'invalid_upstream_contract' },
    )
  }
  if (evidence.outcome === 'unknown') {
    return new AppError(
      502,
      'external_platform_outcome_unknown',
      'External data call outcome is unknown; do not retry automatically',
    )
  }
  return new AppError(502, 'external_platform_rejected', 'External data platform rejected the request')
}

function isTestKey(apiKey) {
  return apiKey?.environment === 'test' || apiKey?.prefix?.startsWith('mih_test_')
}

export class TikHubGateway {
  constructor({
    usageStore,
    platformStore,
    adapter = null,
    config,
    apiKeyPepper,
    reservationLeaseMs,
    defaultPolicy = DEFAULT_POLICY,
    logger = console,
  }) {
    this.usageStore = usageStore
    this.platformStore = platformStore
    this.adapter = adapter
    this.config = config
    this.apiKeyPepper = apiKeyPepper
    this.reservationLeaseMs = reservationLeaseMs
    this.defaultPolicy = defaultPolicy
    this.logger = logger
    this.active = 0
    this.activeByConsumer = new Map()
  }

  #enter(consumerId) {
    const consumerActive = this.activeByConsumer.get(consumerId) || 0
    if (this.active >= this.config.maxConcurrency || consumerActive >= this.config.maxConsumerConcurrency) {
      return false
    }
    this.active += 1
    this.activeByConsumer.set(consumerId, consumerActive + 1)
    return true
  }

  #leave(consumerId) {
    this.active = Math.max(0, this.active - 1)
    const next = Math.max(0, (this.activeByConsumer.get(consumerId) || 1) - 1)
    if (next === 0) this.activeByConsumer.delete(consumerId)
    else this.activeByConsumer.set(consumerId, next)
  }

  async #credential() {
    if (!this.adapter) return { ready: false, value: null }
    try {
      const value = await this.adapter.resolveCredential()
      return { ready: Boolean(value), value }
    } catch {
      this.logger?.warn?.('[external-platform] TikHub credential is unavailable')
      return { ready: false, value: null }
    }
  }

  async capabilities() {
    const { ready } = await this.#credential()
    return {
      platform: XIAOHONGSHU_PLATFORM,
      ready,
      source: 'hub',
      servingMode: 'live_with_stored_fallback',
      contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
      capabilities: ['search_posts', 'post_detail'],
      input: 'official_note_url',
      idempotencyKey: 'optional',
      deliveryModes: ['cache_only', 'cache_first', 'refresh'],
      freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
    }
  }

  async searchNotes(context, {
    body,
    idempotencyKey,
    path,
    responseMode = 'modern',
    fingerprintBody = null,
    enrichment = {},
    replayWindowMs = null,
  }) {
    let durableRequestId = null
    let ownsReservation = false
    if (!['modern', 'legacy'].includes(responseMode)) {
      throw new TypeError('responseMode must be modern or legacy')
    }
    try {
      if (isTestKey(context.apiKey)) {
        throw new AppError(403, 'test_key_not_supported', 'Test API keys cannot dispatch external acquisition')
      }
      const grants = typeof this.usageStore.listEffectiveGrants === 'function'
        ? await this.usageStore.listEffectiveGrants(context.consumer.id, context.apiKey.id)
        : await this.usageStore.listGrants(context.consumer.id)
      if (!grants.includes(XIAOHONGSHU_PLATFORM)) {
        throw new AppError(403, 'platform_not_granted', 'Xiaohongshu data is not granted')
      }
      const consumerPolicy = {
        ...this.defaultPolicy,
        ...((await this.usageStore.getPolicy(context.consumer.id, XIAOHONGSHU_PLATFORM)) || {}),
      }
      const keyEntitlement = typeof this.usageStore.getApiKeyPlatformEntitlement === 'function'
        ? await this.usageStore.getApiKeyPlatformEntitlement(context.apiKey.id, XIAOHONGSHU_PLATFORM)
        : null
      const policy = {
        ...consumerPolicy,
        maxPageSize: keyEntitlement
          ? Math.min(consumerPolicy.maxPageSize, keyEntitlement.maxPageSize)
          : consumerPolicy.maxPageSize,
      }
      const apiKeyQuota = keyEntitlement ? {
        maxRequests: keyEntitlement.maxRequests,
        windowSeconds: keyEntitlement.windowSeconds,
      } : null
      if (typeof this.apiKeyPepper !== 'string' || !this.apiKeyPepper) {
        throw new AppError(503, 'external_platform_unavailable', 'External search cursor signing is unavailable')
      }
      // Snapshots keep the historical consumer-scoped cursor so modern and
      // compatibility projections can share one paid provider page. Public
      // cursors are rebound to the exact route contract before delivery, which
      // prevents a modern continuation from being replayed on the legacy path
      // (and vice versa).
      const storedCodec = createExternalPlatformCursorCodec(this.apiKeyPepper, context.consumer.id)
      const routeCursorSecret = createHash('sha256')
        .update(this.apiKeyPepper)
        .update('\u0000xiaohongshu-search-route\u0000')
        .update(responseMode)
        .update('\u0000')
        .update(String(path))
        .digest('hex')
      const codec = createExternalPlatformCursorCodec(routeCursorSecret, context.consumer.id)
      let normalized
      try {
        normalized = normalizeXiaohongshuSearchRequest(body, {
          decodeCursor: codec.decode,
          maxPageSize: policy.maxPageSize,
        })
      } catch (error) {
        if (error instanceof TikHubXiaohongshuSearchContractError) {
          throw new AppError(400, error.code, error.message)
        }
        throw error
      }
      if (!idempotencyKey) {
        throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header is required')
      }
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 8-128 safe characters')
      }
      if (fingerprintBody != null && (
        typeof fingerprintBody !== 'object' || Array.isArray(fingerprintBody)
      )) throw new TypeError('fingerprintBody must be an object')
      if (replayWindowMs != null && (!Number.isInteger(replayWindowMs) || replayWindowMs < 0)) {
        throw new TypeError('replayWindowMs must be a non-negative integer or null')
      }
      const enrichmentPolicy = searchEnrichmentPolicy(enrichment, this.config)

      const requestFingerprint = fingerprint({
        method: 'POST',
        path,
        body: fingerprintBody || normalized.fingerprintBody,
      })
      // Public route aliases keep their own idempotency identity, while the
      // provider query has one shared cache/lease identity. This prevents the
      // modern and legacy projections from paying twice for the same page.
      const dispatchFingerprint = fingerprint({
        provider: TIKHUB_PROVIDER_KEY,
        endpoint: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
        body: { ...normalized.fingerprintBody, enrichment: enrichmentPolicy },
      })
      await this.usageStore.reapStaleReservations()
      await this.platformStore.reapStaleCalls?.()
      const requestId = randomUUID()
      const reservation = await this.usageStore.reserve({
        requestId,
        idempotencyKey,
        fingerprint: requestFingerprint,
        tenantId: context.tenant.id,
        consumerId: context.consumer.id,
        apiKeyId: context.apiKey.id,
        platform: XIAOHONGSHU_PLATFORM,
        meterKey: XIAOHONGSHU_SEARCH_OPERATION,
        unitsReserved: 1,
        leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
        windowStart: new Date(Date.now() - policy.windowSeconds * 1_000),
        maxRequests: policy.maxRequests,
        ...(apiKeyQuota ? { apiKeyQuota } : {}),
        replayWindowMs,
      })
      durableRequestId = reservation.request?.id || requestId
      ownsReservation = reservation.kind === 'reserved'
      if (reservation.kind === 'conflict') {
        throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
      }
      const delivery = {
        providerKey: TIKHUB_PROVIDER_KEY,
        tenantId: context.tenant.id,
        tenantName: context.tenant.name,
        consumerId: context.consumer.id,
        usageRequestId: reservation.request.id,
        operation: XIAOHONGSHU_SEARCH_OPERATION,
        fingerprint: requestFingerprint,
        snapshotFingerprint: dispatchFingerprint,
      }
      if (reservation.kind === 'in_progress') {
        await this.platformStore.recordGatewayAttempt({
          delivery, sourceMode: 'duplicate_suppressed', succeeded: false,
          status: 409, errorCode: 'request_in_progress',
        }).catch(() => {})
        throw new AppError(409, 'request_in_progress', 'An equal request is already in progress', {
          requestId: reservation.request.id,
        })
      }
      if (reservation.kind === 'unknown') {
        throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown', {
          requestId: reservation.request.id,
        })
      }
      if (reservation.kind === 'replay') {
        const replayError = replayedFailure(reservation.request)
        if (replayError) {
          await this.platformStore.recordReplay({
            delivery, sourceMode: 'idempotent_replay', succeeded: false,
            status: replayError.status, errorCode: replayError.code,
          }).catch(() => {})
          throw replayError
        }
        const capturedAt = reservation.request.capturedAt || reservation.request.completedAt
        await this.platformStore.recordReplay({
          delivery, sourceMode: 'idempotent_replay', succeeded: true, status: 200,
        }).catch(() => {})
        return searchResult(
          reservation.request.responseBody,
          reservation.request.id,
          true,
          'idempotent_replay',
          capturedAt,
          reservation.request.deliverySourceMode,
        )
      }

      const activeRequestId = reservation.request.id
      const selectSnapshot = (snapshot) => {
        const projected = searchSnapshotProjection(snapshot, responseMode, {
          storedCodec,
          deliveryCodec: codec,
        })
        return projected ? requestBoundSearchBody(projected, activeRequestId) : null
      }
      const now = new Date()
      let snapshot = await this.platformStore.snapshotFor({
        consumerId: context.consumer.id,
        operation: XIAOHONGSHU_SEARCH_OPERATION,
        fingerprint: dispatchFingerprint,
      }, now)
      const freshSnapshotBody = snapshot && new Date(snapshot.freshUntil) >= now
        ? selectSnapshot(snapshot)
        : null
      if (freshSnapshotBody) {
        await this.platformStore.commitSnapshotDelivery({
          delivery, snapshot, sourceMode: 'fresh_cache', responseBody: freshSnapshotBody,
        })
        ownsReservation = false
        return searchResult(freshSnapshotBody, activeRequestId, false, 'fresh_cache', snapshot.capturedAt)
      }

      const state = await this.platformStore.providerState(TIKHUB_PROVIDER_KEY)
      const circuitOpen = state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now
      const resolved = circuitOpen ? { ready: Boolean(this.adapter), value: null } : await this.#credential()
      if (!resolved.ready || circuitOpen) {
        const fallbackBody = snapshot ? selectSnapshot(snapshot) : null
        if (fallbackBody) {
          await this.platformStore.commitSnapshotDelivery({
            delivery, snapshot, sourceMode: 'stored_fallback', responseBody: fallbackBody,
          })
          ownsReservation = false
          return searchResult(fallbackBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
        }
        const errorCode = circuitOpen ? 'external_platform_circuit_open' : 'external_platform_not_configured'
        await this.platformStore.rejectWithoutDispatch({
          delivery, sourceMode: circuitOpen ? 'circuit_rejected' : 'unavailable', status: 503, errorCode,
        })
        ownsReservation = false
        throw new AppError(503, errorCode, 'External Xiaohongshu search is unavailable')
      }

      let ownsLease = false
      let entered = false
      let call = null
      let callSettled = false
      let dispatchEvidence = null
      try {
        const lease = await this.platformStore.acquireDispatchLease({
          consumerId: context.consumer.id,
          operation: XIAOHONGSHU_SEARCH_OPERATION,
          fingerprint: dispatchFingerprint,
          endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
          contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
          ownerRequestId: activeRequestId,
          expiresAt: new Date(Date.now() + this.reservationLeaseMs),
        })
        ownsLease = lease === true || lease?.kind === 'acquired'
        if (!ownsLease) {
          snapshot = await this.platformStore.snapshotFor({
            consumerId: context.consumer.id,
            operation: XIAOHONGSHU_SEARCH_OPERATION,
            fingerprint: dispatchFingerprint,
          }, new Date())
          const fallbackBody = snapshot ? selectSnapshot(snapshot) : null
          if (fallbackBody) {
            const sourceMode = new Date(snapshot.freshUntil) >= new Date()
              ? 'fresh_cache' : 'stored_fallback'
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode, responseBody: fallbackBody,
            })
            ownsReservation = false
            return searchResult(fallbackBody, activeRequestId, false, sourceMode, snapshot.capturedAt)
          }
          const code = lease?.reason === 'succeeded_unusable'
            ? 'external_platform_response_unusable'
            : lease?.reason === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress'
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'duplicate_suppressed', status: 409, errorCode: code,
          })
          ownsReservation = false
          throw new AppError(409, code, 'An equal Xiaohongshu provider dispatch cannot be repeated safely', {
            ...(lease?.blockedUntil ? { blockedUntil: lease.blockedUntil } : {}),
          })
        }
        if (!this.#enter(context.consumer.id)) {
          const fallbackBody = snapshot ? selectSnapshot(snapshot) : null
          if (fallbackBody) {
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode: 'stored_fallback', responseBody: fallbackBody,
            })
            ownsReservation = false
            return searchResult(fallbackBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_busy',
          })
          ownsReservation = false
          throw new AppError(429, 'external_platform_busy', 'External Xiaohongshu concurrency is exhausted')
        }
        entered = true
        const rateLimit = typeof this.platformStore.acquireProviderRateLimit === 'function'
          ? await this.platformStore.acquireProviderRateLimit({
              limit: this.config.maxRequestsPerMinute ?? 120,
              windowMs: 60_000,
            })
          : { allowed: true, retryAfterMs: 0 }
        if (!rateLimit.allowed) {
          const fallbackBody = snapshot ? selectSnapshot(snapshot) : null
          if (fallbackBody) {
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode: 'stored_fallback', responseBody: fallbackBody,
            })
            ownsReservation = false
            return searchResult(fallbackBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_rate_limited',
          })
          ownsReservation = false
          throw new AppError(429, 'external_platform_rate_limited', 'External Xiaohongshu request rate is exhausted', {
            retryAfterMs: rateLimit.retryAfterMs,
          })
        }
        call = await this.platformStore.beginProviderCall({
          tenantId: context.tenant.id,
          consumerId: context.consumer.id,
          apiKeyId: context.apiKey.id,
          usageRequestId: activeRequestId,
          operation: XIAOHONGSHU_SEARCH_OPERATION,
          contractVersion: XIAOHONGSHU_SEARCH_CONTRACT_VERSION,
          endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
          endpointVersion: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_VERSION,
          marketplace: XIAOHONGSHU_PLATFORM,
          fingerprint: requestFingerprint,
          dispatchFingerprint,
          callOrdinal: 0,
          callRole: 'primary',
        })
        const searchStartedAt = performance.now()
        try {
          const upstream = await this.adapter.searchXiaohongshuNotes(body, {
            credential: resolved.value,
            decodeCursor: codec.decode,
            encodeCursor: codec.encode,
            maxPageSize: policy.maxPageSize,
          })
          const searchLatencyMs = Math.max(0, Math.round(performance.now() - searchStartedAt))
          if (entered) {
            this.#leave(context.consumer.id)
            entered = false
          }
          const capturedAt = date(upstream.responseArchive?.capturedAt)
          if (!capturedAt) throw new TypeError('TikHub adapter returned no accepted capture timestamp')
          const unitCost = unitCostMinorForEndpoint(
            this.config,
            TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY,
          )
          dispatchEvidence = {
            billed: true,
            costMinor: unitCost,
            costKind: unitCost == null ? 'unknown' : 'estimated',
            currency: unitCost == null ? null : this.config.billing.currency,
            latencyMs: searchLatencyMs,
            responseArchive: upstream.responseArchive,
            upstreamEvidence: upstream.upstreamEvidence,
            archiveObjects: upstream.archiveObjects,
          }
          // The search response is already billable at this point. Persist its
          // immutable provider evidence before optional detail enrichment so a
          // later detail/storage failure cannot erase the paid response trail.
          await this.platformStore.stageProviderEvidence({
            callId: call.id,
            delivery,
            itemCount: upstream.publicBody?.data?.items?.length ?? upstream.records.length,
            ...dispatchEvidence,
          })
          const detail = await this.#enrichSearchNotes({
            context,
            delivery,
            upstream,
            credential: resolved.value,
            enrichmentPolicy,
            firstCallOrdinal: 1,
            deadlineAt: (
              date(reservation.request.leaseExpiresAt)?.getTime()
              ?? (Date.now() + this.reservationLeaseMs)
            ) - 15_000,
          })
          const durationMs = Math.max(0, Math.round(performance.now() - searchStartedAt))
          const projection = projectTikHubXiaohongshuSearch(upstream, {
            detailResults: detail.results,
            detailFailureCount: detail.failureCount,
            durationMs,
            providerCalls: 1 + detail.providerCalls,
          })
          const legacyBody = toNightAllXiaohongshuRawEnvelope(projection)
          const responseBody = requestBoundSearchBody(
            responseMode === 'legacy' ? legacyBody : projection.publicBody,
            activeRequestId,
          )
          // Search previews and detail observations retain separate immutable
          // provider-call lineage. A preview-boundary body is not promoted to
          // canonical storage; a successful detail call queues its own record.
          const records = upstream.records.filter(
            (_record, index) => upstream.bodyStates[index]?.completeness !== 'provider_preview',
          )
          await this.platformStore.commitLiveDelivery({
            callId: call.id,
            delivery,
            responseBody,
            snapshotBody: searchSnapshotBody(projection.publicBody, legacyBody, {
              deliveryCodec: codec,
              storedCodec,
            }),
            capturedAt,
            freshUntil: new Date(capturedAt.getTime() + (this.config.searchFreshTtlMs ?? 5 * 60_000)),
            staleUntil: new Date(capturedAt.getTime() + (this.config.searchStaleTtlMs ?? 24 * 60 * 60_000)),
            itemCount: projection.items.length,
            usageLatencyMs: durationMs,
            ...dispatchEvidence,
            ingestJob: {
              payload: {
                kind: 'external-platform-result',
                providerKey: TIKHUB_PROVIDER_KEY,
                datasetId: TIKHUB_XIAOHONGSHU_DATASET_ID,
                platform: XIAOHONGSHU_PLATFORM,
                requestId: activeRequestId,
                queryFingerprint: requestFingerprint,
                providerCallId: call.id,
                records,
              },
              dedupeKey: `external-platform:tikhub:${call.id}`,
              priority: 100,
            },
          })
          callSettled = true
          ownsReservation = false
          return searchResult(responseBody, activeRequestId, false, 'live', capturedAt)
        } catch (error) {
          if (!(error instanceof TikHubUpstreamError)) throw error
          if (entered) {
            this.#leave(context.consumer.id)
            entered = false
          }
          const mapped = publicFailure(error)
          const latencyMs = Math.max(0, Math.round(performance.now() - searchStartedAt))
          const billed = error.evidence.billed ?? null
          const unitCost = billed === true
            ? unitCostMinorForEndpoint(this.config, TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_KEY)
            : null
          dispatchEvidence = {
            billed,
            costMinor: unitCost,
            costKind: unitCost == null ? 'unknown' : 'estimated',
            currency: unitCost == null ? null : this.config.billing.currency,
            latencyMs,
            responseArchive: error.responseArchive,
            upstreamEvidence: error.upstreamEvidence,
            archiveObjects: error.archiveObjects,
          }
          if (hasStageableProviderEvidence(dispatchEvidence)) {
            await this.platformStore.stageProviderEvidence({
              callId: call.id,
              delivery,
              httpStatus: error.evidence.httpStatus,
              businessCode: error.evidence.businessCode,
              itemCount: 0,
              errorCode: error.evidence.errorCode,
              ...dispatchEvidence,
            })
          }
          const fallbackBody = snapshot ? selectSnapshot(snapshot) : null
          await this.platformStore.finishFailure({
            callId: call.id,
            delivery,
            outcome: error.evidence.outcome,
            httpStatus: error.evidence.httpStatus,
            businessCode: error.evidence.businessCode,
            ...dispatchEvidence,
            errorCode: error.evidence.errorCode,
            failureResponseStatus: mapped.status,
            failureResponseBody: failureBody(mapped, activeRequestId),
            affectsCircuit: error.evidence.affectsCircuit !== false,
            snapshot: fallbackBody ? snapshot : null,
            fallbackResponseBody: fallbackBody,
          })
          callSettled = true
          ownsReservation = false
          if (fallbackBody) {
            return searchResult(fallbackBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
          }
          throw mapped
        }
      } catch (error) {
        if (call && !callSettled) {
          await this.platformStore.markPersistenceUnknown({
            callId: call.id, delivery, ...(dispatchEvidence || {}),
          }).catch(async () => {
            await this.usageStore.markRequestUnknown(activeRequestId, 'external_platform_persistence_unknown').catch(() => {})
          })
          ownsReservation = false
        }
        throw error
      } finally {
        if (ownsLease) {
          await this.platformStore.releaseDispatchLease({
            consumerId: context.consumer.id,
            operation: XIAOHONGSHU_SEARCH_OPERATION,
            fingerprint: dispatchFingerprint,
            ownerRequestId: activeRequestId,
          }).catch(() => {})
        }
        if (entered) this.#leave(context.consumer.id)
      }
    } catch (error) {
      if (ownsReservation && durableRequestId) {
        if (error?.code === 'external_platform_call_persistence_unknown') {
          await this.usageStore.markRequestUnknown(
            durableRequestId,
            'external_platform_call_persistence_unknown',
          ).catch(() => {})
        } else {
          await this.usageStore.releaseRequest(
            durableRequestId,
            'external_platform_pre_dispatch_failed',
          ).catch(() => {})
        }
      }
      if (!(error instanceof AppError)) {
        this.logger?.error?.({ requestId: durableRequestId, error }, 'TikHub search gateway request failed')
      }
      throw withRequestId(error, durableRequestId)
    }
  }

  async #enrichSearchNotes({
    context,
    delivery,
    upstream,
    credential: resolvedCredential,
    enrichmentPolicy,
    firstCallOrdinal,
    deadlineAt,
  }) {
    const allItems = upstream.publicBody?.data?.items || []
    const requested = enrichmentPolicy.mode === 'all'
      ? allItems.map((item) => ({ externalId: item.externalId, url: item.url }))
      : enrichmentPolicy.mode === 'none' ? [] : upstream.detailCandidates
    const candidates = [...new Map(requested
      .filter((item) => item?.externalId && item?.url)
      .map((item) => [item.externalId, item])).values()]
    const selected = candidates.slice(0, enrichmentPolicy.maxItems)
    const results = []
    let failureCount = candidates.length - selected.length
    let providerCalls = 0

    const settleDetail = async (settlement) => {
      try {
        await this.platformStore.finishProviderStep(settlement)
        return settlement.outcome
      } catch (settlementError) {
        // finishProviderStep already reconciles a lost COMMIT acknowledgement
        // and performs at most one safe retry. If it still cannot prove the
        // requested terminal state, retain the same provider evidence while
        // closing only this enrichment call as unknown. Never redispatch the
        // provider and never change the primary usage reservation here.
        if (settlement.outcome === 'unknown') throw settlementError
        try {
          await this.platformStore.finishProviderStep({
            ...settlement,
            outcome: 'unknown',
            affectsCircuit: true,
            snapshot: null,
            ingestJob: null,
          })
          return 'unknown'
        } catch (unknownError) {
          this.logger?.error?.({
            error: unknownError,
            providerCallId: settlement.callId,
          }, 'TikHub detail settlement could not be persisted')
          throw settlementError
        }
      }
    }

    const stageDetail = async (settlement) => {
      if (!hasStageableProviderEvidence(settlement)) return true
      try {
        await this.platformStore.stageProviderEvidence(settlement)
        return true
      } catch (stageError) {
        try {
          await this.platformStore.finishProviderStep({
            ...settlement,
            outcome: 'unknown',
            affectsCircuit: true,
            snapshot: null,
            ingestJob: null,
          })
          return false
        } catch (unknownError) {
          this.logger?.error?.({
            error: unknownError,
            providerCallId: settlement.callId,
          }, 'TikHub detail evidence could not be staged or terminalized')
          throw stageError
        }
      }
    }

    const enrichOne = async (candidate, index) => {
      const timeoutMs = Number.isInteger(this.config.timeoutMs) ? this.config.timeoutMs : 30_000
      if (Number.isFinite(deadlineAt) && Date.now() + timeoutMs + 5_000 > deadlineAt) {
        failureCount += 1
        return
      }
      const detailBody = {
        platform: XIAOHONGSHU_PLATFORM,
        url: candidate.url,
        deliveryMode: 'cache_first',
      }
      const detailRequest = normalizeXiaohongshuPostRequest(detailBody)
      const detailFingerprint = fingerprint({
        method: 'POST',
        path: SOCIAL_POST_PATH,
        body: detailRequest.fingerprintBody,
      })
      const detailDelivery = {
        ...delivery,
        operation: XIAOHONGSHU_POST_OPERATION,
        snapshotFingerprint: detailFingerprint,
      }
      let snapshot = await this.platformStore.snapshotFor({
        consumerId: context.consumer.id,
        operation: XIAOHONGSHU_POST_OPERATION,
        fingerprint: detailFingerprint,
      }, new Date())
      const cachedItem = freshDetailItem(snapshot)
      if (cachedItem) {
        results.push({ publicBody: snapshot.responseBody })
        return
      }
      const state = await this.platformStore.providerState(TIKHUB_PROVIDER_KEY)
      if (state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > new Date()) {
        failureCount += 1
        return
      }

      let ownsLease = false
      let entered = false
      let call = null
      const ordinal = firstCallOrdinal + index
      try {
        const lease = await this.platformStore.acquireDispatchLease({
          consumerId: context.consumer.id,
          operation: XIAOHONGSHU_POST_OPERATION,
          fingerprint: detailFingerprint,
          endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
          contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
          ownerRequestId: delivery.usageRequestId,
          expiresAt: new Date(Date.now() + this.reservationLeaseMs),
        })
        ownsLease = lease === true || lease?.kind === 'acquired'
        if (!ownsLease) {
          snapshot = await this.platformStore.snapshotFor({
            consumerId: context.consumer.id,
            operation: XIAOHONGSHU_POST_OPERATION,
            fingerprint: detailFingerprint,
          }, new Date())
          if (freshDetailItem(snapshot)) results.push({ publicBody: snapshot.responseBody })
          else failureCount += 1
          return
        }
        // Recheck after taking the distributed lease. A concurrent search may
        // have committed the detail snapshot between the first read and lease.
        snapshot = await this.platformStore.snapshotFor({
          consumerId: context.consumer.id,
          operation: XIAOHONGSHU_POST_OPERATION,
          fingerprint: detailFingerprint,
        }, new Date())
        if (freshDetailItem(snapshot)) {
          results.push({ publicBody: snapshot.responseBody })
          return
        }
        if (!this.#enter(context.consumer.id)) {
          failureCount += 1
          return
        }
        entered = true
        const rateLimit = typeof this.platformStore.acquireProviderRateLimit === 'function'
          ? await this.platformStore.acquireProviderRateLimit({
              limit: this.config.maxRequestsPerMinute ?? 120,
              windowMs: 60_000,
            })
          : { allowed: true }
        if (!rateLimit.allowed) {
          failureCount += 1
          return
        }
        call = await this.platformStore.beginProviderCall({
          tenantId: context.tenant.id,
          consumerId: context.consumer.id,
          apiKeyId: context.apiKey.id,
          usageRequestId: delivery.usageRequestId,
          operation: XIAOHONGSHU_POST_OPERATION,
          contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
          endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
          endpointVersion: TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
          marketplace: XIAOHONGSHU_PLATFORM,
          fingerprint: delivery.fingerprint,
          dispatchFingerprint: detailFingerprint,
          callOrdinal: ordinal,
          callRole: 'enrichment',
        })
        providerCalls += 1
        const startedAt = performance.now()
        let detail
        try {
          detail = await this.adapter.getXiaohongshuPost(detailBody, {
            credential: resolvedCredential,
          })
        } catch (error) {
          if (!(error instanceof TikHubUpstreamError)) {
            await this.platformStore.finishProviderStep({
              callId: call.id,
              delivery: detailDelivery,
              outcome: 'unknown',
              httpStatus: null,
              businessCode: null,
              billed: null,
              costMinor: null,
              costKind: 'unknown',
              currency: null,
              latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
              itemCount: null,
              errorCode: 'external_platform_enrichment_unknown',
              affectsCircuit: true,
            })
            failureCount += 1
            return
          }
          const billed = error.evidence.billed ?? null
          const unitCost = billed === true
            ? unitCostMinorForEndpoint(this.config, TIKHUB_XIAOHONGSHU_ENDPOINT_KEY)
            : null
          const failureSettlement = {
            callId: call.id,
            delivery: detailDelivery,
            outcome: error.evidence.outcome,
            httpStatus: error.evidence.httpStatus,
            businessCode: error.evidence.businessCode,
            billed,
            costMinor: unitCost,
            costKind: unitCost == null ? 'unknown' : 'estimated',
            currency: unitCost == null ? null : this.config.billing.currency,
            latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
            itemCount: 0,
            errorCode: error.evidence.errorCode,
            affectsCircuit: error.evidence.affectsCircuit !== false,
            responseArchive: error.responseArchive,
            upstreamEvidence: error.upstreamEvidence,
            archiveObjects: error.archiveObjects,
          }
          if (await stageDetail(failureSettlement)) {
            await settleDetail(failureSettlement)
          }
          failureCount += 1
          return
        }

        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const capturedAt = date(detail.responseArchive?.capturedAt)
        const unitCost = unitCostMinorForEndpoint(this.config, TIKHUB_XIAOHONGSHU_ENDPOINT_KEY)
        const evidence = Object.freeze({
          httpStatus: detail.responseArchive?.httpStatus ?? 200,
          businessCode: detail.responseArchive?.businessCode ?? 200,
          billed: true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : this.config.billing.currency,
          latencyMs,
          itemCount: 1,
          responseArchive: detail.responseArchive,
          upstreamEvidence: detail.upstreamEvidence,
          archiveObjects: detail.archiveObjects,
        })
        if (!capturedAt) {
          await this.platformStore.finishProviderStep({
            callId: call.id,
            delivery: detailDelivery,
            outcome: 'unknown',
            ...evidence,
            errorCode: 'external_platform_enrichment_unknown',
            affectsCircuit: true,
          })
          failureCount += 1
          return
        }
        const successSettlement = {
          callId: call.id,
          delivery: detailDelivery,
          outcome: 'succeeded',
          ...evidence,
          errorCode: null,
          affectsCircuit: false,
          snapshot: {
            responseBody: detail.publicBody,
            capturedAt,
            freshUntil: new Date(capturedAt.getTime() + this.config.freshTtlMs),
            staleUntil: new Date(capturedAt.getTime() + this.config.staleTtlMs),
          },
          ingestJob: {
            payload: {
              kind: 'external-platform-result',
              providerKey: TIKHUB_PROVIDER_KEY,
              datasetId: TIKHUB_XIAOHONGSHU_DATASET_ID,
              platform: XIAOHONGSHU_PLATFORM,
              requestId: delivery.usageRequestId,
              queryFingerprint: delivery.fingerprint,
              providerCallId: call.id,
              records: detail.records,
            },
            dedupeKey: `external-platform:tikhub:${call.id}`,
            priority: 100,
          },
        }
        if (!await stageDetail(successSettlement)) {
          failureCount += 1
          return
        }
        const settledOutcome = await settleDetail(successSettlement)
        if (settledOutcome === 'succeeded') {
          results.push(detail)
        } else {
          failureCount += 1
        }
      } finally {
        if (ownsLease) {
          await this.platformStore.releaseDispatchLease({
            consumerId: context.consumer.id,
            operation: XIAOHONGSHU_POST_OPERATION,
            fingerprint: detailFingerprint,
            ownerRequestId: delivery.usageRequestId,
          }).catch(() => {})
        }
        if (entered) this.#leave(context.consumer.id)
      }
    }
    const workerCount = Math.min(
      selected.length,
      Math.max(1, Math.min(5, this.config.searchEnrichConcurrency ?? 2)),
    )
    let nextIndex = 0
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < selected.length) {
        const index = nextIndex
        nextIndex += 1
        await enrichOne(selected[index], index)
      }
    })
    const settled = await Promise.allSettled(workers)
    const unexpected = settled.find((entry) => entry.status === 'rejected')
    if (unexpected) throw unexpected.reason
    return { results, failureCount, providerCalls }
  }

  async getPost(context, { body, idempotencyKey, retryOfRequestId, path }) {
    let durableRequestId = null
    let ownsReservation = false
    try {
      if (isTestKey(context.apiKey)) {
        throw new AppError(403, 'test_key_not_supported', 'Test API keys cannot dispatch external acquisition')
      }
      const grants = typeof this.usageStore.listEffectiveGrants === 'function'
        ? await this.usageStore.listEffectiveGrants(context.consumer.id, context.apiKey.id)
        : await this.usageStore.listGrants(context.consumer.id)
      if (!grants.includes(XIAOHONGSHU_PLATFORM)) {
        throw new AppError(403, 'platform_not_granted', 'Xiaohongshu data is not granted')
      }
      const capabilityGrants = typeof this.usageStore.listEffectiveCapabilityGrants === 'function'
        ? await this.usageStore.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
        : await this.usageStore.listCapabilityGrants(context.consumer.id)
      if (!capabilityGrants.includes(XIAOHONGSHU_POST_OPERATION)) {
        throw new AppError(403, 'capability_not_granted', 'Xiaohongshu post detail is not granted')
      }
      const platformPolicy = {
        ...this.defaultPolicy,
        ...((await this.usageStore.getPolicy(context.consumer.id, XIAOHONGSHU_PLATFORM)) || {}),
      }
      const capabilityPolicy = {
        ...this.defaultPolicy,
        ...((typeof this.usageStore.getCapabilityPolicy === 'function'
          ? await this.usageStore.getCapabilityPolicy(context.consumer.id, XIAOHONGSHU_POST_OPERATION)
          : null) || {}),
      }
      const keyPlatformEntitlement = typeof this.usageStore.getApiKeyPlatformEntitlement === 'function'
        ? await this.usageStore.getApiKeyPlatformEntitlement(context.apiKey.id, XIAOHONGSHU_PLATFORM)
        : null
      const keyCapabilityEntitlement = typeof this.usageStore.getApiKeyCapabilityEntitlement === 'function'
        ? await this.usageStore.getApiKeyCapabilityEntitlement(context.apiKey.id, XIAOHONGSHU_POST_OPERATION)
        : null
      const policy = {
        ...platformPolicy,
        maxRequests: Math.min(platformPolicy.maxRequests, capabilityPolicy.maxRequests),
        windowSeconds: Math.max(platformPolicy.windowSeconds, capabilityPolicy.windowSeconds),
        maxPageSize: keyPlatformEntitlement
          ? Math.min(platformPolicy.maxPageSize, keyPlatformEntitlement.maxPageSize)
          : platformPolicy.maxPageSize,
      }
      const apiKeyQuota = keyCapabilityEntitlement && keyPlatformEntitlement
        ? {
            maxRequests: Math.min(keyPlatformEntitlement.maxRequests, keyCapabilityEntitlement.maxRequests),
            windowSeconds: Math.max(keyPlatformEntitlement.windowSeconds, keyCapabilityEntitlement.windowSeconds),
          }
        : null
      let normalized
      try { normalized = normalizeXiaohongshuPostRequest(body) } catch (error) {
        if (error instanceof TikHubXiaohongshuContractError) {
          throw new AppError(400, error.code, error.message)
        }
        throw error
      }
      const requestFingerprint = fingerprint({ method: 'POST', path, body: normalized.fingerprintBody })
      const suppliedKey = idempotencyKey != null && idempotencyKey !== ''
      if (suppliedKey && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey))) {
        throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 8-128 safe characters')
      }
      if (normalized.deliveryMode === 'refresh' && !suppliedKey) {
        throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key is required when deliveryMode is refresh')
      }
      await this.usageStore.reapStaleReservations()
      await this.platformStore.reapStaleCalls?.()

      let validatedRetryId = null
      if (retryOfRequestId != null) {
        if (typeof retryOfRequestId !== 'string' || !UUID_PATTERN.test(retryOfRequestId.trim())
          || normalized.deliveryMode !== 'refresh') {
          throw new AppError(400, 'invalid_uncertain_retry', 'X-MX-Insight-Retry-Of requires a request UUID and deliveryMode refresh')
        }
        const candidate = retryOfRequestId.trim()
        const previous = await this.usageStore.getUsageRequestForRetry(candidate, context.consumer.id)
        if (!previous || previous.status !== 'unknown' || previous.platform !== XIAOHONGSHU_PLATFORM
          || previous.fingerprint !== requestFingerprint || previous.idempotencyKey === idempotencyKey) {
          throw new AppError(409, 'uncertain_retry_not_allowed', 'The referenced uncertain request cannot authorize this retry')
        }
        validatedRetryId = candidate
      }

      const bucket = Math.floor(Date.now() / this.config.freshTtlMs)
      // Caller-supplied keys remain consumer-scoped so two API keys cannot
      // rebind one explicit business request. Generated keys include the API
      // key identity so two legitimate keys can each account for a cache hit;
      // the snapshot and dispatch lease stay consumer/fingerprint scoped.
      const effectiveKey = suppliedKey
        ? idempotencyKey
        : `auto:${context.apiKey.id}:${bucket}:${requestFingerprint.slice(0, 48)}`
      const requestId = randomUUID()
      const reservation = await this.usageStore.reserve({
        requestId,
        idempotencyKey: effectiveKey,
        fingerprint: requestFingerprint,
        tenantId: context.tenant.id,
        consumerId: context.consumer.id,
        apiKeyId: context.apiKey.id,
        platform: XIAOHONGSHU_PLATFORM,
        meterKey: XIAOHONGSHU_POST_OPERATION,
        unitsReserved: 1,
        leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
        windowStart: new Date(Date.now() - policy.windowSeconds * 1_000),
        maxRequests: policy.maxRequests,
        ...(apiKeyQuota ? { apiKeyQuota } : {}),
        replayWindowMs: null,
      })
      durableRequestId = reservation.request?.id || requestId
      ownsReservation = reservation.kind === 'reserved'
      if (reservation.kind === 'conflict') {
        throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
      }

      const delivery = {
        providerKey: TIKHUB_PROVIDER_KEY,
        tenantId: context.tenant.id,
        tenantName: context.tenant.name,
        consumerId: context.consumer.id,
        usageRequestId: reservation.request.id,
        operation: XIAOHONGSHU_POST_OPERATION,
        fingerprint: requestFingerprint,
      }
      if (reservation.kind === 'in_progress') {
        await this.platformStore.recordGatewayAttempt({
          delivery, sourceMode: 'duplicate_suppressed', succeeded: false,
          status: 409, errorCode: 'request_in_progress',
        }).catch(() => {})
        throw new AppError(409, 'request_in_progress', 'An equal request is already in progress', { requestId: reservation.request.id })
      }
      if (reservation.kind === 'unknown') {
        throw new AppError(409, 'request_outcome_unknown', 'Previous request outcome is unknown', { requestId: reservation.request.id })
      }
      if (reservation.kind === 'replay') {
        const replayError = replayedFailure(reservation.request)
        if (replayError) {
          await this.platformStore.recordReplay({
            delivery,
            sourceMode: 'idempotent_replay',
            succeeded: false,
            status: replayError.status,
            errorCode: replayError.code,
          }).catch((error) => {
            this.logger?.warn?.(`[external-platform] TikHub replay evidence unavailable: ${error.message}`)
          })
          throw replayError
        }
        const capturedAt = reservation.request.capturedAt || reservation.request.responseBody?.meta?.capturedAt
          || reservation.request.completedAt
        const responseBody = deliveryBody(reservation.request.responseBody, {
          requestId: reservation.request.id, sourceMode: 'idempotent_replay', capturedAt,
        })
        await this.platformStore.recordReplay({
          delivery, sourceMode: 'idempotent_replay', succeeded: true, status: 200,
        }).catch((error) => {
          this.logger?.warn?.(`[external-platform] TikHub replay evidence unavailable: ${error.message}`)
        })
        return result(
          responseBody,
          reservation.request.id,
          true,
          'idempotent_replay',
          capturedAt,
          reservation.request.deliverySourceMode,
        )
      }

      const activeRequestId = reservation.request.id
      const now = new Date()
      let snapshot = await this.platformStore.snapshotFor({
        consumerId: context.consumer.id,
        operation: XIAOHONGSHU_POST_OPERATION,
        fingerprint: requestFingerprint,
      }, now)
      const fresh = snapshot && new Date(snapshot.freshUntil) >= now
      if (snapshot && (normalized.deliveryMode === 'cache_only'
        || (normalized.deliveryMode === 'cache_first' && fresh))) {
        const sourceMode = fresh ? 'fresh_cache' : 'stored_fallback'
        const responseBody = deliveryBody(snapshot.responseBody, {
          requestId: activeRequestId, sourceMode, capturedAt: snapshot.capturedAt,
          ...(fresh ? {} : { fallbackReason: 'cache_only' }),
        })
        await this.platformStore.commitSnapshotDelivery({ delivery, snapshot, sourceMode, responseBody })
        return result(responseBody, activeRequestId, false, sourceMode, snapshot.capturedAt)
      }
      if (normalized.deliveryMode === 'cache_only') {
        await this.platformStore.rejectWithoutDispatch({
          delivery, sourceMode: 'unavailable', status: 404, errorCode: 'stored_snapshot_not_found',
        })
        ownsReservation = false
        throw new AppError(404, 'stored_snapshot_not_found', 'No stored result matches this request')
      }

      const state = await this.platformStore.providerState(TIKHUB_PROVIDER_KEY)
      const circuitOpen = state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now
      const resolved = circuitOpen ? { ready: Boolean(this.adapter), value: null } : await this.#credential()
      if (!resolved.ready || circuitOpen) {
        if (snapshot) {
          const responseBody = deliveryBody(snapshot.responseBody, {
            requestId: activeRequestId,
            sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt,
            fallbackReason: circuitOpen ? 'provider_circuit_open' : 'provider_not_configured',
          })
          await this.platformStore.commitSnapshotDelivery({ delivery, snapshot, sourceMode: 'stored_fallback', responseBody })
          return result(responseBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
        }
        const errorCode = circuitOpen ? 'external_platform_circuit_open' : 'external_platform_not_configured'
        await this.platformStore.rejectWithoutDispatch({
          delivery, sourceMode: circuitOpen ? 'circuit_rejected' : 'unavailable', status: 503, errorCode,
        })
        ownsReservation = false
        throw new AppError(503, errorCode, 'External Xiaohongshu acquisition is unavailable')
      }

      let ownsLease = false
      let entered = false
      let call = null
      let callSettled = false
      let dispatchEvidence = null
      try {
        const lease = await this.platformStore.acquireDispatchLease({
          consumerId: context.consumer.id,
          operation: XIAOHONGSHU_POST_OPERATION,
          fingerprint: requestFingerprint,
          endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
          contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
          ownerRequestId: activeRequestId,
          expiresAt: new Date(Date.now() + this.reservationLeaseMs),
          retryOfRequestId: validatedRetryId,
        })
        ownsLease = lease === true || lease?.kind === 'acquired'
        if (!ownsLease) {
          snapshot = await this.platformStore.snapshotFor({
            consumerId: context.consumer.id,
            operation: XIAOHONGSHU_POST_OPERATION,
            fingerprint: requestFingerprint,
          }, new Date())
          if (snapshot) {
            const stillFresh = new Date(snapshot.freshUntil) >= new Date()
            const sourceMode = stillFresh ? 'fresh_cache' : 'stored_fallback'
            const responseBody = deliveryBody(snapshot.responseBody, {
              requestId: activeRequestId,
              sourceMode,
              capturedAt: snapshot.capturedAt,
              ...(stillFresh ? {} : { fallbackReason: 'duplicate_dispatch_suppressed' }),
            })
            await this.platformStore.commitSnapshotDelivery({ delivery, snapshot, sourceMode, responseBody })
            return result(responseBody, activeRequestId, false, sourceMode, snapshot.capturedAt)
          }
          const blocked = lease?.reason === 'upstream_note_unavailable'
            ? {
                status: 404,
                internalCode: 'upstream_note_unavailable',
                code: 'post_not_found',
                message: 'The Xiaohongshu note is unavailable or the share link could not be resolved',
              }
            : lease?.reason === 'succeeded_unusable'
              ? {
                  status: 409,
                  internalCode: 'external_platform_response_unusable',
                  code: 'external_platform_response_unusable',
                  message: 'A recent response for this provider contract was unusable; do not retry before the safety window',
                }
              : lease?.reason === 'unknown'
                ? {
                    status: 409,
                    internalCode: 'request_outcome_unknown',
                    code: 'request_outcome_unknown',
                    message: 'An equal external provider dispatch has an unresolved outcome',
                  }
                : {
                    status: 409,
                    internalCode: 'request_in_progress',
                    code: 'request_in_progress',
                    message: 'An equal external provider dispatch is already in progress',
                  }
          await this.platformStore.rejectWithoutDispatch({
            delivery,
            sourceMode: 'duplicate_suppressed',
            status: blocked.status,
            errorCode: blocked.internalCode,
          })
          ownsReservation = false
          throw new AppError(blocked.status, blocked.code, blocked.message, {
            ...(lease?.blockedUntil ? { blockedUntil: lease.blockedUntil } : {}),
          })
        }

        // A request suppressed by the shared dispatch lease never consumes a
        // local provider slot. This keeps duplicate note lookups from starving
        // unrelated customer acquisitions.
        if (!this.#enter(context.consumer.id)) {
          if (snapshot) {
            const responseBody = deliveryBody(snapshot.responseBody, {
              requestId: activeRequestId, sourceMode: 'stored_fallback',
              capturedAt: snapshot.capturedAt, fallbackReason: 'concurrency_guard',
            })
            await this.platformStore.commitSnapshotDelivery({ delivery, snapshot, sourceMode: 'stored_fallback', responseBody })
            return result(responseBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_busy',
          })
          ownsReservation = false
          throw new AppError(429, 'external_platform_busy', 'External Xiaohongshu concurrency is exhausted')
        }
        entered = true

        const rateLimit = typeof this.platformStore.acquireProviderRateLimit === 'function'
          ? await this.platformStore.acquireProviderRateLimit({
              limit: this.config.maxRequestsPerMinute ?? 120,
              windowMs: 60_000,
            })
          : { allowed: true, retryAfterMs: 0 }
        if (!rateLimit.allowed) {
          if (snapshot) {
            const responseBody = deliveryBody(snapshot.responseBody, {
              requestId: activeRequestId,
              sourceMode: 'stored_fallback',
              capturedAt: snapshot.capturedAt,
              fallbackReason: 'provider_rate_limit',
            })
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode: 'stored_fallback', responseBody,
            })
            return result(responseBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_rate_limited',
          })
          ownsReservation = false
          throw new AppError(
            429,
            'external_platform_rate_limited',
            'External Xiaohongshu request rate is exhausted',
            { retryAfterMs: rateLimit.retryAfterMs },
          )
        }

        call = await this.platformStore.beginProviderCall({
          tenantId: context.tenant.id,
          consumerId: context.consumer.id,
          apiKeyId: context.apiKey.id,
          usageRequestId: activeRequestId,
          operation: XIAOHONGSHU_POST_OPERATION,
          contractVersion: XIAOHONGSHU_POST_CONTRACT_VERSION,
          endpointKey: TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
          endpointVersion: TIKHUB_XIAOHONGSHU_ENDPOINT_VERSION,
          marketplace: XIAOHONGSHU_PLATFORM,
          fingerprint: requestFingerprint,
          retryOfRequestId: validatedRetryId,
        })
        const startedAt = performance.now()
        try {
          const upstream = await this.adapter.getXiaohongshuPost(body, { credential: resolved.value })
          const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
          const capturedAt = date(upstream.publicBody?.meta?.capturedAt)
          if (!capturedAt) throw new TypeError('TikHub adapter returned no accepted capture timestamp')
          const unitCost = unitCostMinorForEndpoint(this.config, TIKHUB_XIAOHONGSHU_ENDPOINT_KEY)
          dispatchEvidence = {
            billed: true,
            costMinor: unitCost,
            costKind: unitCost == null ? 'unknown' : 'estimated',
            currency: unitCost == null ? null : this.config.billing.currency,
            latencyMs,
            responseArchive: upstream.responseArchive,
            upstreamEvidence: upstream.upstreamEvidence,
            archiveObjects: upstream.archiveObjects,
          }
          const responseBody = deliveryBody(upstream.publicBody, {
            requestId: activeRequestId, sourceMode: 'live', capturedAt,
          })
          await this.platformStore.commitLiveDelivery({
            callId: call.id,
            delivery,
            responseBody,
            snapshotBody: upstream.publicBody,
            capturedAt,
            freshUntil: new Date(capturedAt.getTime() + this.config.freshTtlMs),
            staleUntil: new Date(capturedAt.getTime() + this.config.staleTtlMs),
            itemCount: 1,
            ...dispatchEvidence,
            ingestJob: {
              payload: {
                kind: 'external-platform-result',
                providerKey: TIKHUB_PROVIDER_KEY,
                datasetId: TIKHUB_XIAOHONGSHU_DATASET_ID,
                platform: XIAOHONGSHU_PLATFORM,
                requestId: activeRequestId,
                queryFingerprint: requestFingerprint,
                providerCallId: call.id,
                records: upstream.records,
              },
              dedupeKey: `external-platform:tikhub:${call.id}`,
              priority: 100,
            },
          })
          callSettled = true
          ownsReservation = false
          return result(responseBody, activeRequestId, false, 'live', capturedAt)
        } catch (error) {
          if (!(error instanceof TikHubUpstreamError)) throw error
          const mapped = publicFailure(error)
          const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
          const billed = error.evidence.billed ?? null
          const unitCost = billed === true
            ? unitCostMinorForEndpoint(this.config, TIKHUB_XIAOHONGSHU_ENDPOINT_KEY)
            : null
          dispatchEvidence = {
            billed,
            costMinor: unitCost,
            costKind: unitCost == null ? 'unknown' : 'estimated',
            currency: unitCost == null ? null : this.config.billing.currency,
            latencyMs,
            responseArchive: error.responseArchive,
            upstreamEvidence: error.upstreamEvidence,
            archiveObjects: error.archiveObjects,
          }
          const fallbackBody = snapshot ? deliveryBody(snapshot.responseBody, {
            requestId: activeRequestId, sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt, fallbackReason: error.evidence.errorCode,
          }) : null
          await this.platformStore.finishFailure({
            callId: call.id,
            delivery,
            outcome: error.evidence.outcome,
            httpStatus: error.evidence.httpStatus,
            businessCode: error.evidence.businessCode,
            ...dispatchEvidence,
            errorCode: error.evidence.errorCode,
            failureResponseStatus: mapped.status,
            failureResponseBody: failureBody(mapped, activeRequestId),
            affectsCircuit: error.evidence.affectsCircuit !== false,
            snapshot,
            fallbackResponseBody: fallbackBody,
          })
          callSettled = true
          ownsReservation = false
          if (snapshot) return result(fallbackBody, activeRequestId, false, 'stored_fallback', snapshot.capturedAt)
          throw mapped
        }
      } catch (error) {
        if (call && !callSettled) {
          await this.platformStore.markPersistenceUnknown({
            callId: call.id, delivery, ...(dispatchEvidence || {}),
          }).catch(async () => {
            await this.usageStore.markRequestUnknown(activeRequestId, 'external_platform_persistence_unknown').catch(() => {})
          })
          ownsReservation = false
        }
        throw error
      } finally {
        if (ownsLease) {
          await this.platformStore.releaseDispatchLease({
            consumerId: context.consumer.id,
            operation: XIAOHONGSHU_POST_OPERATION,
            fingerprint: requestFingerprint,
            ownerRequestId: activeRequestId,
          }).catch(() => {})
        }
        if (entered) this.#leave(context.consumer.id)
      }
    } catch (error) {
      if (ownsReservation && durableRequestId) {
        if (error?.code === 'external_platform_call_persistence_unknown') {
          await this.usageStore.markRequestUnknown(
            durableRequestId,
            'external_platform_call_persistence_unknown',
          ).catch(() => {})
        } else {
          await this.usageStore.releaseRequest(
            durableRequestId,
            'external_platform_pre_dispatch_failed',
          ).catch(() => {})
        }
      }
      if (!(error instanceof AppError)) {
        this.logger?.error?.({ requestId: durableRequestId, error }, 'TikHub gateway request failed')
      }
      throw withRequestId(error, durableRequestId)
    }
  }
}
