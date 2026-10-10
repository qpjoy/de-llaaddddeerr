import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

const hours = 3600000
export class PlatformSearchPolicyStore {
  constructor(pool) { this.pool = pool }
  async list() {
    if (!this.pool) return []
    return (await this.pool.query(`SELECT p.*, s.used, s.remaining, s.reset_at, s.blocked_until, s.reason AS availability_reason,
      s.lease_until, s.updated_at AS observed_at FROM control.platform_search_policies p
      LEFT JOIN control.facebook_rapid_quota s ON p.platform='facebook' ORDER BY p.platform`)).rows
  }
  async facebook() {
    const policy = (await this.list()).find(row => row.platform === 'facebook')
    if (!policy) throw new AppError(503, 'platform_search_policy_unavailable', 'Search strategy is unavailable')
    return policy
  }
  async update(platform, input) {
    if (platform !== 'facebook') throw new AppError(400, 'platform_search_policy_read_only', 'This platform retains its existing route')
    if (!input || Object.keys(input).some(k => !['mode', 'monthlyLimit', 'probeIntervalHours', 'expectedRevision', 'reason'].includes(k))
      || !['auto', 'rapidapi', 'justone', 'paused'].includes(input.mode)
      || !Number.isInteger(input.monthlyLimit) || input.monthlyLimit < 1 || input.monthlyLimit > 1000000
      || !Number.isInteger(input.probeIntervalHours) || input.probeIntervalHours < 24 || input.probeIntervalHours > 744
      || !Number.isSafeInteger(input.expectedRevision) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) {
      throw new AppError(400, 'invalid_platform_search_policy', 'Provide mode, quota, probe interval, revision and reason')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const changed = await client.query(`UPDATE control.platform_search_policies SET mode=$1, monthly_limit=$2,
        probe_interval_hours=$3, revision=revision+1, reason=$4, updated_at=now()
        WHERE platform=$5 AND revision=$6 RETURNING *`, [input.mode, input.monthlyLimit, input.probeIntervalHours, input.reason.trim(), platform, input.expectedRevision])
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
  async admitRapid() {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [s] } = await client.query(`SELECT s.*, p.monthly_limit, p.probe_interval_hours, p.mode,
        now() AS checked_at FROM control.facebook_rapid_quota s CROSS JOIN control.platform_search_policies p
        WHERE p.platform='facebook' FOR UPDATE OF s FOR SHARE OF p`)
      if (!s) throw new AppError(503, 'platform_search_policy_unavailable', 'Search strategy is unavailable')
      const now = new Date(s.checked_at).getTime()
      let used = s.used, remaining = s.remaining, resetAt = s.reset_at, blockedUntil = s.blocked_until
      const elapsedReset = resetAt && new Date(resetAt).getTime() <= now
      if (elapsedReset) { used = 0; remaining = null; resetAt = null; blockedUntil = null }
      let reason = null
      if (!['auto', 'rapidapi'].includes(s.mode)) reason = 'strategy_changed'
      else if (s.lease_until && new Date(s.lease_until).getTime() > now) reason = 'source_busy'
      else if (blockedUntil && new Date(blockedUntil).getTime() > now) reason = s.reason || 'source_cooldown'
      const exhausted = used >= s.monthly_limit || remaining === 0
      if (!reason && exhausted && resetAt && new Date(resetAt).getTime() > now) reason = 'quota_exhausted'
      if (!reason && exhausted && !blockedUntil) {
        blockedUntil = new Date(now + s.probe_interval_hours * hours)
        reason = 'quota_exhausted'
      }
      if (reason) {
        if (reason === 'quota_exhausted') await client.query(`UPDATE control.facebook_rapid_quota SET blocked_until=$1,reason=$2 WHERE singleton`, [resetAt || blockedUntil, reason])
        await client.query('COMMIT')
        return { allowed: false, reason }
      }
      const token = randomUUID(), probe = exhausted
      await client.query(`UPDATE control.facebook_rapid_quota SET used=$1,remaining=$2,reset_at=$3,
        blocked_until=$4,lease_token=$5,lease_until=now()+interval '2 minutes',reason=$6,updated_at=now() WHERE singleton`,
      [used + 1, remaining == null ? null : Math.max(0, remaining - 1), resetAt,
        probe ? new Date(now + s.probe_interval_hours * hours) : blockedUntil, token, probe ? 'recovery_probe' : null])
      await client.query('COMMIT')
      return { allowed: true, token, probe }
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  async observeRapid(admission, observation = {}) {
    if (!admission?.token) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [s] } = await client.query(`SELECT s.*, p.monthly_limit, p.probe_interval_hours, now() AS checked_at
        FROM control.facebook_rapid_quota s CROSS JOIN control.platform_search_policies p
        WHERE s.lease_token=$1 AND p.platform='facebook' FOR UPDATE OF s`, [admission.token])
      if (s) {
        const now = new Date(s.checked_at).getTime()
        let { remaining, used, reset_at: resetAt, blocked_until: blockedUntil, reason } = s
        if (Number.isInteger(observation.remaining) && observation.remaining >= 0) remaining = observation.remaining
        if (observation.monthlyExhausted) remaining = 0
        if (Number.isInteger(observation.resetSeconds) && observation.resetSeconds > 0 && observation.resetSeconds <= 32 * 86400) resetAt = new Date(now + observation.resetSeconds * 1000)
        if (admission.probe && observation.ok && remaining > 0) {
          // A successful HTTP response alone is insufficient: it may be an overage.
          used = Math.max(1, s.monthly_limit - Math.min(s.monthly_limit, remaining)); blockedUntil = null; reason = null
        }
        if (remaining === 0 || used >= s.monthly_limit || observation.monthlyExhausted) {
          blockedUntil = resetAt || new Date(now + s.probe_interval_hours * hours); reason = 'quota_exhausted'
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
  const remaining = [integer('x-ratelimit-requests-remaining'), integer('x-rate-limit-rapid-free-plans-hard-limit-remaining')].filter(v => v != null)
  const resets = [integer('x-ratelimit-requests-reset'), integer('x-rate-limit-rapid-free-plans-hard-limit-reset')].filter(v => v > 0)
  const retry = response.headers.get('retry-after')
  return { ok: response.ok, status: response.status, remaining: remaining.length ? Math.min(...remaining) : null,
    resetSeconds: resets.length ? Math.max(...resets) : null,
    retryAfterSeconds: integer('retry-after') ?? (Number.isFinite(Date.parse(retry)) ? Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000)) : null) }
}
