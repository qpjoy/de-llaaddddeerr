import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { peripheralOrigin, validPeripheralResult } from './transport.mjs'

const fail = (code, message, status = 409) => { throw new AppError(status, code, message) }
const text = (value, max, field) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('peripheral_input', `${field} 必填且不能超过 ${max} 字符`, 400)
  return value.trim()
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const assertPeripheralId = id => { if (!UUID.test(id || '')) fail('peripheral_id', '无效的外设或任务 ID', 400); return id }
const bump = d => { d.revision++ }
const cas = (d, revision) => { if (revision !== d.revision) fail('peripheral_revision', '状态已变化，请刷新后重新确认') }
const event = (tx, action, extra = {}) => tx.event({ action, actor: 'admin-token', revision: tx.device.revision, ...extra })

export class PeripheralService {
  constructor({ store, transport, leaseMs = 60_000, cooldownMs = 2000, logger = console }) {
    this.store = store; this.transport = transport; this.leaseMs = leaseMs; this.cooldownMs = cooldownMs; this.logger = logger
    this.inflight = new Map(); this.stopped = false
  }
  async overview() {
    return { available: true, persistent: Boolean(this.store.pool), origins: this.transport.origins, devices: await this.store.list(),
      worker: { scope: 'current-replica', lastTickAt: this.lastTickAt || null, lastErrorAt: this.lastErrorAt || null, running: this.inflight.size } }
  }
  async register(body) {
    const origin = peripheralOrigin(body.origin)
    this.transport.assertOrigin(origin)
    return this.store.create({ id: randomUUID(), name: text(body.name, 80, '外设名称'),
      host: text(body.host, 120, '宿主机标识'), serial: text(body.serial, 120, 'ADB 序列号'),
      accountKey: text(body.accountKey, 120, '账号资源标识（不是密码）'), origin,
      adapter: 'xhs-poc.v1', capacity: 1, enabled: false, state: 'idle', revision: 1,
      session: null, activeJobId: null, cooldownUntil: 0, probe: null,
    })
  }
  async inspect(id, before = null) {
    assertPeripheralId(id)
    if (before) assertPeripheralId(before)
    const [device, jobs, events] = await Promise.all([this.store.get(id), this.store.history(id, before), this.store.events(id)])
    if (!device) fail('peripheral_not_found', '外设不存在', 404)
    return { device, jobs: jobs.slice(0, 50).map(({ responseText, result, lateEvidence, ...job }) => job), next: jobs.length > 50 ? jobs[49].id : null, events }
  }
  async job(id, jobId) {
    const job = await this.store.getJob(assertPeripheralId(id), assertPeripheralId(jobId))
    if (!job) fail('peripheral_job_not_found', '任务不存在', 404)
    return job
  }
  async control(id, body) {
    return this.store.transaction(assertPeripheralId(id), async tx => {
      const d = tx.device
      cas(d, body.revision)
      const active = await tx.active()
      if (body.action === 'configure') {
        if (d.enabled || d.state !== 'idle' || active.length || d.session) fail('peripheral_config_busy', '请先暂停调度、处理排队任务并结束会话后修改配置')
        const origin = peripheralOrigin(body.origin)
        this.transport.assertOrigin(origin)
        Object.assign(d, { origin, name: text(body.name, 80, '名称'), host: text(body.host, 120, '宿主机标识'),
          serial: text(body.serial, 120, 'ADB 序列号'), accountKey: text(body.accountKey, 120, '账号资源标识'), probe: null })
      } else if (body.action === 'pause') d.enabled = false // Drain, never abort physical work.
      else if (body.action === 'enable') {
        if (d.state !== 'idle') fail('peripheral_quarantined', '设备正在执行或待核验，不能启用')
        this.transport.assertOrigin(d.origin)
        if (!d.probe?.reachable || tx.now - d.probe.at > 60_000) fail('peripheral_probe_required', '请先显式检查连接（60 秒内）')
        d.enabled = true
      } else if (body.action === 'close-session') {
        if (active.length || d.state !== 'idle') fail('peripheral_busy', '有未完成任务，不能结束会话')
        if (body.sessionId !== d.session?.id) fail('peripheral_session', '搜索会话已变化')
        d.session = null
      } else if (body.action === 'recover') {
        if (d.state !== 'quarantined' || active.length || tx.now < (d.recoveryAfter || 0)) fail('peripheral_recovery', '尚不能核验恢复，请等待执行租约结束并停止旧执行器')
        const reason = text(body.reason, 500, '核验说明')
        if (body.confirmedStopped !== true) fail('peripheral_recovery', '必须确认旧 Hub 执行器和手机任务已停止，且不存在旁路调用')
        if (!d.probe?.reachable || tx.now - d.probe.at > 60_000) fail('peripheral_probe_required', '恢复前请显式检查连接；连接成功本身不证明任务停止')
        d.state = 'idle'; d.enabled = false; d.session = null; d.activeJobId = null; d.cooldownUntil = tx.now + this.cooldownMs
        bump(d); await event(tx, 'recover', { reason, previousUnknownJobId: d.unknownJobId }); return d
      } else if (body.action === 'cancel') {
        const job = active.find(j => j.id === body.jobId && j.status === 'queued')
        if (!job) fail('peripheral_not_queued', '只能取消尚未派发的任务')
        job.status = 'cancelled'; job.completedAt = new Date(tx.now).toISOString(); await tx.save(job)
        if (job.operation === 'search') d.session = null
      } else fail('peripheral_action', '不支持的管理操作', 400)
      bump(d); await event(tx, body.action, { jobId: body.jobId }); return d
    })
  }
  async probe(id) {
    assertPeripheralId(id)
    const d = await this.store.get(id)
    if (!d) fail('peripheral_not_found', '外设不存在', 404)
    let evidence
    try {
      const result = await this.transport.call(d, 'state')
      evidence = { reachable: result.httpStatus === 200 && result.result !== null, ...result }
    } catch { evidence = { reachable: false, error: '连接失败或超时；未执行搜索、翻页或详情' } }
    return this.store.transaction(id, async tx => {
      if (tx.device.origin !== d.origin || tx.device.serial !== d.serial || tx.device.accountKey !== d.accountKey || tx.device.host !== d.host) {
        fail('peripheral_revision', '连接配置已变化，请对新配置重新检查连接')
      }
      tx.device.probe = { ...evidence, at: tx.now }
      bump(tx.device); await event(tx, 'probe', { reachable: evidence.reachable })
      return tx.device
    })
  }
  async submit(id, body) {
    assertPeripheralId(id)
    const operation = body.operation
    if (!['search','next','note'].includes(operation)) fail('peripheral_operation', '只支持搜索、下一页、详情', 400)
    const idempotencyKey = text(body.idempotencyKey, 128, '幂等键')
    const input = operation === 'search' ? { keyword: text(body.keyword, 200, '关键词') }
      : operation === 'note' ? { input: text(body.input, 8192, 'detailInput') }
        : { sessionId: assertPeripheralId(body.sessionId), expectedPage: body.expectedPage }
    if (operation === 'next' && (!Number.isSafeInteger(input.expectedPage) || input.expectedPage < 1)) fail('peripheral_page', '缺少有效的预期页码', 400)
    if (operation === 'note') {
      let url
      try { url = new URL(input.input) } catch { fail('peripheral_note', '请原样粘贴搜索结果中的 detailInput 链接', 400) }
      if (url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || !url.pathname.startsWith('/explore/') || url.username || url.password) fail('peripheral_note', '只接受小红书搜索结果中的 HTTPS explore 链接', 400)
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex')
    return this.store.transaction(id, async tx => {
      const d = tx.device, previous = await tx.job(idempotencyKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('peripheral_idempotency', '同一幂等键不能用于不同请求')
        return previous
      }
      if (!d.enabled || d.state === 'quarantined') fail('peripheral_unavailable', '设备已暂停或待核验')
      const active = await tx.active()
      if (active.length >= 20) fail('peripheral_queue_full', '设备队列已满（20），请稍后提交', 429)
      if (d.session && tx.now >= d.session.expiresAt && !active.length && d.state === 'idle') d.session = null
      if (operation === 'search') {
        if (d.session || active.length || d.state !== 'idle') fail('peripheral_session_busy', '请先完成任务并结束当前搜索会话')
        d.session = { id: randomUUID(), keyword: input.keyword, page: 0, hasMore: false, expiresAt: tx.now + 600_000 }
      } else if (operation === 'next') {
        if (!d.session || input.sessionId !== d.session.id || input.expectedPage !== d.session.page || !d.session.hasMore || active.length || tx.now >= d.session.expiresAt) fail('peripheral_session', '会话、页码已变化或没有下一页；禁止重复翻页')
        input.keyword = d.session.keyword
      } else if (d.session) fail('peripheral_session_busy', '详情操作前请结束搜索会话，避免破坏手机全局分页状态')
      const job = { id: randomUUID(), deviceId: id, operation, input, idempotencyKey, fingerprint,
        sessionId: d.session?.id || null, status: 'queued', createdAt: new Date(tx.now).toISOString(), deadline: tx.now + 300_000 }
      await tx.save(job); bump(d); await event(tx, 'submit', { jobId: job.id, operation }); return job
    })
  }
  async quarantine(tx, job, reason) {
    const d = tx.device
    job.status = 'unknown'; job.error = reason; job.completedAt = new Date(tx.now).toISOString()
    await tx.save(job)
    // Unknown is retained forever as evidence, not rewritten by manual device recovery.
    d.state = 'quarantined'; d.enabled = false; d.unknownJobId = job.id; d.activeJobId = null
    d.recoveryAfter = job.leaseUntil; d.session = null
    for (const queued of await tx.active()) if (queued.status === 'queued') {
      queued.status = 'cancelled'; queued.error = 'device_quarantined'; queued.completedAt = job.completedAt; await tx.save(queued)
    }
    bump(d); await event(tx, 'quarantine', { jobId: job.id, reason })
  }
  async claim(id) {
    return this.store.transaction(id, async tx => {
      const d = tx.device, active = await tx.active()
      const running = active.find(j => j.status === 'running')
      if (running) {
        if (running.leaseUntil <= tx.now) await this.quarantine(tx, running, 'lease_expired_outcome_unknown')
        return null
      }
      if (!d.enabled || d.state !== 'idle' || tx.now < d.cooldownUntil) return null
      for (const job of active) {
        if (job.deadline <= tx.now) {
          job.status = 'expired'; job.completedAt = new Date(tx.now).toISOString(); await tx.save(job)
          if (job.operation === 'search') d.session = null
          bump(d); await event(tx, 'queue-expired', { jobId: job.id }); continue
        }
        try { this.transport.assertOrigin(d.origin) } catch {
          d.enabled = false; bump(d); await event(tx, 'origin-allowlist-blocked'); return null
        }
        job.status = 'running'; job.claimToken = randomUUID(); job.leaseUntil = tx.now + this.leaseMs
        job.startedAt = new Date(tx.now).toISOString()
        job.device = { name: d.name, host: d.host, serial: d.serial, accountKey: d.accountKey, origin: d.origin, adapter: d.adapter, revision: d.revision }
        await tx.save(job); d.state = 'running'; d.activeJobId = job.id; bump(d)
        await event(tx, 'claim', { jobId: job.id }); return { device: { ...d }, job }
      }
      return null
    })
  }
  async execute({ device, job }) {
    // Commit dispatch intent before touching the phone. A crash is never auto-retried.
    const dispatch = await this.store.transaction(device.id, async tx => {
      const current = await tx.job(job.idempotencyKey)
      if (current?.status !== 'running' || current.claimToken !== job.claimToken || tx.now >= current.leaseUntil) return false
      current.dispatchedAt = new Date(tx.now).toISOString(); await tx.save(current); return true
    })
    if (!dispatch) return
    let evidence
    try { evidence = await this.transport.call(device, job.operation, job.input) }
    catch { evidence = { error: 'transport_outcome_unknown' } }
    await this.store.transaction(device.id, async tx => {
      const current = await tx.job(job.idempotencyKey)
      if (current?.status !== 'running' || current.claimToken !== job.claimToken) {
        if (current?.status === 'unknown' && current.claimToken === job.claimToken && !current.lateEvidence) {
          current.lateEvidence = { ...evidence, receivedAt: new Date(tx.now).toISOString() }
          await tx.save(current)
        }
        await event(tx, 'late-result-ignored', { jobId: job.id }); return
      }
      Object.assign(current, evidence)
      if (tx.now >= current.leaseUntil || evidence.error || evidence.httpStatus !== 200 || !validPeripheralResult(job.operation, job.input, evidence.result)) {
        await this.quarantine(tx, current, evidence.error || 'device_response_unverified'); return
      }
      current.status = 'succeeded'; current.completedAt = new Date(tx.now).toISOString(); await tx.save(current)
      const d = tx.device
      d.state = 'idle'; d.activeJobId = null; d.cooldownUntil = tx.now + this.cooldownMs
      if (job.sessionId && d.session?.id === job.sessionId) Object.assign(d.session, { page: evidence.result.page, hasMore: evidence.result.hasMore, expiresAt: tx.now + 600_000 })
      bump(d); await event(tx, 'complete', { jobId: job.id })
    })
  }
  tick() {
    if (this.stopped) return Promise.resolve()
    if (this.tickPromise) return this.tickPromise
    this.tickPromise = (async () => {
      for (const d of await this.store.candidates()) {
        if (this.stopped) break
        if (this.inflight.has(d.id)) continue
        if (this.inflight.size >= 4) break
        let claimed
        try { claimed = await this.claim(d.id) } catch { this.lastErrorAt = new Date().toISOString(); continue }
        if (!claimed) continue
        const execution = this.execute(claimed).catch(() => this.logger.warn('peripheral_execution_requires_reconciliation')).finally(() => this.inflight.delete(d.id))
        this.inflight.set(d.id, execution)
      }
      this.lastTickAt = new Date().toISOString()
    })().finally(() => { this.tickPromise = null })
    return this.tickPromise
  }
  start() {
    this.stopped = false
    this.timer = setInterval(() => { void this.tick().catch(() => { this.lastErrorAt = new Date().toISOString() }) }, 1000)
    this.timer.unref()
  }
  async close() {
    this.stopped = true; clearInterval(this.timer)
    await this.tickPromise?.catch(() => {})
    await Promise.allSettled([...this.inflight.values()])
  }
}
