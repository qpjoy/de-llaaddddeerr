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
import { JustOneUpstreamError } from '../adapters/justone.mjs'
import { AppError } from '../core/errors.mjs'
import { createExternalPlatformCursorCodec } from './cursor.mjs'
import { describeDeliveryReason } from './delivery-reason.mjs'

const AUTHORIZATION_PLATFORM = 'ecommerce'
const DEFAULT_POLICY = Object.freeze({ maxRequests: 1_000, windowSeconds: 3_600, maxPageSize: 100 })
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

function providerCostControl(config, endpointKey) {
  const billing = config?.billing || {}
  const costMinor = billing.unitCostMinorByEndpoint?.[endpointKey]
  if (!Number.isSafeInteger(costMinor) || costMinor <= 0
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
  const reason = describeDeliveryReason({ sourceMode, fallbackReason, detail: reasonDetail })
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
    credentialStore = null,
    // Everything in this class is provider-shaped rather than provider-specific:
    // the adapter, config, stores and credential all arrive by injection. The
    // provider key is the last constant, so naming it here lets a second vendor
    // reuse this orchestration instead of growing a parallel copy of it.
    providerKey = 'justone',
    defaultPolicy = DEFAULT_POLICY,
    logger = console,
  }) {
    this.providerKey = providerKey
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
        operationReadiness = Object.fromEntries(operations.map((operation) => [
          operation.operationKey,
          {
            ready: credentialReady && operationReadyForConsumer(operation, consumerId),
            effectiveState: operation.effectiveState,
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
      marketplaces: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
      pagination: 'opaque_cursor',
      idempotencyKey: 'optional',
      deliveryModes: ['cache_only', 'cache_first', 'refresh'],
      freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
    }
  }

  async search(context, { body, idempotencyKey, retryOfRequestId, path }) {
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, path }, {
      operation: JUSTONE_OPERATION,
      capabilityMessage: 'E-commerce product search is not granted for this API key',
      normalize: ({ policy, codec }) => normalizeJustOneProductSearchRequest(body, {
        decodeCursor: codec.decode,
        encodeCursor: codec.encode,
        maxPageSize: policy.maxPageSize,
      }),
      dispatch: ({ policy, codec, credential }) => this.adapter.searchProducts(body, {
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
  async fetchResource(context, { resourceKey, body, idempotencyKey, retryOfRequestId, path }) {
    const resource = JUSTONE_RESOURCE_CATALOG[resourceKey]
    if (!resource?.released) {
      throw new AppError(404, 'unsupported_resource', 'This external resource is not available')
    }
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, path }, {
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
  async searchAccounts(context, { body, idempotencyKey, retryOfRequestId, path }) {
    return this.#deliver(context, { body, idempotencyKey, retryOfRequestId, path }, {
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

  async #deliver(context, { body, idempotencyKey, retryOfRequestId, path }, plan) {
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
    if (!capabilityGrants.includes(plan.operation)) {
      throw new AppError(403, 'capability_not_granted', plan.capabilityMessage)
    }
    const consumerPolicy = {
      ...this.defaultPolicy,
      ...((await this.usageStore.getPolicy(context.consumer.id, authorizationPlatform)) || {}),
    }
    const keyEntitlement = typeof this.usageStore.getApiKeyPlatformEntitlement === 'function'
      ? await this.usageStore.getApiKeyPlatformEntitlement(context.apiKey.id, authorizationPlatform)
      : null
    const policy = {
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
    await this.usageStore.reapStaleReservations()
    await this.platformStore.reapStaleCalls?.()

    let validatedRetryOfRequestId = null
    if (retryOfRequestId != null) {
      if (
        typeof retryOfRequestId !== 'string'
        || !UUID_PATTERN.test(retryOfRequestId.trim())
        || normalized.deliveryMode !== 'refresh'
      ) {
        throw new AppError(
          400,
          'invalid_uncertain_retry',
          'X-MX-Insight-Retry-Of requires a request UUID and deliveryMode refresh',
        )
      }
      const candidateId = retryOfRequestId.trim()
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
    const requestId = randomUUID()
    const effectiveKey = suppliedKey
      ? idempotencyKey
      : `auto:${context.apiKey.id}:${requestId}`
    const windowStart = new Date(Date.now() - policy.windowSeconds * 1_000)
    const reservation = await this.usageStore.reserve({
      requestId,
      idempotencyKey: effectiveKey,
      fingerprint: requestFingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: authorizationPlatform,
      meterKey: plan.operation,
      requiredAuthorizationScopes: [
        { type: 'platform', key: authorizationPlatform },
        { type: 'capability', key: plan.operation },
      ],
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart,
      maxRequests: policy.maxRequests,
      // A caller-supplied key names one immutable delivery attempt. An omitted
      // key means this HTTP call is a new billable intent; only explicit key
      // reuse is idempotent.
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
      operation: plan.operation,
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

    const state = await this.platformStore.providerState(this.providerKey)
    const circuitOpen = state?.circuitOpenUntil && new Date(state.circuitOpenUntil) > now
    const resolvedCredential = circuitOpen
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
      throw new AppError(503, errorCode, 'External product search is unavailable')
    }

    let ownsLease = false
    let entered = false
    let call = null
    let callSettled = false
    let lastDispatchEvidence = null
    let costReservation = null
    try {
      const lease = await this.platformStore.acquireDispatchLease({
        consumerId: context.consumer.id,
        operation: plan.operation,
        fingerprint: requestFingerprint,
        endpointKey: normalized.endpointKey,
        contractVersion: normalized.endpointContractVersion,
        ownerRequestId: activeRequestId,
        expiresAt: new Date(Date.now() + this.reservationLeaseMs),
        retryOfRequestId: validatedRetryOfRequestId,
      })
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

      // Only a dispatch-lease owner consumes scarce provider concurrency.
      // Equal requests suppressed by the shared lease must not crowd out a
      // different customer query before they return their 409/cache result.
      if (!this.#enter(context.consumer.id)) {
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
        throw new AppError(429, 'external_platform_busy', 'External product search concurrency is exhausted')
      }
      entered = true

      const costControl = providerCostControl(
        operationControl?.billing ? { billing: operationControl.billing } : this.config,
        normalized.endpointKey,
      )
      if (typeof this.platformStore.reserveProviderCostWorkflow !== 'function') {
        throw new AppError(
          503,
          'external_platform_cost_control_unavailable',
          'Provider cost reservation is unavailable',
        )
      }
      costReservation = await this.platformStore.reserveProviderCostWorkflow({
        tenantId: context.tenant.id,
        consumerId: context.consumer.id,
        apiKeyId: context.apiKey.id,
        usageRequestId: activeRequestId,
        fingerprint: requestFingerprint,
        costControls: [costControl],
      })

      const rateLimit = typeof this.platformStore.acquireProviderRateLimit === 'function'
        ? await this.platformStore.acquireProviderRateLimit({
            limit: this.config.maxRequestsPerMinute ?? 90,
            windowMs: 60_000,
          })
        : { allowed: true, retryAfterMs: 0 }
      if (!rateLimit.allowed) {
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
        costControl,
        costReservationId: costReservation.id,
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
        const result = await plan.dispatch({
          body,
          policy,
          codec,
          credential: resolvedCredential.credential === undefined
            ? {}
            : { credential: resolvedCredential.credential },
        })
        const persistedEvidence = persistedCallEvidence(result)
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
        const unitCost = costControl.costMinor
        lastDispatchEvidence = {
          billed: true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : costControl.currency,
          latencyMs,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          restrictedResponseArchive: persistedEvidence.restrictedResponseArchive,
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
          // A contract with no reviewed per-item identity extracts no items and
          // reports zero, rather than crashing the delivery on a missing field.
          itemCount: result.items?.length ?? 0,
          latencyMs,
          // Official usage semantics count only code=0 as a successful billed
          // request. Monetary cost remains unknown unless a reviewed price book
          // is configured.
          billed: true,
          costMinor: unitCost,
          costKind: unitCost == null ? 'unknown' : 'estimated',
          currency: unitCost == null ? null : costControl.currency,
          archiveObjects: result.archiveObjects,
          responseArchive: persistedEvidence.responseArchive,
          upstreamEvidence: persistedEvidence.upstreamEvidence,
          restrictedResponseArchive: persistedEvidence.restrictedResponseArchive,
          ingestJob: {
            payload: {
              kind: 'external-platform-result',
              providerKey: this.providerKey,
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
        const unitCost = costControl.costMinor
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
      if (costReservation) {
        await this.platformStore.releaseProviderCostWorkflow({
          reservationId: costReservation.id,
          usageRequestId: activeRequestId,
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
        }).catch((error) => {
          this.logger?.warn?.(`[external-platform] dispatch lease release failed: ${error.message}`)
        })
      }
      if (entered) this.#leave(context.consumer.id)
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
