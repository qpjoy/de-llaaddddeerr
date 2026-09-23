import { setTimeout as sleep } from 'node:timers/promises'
import { AppError } from '../core/errors.mjs'

export const DEFAULT_DETAIL_QUEUE = Object.freeze({ intervalMs: 5000, jitterMs: 500, maxWaitMs: 60000, maxPending: 12, freshTtlMs: 300000, staleTtlMs: 3600000 })
const busy = (retryAfterMs = 5000) => new AppError(429, 'external_platform_busy', '服务器繁忙，请稍后再试', { retryAfterMs: Math.max(1000, Math.ceil(retryAfterMs)) })

// A short, atomic state transition, shared by memory and PostgreSQL. No network
// call or timer holds a database connection. Only digests and request IDs persist.
export function queueTransition(state, action, now) {
  state.queue ||= []; state.done ||= []
  state.done = state.done.filter(item => item.until > now)
  const finish = (item, outcome) => { state.done.push({ id: item.id, fingerprint: item.fingerprint, outcome, until: now + (outcome === 'unknown' ? 900000 : 120000) }); state.done = state.done.slice(-512) }
  if (state.active && state.active.expiresAt <= now) { finish(state.active, 'unknown'); state.active = null }
  state.queue = state.queue.filter(item => { if (item.deadline > now) return true; finish(item, 'expired'); return false })
  const { policy } = action
  const spacing = Math.max(policy.intervalMs, Math.min(state.latencyMs || 0, 120000)) + policy.jitterMs
  const estimate = () => Math.max(now, state.nextAt || 0, state.active ? state.active.startedAt + spacing : 0) + state.queue.length * spacing
  if (action.type === 'join') {
    const unsafe = state.done.find(item => item.fingerprint === action.fingerprint && item.outcome === 'unknown')
    if (unsafe) return { kind: 'unknown' }
    const equal = [state.active, ...state.queue].find(item => item?.fingerprint === action.fingerprint)
    if (equal) return { kind: equal.id === action.id ? 'queued' : 'follower', id: equal.id }
    const due = Math.max(estimate(), action.notBefore || 0)
    if (state.queue.length >= policy.maxPending || due >= action.deadline) return { kind: 'busy', retryAfterMs: Math.max(spacing, due - now) }
    state.queue.push({ id: action.id, fingerprint: action.fingerprint, deadline: action.deadline, notBefore: action.notBefore || now })
    return { kind: 'queued', id: action.id }
  }
  if (action.type === 'claim') {
    const terminal = state.done.find(item => item.id === action.id)
    if (terminal) return { kind: terminal.outcome }
    const item = state.queue.find(item => item.id === action.id)
    if (!item) return { kind: 'expired' }
    // Delayed retries yield to eligible fresh work, but retain their deadline.
    const head = state.queue.find(entry => entry.notBefore <= now)
    if (state.active || head?.id !== item.id || now < (state.nextAt || 0)) {
      return { kind: 'wait', waitMs: Math.max(100, Math.min(1000, Math.max(state.nextAt || now, item.notBefore) - now || 500)) }
    }
    state.queue = state.queue.filter(entry => entry.id !== item.id)
    state.active = { ...item, startedAt: now, expiresAt: now + action.leaseMs }
    state.nextAt = now + policy.intervalMs + action.jitterMs
    return { kind: 'acquired' }
  }
  if (action.type === 'dispatch') {
    if (state.active?.id !== action.id) return { kind: 'expired' }
    state.active.startedAt = now
    state.active.expiresAt = now + action.leaseMs
    state.nextAt = now + policy.intervalMs + action.jitterMs
    return { kind: 'acquired' }
  }
  if (action.type === 'requeue') {
    if (state.active?.id !== action.id) return { kind: 'expired' }
    const due = Math.max(estimate(), action.notBefore)
    if (state.queue.length >= policy.maxPending || due >= action.deadline) return { kind: 'busy' }
    state.queue.push({ ...state.active, notBefore: action.notBefore })
    state.active = null
    return { kind: 'queued' }
  }
  if (action.type === 'observe') {
    const terminal = state.done.find(item => item.id === action.id)
    return terminal ? { kind: terminal.outcome } : { kind: 'wait', waitMs: 500 }
  }
  if (action.type === 'finish') {
    const active = state.active?.id === action.id ? state.active : null
    const item = active || state.queue.find(entry => entry.id === action.id)
    if (!item) return { kind: 'expired' }
    if (active) {
      state.latencyMs = Math.round((state.latencyMs || policy.intervalMs) * 0.75 + Math.max(0, now - active.startedAt) * 0.25)
      state.active = null
    }
    state.queue = state.queue.filter(entry => entry.id !== action.id)
    finish(item, action.outcome)
    return { kind: 'finished' }
  }
  throw new TypeError('Unknown queue transition')
}

export class DispatchQueue {
  constructor({ pool = null, clock = Date.now, wait = sleep, random = Math.random } = {}) {
    this.pool = pool; this.clock = clock; this.wait = wait; this.random = random; this.states = new Map()
  }
  async transition(scope, action) {
    if (!this.pool) {
      const state = this.states.get(scope) || {}
      const result = queueTransition(state, action, this.clock())
      this.states.set(scope, state)
      return result
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '3s'")
      await client.query("SET LOCAL statement_timeout = '5s'")
      await client.query('INSERT INTO external_platform.dispatch_queues(scope, state) VALUES ($1, $2) ON CONFLICT DO NOTHING', [scope, {}])
      const { rows } = await client.query('SELECT state, clock_timestamp() AS now FROM external_platform.dispatch_queues WHERE scope = $1 FOR UPDATE', [scope])
      const state = rows[0].state
      const result = queueTransition(state, action, new Date(rows[0].now).getTime())
      await client.query('UPDATE external_platform.dispatch_queues SET state = $2, updated_at = now() WHERE scope = $1', [scope, state])
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
  }
  async enter({ scope, id, fingerprint, policy, deadline, leaseMs, notBefore = 0, signal }) {
    const action = { policy, id, fingerprint, deadline, notBefore }
    const joined = await this.transition(scope, { ...action, type: 'join' })
    if (joined.kind === 'busy') throw busy(joined.retryAfterMs)
    if (joined.kind === 'unknown') throw new AppError(409, 'request_outcome_unknown', 'Previous acquisition outcome is unknown')
    const follower = joined.kind === 'follower'
    try {
      while (true) {
        if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
        if (this.clock() >= deadline) throw busy(policy.intervalMs)
        const result = await this.transition(scope, { ...action, id: joined.id, type: follower ? 'observe' : 'claim', leaseMs, jitterMs: Math.floor(this.random() * policy.jitterMs) })
        if (result.kind === 'acquired') return { scope, id: joined.id, policy, follower: false }
        if (result.kind === 'succeeded') return { scope, id: joined.id, policy, follower: true }
        if (result.kind === 'unknown') throw new AppError(409, 'request_outcome_unknown', 'Shared acquisition outcome is unknown')
        if (result.kind !== 'wait') throw busy(policy.intervalMs)
        await this.wait(Math.min(result.waitMs, deadline - this.clock()), undefined, { signal })
      }
    } catch (error) {
      if (!follower) await this.finish({ scope, id: joined.id, policy }, 'cancelled').catch(() => {})
      if (signal?.aborted) throw new AppError(499, 'request_cancelled', 'Request cancelled before dispatch')
      throw error
    }
  }
  async finish(ticket, outcome) {
    if (ticket && !ticket.follower) await this.transition(ticket.scope, { ...ticket, type: 'finish', outcome })
  }
}

// PGY explicitly documents HTTP 400 as unbilled. Other errors, timeouts and
// accepted-but-unusable responses cannot safely be retried automatically.
export function canRetryDetail(error) {
  return error?.evidence?.outcome === 'rejected' && error.evidence.billed === false
    && error.evidence.httpStatus === 400 && error.evidence.errorCode === 'upstream_request_rejected'
}
