import { createHash, randomUUID } from 'node:crypto'
import {
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
  JUSTONE_CONTRACT_VERSION,
  JUSTONE_OPERATION,
  JustOneContractError,
  normalizeJustOneProductSearchRequest,
} from '../contracts/justone.mjs'
import { JustOneUpstreamError } from '../adapters/justone.mjs'
import { AppError } from '../core/errors.mjs'
import { createExternalPlatformCursorCodec } from './cursor.mjs'

const AUTHORIZATION_PLATFORM = 'ecommerce'
const DEFAULT_POLICY = Object.freeze({ maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 })
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function persistedCallEvidence(source) {
  const responseObject = source?.archiveObjects?.find?.((object) => object?.kind === 'response') || null
  const rawPayload = responseObject?.rawPayload ?? responseObject?.rawItem ?? null
  const response = rawPayload?.response ?? null
  const responseArchive = source?.responseArchive ?? (responseObject ? {
    contractState: responseObject.contractState || response?.contractState || 'unknown',
    httpStatus: response?.httpStatus ?? null,
    businessCode: response?.businessCode ?? null,
    contentType: responseObject.contentType ?? response?.contentType ?? null,
    bodySize: responseObject.bodySize ?? response?.bodySize ?? null,
    payloadSha256: responseObject.payloadSha256 ?? responseObject.rawPayloadSha256 ?? null,
    rawPayload,
    capturedAt: rawPayload?.capturedAt ?? new Date(),
  } : null)
  const upstreamEvidence = source?.upstreamEvidence ?? (responseObject ? {
    requestId: responseObject.upstreamRequestId ?? response?.requestId ?? null,
    recordTime: responseObject.upstreamRecordTime ?? response?.recordTime ?? null,
  } : null)
  return { responseArchive, upstreamEvidence }
}

function asDate(value) {
  const result = value instanceof Date ? value : new Date(value)
  return Number.isNaN(result.getTime()) ? null : result
}

function acceptedCaptureTime(result) {
  const value = result?.publicBody?.meta?.capturedAt
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new TypeError('External platform adapter returned no accepted capture timestamp')
  }
  const capturedAt = asDate(value)
  if (!capturedAt) {
    throw new TypeError('External platform adapter returned an invalid accepted capture timestamp')
  }
  return new Date(capturedAt.getTime())
}

function deliveryBody(base, {
  requestId,
  sourceMode,
  capturedAt,
  servedAt = new Date(),
  fallbackReason = null,
}) {
  const captured = asDate(capturedAt) || servedAt
  const ageSeconds = Math.max(0, Math.floor((servedAt.getTime() - captured.getTime()) / 1_000))
  return {
    ...structuredClone(base),
    requestId,
    meta: {
      ...(base?.meta || {}),
      capturedAt: captured.toISOString(),
      servedAt: servedAt.toISOString(),
      sourceMode,
      ageSeconds,
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  }
}

function withDurableRequestId(error, requestId) {
  if (!requestId) return error
  if (!(error instanceof AppError)) {
    return new AppError(500, 'internal_error', 'Internal server error', { requestId })
  }
  return new AppError(error.status, error.code, error.message, {
    ...(error.details && typeof error.details === 'object' && !Array.isArray(error.details)
      ? error.details
      : {}),
    requestId,
  })
}

function failureResponseBody(error, requestId) {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: { requestId },
    },
    requestId,
  }
}

function replayedFailure(request) {
  const status = request?.responseStatus
  if (!Number.isInteger(status) || status < 400 || status > 599) return null
  const stored = request.responseBody?.error
  const code = typeof stored?.code === 'string' && stored.code
    ? stored.code
    : 'external_platform_rejected'
  const message = typeof stored?.message === 'string' && stored.message
    ? stored.message
    : 'External data platform rejected the request'
  return new AppError(status, code, message, { requestId: request.id })
}

function publicFailure(error) {
  const evidence = error.evidence || {}
  if (evidence.businessCode === 302 || evidence.businessCode === 303 || evidence.httpStatus === 429) {
    return new AppError(429, 'external_platform_capacity_exceeded', 'External data capacity is temporarily exhausted')
  }
  if ([100, 600, 601, 602].includes(evidence.businessCode)) {
    return new AppError(503, 'external_platform_capacity_unavailable', 'External data capacity is unavailable')
  }
  if (evidence.outcome === 'succeeded_unusable') {
    return new AppError(
      502,
      'external_platform_response_unusable',
      'The external call was accepted but its response could not be normalized; do not retry automatically',
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

function resultFromBody(body, { requestId, replay, sourceMode, capturedAt }) {
  const captured = asDate(capturedAt)
  return {
    status: 200,
    body,
    requestId,
    replay,
    sourceMode,
    capturedAt: captured?.toISOString() || null,
    staleAgeSeconds: captured
      ? Math.max(0, Math.floor((Date.now() - captured.getTime()) / 1_000))
      : null,
  }
}

export class ExternalPlatformGateway {
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
    if (
      this.active >= this.config.maxConcurrency
      || consumerActive >= this.config.maxConsumerConcurrency
    ) return false
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

  capabilities() {
    return {
      platform: AUTHORIZATION_PLATFORM,
      ready: Boolean(this.adapter),
      source: 'hub',
      servingMode: 'live_with_stored_fallback',
      contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
      capabilities: ['product_search'],
      marketplaces: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
      pagination: 'opaque_cursor',
      idempotencyKey: 'optional',
      freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
    }
  }

  async search(context, { body, idempotencyKey, path }) {
    let durableRequestId = null
    let ownsReservation = false
    try {
    const grants = await this.usageStore.listGrants(context.consumer.id)
    if (!grants.includes(AUTHORIZATION_PLATFORM)) {
      throw new AppError(403, 'platform_not_granted', 'E-commerce data is not granted')
    }
    const policy = {
      ...this.defaultPolicy,
      ...((await this.usageStore.getPolicy(context.consumer.id, AUTHORIZATION_PLATFORM)) || {}),
    }
    const codec = createExternalPlatformCursorCodec(this.apiKeyPepper, context.consumer.id)
    let normalized
    try {
      normalized = normalizeJustOneProductSearchRequest(body, {
        decodeCursor: codec.decode,
        encodeCursor: codec.encode,
        maxPageSize: policy.maxPageSize,
      })
    } catch (error) {
      if (error instanceof JustOneContractError) {
        throw new AppError(400, error.code, error.message)
      }
      throw error
    }

    const requestFingerprint = fingerprint({
      method: 'POST',
      path,
      body: normalized.fingerprintBody,
    })
    const suppliedKey = idempotencyKey != null && idempotencyKey !== ''
    if (suppliedKey && (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey))) {
      throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 8-128 safe characters')
    }
    const cacheBucket = Math.floor(Date.now() / this.config.freshTtlMs)
    const effectiveKey = suppliedKey
      ? idempotencyKey
      : `auto:${cacheBucket}:${requestFingerprint.slice(0, 48)}`
    const requestId = randomUUID()
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    await this.usageStore.reapStaleReservations()
    await this.platformStore.reapStaleCalls?.()
    const reservation = await this.usageStore.reserve({
      requestId,
      idempotencyKey: effectiveKey,
      fingerprint: requestFingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: AUTHORIZATION_PLATFORM,
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      // A caller-supplied key names one immutable paid dispatch. Generated keys
      // rotate with the freshness bucket, so neither form needs row reuse.
      replayWindowMs: null,
    })
    durableRequestId = reservation.request?.id || requestId
    ownsReservation = reservation.kind === 'reserved'
    if (reservation.kind === 'conflict') {
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
    }

    const delivery = {
      tenantId: context.tenant.id,
      tenantName: context.tenant.name,
      consumerId: context.consumer.id,
      usageRequestId: reservation.request.id,
      operation: JUSTONE_OPERATION,
      fingerprint: requestFingerprint,
    }
    if (reservation.kind === 'in_progress') {
      await this.platformStore.recordGatewayAttempt({
        delivery,
        sourceMode: 'duplicate_suppressed',
        succeeded: false,
        status: 409,
        errorCode: 'request_in_progress',
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
          delivery,
          sourceMode: 'idempotent_replay',
          succeeded: false,
          status: replayError.status,
          errorCode: replayError.code,
        }).catch((error) => {
          this.logger?.warn?.(`[external-platform] replay evidence unavailable: ${error.message}`)
        })
        throw replayError
      }
      const base = reservation.request.responseBody
      const capturedAt = reservation.request.capturedAt
        || base?.meta?.capturedAt
        || reservation.request.completedAt
      const responseBody = deliveryBody(base, {
        requestId: reservation.request.id,
        sourceMode: 'idempotent_replay',
        capturedAt,
      })
      await this.platformStore.recordReplay({ delivery, sourceMode: 'idempotent_replay' }).catch((error) => {
        this.logger?.warn?.(`[external-platform] replay evidence unavailable: ${error.message}`)
      })
      return resultFromBody(responseBody, {
        requestId: reservation.request.id,
        replay: true,
        sourceMode: 'idempotent_replay',
        capturedAt,
      })
    }

    const activeRequestId = reservation.request.id
    const now = new Date()
    let snapshot = await this.platformStore.snapshotFor({
      consumerId: context.consumer.id,
      operation: JUSTONE_OPERATION,
      fingerprint: requestFingerprint,
    }, now)
    if (snapshot && new Date(snapshot.freshUntil) >= now) {
      const responseBody = deliveryBody(snapshot.responseBody, {
        requestId: activeRequestId,
        sourceMode: 'fresh_cache',
        capturedAt: snapshot.capturedAt,
      })
      await this.platformStore.commitSnapshotDelivery({
        delivery,
        snapshot,
        sourceMode: 'fresh_cache',
        responseBody,
      })
      return resultFromBody(responseBody, {
        requestId: activeRequestId,
        replay: false,
        sourceMode: 'fresh_cache',
        capturedAt: snapshot.capturedAt,
      })
    }

    const state = await this.platformStore.providerState('justone')
    const circuitOpen = state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now
    if (!this.adapter || circuitOpen) {
      if (snapshot) {
        const reason = !this.adapter ? 'provider_not_configured' : 'provider_circuit_open'
        const responseBody = deliveryBody(snapshot.responseBody, {
          requestId: activeRequestId,
          sourceMode: 'stored_fallback',
          capturedAt: snapshot.capturedAt,
          fallbackReason: reason,
        })
        await this.platformStore.commitSnapshotDelivery({
          delivery,
          snapshot,
          sourceMode: 'stored_fallback',
          responseBody,
        })
        return resultFromBody(responseBody, {
          requestId: activeRequestId,
          replay: false,
          sourceMode: 'stored_fallback',
          capturedAt: snapshot.capturedAt,
        })
      }
      const sourceMode = circuitOpen ? 'circuit_rejected' : 'unavailable'
      const errorCode = circuitOpen ? 'external_platform_circuit_open' : 'external_platform_not_configured'
      await this.platformStore.rejectWithoutDispatch({
        delivery,
        sourceMode,
        status: 503,
        errorCode,
      })
      throw new AppError(503, errorCode, 'External product search is unavailable')
    }

    if (!this.#enter(context.consumer.id)) {
      if (snapshot) {
        const responseBody = deliveryBody(snapshot.responseBody, {
          requestId: activeRequestId,
          sourceMode: 'stored_fallback',
          capturedAt: snapshot.capturedAt,
          fallbackReason: 'concurrency_guard',
        })
        await this.platformStore.commitSnapshotDelivery({
          delivery,
          snapshot,
          sourceMode: 'stored_fallback',
          responseBody,
        })
        return resultFromBody(responseBody, {
          requestId: activeRequestId,
          replay: false,
          sourceMode: 'stored_fallback',
          capturedAt: snapshot.capturedAt,
        })
      }
      await this.platformStore.rejectWithoutDispatch({
        delivery,
        sourceMode: 'unavailable',
        status: 429,
        errorCode: 'external_platform_busy',
      })
      throw new AppError(429, 'external_platform_busy', 'External product search concurrency is exhausted')
    }

    let ownsLease = false
    let call = null
    let callSettled = false
    let lastDispatchEvidence = null
    try {
      const lease = await this.platformStore.acquireDispatchLease({
        consumerId: context.consumer.id,
        operation: JUSTONE_OPERATION,
        fingerprint: requestFingerprint,
        endpointKey: normalized.endpointKey,
        ownerRequestId: activeRequestId,
        expiresAt: new Date(Date.now() + this.reservationLeaseMs),
      })
      ownsLease = lease === true || lease?.kind === 'acquired'
      if (!ownsLease) {
        // A leader may have finished between the first snapshot lookup and the
        // lease attempt. Recheck once; never poll or create an upstream retry.
        snapshot = await this.platformStore.snapshotFor({
          consumerId: context.consumer.id,
          operation: JUSTONE_OPERATION,
          fingerprint: requestFingerprint,
        }, new Date())
        if (snapshot && new Date(snapshot.freshUntil) >= new Date()) {
          const responseBody = deliveryBody(snapshot.responseBody, {
            requestId: activeRequestId,
            sourceMode: 'fresh_cache',
            capturedAt: snapshot.capturedAt,
          })
          await this.platformStore.commitSnapshotDelivery({
            delivery,
            snapshot,
            sourceMode: 'fresh_cache',
            responseBody,
          })
          return resultFromBody(responseBody, {
            requestId: activeRequestId,
            replay: false,
            sourceMode: 'fresh_cache',
            capturedAt: snapshot.capturedAt,
          })
        }
        const blockedOutcome = lease?.kind === 'blocked'
          && ['unknown', 'succeeded_unusable'].includes(lease.reason)
          ? lease.reason
          : null
        if (blockedOutcome && snapshot) {
          const responseBody = deliveryBody(snapshot.responseBody, {
            requestId: activeRequestId,
            sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt,
            fallbackReason: blockedOutcome === 'unknown'
              ? 'previous_outcome_unknown'
              : 'previous_response_unusable',
          })
          await this.platformStore.commitSnapshotDelivery({
            delivery,
            snapshot,
            sourceMode: 'stored_fallback',
            responseBody,
          })
          return resultFromBody(responseBody, {
            requestId: activeRequestId,
            replay: false,
            sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt,
          })
        }
        const errorCode = blockedOutcome === 'unknown'
          ? 'request_outcome_unknown'
          : blockedOutcome === 'succeeded_unusable'
            ? 'external_platform_response_unusable'
            : 'request_in_progress'
        await this.platformStore.rejectWithoutDispatch({
          delivery,
          sourceMode: 'duplicate_suppressed',
          status: 409,
          errorCode,
        })
        if (blockedOutcome === 'unknown') {
          throw new AppError(409, errorCode, 'A recent equal dispatch has an unknown outcome; do not retry automatically')
        }
        if (blockedOutcome === 'succeeded_unusable') {
          throw new AppError(409, errorCode, 'A recent response could not be normalized; do not retry automatically')
        }
        throw new AppError(409, errorCode, 'An equal paid dispatch is already in progress')
      }

      call = await this.platformStore.beginProviderCall({
        tenantId: context.tenant.id,
        consumerId: context.consumer.id,
        apiKeyId: context.apiKey.id,
        usageRequestId: activeRequestId,
        operation: JUSTONE_OPERATION,
        contractVersion: JUSTONE_CONTRACT_VERSION,
        endpointKey: normalized.endpointKey,
        endpointVersion: normalized.endpointVersion,
        marketplace: normalized.marketplace,
        fingerprint: requestFingerprint,
      })
      const startedAt = performance.now()
      try {
        const result = await this.adapter.searchProducts(body, {
          decodeCursor: codec.decode,
          encodeCursor: codec.encode,
          maxPageSize: policy.maxPageSize,
        })
        const persistedEvidence = persistedCallEvidence(result)
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const unitCost = this.config.billing.unitCostMinorByEndpoint?.[normalized.endpointKey] ?? null
        lastDispatchEvidence = {
          billed: true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : this.config.billing.currency,
          latencyMs,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          archiveObjects: result.archiveObjects,
        }
        const capturedAt = acceptedCaptureTime(result)
        const responseBody = deliveryBody(result.publicBody, {
          requestId: activeRequestId,
          sourceMode: 'live',
          capturedAt,
        })
        await this.platformStore.commitLiveDelivery({
          callId: call.id,
          delivery,
          responseBody,
          snapshotBody: result.publicBody,
          capturedAt,
          freshUntil: new Date(capturedAt.getTime() + this.config.freshTtlMs),
          staleUntil: new Date(capturedAt.getTime() + this.config.staleTtlMs),
          itemCount: result.items.length,
          latencyMs,
          // Official usage semantics count only code=0 as a successful billed
          // request. Monetary cost remains unknown unless a reviewed price book
          // is configured.
          billed: true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : this.config.billing.currency,
          archiveObjects: result.archiveObjects,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          ingestJob: {
            payload: {
              kind: 'external-platform-result',
              providerKey: 'justone',
              datasetId: 'ecommerce.products.v1',
              platform: 'ecommerce',
              requestId: activeRequestId,
              queryFingerprint: requestFingerprint,
              providerCallId: call.id,
              records: result.records,
            },
            dedupeKey: `external-platform:justone:${call.id}`,
            priority: 100,
          },
        })
        callSettled = true
        return resultFromBody(responseBody, {
          requestId: activeRequestId,
          replay: false,
          sourceMode: 'live',
          capturedAt,
        })
      } catch (error) {
        if (!(error instanceof JustOneUpstreamError)) throw error
        const evidence = error.evidence
        const persistedEvidence = persistedCallEvidence(error)
        const mappedError = publicFailure(error)
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const billed = evidence.billed ?? null
        const unitCost = billed === true
          ? this.config.billing.unitCostMinorByEndpoint?.[normalized.endpointKey] ?? null
          : null
        lastDispatchEvidence = {
          billed,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : this.config.billing.currency,
          latencyMs,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          archiveObjects: error.archiveObjects,
        }
        const fallbackBody = snapshot
          ? deliveryBody(snapshot.responseBody, {
              requestId: activeRequestId,
              sourceMode: 'stored_fallback',
              capturedAt: snapshot.capturedAt,
              fallbackReason: evidence.errorCode,
            })
          : null
        await this.platformStore.finishFailure({
          callId: call.id,
          delivery,
          outcome: evidence.outcome === 'succeeded_unusable'
            ? 'succeeded_unusable'
            : evidence.outcome === 'unknown' ? 'unknown' : 'rejected',
          httpStatus: evidence.httpStatus,
          businessCode: evidence.businessCode,
          billed,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : this.config.billing.currency,
          latencyMs,
          errorCode: evidence.errorCode,
          failureResponseStatus: mappedError.status,
          failureResponseBody: failureResponseBody(mappedError, activeRequestId),
          affectsCircuit: evidence.affectsCircuit !== false,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          archiveObjects: error.archiveObjects,
          snapshot,
          fallbackResponseBody: fallbackBody,
        })
        callSettled = true
        if (snapshot) {
          return resultFromBody(fallbackBody, {
            requestId: activeRequestId,
            replay: false,
            sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt,
          })
        }
        throw mappedError
      }
    } catch (error) {
      if (call && !callSettled) {
        await this.platformStore.markPersistenceUnknown({
          callId: call.id,
          delivery,
          ...(lastDispatchEvidence || {}),
        }).catch(async () => {
          await this.usageStore.markRequestUnknown(
            activeRequestId,
            'external_platform_persistence_unknown',
          ).catch(() => {})
        })
      } else if (!call && !(error instanceof AppError)) {
        await this.usageStore.releaseRequest(
          activeRequestId,
          'external_platform_pre_dispatch_failed',
        ).catch(() => {})
      }
      throw error
    } finally {
      if (ownsLease) {
        await this.platformStore.releaseDispatchLease({
          consumerId: context.consumer.id,
          operation: JUSTONE_OPERATION,
          fingerprint: requestFingerprint,
          ownerRequestId: activeRequestId,
        }).catch((error) => {
          this.logger?.warn?.(`[external-platform] dispatch lease release failed: ${error.message}`)
        })
      }
      this.#leave(context.consumer.id)
    }
    } catch (error) {
      if (ownsReservation && durableRequestId) {
        await this.usageStore.releaseRequest(
          durableRequestId,
          'external_platform_pre_dispatch_failed',
        ).catch(() => {})
      }
      if (!(error instanceof AppError)) {
        this.logger?.error?.(
          { requestId: durableRequestId, error },
          'external platform request failed',
        )
      }
      throw withDurableRequestId(error, durableRequestId)
    }
  }
}

export const EXTERNAL_ECOMMERCE_CONTRACT_VERSION = ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION
