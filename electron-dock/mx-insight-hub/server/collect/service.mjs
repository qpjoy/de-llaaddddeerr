import { AppError } from '../core/errors.mjs'
import { normalizeEngineBaseUrl } from '../self-hosted/wechat-contract.mjs'
import {
  COLLECT, COLLECT_CAPABILITIES, COLLECT_ENGINE_BOUNDS as BOUNDS, COLLECT_KINDS, COLLECT_TERMINAL, collectCapability,
} from '../../shared/collect-engines.mjs'
import { WECHAT_SELF_HOSTED } from '../../shared/wechat-self-hosted.mjs'
import { assertIdempotencyKey, normalizeBatchRequest, normalizeJobRequest } from './catalog.mjs'

// Public contract (202 + polling) and Admin engine management for collection
// engines. Design: docs/architecture/spider_man/07-collect-engines.md

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENGINE_ID = /^[a-z0-9][a-z0-9.-]{2,63}$/
const SLOT_REF = /^[a-z0-9][a-z0-9-]{1,63}$/
const PROVIDER_KEY = /^[a-z][a-z0-9._-]{0,63}$/
// Polling reads share one queue snapshot per engine and process for this long.
const SNAPSHOT_TTL_MS = 2_000
const DEFAULT_ITEM_MS = 60_000
const terminal = new Set(COLLECT_TERMINAL)

const ownerOf = context => ({ tenantId: context.tenant.id, consumerId: context.consumer.id, apiKeyId: context.apiKey.id })
const iso = value => value == null ? null : new Date(value).toISOString()

function assertId(value, code = 'job_not_found') {
  if (!UUID.test(value || '')) throw new AppError(404, code, code === 'batch_not_found' ? 'Batch not found' : 'Job not found')
  return value
}

// Jobs that fit in currently free slots start now; the rest wait one median
// run per full round of slots ahead of them.
export function estimateStart({ position, capacity, running = 0, medianMs, now = Date.now() }) {
  const each = Number.isFinite(medianMs) && medianMs > 0 ? medianMs : DEFAULT_ITEM_MS
  const slots = Math.max(1, capacity)
  const rounds = Math.max(0, Math.ceil((position - Math.max(0, slots - running)) / slots))
  return new Date(now + rounds * each).toISOString()
}

// Polling hint: queued jobs wait until their estimated start (5–60 s), running
// jobs are checked every 5 s. Null when nothing is open.
export function retryAfterSeconds(views, now = Date.now()) {
  let seconds = null
  for (const view of views) {
    let wait = null
    if (view.status === 'running') wait = 5
    else if (view.status === 'queued') {
      const start = view.queue?.estimatedStartAt ? Date.parse(view.queue.estimatedStartAt) : now
      wait = Math.min(60, Math.max(5, Math.ceil((start - now) / 1000)))
    }
    if (wait != null) seconds = seconds == null ? wait : Math.min(seconds, wait)
  }
  return seconds
}

export function publicJobView(job, { position = null, ahead = null, estimatedStartAt = null } = {}) {
  const prefix = COLLECT.apiPrefix
  return {
    jobId: job.id, batchId: job.batchId || null, clientRef: job.clientRef || null, capability: job.capability, status: job.status,
    input: job.input,
    queue: job.status === 'queued' ? { position, ahead, estimatedStartAt } : null,
    timing: { queuedAt: iso(job.queuedAt), deadlineAt: iso(job.deadlineAt), dispatchedAt: iso(job.dispatchedAt),
      finishedAt: iso(job.finishedAt), durationMs: job.durationMs ?? null },
    delivery: { available: Boolean(job.result), dataStatus: job.dataStatus || null, itemCount: job.result?.itemCount ?? null,
      bytes: job.result?.bytes ?? null, sha256: job.result?.sha256 ?? null },
    billing: { status: job.billing || 'none' },
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
    links: { self: `${prefix}/jobs/${job.id}`, result: `${prefix}/jobs/${job.id}/result` },
  }
}

function adminJobView(job) {
  return { ...publicJobView(job), engineId: job.engineId, routeKey: job.routeKey, phase: job.phase, slotNo: job.slotNo, tenantId: job.tenantId,
    consumerId: job.consumerId, apiKeyId: job.apiKeyId, usageRequestId: job.usageRequestId, engineRevision: job.engineRevision,
    checks: job.checks, upstreamRef: job.upstreamRef, upstreamState: job.upstreamState, httpStatus: job.httpStatus,
    errorDetails: job.error?.details ?? null, hasLateEvidence: Boolean(job.lateEvidence), runDeadlineAt: job.runDeadlineAt, cost: job.cost }
}

function adminBody(body, fields, { revision = true } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_engine_config', 'JSON object body is required')
  const unsupported = Object.keys(body).filter(key => !fields.includes(key))
  if (unsupported.length) throw new AppError(400, 'invalid_engine_config', `Unsupported fields: ${unsupported.join(', ')}`)
  if (revision && !Number.isInteger(body.expectedRevision)) throw new AppError(400, 'invalid_engine_config', 'expectedRevision is required')
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 2 || reason.length > 200) throw new AppError(400, 'invalid_engine_config', '请填写 2–200 字的原因')
  return { ...body, reason }
}

const configError = message => new AppError(400, 'invalid_engine_config', message)

function bounded(value, name, { min, max }, scale = 1) {
  if (!Number.isInteger(value) || value < min || value > max) throw configError(`${name} 须为 ${min}–${max} 的整数`)
  return value * scale
}

export class CollectService {
  // credentials: { read, describe, update } over the provider credential store
  // (migration 052). egressStores: provider key → System Proxy binding store.
  constructor({ jobs, ledger, contracts, executor = null, credentials = null, credentialsFor = null, fetchImpl = globalThis.fetch,
    fetchFor = null, egressStores = {}, legacy = {} }) {
    Object.assign(this, { jobs, ledger, contracts, executor, credentials, fetchImpl, egressStores, legacy })
    this.credentialsFor = credentialsFor || (credentials ? provider => credentials.read(provider) : async () => null)
    this.fetchFor = fetchFor || (() => fetchImpl)
    this.snapshots = new Map()
  }

  // ---- public -------------------------------------------------------------------

  async #authorize(context, capability) {
    const grants = await this.ledger.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
    if (!grants.includes(capability)) throw new AppError(403, 'capability_not_granted', `Capability ${capability} is not granted to this key`)
    return grants
  }

  async #snapshot(engineId) {
    const cached = this.snapshots.get(engineId)
    if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.value
    const [snapshot, engine] = await Promise.all([this.jobs.queueSnapshot(engineId), this.jobs.engine(engineId)])
    const value = { snapshot, capacity: engine?.capacity || 1, positions: new Map(snapshot.queuedIds.map((id, index) => [id, index + 1])) }
    this.snapshots.set(engineId, { at: Date.now(), value })
    return value
  }

  async #views(jobs) {
    const engineIds = [...new Set(jobs.filter(job => job.status === 'queued').map(job => job.engineId))]
    const snapshots = new Map(await Promise.all(engineIds.map(async id => [id, await this.#snapshot(id)])))
    return jobs.map(job => {
      if (job.status !== 'queued') return publicJobView(job)
      const { snapshot, capacity, positions } = snapshots.get(job.engineId)
      const position = positions.get(job.id) ?? null
      return publicJobView(job, { position, ahead: position == null && snapshot.truncated ? `>${snapshot.queuedIds.length}` : null,
        estimatedStartAt: estimateStart({ position: position ?? snapshot.queued, capacity, running: snapshot.running, medianMs: snapshot.medianMs }) })
    })
  }

  #forget(jobs) { for (const job of jobs) this.snapshots.delete(job.engineId) }

  async #owned(context, jobId) {
    const job = await this.jobs.get(assertId(jobId))
    if (!job || job.consumerId !== context.consumer.id) throw new AppError(404, 'job_not_found', 'Job not found')
    return job
  }

  async capabilities(context) {
    const grants = new Set(await this.ledger.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id))
    const engines = await this.jobs.listEngines()
    return COLLECT_CAPABILITIES.map(row => {
      const routes = engines.flatMap(engine => engine.routes.filter(route => route.capability === row.key)
        .map(route => ({ routeKey: route.routeKey, ready: engine.enabled && !engine.quarantineReason })))
      return { capability: row.key, label: row.label, description: row.description, stage: row.stage, granted: grants.has(row.key),
        routeBy: row.routeBy || null, routes: (row.routes || []).map(route => ({ key: route.key, label: route.label,
          ready: routes.some(item => item.routeKey === route.key && item.ready) })),
        ready: routes.some(item => item.ready) }
    })
  }

  async submitJob(context, body, idempotencyKey) {
    assertIdempotencyKey(idempotencyKey)
    const { definition, item } = normalizeJobRequest(body)
    await this.#authorize(context, definition.key)
    const result = await this.jobs.submit({ owner: ownerOf(context), kind: 'job', idempotencyKey, fingerprint: item.fingerprint,
      capability: definition.key, items: [item] })
    this.#forget(result.jobs)
    this.executor?.nudge()
    const [view] = await this.#views(result.jobs)
    return { replay: result.replay, data: view }
  }

  async submitBatch(context, body, idempotencyKey) {
    assertIdempotencyKey(idempotencyKey)
    const { definition, items, fingerprint } = normalizeBatchRequest(body)
    await this.#authorize(context, definition.key)
    const result = await this.jobs.submit({ owner: ownerOf(context), kind: 'batch', idempotencyKey, fingerprint, capability: definition.key, items })
    this.#forget(result.jobs)
    this.executor?.nudge()
    return { replay: result.replay, data: await this.#batchView(result.batch, result.jobs) }
  }

  async #batchView(batch, jobs) {
    const views = await this.#views(jobs)
    const counts = Object.fromEntries(['queued', 'running', ...COLLECT_TERMINAL].map(status => [status, 0]))
    for (const job of jobs) counts[job.status]++
    return { batchId: batch.id, capability: batch.capability, total: jobs.length, complete: jobs.every(job => terminal.has(job.status)), counts, jobs: views,
      links: { self: `${COLLECT.apiPrefix}/batches/${batch.id}`, result: `${COLLECT.apiPrefix}/batches/${batch.id}/result` } }
  }

  async getJob(context, jobId) {
    const [view] = await this.#views([await this.#owned(context, jobId)])
    return view
  }

  async listJobs(context, { limit: limitInput, capability = null } = {}) {
    const limit = limitInput === undefined ? 20 : Number(limitInput)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'invalid_limit', 'limit must be an integer between 1 and 100')
    if (capability !== null && !collectCapability(capability)) throw new AppError(400, 'invalid_collect_request', 'capability is not a supported collection capability')
    return this.#views(await this.jobs.listForConsumer(context.consumer.id, { limit, capability }))
  }

  async getResult(context, jobId) {
    const job = await this.#owned(context, jobId)
    const stored = job.result ? await this.jobs.result(job.id) : null
    if (!stored) {
      if (!terminal.has(job.status)) {
        throw new AppError(409, 'result_not_ready', '任务尚未完成，请稍后用同一 jobId 查询', { status: job.status, retryAfterMs: 5_000 })
      }
      throw new AppError(409, 'result_unavailable', '该任务没有可读取的结果', { status: job.status, error: job.error || null })
    }
    return { jobId: job.id, capability: job.capability, status: job.status, dataStatus: job.dataStatus, billing: { status: job.billing || 'none' },
      evidence: { bytes: stored.bytes, sha256: stored.sha256, itemCount: stored.itemCount, storedAt: stored.createdAt },
      error: job.error ? { code: job.error.code, message: job.error.message } : null,
      // The adapter's own envelope, preserved as delivered.
      payload: stored.payload }
  }

  async cancelJob(context, jobId) {
    const job = await this.#owned(context, jobId)
    const cancelled = await this.jobs.cancel({ jobId: job.id, consumerId: context.consumer.id })
    if (!cancelled) throw new AppError(409, 'job_not_cancellable', '只能取消还在排队的任务', { status: job.status })
    this.#forget([job])
    return publicJobView(cancelled)
  }

  async #ownedBatch(context, batchId) {
    const found = await this.jobs.batch(assertId(batchId, 'batch_not_found'))
    if (!found || found.batch.consumerId !== context.consumer.id) throw new AppError(404, 'batch_not_found', 'Batch not found')
    return found
  }

  async getBatch(context, batchId) {
    const { batch, jobs } = await this.#ownedBatch(context, batchId)
    return this.#batchView(batch, jobs)
  }

  async getBatchResult(context, batchId) {
    const { batch, jobs } = await this.#ownedBatch(context, batchId)
    const items = await Promise.all(jobs.map(async job => {
      const stored = job.result ? await this.jobs.result(job.id) : null
      return { index: job.itemIndex, clientRef: job.clientRef, jobId: job.id, status: job.status, dataStatus: job.dataStatus,
        error: job.error ? { code: job.error.code, message: job.error.message } : null, payload: stored?.payload ?? null }
    }))
    return { batchId: batch.id, capability: batch.capability, total: jobs.length, complete: jobs.every(job => terminal.has(job.status)), items }
  }

  // ---- admin --------------------------------------------------------------------

  adminCatalog() {
    return {
      contractVersion: COLLECT.contractVersion,
      kinds: Object.entries(COLLECT_KINDS).map(([kind, row]) => ({ kind, ...row, available: this.contracts.has(kind) })),
      capabilities: COLLECT_CAPABILITIES,
      bounds: BOUNDS,
    }
  }

  async #legacyEngines() {
    const rows = []
    if (this.legacy.wechat) {
      try {
        const state = await this.legacy.wechat.adminState()
        const recent = {}
        for (const job of state.jobs) if (terminal.has(job.status)) recent[job.status] = (recent[job.status] || 0) + 1
        rows.push({ id: state.engine.id, source: 'wechat', kind: 'night_all_http', displayName: '微信公众号（Night-All 搜狗）',
          capabilities: [WECHAT_SELF_HOSTED.capability], enabled: state.engine.enabled, billingEnabled: state.engine.billingEnabled,
          quarantineReason: state.engine.quarantineReason, cooling: state.engine.cooling, cooldownUntil: state.engine.cooldownUntil,
          capacity: 1, stats: { busySlots: state.queue.runningJobId && !state.engine.quarantineReason ? 1 : 0, quarantinedSlots: state.engine.quarantineReason ? 1 : 0,
            queued: state.queue.queued, recentSample: recent }, revision: state.engine.revision,
          manage: { href: `#${WECHAT_SELF_HOSTED.path}?tab=management`, note: '沿用 migration 165 的独立表和执行器，后续再迁入通用引擎' } })
      } catch (error) {
        rows.push({ id: 'night-all.wechat-mp', source: 'wechat', kind: 'night_all_http', displayName: '微信公众号（Night-All 搜狗）',
          error: { code: error?.code || 'unavailable', message: error?.message || '读取失败' } })
      }
    }
    return rows
  }

  async adminEngines() {
    const [engines, legacy] = await Promise.all([this.jobs.listEngines(), this.#legacyEngines()])
    return { contractVersion: COLLECT.contractVersion, engines, legacy, executor: { running: Boolean(this.executor && !this.executor.stopped) } }
  }

  async adminEngine(engineId) {
    const detail = await this.jobs.engineDetail(engineId)
    if (!detail) throw new AppError(404, 'engine_not_found', 'Engine not found')
    const [snapshot, recent, events] = await Promise.all([
      this.jobs.queueSnapshot(engineId), this.jobs.listRecent(engineId, 50), this.jobs.events(engineId, 30),
    ])
    const [credential, egress] = await Promise.all([this.#credentialState(detail.engine), this.#egressState(detail.engine.kind)])
    return { ...detail, credential, egress, queue: { queued: snapshot.queued, running: snapshot.running, medianMs: snapshot.medianMs, oldestRunningAt: snapshot.oldestRunningAt,
      drainAt: snapshot.queued ? estimateStart({ position: snapshot.queued + detail.engine.capacity, capacity: detail.engine.capacity, running: snapshot.running, medianMs: snapshot.medianMs }) : null },
    jobs: recent.map(adminJobView), events, kind: { kind: detail.engine.kind, ...(COLLECT_KINDS[detail.engine.kind] || {}), available: this.contracts.has(detail.engine.kind) } }
  }

  #routes(kind, input) {
    if (input === undefined) return null
    if (!Array.isArray(input) || input.length > 32) throw configError('routes 须为数组（最多 32 项）')
    const seen = new Set()
    return input.map(route => {
      if (!route || typeof route !== 'object' || Array.isArray(route)) throw configError('routes 的每一项须为对象')
      const definition = collectCapability(route.capability)
      if (!definition) throw configError(`不支持的能力 ${route.capability}`)
      if (!definition.kinds.includes(kind)) throw configError(`${definition.key} 不能由 ${kind} 类型的引擎承接`)
      const routeKey = route.routeKey ?? ''
      if (definition.routeBy ? !(definition.routes || []).some(row => row.key === routeKey) : routeKey !== '') {
        throw configError(`${definition.key} 的路由 ${routeKey || '（空）'} 不在允许范围内`)
      }
      const key = `${definition.key}:${routeKey}`
      if (seen.has(key)) throw configError(`重复的路由 ${key}`)
      seen.add(key)
      return { capability: definition.key, routeKey }
    })
  }

  #fields(kind, input, { creating }) {
    const contract = this.contracts.get(kind)
    const out = {}
    if (input.displayName !== undefined) {
      const name = typeof input.displayName === 'string' ? input.displayName.trim() : ''
      if (!name || name.length > 80) throw configError('名称须为 1–80 个字符')
      out.displayName = name
    }
    if (input.slotRef !== undefined) {
      if (input.slotRef !== null && (typeof input.slotRef !== 'string' || !SLOT_REF.test(input.slotRef))) throw configError('slotRef 须为插槽 ID，例如 market-195')
      out.slotRef = input.slotRef
    }
    if (COLLECT_KINDS[kind]?.baseUrl === 'none') {
      if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== '') throw configError('该类型的引擎使用固定地址，不能填写接口地址')
      if (creating) out.baseUrl = null
    } else if (input.baseUrl !== undefined) {
      if (input.baseUrl === null || input.baseUrl === '') {
        if (COLLECT_KINDS[kind]?.baseUrl === 'required') throw configError('该类型的引擎必须填写接口地址')
        out.baseUrl = null
      } else out.baseUrl = contract?.normalizeBaseUrl ? contract.normalizeBaseUrl(input.baseUrl) : normalizeEngineBaseUrl(input.baseUrl)
    } else if (creating && COLLECT_KINDS[kind]?.baseUrl === 'required') throw configError('该类型的引擎必须填写接口地址')
    if (input.credentialProvider !== undefined) {
      if (input.credentialProvider !== null && input.credentialProvider !== '' && (typeof input.credentialProvider !== 'string' || !PROVIDER_KEY.test(input.credentialProvider))) {
        throw configError('凭据须为凭据库中的供应商键，例如 collect-runner')
      }
      out.credentialProvider = input.credentialProvider || null
    }
    if (input.config !== undefined) {
      try { out.config = contract?.normalizeConfig ? contract.normalizeConfig(input.config) : {} } catch (error) { throw configError(error.message) }
    }
    if (input.capacity !== undefined) out.capacity = bounded(input.capacity, '执行槽数', BOUNDS.capacity)
    if (input.queueLimit !== undefined) out.queueLimit = bounded(input.queueLimit, '排队上限', BOUNDS.queueLimit)
    if (input.consumerOpenLimit !== undefined) out.consumerOpenLimit = bounded(input.consumerOpenLimit, '每个调用方未完成上限', BOUNDS.consumerOpenLimit)
    if (input.queueWaitMinutes !== undefined) out.queueWaitMs = bounded(input.queueWaitMinutes, '最长排队分钟', BOUNDS.queueWaitMinutes, 60_000)
    if (input.runTimeoutSeconds !== undefined) out.runTimeoutMs = bounded(input.runTimeoutSeconds, '单次执行超时秒数', BOUNDS.runTimeoutSeconds, 1_000)
    for (const flag of ['enabled', 'billingEnabled']) {
      if (input[flag] !== undefined) {
        if (typeof input[flag] !== 'boolean') throw configError(`${flag} 须为布尔值`)
        out[flag] = input[flag]
      }
    }
    return out
  }

  async adminCreateEngine(body, actor) {
    const input = adminBody(body, ['id', 'kind', 'displayName', 'slotRef', 'baseUrl', 'credentialProvider', 'config', 'capacity', 'queueLimit',
      'consumerOpenLimit', 'queueWaitMinutes', 'runTimeoutSeconds', 'enabled', 'billingEnabled', 'routes', 'reason'], { revision: false })
    if (typeof input.id !== 'string' || !ENGINE_ID.test(input.id)) throw configError('引擎 ID 须为 3–64 位小写字母、数字、点或短横线，例如 runner.market-195')
    if (!COLLECT_KINDS[input.kind] || !this.contracts.has(input.kind)) throw configError(`不支持的引擎类型 ${input.kind}`)
    if (input.displayName === undefined) throw configError('请填写引擎名称')
    const fields = this.#fields(input.kind, input, { creating: true })
    if (!fields.credentialProvider && COLLECT_KINDS[input.kind].defaultCredentialProvider) {
      fields.credentialProvider = COLLECT_KINDS[input.kind].defaultCredentialProvider
    }
    if (COLLECT_KINDS[input.kind].credential === 'required' && !fields.credentialProvider) throw configError('该类型的引擎必须填写凭据键')
    const engine = {
      id: input.id, kind: input.kind, displayName: fields.displayName, slotRef: fields.slotRef ?? null, baseUrl: fields.baseUrl ?? null,
      credentialProvider: fields.credentialProvider ?? null, config: fields.config ?? {},
      capacity: fields.capacity ?? BOUNDS.capacity.default, queueLimit: fields.queueLimit ?? BOUNDS.queueLimit.default,
      consumerOpenLimit: fields.consumerOpenLimit ?? BOUNDS.consumerOpenLimit.default,
      queueWaitMs: fields.queueWaitMs ?? BOUNDS.queueWaitMinutes.default * 60_000, runTimeoutMs: fields.runTimeoutMs ?? BOUNDS.runTimeoutSeconds.default * 1_000,
      // New engines start stopped: enabling is a separate, deliberate step.
      enabled: fields.enabled ?? false, billingEnabled: fields.billingEnabled ?? false,
    }
    const created = await this.jobs.createEngine({ engine, routes: this.#routes(input.kind, input.routes) || [], actor, reason: input.reason })
    this.executor?.nudge()
    return created
  }

  async adminConfigureEngine(engineId, body, actor) {
    const input = adminBody(body, ['displayName', 'slotRef', 'baseUrl', 'credentialProvider', 'config', 'capacity', 'queueLimit', 'consumerOpenLimit',
      'queueWaitMinutes', 'runTimeoutSeconds', 'enabled', 'billingEnabled', 'routes', 'expectedRevision', 'reason'])
    const current = await this.jobs.engine(engineId)
    if (!current) throw new AppError(404, 'engine_not_found', 'Engine not found')
    const patch = this.#fields(current.kind, input, { creating: false })
    if (patch.credentialProvider === null && COLLECT_KINDS[current.kind]?.credential === 'required') throw configError('该类型的引擎必须填写凭据键')
    const engine = await this.jobs.updateEngine({ engineId, patch, routes: this.#routes(current.kind, input.routes),
      expectedRevision: input.expectedRevision, actor, reason: input.reason })
    this.snapshots.delete(engineId)
    this.executor?.nudge()
    return engine
  }

  async adminRecoverEngine(engineId, body, actor) {
    const input = adminBody(body, ['expectedRevision', 'reason'])
    const engine = await this.jobs.recoverEngine({ engineId, expectedRevision: input.expectedRevision, actor, reason: input.reason })
    this.executor?.nudge()
    return engine
  }

  async adminRecoverSlot(engineId, slotNo, body, actor) {
    const input = adminBody(body, ['expectedRevision', 'reason'])
    const number = Number(slotNo)
    if (!Number.isInteger(number) || number < 1 || number > BOUNDS.capacity.max) throw new AppError(404, 'slot_not_found', 'Slot not found')
    const engine = await this.jobs.recoverSlot({ engineId, slotNo: number, expectedRevision: input.expectedRevision, actor, reason: input.reason })
    this.executor?.nudge()
    return engine
  }

  // Read-only reachability check; never submits work to the engine.
  async adminProbe(engineId, body = {}) {
    if (body && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'baseUrl'))) {
      throw new AppError(400, 'invalid_probe_request', 'Only baseUrl may be supplied')
    }
    const engine = await this.jobs.engine(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    const contract = this.contracts.get(engine.kind)
    if (!contract?.probe) throw new AppError(409, 'probe_unsupported', '该类型的引擎没有连通性探测')
    const baseUrl = body?.baseUrl ? (contract.normalizeBaseUrl || normalizeEngineBaseUrl)(body.baseUrl) : engine.baseUrl
    let credential = null
    if (engine.credentialProvider) credential = await this.credentialsFor(engine.credentialProvider).catch(() => null)
    return { ...(await contract.probe({ engine, credential, fetchImpl: this.fetchFor(engine.kind), baseUrl })),
      credential: engine.credentialProvider ? (credential ? 'configured' : 'missing') : 'not_required' }
  }

  async #credentialState(engine) {
    if (!engine.credentialProvider) return { provider: null, required: COLLECT_KINDS[engine.kind]?.credential === 'required' }
    if (!this.credentials?.describe) return { provider: engine.credentialProvider, configured: null, writable: false }
    try {
      const described = await this.credentials.describe(engine.credentialProvider)
      // Never the secret itself: whether one is stored and its revision.
      return { provider: engine.credentialProvider, configured: described.source === 'database' && described.credentialConfigured,
        revision: described.revision, updatedAt: described.updatedAt, writable: true }
    } catch (error) {
      return { provider: engine.credentialProvider, configured: null, writable: false, error: error?.code || 'credential_store_unavailable' }
    }
  }

  async #egressState(kind) {
    const provider = COLLECT_KINDS[kind]?.egressProvider
    if (!provider) return null
    const store = this.egressStores[provider]
    if (!store) return { provider, available: false }
    try {
      const described = await store.describe()
      return { provider, available: true, mode: described.mode, sequenceKey: described.sequenceKey, revision: described.revision,
        sequences: described.sequences, recentProbeFailures: described.recentProbeFailures.slice(0, 5) }
    } catch (error) {
      return { provider, available: false, error: error?.code || 'proxy_store_unavailable' }
    }
  }

  // Write-only: the token goes to the shared credential store and is never
  // returned. The engine's own audit log records who set it, not what.
  async adminSetCredential(engineId, body, actor) {
    const input = adminBody(body, ['apiKey', 'expectedRevision', 'reason'], { revision: false })
    const engine = await this.jobs.engine(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    if (!engine.credentialProvider) throw configError('该引擎没有配置凭据键，请先在配置里填写')
    if (!this.credentials?.update) throw new AppError(503, 'credential_store_unavailable', '凭据库不可用')
    const described = await this.credentials.update(engine.credentialProvider, { apiKey: input.apiKey, expectedRevision: input.expectedRevision }, actor)
    await this.jobs.recordEvent(engineId, 'credential_updated', { actor, reason: input.reason, details: { provider: engine.credentialProvider, revision: described.revision } })
    return this.#credentialState(engine)
  }

  async adminSetEgress(engineId, body, actor) {
    const engine = await this.jobs.engine(engineId)
    if (!engine) throw new AppError(404, 'engine_not_found', 'Engine not found')
    const provider = COLLECT_KINDS[engine.kind]?.egressProvider
    const store = provider ? this.egressStores[provider] : null
    if (!store) throw new AppError(409, 'egress_unsupported', '该类型的引擎没有可配置的出口，或当前进程没有数据库')
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const unsupported = Object.keys(input).filter(key => !['mode', 'sequenceKey', 'expectedRevision', 'reason'].includes(key))
    if (unsupported.length) throw new AppError(400, 'invalid_proxy_binding', `Unsupported fields: ${unsupported.join(', ')}`)
    await store.update({ mode: input.mode, sequenceKey: input.sequenceKey ?? null, expectedRevision: input.expectedRevision, reason: input.reason })
    await this.jobs.recordEvent(engineId, 'egress_updated', { actor, reason: typeof input.reason === 'string' ? input.reason.trim() : '',
      details: { provider, mode: input.mode, sequenceKey: input.sequenceKey ?? null } })
    return this.#egressState(engine.kind)
  }

  async adminJob(jobId) {
    const job = await this.jobs.get(assertId(jobId))
    if (!job) throw new AppError(404, 'job_not_found', 'Job not found')
    const stored = job.result ? await this.jobs.result(job.id) : null
    return { ...adminJobView(job), payload: stored?.payload ?? null, lateEvidence: job.lateEvidence }
  }
}
