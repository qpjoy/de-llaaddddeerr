import { requestMaintenance } from '../core/request-maintenance.mjs'
import { currentAdmissionLimits, refreshAdmissionLimits, admissionQueuePolicy } from './admission-runtime.mjs'
import { isHubRateLimitExempt, isInternalTraffic, internalCircuitState } from '../core/internal-traffic-policy.mjs'
import { circuitOpenError, ecommerceCapacityError, upstreamCapacityError } from './availability-errors.mjs'
import { ConcurrencyAdmissionQueue, DEFAULT_CONCURRENCY_QUEUE, concurrencyBusy } from './concurrency-admission.mjs'
import { WebSearchUpstreamError } from '../adapters/web-search.mjs'
import { gatewayWebSearchRequest } from '../web-search/contract.mjs'
import { assertEnterpriseCallable, normalizeEnterpriseRequest, enterpriseOperation, ENTERPRISE_DATASET, ENTERPRISE_CAPABILITY } from '../contracts/enterprise.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest } from '../contracts/native-forwarding.mjs'
import { TikHubUpstreamError } from '../adapters/tikhub.mjs'
import { RapidApiUpstreamError } from '../adapters/rapidapi.mjs'
import { HUB_SOCIAL_ENDPOINTS, normalizeHubSocialRequest } from '../contracts/hub-social.mjs'
import { normalizeHubSocialCompatRequest } from '../contracts/hub-social-compat.mjs'
import { normalizeXhsDiscoveryRequest, XHS_DISCOVERY_ENDPOINTS } from '../contracts/xiaohongshu-discovery.mjs'
import { createHash, randomUUID } from 'node:crypto'
import {
  ECOMMERCE_DELIVERY_MODES,
  ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
  JUSTONE_OPERATION,
  JustOneContractError,
  normalizeJustOneProductSearchRequest,
} from '../contracts/justone.mjs'
import {
  JUSTONE_RELEASED_RESOURCES,
  JUSTONE_RESOURCE_CATALOG,
  normalizeJustOneResourceRequest,
} from '../contracts/justone-resources.mjs'
import {
  SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
  SOCIAL_ACCOUNT_SEARCH_OPERATION,
  SocialAccountContractError,
  normalizeSocialAccountSearchRequest,
} from '../contracts/social-accounts.mjs'
import { JustOneUpstreamError, JustOneSucceededUnusableError } from '../adapters/justone.mjs'
import { AppError } from '../core/errors.mjs'
import { createExternalPlatformCursorCodec, createRawSearchCursorCodec, createDataSearchCursorCodec, createNightAllCompatibilityCursorCodec } from './cursor.mjs'
import { describeDeliveryReason } from './delivery-reason.mjs'
import { acquisitionRequestSnapshot } from '../acquisitions/request-snapshot.mjs'
import { normalizeRawSearch, projectWeiboSearch, rawSearchRecords, RAW_SEARCH_DATASET, RAW_SEARCH_PATH, WEIBO_SEARCH_KEY } from '../contracts/raw-search.mjs'
import { enrichWeiboRawSearch } from './raw-search-enrichment.mjs'
import { INSTAGRAM_SEARCH_KEY, projectInstagramSearch } from '../contracts/instagram-search.mjs'
import { JUSTONE_INSTAGRAM_SEARCH_KEY, projectJustOneInstagramSearch } from '../contracts/instagram-justone-search.mjs'
import { normalizeHubDataSearch, projectDataSearch, projectTwitterSearchFillDelivery } from '../contracts/hub-data-search.mjs'
import { runTwitterSearchFill } from './twitter-search-fill.mjs'
import { contentSearchPlan } from './content-search.mjs'
import { socialAccountPlan } from './social-account-delivery.mjs'
import { youtubeCommentsPlan } from './youtube-comments-workflow.mjs'
import { runFacebookSearchFill } from './facebook-search-fill.mjs'
import { waitForFacebookRapidAdmission } from './facebook-rapid-admission.mjs'
import { normalizeFacebookSearch, projectFacebookSearch, facebookJustOneArchives, FACEBOOK_OPERATION, FACEBOOK_JUSTONE_KEY } from '../contracts/facebook-search.mjs'

const AUTHORIZATION_PLATFORM = 'ecommerce'
const DEFAULT_POLICY = Object.freeze({ maxRequests: 100_000, windowSeconds: 3_600, maxPageSize: 100 })
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function operationReadyForConsumer(operation, consumerId) {
  if (operation?.effectiveState === 'active') return true
  if (operation?.effectiveState !== 'canary' || !consumerId) return false
  return operation.canaryConsumerIds?.some((candidate) => (
    String(candidate).toLowerCase() === String(consumerId).toLowerCase()
  )) === true
}

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

function providerCostControl(config, endpointKey, allowZeroCost = false) {
  const billing = config?.billing || {}
  const costMinor = billing.unitCostMinorByEndpoint?.[endpointKey]
  if (!Number.isSafeInteger(costMinor) || costMinor < (allowZeroCost ? 0 : 1)
    || !Number.isSafeInteger(billing.monthlyBudgetMinor) || billing.monthlyBudgetMinor < 0
    || !Number.isSafeInteger(billing.monthlySubsidyBudgetMinor)
    || billing.monthlySubsidyBudgetMinor < 0
    || !/^[A-Z]{3}$/u.test(billing.currency || '')) {
    throw new AppError(
      503,
      'external_platform_cost_control_unavailable',
      'External data cost control is unavailable; paid dispatch is disabled',
    )
  }
  return {
    costMinor,
    costKind: 'estimated',
    currency: billing.currency,
    monthlyBudgetMinor: billing.monthlyBudgetMinor,
    monthlySubsidyBudgetMinor: billing.monthlySubsidyBudgetMinor,
  }
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
  return {
    responseArchive,
    upstreamEvidence,
    restrictedResponseArchive: source?.restrictedResponseArchive ?? null,
  }
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
  reasonDetail = null,
}) {
  const captured = asDate(capturedAt) || servedAt
  const ageSeconds = Math.max(0, Math.floor((servedAt.getTime() - captured.getTime()) / 1_000))
  // `reason` is derived from the same sourceMode/fallbackReason pair that is
  // written to durable delivery evidence, so the public explanation and the
  // audit row cannot drift apart. `fallbackReason` stays for compatibility.
  const deliveryReason = describeDeliveryReason({ sourceMode, fallbackReason, detail: reasonDetail })
  // WeChat is a Hub-owned public surface. Keep the delivery facts and durable
  // replay body while leaving connector topology in restricted call evidence.
  const reason = sourceMode === 'live' && base?.endpoint?.startsWith('wechat.')
    ? { ...deliveryReason, scope: 'data_service', summary: 'Served from a fresh Hub data request.' }
    : deliveryReason
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
      ...(reason ? { reason } : {}),
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
  const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details
    : {}
  return {
    error: {
      code: error.code,
      message: error.message,
      details: { ...details, requestId },
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
  const storedDetails = stored?.details && typeof stored.details === 'object' && !Array.isArray(stored.details)
    ? stored.details
    : {}
  return new AppError(status, code, message, { ...storedDetails, requestId: request.id })
}

function publicFailure(error, { ecommerce = false } = {}) {
  const evidence = error.evidence || {}
  if (error instanceof WebSearchUpstreamError) {
    const code = evidence.outcome === 'unknown' ? 'web_search_upstream_outcome_unknown'
      : evidence.outcome === 'succeeded_unusable' ? 'web_search_upstream_response_unusable' : evidence.errorCode
    return new AppError(evidence.errorCode === 'web_search_egress_unavailable' ? 503 : evidence.httpStatus === 429 ? 429 : 502,
      code, 'Search request failed; reuse the same request identifier to verify its outcome', {
        ...(evidence.httpStatus === 429 ? upstreamCapacityError(evidence).details : {}),
        outcome: evidence.outcome, retryable: false })
  }
  if (error instanceof RapidApiUpstreamError) {
    if (evidence.errorCode === 'social_egress_unavailable') return new AppError(503, 'social_egress_unavailable', 'Social data egress is unavailable; no business request was dispatched', { outcome: 'rejected', retryable: false })
    const unknown = evidence.outcome === 'unknown'
    const code = unknown ? 'social_upstream_outcome_unknown' : evidence.outcome === 'succeeded_unusable' ? 'social_upstream_response_unusable' : 'social_upstream_rejected'
    return new AppError(evidence.httpStatus === 429 ? 429 : 502, code,
      `External social data request failed (upstreamStatus: ${evidence.httpStatus ?? 'unknown'}${evidence.businessCode != null ? `, upstreamCode: ${evidence.businessCode}` : ''})`,
      { ...(evidence.httpStatus === 429 ? upstreamCapacityError(evidence).details : {}),
        upstreamStatus: evidence.httpStatus, ...(evidence.businessCode != null ? {upstreamCode:evidence.businessCode} : {}), outcome: evidence.outcome, retryable: false })
  }
  // Business capacity codes belong to JustOne. Other suppliers may reuse
  // those numbers in error metadata without reporting a capacity failure.
  if (ecommerce && error instanceof JustOneUpstreamError
    && ({ 601: 'upstream_balance_exhausted', 602: 'upstream_token_limit_exceeded',
      303: 'upstream_daily_quota_exceeded' })[evidence.businessCode] === evidence.errorCode) {
    const capacity = ecommerceCapacityError(evidence.errorCode, {
      status: evidence.businessCode === 303 ? 429 : 503,
      code: evidence.businessCode === 303 ? 'external_platform_capacity_exceeded' : 'external_platform_capacity_unavailable',
      requestDispatched: true,
    })
    if (capacity) return capacity
  }
  if (evidence.httpStatus === 429
    || (error instanceof JustOneUpstreamError && [302, 303].includes(evidence.businessCode))) {
    return upstreamCapacityError(evidence)
  }
  if (error instanceof JustOneUpstreamError && [100, 600, 601, 602].includes(evidence.businessCode)) {
    return new AppError(503, 'external_platform_capacity_unavailable', 'External data capacity is unavailable')
  }
  if (evidence.outcome === 'succeeded_unusable') {
    return new AppError(
      502,
      'external_platform_response_unusable',
      'The external call was accepted but its response could not be normalized; do not retry automatically',
      {
        upstreamAccepted: true,
        normalizationCode: typeof evidence.errorCode === 'string'
          ? evidence.errorCode
          : 'unknown_response_shape',
      },
    )
  }
  if (evidence.outcome === 'unknown') {
    return new AppError(
      502,
      'external_platform_outcome_unknown',
      'External data call outcome is unknown; do not retry automatically',
    )
  }
  if (error instanceof JustOneUpstreamError
    && evidence.outcome === 'rejected'
    && evidence.businessCode === 301
    && evidence.errorCode === 'upstream_collection_failed') {
    // Keep the existing public status/code and immutable replay contract. A
    // reviewed collection failure has a useful neutral reason; raw provider
    // messages and procurement billing do not belong in the public response.
    return new AppError(
      502,
      'external_platform_rejected',
      'The data source reported a collection failure',
      { reasonCode: 'upstream_collection_failed', outcome: 'rejected', retryable: false },
    )
  }
  return new AppError(502, 'external_platform_rejected', 'External data platform rejected the request')
}

function resultFromBody(body, {
  requestId,
  replay,
  sourceMode,
  capturedAt,
  originSourceMode = null,
}) {
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
    ...(originSourceMode ? { originSourceMode } : {}),
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
    operationControlStore = null,
    admissionPolicies = null,
    credentialStore = null,
    ecommerceRoutingStore = null,
    // Everything in this class is provider-shaped rather than provider-specific:
    // the adapter, config, stores and credential all arrive by injection. The
    // provider key is the last constant, so naming it here lets a second vendor
    // reuse this orchestration instead of growing a parallel copy of it.
    providerKey = 'justone',
    defaultPolicy = DEFAULT_POLICY,
    logger = console,
    admissionClock = Date.now,
  }) {
    this.providerKey = providerKey
    this.usageStore = usageStore
    this.platformStore = platformStore
    this.adapter = adapter
    this.config = config
    this.apiKeyPepper = apiKeyPepper
    this.reservationLeaseMs = reservationLeaseMs
    this.operationControlStore = operationControlStore
    this.admissionPolicies = admissionPolicies
    this.credentialStore = credentialStore
    this.ecommerceRoutingStore = ecommerceRoutingStore
    this.defaultPolicy = defaultPolicy
    this.logger = logger
    this.active = 0
    this.activeByConsumer = new Map()
    this.admissionClock = admissionClock
    this.concurrencyQueue = new ConcurrencyAdmissionQueue({ clock: admissionClock })
  }

  #enter(context) {
    if (isHubRateLimitExempt(context)) return 'exempt'
    const consumerId = context.consumer.id
    const consumerActive = this.activeByConsumer.get(consumerId) || 0
    if (
      this.active >= currentAdmissionLimits(this).maxConcurrency
      || (!(this.providerKey === 'tikhub' && isInternalTraffic(this.usageStore, context)) && consumerActive >= currentAdmissionLimits(this).maxConsumerConcurrency)
    ) return false
    this.active += 1
    this.activeByConsumer.set(consumerId, consumerActive + 1)
    return true
  }

  #leave(consumerId, admission = true) {
    // Release the captured admission, not the current mutable Key setting.
    // Exempt work neither occupies nor releases an ordinary caller's slot.
    if (admission === 'exempt') return
    this.active = Math.max(0, this.active - 1)
    const next = Math.max(0, (this.activeByConsumer.get(consumerId) || 1) - 1)
    if (next === 0) this.activeByConsumer.delete(consumerId)
    else this.activeByConsumer.set(consumerId, next)
    this.concurrencyQueue.drain()
  }

  async #revalidateWaitingIdentity(context, platform, plan) {
    const current = await this.usageStore.findApiKeyById(context.apiKey.id)
    if (!current || current.apiKey.status !== 'active' || current.consumer.id !== context.consumer.id
      || current.tenant.id !== context.tenant.id) throw new AppError(403, 'capability_not_granted', 'Access changed while waiting')
    const grants = await this.usageStore.listEffectiveGrants(current.consumer.id, current.apiKey.id)
    const capabilities = await this.usageStore.listEffectiveCapabilityGrants(current.consumer.id, current.apiKey.id)
    const required = [...(!plan.platformSearch ? [plan.capability || plan.operation] : []), ...(plan.requiredCapabilities || [])]
    if (!grants.includes(platform) || required.some(key => !capabilities.includes(key))) {
      throw new AppError(403, 'capability_not_granted', 'Access changed while waiting')
    }
    const assignment = await this.usageStore.getConsumerPlan(current.consumer.id)
    if (!assignment || assignment.status !== 'active' || assignment.versionStatus !== 'published') {
      throw new AppError(503, 'plan_assignment_unavailable', 'An active published plan assignment is required')
    }
    return { ...context, ...current }
  }

  async #enterOrQueue(context, { lease, delivery, expiresAt, signal, platform, canWait, revalidate }) {
    await refreshAdmissionLimits(this)
    if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
    if (isHubRateLimitExempt(context)) return 'exempt'
    if (!this.concurrencyQueue.entries.length && this.#enter(context)) return true
    if (!canWait) return false
    const policy = admissionQueuePolicy(this)
    const deadline = Math.min(this.admissionClock() + policy.maxWaitMs,
      new Date(expiresAt).getTime() - (this.config.timeoutMs || 30000) - 5000)
    const ownedSearchDelivery = this.providerKey === 'rapidapi' && ['twitter', 'facebook'].includes(platform) && lease?.ownedDeliveryLease === true
    let entered = false
    try {
      // Ordinary queued requests release dispatch arbitration while keeping
      // their original customer reservation. Reclaim it after waiting so new
      // unknown-outcome evidence remains authoritative, without extending it.
      // Standard social searches also own finalization. Keep their arbitration
      // during first-acquisition waiting; the owned claim below still checks
      // new unknown/quarantine evidence without extending that lease.
      if (!ownedSearchDelivery) await this.platformStore.releaseDispatchLease(lease)
      await this.concurrencyQueue.enter({ tryEnter: () => (entered = this.#enter(context)), deadline,
        maxPending: policy.maxPending, signal })
      context = await revalidate()
      await refreshAdmissionLimits(this)
      if (entered !== 'exempt' && (this.active > currentAdmissionLimits(this).maxConcurrency
        || (!(this.providerKey === 'tikhub' && isInternalTraffic(this.usageStore, context))
          && (this.activeByConsumer.get(context.consumer.id) || 0) > currentAdmissionLimits(this).maxConsumerConcurrency))) {
        throw concurrencyBusy('consumer_concurrency_changed')
      }
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      if (this.admissionClock() >= deadline) throw concurrencyBusy('concurrency_queue_timeout')
      const claim = await this.platformStore.acquireDispatchLease(lease)
      if (claim !== true && claim?.kind !== 'acquired') {
        const code = claim?.reason === 'unknown' ? 'request_outcome_unknown'
          : claim?.reason === 'succeeded_unusable' ? 'external_platform_response_unusable' : 'request_in_progress'
        throw new AppError(409, code, 'Dispatch protection changed while waiting', {
          upstreamDispatched: false, ...(claim?.blockedUntil ? { blockedUntil: claim.blockedUntil } : {}),
        })
      }
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      if (this.admissionClock() >= deadline) throw concurrencyBusy('concurrency_queue_timeout')
      return entered
    } catch (cause) {
      if (entered) this.#leave(context.consumer.id, entered)
      const error = cause.code === 'external_platform_busy' ? concurrencyBusy(cause.details?.reason, {
        ...cause.details, platform, operation: delivery.operation,
        activeConcurrency: this.active, maxConcurrency: currentAdmissionLimits(this).maxConcurrency,
        consumerActiveConcurrency: this.activeByConsumer.get(context.consumer.id) || 0,
        maxConsumerConcurrency: currentAdmissionLimits(this).maxConsumerConcurrency,
        queueDepth: this.concurrencyQueue.entries.length, maxPending: policy.maxPending,
      }) : cause
      if (ownedSearchDelivery && error.code === 'external_platform_busy') {
        const causeText = error.details?.reason === 'concurrency_queue_full' ? '等待队列已满'
          : error.details?.reason === 'concurrency_queue_timeout' ? '等待并发名额超时' : '并发名额暂不可用'
        error.status = 503
        error.message = `Hub ${platform === 'twitter' ? 'Twitter' : 'Facebook'} 数据采集${causeText}，本次尚未发起采集，请稍后重试。`
        error.details = { ...error.details, admissionMode: 'bounded_wait', maxWaitMs: policy.maxWaitMs }
      }
      await this.platformStore.rejectWithoutDispatch({ delivery, sourceMode: 'unavailable',
        status: error.status || 503, errorCode: error.code || 'external_platform_unavailable' })
      throw error
    }
  }

  async #resolvedCredential() {
    if (!this.adapter) return { ready: false, credential: null }
    let credentialSnapshot = null
    if (typeof this.credentialStore?.readCredentialSnapshot === 'function') {
      try {
        credentialSnapshot = await this.credentialStore.readCredentialSnapshot(this.providerKey)
        if (credentialSnapshot.source === 'database') {
          return {
            ready: Boolean(credentialSnapshot.apiKey),
            credential: credentialSnapshot.apiKey,
            revision: credentialSnapshot.revision,
          }
        }
      } catch {
        this.logger?.warn?.('[external-platform] JustOne credential snapshot is unavailable')
        return { ready: false, credential: null, revision: null }
      }
    }
    if (typeof this.adapter.resolveCredential !== 'function') {
      return { ready: true, credential: undefined, revision: credentialSnapshot?.revision ?? null }
    }
    try {
      const credential = await this.adapter.resolveCredential()
      return {
        ready: Boolean(credential),
        credential,
        revision: credentialSnapshot?.revision ?? null,
      }
    } catch {
      this.logger?.warn?.('[external-platform] JustOne credential is unavailable')
      return { ready: false, credential: null, revision: credentialSnapshot?.revision ?? null }
    }
  }

  // The monthly procurement cap for one operation, as the gateway would apply
  // it. The price book bound to the operation wins over the deployment-level
  // billing config, exactly as it does when a call is dispatched -- otherwise
  // the console would report a cap that is not the one being enforced.
  async #operationBudget(operation) {
    if (typeof this.platformStore?.describeCostBudget !== 'function') return null
    // describeProvider reports the effective price book, having already chosen
    // between a database price book and the deployment billing the same way
    // dispatch does. Reading operation.billing here would silently fall back to
    // the deployment config and report a cap that is not the enforced one.
    const priceBook = operation?.priceBook
    if (!priceBook) return null
    try {
      return await this.platformStore.describeCostBudget({
        currency: priceBook.currency,
        monthlyBudgetMinor: priceBook.monthlyBudgetMinor,
      })
    } catch {
      // Diagnostics must never take the capabilities response down with them.
      return null
    }
  }

  async capabilities({ consumerId = null, credentialConfigured = null } = {}) {
    const credentialReady = typeof credentialConfigured === 'boolean'
      ? credentialConfigured
      : (await this.#resolvedCredential()).ready
    let ready = credentialReady
    // Operations under this platform are gated and priced independently, so one
    // platform-level flag cannot answer "may I call this". Each operation gets
    // its own row; the platform flag stays product search's readiness for
    // backward compatibility, and callers check the row that matches the call
    // they are about to make.
    let operationReadiness = {}
    if (this.operationControlStore) {
      try {
        const operations = await this.operationControlStore.describeProvider(this.providerKey, {
          config: this.config,
          credentialConfigured: credentialReady,
        })
        // The monthly procurement cap is only evaluated while dispatching, so
        // an operation can be perfectly ready and still refuse every call for
        // having spent its budget. Reported alongside readiness rather than
        // folded into it: a request that carries an enforced per-request charge
        // is exempt from the aggregate cap, so this blocks unbilled traffic
        // rather than the operation as such.
        const budgets = await Promise.all(operations.map((operation) => (
          this.#operationBudget(operation)
        )))
        operationReadiness = Object.fromEntries(operations.map((operation, index) => [
          operation.operationKey,
          {
            ready: credentialReady && operationReadyForConsumer(operation, consumerId),
            effectiveState: operation.effectiveState,
            budget: budgets[index],
          },
        ]))
        ready = operationReadiness[JUSTONE_OPERATION]?.ready ?? false
      } catch {
        this.logger?.warn?.('[external-platform] JustOne operation readiness is unavailable')
        ready = false
        operationReadiness = {}
      }
    }
    return {
      platform: AUTHORIZATION_PLATFORM,
      ready,
      source: 'hub',
      servingMode: 'live_with_stored_fallback',
      contractVersion: ECOMMERCE_PRODUCT_SEARCH_CONTRACT_VERSION,
      capabilities: ['product_search'],
      operations: operationReadiness,
      // Platform-shaped resources are advertised separately from the
      // normalized product-search contract so a caller can tell which of the
      // two layers it is looking at.
      resources: JUSTONE_RELEASED_RESOURCES.map((resource) => ({
        resourceKey: resource.resourceKey,
        operation: resource.operationKey,
        path: resource.hubPath,
        versions: [...resource.versions],
        defaultVersion: resource.defaultVersion,
        ready: operationReadiness[resource.operationKey]?.ready ?? false,
      })),
      marketplaces: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu', 'douyin_ec'],
      pagination: 'opaque_cursor',
      idempotencyKey: 'optional',
      deliveryModes: ['cache_only', 'cache_first', 'refresh', 'live_only'],
      freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
    }
  }

  async search(context, { body, idempotencyKey, retryOfRequestId, path, signal }) {
    let defaultAdapterId
    const normalize = ({ policy, codec }) => normalizeJustOneProductSearchRequest(body, {
      defaultAdapterId, decodeCursor: codec.decode, encodeCursor: codec.encode, maxPageSize: policy.maxPageSize,
    })
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, path, signal }, {
      operation: JUSTONE_OPERATION,
      capabilityMessage: 'E-commerce product search is not granted for this API key',
      normalize,
      resolveLiveRoute: async ({ normalized, policy, codec }) => {
        // Configuration only governs new acquisition. Saved responses, cache
        // reads and existing traversal cursors survive a default-route edit.
        if (!body.cursor) defaultAdapterId = await this.ecommerceRoutingStore?.select(normalized.marketplace)
        return normalize({ policy, codec })
      },
      dispatch: ({ policy, codec, credential }) => this.adapter.searchProducts(body, {
        defaultAdapterId,
        decodeCursor: codec.decode,
        encodeCursor: codec.encode,
        maxPageSize: policy.maxPageSize,
        ...credential,
      }),
    })
  }

  // Registry-declared resources (detail, reviews, questions, shop products)
  // reuse the whole delivery path: the same grants, quota reservation,
  // idempotency, snapshot policy, dispatch lease, cost reservation, circuit and
  // operation control. Only request validation and the adapter call differ,
  // which is what these two hooks carry.
  async fetchResource(context, { resourceKey, body, idempotencyKey, retryOfRequestId, path, signal }) {
    const resource = JUSTONE_RESOURCE_CATALOG[resourceKey]
    if (!resource?.released) {
      throw new AppError(404, 'unsupported_resource', 'This external resource is not available')
    }
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, path, signal }, {
      operation: resource.operationKey,
      capabilityMessage: `${resource.label} is not granted for this API key`,
      normalize: () => normalizeJustOneResourceRequest(resourceKey, body, {
        deliveryModes: ECOMMERCE_DELIVERY_MODES,
      }),
      dispatch: ({ credential }) => this.adapter.fetchResource(resourceKey, body, {
        deliveryModes: ECOMMERCE_DELIVERY_MODES,
        ...credential,
      }),
    })
  }

  // Keyword account search for the platforms this provider serves. The other
  // two platforms in this contract are served by TikHub and dispatch through
  // that gateway; the contract, canonical records and dataset are shared.
  async searchAccounts(context, { body, idempotencyKey, retryOfRequestId, path, signal }) {
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, path, signal }, {
      operation: SOCIAL_ACCOUNT_SEARCH_OPERATION,
      authorizationPlatform: SOCIAL_ACCOUNT_AUTHORIZATION_PLATFORM,
      capabilityMessage: 'Social account search is not granted for this API key',
      normalize: () => normalizeSocialAccountSearchRequest(body, {
        deliveryModes: ECOMMERCE_DELIVERY_MODES,
      }),
      dispatch: ({ credential }) => this.adapter.searchAccounts(body, {
        deliveryModes: ECOMMERCE_DELIVERY_MODES,
        ...credential,
      }),
    })
  }

  async hotXiaohongshuNotes(context, { body, idempotencyKey, path, signal }) {
    if (this.providerKey !== 'justone' || path !== XHS_DISCOVERY_ENDPOINTS.hot_notes.path) throw new AppError(404, 'not_found', 'Unknown discovery endpoint')
    if (!this.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Discovery operation requires reviewed runtime controls')
    // Purpose/Key separation keeps a cursor from crossing identities or products.
    const secret = createHash('sha256').update(this.apiKeyPepper).update(`\u0000xhs-hot-notes:${context.apiKey.id}\u0000`).digest('hex')
    const codec = createExternalPlatformCursorCodec(secret, context.consumer.id)
    return this.#deliver(context, { body, idempotencyKey, path, signal }, {
      operation: XHS_DISCOVERY_ENDPOINTS.hot_notes.operation, authorizationPlatform: 'xiaohongshu',
      capabilityMessage: 'Hot notes search is not granted for this API key', datasetId: 'social.posts.v1',
      replayReleasedFailures: true, skipIngest: true,
      normalize: () => normalizeXhsDiscoveryRequest('hot_notes', body, { decodeCursor: codec.decode }),
      dispatch: ({ credential }) => this.adapter.hotXiaohongshuNotes(body, { ...credential, decodeCursor: codec.decode, encodeCursor: codec.encode }),
    })
  }

  async forwardNative(context, { key, body, idempotencyKey, path, signal }) {
    const endpoint = nativeForwardingEndpoint(key)
    if (!endpoint || endpoint.provider !== this.providerKey || endpoint.hubPath !== path) {
      throw new AppError(404, 'native_endpoint_not_found', 'Unknown native data endpoint')
    }
    if (!this.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Native forwarding requires reviewed operation controls')
    return this.#deliver(context, { body, idempotencyKey, path, signal }, {
      operation: endpoint.operation, authorizationPlatform: endpoint.authorizationPlatform,
      capabilityMessage: 'This native data endpoint is not granted for this API key',
      skipIngest: true, replayReleasedFailures: true, nativeForwarding: true,
      billingFree: endpoint.key === 'wechat.demo.article-sample',
      allowZeroCost: endpoint.allowZeroCost === true,
      normalize: ({ policy }) => normalizeNativeForwardingRequest(key, body, { maxPageSize: Math.min(100, policy.maxPageSize) }),
      dispatch: ({ credential }) => this.adapter.forwardNative(key, body, credential),
    })
  }

  async socialAccountData(context, input) {
    // Preserve already-issued Twitter cursors and exact historical replay.
    // Only new traversals adopt the account manifest; old receipts are immutable.
    if (this.providerKey === 'rapidapi') {
      if (typeof input.body?.cursor === 'string' && input.body.cursor.startsWith('mxec2.')) return this.socialData(context, input)
      const saved = input.idempotencyKey && await this.usageStore.getUsageRequestByIdempotencyKey(context.consumer.id, input.idempotencyKey)
      if (saved && saved.apiKeyId === context.apiKey.id && saved.acquisitionRequest?.path === input.path) {
        let old
        try { old = normalizeHubSocialRequest(input.operation, input.body) } catch { /* New account aliases use the managed contract below. */ }
        if (old && saved.fingerprint === fingerprint({ method: 'POST', path: input.path, body: old.fingerprintBody })) return this.socialData(context, input)
        let current
        try { current = normalizeHubSocialCompatRequest(input.operation, input.body, { maxPageSize: 1000, businessId: context.consumer.businessId }) }
        catch { /* Historical IDs may exceed the current official limit. */ }
        const currentFingerprint = current && fingerprint({ method: 'POST', path: input.path, body: current.fingerprintBody })
        // Both previous identity contracts are receipt-only: the original
        // digits-as-ID interpretation and the later explicit-field handles.
        let historical
        for (const options of [{ legacyTwitterIdentity: true }, { twitterIdentityMode: 'explicit' }]) {
          try {
            const normalized = normalizeHubSocialCompatRequest(input.operation, input.body, {
              maxPageSize: 1000, businessId: context.consumer.businessId, ...options,
            })
            if (saved.fingerprint === fingerprint({ method: 'POST', path: input.path, body: normalized.fingerprintBody })) {
              historical = { normalized, options }
              break
            }
          } catch { /* An invalid former request cannot identify this receipt. */ }
        }
        const sameBody = saved.acquisitionRequest.body && canonicalJson(saved.acquisitionRequest.body) === canonicalJson(input.body)
        if (historical && !sameBody && saved.acquisitionRequest.body) {
          let original, originalHistorical
          try {
            original = normalizeHubSocialCompatRequest(input.operation, saved.acquisitionRequest.body, { maxPageSize: 1000, businessId: context.consumer.businessId })
            originalHistorical = normalizeHubSocialCompatRequest(input.operation, saved.acquisitionRequest.body, {
              maxPageSize: 1000, businessId: context.consumer.businessId, ...historical.options,
            })
          } catch { /* A changed body cannot reinterpret an old identity. */ }
          if (!original || !originalHistorical || !current
            || fingerprint({ method: 'POST', path: input.path, body: originalHistorical.fingerprintBody }) !== saved.fingerprint
            || fingerprint({ method: 'POST', path: input.path, body: original.fingerprintBody }) !== currentFingerprint) {
            throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was used with a different request')
          }
        }
        if (historical?.normalized.platform === 'twitter' && input.path === `/api/v1/data/social/${input.operation}`
          && sameBody && saved.fingerprint !== currentFingerprint) {
          const restart = () => { throw new AppError(409, 'search_restart_required', 'The saved request used the former Twitter identity interpretation; restart explicitly with a new Idempotency-Key and no cursor', { requestId: saved.id }) }
          const kind = saved.responseBody != null && (saved.status === 'committed' || saved.status === 'released' && saved.responseStatus >= 400 && saved.responseStatus <= 599)
            ? 'replay' : saved.status === 'reserved' ? 'in_progress' : saved.status === 'unknown' ? 'unknown' : null
          // Require the original body and its former fingerprint. Freeze only
          // this proven receipt; never reserve or dispatch a former identity,
          // even for a released row or an expired reservation.
          return this.#deliver(context, input, {
            operation: input.operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get', authorizationPlatform: 'twitter',
            capabilityMessage: 'This Hub account operation is not granted for this API key',
            reservation: { kind, request: saved }, historicalReceiptOnly: true,
            normalize: ({ policy }) => {
              const normalized = normalizeHubSocialCompatRequest(input.operation, input.body, {
                maxPageSize: policy.maxPageSize, businessId: context.consumer.businessId, ...historical.options,
              })
              const totalLimit = normalized.jobs.length * (input.operation === 'user-info' ? 1 : normalized.pageSize)
              if (totalLimit > policy.maxPageSize || totalLimit > 1000) throw new AppError(400, 'work_budget_exceeded', 'Account work exceeds this Key entitlement')
              if (!kind) restart()
              return { ...normalized, deliveryMode: 'live_only' }
            },
            assemble: restart,
          })
        }
      }
    }
    const capability = input.operation === 'crawl' ? 'social.content.crawl' : 'social.profile.get'
    const prepared = socialAccountPlan({ gateway: this, context, input, dependencies: {
      resolveCredential: () => this.#resolvedCredential(),
      revalidateIdentity: async ({ totalLimit }) => {
        const platform = prepared.plan.authorizationPlatform
        const current = await this.#revalidateWaitingIdentity(context, platform, { operation: capability })
        const policy = await this.usageStore.getPolicy(current.consumer.id, platform)
        const entitlement = await this.usageStore.getApiKeyPlatformEntitlement?.(current.apiKey.id, platform)
        if (totalLimit > Math.min(policy?.maxPageSize ?? this.defaultPolicy.maxPageSize,
          entitlement?.maxPageSize ?? this.defaultPolicy.maxPageSize)) throw new AppError(400, 'page_size_exceeded', 'Account work exceeds the current Key entitlement')
        context = current
        return current
      },
      enterCapacity: options => this.#enterOrQueue(context, { ...options, canWait: false }),
      leaveCapacity: admission => this.#leave(context.consumer.id, admission), providerCostControl,
    } })
    return this.#deliver(context, prepared.input, prepared.plan)
  }

  async youtubeComments(context, input) {
    const prepared = youtubeCommentsPlan({ gateway: this, context, input, dependencies: {
      resolveCredential: () => this.#resolvedCredential(),
      revalidateIdentity: async ({ totalLimit }) => {
        const current = await this.#revalidateWaitingIdentity(context, 'youtube', { operation: 'social.comments.list' })
        const policy = await this.usageStore.getPolicy(current.consumer.id, 'youtube')
        const entitlement = await this.usageStore.getApiKeyPlatformEntitlement?.(current.apiKey.id, 'youtube')
        if (totalLimit > Math.min(policy?.maxPageSize ?? this.defaultPolicy.maxPageSize,
          entitlement?.maxPageSize ?? this.defaultPolicy.maxPageSize)) throw new AppError(400, 'page_size_exceeded', 'Comment count exceeds the current Key entitlement')
        context = current
        return current
      },
      enterCapacity: options => this.#enterOrQueue(context, { ...options, canWait: false }),
      leaveCapacity: admission => this.#leave(context.consumer.id, admission), providerCostControl,
    } })
    return this.#deliver(context, prepared.input, prepared.plan)
  }

  async socialData(context, { operation, body, idempotencyKey, path, signal }) {
    const endpoint = HUB_SOCIAL_ENDPOINTS[operation]
    if (!endpoint || endpoint.path !== path || this.providerKey !== endpoint.provider) throw new AppError(404, 'not_found', 'Unknown Hub social endpoint')
    if (!this.operationControlStore) throw new AppError(503, 'external_platform_contract_unverified', 'Social data requires reviewed operation controls')
    const secret = createHash('sha256').update(this.apiKeyPepper).update(`\u0000hub-social:${context.apiKey.id}\u0000`).digest('hex')
    const codec = createExternalPlatformCursorCodec(secret, context.consumer.id)
    let normalized
    return this.#deliver(context, { body, idempotencyKey, path, signal }, {
      operation: endpoint.operation, authorizationPlatform: endpoint.platform,
      capabilityMessage: 'This Hub social operation is not granted for this API key',
      replayReleasedFailures: true, skipIngest: true, billingUnknown: true,
      normalize: ({ policy }) => (normalized = normalizeHubSocialRequest(operation, body, { maxPageSize: policy.maxPageSize, decodeCursor: codec.decode })),
      dispatch: ({ credential }) => this.adapter.execute(normalized, { ...credential, encodeCursor: codec.encode }),
    })
  }

  async searchContent(context, input, { finalizeXiaohongshu = null, assertSearchDispatchAllowed = null, twitterFallback = null } = {}) {
    const platform = input.normalized.platform
    const revalidateIdentity = async ({ operation, totalLimit }) => {
      const current = await this.#revalidateWaitingIdentity(context, platform, { platformSearch: true, operation,
        ...(platform === 'xiaohongshu' ? { requiredCapabilities: ['social.posts.search'] } : {}) })
      const policy = await this.usageStore.getPolicy(current.consumer.id, platform)
      const entitlement = await this.usageStore.getApiKeyPlatformEntitlement?.(current.apiKey.id, platform)
      if (totalLimit > Math.min(policy?.maxPageSize ?? this.defaultPolicy.maxPageSize,
        entitlement?.maxPageSize ?? this.defaultPolicy.maxPageSize)) throw new AppError(400, 'page_size_exceeded', 'Content-search work exceeds the current Key entitlement')
      context = current
      return current
    }
    const prepared = contentSearchPlan({ gateway: this, context, input, dependencies: {
      assertSearchDispatchAllowed: platform === 'twitter' && input.dataSearch ? assertSearchDispatchAllowed : null,
      inheritedTwitterLease: twitterFallback?.assertParentLease,
      firstCallOrdinal: twitterFallback ? 1 : 0,
      resolveCredential: () => this.#resolvedCredential(),
      revalidateIdentity,
      enterCapacity: options => this.#enterOrQueue(context, { ...options, canWait: false }),
      leaveCapacity: admission => this.#leave(context.consumer.id, admission), providerCostControl,
      finalizeResponse: platform === 'weibo' ? async ({ request, rowsByJob, responseBody, delivery, firstCallOrdinal, deadlineAt }) => {
        const rows = structuredClone(rowsByJob.flat())
        const credential = await this.#resolvedCredential()
        const result = await enrichWeiboRawSearch({ gateway: this, context,
          request: { enrichment: { enabled: true, all: false, maxItems: 20 } },
          result: { items: rows, publicBody: { data: { raw_info: '[]', raw_data: JSON.stringify(rows),
            page: { page: request.page, pageSize: request.pageSize, hasMore: responseBody.data.pageInfo.hasMore,
              nextCursor: responseBody.data.pageInfo.nextCursor }, status: 'ok', meta: {} } } },
          delivery, credential: { credential: credential.credential }, credentialRevision: credential.revision,
          providerCostControl, deadlineAt, firstCallOrdinal, ingestDetails: true,
          revalidateIdentity: () => revalidateIdentity({ operation: request.operation, totalLimit: request.totalLimit }) })
        result.publicBody.data.meta.upstreamCallCount = firstCallOrdinal + result.publicBody.data.meta.enrichment.detailUpstreamCalls
        const projected = projectDataSearch(result, request)
        projected.data.warnings = [...responseBody.data.warnings.filter(row => row.code !== 'body_completeness_unknown'), ...projected.data.warnings]
        projected.data.status = projected.data.warnings.length ? 'partial' : projected.data.status
        return { ...projected, requestId: delivery.usageRequestId }
      } : finalizeXiaohongshu,
    } })
    if (twitterFallback) {
      // Internal handoff only: the RapidAPI workflow still owns this reservation
      // and parent lease. Do not reserve, reap, quote or settle a second intent.
      if (platform !== 'twitter' || !input.dataSearch || input.normalized.cursor || input.retryOfRequestId) {
        throw new AppError(409, 'twitter_fallback_invalid', 'This search cannot switch suppliers')
      }
      const normalized = prepared.plan.normalize({ policy: { maxPageSize: input.normalized.pageSize } })
      if (fingerprint({ method: 'POST', path: prepared.input.path, body: normalized.fingerprintBody }) !== twitterFallback.delivery.fingerprint) {
        throw new AppError(409, 'idempotency_conflict', 'Search fallback must preserve the original request')
      }
      return prepared.plan.assemble({ delivery: { ...twitterFallback.delivery, operation: prepared.plan.operation },
        deadlineAt: twitterFallback.deadlineAt, signal: input.signal })
    }
    return this.#deliver(context, prepared.input, prepared.plan)
  }

  async searchRaw(context, input, { policyStore = null, gateways = null, reservation = null, selection = null, fallbackUsed = false, assertSearchDispatchAllowed = null, rejectedFallback = null } = {}) {
    const { normalized, body, idempotencyKey, retryOfRequestId, dataSearch = null, signal } = input
    const platform = normalized.platform
    if (retryOfRequestId != null && !(platform === 'twitter' && dataSearch)) {
      throw new AppError(400, 'invalid_uncertain_retry', 'Explicit Twitter retry requires the standard data search route')
    }
    const strategy = platform === 'instagram' && policyStore && gateways
    const codec = (dataSearch ? createDataSearchCursorCodec : createRawSearchCursorCodec)(this.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}`)
    const cursor = dataSearch ? normalized.cursor : normalized.upstreamBody?.cursor
    let pinnedProvider = null
    if (strategy && cursor) {
      // Only an authenticated Hub cursor can select a provider. Full query,
      // expiry and shape validation still runs in the receiving normalizer.
      try {
        const state = codec.decode(cursor)
        if (['justone', 'tikhub'].includes(state.provider)) pinnedProvider = state.provider
      } catch { /* Normalization reports invalid or retired cursors. */ }
    }
    const forward = (provider, reserved, usedFallback = fallbackUsed) => {
      if (!gateways?.[provider]) throw new AppError(503, 'strategy_search_route_unavailable', 'The selected search supplier is unavailable')
      return gateways[provider].searchRaw(context, input, { policyStore, gateways,
        reservation: reserved, selection, fallbackUsed: usedFallback })
    }
    if (pinnedProvider && pinnedProvider !== this.providerKey) return forward(pinnedProvider, reservation)
    const justOneInstagram = platform === 'instagram' && this.providerKey === 'justone'
    const instagramProjection = justOneInstagram ? projectJustOneInstagramSearch : projectInstagramSearch
    const nativeKey = platform === 'weibo' ? WEIBO_SEARCH_KEY : justOneInstagram ? JUSTONE_INSTAGRAM_SEARCH_KEY : INSTAGRAM_SEARCH_KEY
    const native = platform !== 'twitter'
    if (!this.operationControlStore || !['weibo', 'twitter', 'instagram'].includes(platform)
      || this.providerKey !== (justOneInstagram ? 'justone' : native ? 'tikhub' : 'rapidapi')) {
      throw new AppError(503, 'raw_search_unavailable', 'Hub raw search is unavailable')
    }
    let request
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, signal, path: dataSearch ? '/api/v1/data/search' : RAW_SEARCH_PATH }, {
      operation: native ? `native.${nativeKey}` : 'social.content.search',
      authorizationPlatform: platform, platformSearch: true, meterKey: dataSearch ? platform : 'raw',
      datasetId: dataSearch ? 'night-all.search.v1' : RAW_SEARCH_DATASET, replayReleasedFailures: true,
      replayWindowMs: dataSearch?.replayWindowMs,
      dataSearch: Boolean(dataSearch), nativeForwarding: native, billingUnknown: !native,
      twitterManualRetry: platform === 'twitter' && Boolean(dataSearch),
      acknowledgedRequestIds: platform === 'twitter' && dataSearch ? input.acknowledgedRequestIds || [] : [],
      reservation,
      normalize: ({ policy }) => {
        const historicalCodec = createNightAllCompatibilityCursorCodec(this.apiKeyPepper, context.consumer.id)
        const options = { instagramProvider: justOneInstagram ? 'justone' : 'tikhub', instagramStrategy: Boolean(strategy), historicalCodec,
          twitterSearchParameters: input.twitterSearchParameters }
        request = dataSearch ? normalizeHubDataSearch(normalized, codec, dataSearch.resultType,
          historicalCodec, options) : normalizeRawSearch(normalized, codec, options)
        if (request.pageSize > policy.maxPageSize) throw new AppError(400, 'page_size_exceeded', 'Page size exceeds the Key entitlement')
        return request
      },
      route: async reserved => {
        if (request.restartRequired) throw new AppError(409, 'search_restart_required',
          platform === 'instagram'
            ? 'Instagram search now uses a different provider; restart from page 1 with a new Idempotency-Key. Historical cursors cannot be continued.'
            : 'Twitter search now runs in Hub; restart from page 1 with a new Idempotency-Key. Historical Night-All cursors cannot be continued.')
        if (strategy) {
          selection ||= await policyStore.get('search', 'instagram')
          if (selection.mode === 'paused') throw new AppError(503, 'strategy_search_paused', 'Instagram search is paused')
          if (!pinnedProvider && !fallbackUsed && selection.primaryProvider !== this.providerKey) {
            return { result: await forward(selection.primaryProvider, reserved) }
          }
        }
        return null
      },
      revalidateDispatch: strategy ? async () => {
        if ((await policyStore.get('search', 'instagram')).mode === 'paused') {
          throw new AppError(503, 'strategy_search_paused', 'Instagram search is paused')
        }
      } : null,
      // Priority applies only before the first supplier dispatch. An upstream
      // rejection, unknown result or paid unusable response never retries here.
      unavailable: strategy ? async (reserved, availability) => {
        if (pinnedProvider || cursor || fallbackUsed || selection?.mode !== 'priority'
          || !availability?.safeToFallback) return null
        const latest = await policyStore.get('search', 'instagram')
        if (latest.mode === 'paused') throw new AppError(503, 'strategy_search_paused', 'Instagram search is paused')
        if (latest.revision !== selection.revision) return null
        let ownsFallbackLease = false
        if (!availability.dispatchLeaseHeld) {
          // Provider/circuit readiness is checked before the ordinary dispatch
          // lease. Preserve its equal-request unknown/quarantine guard even
          // when a different supplier would otherwise be ready to run.
          const lease = await this.platformStore.acquireDispatchLease(availability.dispatchLease)
          ownsFallbackLease = lease === true || lease?.kind === 'acquired'
          if (!ownsFallbackLease) {
            const code = lease?.kind === 'blocked' && lease.reason === 'unknown' ? 'request_outcome_unknown'
              : lease?.kind === 'blocked' && lease.reason === 'succeeded_unusable' ? 'external_platform_response_unusable'
                : 'request_in_progress'
            throw new AppError(409, code, 'An equal search is pending or has an unresolved result; supplier fallback is blocked',
              { upstreamDispatched: false, blockedUntil: lease?.blockedUntil || null })
          }
        }
        try { return { result: await forward(selection.fallbackProvider, reserved, true) } }
        finally {
          if (ownsFallbackLease) await this.platformStore.releaseDispatchLease(availability.dispatchLease).catch(() => {
            this.logger?.warn?.('[external-platform] search fallback lease release is unavailable')
          })
        }
      } : null,
      assemble: platform === 'twitter' && dataSearch ? async ({ delivery, deadlineAt, signal }) => {
        if (request.restartRequired) throw new AppError(409, 'search_restart_required',
          'Twitter search now runs in Hub; restart from page 1 with a new Idempotency-Key.')
        return runTwitterSearchFill({ gateway: this, context, delivery, request, deadlineAt, signal,
          assertSearchDispatchAllowed, rejectedFallback,
          resolveCredential: () => this.#resolvedCredential(),
          revalidateIdentity: async () => {
            const current = await this.#revalidateWaitingIdentity(context, 'twitter', {
              platformSearch: true, operation: 'social.content.search' })
            const currentPolicy = await this.usageStore.getPolicy(context.consumer.id, 'twitter')
            const entitlement = await this.usageStore.getApiKeyPlatformEntitlement?.(context.apiKey.id, 'twitter')
            const maxPageSize = Math.min(currentPolicy?.maxPageSize ?? this.defaultPolicy.maxPageSize,
              entitlement?.maxPageSize ?? this.defaultPolicy.maxPageSize)
            if (request.pageSize > maxPageSize) throw new AppError(400, 'page_size_exceeded', 'Page size exceeds the Key entitlement')
            context = current
            return current
          },
          enterCapacity: options => this.#enterOrQueue(context, { ...options, delivery, platform: 'twitter' }),
          leaveCapacity: admission => this.#leave(context.consumer.id, admission), providerCostControl,
          projectDelivery: input => projectTwitterSearchFillDelivery(input, request),
        })
      } : null,
      buffered: async () => {
        // Historical responses replay before this hook. Never interpret a
        // retired TikHub buffer or continuation using the JustOne contract.
        if (request.restartRequired || !request.buffer) return null
        const archived = await this.platformStore.instagramPageFor({ callId: request.buffer.callId,
          tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id,
          path: dataSearch ? '/api/v1/data/search' : RAW_SEARCH_PATH })
        if (!archived) throw new AppError(409, 'search_page_unavailable', 'The saved search page is unavailable; restart explicitly with a new Idempotency-Key')
        let result
        try { result = instagramProjection(archived, request) }
        catch { throw new AppError(409, 'search_page_unavailable', 'The saved search page no longer matches this cursor; restart explicitly with a new Idempotency-Key') }
        if (dataSearch) result.publicBody = { ...projectDataSearch(result, request), meta: result.publicBody.meta }
        return { result, sourceCallId: request.buffer.callId }
      },
      dispatch: ({ credential }) => native
        ? this.adapter.forwardNative(nativeKey, { params: request.upstreamQuery }, credential)
        : this.adapter.execute(request.providerRequest, { ...credential, encodeCursor: request.encodeNext }),
      finalize: async ({ result, delivery, callId, credential, credentialRevision, deadlineAt }) => {
        if (native) {
          if (platform === 'instagram') request.archiveCallId = callId
          try {
            const receipt = result.restrictedResponseArchive
            result = (platform === 'weibo' ? projectWeiboSearch : instagramProjection)(result, request)
            if (result.acquiredItems?.length > request.pageSize
              && (!receipt || receipt.bodySize > 8388608)) {
              throw new Error('instagram_page_archive_required')
            }
          }
          catch (error) {
            const reasons = platform === 'weibo' ? ['invalid_weibo_search_shape',
              'invalid_weibo_identity', 'weibo_page_exceeds_requested_count'] : [
              'invalid_instagram_search_shape', 'invalid_instagram_media_grid', 'invalid_instagram_post_identity',
              'instagram_page_exceeds_requested_count', 'invalid_instagram_continuation',
              'invalid_instagram_pagination', 'missing_instagram_continuation', 'instagram_page_archive_required',
            ]
            // Retain only known contract reasons, never arbitrary provider values or exception text.
            const normalizationCode = reasons.includes(error.message)
              ? error.message : `invalid_${platform}_search_contract`
            const evidence = {
              outcome: 'succeeded_unusable', billed: true, httpStatus: 200, businessCode: justOneInstagram ? 0 : 200,
              errorCode: normalizationCode,
            }
            if (justOneInstagram) throw new JustOneSucceededUnusableError(evidence, result.archiveObjects, result.restrictedResponseArchive)
            throw new TikHubUpstreamError('Social search response could not be normalized', evidence, result)
          }
          if (platform === 'weibo') result = await enrichWeiboRawSearch({ gateway: this, context, request, result, delivery,
            credential, credentialRevision, providerCostControl, deadlineAt })
        }
        // Ingest the whole paid page once, including buffered records. Later
        // deliveries reuse its receipt and never create another acquisition.
        const acquired = result.acquiredItems ? { ...result.publicBody, data: { ...result.publicBody.data,
          raw_data: JSON.stringify(result.acquiredItems) } } : result.publicBody
        result.records = rawSearchRecords(acquired, platform, this.providerKey)
        if (dataSearch) result.publicBody = { ...projectDataSearch(result, request), meta: result.publicBody.meta }
        return result
      },
    })
  }

  async searchFacebook(context, input, { policyStore, fallbackGateway, reservation = null, request: previousRequest = null, attempt = 0, providerCalls = 0 } = {}) {
    const { normalized, body, idempotencyKey, dataSearch = null, signal } = input
    const codec = (dataSearch ? createDataSearchCursorCodec : createRawSearchCursorCodec)(this.apiKeyPepper, `${context.consumer.id}:${context.apiKey.id}`)
    const request = previousRequest || normalizeFacebookSearch(normalized, codec, dataSearch)
    const rapid = this.providerKey === 'rapidapi'
    const providerRequest = request.forProvider(this.providerKey)
    let admission = null, observationFailed = false, observationComplete = false
    const observe = async quota => {
      if (observationFailed || observationComplete) return
      try {
        await policyStore.observeRapid(admission, quota)
        // A completed observation already releases this admission token. Do
        // not open another transaction from finally for the same receipt.
        observationComplete = Boolean(admission?.token)
      }
      catch {
        // The supplier receipt is already authoritative. A quota-store fault
        // must not erase it, retry a paid call, or release an uncertain lease.
        observationFailed = true
        this.logger?.warn?.('[external-platform] Facebook quota observation is unavailable; admission remains reserved until expiry')
      }
    }
    const next = async (reserved, previousCalls = 0) => {
      if (!rapid || !fallbackGateway) throw new AppError(503, 'facebook_search_unavailable', 'Facebook search is unavailable')
      if (request.provider) throw new AppError(409, 'search_restart_required', 'This search continuation is temporarily unavailable; restart from page 1 with a new Idempotency-Key')
      return fallbackGateway.searchFacebook(context, input, { policyStore, reservation: reserved, request, attempt: attempt + 1, providerCalls: previousCalls })
    }
    return this.#deliver(context, { body, idempotencyKey, signal, path: dataSearch ? '/api/v1/data/search' : RAW_SEARCH_PATH }, {
      operation: dataSearch || rapid ? FACEBOOK_OPERATION.operationKey : `native.${FACEBOOK_JUSTONE_KEY}`,
      authorizationPlatform: 'facebook', platformSearch: true, meterKey: dataSearch ? 'facebook' : 'raw',
      datasetId: dataSearch ? 'night-all.search.v1' : RAW_SEARCH_DATASET, replayReleasedFailures: true,
      replayWindowMs: dataSearch?.replayWindowMs, dataSearch: Boolean(dataSearch), billingUnknown: rapid, allowZeroCost: rapid,
      reservation, callOrdinal: attempt,
      normalize: ({ policy }) => {
        if (request.pageSize > policy.maxPageSize) throw new AppError(400, 'page_size_exceeded', 'Page size exceeds the Key entitlement')
        return { ...providerRequest, ...request }
      },
      assemble: dataSearch ? ({ delivery, deadlineAt, signal }) => {
        if (!rapid) throw new AppError(503, 'facebook_search_unavailable', 'The Facebook standard search coordinator is unavailable')
        const gateways = { rapidapi: this, ...(fallbackGateway ? { justone: fallbackGateway } : {}) }
        return runFacebookSearchFill({ gateway: this, gateways, context, delivery, request, policyStore, deadlineAt, signal,
          resolveCredential: provider => gateways[provider].#resolvedCredential(),
          enterCapacity: (provider, options) => gateways[provider].#enterOrQueue(context,
            { ...options, delivery, platform: 'facebook' }),
          leaveCapacity: (provider, admission) => gateways[provider].#leave(context.consumer.id, admission),
          revalidateIdentity: async () => {
            const current = await this.#revalidateWaitingIdentity(context, 'facebook', {
              platformSearch: true, operation: FACEBOOK_OPERATION.operationKey })
            const currentPolicy = await this.usageStore.getPolicy(context.consumer.id, 'facebook')
            const entitlement = await this.usageStore.getApiKeyPlatformEntitlement?.(context.apiKey.id, 'facebook')
            if (request.pageSize > Math.min(currentPolicy?.maxPageSize ?? this.defaultPolicy.maxPageSize,
              entitlement?.maxPageSize ?? this.defaultPolicy.maxPageSize)) {
              throw new AppError(400, 'page_size_exceeded', 'Page size exceeds the Key entitlement')
            }
            context = current
            return current
          }, providerCostControl, persistedCallEvidence, publicFailure,
        })
      } : null,
      // Called only after idempotent replay and authorization, never on a replay.
      route: async reserved => {
        const policy = await policyStore.facebook()
        if (policy.mode === 'paused') throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused')
        if (rapid && (request.provider === 'justone' || (!request.provider && policy.mode === 'justone'))) {
          return { result: await fallbackGateway.searchFacebook(context, input, { policyStore, reservation: reserved, request, attempt }) }
        }
        return null
      },
      revalidateDispatch: async () => {
        if ((await policyStore.facebook()).mode === 'paused') {
          throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused')
        }
      },
      unavailable: rapid ? async reserved => {
        const policy = await policyStore.facebook()
        return policy.mode === 'auto' && !request.provider ? { result: await next(reserved) } : null
      } : null,
      admit: rapid ? async (reserved, { revalidate, delivery, deadlineAt }) => {
        admission = await waitForFacebookRapidAdmission({ policyStore, rateLimitExempt: () => isHubRateLimitExempt(context), requestId: delivery.usageRequestId,
          deadlineAt, timeoutMs: this.config.timeoutMs || 30000, signal, revalidate, logger: this.logger })
        if (admission.allowed) return null
        const policy = await policyStore.facebook()
        if (policy.mode === 'paused') throw new AppError(503, 'facebook_search_paused', 'Facebook search is paused')
        if (policy.mode === 'auto') return { result: await next(reserved) }
        throw new AppError(503, 'facebook_search_capacity_unavailable', 'Search capacity is temporarily unavailable')
      } : null,
      dispatch: async ({ credential }) => {
        try {
          let result = rapid ? await this.adapter.execute({ ...request, ...providerRequest }, credential)
            : await this.adapter.forwardNative(FACEBOOK_JUSTONE_KEY, { params: providerRequest.upstreamQuery }, credential)
          if (rapid) await observe(result.quota)
          else {
            try { result = { ...result, restrictedResponseArchive: result.restrictedResponseArchive,
              archiveObjects: facebookJustOneArchives(result.archiveObjects, providerRequest.endpointVersion),
              ...projectFacebookSearch(result.publicBody.data, request, 'justone', result.publicBody.meta.capturedAt) } }
            catch { throw new JustOneUpstreamError('JustOneSucceededUnusableError', 'Facebook response could not be normalized', {
              outcome: 'succeeded_unusable', billed: true, httpStatus: 200, businessCode: 0, errorCode: 'invalid_facebook_response',
            }, result.archiveObjects, result.restrictedResponseArchive) }
          }
          return result
        } catch (error) {
          if (rapid) await observe(error.evidence?.quota)
          else if (error instanceof JustOneUpstreamError) throw new JustOneUpstreamError(error.name, error.message,
            error.evidence, facebookJustOneArchives(error.archiveObjects, providerRequest.endpointVersion), error.restrictedResponseArchive)
          throw error
        }
      },
      retryRejected: rapid ? async ({ error, reserved, settle }) => {
        if (error.evidence?.httpStatus !== 429 || error.evidence?.outcome !== 'rejected') return null
        const policy = await policyStore.facebook()
        if (policy.mode !== 'auto' || request.provider) return null
        await settle()
        return { result: await next(reserved, 1) }
      } : null,
      cleanup: rapid ? () => observe() : null,
      costUnknown: () => admission?.probe === true,
      finalize: ({ result }) => {
        result.publicBody.data.meta.upstreamCallCount = providerCalls + 1
        result.records = rawSearchRecords(result.publicBody, 'facebook', this.providerKey, { projectionVersion: request.projectionVersion })
        if (dataSearch) result.publicBody = { ...projectDataSearch(result, request), meta: result.publicBody.meta }
        return result
      },
    })
  }

  async webSearch(context, { request, provider, body, idempotencyKey, path, signal }) {
    if (!this.operationControlStore) throw new AppError(503, 'web_search_unavailable', 'Search controls are unavailable')
    let normalized
    return this.#deliver(context, { body, idempotencyKey, path, signal }, {
      operation: 'web.search', authorizationPlatform: 'web_search',
      capabilityMessage: 'Web Search is not granted for this Key',
      requiredCapabilities: [provider.capability], replayReleasedFailures: true, skipIngest: true, billingUnknown: true,
      normalize: ({policy}) => (normalized = gatewayWebSearchRequest(request, provider, policy.maxPageSize)),
      dispatch: ({credential}) => this.adapter.execute(normalized, credential),
    })
  }

  async nativeReadiness({ consumerId, operationKeys, credentialConfigured }) {
    if (!this.operationControlStore) return {}
    const credentialReady = typeof credentialConfigured === 'boolean'
      ? credentialConfigured : (await this.#resolvedCredential()).ready
    const rows = await this.operationControlStore.describeProvider(this.providerKey, {
      config: { ...this.config, reservationLeaseMs: this.reservationLeaseMs }, credentialConfigured: credentialReady,
    })
    return Object.fromEntries(rows.filter(row => operationKeys.includes(row.operationKey))
      .map(row => [row.operationKey, credentialReady && operationReadyForConsumer(row, consumerId)]))
  }

  async queryEnterprise(context, { apiId, body, idempotencyKey, path, signal }) {
    if (this.providerKey !== 'qixin') throw new AppError(404, 'enterprise_api_not_found', 'Unknown enterprise API')
    assertEnterpriseCallable(apiId)
    const request = normalizeEnterpriseRequest(apiId, body)
    return this.#deliver(context, { body, idempotencyKey, path, signal }, {
      operation: enterpriseOperation(apiId), capability: ENTERPRISE_CAPABILITY,
      authorizationPlatform: 'enterprise', datasetId: ENTERPRISE_DATASET,
      capabilityMessage: 'Enterprise queries are not granted for this API key',
      allowZeroCost: request.api.price === 0, billingUnknown: true,
      normalize: () => request,
      dispatch: ({ credential }) => this.adapter.query(apiId, body, credential),
    })
  }

  async #deliver(context, { body, idempotencyKey, retryOfRequestId, path, signal }, plan) {
    // Operations under this provider do not all sit in the same data domain:
    // product search is `ecommerce`, account search is `social`. Grants, quota
    // policy, key entitlement and usage scope all follow the operation's own
    // domain rather than one provider-wide constant.
    const authorizationPlatform = plan.authorizationPlatform || AUTHORIZATION_PLATFORM
    let durableRequestId = null
    let ownsReservation = false
    try {
    // `test` is currently issuance metadata, not an isolated no-cost
    // environment. Enforce this at the last trusted boundary before grants,
    // quota reservation, cache lookup or provider dispatch so a browser or
    // direct HTTP client cannot turn a legacy Test key into a provider
    // dispatch that may consume quota or internal procurement cost.
    if (
      context.apiKey?.environment === 'test'
      || context.apiKey?.prefix?.startsWith('mih_test_')
    ) {
      throw new AppError(
        403,
        'test_key_not_supported',
        'Test API keys cannot dispatch external ecommerce acquisition',
      )
    }
    const grants = typeof this.usageStore.listEffectiveGrants === 'function'
      ? await this.usageStore.listEffectiveGrants(context.consumer.id, context.apiKey.id)
      : await this.usageStore.listGrants(context.consumer.id)
    if (!grants.includes(authorizationPlatform)) {
      throw new AppError(403, 'platform_not_granted', 'E-commerce data is not granted')
    }
    const capabilityGrants = typeof this.usageStore.listEffectiveCapabilityGrants === 'function'
      ? await this.usageStore.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
      : await this.usageStore.listCapabilityGrants(context.consumer.id)
    if (!plan.platformSearch && !capabilityGrants.includes(plan.capability || plan.operation)) {
      throw new AppError(403, 'capability_not_granted', plan.capabilityMessage)
    }
    if ((plan.requiredCapabilities || []).some(scope => !capabilityGrants.includes(scope))) throw new AppError(403, 'web_search_provider_not_granted', 'Search supplier is not granted')
    const consumerPolicy = {
      ...this.defaultPolicy,
      ...((await this.usageStore.getPolicy(context.consumer.id, authorizationPlatform)) || {}),
    }
    const keyEntitlement = typeof this.usageStore.getApiKeyPlatformEntitlement === 'function'
      ? await this.usageStore.getApiKeyPlatformEntitlement(context.apiKey.id, authorizationPlatform)
      : null
    let policy = {
      ...consumerPolicy,
      maxPageSize: keyEntitlement
        ? Math.min(consumerPolicy.maxPageSize, keyEntitlement.maxPageSize)
        : consumerPolicy.maxPageSize,
    }
    const codec = createExternalPlatformCursorCodec(this.apiKeyPepper, context.consumer.id)
    let normalized
    try {
      normalized = plan.normalize({ body, policy, codec })
    } catch (error) {
      // Every request contract dispatched through this path reports a caller
      // mistake as a 400. A contract added later that is not listed here would
      // surface as a 500, so the check names the family rather than one class.
      if (error instanceof JustOneContractError || error instanceof SocialAccountContractError) {
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
    if (['refresh', 'live_only'].includes(normalized.deliveryMode) && !suppliedKey) {
      throw new AppError(
        400,
        'idempotency_key_required',
        `Idempotency-Key is required when deliveryMode is ${normalized.deliveryMode}`,
      )
    }
    if (!plan.historicalReceiptOnly) {
      await requestMaintenance(this.usageStore)
      await requestMaintenance(this.platformStore, 'reapStaleCalls')
    }

    let validatedRetryOfRequestId = null
    if (retryOfRequestId != null) {
      if (
        typeof retryOfRequestId !== 'string'
        || !UUID_PATTERN.test(retryOfRequestId.trim())
        || (plan.twitterManualRetry ? !suppliedKey || normalized.restartRequired : normalized.deliveryMode !== 'refresh')
      ) {
        throw new AppError(
          400,
          'invalid_uncertain_retry',
          plan.twitterManualRetry ? 'Twitter retry requires a request UUID, current standard search and a new Idempotency-Key'
            : 'X-MX-Insight-Retry-Of requires a request UUID and deliveryMode refresh',
        )
      }
      const candidateId = retryOfRequestId.trim()
      if (plan.twitterManualRetry) {
        // Validate durable ownership after ordinary idempotency handling so an
        // acknowledged successor can replay its immutable saved response.
        validatedRetryOfRequestId = candidateId
      } else {
        const previous = await this.usageStore.getUsageRequestForRetry(candidateId, context.consumer.id)
        if (
          !previous
          || previous.status !== 'unknown'
          || previous.platform !== authorizationPlatform
          || previous.fingerprint !== requestFingerprint
          || previous.idempotencyKey === idempotencyKey
        ) {
          throw new AppError(
            409,
            'uncertain_retry_not_allowed',
            'The referenced uncertain request cannot authorize this retry',
          )
        }
        validatedRetryOfRequestId = candidateId
      }
    }
    const requestId = randomUUID()
    const effectiveKey = suppliedKey
      ? idempotencyKey
      : `auto:${context.apiKey.id}:${requestId}`
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    let replayWindowMs = plan.replayWindowMs ?? null
    if (plan.twitterManualRetry && suppliedKey) {
      const previous = await this.usageStore.getUsageRequestByIdempotencyKey(context.consumer.id, idempotencyKey)
      if (validatedRetryOfRequestId || previous && await this.platformStore.twitterManualRetryOriginalFor(previous.id)) replayWindowMs = null
    }
    const reservation = plan.reservation || await this.usageStore.reserve({
      requestId,
      idempotencyKey: effectiveKey,
      fingerprint: requestFingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: authorizationPlatform,
      meterKey: plan.meterKey || plan.operation,
      acquisitionRequest: plan.searchProvider || normalized.twitterSearchParameters ? { ...acquisitionRequestSnapshot({ method: 'POST', path, body }),
        ...(normalized.twitterSearchParameters ? { twitterSearchParameters: normalized.twitterSearchParameters } : {}),
        // Trusted internal route evidence is recorded with the reservation,
        // before credentials, admission or HTTP. It is not a caller field and
        // does not alter the original fingerprint or historical replay body.
        ...(plan.searchProvider ? { searchProvider: plan.searchProvider, searchContractVersion: plan.searchContractVersion } : {}),
      } : acquisitionRequestSnapshot({ method: 'POST', path, body }),
      requiredAuthorizationScopes: [
        { type: 'platform', key: authorizationPlatform },
        ...(!plan.platformSearch ? [{ type: 'capability', key: plan.capability || plan.operation }] : []),
        ...(plan.requiredCapabilities || []).map(key => ({type:'capability',key})),
      ],
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      // A caller-supplied key names one immutable delivery attempt. An omitted
      // key means this HTTP call is a new billable intent; only explicit key
      // reuse is idempotent.
      replayWindowMs,
      // A definitive enterprise rejection releases the wallet hold, but the
      // same caller intent must still replay its saved error without dispatch.
      replayReleasedFailures: this.providerKey === 'qixin' || plan.replayReleasedFailures === true,
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
      apiKeyId: context.apiKey.id,
      usageRequestId: reservation.request.id,
      operation: plan.operation,
      fingerprint: requestFingerprint,
      ...(plan.acknowledgedRequestIds?.length ? { acknowledgedRequestIds:plan.acknowledgedRequestIds } : {}),
    }
    if (plan.twitterManualRetry && validatedRetryOfRequestId && reservation.kind !== 'reserved') {
      const owner = await this.platformStore.twitterManualRetryOwnerFor(validatedRetryOfRequestId)
      if (owner !== delivery.usageRequestId && !(reservation.kind === 'in_progress' && owner == null)) throw new AppError(409, 'uncertain_retry_not_allowed',
        'This Idempotency-Key does not identify the acknowledged Twitter retry')
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
      // The Idempotency-Key identifies the already delivered HTTP body. Replay
      // metadata belongs in the transport/result fields below; rewriting body
      // timestamps or sourceMode would make the durable response non-exact.
      const responseBody = structuredClone(base)
      await this.platformStore.recordReplay({ delivery, sourceMode: 'idempotent_replay' }).catch((error) => {
        this.logger?.warn?.(`[external-platform] replay evidence unavailable: ${error.message}`)
      })
      return resultFromBody(responseBody, {
        requestId: reservation.request.id,
        replay: true,
        sourceMode: 'idempotent_replay',
        capturedAt,
        originSourceMode: reservation.request.deliverySourceMode,
      })
    }

    const activeRequestId = reservation.request.id
    if (plan.twitterManualRetry && validatedRetryOfRequestId) {
      delivery.twitterManualRetry = { retryOfRequestId: validatedRetryOfRequestId,
        ...(normalized.buffer ? { bufferCallId: normalized.buffer.callId } : {}) }
      await this.platformStore.validateTwitterManualRetry({ ...delivery, ...delivery.twitterManualRetry, idempotencyKey })
    }
    if (plan.assemble) {
      try {
        const assembled = await plan.assemble({ delivery, signal,
          deadlineAt: new Date(reservation.request.leaseExpiresAt).getTime() || Date.now() + this.reservationLeaseMs })
        ownsReservation = false
        return assembled
      } catch (error) {
        // The workflow may retain its lease while an unknown write cannot be
        // confirmed. Leave that original customer hold for durable recovery;
        // an unrelated prior-unknown admission still releases its new hold.
        if (error.preserveReservation === true) ownsReservation = false
        // A transport correlation ID does not identify the durable usage row.
        // Keep an explicit ledger ID for read-only outcome checks after errors.
        if (error instanceof AppError) error.details = { ...error.details,
          requestId: error.details?.requestId || delivery.usageRequestId }
        throw error
      }
    }
    if (plan.buffered) {
      const buffered = await plan.buffered()
      if (buffered) {
        const { result, sourceCallId } = buffered
        const capturedAt = acceptedCaptureTime(result)
        const sourceMode = Date.now() - capturedAt.getTime() <= this.config.freshTtlMs ? 'fresh_cache' : 'stored_fallback'
        const responseBody = plan.dataSearch ? { data: result.publicBody.data, requestId: activeRequestId }
          : deliveryBody(result.publicBody, { requestId: activeRequestId, sourceMode, capturedAt,
            ...(sourceMode === 'stored_fallback' ? { fallbackReason: 'pagination_buffer' } : {}) })
        await this.platformStore.commitInstagramPage({ delivery, sourceCallId, sourceMode, responseBody, capturedAt,
          usageUnitsActual: plan.dataSearch ? result.items.length : 1 })
        return resultFromBody(responseBody, { requestId: activeRequestId, replay: false, sourceMode, capturedAt })
      }
    }
    if (plan.route) {
      const routed = await plan.route(reservation)
      if (routed) { ownsReservation = false; return routed.result }
    }
    const now = new Date()
    let snapshot = await this.platformStore.snapshotFor({
      consumerId: context.consumer.id,
      operation: plan.operation,
      fingerprint: requestFingerprint,
    }, now)
    // `live_only` asks for a fresh upstream read or an explanation, never stored
    // data. Each fallback below therefore asks whether serving stored data is
    // permitted, not merely whether a snapshot happens to exist.
    const allowStoredFallback = normalized.deliveryMode !== 'live_only'
    const snapshotIsFresh = snapshot && new Date(snapshot.freshUntil) >= now
    if (
      snapshot
      && (
        normalized.deliveryMode === 'cache_only'
        || (normalized.deliveryMode === 'cache_first' && snapshotIsFresh)
      )
    ) {
      const sourceMode = snapshotIsFresh ? 'fresh_cache' : 'stored_fallback'
      const responseBody = deliveryBody(snapshot.responseBody, {
        requestId: activeRequestId,
        sourceMode,
        capturedAt: snapshot.capturedAt,
        ...(snapshotIsFresh ? {} : { fallbackReason: 'cache_only' }),
      })
      await this.platformStore.commitSnapshotDelivery({
        delivery,
        snapshot,
        sourceMode,
        responseBody,
      })
      return resultFromBody(responseBody, {
        requestId: activeRequestId,
        replay: false,
        sourceMode,
        capturedAt: snapshot.capturedAt,
      })
    }
    if (normalized.deliveryMode === 'cache_only') {
      await this.platformStore.rejectWithoutDispatch({
        delivery,
        sourceMode: 'unavailable',
        status: 404,
        errorCode: 'stored_snapshot_not_found',
      })
      throw new AppError(404, 'stored_snapshot_not_found', 'No stored result matches this request')
    }

    if (plan.resolveLiveRoute) normalized = await plan.resolveLiveRoute({ normalized, policy, codec })
    const sharedState = await this.platformStore.providerState(this.providerKey)
    const state = (this.providerKey === 'tikhub' || isHubRateLimitExempt(context)) ? internalCircuitState(this.usageStore, context, sharedState) : sharedState
    // Two breakers: the provider-wide one for upstream faults, and this
    // marketplace's own for responses the Hub could not normalize. A gap in our
    // contract for one marketplace must not suspend live dispatch for the rest.
    const contractCircuit = typeof this.platformStore.contractCircuitState === 'function'
      ? await this.platformStore.contractCircuitState(this.providerKey, normalized.marketplace ?? null)
      : null
    const circuitOpen = Boolean(
      (state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now)
      || (contractCircuit?.circuitOpenUntil && new Date(contractCircuit.circuitOpenUntil) > now),
    )
    let resolvedCredential = circuitOpen
      ? { ready: Boolean(this.adapter), credential: null, revision: null }
      : await this.#resolvedCredential()
    let operationControl = null
    let operationControlError = null
    if (!circuitOpen && this.operationControlStore) {
      try {
        // This authoritative read is intentionally at the live-dispatch
        // boundary: cache delivery remains available while a provider is
        // paused, and an admitted in-flight call keeps this immutable revision.
        operationControl = await this.operationControlStore.authorizeDispatch(
          this.providerKey,
          plan.operation,
          {
            consumerId: context.consumer.id,
            config: this.config,
            credentialConfigured: resolvedCredential.ready,
            credentialRevision: resolvedCredential.revision,
          },
        )
      } catch (error) {
        operationControlError = error
      }
    }
    if (!resolvedCredential.ready || circuitOpen || operationControlError) {
      if (plan.unavailable) {
        const routed = await plan.unavailable(reservation, { dispatchLeaseHeld: false,
          dispatchLease: { consumerId: context.consumer.id, operation: plan.operation, fingerprint: requestFingerprint,
            endpointKey: normalized.endpointKey, contractVersion: normalized.endpointContractVersion,
            ownerRequestId: activeRequestId, expiresAt: new Date(reservation.request.leaseExpiresAt),
            retryOfRequestId: validatedRetryOfRequestId }, safeToFallback: !operationControlError
          || (operationControlError instanceof AppError && ['external_platform_operation_blocked',
            'external_platform_operation_disabled', 'external_platform_operation_paused',
            'external_platform_operation_shadow', 'external_platform_operation_canary'].includes(operationControlError.code)) })
        if (routed) { ownsReservation = false; return routed.result }
      }
      if (allowStoredFallback && snapshot) {
        const reason = operationControlError?.code
          || (!resolvedCredential.ready ? 'provider_not_configured' : 'provider_circuit_open')
        // A silently degraded delivery is the hardest state to triage, so the
        // blockers that refused dispatch travel with the fallback body itself
        // instead of only with the 503 that a caller with a snapshot never sees.
        // These are the same non-secret prerequisites the 503 path already
        // publishes; they name deployment state, never credentials or URLs.
        const responseBody = deliveryBody(snapshot.responseBody, {
          requestId: activeRequestId,
          sourceMode: 'stored_fallback',
          capturedAt: snapshot.capturedAt,
          fallbackReason: reason,
          reasonDetail: { blockers: operationControlError?.details?.blockers || null },
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
      const errorCode = operationControlError?.code
        || (circuitOpen ? 'external_platform_circuit_open' : 'external_platform_not_configured')
      await this.platformStore.rejectWithoutDispatch({
        delivery,
        sourceMode,
        status: 503,
        errorCode,
      })
      if (operationControlError) throw operationControlError
      if (authorizationPlatform === 'instagram' && circuitOpen) {
        const contractOpen = contractCircuit?.circuitOpenUntil && new Date(contractCircuit.circuitOpenUntil) > now
        throw circuitOpenError(contractOpen ? contractCircuit : state, this.config,
          'Instagram 搜索暂时受保护，请保留请求 ID 核查原因。', { scope: contractOpen ? 'platform_contract' : null })
      }
      if (this.providerKey === 'justone' && authorizationPlatform === 'ecommerce'
        && state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now) {
        const capacity = ecommerceCapacityError(state.lastErrorCode, {
          code: 'external_platform_circuit_open', state, config: this.config,
        })
        if (capacity) throw capacity
      }
      if (this.providerKey === 'tikhub' && circuitOpen
        && !(contractCircuit?.circuitOpenUntil && new Date(contractCircuit.circuitOpenUntil) > now)) {
        throw circuitOpenError(state, this.config, 'External data is temporarily unavailable')
      }
      throw new AppError(503, errorCode, 'External product search is unavailable')
    }

    let ownsLease = false
    let entered = false
    let waitedForCapacity = false
    let call = null
    let callSettled = false
    let lastDispatchEvidence = null
    let costReservation = null
    try {
      const dispatchLease = {
        consumerId: context.consumer.id,
        operation: plan.operation,
        fingerprint: requestFingerprint,
        endpointKey: normalized.endpointKey,
        contractVersion: normalized.endpointContractVersion,
        ownerRequestId: activeRequestId,
        expiresAt: new Date(reservation.request.leaseExpiresAt),
        retryOfRequestId: validatedRetryOfRequestId,
      }
      const lease = await this.platformStore.acquireDispatchLease(dispatchLease)
      ownsLease = lease === true || lease?.kind === 'acquired'
      if (!ownsLease) {
        // A leader may have finished between the first snapshot lookup and the
        // lease attempt. Recheck once; never poll or create an upstream retry.
        snapshot = await this.platformStore.snapshotFor({
          consumerId: context.consumer.id,
          operation: plan.operation,
          fingerprint: requestFingerprint,
        }, new Date())
        if (allowStoredFallback && snapshot && new Date(snapshot.freshUntil) >= new Date()) {
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
        if (allowStoredFallback && blockedOutcome && snapshot) {
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
          throw new AppError(
            409,
            errorCode,
            'A recent response could not be normalized; do not retry automatically',
            { upstreamDispatched: false, blockedUntil: lease?.blockedUntil || null },
          )
        }
        throw new AppError(409, errorCode, 'An equal external provider dispatch is already in progress')
      }

      const revalidateCapacity = async () => {
        waitedForCapacity = true
        context = await this.#revalidateWaitingIdentity(context, authorizationPlatform, plan)
        const currentPolicy = { ...this.defaultPolicy, ...await this.usageStore.getPolicy(context.consumer.id, authorizationPlatform) }
        const entitlement = await this.usageStore.getApiKeyPlatformEntitlement?.(context.apiKey.id, authorizationPlatform)
        policy = { ...currentPolicy, maxPageSize: entitlement
          ? Math.min(currentPolicy.maxPageSize, entitlement.maxPageSize) : currentPolicy.maxPageSize }
        try { plan.normalize({ body, policy, codec }) }
        catch (error) {
          if (error instanceof JustOneContractError || error instanceof SocialAccountContractError) throw new AppError(400, error.code, error.message)
          throw error
        }
        const shared = await this.platformStore.providerState(this.providerKey)
        const latest = (this.providerKey === 'tikhub' || isHubRateLimitExempt(context)) ? internalCircuitState(this.usageStore, context, shared) : shared
        const contract = await this.platformStore.contractCircuitState?.(this.providerKey, normalized.marketplace ?? null)
        if ([latest, contract].some(value => value?.circuitOpenUntil && Date.parse(value.circuitOpenUntil) > this.admissionClock())) {
          if (this.providerKey === 'justone' && authorizationPlatform === 'ecommerce'
            && latest?.circuitOpenUntil && Date.parse(latest.circuitOpenUntil) > this.admissionClock()) {
            const capacity = ecommerceCapacityError(latest.lastErrorCode, {
              code: 'external_platform_circuit_open', state: latest, config: this.config,
            })
            if (capacity) throw capacity
          }
          throw circuitOpenError(contract?.circuitOpenUntil && Date.parse(contract.circuitOpenUntil) > this.admissionClock() ? contract : latest,
            this.config, 'External data is temporarily unavailable')
        }
        resolvedCredential = await this.#resolvedCredential()
        if (!resolvedCredential.ready) throw new AppError(503, 'external_platform_not_configured', 'External data configuration changed while waiting')
        operationControl = await this.operationControlStore?.authorizeDispatch(this.providerKey, plan.operation, {
          consumerId: context.consumer.id, config: this.config,
          credentialConfigured: resolvedCredential.ready, credentialRevision: resolvedCredential.revision,
        })
        await plan.revalidateDispatch?.()
        return context
      }

      // Only a dispatch-lease owner consumes scarce provider concurrency.
      // Equal requests suppressed by the shared lease must not crowd out a
      // different customer query before they return their 409/cache result.
      if (!(entered = await this.#enterOrQueue(context, { lease: dispatchLease, delivery,
        expiresAt: reservation.request.leaseExpiresAt, signal, platform: authorizationPlatform,
        canWait: !(allowStoredFallback && snapshot),
        revalidate: revalidateCapacity
      }))) {
        if (allowStoredFallback && snapshot) {
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
        ownsReservation = false
        throw concurrencyBusy('concurrency_guard', { platform: authorizationPlatform, operation: plan.operation })
      }
      if (waitedForCapacity && allowStoredFallback) {
        const fresh = await this.platformStore.snapshotFor({ consumerId: context.consumer.id,
          operation: plan.operation, fingerprint: requestFingerprint }, new Date())
        if (fresh && new Date(fresh.freshUntil) >= new Date()) {
          const responseBody = deliveryBody(fresh.responseBody, { requestId: activeRequestId,
            sourceMode: 'fresh_cache', capturedAt: fresh.capturedAt })
          await this.platformStore.commitSnapshotDelivery({ delivery, snapshot: fresh, sourceMode: 'fresh_cache', responseBody })
          return resultFromBody(responseBody, { requestId: activeRequestId, replay: false,
            sourceMode: 'fresh_cache', capturedAt: fresh.capturedAt })
        }
      }

      const costControl = providerCostControl(
        operationControl?.billing ? { billing: operationControl.billing } : this.config,
        normalized.endpointKey,
        plan.allowZeroCost === true,
      )
      if (typeof this.platformStore.reserveProviderCostWorkflow !== 'function') {
        throw new AppError(
          503,
          'external_platform_cost_control_unavailable',
          'Provider cost reservation is unavailable',
        )
      }
      costReservation = costControl.costMinor === 0 ? null : await this.platformStore.reserveProviderCostWorkflow({
        tenantId: context.tenant.id,
        consumerId: context.consumer.id,
        apiKeyId: context.apiKey.id,
        usageRequestId: activeRequestId,
        fingerprint: requestFingerprint,
        costControls: [costControl],
      })

      const rateLimit = isHubRateLimitExempt(context) || (this.providerKey === 'tikhub' && isInternalTraffic(this.usageStore, context))
        ? { allowed: true, retryAfterMs: 0 }
        : typeof this.platformStore.acquireProviderRateLimit === 'function'
        ? await this.platformStore.acquireProviderRateLimit({
            limit: (await refreshAdmissionLimits(this)).maxRequestsPerMinute ?? 90,
            windowMs: 60_000,
          })
        : { allowed: true, retryAfterMs: 0 }
      if (!rateLimit.allowed) {
        // Facebook's auto policy may choose its other supplier before any
        // RapidAPI dispatch. The route itself preserves administrator mode and
        // provider-bound cursors; other operations have no unavailable route.
        if (plan.unavailable) {
          // A usage request may have only one active procurement reservation.
          // No call has started, so release this provider's hold before a
          // priority route reuses the same customer request with its backup.
          if (costReservation) {
            await this.platformStore.releaseProviderCostWorkflow({
              reservationId: costReservation.id, usageRequestId: activeRequestId,
            })
            costReservation = null
          }
          const routed = await plan.unavailable(reservation, { safeToFallback: true, dispatchLeaseHeld: ownsLease, dispatchLease })
          if (routed) { ownsReservation = false; return routed.result }
        }
        if (allowStoredFallback && snapshot) {
          const responseBody = deliveryBody(snapshot.responseBody, {
            requestId: activeRequestId,
            sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt,
            fallbackReason: 'provider_rate_limit',
          })
          await this.platformStore.commitSnapshotDelivery({
            delivery, snapshot, sourceMode: 'stored_fallback', responseBody,
          })
          return resultFromBody(responseBody, {
            requestId: activeRequestId,
            replay: false,
            sourceMode: 'stored_fallback',
            capturedAt: snapshot.capturedAt,
          })
        }
        await this.platformStore.rejectWithoutDispatch({
          delivery, sourceMode: 'unavailable', status: 429, errorCode: 'external_platform_rate_limited',
        })
        ownsReservation = false
        throw new AppError(
          429,
          'external_platform_rate_limited',
          'External product search request rate is exhausted',
          { retryAfterMs: rateLimit.retryAfterMs },
        )
      }

      if (plan.admit) {
        try {
          const routed = await plan.admit(reservation, { revalidate: async () => {
            await revalidateCapacity()
            const latestCost = providerCostControl(operationControl?.billing ? { billing: operationControl.billing } : this.config,
              normalized.endpointKey, plan.allowZeroCost === true)
            if (JSON.stringify(latestCost) !== JSON.stringify(costControl)) throw new AppError(503,
              'external_platform_cost_control_unavailable', 'Procurement controls changed while waiting')
            const claim = await this.platformStore.acquireDispatchLease({ ...dispatchLease, ownedDeliveryLease: true })
            if (claim !== true && claim?.kind !== 'acquired') throw new AppError(409,
              claim?.reason === 'unknown' ? 'request_outcome_unknown' : claim?.reason === 'succeeded_unusable'
                ? 'external_platform_response_unusable' : 'request_in_progress', 'Dispatch protection changed while waiting')
          }, delivery,
            deadlineAt: new Date(reservation.request.leaseExpiresAt).getTime() })
          if (routed) { ownsReservation = false; return routed.result }
        } catch (error) {
          if (error.details?.stage === 'facebook_quota_admission') {
            await this.platformStore.rejectWithoutDispatch({ delivery, sourceMode: 'unavailable',
              status: error.status || 503, errorCode: error.code || 'facebook_quota_state_unavailable' })
            ownsReservation = false
          }
          throw error
        }
      }
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      call = await this.platformStore.beginProviderCall({
        tenantId: context.tenant.id,
        consumerId: context.consumer.id,
        apiKeyId: context.apiKey.id,
        usageRequestId: activeRequestId,
        operation: plan.operation,
        contractVersion: normalized.endpointContractVersion,
        endpointKey: normalized.endpointKey,
        endpointVersion: normalized.endpointVersion,
        marketplace: normalized.marketplace,
        fingerprint: requestFingerprint,
        retryOfRequestId: validatedRetryOfRequestId,
        ...(plan.callOrdinal != null ? { callOrdinal: plan.callOrdinal, callRole: plan.callOrdinal ? 'retry' : 'primary' } : {}),
        costControl: costControl.costMinor === 0 ? null : costControl,
        costReservationId: costReservation?.id ?? null,
        ...(operationControl ? { operationControl } : {}),
      })
      lastDispatchEvidence = {
        billed: null,
        costMinor: costControl.costMinor,
        costKind: costControl.costKind,
        currency: costControl.currency,
      }
      const startedAt = performance.now()
      try {
        let result = await plan.dispatch({
          body,
          policy,
          codec,
          credential: resolvedCredential.credential === undefined
            ? {}
            : { credential: resolvedCredential.credential },
        })
        const persistedEvidence = persistedCallEvidence(result)
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const unitCost = plan.costUnknown?.() ? null : costControl.costMinor
        lastDispatchEvidence = {
          billed: plan.billingFree ? false : plan.billingUnknown ? null : true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : costControl.currency,
          latencyMs,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          restrictedResponseArchive: persistedEvidence.restrictedResponseArchive,
          archiveObjects: result.archiveObjects,
        }
        if (plan.platformSearch && this.providerKey === 'tikhub') {
          // Persist the paid search before any optional paid detail calls.
          await this.platformStore.stageProviderEvidence({
            callId: call.id, delivery, ...lastDispatchEvidence,
            httpStatus: persistedEvidence.responseArchive?.httpStatus ?? 200,
            businessCode: persistedEvidence.responseArchive?.businessCode ?? 200,
            itemCount: result.items?.length ?? 0,
          })
          // The primary call now carries its procurement cost. Release its
          // workflow hold before independently admitting each detail step.
          if (costReservation) {
            await this.platformStore.releaseProviderCostWorkflow({
              reservationId: costReservation.id, usageRequestId: activeRequestId,
            })
            costReservation = null
          }
        }
        if (plan.finalize) result = await plan.finalize({
          result, delivery, callId: call.id,
          credential: resolvedCredential.credential === undefined ? {} : { credential: resolvedCredential.credential },
          credentialRevision: resolvedCredential.revision,
          deadlineAt: new Date(reservation.request.leaseExpiresAt).getTime() || Date.now() + this.reservationLeaseMs,
        })
        const capturedAt = acceptedCaptureTime(result)
        const responseBody = plan.dataSearch ? { data: result.publicBody.data, requestId: activeRequestId } : deliveryBody(result.publicBody, {
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
          // A contract with no reviewed per-item identity extracts no items and
          // reports zero, rather than crashing the delivery on a missing field.
          itemCount: result.acquiredItems?.length ?? result.items?.length ?? 0,
          ...(plan.platformSearch ? { usageUnitsActual: plan.dataSearch ? Math.max(1, result.items?.length ?? 0) : 1 } : {}),
          latencyMs,
          ...(plan.platformSearch ? { usageLatencyMs: Math.max(0, Math.round(performance.now() - startedAt)) } : {}),
          // Official usage semantics count only code=0 as a successful billed
          // request. Monetary cost remains unknown unless a reviewed price book
          // is configured.
          billed: plan.billingFree ? false : plan.billingUnknown ? null : true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : costControl.currency,
          archiveObjects: result.archiveObjects,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          restrictedResponseArchive: persistedEvidence.restrictedResponseArchive,
          ingestJob: plan.skipIngest ? null : {
            payload: {
              kind: 'external-platform-result',
              consumerId: context.consumer.id,
              providerKey: this.providerKey,
              datasetId: plan.datasetId || 'ecommerce.products.v1',
              platform: authorizationPlatform,
              requestId: activeRequestId,
              queryFingerprint: requestFingerprint,
              providerCallId: call.id,
              records: result.records,
            },
            dedupeKey: `external-platform:${this.providerKey}:${call.id}`,
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
        if (!(error instanceof JustOneUpstreamError)
          && !(error instanceof RapidApiUpstreamError || error instanceof WebSearchUpstreamError)
          && !(plan.nativeForwarding && error instanceof TikHubUpstreamError)) throw error
        const evidence = error.evidence
        const persistedEvidence = persistedCallEvidence(error)
        const mappedError = publicFailure(error, { ecommerce: authorizationPlatform === 'ecommerce' })
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const billed = plan.billingFree ? false : evidence.billed ?? null
        const unitCost = plan.costUnknown?.() ? null : costControl.costMinor
        lastDispatchEvidence = {
          billed,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : costControl.currency,
          latencyMs,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          restrictedResponseArchive: persistedEvidence.restrictedResponseArchive,
          archiveObjects: error.archiveObjects,
        }
        // Under live_only the caller receives the error, so the durable delivery
        // evidence must record the error too. Recording a fallback the caller
        // never saw would make a later idempotent replay contradict the
        // original response.
        if (plan.retryRejected) {
          const routed = await plan.retryRejected({ error, reserved: reservation, settle: async () => {
            await this.platformStore.finishProviderStep({ callId: call.id, delivery, outcome: 'rejected',
              httpStatus: evidence.httpStatus, businessCode: evidence.businessCode, ...lastDispatchEvidence,
              errorCode: evidence.errorCode, affectsCircuit: false })
            callSettled = true
            ownsReservation = false
          } })
          if (routed) return routed.result
        }
        const deliverableSnapshot = allowStoredFallback ? snapshot : null
        const fallbackBody = deliverableSnapshot
          ? deliveryBody(deliverableSnapshot.responseBody, {
              requestId: activeRequestId,
              sourceMode: 'stored_fallback',
              capturedAt: deliverableSnapshot.capturedAt,
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
          currency: unitCost == null ? null : costControl.currency,
          latencyMs,
          errorCode: evidence.errorCode,
          failureResponseStatus: mappedError.status,
          failureResponseBody: failureResponseBody(mappedError, activeRequestId),
          affectsCircuit: evidence.affectsCircuit !== false,
          circuitCategory: evidence.circuitCategory ?? null,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          restrictedResponseArchive: persistedEvidence.restrictedResponseArchive,
          archiveObjects: error.archiveObjects,
          snapshot: deliverableSnapshot,
          fallbackResponseBody: fallbackBody,
        })
        callSettled = true
        if (deliverableSnapshot) {
          return resultFromBody(fallbackBody, {
            requestId: activeRequestId,
            replay: false,
            sourceMode: 'stored_fallback',
            capturedAt: deliverableSnapshot.capturedAt,
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
      } else if (error?.code === 'external_platform_call_persistence_unknown') {
        // A lost INSERT/COMMIT acknowledgement is not a safe pre-dispatch
        // failure: the provider-call row may exist. Keep the usage request
        // unknown so neither this catch nor the outer reservation cleanup can
        // release it and authorize an accidental duplicate paid dispatch.
        await this.usageStore.markRequestUnknown(
          activeRequestId,
          'external_platform_call_persistence_unknown',
        ).catch(() => {})
        ownsReservation = false
      } else if (!call && !(error instanceof AppError)) {
        await this.usageStore.releaseRequest(
          activeRequestId,
          'external_platform_pre_dispatch_failed',
        ).catch(() => {})
      }
      throw error
    } finally {
      // Upstream execution has ended. Let queued requests use provider
      // capacity before optional database cleanup; none
      // of these releases may start another paid dispatch for this request.
      if (entered) this.#leave(context.consumer.id, entered)
      if (plan.cleanup) await plan.cleanup().catch(() => {})
      if (costReservation) {
        await this.platformStore.releaseProviderCostWorkflow({
          reservationId: costReservation.id,
          usageRequestId: activeRequestId,
          bestEffortRelease: true,
        }).catch((error) => {
          this.logger?.warn?.(`[external-platform] cost reservation release failed: ${error.message}`)
        })
      }
      if (ownsLease) {
        await this.platformStore.releaseDispatchLease({
          consumerId: context.consumer.id,
          operation: plan.operation,
          fingerprint: requestFingerprint,
          ownerRequestId: activeRequestId,
          bestEffortRelease: true,
        }).catch((error) => {
          this.logger?.warn?.(`[external-platform] dispatch lease release failed: ${error.message}`)
        })
      }
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
