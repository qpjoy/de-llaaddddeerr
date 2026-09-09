import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue, isPostgresSafeText } from '../core/postgres-json.mjs'

const clone = (value) => value == null ? value : structuredClone(value)
const iso = (value = new Date()) => new Date(value).toISOString()
const number = (value) => value == null ? null : Number(value)
const FINISHED_PROVIDER_OUTCOMES = new Set(['succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

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
    && isDeepStrictEqual(row.payload, expected.payload)
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
    uncertainCooldownMs = 15 * 60_000,
  } = {}) {
    this.usageStore = usageStore
    this.providerKey = providerKey
    this.authorizationPlatform = authorizationPlatform
    this.circuitFailureThreshold = circuitFailureThreshold
    this.circuitOpenMs = circuitOpenMs
    this.uncertainCooldownMs = uncertainCooldownMs
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
  }

  async snapshotFor(input, at = new Date()) {
    const found = this.snapshots.get(snapshotKey(input))
    if (!found || new Date(found.staleUntil) < new Date(at)) return null
    return clone(found)
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
  }) {
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
            && new Date(call.completedAt).getTime() + this.uncertainCooldownMs > now
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
          : iso(new Date(blocker.completedAt).getTime() + this.uncertainCooldownMs),
      }
    }
    const key = snapshotKey({ consumerId, operation, fingerprint })
    const current = this.leases.get(key)
    if (current && new Date(current.expiresAt).getTime() > now) {
      return { kind: 'busy', blockedUntil: current.expiresAt }
    }
    this.leases.set(key, { ownerRequestId, expiresAt: iso(expiresAt) })
    return { kind: 'acquired' }
  }

  async releaseDispatchLease({ consumerId, operation, fingerprint, ownerRequestId }) {
    const key = snapshotKey({ consumerId, operation, fingerprint })
    if (this.leases.get(key)?.ownerRequestId === ownerRequestId) this.leases.delete(key)
  }

  async providerState(providerKey = this.providerKey) {
    if (providerKey !== this.providerKey) return null
    return clone(this.state)
  }

  async acquireProviderRateLimit({ limit, tokens = 1, windowMs = 60_000, at = new Date() }) {
    const maximum = boundedRateLimit(limit, 'limit')
    const requested = boundedRateLimit(tokens, 'tokens')
    if (requested > maximum) throw new TypeError('tokens must not exceed limit')
    const moment = rateMoment({ at, windowMs })
    const current = this.rateBuckets.get(this.providerKey)
    const elapsedMs = current
      ? Math.max(0, moment.timestamp - current.refilledAtMs)
      : 0
    const available = current
      ? Math.min(maximum, current.tokens + (elapsedMs * maximum / moment.windowMs))
      : maximum
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
    if (!['primary', 'enrichment'].includes(callRole)) {
      throw new TypeError('callRole must be primary or enrichment')
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
      ...callInput
    } = input
    const call = {
      id,
      ...clone(callInput),
      callOrdinal,
      callRole,
      dispatchFingerprint,
      providerKey: this.providerKey,
      outcome: 'pending',
      ...(costControl ? {
        costMinor: costControl.costMinor,
        costKind: costControl.costKind,
        currency: costControl.currency,
      } : {}),
      startedAt: iso(),
      completedAt: null,
    }
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
    Object.assign(this.state, {
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastSuccessAt: call.completedAt,
      lastErrorCode: null,
    })
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
      Object.assign(this.state, {
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastSuccessAt: call.completedAt,
        lastErrorCode: null,
      })
    } else if (affectsCircuit) {
      this.#recordFailure(errorCode)
    }
    return { snapshot: clone(storedSnapshot) }
  }

  async commitSnapshotDelivery({
    delivery,
    snapshot,
    sourceMode,
    responseBody = snapshot.responseBody,
    usageUnitsActual = Math.max(1, deliveredItemCount(responseBody)),
  }) {
    const current = this.snapshots.get(snapshotKey(delivery))
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

  #recordFailure(errorCode) {
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
    if (affectsCircuit) this.#recordFailure(errorCode)
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
    else await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release(releaseError)
  }
}

async function postgresProviderCostState(client, {
  providerKey,
  usageRequestId,
  currency,
  reservationId = null,
}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `external-platform-cost:${providerKey}`,
  ])
  const exposure = await client.query(
    `WITH monthly_calls AS MATERIALIZED (
       SELECT usage_request_id, cost_minor, cost_kind, currency
         FROM external_platform.provider_calls
        WHERE provider_key = $1
          AND started_at >= (
            date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
          AND started_at < (
            (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month')
              AT TIME ZONE 'UTC'
          )
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
            ) AS known_cost_minor,
            (
              SELECT count(*)::integer
                FROM monthly_calls
               WHERE (cost_kind <> 'unknown' AND (cost_minor IS NULL OR cost_minor <= 0))
                  OR (cost_minor IS NOT NULL AND currency IS DISTINCT FROM $2)
            ) AS unknown_cost_calls,
            (
              SELECT count(*)::integer
                FROM monthly_calls
               WHERE usage_request_id = $3
                 AND (
                   cost_kind IS NULL
                   OR cost_kind NOT IN ('estimated', 'provider_reported')
                   OR cost_minor IS NULL
                   OR cost_minor <= 0
                   OR currency IS DISTINCT FROM $2
                 )
            ) AS current_unknown_cost_calls,
            (SELECT cost_minor FROM subsidy_exposure) AS subsidy_cost_minor,
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
              SELECT cost_minor FROM usage_costs WHERE usage_request_id = $3
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
  const row = exposure.rows[0] || {}
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
    uncertainCooldownMs = 15 * 60_000,
  }) {
    this.pool = pool
    this.providerKey = providerKey
    this.authorizationPlatform = authorizationPlatform
    this.queueName = queueName
    this.circuitFailureThreshold = circuitFailureThreshold
    this.circuitOpenMs = circuitOpenMs
    this.uncertainCooldownMs = uncertainCooldownMs
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

  async reapStaleCalls() {
    // This second pass closes a narrow race where the usage reaper began before
    // beginProviderCall committed and therefore could not see the new call in
    // its original statement snapshot.
    const { rows } = await this.pool.query(
      `UPDATE external_platform.provider_calls call SET
         outcome = 'unknown', error_code = 'reservation_lease_expired',
         completed_at = now()
       FROM usage_requests request
       WHERE call.usage_request_id = request.id
         AND call.outcome = 'pending'
         AND request.status = 'unknown'
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
  }) {
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
                   )
                   OR (
                     call.endpoint_key = $7
                     AND call.contract_version = $9
                     AND call.outcome = 'succeeded_unusable'
                     AND call.error_code IS DISTINCT FROM 'upstream_note_unavailable'
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
                 AND call.completed_at > now() - make_interval(secs => $6)
               )
             )
        )
       ON CONFLICT (consumer_id, operation, request_fingerprint) DO UPDATE SET
         owner_request_id = EXCLUDED.owner_request_id,
         expires_at = EXCLUDED.expires_at,
         created_at = now()
       WHERE external_platform.dispatch_leases.expires_at <= now()
       RETURNING owner_request_id, expires_at`,
      [
        consumerId, operation, fingerprint, ownerRequestId, expiresAt,
        Math.ceil(this.uncertainCooldownMs / 1_000),
        endpointKey,
        retryOfRequestId,
        contractVersion,
        this.providerKey,
      ],
    )
    if (rows[0]?.owner_request_id === ownerRequestId) return { kind: 'acquired' }

    const blocker = await this.pool.query(
      `SELECT outcome, error_code, completed_at,
              CASE
                WHEN outcome = 'pending' THEN NULL
                ELSE completed_at + make_interval(secs => $4)
              END AS blocked_until
         FROM external_platform.provider_calls
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
                )
                OR (
                  endpoint_key = $5
                  AND contract_version = $7
                  AND outcome = 'succeeded_unusable'
                  AND error_code IS DISTINCT FROM 'upstream_note_unavailable'
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
              AND completed_at > now() - make_interval(secs => $4)
            )
          )
        ORDER BY started_at DESC
        LIMIT 1`,
      [
        consumerId, operation, fingerprint,
        Math.ceil(this.uncertainCooldownMs / 1_000), endpointKey, retryOfRequestId,
        contractVersion,
        this.providerKey,
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

  async releaseDispatchLease({ consumerId, operation, fingerprint, ownerRequestId }) {
    await this.pool.query(
      `DELETE FROM external_platform.dispatch_leases
        WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
          AND owner_request_id = $4`,
      [consumerId, operation, fingerprint, ownerRequestId],
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
    const duration = boundedRateLimit(windowMs, 'windowMs')
    if (duration < 1_000 || duration > 3_600_000) {
      throw new TypeError('windowMs must be between 1000 and 3600000')
    }
    const { rows } = await this.pool.query(
      `WITH db_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS observed_at
       )
       INSERT INTO external_platform.provider_rate_buckets AS bucket
         (provider_key, capacity, window_ms, tokens, last_admitted, refilled_at, updated_at)
       SELECT $1, $2, $3, ($2 - $4)::double precision, true,
              db_clock.observed_at, db_clock.observed_at
         FROM db_clock
       ON CONFLICT (provider_key) DO UPDATE SET
         capacity = EXCLUDED.capacity,
         window_ms = EXCLUDED.window_ms,
         tokens = CASE
           WHEN least(
             EXCLUDED.capacity::double precision,
             bucket.tokens + greatest(
               0::double precision,
               extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
                 * 1000::double precision
                 * EXCLUDED.capacity::double precision
                 / EXCLUDED.window_ms::double precision
             )
           ) >= $4::double precision
             THEN least(
               EXCLUDED.capacity::double precision,
               bucket.tokens + greatest(
                 0::double precision,
                 extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
                   * 1000::double precision
                   * EXCLUDED.capacity::double precision
                   / EXCLUDED.window_ms::double precision
               )
             ) - $4::double precision
           ELSE least(
             EXCLUDED.capacity::double precision,
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
           EXCLUDED.capacity::double precision,
           bucket.tokens + greatest(
             0::double precision,
             extract(epoch FROM (EXCLUDED.refilled_at - bucket.refilled_at))::double precision
               * 1000::double precision
               * EXCLUDED.capacity::double precision
               / EXCLUDED.window_ms::double precision
           )
         ) >= $4::double precision,
         refilled_at = EXCLUDED.refilled_at,
         updated_at = EXCLUDED.refilled_at
       RETURNING last_admitted AS allowed,
         floor(tokens)::bigint AS remaining,
         CASE WHEN last_admitted THEN 0::bigint ELSE greatest(
           1::bigint,
           ceil(($4::double precision - tokens) * window_ms::double precision
             / capacity::double precision)::bigint
         ) END AS retry_after_ms`,
      [this.providerKey, maximum, duration, requested],
    )
    if (!rows[0]) throw new Error('Provider rate bucket returned no state')
    return {
      allowed: rows[0].allowed === true,
      remaining: Math.max(0, Number(rows[0].remaining)),
      retryAfterMs: Math.max(0, Number(rows[0].retry_after_ms)),
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
        // Provider lock order is shared with beginProviderCall: provider first,
        // then the usage row. This prevents a workflow reservation racing a
        // standalone call or a usage release on another Hub replica.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `external-platform-cost:${this.providerKey}`,
        ])
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

  async releaseProviderCostWorkflow({ reservationId, usageRequestId }) {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `external-platform-cost:${this.providerKey}`,
      ])
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

  async beginProviderCall(input) {
    const id = input.id ?? randomUUID()
    const callOrdinal = input.callOrdinal ?? 0
    if (!Number.isSafeInteger(callOrdinal) || callOrdinal < 0) {
      throw new TypeError('callOrdinal must be a non-negative safe integer')
    }
    const callRole = input.callRole ?? (callOrdinal === 0 ? 'primary' : 'enrichment')
    if (!['primary', 'enrichment'].includes(callRole)) {
      throw new TypeError('callRole must be primary or enrichment')
    }
    const costControl = normalizedCostControl(input.costControl)
    const values = [
      id, input.tenantId, input.consumerId, input.apiKeyId, input.usageRequestId,
      input.operation, input.contractVersion, input.endpointKey,
      input.endpointVersion, input.marketplace, input.fingerprint,
      input.retryOfRequestId ?? null, this.providerKey, this.authorizationPlatform,
      callOrdinal, callRole, input.dispatchFingerprint ?? input.fingerprint,
      ...(costControl ? [costControl.costMinor, costControl.costKind, costControl.currency] : []),
    ]
    try {
      return await transaction(this.pool, async (client) => {
        if (costControl) {
          const state = await postgresProviderCostState(client, {
            providerKey: this.providerKey,
            usageRequestId: input.usageRequestId,
            currency: costControl.currency,
            reservationId: input.costReservationId ?? null,
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
              dispatch_fingerprint${costControl ? ', cost_minor, cost_kind, currency' : ''})
           SELECT $1, $13, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                  $15, $16, $17${costControl ? ', $18, $19, $20' : ''}
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
        await client.query(
          `UPDATE external_platform.provider_state
              SET last_call_at = $1, updated_at = now()
            WHERE provider_key = $2`,
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
            ${costControl ? `AND call.cost_minor = $18
            AND call.cost_kind = $19
            AND call.currency = $20` : ''}
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
      const ingestResult = await queryable.query(
        `SELECT queue, payload, dedupe_key, priority
           FROM mxq.jobs
          WHERE queue = $1 AND dedupe_key IS NOT DISTINCT FROM $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.ingestJob.queue || this.queueName, input.ingestJob.dedupeKey ?? null],
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
      await client.query(
        `UPDATE external_platform.provider_state SET
           consecutive_failures = 0, circuit_open_until = NULL,
           last_success_at = now(), last_error_code = NULL, updated_at = now()
         WHERE provider_key = $1`,
        [this.providerKey],
      )
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
        await client.query(
          `UPDATE external_platform.provider_state SET
             consecutive_failures = 0, circuit_open_until = NULL,
             last_success_at = now(), last_error_code = NULL, updated_at = now()
           WHERE provider_key = $1`,
          [this.providerKey],
        )
      } else if (affectsCircuit) {
        await this.#advanceFailureState(client, errorCode)
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
    responseBody = snapshot.responseBody,
    usageUnitsActual = Math.max(1, deliveredItemCount(responseBody)),
  }) {
    return transaction(this.pool, async (client) => {
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

  async #advanceFailureState(client, errorCode) {
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
        await this.#advanceFailureState(client, errorCode)
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

      const usage = outcome === 'rejected' || outcome === 'succeeded_unusable'
        ? await client.query(
            `UPDATE usage_requests SET
               status = 'committed', response_status = $2, response_body = $3,
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
    for (const [ordinal, object] of archiveObjects.entries()) {
      if (object.capturedDate !== capturedDate) {
        throw new AppError(
          500,
          'external_platform_archive_date_invalid',
          'External platform archive date does not match its UTC capture time',
        )
      }
      await client.query(
        `INSERT INTO external_platform.archive_objects
           (id, provider_key, object_kind, marketplace, operation, endpoint_version,
            captured_date, archive_path, response_pointer, source_key, payload_sha256,
            raw_payload, provider_call_id, item_ordinal)
         VALUES ($1, $14, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (provider_call_id, item_ordinal) DO NOTHING`,
        [
          randomUUID(), object.kind === 'response' ? 'response' : 'item',
          object.marketplace, delivery.operation, object.endpointVersion,
          capturedDate, object.archivePath, object.envelopePointer || '$', object.sourceKey,
          object.payloadSha256, object.rawPayload, callId, ordinal,
          this.providerKey,
        ],
      )
    }
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
