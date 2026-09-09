import { createHash, randomUUID } from 'node:crypto'

import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { AppError } from '../core/errors.mjs'
import { TIKHUB_PROVIDER_KEY, XIAOHONGSHU_PLATFORM } from '../contracts/tikhub-xiaohongshu.mjs'
import {
  buildXiaohongshuUserInfoPlan,
  profileCallForIdentifier,
  TikHubXiaohongshuUserInfoContractError,
  toNightAllXiaohongshuUserInfoEnvelope,
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
  XIAOHONGSHU_USER_INFO_CONTRACT_VERSION,
  XIAOHONGSHU_USER_INFO_OPERATION,
} from '../contracts/tikhub-xiaohongshu-user-info.mjs'
import {
  normalizeXiaohongshuCrawlRequest,
  TikHubXiaohongshuUserPostsContractError,
  toNightAllXiaohongshuCrawlEnvelope,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
  XIAOHONGSHU_CRAWL_CONTRACT_VERSION,
  XIAOHONGSHU_CRAWL_OPERATION,
} from '../contracts/tikhub-xiaohongshu-user-posts.mjs'
import {
  NIGHT_ALL_COMPAT_DATASET_ID,
  normalizeNightAllLegacyPayload,
} from '../ingest/legacy-night-all.mjs'
import { TIKHUB_XIAOHONGSHU_CONNECTOR_ID } from '../ingest/tikhub-xiaohongshu.mjs'
import { createExternalPlatformCursorCodec } from './cursor.mjs'
import { providerCostControl } from './tikhub-gateway.mjs'

const DEFAULT_POLICY = Object.freeze({ maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 })
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u
const USER_INFO_PARSER_VERSION = 'mxih-tikhub-xiaohongshu-user-info.v1'
const USER_POSTS_PARSER_VERSION = 'mxih-tikhub-xiaohongshu-user-posts.v1'
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

class StoredFallbackDelivery extends Error {
  constructor(result) {
    super('stored_fallback')
    this.result = result
  }
}

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

function capturedDate(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function response(body, requestId, replay, sourceMode, capturedAt, originSourceMode = null) {
  const captured = capturedDate(capturedAt)
  return {
    status: 200,
    body: { ...structuredClone(body), requestId },
    requestId,
    replay,
    sourceMode,
    capturedAt: captured?.toISOString() || null,
    staleAgeSeconds: captured ? Math.max(0, Math.floor((Date.now() - captured.getTime()) / 1_000)) : null,
    ...(originSourceMode ? { originSourceMode } : {}),
  }
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

function publicFailure(error) {
  const evidence = error.evidence || {}
  if (evidence.errorCode === 'upstream_user_unavailable') {
    return new AppError(404, 'user_not_found', 'The Xiaohongshu user could not be resolved')
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
    return new AppError(502, 'external_platform_outcome_unknown', 'External data call outcome is unknown; do not retry automatically')
  }
  return new AppError(502, 'external_platform_rejected', 'External data platform rejected the request')
}

function isTestKey(apiKey) {
  return apiKey?.environment === 'test' || apiKey?.prefix?.startsWith('mih_test_')
}

function fallbackResponse(snapshot, requestId) {
  const body = { ...structuredClone(snapshot.responseBody), requestId }
  return { body, result: response(body, requestId, false, 'stored_fallback', snapshot.capturedAt) }
}

function hasStageableProviderEvidence({ responseArchive, archiveObjects }) {
  const capturedAt = capturedDate(responseArchive?.capturedAt)
  if (!capturedAt || !SHA256_PATTERN.test(responseArchive?.payloadSha256 || '')) return false
  return Array.isArray(archiveObjects) && archiveObjects.some((object) => (
    object?.kind === 'response'
    && object.payloadSha256 === responseArchive.payloadSha256
  ))
}

export class TikHubUserInfoGateway {
  constructor({
    usageStore,
    platformStore,
    adapter = null,
    config,
    apiKeyPepper,
    reservationLeaseMs,
    operationControlStore = null,
    credentialStore = null,
    defaultPolicy = DEFAULT_POLICY,
    logger = console,
  }) {
    this.usageStore = usageStore
    this.platformStore = platformStore
    this.adapter = adapter
    this.config = config
    this.apiKeyPepper = apiKeyPepper
    this.reservationLeaseMs = reservationLeaseMs
    this.operationControlStore = operationControlStore
    this.credentialStore = credentialStore
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
    if (!this.adapter) return { ready: false, value: null, revision: null }
    let credentialSnapshot = null
    if (typeof this.credentialStore?.readCredentialSnapshot === 'function') {
      try {
        credentialSnapshot = await this.credentialStore.readCredentialSnapshot(TIKHUB_PROVIDER_KEY)
        if (credentialSnapshot.source === 'database') {
          return {
            ready: Boolean(credentialSnapshot.apiKey),
            value: credentialSnapshot.apiKey,
            revision: credentialSnapshot.revision,
          }
        }
      } catch {
        this.logger?.warn?.('[external-platform] TikHub credential snapshot is unavailable')
        return { ready: false, value: null, revision: null }
      }
    }
    try {
      const value = await this.adapter.resolveCredential()
      return { ready: Boolean(value), value, revision: credentialSnapshot?.revision ?? null }
    } catch {
      this.logger?.warn?.('[external-platform] TikHub credential is unavailable')
      return { ready: false, value: null, revision: credentialSnapshot?.revision ?? null }
    }
  }

  async #authorizeOperation(context, operationKey, credential) {
    if (this.operationControlStore) {
      return this.operationControlStore.authorizeDispatch('tikhub', operationKey, {
        consumerId: context.consumer.id,
        config: this.config,
        credentialConfigured: Boolean(credential?.ready),
        credentialRevision: credential?.revision ?? null,
      })
    }
    if (!this.config?.userActivityContractVerified) {
      throw new AppError(
        503,
        'external_platform_contract_unverified',
        'Hub-native Xiaohongshu user activity live dispatch is disabled',
      )
    }
    return null
  }

  async legacyUserInfo(context, input) {
    return this.#legacy(context, input, 'user-info')
  }

  async legacyCrawl(context, input) {
    return this.#legacy(context, input, 'crawl')
  }

  async #legacy(context, { body, idempotencyKey, path }, operation) {
    let durableRequestId = null
    let ownsReservation = false
    let paidDispatchOccurred = false
    try {
      if (isTestKey(context.apiKey)) {
        throw new AppError(403, 'test_key_not_supported', 'Test API keys cannot dispatch external acquisition')
      }
      if (!idempotencyKey) {
        throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header is required')
      }
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must contain 8-128 safe characters')
      }
      const isCrawl = operation === 'crawl'
      const gatewayOperation = isCrawl
        ? XIAOHONGSHU_CRAWL_OPERATION
        : XIAOHONGSHU_USER_INFO_OPERATION
      const [grants, capabilityGrants] = await Promise.all([
        typeof this.usageStore.listEffectiveGrants === 'function'
          ? this.usageStore.listEffectiveGrants(context.consumer.id, context.apiKey.id)
          : this.usageStore.listGrants(context.consumer.id),
        typeof this.usageStore.listEffectiveCapabilityGrants === 'function'
          ? this.usageStore.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
          : this.usageStore.listCapabilityGrants(context.consumer.id),
      ])
      if (!grants.includes(XIAOHONGSHU_PLATFORM)) {
        throw new AppError(403, 'platform_not_granted', 'Xiaohongshu data is not granted')
      }
      if (!capabilityGrants.includes(gatewayOperation)) {
        throw new AppError(403, 'capability_not_granted', `${gatewayOperation} is not granted`)
      }
      const consumerPolicy = {
        ...this.defaultPolicy,
        ...((await this.usageStore.getPolicy(context.consumer.id, XIAOHONGSHU_PLATFORM)) || {}),
      }
      const entitlement = typeof this.usageStore.getApiKeyPlatformEntitlement === 'function'
        ? await this.usageStore.getApiKeyPlatformEntitlement(context.apiKey.id, XIAOHONGSHU_PLATFORM)
        : null
      const policy = {
        ...consumerPolicy,
        maxPageSize: entitlement
          ? Math.min(consumerPolicy.maxPageSize, entitlement.maxPageSize)
          : consumerPolicy.maxPageSize,
      }
      const contractVersion = isCrawl
        ? XIAOHONGSHU_CRAWL_CONTRACT_VERSION
        : XIAOHONGSHU_USER_INFO_CONTRACT_VERSION
      let cursorCodec = null
      if (isCrawl) {
        if (typeof this.apiKeyPepper !== 'string' || !this.apiKeyPepper) {
          throw new AppError(503, 'external_platform_unavailable', 'External crawl cursor signing is unavailable')
        }
        const cursorSecret = createHash('sha256')
          .update(this.apiKeyPepper)
          .update('\u0000xiaohongshu-crawl-v1\u0000')
          .update(gatewayOperation)
          .digest('hex')
        cursorCodec = createExternalPlatformCursorCodec(cursorSecret, context.consumer.id)
      }

      let plan
      try {
        plan = isCrawl
          ? normalizeXiaohongshuCrawlRequest(body, {
              decodeCursor: cursorCodec.decode,
              maxPageSize: Math.min(100, policy.maxPageSize),
            })
          : buildXiaohongshuUserInfoPlan(body)
      } catch (error) {
        if (
          error instanceof TikHubXiaohongshuUserInfoContractError
          || error instanceof TikHubXiaohongshuUserPostsContractError
        ) throw new AppError(400, error.code, error.message)
        throw error
      }

      const pageSize = isCrawl ? plan.pageSize : plan.page.pageSize
      const pageNumber = isCrawl ? plan.page : plan.page.page
      const identity = isCrawl ? plan.identity : plan.identifiers[0]
      if (pageSize > policy.maxPageSize) {
        throw new AppError(400, 'page_size_exceeded', `Page size must not exceed ${policy.maxPageSize}`)
      }
      const requestFingerprint = fingerprint({ method: 'POST', path, body: { contractVersion, ...body } })
      const dispatchFingerprint = fingerprint({
        provider: TIKHUB_PROVIDER_KEY,
        operation: gatewayOperation,
        identity,
        page: pageNumber,
        pageSize,
        continuationFingerprint: plan.providerCursor
          ? fingerprint({ providerCursor: plan.providerCursor, resolvedUserId: plan.resolvedUserId })
          : null,
      })
      const resolverRequired = identity.kind === 'username' && !plan.resolvedUserId
      const endpointKeys = [
        ...(resolverRequired ? [TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY] : []),
        TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
        ...(isCrawl ? [TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY] : []),
      ]
      const expectedProviderCalls = endpointKeys.length

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
        meterKey: gatewayOperation,
        requiredAuthorizationScopes: [
          { type: 'platform', key: XIAOHONGSHU_PLATFORM },
          { type: 'capability', key: gatewayOperation },
        ],
        unitsReserved: 1,
        leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
        windowStart: new Date(Date.now() - policy.windowSeconds * 1_000),
        maxRequests: policy.maxRequests,
        replayWindowMs: null,
      })
      durableRequestId = reservation.request?.id || requestId
      ownsReservation = reservation.kind === 'reserved'
      if (reservation.kind === 'conflict') {
        throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
      }
      if (reservation.kind === 'in_progress') {
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
        if (reservation.request.responseStatus >= 400) {
          const stored = reservation.request.responseBody?.error
          throw new AppError(
            reservation.request.responseStatus,
            stored?.code || 'external_platform_rejected',
            stored?.message || 'External data platform rejected the request',
            stored?.details || {},
          )
        }
        return response(
          reservation.request.responseBody,
          reservation.request.id,
          true,
          'idempotent_replay',
          reservation.request.capturedAt || reservation.request.completedAt,
          reservation.request.deliverySourceMode,
        )
      }

      const activeRequestId = reservation.request.id
      const delivery = {
        providerKey: TIKHUB_PROVIDER_KEY,
        tenantId: context.tenant.id,
        tenantName: context.tenant.name,
        consumerId: context.consumer.id,
        usageRequestId: activeRequestId,
        operation: gatewayOperation,
        fingerprint: requestFingerprint,
        snapshotFingerprint: dispatchFingerprint,
      }
      const now = new Date()
      let snapshot = await this.platformStore.snapshotFor({
        consumerId: context.consumer.id,
        operation: gatewayOperation,
        fingerprint: dispatchFingerprint,
      }, now)
      if (snapshot && new Date(snapshot.freshUntil) >= now) {
        const responseBody = { ...structuredClone(snapshot.responseBody), requestId: activeRequestId }
        await this.platformStore.commitSnapshotDelivery({
          delivery, snapshot, sourceMode: 'fresh_cache', responseBody, usageUnitsActual: 1,
        })
        ownsReservation = false
        return response(responseBody, activeRequestId, false, 'fresh_cache', snapshot.capturedAt)
      }

      const state = await this.platformStore.providerState(TIKHUB_PROVIDER_KEY)
      const circuitOpen = state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now
      const resolvedCredential = circuitOpen
        ? { ready: false, value: null, revision: null }
        : await this.#credential()
      let operationControl = null
      let operationControlError = null
      if (!circuitOpen) {
        try {
          operationControl = await this.#authorizeOperation(
            context,
            gatewayOperation,
            resolvedCredential,
          )
        } catch (error) {
          operationControlError = error
        }
      }

      if (!resolvedCredential.ready || circuitOpen || operationControlError) {
        if (snapshot) {
          const fallback = fallbackResponse(snapshot, activeRequestId)
          await this.platformStore.commitSnapshotDelivery({
            delivery,
            snapshot,
            sourceMode: 'stored_fallback',
            responseBody: fallback.body,
            usageUnitsActual: 1,
          })
          ownsReservation = false
          return fallback.result
        }
        const code = operationControlError instanceof AppError
          ? operationControlError.code
          : operationControlError
            ? 'external_platform_control_store_unavailable'
            : circuitOpen
              ? 'external_platform_circuit_open'
              : 'external_platform_not_configured'
        const status = operationControlError instanceof AppError ? operationControlError.status : 503
        await this.platformStore.rejectWithoutDispatch({
          delivery,
          sourceMode: circuitOpen ? 'circuit_rejected' : 'unavailable',
          status,
          errorCode: code,
        })
        ownsReservation = false
        if (operationControlError) throw operationControlError
        throw new AppError(503, code, 'External Xiaohongshu user data is unavailable')
      }

      let ownsLease = false
      let entered = false
      let pendingCall = null
      let pendingEvidence = null
      let costReservation = null
      try {
        const lease = await this.platformStore.acquireDispatchLease({
          consumerId: context.consumer.id,
          operation: gatewayOperation,
          fingerprint: dispatchFingerprint,
          endpointKey: isCrawl
            ? TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY
            : TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
          contractVersion,
          ownerRequestId: activeRequestId,
          expiresAt: new Date(Date.now() + this.reservationLeaseMs),
        })
        ownsLease = lease === true || lease?.kind === 'acquired'
        if (!ownsLease) {
          snapshot = await this.platformStore.snapshotFor({
            consumerId: context.consumer.id,
            operation: gatewayOperation,
            fingerprint: dispatchFingerprint,
          }, new Date())
          if (snapshot) {
            const fresh = new Date(snapshot.freshUntil) >= new Date()
            const sourceMode = fresh ? 'fresh_cache' : 'stored_fallback'
            const responseBody = { ...structuredClone(snapshot.responseBody), requestId: activeRequestId }
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode, responseBody, usageUnitsActual: 1,
            })
            ownsReservation = false
            return response(responseBody, activeRequestId, false, sourceMode, snapshot.capturedAt)
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'duplicate_suppressed', status: 409, errorCode: 'request_in_progress',
          })
          ownsReservation = false
          throw new AppError(409, 'request_in_progress', 'An equal provider dispatch is already in progress')
        }
        if (!this.#enter(context.consumer.id)) {
          if (snapshot) {
            const fallback = fallbackResponse(snapshot, activeRequestId)
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode: 'stored_fallback', responseBody: fallback.body,
              usageUnitsActual: 1,
            })
            ownsReservation = false
            return fallback.result
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_busy',
          })
          ownsReservation = false
          throw new AppError(429, 'external_platform_busy', 'External Xiaohongshu concurrency is exhausted')
        }
        entered = true

        if (typeof this.platformStore.reserveProviderCostWorkflow !== 'function') {
          throw new AppError(
            503,
            'external_platform_cost_control_unavailable',
            'Atomic external provider cost admission is unavailable',
          )
        }
        const costConfig = operationControl?.billing
          ? { billing: operationControl.billing }
          : this.config
        const costControls = endpointKeys.map((endpointKey) => providerCostControl(costConfig, endpointKey))
        try {
          costReservation = await this.platformStore.reserveProviderCostWorkflow({
            tenantId: context.tenant.id,
            consumerId: context.consumer.id,
            apiKeyId: context.apiKey.id,
            usageRequestId: activeRequestId,
            fingerprint: requestFingerprint,
            costControls,
          })
        } catch (error) {
          if (snapshot && error instanceof AppError && [
            'external_platform_cost_budget_exhausted',
            'external_platform_subsidy_budget_exhausted',
          ].includes(error.code)) {
            const fallback = fallbackResponse(snapshot, activeRequestId)
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode: 'stored_fallback', responseBody: fallback.body,
              usageUnitsActual: 1,
            })
            ownsReservation = false
            return fallback.result
          }
          throw error
        }

        // Cost reservations are releasable; rate-limit tokens are not. Reserve
        // the complete workflow cost first so budget-rejected requests cannot
        // consume provider capacity without making a call.
        const admission = typeof this.platformStore.acquireProviderRateLimit === 'function'
          ? await this.platformStore.acquireProviderRateLimit({
              limit: this.config.maxRequestsPerMinute ?? 120,
              tokens: expectedProviderCalls,
              windowMs: 60_000,
            })
          : { allowed: true, retryAfterMs: 0 }
        if (!admission.allowed) {
          if (snapshot) {
            const fallback = fallbackResponse(snapshot, activeRequestId)
            await this.platformStore.commitSnapshotDelivery({
              delivery, snapshot, sourceMode: 'stored_fallback', responseBody: fallback.body,
              usageUnitsActual: 1,
            })
            ownsReservation = false
            return fallback.result
          }
          await this.platformStore.rejectWithoutDispatch({
            delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_rate_limited',
          })
          ownsReservation = false
          throw new AppError(429, 'external_platform_rate_limited', 'External Xiaohongshu request rate is exhausted', {
            retryAfterMs: admission.retryAfterMs,
          })
        }

        let ordinal = 0
        let totalLatencyMs = 0
        const startedAt = performance.now()
        const dispatch = async ({ endpointKey, endpointVersion, invoke, terminal, itemCount, ingestJob = null }) => {
          const costControl = costControls[ordinal]
          if (!costControl || endpointKeys[ordinal] !== endpointKey) {
            throw new AppError(500, 'external_platform_workflow_invalid', 'Provider workflow order is invalid')
          }
          let call
          try {
            call = await this.platformStore.beginProviderCall({
              tenantId: context.tenant.id,
              consumerId: context.consumer.id,
              apiKeyId: context.apiKey.id,
              usageRequestId: activeRequestId,
              operation: gatewayOperation,
              contractVersion,
              endpointKey,
              endpointVersion,
              marketplace: XIAOHONGSHU_PLATFORM,
              fingerprint: requestFingerprint,
              dispatchFingerprint,
              callOrdinal: ordinal,
              callRole: ordinal === 0 ? 'primary' : 'enrichment',
              costControl,
              costReservationId: costReservation.id,
              operationControl,
            })
          } catch (error) {
            if (paidDispatchOccurred) {
              await this.usageStore.markRequestUnknown(
                activeRequestId,
                'external_platform_workflow_incomplete',
              ).catch(() => {})
              ownsReservation = false
            }
            throw error
          }
          ordinal += 1
          pendingCall = call
          pendingEvidence = {
            billed: null,
            costMinor: costControl.costMinor,
            costKind: costControl.costKind,
            currency: costControl.currency,
          }
          const callStartedAt = performance.now()
          try {
            paidDispatchOccurred = true
            const upstream = await invoke()
            const latencyMs = Math.max(0, Math.round(performance.now() - callStartedAt))
            totalLatencyMs += latencyMs
            const evidence = {
              billed: true,
              costMinor: costControl.costMinor,
              costKind: costControl.costKind,
              currency: costControl.currency,
              latencyMs,
              itemCount: itemCount(upstream),
              responseArchive: upstream.responseArchive,
              restrictedResponseArchive: upstream.restrictedResponseArchive,
              upstreamEvidence: upstream.upstreamEvidence,
              archiveObjects: upstream.archiveObjects,
            }
            pendingEvidence = evidence
            await this.platformStore.stageProviderEvidence({ callId: call.id, delivery, ...evidence })
            if (!terminal) {
              await this.platformStore.finishProviderStep({
                callId: call.id,
                delivery,
                outcome: 'succeeded',
                ...evidence,
                errorCode: null,
                affectsCircuit: false,
                ...(typeof ingestJob === 'function' ? { ingestJob: ingestJob(upstream, call.id) } : {}),
              })
              pendingCall = null
              pendingEvidence = null
            }
            return upstream
          } catch (error) {
            if (!(error instanceof TikHubUpstreamError)) {
              await this.platformStore.markPersistenceUnknown({
                callId: call.id,
                delivery,
                ...pendingEvidence,
              }).catch(() => {})
              ownsReservation = false
              throw error
            }
            const mapped = publicFailure(error)
            const latencyMs = Math.max(0, Math.round(performance.now() - callStartedAt))
            totalLatencyMs += latencyMs
            const evidence = {
              billed: error.evidence.billed ?? null,
              costMinor: costControl.costMinor,
              costKind: costControl.costKind,
              currency: costControl.currency,
              latencyMs,
              itemCount: 0,
              responseArchive: error.responseArchive,
              restrictedResponseArchive: error.restrictedResponseArchive,
              upstreamEvidence: error.upstreamEvidence,
              archiveObjects: error.archiveObjects,
            }
            // Invalid JSON/UTF-8 still has an exact restricted byte archive but
            // intentionally has no sanitized JSON archive. Skip the staging
            // precondition in that case; finishFailure persists the restricted
            // evidence transactionally with the provider-call outcome.
            if (hasStageableProviderEvidence(evidence)) {
              await this.platformStore.stageProviderEvidence({
                callId: call.id,
                delivery,
                httpStatus: error.evidence.httpStatus,
                businessCode: error.evidence.businessCode,
                errorCode: error.evidence.errorCode,
                ...evidence,
              })
            }
            const fallback = snapshot ? fallbackResponse(snapshot, activeRequestId) : null
            await this.platformStore.finishFailure({
              callId: call.id,
              delivery,
              outcome: error.evidence.outcome,
              httpStatus: error.evidence.httpStatus,
              businessCode: error.evidence.businessCode,
              ...evidence,
              errorCode: error.evidence.errorCode,
              failureResponseStatus: mapped.status,
              failureResponseBody: failureBody(mapped, activeRequestId),
              affectsCircuit: error.evidence.affectsCircuit !== false,
              snapshot,
              fallbackResponseBody: fallback?.body,
              usageUnitsActual: snapshot ? 1 : 0,
            })
            pendingCall = null
            pendingEvidence = null
            ownsReservation = false
            if (fallback) throw new StoredFallbackDelivery(fallback.result)
            throw mapped
          }
        }

        let selectedIdentity = plan.resolvedUserId
          ? { kind: 'user_id', value: plan.resolvedUserId }
          : identity
        const profileIngestJob = (profileValue, callId, parserVersion) => {
          const page = {
            page: 1,
            pageSize: 1,
            hasMore: false,
            nextCursor: null,
            providerCursor: null,
            nextParams: null,
            nextPage: null,
            paginationMode: 'none',
          }
          const projected = toNightAllXiaohongshuUserInfoEnvelope([profileValue], page, {
            providerCalls: 1,
            durationMs: 0,
          })
          const records = normalizeNightAllLegacyPayload(
            projected,
            XIAOHONGSHU_PLATFORM,
            'user-info',
            { connectorId: TIKHUB_XIAOHONGSHU_CONNECTOR_ID, parserVersion },
          ).records
          return {
            payload: {
              kind: 'external-platform-result',
              providerKey: TIKHUB_PROVIDER_KEY,
              datasetId: NIGHT_ALL_COMPAT_DATASET_ID,
              platform: XIAOHONGSHU_PLATFORM,
              requestId: activeRequestId,
              queryFingerprint: requestFingerprint,
              providerCallId: callId,
              records,
            },
            dedupeKey: `external-platform:tikhub:${callId}`,
            priority: 100,
          }
        }
        let profileCall = profileCallForIdentifier(selectedIdentity)
        if (profileCall.role === 'resolve') {
          const resolved = await dispatch({
            endpointKey: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_KEY,
            endpointVersion: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
            terminal: false,
            itemCount: () => 1,
            invoke: () => this.adapter.searchXiaohongshuUsers(selectedIdentity.value, {
              credential: resolvedCredential.value,
            }),
            ingestJob: (upstream, callId) => profileIngestJob({
              user_id: upstream.user.userId,
              user_name: upstream.user.username,
              name: upstream.user.displayName,
              profile_image_url: upstream.user.avatarUrl || '',
              url: `https://www.xiaohongshu.com/user/profile/${upstream.user.userId}`,
              original_url: `https://www.xiaohongshu.com/user/profile/${upstream.user.userId}`,
              crawled_at: Math.floor(new Date(upstream.capturedAt).getTime() / 1_000),
            }, callId, `${USER_INFO_PARSER_VERSION}:search-users`),
          })
          selectedIdentity = { kind: 'user_id', value: resolved.user.userId }
          profileCall = profileCallForIdentifier(selectedIdentity)
        }

        const profile = await dispatch({
          endpointKey: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_KEY,
          endpointVersion: TIKHUB_XIAOHONGSHU_USER_ENDPOINT_VERSION,
          terminal: !isCrawl,
          itemCount: () => 1,
          invoke: () => this.adapter.getXiaohongshuUserInfo(profileCall.query, {
            credential: resolvedCredential.value,
          }),
          ingestJob: isCrawl
            ? (upstream, callId) => profileIngestJob(
                upstream.profile,
                callId,
                USER_INFO_PARSER_VERSION,
              )
            : null,
        })

        let posts = null
        if (isCrawl) {
          posts = await dispatch({
            endpointKey: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_KEY,
            endpointVersion: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_VERSION,
            terminal: true,
            itemCount: (upstream) => upstream.posts.items.length,
            invoke: () => this.adapter.getXiaohongshuUserPostedNotes({
              user_id: profile.profile.user_id,
              ...(plan.providerCursor ? { cursor: plan.providerCursor } : {}),
            }, plan, {
              credential: resolvedCredential.value,
              encodeCursor: cursorCodec.encode,
            }),
          })
        }

        const capturedAt = capturedDate(
          (isCrawl ? posts : profile).capturedAt
          || pendingEvidence?.responseArchive?.capturedAt,
        ) || new Date()
        const durationMs = Math.max(totalLatencyMs, Math.round(performance.now() - startedAt))
        const projected = isCrawl
          ? toNightAllXiaohongshuCrawlEnvelope(profile.profile, posts.posts, {
              providerCalls: ordinal,
              durationMs,
            })
          : toNightAllXiaohongshuUserInfoEnvelope([profile.profile], plan.page, {
              providerCalls: ordinal,
              durationMs,
            })
        const responseBody = { ...projected, requestId: activeRequestId }
        let records = normalizeNightAllLegacyPayload(
          projected,
          XIAOHONGSHU_PLATFORM,
          operation,
          {
            connectorId: TIKHUB_XIAOHONGSHU_CONNECTOR_ID,
            parserVersion: isCrawl ? USER_POSTS_PARSER_VERSION : USER_INFO_PARSER_VERSION,
          },
        ).records
        if (isCrawl) records = records.filter((record) => record.objectType !== 'profile')
        const itemCount = isCrawl ? posts.posts.items.length : 1
        await this.platformStore.commitLiveDelivery({
          callId: pendingCall.id,
          delivery,
          responseBody,
          snapshotBody: projected,
          capturedAt,
          freshUntil: new Date(capturedAt.getTime() + this.config.freshTtlMs),
          staleUntil: new Date(capturedAt.getTime() + this.config.staleTtlMs),
          itemCount,
          usageUnitsActual: 1,
          usageLatencyMs: durationMs,
          ...pendingEvidence,
          ingestJob: {
            payload: {
              kind: 'external-platform-result',
              providerKey: TIKHUB_PROVIDER_KEY,
              datasetId: NIGHT_ALL_COMPAT_DATASET_ID,
              platform: XIAOHONGSHU_PLATFORM,
              requestId: activeRequestId,
              queryFingerprint: requestFingerprint,
              providerCallId: pendingCall.id,
              records,
            },
            dedupeKey: `external-platform:tikhub:${pendingCall.id}`,
            priority: 100,
          },
        })
        pendingCall = null
        pendingEvidence = null
        ownsReservation = false
        return response(responseBody, activeRequestId, false, 'live', capturedAt)
      } catch (error) {
        if (error instanceof StoredFallbackDelivery) throw error
        if (pendingCall) {
          await this.platformStore.markPersistenceUnknown({
            callId: pendingCall.id,
            delivery,
            ...(pendingEvidence || {}),
          }).catch(async () => {
            await this.usageStore.markRequestUnknown(
              activeRequestId,
              'external_platform_persistence_unknown',
            ).catch(() => {})
          })
          ownsReservation = false
        }
        throw error
      } finally {
        if (costReservation && typeof this.platformStore.releaseProviderCostWorkflow === 'function') {
          await this.platformStore.releaseProviderCostWorkflow({
            reservationId: costReservation.id,
            usageRequestId: activeRequestId,
          }).catch((error) => {
            this.logger?.warn?.(`[external-platform] TikHub cost reservation release failed: ${error.message}`)
          })
        }
        if (ownsLease) {
          await this.platformStore.releaseDispatchLease({
            consumerId: context.consumer.id,
            operation: gatewayOperation,
            fingerprint: dispatchFingerprint,
            ownerRequestId: activeRequestId,
          }).catch(() => {})
        }
        if (entered) this.#leave(context.consumer.id)
      }
    } catch (error) {
      if (error instanceof StoredFallbackDelivery) return error.result
      if (ownsReservation && durableRequestId) {
        if (paidDispatchOccurred || error?.code === 'external_platform_call_persistence_unknown') {
          await this.usageStore.markRequestUnknown(
            durableRequestId,
            'external_platform_workflow_incomplete',
          ).catch(() => {})
        } else {
          await this.usageStore.releaseRequest(
            durableRequestId,
            'external_platform_pre_dispatch_failed',
          ).catch(() => {})
        }
      }
      if (!(error instanceof AppError)) {
        this.logger?.error?.({ requestId: durableRequestId, error }, 'TikHub user activity gateway request failed')
      }
      if (error instanceof AppError && durableRequestId && !error.details?.requestId) {
        throw new AppError(error.status, error.code, error.message, {
          ...(error.details || {}), requestId: durableRequestId,
        })
      }
      throw error
    }
  }
}
