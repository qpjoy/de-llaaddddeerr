import { requestMaintenance } from '../core/request-maintenance.mjs'
import { upstreamCapacityError } from './availability-errors.mjs'
import { isHubRateLimitExempt, internalCircuitState } from '../core/internal-traffic-policy.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { IpRiskBatch } from './ip-risk-batch.mjs'
import { IpRiskHistory } from './ip-risk-history.mjs'
import { IpSearchEvents } from './ipsearch-events.mjs'
import { IP_RISK_PLATFORM, IP_RISK_OPERATION, IP_RISK_VERSION, normalizeIpRiskRequest } from '../contracts/ip-risk.mjs'
import { acquisitionRequestSnapshot } from '../acquisitions/request-snapshot.mjs'
import { ConcurrencyAdmissionQueue, DEFAULT_CONCURRENCY_QUEUE, concurrencyBusy } from './concurrency-admission.mjs'
import { currentAdmissionLimits, refreshAdmissionLimits, admissionQueuePolicy } from './admission-runtime.mjs'

export const IP_ADMISSION_CONFIG = Object.freeze({ maxConcurrency: 6, maxConsumerConcurrency: 6, maxRequestsPerMinute: 60 })

export class IpRiskGateway {
  constructor({ usageStore, platformStore, adapter, credentialStore = null, enabled = false, credentialConfigured = adapter.configured, reservationLeaseMs = 60000, providerKey = 'ipsearch', operation = IP_RISK_OPERATION, version = IP_RISK_VERSION, meterKey = operation, endpointVersion = providerKey === 'ipsearch' ? 'v2-sdk-0.1.0' : version, concurrencyPolicy = DEFAULT_CONCURRENCY_QUEUE, admissionRuntime = {}, admissionPolicies = null, config = IP_ADMISSION_CONFIG }) {
    Object.assign(this, { usageStore, platformStore, adapter, credentialStore, enabled, credentialConfigured, reservationLeaseMs, providerKey, operation, version, meterKey, endpointVersion, concurrencyPolicy })
    this.config = { ...config, concurrencyQueue: concurrencyPolicy }
    this.admissionPolicies = admissionPolicies
    this.events = new IpSearchEvents(platformStore.pool)
    this.active = 0
    this.activeByConsumer = new Map()
    this.admissionClock = admissionRuntime.clock || Date.now
    this.concurrencyQueue = new ConcurrencyAdmissionQueue({ clock: this.admissionClock })
    this.batch = new IpRiskBatch(this)
    this.history = new IpRiskHistory(this)
  }
  get dispatchBudgetMs() { return this.adapter.dispatchBudgetMs }
  #enter(context) {
    if (isHubRateLimitExempt(context)) return 'exempt'
    const limits = currentAdmissionLimits(this)
    const consumerActive = this.activeByConsumer.get(context.consumer.id) || 0
    if (this.active >= limits.maxConcurrency || consumerActive >= limits.maxConsumerConcurrency) return false
    this.active++
    this.activeByConsumer.set(context.consumer.id, consumerActive + 1)
    return true
  }
  #leave(consumerId, admission = true) {
    if (admission === 'exempt') return
    this.active = Math.max(0, this.active - 1)
    const remaining = Math.max(0, (this.activeByConsumer.get(consumerId) || 1) - 1)
    if (remaining) this.activeByConsumer.set(consumerId, remaining)
    else this.activeByConsumer.delete(consumerId)
    this.concurrencyQueue.drain()
  }
  async #revalidate(context) {
    const current = await this.usageStore.findApiKeyById(context.apiKey.id)
    if (!current || current.apiKey.status !== 'active' || current.consumer.id !== context.consumer.id || current.tenant.id !== context.tenant.id) {
      throw new AppError(403, 'capability_not_granted', 'IP risk access changed while waiting')
    }
    const [grants, capabilities, plan] = await Promise.all([
      this.usageStore.listEffectiveGrants(current.consumer.id, current.apiKey.id),
      this.usageStore.listEffectiveCapabilityGrants(current.consumer.id, current.apiKey.id),
      this.usageStore.getConsumerPlan(current.consumer.id),
    ])
    if (!grants.includes(IP_RISK_PLATFORM) || !capabilities.includes(this.operation)) throw new AppError(403, 'capability_not_granted', 'IP risk access changed while waiting')
    if (!plan || plan.status !== 'active' || plan.versionStatus !== 'published') throw new AppError(503, 'plan_assignment_unavailable', 'An active published plan assignment is required')
    if (this.adapter.capabilities && !(await this.adapter.capabilities({ hubRateLimitExempt: isHubRateLimitExempt(current) })).ready) throw new AppError(503, 'ip_risk_unavailable', 'IP risk service changed while waiting')
    return { ...context, ...current }
  }
  async #credential(context) {
    const credential = await this.credentialStore?.readCredentialSnapshot(this.providerKey)
    const apiKey = credential?.source === 'database' ? credential.apiKey : credential?.apiKey ?? this.adapter.apiKey
    if (!(this.enabled || credential?.source === 'database') || (this.credentialStore ? !apiKey : !this.adapter.configured)) throw new AppError(503, 'ip_risk_unavailable', 'IP risk service is not enabled')
    const shared = await this.platformStore.providerState()
    const state = isHubRateLimitExempt(context) ? internalCircuitState(this.usageStore, context, shared) : shared
    if (state.circuitOpenUntil && new Date(state.circuitOpenUntil) > new Date()) throw new AppError(503, 'ip_risk_unavailable', 'IP risk service is temporarily unavailable')
    return apiKey
  }
  async #enterOrQueue(context, { lease, expiresAt, signal, revalidate }) {
    await refreshAdmissionLimits(this)
    if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
    if (isHubRateLimitExempt(context)) return 'exempt'
    if (!this.concurrencyQueue.entries.length && this.#enter(context)) return true
    const budget = this.dispatchBudgetMs
    if (!Number.isFinite(budget) || budget <= 0) throw new AppError(503, 'ip_risk_unavailable', 'IP risk dispatch time budget is unavailable', { upstreamDispatched: false })
    const policy = admissionQueuePolicy(this)
    const deadline = Math.min(this.admissionClock() + policy.maxWaitMs, new Date(expiresAt).getTime() - budget - 5000)
    let entered = false
    try {
      await this.platformStore.releaseDispatchLease(lease)
      await this.concurrencyQueue.enter({ tryEnter: () => (entered = this.#enter(context)), deadline, maxPending: policy.maxPending, signal,
        details: { platform: IP_RISK_PLATFORM, maxConcurrency: currentAdmissionLimits(this).maxConcurrency, maxPending: policy.maxPending } })
      context = await this.#revalidate(context)
      await revalidate(context)
      await refreshAdmissionLimits(this)
      if (entered !== 'exempt' && (this.active > currentAdmissionLimits(this).maxConcurrency
        || (this.activeByConsumer.get(context.consumer.id) || 0) > currentAdmissionLimits(this).maxConsumerConcurrency)) {
        throw concurrencyBusy('consumer_concurrency_changed', { platform: IP_RISK_PLATFORM })
      }
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      if (this.admissionClock() >= deadline) throw concurrencyBusy('concurrency_queue_timeout', { platform: IP_RISK_PLATFORM })
      const acquired = await this.platformStore.acquireDispatchLease(lease)
      if (acquired.kind !== 'acquired') throw new AppError(409, 'ip_query_in_progress_or_unknown', 'An equal query is running or has an uncertain result', { upstreamDispatched: false })
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      if (this.admissionClock() >= deadline) throw concurrencyBusy('concurrency_queue_timeout', { platform: IP_RISK_PLATFORM })
      return entered
    } catch (error) {
      if (entered) this.#leave(context.consumer.id, entered)
      throw error
    }
  }
  async capabilities() {
    if (this.adapter.capabilities) return this.adapter.capabilities()
    const credential = await this.credentialStore?.describeCredential(this.providerKey)
    const configured = credential?.credentialConfigured ?? this.credentialConfigured
    const enabled = this.enabled || credential?.source === 'database'
    return { platform: IP_RISK_PLATFORM, ready: enabled && configured,
      operations: { [this.operation]: { ready: enabled && configured } } }
  }
  async query(context, { body, idempotencyKey, path, signal, dispatchDeadline }) {
    const started = Date.now()
    const eventId = await this.events.begin(context)
    let result, failure
    try {
      result = await this.execute(context, { body, idempotencyKey, path, signal, dispatchDeadline })
      return result
    } catch (error) { failure = error; throw error }
    finally {
      // Persisted pending event remains reconcilable if completion persistence fails.
      await this.events.finish(eventId, result?.status || failure?.status || 503,
        result?.body?.error?.code || failure?.code || null, result?.requestId || failure?.details?.requestId,
        !!result?.replay, Date.now() - started).catch(() => {})
    }
  }
  async execute(context, { body, idempotencyKey, path, signal, dispatchDeadline }) {
    const { tenant, consumer, apiKey } = context
    const grants = await this.usageStore.listEffectiveGrants(consumer.id, apiKey.id)
    const capabilities = await this.usageStore.listEffectiveCapabilityGrants(consumer.id, apiKey.id)
    if (!grants.includes(IP_RISK_PLATFORM) || !capabilities.includes(this.operation)) {
      throw new AppError(403, 'capability_not_granted', 'IP risk queries are not granted')
    }
    if (apiKey.environment === 'test' || apiKey.prefix?.startsWith('mih_test_')) throw new AppError(403, 'test_key_not_supported', 'Use a Live Hub key')
    const input = normalizeIpRiskRequest(body)
    idempotencyKey ??= `ip-auto-${randomUUID()}`
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
      throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key requires 8–128 safe characters')
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ path, ...input, version: this.version })).digest('hex')
    const policy = { maxRequests: 1000, windowSeconds: 3600, ...await this.usageStore.getPolicy(consumer.id, IP_RISK_PLATFORM) }
    await requestMaintenance(this.usageStore)
    await requestMaintenance(this.platformStore, 'reapStaleCalls')
    const reservation = await this.usageStore.reserve({
      requestId: randomUUID(), idempotencyKey, fingerprint, tenantId: tenant.id, consumerId: consumer.id, apiKeyId: apiKey.id,
      platform: IP_RISK_PLATFORM,
      // Unlisted meters remain free; assigned explicit prices use the existing wallet ledger.
      meterKey: this.meterKey,
      acquisitionRequest: acquisitionRequestSnapshot({ method: 'POST', path, body }),
      requiredAuthorizationScopes: [{ type: 'platform', key: IP_RISK_PLATFORM }, { type: 'capability', key: this.operation }],
      unitsReserved: 1, leaseExpiresAt: new Date(Math.min(Date.now() + this.reservationLeaseMs, dispatchDeadline ?? Infinity)),
      windowStart: new Date(Date.now() - policy.windowSeconds * 1000), maxRequests: policy.maxRequests, replayWindowMs: null,
      // Definitive Baidu failures release subscription quota but retain the
      // saved response under this operation identity; replay must not dispatch.
      replayReleasedFailures: this.providerKey === 'baidu-ip',
    }).catch(error => {
      if (error.code === 'P0001' && error.message === 'commerce_subscription_required') throw new AppError(403,error.message,'请先购买有效的 IP v2 订阅')
      if (error.code === 'P0001' && error.message === 'commerce_quota_exhausted') throw new AppError(429,error.message,'本期订阅额度已用尽')
      if (error.code === 'P0001' && error.message === 'commerce_daily_limit_exhausted') throw new AppError(429,error.message,'今日订阅次数已用尽，将于北京时间次日 00:00 恢复')
      throw error
    })
    const requestId = reservation.request?.id
    const delivery = { tenantId: tenant.id, tenantName: tenant.name, consumerId: consumer.id, usageRequestId: requestId, operation: this.operation, fingerprint }
    if (reservation.kind === 'replay') {
      await this.platformStore.recordReplay({ delivery, status: reservation.request.responseStatus, succeeded: reservation.request.responseStatus === 200 })
      const replayBody = structuredClone(reservation.request.responseBody)
      if (replayBody?.meta) replayBody.meta = { ...replayBody.meta, sourceMode: 'idempotent_replay', originSourceMode: replayBody.meta.sourceMode }
      return { status: reservation.request.responseStatus, body: replayBody, requestId, replay: true }
    }
    if (reservation.kind !== 'reserved') throw new AppError(409, `request_${reservation.kind}`, 'Request cannot be dispatched; retain its Idempotency-Key', { requestId })
    let call = null, evidence = null, lease = false, terminal = false, slot = false
    try {
      let apiKeyValue = await this.#credential(context)
      const dispatchLease = { consumerId: consumer.id, operation: this.operation, fingerprint,
        endpointKey: 'risk.query', contractVersion: this.version, ownerRequestId: requestId, expiresAt: reservation.request.leaseExpiresAt }
      const acquired = await this.platformStore.acquireDispatchLease(dispatchLease)
      if (acquired.kind !== 'acquired') throw new AppError(409, 'ip_query_in_progress_or_unknown', 'An equal query is running or has an uncertain result')
      lease = true
      slot = await this.#enterOrQueue(context, { lease: dispatchLease, expiresAt: reservation.request.leaseExpiresAt, signal,
        revalidate: async current => { context = current; apiKeyValue = await this.#credential(context) } })
      const rate = isHubRateLimitExempt(context) ? { allowed: true } : await this.platformStore.acquireProviderRateLimit({ limit: (await refreshAdmissionLimits(this)).maxRequestsPerMinute })
      if (!rate.allowed) throw new AppError(429, 'ip_query_rate_limited', 'IP query rate limit reached')
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      call = await this.platformStore.beginProviderCall({ tenantId: tenant.id, consumerId: consumer.id, apiKeyId: apiKey.id, usageRequestId: requestId,
        operation: this.operation, contractVersion: this.version, endpointKey: 'risk.query', endpointVersion: this.endpointVersion, marketplace: IP_RISK_PLATFORM, fingerprint })
      evidence = await this.adapter.query(input.ip, { apiKey: apiKeyValue, requestId, hubRateLimitExempt: isHubRateLimitExempt(context) })
      const common = { callId: call.id, delivery, billed: null, costMinor: null, costKind: 'unknown', currency: null,
        latencyMs: evidence.latencyMs, responseArchive: evidence.responseArchive, restrictedResponseArchive: evidence.restrictedResponseArchive }
      if (evidence.outcome !== 'succeeded') {
        const rateLimited = evidence.httpStatus === 429 || evidence.errorCode === 'ip_channel_rate_limited'
        // This API historically projects supplier failures as HTTP 502. Keep
        // that contract and expose the supplier 429/business limit in details.
        const status = 502
        const failure = { error: { code: evidence.errorCode, message: 'IP query could not be completed; retain the request identity',
          ...(rateLimited ? { details: upstreamCapacityError(evidence).details } : {}) }, requestId }
        await this.platformStore.finishFailure({ ...common, outcome: evidence.outcome, httpStatus: evidence.httpStatus, businessCode: evidence.businessCode,
          errorCode: rateLimited ? 'upstream_rate_limited' : evidence.errorCode, failureResponseStatus: status, failureResponseBody: failure })
        terminal = true
        return { status, body: failure, requestId, replay: false }
      }
      const capturedAt = new Date()
      const responseBody = { contractVersion: this.version, data: { ip: input.ip, ...evidence.normalized },
        meta: { capturedAt: capturedAt.toISOString(), sourceMode: 'live', pricingStatus: this.meterKey === 'ip.risk.subscription.product' ? 'subscription' : 'plan_based', chargeStatus: this.meterKey === 'ip.risk.subscription.product' ? 'included' : 'see_usage' }, requestId }
      await this.platformStore.commitLiveDelivery({ ...common, responseBody, capturedAt, freshUntil: capturedAt, staleUntil: capturedAt,
        itemCount: evidence.normalized.status === 'no_data' ? 0 : 1, usageUnitsActual: 1 })
      terminal = true
      return { status: 200, body: responseBody, requestId, replay: false }
    } catch (error) {
      if (call && !terminal) {
        await this.platformStore.markPersistenceUnknown({ callId: call.id, delivery, responseArchive: evidence?.responseArchive,
          restrictedResponseArchive: evidence?.restrictedResponseArchive }).catch(() => {})
        throw new AppError(503, 'ip_query_outcome_unknown', 'Query outcome requires reconciliation; do not submit a new request', { requestId })
      }
      if (!terminal) await this.platformStore.rejectWithoutDispatch({ delivery, sourceMode: 'unavailable', status: error.status || 503, errorCode: error.code || 'ip_risk_unavailable' })
      if (error instanceof AppError) throw new AppError(error.status, error.code, error.message, { ...error.details, requestId })
      throw error
    } finally {
      if (lease) await this.platformStore.releaseDispatchLease({ consumerId: consumer.id, operation: this.operation, fingerprint, ownerRequestId: requestId }).catch(() => {})
      if (slot) this.#leave(context.consumer.id, slot)
    }
  }
}
