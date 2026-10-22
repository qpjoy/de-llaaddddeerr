import { AppError } from '../core/errors.mjs'
import { WECHAT_SELF_HOSTED, WECHAT_SELF_HOSTED_LIMITS, WECHAT_SELF_HOSTED_TERMINAL } from '../../shared/wechat-self-hosted.mjs'
import {
  WECHAT_ENGINE_ID, WECHAT_SELF_HOSTED_VERSION, DEFAULT_ENGINE_BASE_URL, DISPATCH_TIMEOUT_MS,
  assertIdempotencyKey, normalizeSearchItem, normalizeBatchRequest, normalizeEngineBaseUrl,
  fingerprint, estimateStart, publicJobView,
} from './wechat-contract.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROBE_TIMEOUT_MS = 5_000
// Polling reads share one queue snapshot per process for this long.
const SNAPSHOT_TTL_MS = 2_000
const terminal = new Set(WECHAT_SELF_HOSTED_TERMINAL)

function assertId(value, code = 'job_not_found') {
  if (!UUID.test(value || '')) throw new AppError(404, code, code === 'batch_not_found' ? 'Batch not found' : 'Job not found')
  return value
}

const ownerOf = context => ({ tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id })

// Public contract (202 + polling) and Admin engine operations for the WeChat
// self-hosted engine. Design: docs/architecture/spider_man/03-self-hosted-engines.md
export class WechatSelfHostedService {
  constructor({ jobs, ledger, executor = null, fetchImpl = globalThis.fetch, engineId = WECHAT_ENGINE_ID, limits = WECHAT_SELF_HOSTED_LIMITS }) {
    Object.assign(this, { jobs, ledger, executor, fetchImpl, engineId, limits })
    this.cached = null
  }

  async #snapshot() {
    if (this.cached && Date.now() - this.cached.at < SNAPSHOT_TTL_MS) return this.cached.value
    const [snapshot, engine] = await Promise.all([this.jobs.queueSnapshot(this.engineId), this.jobs.engine(this.engineId)])
    this.cached = { at: Date.now(), value: { snapshot, engine } }
    return this.cached.value
  }

  async #authorize(context) {
    const grants = await this.ledger.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
    if (!grants.includes(WECHAT_SELF_HOSTED.capability)) {
      throw new AppError(403, 'capability_not_granted', `Capability ${WECHAT_SELF_HOSTED.capability} is not granted to this key`)
    }
  }

  async #views(jobs) {
    if (!jobs.some(job => job.status === 'queued')) return jobs.map(job => publicJobView(job))
    const { snapshot, engine } = await this.#snapshot()
    const positions = new Map(snapshot.queued.map((row, index) => [row.id, index + 1]))
    const cooldownUntil = engine?.cooldownUntil ? new Date(engine.cooldownUntil).getTime() : null
    return jobs.map(job => {
      const position = positions.get(job.id) ?? null
      return publicJobView(job, { position, estimatedStartAt: position == null ? null
        : estimateStart({ position, runningSince: snapshot.runningSince, medianMs: snapshot.medianMs, cooldownUntil }) })
    })
  }

  async #owned(context, jobId) {
    const job = await this.jobs.get(assertId(jobId))
    if (!job || job.consumerId !== context.consumer.id || job.engineId !== this.engineId) throw new AppError(404, 'job_not_found', 'Job not found')
    return job
  }

  async submitJob(context, body, idempotencyKey) {
    assertIdempotencyKey(idempotencyKey)
    const { input } = normalizeSearchItem(body)
    await this.#authorize(context)
    const print = fingerprint(input)
    const result = await this.jobs.submit({ engineId: this.engineId, owner: ownerOf(context), kind: 'job', idempotencyKey,
      fingerprint: print, items: [{ clientRef: null, input, fingerprint: print }], limits: this.limits })
    this.cached = null
    this.executor?.nudge()
    const [view] = await this.#views(result.jobs)
    return { replay: result.replay, data: view }
  }

  async submitBatch(context, body, idempotencyKey) {
    assertIdempotencyKey(idempotencyKey)
    const items = normalizeBatchRequest(body)
    await this.#authorize(context)
    const result = await this.jobs.submit({ engineId: this.engineId, owner: ownerOf(context), kind: 'batch', idempotencyKey,
      fingerprint: fingerprint(items), items: items.map(item => ({ ...item, fingerprint: fingerprint(item.input) })), limits: this.limits })
    this.cached = null
    this.executor?.nudge()
    return { replay: result.replay, data: await this.#batchView(result.batch, result.jobs) }
  }

  async #batchView(batch, jobs) {
    const views = await this.#views(jobs)
    const counts = Object.fromEntries(['queued', 'running', ...WECHAT_SELF_HOSTED_TERMINAL].map(status => [status, 0]))
    for (const job of jobs) counts[job.status]++
    return { batchId: batch.id, total: jobs.length, complete: jobs.every(job => terminal.has(job.status)), counts, jobs: views,
      links: { self: `${WECHAT_SELF_HOSTED.apiPrefix}/batches/${batch.id}`, result: `${WECHAT_SELF_HOSTED.apiPrefix}/batches/${batch.id}/result` } }
  }

  async getJob(context, jobId) {
    const [view] = await this.#views([await this.#owned(context, jobId)])
    return view
  }

  async listJobs(context, limitInput) {
    const limit = limitInput == null ? 20 : Number(limitInput)
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError(400, 'invalid_limit', 'limit must be an integer between 1 and 50')
    return this.#views(await this.jobs.listForConsumer(context.consumer.id, limit))
  }

  async getResult(context, jobId) {
    const job = await this.#owned(context, jobId)
    if (!job.result) {
      if (!terminal.has(job.status)) {
        throw new AppError(409, 'result_not_ready', '任务尚未完成，请稍后用同一 jobId 查询', { status: job.status, retryAfterMs: 5_000 })
      }
      throw new AppError(409, 'result_unavailable', '该任务没有可读取的结果', { status: job.status, error: job.error || null })
    }
    return resultView(job)
  }

  async cancelJob(context, jobId) {
    const job = await this.#owned(context, jobId)
    const cancelled = await this.jobs.cancel({ jobId: job.id, consumerId: context.consumer.id })
    if (!cancelled) throw new AppError(409, 'job_not_cancellable', '只能取消还在排队的任务', { status: job.status })
    this.cached = null
    return publicJobView(cancelled)
  }

  async #ownedBatch(context, batchId) {
    const found = await this.jobs.batch(assertId(batchId, 'batch_not_found'))
    if (!found || found.batch.consumerId !== context.consumer.id || found.batch.engineId !== this.engineId) {
      throw new AppError(404, 'batch_not_found', 'Batch not found')
    }
    return found
  }

  async getBatch(context, batchId) {
    const { batch, jobs } = await this.#ownedBatch(context, batchId)
    return this.#batchView(batch, jobs)
  }

  async getBatchResult(context, batchId) {
    const { batch, jobs } = await this.#ownedBatch(context, batchId)
    return {
      batchId: batch.id, total: jobs.length, complete: jobs.every(job => terminal.has(job.status)),
      items: jobs.map(job => job.result ? { index: job.itemIndex, clientRef: job.clientRef, ...resultView(job) }
        : { index: job.itemIndex, clientRef: job.clientRef, jobId: job.id, status: job.status, items: null,
          error: job.error ? { code: job.error.code, message: job.error.message } : null }),
    }
  }

  // ---- Admin ----------------------------------------------------------------

  async adminState() {
    const [engine, snapshot, recent, events] = await Promise.all([
      this.jobs.engine(this.engineId), this.jobs.queueSnapshot(this.engineId),
      this.jobs.listRecent(this.engineId, 30), this.jobs.events(this.engineId, 20),
    ])
    if (!engine) throw new AppError(503, 'engine_unavailable', '自建引擎未配置（需要数据库迁移 165）')
    const cooldownUntil = engine.cooldownUntil ? new Date(engine.cooldownUntil).getTime() : null
    return {
      contractVersion: WECHAT_SELF_HOSTED_VERSION,
      engine: { ...engine, cooling: cooldownUntil != null && cooldownUntil > Date.now() },
      defaults: { baseUrl: DEFAULT_ENGINE_BASE_URL, dispatchTimeoutMs: DISPATCH_TIMEOUT_MS },
      limits: this.limits,
      queue: {
        queued: snapshot.queued.length, runningJobId: snapshot.runningJobId,
        runningSince: snapshot.runningSince ? new Date(snapshot.runningSince).toISOString() : null,
        medianMs: snapshot.medianMs,
        nextStartAt: snapshot.queued.length ? estimateStart({ position: 1, runningSince: snapshot.runningSince, medianMs: snapshot.medianMs, cooldownUntil }) : null,
        drainAt: snapshot.queued.length ? estimateStart({ position: snapshot.queued.length + 1, runningSince: snapshot.runningSince, medianMs: snapshot.medianMs, cooldownUntil }) : null,
      },
      jobs: recent.map(adminJobView),
      events,
      executor: { running: Boolean(this.executor && !this.executor.stopped) },
    }
  }

  async adminJob(jobId) {
    const job = await this.jobs.get(assertId(jobId))
    if (!job || job.engineId !== this.engineId) throw new AppError(404, 'job_not_found', 'Job not found')
    return { ...adminJobView(job), result: job.result, lateEvidence: job.lateEvidence }
  }

  async adminConfigure(body, actor) {
    const input = adminInput(body, ['baseUrl', 'enabled', 'billingEnabled', 'expectedRevision', 'reason'])
    if (typeof input.enabled !== 'boolean') throw new AppError(400, 'invalid_engine_config', 'enabled must be a boolean')
    if (input.billingEnabled !== undefined && typeof input.billingEnabled !== 'boolean') {
      throw new AppError(400, 'invalid_engine_config', 'billingEnabled must be a boolean')
    }
    const engine = await this.jobs.updateEngine({ engineId: this.engineId, baseUrl: normalizeEngineBaseUrl(input.baseUrl),
      enabled: input.enabled, billingEnabled: input.billingEnabled, expectedRevision: input.expectedRevision, actor, reason: input.reason })
    this.cached = null
    this.executor?.nudge()
    return engine
  }

  async adminRecover(body, actor) {
    const input = adminInput(body, ['expectedRevision', 'reason'])
    const engine = await this.jobs.recoverEngine({ engineId: this.engineId, expectedRevision: input.expectedRevision, actor, reason: input.reason })
    this.executor?.nudge()
    return engine
  }

  // Read-only connectivity check. Never posts work to the engine.
  async adminProbe(body = {}) {
    if (body && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'baseUrl'))) {
      throw new AppError(400, 'invalid_probe_request', 'Only baseUrl may be supplied')
    }
    const engine = await this.jobs.engine(this.engineId)
    const baseUrl = normalizeEngineBaseUrl(body?.baseUrl ?? engine?.baseUrl ?? DEFAULT_ENGINE_BASE_URL)
    const started = Date.now()
    try {
      const response = await this.fetchImpl(new URL('/api/v1/health', baseUrl), {
        redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => null)
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : {}
      return { baseUrl, reachable: true, httpStatus: response.status, healthy: response.ok && data.ok === true,
        durationMs: Date.now() - started, version: typeof data.version === 'string' ? data.version : null,
        queueMode: typeof data.queueMode === 'string' ? data.queueMode : null }
    } catch (error) {
      return { baseUrl, reachable: false, httpStatus: null, healthy: false, durationMs: Date.now() - started,
        error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.cause?.code || error?.code || 'connection_failed') }
    }
  }
}

function adminInput(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_engine_config', 'JSON object body is required')
  const unsupported = Object.keys(body).filter(key => !fields.includes(key))
  if (unsupported.length) throw new AppError(400, 'invalid_engine_config', `Unsupported fields: ${unsupported.join(', ')}`)
  if (!Number.isInteger(body.expectedRevision)) throw new AppError(400, 'invalid_engine_config', 'expectedRevision is required')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 2 || reason.length > 200) throw new AppError(400, 'invalid_engine_config', '请填写 2–200 字的原因')
  return { ...body, reason }
}

function resultView(job) {
  return {
    jobId: job.id, status: job.status, sourceMode: job.sourceMode, fetchedAt: job.result.fetchedAt || null,
    items: job.result.items || [], page: job.result.page || null, warnings: job.result.warnings || [],
    billing: { status: job.billing || 'none' },
    notice: job.sourceMode === 'stored_fallback' ? '搜狗当前不可用，这是最近一次成功采集的旧结果，不代表本次采集成功，不收费。' : null,
  }
}

function adminJobView(job) {
  return { ...publicJobView(job), tenantId: job.tenantId, consumerId: job.consumerId, apiKeyId: job.apiKeyId,
    usageRequestId: job.usageRequestId, engineRevision: job.engineRevision, baseUrl: job.baseUrl, httpStatus: job.httpStatus,
    hasLateEvidence: Boolean(job.lateEvidence) }
}
