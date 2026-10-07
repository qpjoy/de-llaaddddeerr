import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { IpRiskBatch } from './ip-risk-batch.mjs'
import { IpRiskHistory } from './ip-risk-history.mjs'
import { IpSearchEvents } from './ipsearch-events.mjs'
import { IP_RISK_PLATFORM, IP_RISK_OPERATION, IP_RISK_VERSION, normalizeIpRiskRequest } from '../contracts/ip-risk.mjs'
import { acquisitionRequestSnapshot } from '../acquisitions/request-snapshot.mjs'

export class IpRiskGateway {
  constructor({ usageStore, platformStore, adapter, credentialStore = null, enabled = false, credentialConfigured = adapter.configured, reservationLeaseMs = 60000, providerKey = 'ipsearch', operation = IP_RISK_OPERATION, version = IP_RISK_VERSION, meterKey = operation, endpointVersion = providerKey === 'ipsearch' ? 'v2-sdk-0.1.0' : version }) {
    Object.assign(this, { usageStore, platformStore, adapter, credentialStore, enabled, credentialConfigured, reservationLeaseMs, providerKey, operation, version, meterKey, endpointVersion })
    this.events = new IpSearchEvents(platformStore.pool)
    this.active = 0
    this.batch = new IpRiskBatch(this)
    this.history = new IpRiskHistory(this)
  }
  async capabilities() {
    if (this.adapter.capabilities) return this.adapter.capabilities()
    const credential = await this.credentialStore?.describeCredential(this.providerKey)
    const configured = credential?.credentialConfigured ?? this.credentialConfigured
    const enabled = this.enabled || credential?.source === 'database'
    return { platform: IP_RISK_PLATFORM, ready: enabled && configured,
      operations: { [this.operation]: { ready: enabled && configured } } }
  }
  async query(context, { body, idempotencyKey, path }) {
    const started = Date.now()
    const eventId = await this.events.begin(context)
    let result, failure
    try {
      result = await this.execute(context, { body, idempotencyKey, path })
      return result
    } catch (error) { failure = error; throw error }
    finally {
      // Persisted pending event remains reconcilable if completion persistence fails.
      await this.events.finish(eventId, result?.status || failure?.status || 503,
        result?.body?.error?.code || failure?.code || null, result?.requestId || failure?.details?.requestId,
        !!result?.replay, Date.now() - started).catch(() => {})
    }
  }
  async execute(context, { body, idempotencyKey, path }) {
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
    await this.usageStore.reapStaleReservations()
    await this.platformStore.reapStaleCalls()
    const reservation = await this.usageStore.reserve({
      requestId: randomUUID(), idempotencyKey, fingerprint, tenantId: tenant.id, consumerId: consumer.id, apiKeyId: apiKey.id,
      platform: IP_RISK_PLATFORM,
      // Unlisted meters remain free; assigned explicit prices use the existing wallet ledger.
      meterKey: this.meterKey,
      acquisitionRequest: acquisitionRequestSnapshot({ method: 'POST', path, body }),
      requiredAuthorizationScopes: [{ type: 'platform', key: IP_RISK_PLATFORM }, { type: 'capability', key: this.operation }],
      unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + this.reservationLeaseMs),
      windowStart: new Date(Date.now() - policy.windowSeconds * 1000), maxRequests: policy.maxRequests, replayWindowMs: null,
    }).catch(error => {
      if (error.code === 'P0001' && error.message === 'commerce_subscription_required') throw new AppError(403,error.message,'请先购买有效的 IP v2 订阅')
      if (error.code === 'P0001' && error.message === 'commerce_quota_exhausted') throw new AppError(429,error.message,'本期订阅额度已用尽')
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
      const credential = await this.credentialStore?.readCredentialSnapshot(this.providerKey)
      const apiKeyValue = credential?.apiKey ?? this.adapter.apiKey
      if (!(this.enabled || credential?.source === 'database') || (this.credentialStore ? !apiKeyValue : !this.adapter.configured)) throw new AppError(503, 'ip_risk_unavailable', 'IP risk service is not enabled')
      const state = await this.platformStore.providerState()
      if (state.circuitOpenUntil && new Date(state.circuitOpenUntil) > new Date()) throw new AppError(503, 'ip_risk_unavailable', 'IP risk service is temporarily unavailable')
      const acquired = await this.platformStore.acquireDispatchLease({ consumerId: consumer.id, operation: this.operation, fingerprint,
        endpointKey: 'risk.query', contractVersion: this.version, ownerRequestId: requestId, expiresAt: new Date(Date.now() + this.reservationLeaseMs) })
      if (acquired.kind !== 'acquired') throw new AppError(409, 'ip_query_in_progress_or_unknown', 'An equal query is running or has an uncertain result')
      lease = true
      if (this.active >= 3) throw new AppError(429, 'ip_query_concurrency_limited', 'IP query capacity is temporarily exhausted')
      this.active++; slot = true
      const rate = await this.platformStore.acquireProviderRateLimit({ limit: 60 })
      if (!rate.allowed) throw new AppError(429, 'ip_query_rate_limited', 'IP query rate limit reached')
      call = await this.platformStore.beginProviderCall({ tenantId: tenant.id, consumerId: consumer.id, apiKeyId: apiKey.id, usageRequestId: requestId,
        operation: this.operation, contractVersion: this.version, endpointKey: 'risk.query', endpointVersion: this.endpointVersion, marketplace: IP_RISK_PLATFORM, fingerprint })
      evidence = await this.adapter.query(input.ip, { apiKey: apiKeyValue, requestId })
      const common = { callId: call.id, delivery, billed: null, costMinor: null, costKind: 'unknown', currency: null,
        latencyMs: evidence.latencyMs, responseArchive: evidence.responseArchive, restrictedResponseArchive: evidence.restrictedResponseArchive }
      if (evidence.outcome !== 'succeeded') {
        const failure = { error: { code: evidence.errorCode, message: 'IP query could not be completed; retain the request identity' }, requestId }
        await this.platformStore.finishFailure({ ...common, outcome: evidence.outcome, httpStatus: evidence.httpStatus, businessCode: evidence.businessCode,
          errorCode: evidence.errorCode, failureResponseStatus: 502, failureResponseBody: failure })
        terminal = true
        return { status: 502, body: failure, requestId, replay: false }
      }
      const capturedAt = new Date()
      const responseBody = { contractVersion: this.version, data: { ip: input.ip, ...evidence.normalized },
        meta: { capturedAt: capturedAt.toISOString(), sourceMode: 'live', pricingStatus: 'plan_based', chargeStatus: 'see_usage' }, requestId }
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
      throw error
    } finally {
      if (slot) this.active--
      if (lease) await this.platformStore.releaseDispatchLease({ consumerId: consumer.id, operation: this.operation, fingerprint, ownerRequestId: requestId }).catch(() => {})
    }
  }
}
