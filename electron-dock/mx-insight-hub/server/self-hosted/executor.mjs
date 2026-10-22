import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { WECHAT_SELF_HOSTED } from '../../shared/wechat-self-hosted.mjs'
import {
  WECHAT_ENGINE_ID, DISPATCH_TIMEOUT_MS, MAX_RESPONSE_BYTES,
  nightAllSearchBody, classifyEngineResponse, classifyTransportError,
} from './wechat-contract.mjs'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
const CLOSE_WAIT_MS = 5_000

async function readBounded(response, limit) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw Object.assign(new Error('Engine response exceeds the size limit'), { code: 'response_too_large' })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Runs one engine job at a time. The engine slot is arbitrated by the store,
// so a second executor (another process or node) can never dispatch in
// parallel; this loop only decides what this process does next.
//
// Billing is an engine switch (spider_man D14), off by default: jobs are only
// forwarded and the usage ledger is never touched. When it is on (D11), the
// ledger is reserved just before dispatch, the result is persisted, then the
// ledger is settled (commit for live/fresh, release for stale/failed, unknown
// otherwise). The caller is re-checked before every dispatch either way.
export class WechatSelfHostedExecutor {
  constructor({
    jobs, ledger, policyFor, fetchImpl = globalThis.fetch, serviceTokenFor = () => null, logger = console,
    engineId = WECHAT_ENGINE_ID, pollMs = 2_000, dispatchTimeoutMs = DISPATCH_TIMEOUT_MS,
    owner = `executor:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
  }) {
    Object.assign(this, { jobs, ledger, policyFor, fetchImpl, serviceTokenFor, logger, engineId, pollMs, dispatchTimeoutMs, owner })
    this.current = null
    this.ready = null
    this.lastPruneAt = 0
    this.stopped = true
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.ready = this.#recoverOrphans()
    this.timer = setInterval(() => { void this.tick() }, this.pollMs)
    this.timer.unref?.()
  }

  async close() {
    this.stopped = true
    clearInterval(this.timer)
    // A dispatch may wait minutes; a restart records it as unknown instead.
    await Promise.race([this.current?.catch(() => {}), new Promise(resolve => setTimeout(resolve, CLOSE_WAIT_MS).unref?.())])
  }

  nudge() {
    if (!this.stopped) void this.tick()
  }

  tick() {
    if (!this.current) {
      this.current = this.#run().catch(error => {
        this.logger.error?.('wechat self-hosted executor tick failed', error?.code || error?.message || error)
      }).finally(() => { this.current = null })
    }
    return this.current
  }

  async #recoverOrphans() {
    const orphans = await this.jobs.orphanRunning({ engineId: this.engineId, owner: this.owner })
    for (const job of orphans) {
      if (job.usageRequestId) await this.ledger.markRequestUnknown(job.usageRequestId, 'executor_restarted').catch(() => {})
    }
  }

  async #run() {
    await this.ready
    if (Date.now() - this.lastPruneAt > PRUNE_EVERY_MS) {
      this.lastPruneAt = Date.now()
      await this.jobs.prune(this.engineId, RETENTION_MS).catch(() => {})
    }
    let ran = 0
    while (!this.stopped) {
      // Idle polls stay a single lock-free read; only real work takes the lock.
      if (!(await this.jobs.readiness(this.engineId)).claimable) return ran
      const { job, billingEnabled } = await this.jobs.claim({ engineId: this.engineId, owner: this.owner })
      if (!job) return ran
      await (billingEnabled ? this.#execute(job) : this.#forward(job))
      ran++
    }
    return ran
  }

  async #finish(job, outcome, { billing, httpStatus = null, durationMs = null } = {}) {
    return this.jobs.finish({ engineId: this.engineId, jobId: job.id, owner: this.owner, outcome, httpStatus, durationMs, billing })
  }

  // Reads only: the key must still be active and hold the product grant.
  async #caller(job) {
    const context = await this.ledger.findApiKeyById(job.apiKeyId)
    if (!context || context.consumer.id !== job.consumerId) {
      return { refused: { code: 'api_key_unavailable', message: '提交任务的 Key 已失效、过期或被撤销；未派发，不收费' } }
    }
    const grants = await this.ledger.listEffectiveCapabilityGrants(job.consumerId, job.apiKeyId)
    if (!grants.includes(WECHAT_SELF_HOSTED.capability)) {
      return { refused: { code: 'capability_not_granted', message: '当前 Key 已无自建引擎权限；未派发，不收费' } }
    }
    return { context }
  }

  async #forward(job) {
    let caller
    try { caller = await this.#caller(job) } catch (error) {
      caller = { refused: { code: error?.code || 'caller_check_failed', message: '调用身份复核失败；未派发，不收费' } }
    }
    if (caller.refused) {
      await this.#finish(job, { status: 'failed', error: caller.refused }, { billing: 'none' })
      return
    }
    const { outcome, httpStatus, durationMs } = await this.#dispatch(job)
    await this.#finish(job, outcome, { billing: 'none', httpStatus, durationMs })
  }

  async #reserve(job) {
    const caller = await this.#caller(job)
    if (caller.refused) return caller
    const { context } = caller
    const policy = await this.policyFor(context, WECHAT_SELF_HOSTED.platform)
    const reservation = await this.ledger.reserve({
      requestId: randomUUID(),
      idempotencyKey: `wsh-${job.id}`,
      fingerprint: job.fingerprint,
      tenantId: context.tenant.id,
      consumerId: context.consumer.id,
      apiKeyId: context.apiKey.id,
      platform: WECHAT_SELF_HOSTED.platform,
      meterKey: WECHAT_SELF_HOSTED.meterKey,
      acquisitionRequest: { method: 'POST', path: `${WECHAT_SELF_HOSTED.apiPrefix}/jobs`, body: job.input },
      requiredAuthorizationScopes: [
        { type: 'platform', key: WECHAT_SELF_HOSTED.platform },
        { type: 'capability', key: WECHAT_SELF_HOSTED.capability },
      ],
      unitsReserved: 1,
      leaseExpiresAt: new Date(Date.now() + this.dispatchTimeoutMs + 120_000),
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

  async #dispatch(job) {
    const started = Date.now()
    const token = this.serviceTokenFor(job.baseUrl)
    try {
      const response = await this.fetchImpl(new URL('/api/v1/search/raw', job.baseUrl), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(nightAllSearchBody(job.input)),
        signal: AbortSignal.timeout(this.dispatchTimeoutMs),
      })
      const text = await readBounded(response, MAX_RESPONSE_BYTES)
      return { outcome: classifyEngineResponse({ status: response.status, text }), httpStatus: response.status, durationMs: Date.now() - started }
    } catch (error) {
      return { outcome: classifyTransportError(error), httpStatus: null, durationMs: Date.now() - started }
    }
  }

  async #execute(job) {
    let usage
    try {
      usage = await this.#reserve(job)
    } catch (error) {
      // Nothing was dispatched. An ambiguous reservation stays in the ledger
      // for the reaper; it is never charged automatically.
      const ambiguous = error?.preserveReservation === true
      await this.#finish(job, { status: 'failed', error: {
        code: error?.code || 'usage_reservation_failed',
        message: ambiguous ? '计费预留结果未知；未派发，待核实' : `${error?.message || '计费预留失败'}；未派发，不收费`,
      } }, { billing: ambiguous ? 'pending_review' : 'none' })
      return
    }
    if (usage.refused) {
      await this.#finish(job, { status: 'failed', error: usage.refused }, { billing: usage.review ? 'pending_review' : 'none' })
      return
    }
    if (!await this.jobs.markReserved({ jobId: job.id, owner: this.owner, usageRequestId: usage.usageRequestId })) {
      await this.ledger.releaseRequest(usage.usageRequestId, 'executor_fenced').catch(() => {})
      return
    }

    const { outcome, httpStatus, durationMs } = await this.#dispatch(job)
    const billing = outcome.status === 'unknown' ? 'pending_review' : outcome.charge ? 'charged' : 'not_charged'
    const finished = await this.#finish(job, outcome, { billing, httpStatus, durationMs })
    if (finished.fenced) {
      await this.ledger.markRequestUnknown(usage.usageRequestId, 'executor_fenced').catch(() => {})
      return
    }
    try {
      if (outcome.status === 'unknown') {
        await this.ledger.markRequestUnknown(usage.usageRequestId, outcome.error.code)
      } else if (outcome.charge) {
        await this.ledger.commitRequest(usage.usageRequestId, {
          responseStatus: 200,
          // Bounded summary only: the articles stay in the job record.
          responseBody: { data: { jobId: job.id, status: outcome.status, sourceMode: outcome.sourceMode,
            itemCount: outcome.result?.items?.length ?? 0 }, requestId: usage.usageRequestId },
          unitsActual: 1,
          upstreamLatencyMs: durationMs,
        })
      } else {
        await this.ledger.releaseRequest(usage.usageRequestId, outcome.error?.code || 'stale_fallback_not_billed')
      }
    } catch (error) {
      await this.ledger.markRequestUnknown(usage.usageRequestId, 'usage_settlement_ambiguous').catch(() => {})
      await this.jobs.setBilling(job.id, 'pending_review').catch(() => {})
      this.logger.error?.('wechat self-hosted settlement failed', job.id, error?.code || error?.message)
    }
  }
}
