import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const clone = (value) => value == null ? value : structuredClone(value)
const iso = (value = new Date()) => new Date(value).toISOString()
const number = (value) => value == null ? null : Number(value)

function snapshotKey({ consumerId, operation, fingerprint }) {
  return `${consumerId}\u0000${operation}\u0000${fingerprint}`
}

function requestEvent(input, overrides = {}) {
  return {
    id: randomUUID(),
    providerKey: 'justone',
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
    circuitFailureThreshold = 3,
    circuitOpenMs = 60_000,
    uncertainCooldownMs = 15 * 60_000,
  } = {}) {
    this.usageStore = usageStore
    this.circuitFailureThreshold = circuitFailureThreshold
    this.circuitOpenMs = circuitOpenMs
    this.uncertainCooldownMs = uncertainCooldownMs
    this.calls = new Map()
    this.responseArchives = new Map()
    this.snapshots = new Map()
    this.requests = []
    this.leases = new Map()
    this.state = {
      providerKey: 'justone',
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
    ownerRequestId,
    expiresAt,
  }) {
    const now = Date.now()
    const blocker = [...this.calls.values()]
      .filter((call) => (
        call.operation === operation
        && (
          (
            call.consumerId === consumerId
            && call.fingerprint === fingerprint
            && call.outcome === 'pending'
          )
          || (
            (
              (
                call.consumerId === consumerId
                && call.fingerprint === fingerprint
                && call.outcome === 'unknown'
              )
              || (call.endpointKey === endpointKey && call.outcome === 'succeeded_unusable')
            )
            && new Date(call.completedAt).getTime() + this.uncertainCooldownMs > now
          )
        )
      ))
      .sort((left, right) => new Date(right.startedAt) - new Date(left.startedAt))[0]
    if (blocker) {
      return {
        kind: 'blocked',
        reason: blocker.outcome,
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

  async providerState() {
    return clone(this.state)
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
      || usage.platform !== 'ecommerce'
      || (leaseExpiresAt != null && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()))
    ) {
      throw new AppError(
        409,
        'external_platform_usage_scope_mismatch',
        'Provider call does not match its reserved usage request',
      )
    }
    const id = input.id ?? randomUUID()
    if (
      this.calls.has(id)
      || [...this.calls.values()].some((call) => call.usageRequestId === input.usageRequestId)
    ) {
      throw new AppError(409, 'external_platform_call_exists', 'Usage request already owns a provider call')
    }
    const call = {
      id,
      ...clone(input),
      providerKey: 'justone',
      outcome: 'pending',
      startedAt: iso(),
      completedAt: null,
    }
    this.calls.set(call.id, call)
    this.state.lastCallAt = call.startedAt
    return clone(call)
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
    billed,
    costMinor,
    costKind,
    currency,
    archiveObjects = [],
    responseArchive = null,
    upstreamEvidence = null,
  }) {
    const call = this.calls.get(callId)
    if (!call || call.outcome !== 'pending') {
      throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
    }
    await this.usageStore.commitRequest(delivery.usageRequestId, {
      responseStatus: 200,
      responseBody,
      unitsActual: Math.max(1, itemCount),
      upstreamLatencyMs: latencyMs,
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
    const key = snapshotKey(delivery)
    const snapshot = {
      id: this.snapshots.get(key)?.id ?? randomUUID(),
      providerKey: 'justone',
      consumerId: delivery.consumerId,
      operation: delivery.operation,
      fingerprint: delivery.fingerprint,
      responseBody: clone(snapshotBody),
      capturedAt: iso(capturedAt),
      freshUntil: iso(freshUntil),
      staleUntil: iso(staleUntil),
      lastSuccessCallId: callId,
    }
    this.snapshots.set(key, snapshot)
    this.requests.push(requestEvent({
      ...delivery,
      sourceMode: 'live',
      succeeded: true,
      responseStatus: 200,
      providerCallId: callId,
      snapshotId: snapshot.id,
    }))
    Object.assign(this.state, {
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      lastSuccessAt: call.completedAt,
      lastErrorCode: null,
    })
    return { snapshot: clone(snapshot) }
  }

  async commitSnapshotDelivery({ delivery, snapshot, sourceMode, responseBody = snapshot.responseBody }) {
    await this.usageStore.commitRequest(delivery.usageRequestId, {
      responseStatus: 200,
      responseBody,
      unitsActual: Math.max(1, responseBody?.data?.items?.length || 0),
      upstreamLatencyMs: 0,
    })
    this.requests.push(requestEvent({
      ...delivery,
      sourceMode,
      succeeded: true,
      responseStatus: 200,
      snapshotId: snapshot.id,
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
    upstreamEvidence = null,
    archiveObjects = [],
    snapshot = null,
    fallbackResponseBody = snapshot?.responseBody,
  }) {
    const call = this.calls.get(callId)
    if (!call || call.outcome !== 'pending') {
      throw new AppError(409, 'external_platform_call_state_conflict', 'Provider call is not pending')
    }
    if (snapshot) {
      await this.usageStore.commitRequest(delivery.usageRequestId, {
        responseStatus: 200,
        responseBody: fallbackResponseBody,
        unitsActual: Math.max(1, fallbackResponseBody?.data?.items?.length || 0),
        upstreamLatencyMs: latencyMs,
      })
    } else if (outcome === 'rejected') {
      await this.usageStore.commitRequest(delivery.usageRequestId, {
        responseStatus: failureResponseStatus,
        responseBody: failureResponseBody || {
          error: { code: errorCode, message: 'External data platform rejected the request' },
        },
        unitsActual: 0,
        upstreamLatencyMs: latencyMs,
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
    if (affectsCircuit) this.#recordFailure(errorCode)
    if (snapshot) {
      this.requests.push(requestEvent({
        ...delivery,
        sourceMode: 'stored_fallback',
        succeeded: true,
        responseStatus: 200,
        providerCallId: callId,
        snapshotId: snapshot.id,
        errorCode,
      }))
      return
    }
    this.requests.push(requestEvent({
      ...delivery,
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
    upstreamEvidence = null,
    archiveObjects = [],
    errorCode = 'external_platform_persistence_unknown',
  }) {
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
    this.requests.push(requestEvent({
      ...delivery,
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
      sourceMode,
      succeeded,
      responseStatus: status,
      errorCode,
    }))
  }

  async recordGatewayAttempt({ delivery, sourceMode, succeeded, status, errorCode = null }) {
    this.requests.push(requestEvent({
      ...delivery,
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
    queueName = 'mx-insight-hub:ingest',
    circuitFailureThreshold = 3,
    circuitOpenMs = 60_000,
    uncertainCooldownMs = 15 * 60_000,
  }) {
    this.pool = pool
    this.queueName = queueName
    this.circuitFailureThreshold = circuitFailureThreshold
    this.circuitOpenMs = circuitOpenMs
    this.uncertainCooldownMs = uncertainCooldownMs
  }

  async snapshotFor({ consumerId, operation, fingerprint }, at = new Date()) {
    const { rows } = await this.pool.query(
      `SELECT * FROM external_platform.response_snapshots
        WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
          AND stale_until >= $4`,
      [consumerId, operation, fingerprint, at],
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
    ownerRequestId,
    expiresAt,
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO external_platform.dispatch_leases
         (consumer_id, operation, request_fingerprint, owner_request_id, expires_at)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (
          SELECT 1
            FROM external_platform.provider_calls call
           WHERE call.provider_key = 'justone'
             AND call.operation = $2
             AND (
               (
                 call.consumer_id = $1
                 AND call.request_fingerprint = $3
                 AND call.outcome = 'pending'
               )
               OR (
                 (
                   (
                     call.consumer_id = $1
                     AND call.request_fingerprint = $3
                     AND call.outcome = 'unknown'
                   )
                   OR (call.endpoint_key = $7 AND call.outcome = 'succeeded_unusable')
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
      ],
    )
    if (rows[0]?.owner_request_id === ownerRequestId) return { kind: 'acquired' }

    const blocker = await this.pool.query(
      `SELECT outcome, completed_at,
              CASE
                WHEN outcome = 'pending' THEN NULL
                ELSE completed_at + make_interval(secs => $4)
              END AS blocked_until
         FROM external_platform.provider_calls
        WHERE provider_key = 'justone'
          AND operation = $2
          AND (
            (
              consumer_id = $1
              AND request_fingerprint = $3
              AND outcome = 'pending'
            )
            OR (
              (
                (
                  consumer_id = $1
                  AND request_fingerprint = $3
                  AND outcome = 'unknown'
                )
                OR (endpoint_key = $5 AND outcome = 'succeeded_unusable')
              )
              AND completed_at > now() - make_interval(secs => $4)
            )
          )
        ORDER BY started_at DESC
        LIMIT 1`,
      [
        consumerId, operation, fingerprint,
        Math.ceil(this.uncertainCooldownMs / 1_000), endpointKey,
      ],
    )
    if (blocker.rows[0]) {
      return {
        kind: 'blocked',
        reason: blocker.rows[0].outcome,
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

  async providerState(providerKey = 'justone') {
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

  async beginProviderCall(input) {
    const id = input.id ?? randomUUID()
    const values = [
      id, input.tenantId, input.consumerId, input.apiKeyId, input.usageRequestId,
      input.operation, input.contractVersion, input.endpointKey,
      input.endpointVersion, input.marketplace, input.fingerprint,
    ]
    try {
      return await transaction(this.pool, async (client) => {
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
                AND request.platform = 'ecommerce'
                AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())
              FOR UPDATE
           )
           INSERT INTO external_platform.provider_calls
             (id, provider_key, tenant_id, consumer_id, api_key_id, usage_request_id,
              operation, contract_version, endpoint_key, endpoint_version, marketplace,
              request_fingerprint)
           SELECT $1, 'justone', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
             FROM owned_request
           RETURNING id, started_at`,
          values,
        )
        if (!rows[0]) {
          throw new AppError(
            409,
            'external_platform_usage_scope_mismatch',
            'Provider call does not match its reserved usage request',
          )
        }
        await client.query(
          `UPDATE external_platform.provider_state
              SET last_call_at = $1, updated_at = now()
            WHERE provider_key = 'justone'`,
          [rows[0].started_at],
        )
        return { id, startedAt: iso(rows[0].started_at) }
      })
    } catch (error) {
      // A lost COMMIT acknowledgement is not evidence that the INSERT failed.
      // Reconcile by the preselected call id before allowing the caller to
      // release or reuse the usage reservation.
      const reconciled = await this.pool.query(
        `SELECT call.id, call.started_at
           FROM external_platform.provider_calls call
           JOIN usage_requests request ON request.id = call.usage_request_id
          WHERE call.id = $1
            AND call.provider_key = 'justone'
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
            AND call.outcome = 'pending'
            AND request.status = 'reserved'
            AND request.platform = 'ecommerce'
            AND (request.lease_expires_at IS NULL OR request.lease_expires_at > now())`,
        values,
      ).catch(() => ({ rows: [] }))
      if (reconciled.rows[0]) {
        return { id, startedAt: iso(reconciled.rows[0].started_at) }
      }
      throw error
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
    billed,
    costMinor,
    costKind,
    currency,
    archiveObjects = [],
    responseArchive = null,
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

      const snapshotId = randomUUID()
      const snapshotResult = await client.query(
        `INSERT INTO external_platform.response_snapshots
           (id, provider_key, consumer_id, operation, request_fingerprint,
            response_body, captured_at, fresh_until, stale_until, last_success_call_id)
         VALUES ($1, 'justone', $2, $3, $4, $5, $6, $7, $8, $9)
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
          snapshotId, delivery.consumerId, delivery.operation, delivery.fingerprint,
          snapshotBody, capturedAt, freshUntil, staleUntil, callId,
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
        [delivery.usageRequestId, responseBody, Math.max(1, itemCount), latencyMs, capturedAt],
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
         WHERE provider_key = 'justone'`,
      )
      if (ingestJob) {
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
      return { snapshot }
    })
  }

  async commitSnapshotDelivery({ delivery, snapshot, sourceMode, responseBody = snapshot.responseBody }) {
    return transaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM external_platform.response_snapshots
          WHERE id = $1 AND consumer_id = $2 AND operation = $3
            AND request_fingerprint = $4 AND stale_until >= now()
          FOR SHARE`,
        [snapshot.id, delivery.consumerId, delivery.operation, delivery.fingerprint],
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
          Math.max(1, responseBody?.data?.items?.length || 0),
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
       WHERE provider_key = 'justone'`,
      [this.circuitFailureThreshold, Math.ceil(this.circuitOpenMs / 1_000), errorCode],
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
    upstreamEvidence = null,
    archiveObjects = [],
    snapshot = null,
    fallbackResponseBody = snapshot?.responseBody,
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
      await this.#insertArchiveObjects(client, {
        callId,
        delivery,
        capturedAt: responseArchive?.capturedAt ?? new Date(),
        archiveObjects,
      })
      if (affectsCircuit) await this.#advanceFailureState(client, errorCode)
      if (snapshot) {
        const locked = await client.query(
          `SELECT * FROM external_platform.response_snapshots
            WHERE id = $1 AND consumer_id = $2 AND operation = $3
              AND request_fingerprint = $4 AND stale_until >= now()
            FOR SHARE`,
          [snapshot.id, delivery.consumerId, delivery.operation, delivery.fingerprint],
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
            Math.max(1, fallbackResponseBody?.data?.items?.length || 0),
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

      const usage = outcome === 'rejected'
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

  async #insertGatewayRequest(client, input) {
    await client.query(
      `INSERT INTO external_platform.gateway_requests
         (id, provider_key, tenant_id, consumer_id, usage_request_id,
          request_fingerprint, source_mode, succeeded, response_status,
          provider_call_id, snapshot_id, error_code)
       VALUES ($1, 'justone', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(), input.tenantId, input.consumerId, input.usageRequestId,
        input.fingerprint, input.sourceMode, input.succeeded,
        input.responseStatus, input.providerCallId ?? null, input.snapshotId ?? null,
        input.errorCode ?? null,
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
         VALUES ($1, 'justone', $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (provider_call_id, item_ordinal) DO NOTHING`,
        [
          randomUUID(), object.kind === 'response' ? 'response' : 'item',
          object.marketplace, delivery.operation, object.endpointVersion,
          capturedDate, object.archivePath, object.envelopePointer || '$', object.sourceKey,
          object.payloadSha256, object.rawPayload, callId, ordinal,
        ],
      )
    }
  }

  async analytics({ from, bucket = 'hour' }) {
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
          WHERE provider_key = 'justone' AND created_at >= $1`,
        [from],
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
          WHERE provider_key = 'justone' AND started_at >= $1`,
        [from],
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
            WHERE provider_key = 'justone' AND created_at >= $1
            GROUP BY 1
         ), calls AS (
           SELECT date_trunc('${bucketSql}', started_at) AS bucket,
                  count(*)::integer AS upstream_calls,
                  sum(cost_minor) FILTER (WHERE cost_minor IS NOT NULL)::bigint AS cost_minor
             FROM external_platform.provider_calls
            WHERE provider_key = 'justone' AND started_at >= $1
            GROUP BY 1
         )
         SELECT requests.*, coalesce(calls.upstream_calls, 0)::integer AS upstream_calls,
                calls.cost_minor
           FROM requests LEFT JOIN calls USING (bucket)
          ORDER BY bucket`,
        [from],
      ),
      this.pool.query(
        `SELECT tenant.id, tenant.name,
                count(request.id)::integer AS hub_requests,
                count(request.id) FILTER (WHERE request.succeeded)::integer AS succeeded,
                count(call.id)::integer AS upstream_calls,
                sum(call.cost_minor) FILTER (WHERE call.cost_minor IS NOT NULL)::bigint AS cost_minor
           FROM external_platform.gateway_requests request
           JOIN tenants tenant ON tenant.id = request.tenant_id
           LEFT JOIN external_platform.provider_calls call
             ON call.id = request.provider_call_id
          WHERE request.provider_key = 'justone' AND request.created_at >= $1
          GROUP BY tenant.id, tenant.name
          ORDER BY hub_requests DESC, tenant.name
          LIMIT 20`,
        [from],
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
          WHERE provider_key = 'justone' AND started_at >= $1
          GROUP BY endpoint_key, endpoint_version, marketplace
          ORDER BY calls DESC, endpoint_key`,
        [from],
      ),
      this.providerState('justone'),
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
    row.upstreamCalls += request.providerCallId ? 1 : 0
    tenantMap.set(request.tenantId, row)
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
