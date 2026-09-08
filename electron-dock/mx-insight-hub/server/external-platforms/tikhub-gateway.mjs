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
  TIKHUB_XIAOHONGSHU_CONNECTOR_ID,
  TIKHUB_XIAOHONGSHU_DATASET_ID,
} from '../ingest/tikhub-xiaohongshu.mjs'

const DEFAULT_POLICY = Object.freeze({ maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 1 })
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SOCIAL_POST_MEDIA_PATH = '/api/v1/data/posts/media'

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

function result(body, requestId, replay, sourceMode, capturedAt) {
  const captured = date(capturedAt)
  return {
    status: 200,
    body: publicDeliveryBody(body, requestId),
    requestId,
    replay,
    sourceMode,
    capturedAt: captured?.toISOString() || null,
    staleAgeSeconds: captured ? Math.max(0, Math.floor((Date.now() - captured) / 1_000)) : null,
  }
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
    reservationLeaseMs,
    defaultPolicy = DEFAULT_POLICY,
    logger = console,
  }) {
    this.usageStore = usageStore
    this.platformStore = platformStore
    this.adapter = adapter
    this.config = config
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
      capabilities: ['post_detail'],
      input: 'official_note_url',
      idempotencyKey: 'optional',
      deliveryModes: ['cache_only', 'cache_first', 'refresh'],
      freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
    }
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
        return result(responseBody, reservation.request.id, true, 'idempotent_replay', capturedAt)
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
          const unitCost = this.config.billing.unitCostMinor
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
          const unitCost = billed === true ? this.config.billing.unitCostMinor : null
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
        await this.usageStore.releaseRequest(durableRequestId, 'external_platform_pre_dispatch_failed').catch(() => {})
      }
      if (!(error instanceof AppError)) {
        this.logger?.error?.({ requestId: durableRequestId, error }, 'TikHub gateway request failed')
      }
      throw withRequestId(error, durableRequestId)
    }
  }
}
