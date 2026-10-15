import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const hours = 3600000
const day = 24 * hours
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

// Calendar hints only shorten the interval between demand-triggered checks.
// They never establish a new quota period or replenish the included calls.
export function facebookProbeIntervalHours(policy, now) {
  const local = new Date(now + 8 * hours) // The operator's billing-day hint is Asia/Shanghai.
  const cycleDay = policy.billing_cycle_day ?? 27
  for (const offset of [-1, 0, 1]) {
    const month = local.getUTCMonth() + offset, year = local.getUTCFullYear()
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const cycle = Date.UTC(year, month, Math.min(cycleDay, lastDay)) - 8 * hours
    if (now >= cycle - day && now < cycle + 3 * day) {
      return Math.min(policy.probe_interval_hours, policy.billing_probe_interval_hours ?? 6)
    }
  }
  return policy.probe_interval_hours
}

export function facebookRecoveryCheckAt(state, now) {
  if (state.reset_at) return new Date(state.reset_at).getTime()
  const interval = facebookProbeIntervalHours(state, now) * hours
  if (!state.blocked_until) return now + interval
  // A previously scheduled 72-hour wait can enter the shorter billing window.
  return Math.min(new Date(state.blocked_until).getTime(), new Date(state.updated_at).getTime() + interval)
}

export class PlatformSearchPolicyStore {
  constructor(pool) { this.pool = pool }
  async list() {
    if (!this.pool) return []
    const { rows } = await this.pool.query(`SELECT p.*, s.used, s.remaining, s.reset_at, s.blocked_until, s.reason AS availability_reason,
      s.lease_until, jsonb_array_length(s.waiters) AS queue_depth, s.updated_at AS observed_at, now() AS checked_at FROM control.platform_search_policies p
      LEFT JOIN control.facebook_rapid_quota s ON p.platform='facebook' ORDER BY p.platform`)
    return rows.map(({ checked_at: checkedAt, ...row }) => {
      if (row.platform !== 'facebook') return row
      const now = new Date(checkedAt).getTime()
      const needsCheck = row.used >= row.monthly_limit || row.remaining === 0
        || ['quota_exhausted', 'recovery_probe'].includes(row.availability_reason)
        || (row.reset_at && new Date(row.reset_at).getTime() <= now)
      const rateLimited = row.availability_reason === 'rate_limited' && row.blocked_until && new Date(row.blocked_until).getTime() > now
      return { ...row, available_included: row.platform === 'facebook'
        ? Math.max(0, Math.min(row.monthly_limit - row.used, row.remaining ?? row.monthly_limit)) : null,
        next_recovery_check_at: rateLimited ? row.blocked_until : needsCheck
        ? new Date(facebookRecoveryCheckAt({ ...row, updated_at: row.observed_at }, now)) : null }
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
      || !Number.isInteger(input.monthlyLimit) || input.monthlyLimit < 1 || input.monthlyLimit > 1000000
      || !Number.isInteger(input.probeIntervalHours) || input.probeIntervalHours < 24 || input.probeIntervalHours > 744
      || (input.billingCycleDay !== undefined && (!Number.isInteger(input.billingCycleDay) || input.billingCycleDay < 1 || input.billingCycleDay > 31))
      || (input.billingProbeIntervalHours !== undefined && (!Number.isInteger(input.billingProbeIntervalHours) || input.billingProbeIntervalHours < 1 || input.billingProbeIntervalHours > 24))
      || !Number.isSafeInteger(input.expectedRevision) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_platform_search_policy', 'Provide mode, quota, probe interval, revision and reason')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const changed = await client.query(`UPDATE control.platform_search_policies SET mode=$1, monthly_limit=$2,
        probe_interval_hours=$3, revision=revision+1, reason=$4, updated_at=now(),
        billing_cycle_day=coalesce($7,billing_cycle_day), billing_probe_interval_hours=coalesce($8,billing_probe_interval_hours)
        WHERE platform=$5 AND revision=$6 RETURNING *`, [input.mode, input.monthlyLimit, input.probeIntervalHours, input.reason.trim(), platform, input.expectedRevision,
        input.billingCycleDay ?? null, input.billingProbeIntervalHours ?? null])
      if (!changed.rowCount) throw new AppError(409, 'platform_search_revision_conflict', 'Strategy changed; refresh before saving')
      await client.query(`INSERT INTO control.platform_search_policy_events(platform,revision,actor,policy)
        VALUES($1,$2,'admin-token',$3::jsonb)`, [platform, changed.rows[0].revision, JSON.stringify(changed.rows[0])])
      await client.query('COMMIT')
      return changed.rows[0]
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
      const exhausted = used >= s.monthly_limit || remaining === 0
      const probe = exhausted || Boolean(elapsedReset) || ['quota_exhausted', 'recovery_probe'].includes(s.reason)
      let reason = null
      if (!['auto', 'rapidapi'].includes(s.mode)) reason = 'strategy_changed'
      else if (s.lease_until && new Date(s.lease_until).getTime() > now) reason = 'source_busy'
      else if (s.reason === 'rate_limited' && blockedUntil && new Date(blockedUntil).getTime() > now) reason = 'rate_limited'
      if (!reason && probe) {
        blockedUntil = new Date(facebookRecoveryCheckAt(s, now))
        if (blockedUntil.getTime() > now) reason = 'quota_exhausted'
      }
      if (reason) {
        if (reason === 'quota_exhausted') await client.query(`UPDATE control.facebook_rapid_quota SET blocked_until=$1,reason=$2 WHERE singleton`, [blockedUntil, reason])
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
        blocked_until=$4,lease_token=$5,lease_until=now()+interval '2 minutes',reason=$6,waiters=$7::jsonb,updated_at=now() WHERE singleton`,
      [used + 1, remaining == null ? null : Math.max(0, remaining - 1), resetAt,
        probe ? new Date(now + facebookProbeIntervalHours(s, now) * hours) : blockedUntil, token, probe ? 'recovery_probe' : null, JSON.stringify(waiters)])
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
        const reliableRemaining = Number.isInteger(observation.remaining) && observation.remaining >= 0
          && observation.remaining <= s.monthly_limit && !observation.quotaConflict
          && (observation.limit == null || observation.limit === s.monthly_limit)
        if (reliableRemaining) remaining = remaining == null ? observation.remaining : Math.min(remaining, observation.remaining)
        if (observation.monthlyExhausted) remaining = 0
        if (resetAt && new Date(resetAt).getTime() <= now) resetAt = null
        if (reliableRemaining && Number.isInteger(observation.resetSeconds) && observation.resetSeconds > 0 && observation.resetSeconds <= 32 * 86400) resetAt = new Date(now + observation.resetSeconds * 1000)
        if (reliableRemaining && observation.ok && remaining > 0 && !observation.monthlyExhausted) {
          used = Math.max(used, s.monthly_limit - remaining)
          blockedUntil = null; reason = null
        }
        if (admission.probe && reliableRemaining && observation.ok && observation.remaining > 0 && !observation.monthlyExhausted) {
          // Only an explicitly admitted recovery probe can establish renewal.
          // Ordinary/stale headers can tighten quota but never refill it.
          remaining = observation.remaining
          used = Math.max(1, s.monthly_limit - remaining); blockedUntil = null; reason = null
        }
        if (remaining != null) remaining = Math.min(remaining, Math.max(0, s.monthly_limit - used))
        if (remaining === 0 || used >= s.monthly_limit || observation.monthlyExhausted
          || (admission.probe && !(reliableRemaining && observation.ok && remaining > 0))) {
          blockedUntil = resetAt || new Date(now + facebookProbeIntervalHours(s, now) * hours); reason = 'quota_exhausted'
        } else if (observation.status === 429) {
          blockedUntil = new Date(now + Math.max(60, Math.min(observation.retryAfterSeconds || 300, 86400)) * 1000); reason = 'rate_limited'
        }
        await client.query(`UPDATE control.facebook_rapid_quota SET remaining=$1,used=$2,reset_at=$3,blocked_until=$4,
          reason=$5,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE singleton`, [remaining, used, resetAt, blockedUntil, reason])
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
