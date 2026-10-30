import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

// No calendar estimates or periodic probes. A trusted supplier reset permits
// one real business request; an administrator may explicitly authorize one.
export function facebookRecoveryCheckAt(state, now) {
  if (['rate_limited', 'quota_unknown'].includes(state.reason) && state.blocked_until && new Date(state.blocked_until).getTime() > now) {
    return new Date(state.blocked_until).getTime()
  }
  if (state.manual_check_until && new Date(state.manual_check_until).getTime() > now) return now
  return state.reset_at ? new Date(state.reset_at).getTime() : null
}

export function facebookRapidAvailable(state, now) {
  if (state.mode && !['auto', 'rapidapi'].includes(state.mode)) return false
  const reason = state.availability_reason ?? state.reason
  if (['rate_limited', 'quota_unknown'].includes(reason) && state.blocked_until && new Date(state.blocked_until).getTime() > now) return false
  const checkAt = facebookRecoveryCheckAt({ ...state, reason }, now)
  if (checkAt != null && checkAt <= now) return true
  if (['quota_unknown', 'recovery_probe', 'quota_exhausted'].includes(reason)) return false
  return state.remaining > 0 || (state.remaining == null && state.used === 0 && !reason)
}

export class PlatformSearchPolicyStore {
  constructor(pool) { this.pool = pool }
  async list() {
    if (!this.pool) return []
    const { rows } = await this.pool.query(`SELECT p.*, s.used, s.remaining, s.reset_at, s.blocked_until, s.reason AS availability_reason,
      s.lease_until, s.supplier_remaining, s.supplier_limit, s.supplier_observed_at, s.manual_check_until, jsonb_array_length(s.waiters) AS queue_depth, s.updated_at AS observed_at, now() AS checked_at FROM control.platform_search_policies p
      LEFT JOIN control.facebook_rapid_quota s ON p.platform='facebook' ORDER BY p.platform`)
    return rows.map(({ checked_at: checkedAt, ...row }) => {
      if (row.platform !== 'facebook') return row
      const now = new Date(checkedAt).getTime()
      const checkAt = facebookRecoveryCheckAt({ ...row, reason: row.availability_reason }, now)
      return { ...row, available_included: row.remaining,
        rapid_available: facebookRapidAvailable(row, now),
        next_recovery_check_at: checkAt == null ? null : new Date(checkAt) }
    })
  }
  async facebook() {
    const policy = (await this.list()).find(row => row.platform === 'facebook')
    if (!policy) throw new AppError(503, 'platform_search_policy_unavailable', 'Search strategy is unavailable')
    return policy
  }
  async update(platform, input) {
    if (platform !== 'facebook') throw new AppError(400, 'platform_search_policy_read_only', 'This platform retains its existing route')
    if (!input || Object.keys(input).some(k => !['mode', 'monthlyLimit', 'probeIntervalHours', 'billingCycleDay', 'billingProbeIntervalHours', 'expectedRevision', 'reason'].includes(k))
      || !['auto', 'rapidapi', 'justone', 'paused'].includes(input.mode)
      || (input.monthlyLimit !== undefined && (!Number.isInteger(input.monthlyLimit) || input.monthlyLimit < 1 || input.monthlyLimit > 1000000))
      || (input.probeIntervalHours !== undefined && (!Number.isInteger(input.probeIntervalHours) || input.probeIntervalHours < 24 || input.probeIntervalHours > 744))
      || (input.billingCycleDay !== undefined && (!Number.isInteger(input.billingCycleDay) || input.billingCycleDay < 1 || input.billingCycleDay > 31))
      || (input.billingProbeIntervalHours !== undefined && (!Number.isInteger(input.billingProbeIntervalHours) || input.billingProbeIntervalHours < 1 || input.billingProbeIntervalHours > 24))
      || !Number.isSafeInteger(input.expectedRevision) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_platform_search_policy', 'Provide mode, revision and reason')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const changed = await client.query(`UPDATE control.platform_search_policies SET mode=$1, monthly_limit=coalesce($2,monthly_limit),
        probe_interval_hours=coalesce($3,probe_interval_hours), revision=revision+1, reason=$4, updated_at=now(),
        billing_cycle_day=coalesce($7,billing_cycle_day), billing_probe_interval_hours=coalesce($8,billing_probe_interval_hours)
        WHERE platform=$5 AND revision=$6 RETURNING *`, [input.mode, input.monthlyLimit ?? null, input.probeIntervalHours ?? null, input.reason.trim(), platform, input.expectedRevision,
        input.billingCycleDay ?? null, input.billingProbeIntervalHours ?? null])
      if (!changed.rows.length) throw new AppError(409, 'platform_search_revision_conflict', 'Strategy changed; refresh before saving')
      await client.query(`INSERT INTO control.platform_search_policy_events(platform,revision,actor,policy)
        VALUES($1,$2,'admin-token',$3::jsonb)`, [platform, changed.rows[0].revision, JSON.stringify(changed.rows[0])])
      await client.query('COMMIT')
      return changed.rows[0]
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  async requestRapidCheck(input) {
    if (!input || Object.keys(input).some(key => !['expectedObservedAt', 'reason'].includes(key))
      || typeof input.expectedObservedAt !== 'string' || !Number.isFinite(Date.parse(input.expectedObservedAt))
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_facebook_quota_check', 'Provide the observed quota version and a reason')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '1s'")
      await client.query("SET LOCAL statement_timeout = '3s'")
      const { rows: [state] } = await client.query(`SELECT s.*,p.mode,now() AS checked_at
        FROM control.facebook_rapid_quota s CROSS JOIN control.platform_search_policies p
        WHERE s.singleton AND p.platform='facebook' FOR UPDATE OF s FOR SHARE OF p`)
      if (!state) throw new AppError(503, 'platform_search_policy_unavailable', 'Search strategy is unavailable')
      const now = new Date(state.checked_at).getTime()
      if (new Date(state.updated_at).getTime() !== Date.parse(input.expectedObservedAt)) {
        throw new AppError(409, 'facebook_quota_changed', 'Quota changed; refresh before authorizing a check')
      }
      if (!['auto', 'rapidapi'].includes(state.mode) || new Date(state.lease_until).getTime() > now
        || new Date(state.manual_check_until).getTime() > now) {
        throw new AppError(409, 'facebook_quota_check_unavailable', 'A check is pending, in flight, or the strategy does not allow RapidAPI')
      }
      const expiresAt = new Date(now + 5 * 60000)
      await client.query(`INSERT INTO control.facebook_rapid_check_events(id,reason,expires_at,quota_observed_at)
        VALUES($1,$2,$3,$4)`, [randomUUID(), input.reason.trim(), expiresAt, state.updated_at])
      await client.query(`UPDATE control.facebook_rapid_quota SET manual_check_until=$1,updated_at=clock_timestamp() WHERE singleton`, [expiresAt])
      await client.query('COMMIT')
      return { expiresAt, dispatched: false }
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  // One admitted RapidAPI request at a time for this subscription. This also
  // makes a remaining=1 response safe across Hub replicas and ordered headers.
  async admitRapid(ticket = null) {
    if (ticket && (!UUID.test(ticket.id || '') || !UUID.test(ticket.requestId || '')
      || !Number.isSafeInteger(ticket.deadline))) throw new AppError(400, 'invalid_facebook_admission', 'Invalid admission identity')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '1s'")
      await client.query("SET LOCAL statement_timeout = '3s'")
      const { rows: [s] } = await client.query(`SELECT s.*, p.monthly_limit, p.probe_interval_hours, p.billing_cycle_day, p.billing_probe_interval_hours, p.mode,
        now() AS checked_at FROM control.facebook_rapid_quota s CROSS JOIN control.platform_search_policies p
        WHERE p.platform='facebook' FOR UPDATE OF s FOR SHARE OF p`)
      if (!s) throw new AppError(503, 'platform_search_policy_unavailable', 'Search strategy is unavailable')
      const now = new Date(s.checked_at).getTime()
      let waiters = (s.waiters || []).filter(row => row.deadline > now)
      const finish = async reason => {
        if (ticket && reason !== 'source_busy') waiters = waiters.filter(row => row.id !== ticket.id)
        await client.query('UPDATE control.facebook_rapid_quota SET waiters=$1::jsonb WHERE singleton', [JSON.stringify(waiters)])
        await client.query('COMMIT')
        return { allowed: false, reason, used: s.used, remaining: s.remaining, queueDepth: waiters.length }
      }
      let used = s.used, remaining = s.remaining, resetAt = s.reset_at, blockedUntil = s.blocked_until
      const elapsedReset = resetAt && new Date(resetAt).getTime() <= now
      const manual = s.manual_check_until && new Date(s.manual_check_until).getTime() > now
      const initial = used === 0 && remaining == null && s.reason == null
      const probe = remaining == null || remaining === 0 || Boolean(elapsedReset) || Boolean(manual)
        || ['quota_exhausted', 'recovery_probe', 'quota_unknown'].includes(s.reason)
      let reason = null
      if (!['auto', 'rapidapi'].includes(s.mode)) reason = 'strategy_changed'
      else if (s.lease_until && new Date(s.lease_until).getTime() > now) reason = 'source_busy'
      else if ((s.reason === 'quota_unknown' || (ticket?.hubRateLimitExempt !== true && s.reason === 'rate_limited'))
        && blockedUntil && new Date(blockedUntil).getTime() > now) reason = 'rate_limited'
      if (!reason && probe && !initial) {
        const checkAt = facebookRecoveryCheckAt(s, now)
        if (checkAt == null || checkAt > now) reason = remaining === 0 ? 'quota_exhausted' : 'quota_unknown'
      }
      if (reason) {
        // Busy callers join below; terminal quota/policy decisions do not wait.
        if (reason !== 'source_busy') return await finish(reason)
      }
      if (ticket) {
        if (ticket.deadline <= now) return await finish('queue_timeout')
        const existing = waiters.find(row => row.id === ticket.id)
        if (existing && (existing.requestId !== ticket.requestId || existing.deadline !== ticket.deadline)) {
          throw new AppError(409, 'facebook_admission_conflict', 'Admission identity changed')
        }
        if (!existing) {
          if (waiters.length >= 32) return await finish('queue_full')
          waiters.push({ id: ticket.id, requestId: ticket.requestId, deadline: ticket.deadline })
        }
      }
      if (reason === 'source_busy' || (waiters.length && waiters[0].id !== ticket?.id)) return await finish('source_busy')
      if (ticket) waiters = waiters.filter(row => row.id !== ticket.id)
      const token = randomUUID()
      if (elapsedReset) resetAt = null
      await client.query(`UPDATE control.facebook_rapid_quota SET used=$1,remaining=$2,reset_at=$3,
        blocked_until=$4,lease_token=$5,lease_until=now()+interval '2 minutes',reason=$6,waiters=$7::jsonb,manual_check_until=NULL,updated_at=clock_timestamp() WHERE singleton`,
      [used + 1, remaining == null ? null : Math.max(0, remaining - 1), resetAt,
        null, token, probe ? 'recovery_probe' : null, JSON.stringify(waiters)])
      await client.query('COMMIT')
      return { allowed: true, token, probe, used: used + 1, remaining: remaining == null ? null : Math.max(0, remaining - 1), queueDepth: waiters.length }
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  async cancelRapidWait(ticket) {
    if (!UUID.test(ticket?.id || '') || !UUID.test(ticket?.requestId || '')) return
    await this.pool.query(`UPDATE control.facebook_rapid_quota SET waiters=coalesce((
      SELECT jsonb_agg(entry.value ORDER BY entry.ordinality)
      FROM jsonb_array_elements(waiters) WITH ORDINALITY AS entry(value, ordinality)
      WHERE NOT (entry.value->>'id'=$1 AND entry.value->>'requestId'=$2)
    ),'[]'::jsonb) WHERE singleton`, [ticket.id, ticket.requestId])
  }
  async observeRapid(admission, observation = {}) {
    if (!admission?.token) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [s] } = await client.query(`SELECT s.*, p.monthly_limit, p.probe_interval_hours, p.billing_cycle_day, p.billing_probe_interval_hours, now() AS checked_at
        FROM control.facebook_rapid_quota s CROSS JOIN control.platform_search_policies p
        WHERE s.lease_token=$1 AND p.platform='facebook' FOR UPDATE OF s`, [admission.token])
      if (s) {
        const now = new Date(s.checked_at).getTime()
        let { remaining, used, reset_at: resetAt, blocked_until: blockedUntil, reason } = s
        const reliableRemaining = Number.isSafeInteger(observation.remaining) && observation.remaining >= 0
          && observation.remaining <= 2147483647 && !observation.quotaConflict
          && (observation.limit == null || (Number.isSafeInteger(observation.limit) && observation.limit > 0
            && observation.limit <= 2147483647 && observation.remaining <= observation.limit))
        // Only the current serialized lease can replace the supplier snapshot.
        // Historical callbacks never overwrite a newer response or release its owner.
        let supplierRemaining = s.supplier_remaining, supplierLimit = s.supplier_limit,
          supplierObservedAt = s.supplier_observed_at
        if (reliableRemaining) {
          remaining = observation.remaining
          supplierRemaining = remaining; supplierLimit = observation.limit ?? null; supplierObservedAt = new Date(now)
          resetAt = Number.isInteger(observation.resetSeconds) && observation.resetSeconds > 0
            && observation.resetSeconds <= 32 * 86400 ? new Date(now + observation.resetSeconds * 1000) : null
          reason = remaining === 0 ? 'quota_exhausted' : null
        } else {
          // Keep the reserved deduction, but do not present it as a fresh header.
          reason = 'quota_unknown'
          if (resetAt && new Date(resetAt).getTime() <= now) resetAt = null
        }
        if (observation.monthlyExhausted) { remaining = 0; reason = 'quota_exhausted' }
        blockedUntil = null
        if (observation.status === 429 && !observation.monthlyExhausted && remaining !== 0) {
          blockedUntil = new Date(now + Math.max(60, Math.min(observation.retryAfterSeconds || 300, 86400)) * 1000)
          // Missing quota headers remain unknown even after the short cooldown.
          if (reliableRemaining) reason = 'rate_limited'
        }
        await client.query(`UPDATE control.facebook_rapid_quota SET remaining=$1,used=$2,reset_at=$3,blocked_until=$4,
          reason=$5,lease_token=NULL,lease_until=NULL,supplier_remaining=$6,supplier_limit=$7,
          supplier_observed_at=$8,updated_at=clock_timestamp() WHERE singleton`,
        [remaining, used, resetAt, blockedUntil, reason, supplierRemaining, supplierLimit, supplierObservedAt])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
}

export function rapidQuotaObservation(response) {
  const integer = name => { const v = response.headers.get(name); return v != null && /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null }
  // The operator-confirmed Facebook plan is monthly. Generic rate windows and
  // free-plan hard limits are different counters and cannot prove its recovery.
  const counters = ['x-ratelimit-requests', 'x-rapidapi-requests'].map(source => ({ source,
    remaining: integer(`${source}-remaining`), limit: integer(`${source}-limit`), reset: integer(`${source}-reset`) }))
  const quotaConflict = ['remaining', 'limit', 'reset'].some(field => counters.every(c => c[field] != null) && counters[0][field] !== counters[1][field])
  const counter = quotaConflict ? null : counters.find(c => c.remaining != null)
  const retry = response.headers.get('retry-after')
  return { ok: response.ok, status: response.status, remaining: counter?.remaining ?? null,
    limit: counter?.limit ?? null, resetSeconds: counter?.reset ?? null,
    billingHeaderSource: counter?.source ?? null, quotaConflict,
    retryAfterSeconds: integer('retry-after') ?? (Number.isFinite(Date.parse(retry)) ? Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000)) : null) }
}
