import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { capabilityDefinition } from './catalog.mjs'
import { failed, unknown } from './http.mjs'

// Drives every enabled collection engine from one loop per process.
//
// * Slots are arbitrated by the store (PG rows, SKIP LOCKED), so any number
//   of executor processes can run side by side; this class only bounds how
//   much work this process holds at once (maxInFlight).
// * Async contracts hand the run to the upstream and return; the job then
//   waits in PG and whichever executor finds it due checks it. A restart
//   loses nothing for those.
// * A dispatch whose executor disappears is noticed by its lease: reconcilable
//   kinds are re-checked, others become unknown with the slot quarantined.
//
// Billing is an engine switch, off by default (spider_man D14): jobs are only
// forwarded and the usage ledger is never touched. When on, the ledger is
// reserved just before dispatch (D11) and settled when the outcome is stored.

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
const HOUSEKEEPING_EVERY_MS = 5_000
const CLOSE_WAIT_MS = 5_000
// Async start calls are short; their dispatch lease only covers the call.
const ASYNC_DISPATCH_LEASE_MS = 60_000
const CHECK_LEASE_MS = 60_000
export const LEASE_GRACE_MS = 30_000

export class CollectExecutor {
  constructor({
    jobs, ledger, contracts, policyFor, credentialsFor = async () => null, fetchImpl = globalThis.fetch, fetchFor = null, deps = {}, logger = console,
    pollMs = 1_000, maxInFlight = 32, owner = `collect:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
  }) {
    Object.assign(this, { jobs, ledger, contracts, policyFor, credentialsFor, fetchImpl, logger, pollMs, maxInFlight, owner })
    // Per-kind transport, e.g. the System Proxy route for api.apify.com.
    this.fetchFor = fetchFor || (() => fetchImpl)
    // Injected runtime pieces for native queries (e.g. a DNS Resolver in tests).
    this.deps = deps
    this.inFlight = new Set()
    this.spawned = 0
    this.ticking = null
    this.lastHousekeepingAt = 0
    this.lastPruneAt = 0
    this.stopped = true
    this.reconcilableKinds = [...contracts.values()].filter(contract => contract.reconcilable).map(contract => contract.kind)
    this.readOnlyKinds = [...contracts.values()].filter(contract => contract.readOnly).map(contract => contract.kind)
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => { void this.tick() }, this.pollMs)
    this.timer.unref?.()
  }

  async close() {
    this.stopped = true
    clearInterval(this.timer)
    // Sync dispatches may take minutes; their leases record the outcome as
    // unknown (or reconcile) instead of holding shutdown.
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise(resolve => setTimeout(resolve, CLOSE_WAIT_MS).unref?.())])
  }

  nudge() {
    if (!this.stopped) void this.tick()
  }

  // Single-flight: overlapping timer ticks and nudges share one pass.
  tick() {
    if (!this.ticking) {
      this.ticking = this.#pass().catch(error => {
        this.logger.error?.('collect executor tick failed', error?.code || error?.message || error)
      }).finally(() => { this.ticking = null })
    }
    return this.ticking
  }

  // Runs passes until one starts nothing new and all work has settled.
  async drain() {
    for (;;) {
      const before = this.spawned
      await this.tick()
      while (this.inFlight.size) await Promise.allSettled([...this.inFlight])
      if (this.ticking) await this.ticking
      if (this.spawned === before && !this.inFlight.size) return
    }
  }

  // Inline run of a job this caller already claimed (synchronous queries).
  // Same checks, billing and recording as a queued dispatch.
  async runClaimed(job, engine) {
    await this.#dispatch(job, engine)
    return this.jobs.get(job.id)
  }

  #spawn(work) {
    this.spawned++
    const task = work().catch(error => {
      this.logger.error?.('collect executor task failed', error?.code || error?.message || error)
    }).finally(() => {
      this.inFlight.delete(task)
      // A finished task frees a slot or room here; claim the next job now
      // instead of waiting for the timer.
      this.nudge()
    })
    this.inFlight.add(task)
  }

  #room() { return Math.max(0, this.maxInFlight - this.inFlight.size) }

  async #pass() {
    if (this.stopped) return
    const ready = await this.jobs.readiness()
    if (Date.now() - this.lastHousekeepingAt > HOUSEKEEPING_EVERY_MS || ready.orphans || ready.expired) {
      this.lastHousekeepingAt = Date.now()
      await this.#housekeeping(ready)
    }
    if (ready.checks && this.#room()) {
      const due = await this.jobs.claimChecks({ owner: this.owner, limit: this.#room(), checkLeaseMs: CHECK_LEASE_MS })
      const engines = await this.jobs.enginesById([...new Set(due.map(job => job.engineId))])
      for (const job of due) this.#spawn(() => this.#check(job, engines.get(job.engineId)))
    }
    for (const candidate of ready.engines) {
      const contract = this.contracts.get(candidate.kind)
      for (let taken = 0; taken < candidate.free && this.#room() && !this.stopped; taken++) {
        const { job, engine } = await this.jobs.claim({ engineId: candidate.id, owner: this.owner, leaseGraceMs: LEASE_GRACE_MS,
          dispatchLeaseMs: contract?.mode === 'async' ? ASYNC_DISPATCH_LEASE_MS : null })
        if (!job) break
        this.#spawn(() => this.#dispatch(job, engine))
      }
    }
  }

  async #housekeeping(ready) {
    if (ready.expired) await this.jobs.expireQueued().catch(() => {})
    if (ready.orphans) {
      const orphans = await this.jobs.reapOrphans({ reconcilableKinds: this.reconcilableKinds, readOnlyKinds: this.readOnlyKinds, leaseGraceMs: LEASE_GRACE_MS })
      for (const job of orphans) {
        if (job.usageRequestId) await this.ledger.markRequestUnknown(job.usageRequestId, 'executor_lost').catch(() => {})
      }
    }
    if (Date.now() - this.lastPruneAt > PRUNE_EVERY_MS) {
      this.lastPruneAt = Date.now()
      await this.jobs.prune(RETENTION_MS).catch(() => {})
    }
  }

  // Reads only: the key must still be active and hold the capability grant.
  async #caller(job) {
    const context = await this.ledger.findApiKeyById(job.apiKeyId)
    if (!context || context.consumer.id !== job.consumerId) {
      return { refused: { code: 'api_key_unavailable', message: '提交任务的 Key 已失效、过期或被撤销；未派发，不收费' } }
    }
    const grants = await this.ledger.listEffectiveCapabilityGrants(job.consumerId, job.apiKeyId)
    if (!grants.includes(job.capability)) {
      return { refused: { code: 'capability_not_granted', message: '当前 Key 已无该采集能力的权限；未派发，不收费' } }
    }
    return { context }
  }

  async #reserve(job, context, definition) {
    const policy = await this.policyFor(context, definition.platform)
    const reservation = await this.ledger.reserve({
      requestId: randomUUID(),
      idempotencyKey: `col-${job.id}`,
      fingerprint: job.fingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: definition.platform,
      meterKey: definition.key,
      acquisitionRequest: { method: 'POST', path: '/api/v1/data/collect/jobs', body: { capability: job.capability, input: job.input } },
      requiredAuthorizationScopes: [{ type: 'platform', key: definition.platform }, { type: 'capability', key: definition.key }],
      unitsReserved: 1,
      leaseExpiresAt: new Date(new Date(job.runDeadlineAt).getTime() + LEASE_GRACE_MS + 120_000),
      windowStart: new Date(Date.now() - policy.windowSeconds * 1_000),
      maxRequests: policy.maxRequests,
      replayWindowMs: null,
    })
    if (reservation.kind !== 'reserved') {
      // The ledger key is derived from this job, which is never re-queued.
      return { refused: { code: 'usage_state_conflict', message: '账本中已有该任务的记录；未派发，待核实' }, review: true }
    }
    return { usageRequestId: reservation.request.id }
  }

  async #prepare(job, engine) {
    const contract = this.contracts.get(engine?.kind)
    const definition = capabilityDefinition(job.capability)
    if (!contract || !definition) return { outcome: failed('engine_kind_unsupported', '当前 Hub 版本不支持该引擎类型或能力；未派发，不收费') }
    let caller
    try { caller = await this.#caller(job) } catch (error) {
      caller = { refused: { code: error?.code || 'caller_check_failed', message: '调用身份复核失败；未派发，不收费' } }
    }
    if (caller.refused) return { outcome: failed(caller.refused.code, caller.refused.message) }
    let credential = null
    if (engine.credentialProvider) {
      try { credential = await this.credentialsFor(engine.credentialProvider) } catch { credential = null }
      if (!credential) return { outcome: failed('engine_credential_missing', '引擎凭据未配置或读取失败；未派发，不收费') }
    }
    let usageRequestId = null
    if (engine.billingEnabled) {
      let usage
      try {
        usage = await this.#reserve(job, caller.context, definition)
      } catch (error) {
        // Nothing was dispatched. An ambiguous reservation stays in the
        // ledger for the reaper; it is never charged automatically.
        const ambiguous = error?.preserveReservation === true
        return { outcome: failed(error?.code || 'usage_reservation_failed',
          ambiguous ? '计费预留结果未知；未派发，待核实' : `${error?.message || '计费预留失败'}；未派发，不收费`), billing: ambiguous ? 'pending_review' : 'none' }
      }
      if (usage.refused) return { outcome: failed(usage.refused.code, usage.refused.message), billing: usage.review ? 'pending_review' : 'none' }
      if (!await this.jobs.markReserved({ jobId: job.id, owner: this.owner, usageRequestId: usage.usageRequestId })) {
        await this.ledger.releaseRequest(usage.usageRequestId, 'executor_fenced').catch(() => {})
        return { fenced: true }
      }
      usageRequestId = usage.usageRequestId
    }
    return { contract, definition, credential, usageRequestId }
  }

  async #dispatch(job, engine) {
    const started = Date.now()
    const prepared = await this.#prepare(job, engine)
    if (prepared.fenced) return
    if (prepared.outcome) {
      await this.jobs.finish({ jobId: job.id, owner: this.owner, outcome: prepared.outcome, billing: prepared.billing || 'none' })
      return
    }
    const { contract, definition, credential, usageRequestId } = prepared
    const context = { engine, job, definition, credential, fetchImpl: this.fetchFor(engine.kind), runDeadlineAt: job.runDeadlineAt, deps: this.deps }
    let answer
    try {
      answer = contract.mode === 'sync' ? await contract.dispatch(context) : await contract.start(context)
    } catch (error) {
      answer = { outcome: unknown('contract_error', '引擎合同执行异常，上游是否已开始执行未知', { cause: String(error?.code || error?.message || error).slice(0, 200) }) }
    }
    if (answer.outcome) {
      // Rate-limited upstreams (Shodan: one call per second) pace the whole
      // engine through its shared PG cooldown, whichever process ran the call.
      const outcome = contract.minIntervalMs ? { ...answer.outcome, paceUntil: Date.now() + contract.minIntervalMs } : answer.outcome
      await this.#complete({ ...job, usageRequestId }, outcome, { durationMs: Date.now() - started })
      return
    }
    const waiting = await this.jobs.markWaiting({ jobId: job.id, owner: this.owner, upstreamRef: answer.upstream?.ref ?? job.id,
      upstreamState: answer.upstream?.state ?? null, nextCheckMs: answer.nextCheckMs ?? 2_000, leaseGraceMs: LEASE_GRACE_MS })
    if (!waiting) this.logger.warn?.('collect dispatch lost its lease before the upstream accepted it', job.id)
  }

  async #check(job, engine) {
    const contract = this.contracts.get(engine?.kind)
    const definition = capabilityDefinition(job.capability)
    if (!contract || !definition || contract.mode !== 'async') {
      await this.#complete(job, unknown('engine_kind_unsupported', '当前 Hub 版本无法核对该任务的上游状态'))
      return
    }
    let credential = null
    if (engine.credentialProvider) credential = await this.credentialsFor(engine.credentialProvider).catch(() => null)
    const fetchImpl = this.fetchFor(engine.kind)
    if (Date.now() > new Date(job.runDeadlineAt).getTime() + LEASE_GRACE_MS) {
      // Ask the upstream to stop; only a confirmed stop frees the slot.
      const aborted = contract.abort ? await contract.abort({ engine, job, definition, credential, fetchImpl }).catch(() => ({ stopped: false })) : { stopped: false }
      await this.#complete(job, aborted.stopped
        ? { ...failed('run_deadline_exceeded', '超过执行截止时间，已在上游确认中止；不收费', { upstreamStatus: aborted.status ?? null }), cost: aborted.cost ?? null }
        : unknown('run_deadline_exceeded', '超过执行截止时间仍未拿到上游结果，进程是否已停止未知'))
      return
    }
    let answer
    try {
      answer = await contract.check({ engine, job, definition, credential, fetchImpl })
    } catch {
      answer = { nextCheckMs: 10_000 }
    }
    if (answer.outcome) {
      await this.#complete(job, answer.outcome, { durationMs: answer.outcome.upstreamDurationMs ?? null })
      return
    }
    await this.jobs.updateWaiting({ jobId: job.id, owner: this.owner, upstreamState: answer.upstream?.state ?? null, nextCheckMs: answer.nextCheckMs ?? 5_000 })
  }

  async #complete(job, outcome, { durationMs = null, httpStatus = null } = {}) {
    const elapsed = durationMs ?? (job.dispatchedAt ? Date.now() - new Date(job.dispatchedAt).getTime() : null)
    const billing = !job.usageRequestId ? 'none' : outcome.status === 'unknown' ? 'pending_review' : outcome.charge ? 'charged' : 'not_charged'
    const finished = await this.jobs.finish({ jobId: job.id, owner: this.owner, outcome, httpStatus, durationMs: elapsed, billing })
    if (!job.usageRequestId) return
    if (finished.fenced) {
      await this.ledger.markRequestUnknown(job.usageRequestId, 'executor_fenced').catch(() => {})
      return
    }
    try {
      if (outcome.status === 'unknown') {
        await this.ledger.markRequestUnknown(job.usageRequestId, outcome.error?.code || 'collect_unknown')
      } else if (outcome.charge) {
        await this.ledger.commitRequest(job.usageRequestId, {
          responseStatus: 200,
          // Bounded summary only: the payload stays in collect.job_results.
          responseBody: { data: { jobId: job.id, capability: job.capability, status: outcome.status, dataStatus: outcome.dataStatus || null,
            itemCount: outcome.itemCount ?? null }, requestId: job.usageRequestId },
          unitsActual: 1,
          upstreamLatencyMs: elapsed,
        })
      } else {
        await this.ledger.releaseRequest(job.usageRequestId, outcome.error?.code || 'collect_not_billed')
      }
    } catch (error) {
      await this.ledger.markRequestUnknown(job.usageRequestId, 'usage_settlement_ambiguous').catch(() => {})
      await this.jobs.setBilling(job.id, 'pending_review').catch(() => {})
      this.logger.error?.('collect settlement failed', job.id, error?.code || error?.message)
    }
  }
}
