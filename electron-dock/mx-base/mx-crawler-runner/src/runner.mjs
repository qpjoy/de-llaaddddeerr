import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { verifyCatalog } from './catalog.mjs'
import { runAdapter } from './process.mjs'
import { DISPATCH_ID, InvocationRegistry } from './registry.mjs'

export const PROTOCOL = 'mx-crawler-runner.v1'
export const VERSION = '0.1.0'
// Fixed limits; the Hub engines in front of the runner hold the queue. The
// capacity must stay at or above the total execution slots of all Hub runner
// engines (18 packages x 1 by default), or bursts are refused with 429
// instead of queueing in Hub; perSlot bounds how far one engine can be raised.
export const LIMITS = Object.freeze({
  capacity: 24,
  perSlot: 4,
  minDeadlineMs: 1_000,
  maxSteps: 4,
  maxDeadlineMs: 6 * 60 * 60 * 1000,
  retentionMs: 24 * 60 * 60 * 1000,
  pruneEveryMs: 10 * 60 * 1000,
})

export class RunnerError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const canonical = value => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item))
// Over the whole request shape: { slotId, operation, params } or { slotId, steps }.
const requestHash = request => createHash('sha256').update(canonical(request)).digest('hex')

function validateProxy(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048) throw new RunnerError(400, 'invalid_proxy', 'proxyUrl must be an http(s) URL')
  let url
  try { url = new URL(value) } catch { throw new RunnerError(400, 'invalid_proxy', 'proxyUrl must be an http(s) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new RunnerError(400, 'invalid_proxy', 'proxyUrl must be an http(s) proxy origin')
  }
  return value
}

// What the Hub sees. The adapter's stderr stays in the runner's own log.
export function invocationView(record) {
  return {
    dispatchId: record.dispatchId, slotId: record.slotId, operation: record.operation, state: record.state,
    acceptedAt: record.acceptedAt, startedAt: record.startedAt ?? null, finishedAt: record.finishedAt ?? null,
    deadlineAt: record.deadlineAt, durationMs: record.durationMs ?? null, exitCode: record.exitCode ?? null,
    // `envelope`/`failure` are always the last step that ran; earlier steps of
    // a multi-step invocation are listed in `steps` with their own envelopes.
    envelope: record.envelope ?? null, failure: record.failure ?? null,
    ...(record.steps ? { steps: record.steps } : {}),
  }
}

function checkStep(slot, operation, params, where) {
  if (typeof operation !== 'string' || !slot.operations.includes(operation)) {
    throw new RunnerError(400, 'operation_not_allowed', `${where}operation must be one of: ${slot.operations.join(', ')}`)
  }
  const value = params === undefined ? {} : params
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError(400, 'invalid_params', `${where}params must be an object`)
  const reserved = Object.keys(value).filter(key => slot.reserved.includes(key))
  if (reserved.length) throw new RunnerError(400, 'reserved_param', `${where}runner-owned parameters: ${reserved.join(', ')}`)
  return { operation, params: value }
}

export class Runner {
  constructor({ slots, dataDir, nodePath = process.execPath, logger = null, limits = LIMITS, run = runAdapter, now = () => Date.now() }) {
    this.slots = slots
    this.registry = new InvocationRegistry(dataDir)
    this.nodePath = nodePath
    this.limits = { ...LIMITS, ...limits }
    this.run = run
    this.now = now
    this.log = logger || (entry => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`))
    this.active = new Map()
    this.locks = new Map()
    this.states = new Map()
    this.closing = false
    this.diskBytes = null
  }

  async init() {
    await this.registry.init()
    this.states = verifyCatalog(this.slots, { nodePath: this.nodePath })
    for (const [slotId, state] of this.states) this.log({ level: state.available ? 'info' : 'warn', event: 'package', slotId, ...state })
    // A record still accepted or running belongs to a process that ended with
    // the previous runner (same container, same process group lifetime).
    let recovered = 0
    for await (const record of this.registry.all()) {
      if (record.state === 'completed') continue
      await this.registry.write({ ...record, state: 'completed', finishedAt: new Date(this.now()).toISOString(), envelope: null,
        failure: { code: 'interrupted', message: 'runner 重启时该调用仍在运行；适配器进程已随上一个 runner 结束' } })
      recovered += 1
    }
    if (recovered) this.log({ level: 'warn', event: 'recovered_interrupted', count: recovered })
    await this.prune()
  }

  health() {
    const perSlot = new Map()
    for (const entry of this.active.values()) perSlot.set(entry.slotId, (perSlot.get(entry.slotId) || 0) + 1)
    return {
      ok: !this.closing, protocol: PROTOCOL, version: VERSION, capacity: this.limits.capacity, running: this.active.size,
      perSlotLimit: this.limits.perSlot, diskBytes: this.diskBytes,
      slots: [...this.slots.values()].map(slot => ({ slotId: slot.slotId, packageId: slot.packageId, label: slot.label,
        operations: slot.operations, proxy: slot.proxy, running: perSlot.get(slot.slotId) || 0,
        available: this.states.get(slot.slotId)?.available ?? false, reason: this.states.get(slot.slotId)?.reason ?? 'not_verified' })),
    }
  }

  // Serialise everything that touches one dispatchId.
  async #locked(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const chained = previous.then(() => current)
    this.locks.set(id, chained)
    await previous
    try { return await fn() } finally {
      release()
      if (this.locks.get(id) === chained) this.locks.delete(id)
    }
  }

  #validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RunnerError(400, 'invalid_request', 'Body must be a JSON object')
    const allowed = new Set(['protocol', 'dispatchId', 'slotId', 'operation', 'params', 'steps', 'deadlineMs', 'proxyUrl'])
    const extra = Object.keys(body).filter(key => !allowed.has(key))
    if (extra.length) throw new RunnerError(400, 'invalid_request', `Unsupported fields: ${extra.join(', ')}`)
    if (body.protocol !== PROTOCOL) throw new RunnerError(400, 'protocol_unsupported', `protocol must be ${PROTOCOL}`)
    if (typeof body.dispatchId !== 'string' || !DISPATCH_ID.test(body.dispatchId)) throw new RunnerError(400, 'invalid_dispatch_id', 'dispatchId is invalid')
    const slot = typeof body.slotId === 'string' ? this.slots.get(body.slotId) : null
    if (!slot) throw new RunnerError(404, 'slot_unknown', 'slotId is not a reviewed package on this runner')
    // Either one operation, or 1-4 steps run in order in one work directory
    // (stateful packages: discover stores shows that collect then reads).
    let steps
    if (body.steps !== undefined) {
      if (body.operation !== undefined || body.params !== undefined) throw new RunnerError(400, 'invalid_request', 'Send operation/params or steps, not both')
      if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > this.limits.maxSteps) {
        throw new RunnerError(400, 'invalid_steps', `steps must list 1-${this.limits.maxSteps} operations`)
      }
      steps = body.steps.map((step, index) => {
        if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => key !== 'operation' && key !== 'params')) {
          throw new RunnerError(400, 'invalid_steps', `steps[${index}] must be { operation, params }`)
        }
        return checkStep(slot, step.operation, step.params, `steps[${index}].`)
      })
    } else steps = [checkStep(slot, body.operation, body.params, '')]
    if (!Number.isInteger(body.deadlineMs) || body.deadlineMs < this.limits.minDeadlineMs || body.deadlineMs > this.limits.maxDeadlineMs) {
      throw new RunnerError(400, 'invalid_deadline', `deadlineMs must be ${this.limits.minDeadlineMs}-${this.limits.maxDeadlineMs}`)
    }
    const proxyUrl = validateProxy(body.proxyUrl)
    if (proxyUrl && slot.proxy === 'never') throw new RunnerError(400, 'proxy_not_allowed', 'This package runs on direct egress only')
    return { slot, dispatchId: body.dispatchId, steps, multi: body.steps !== undefined, deadlineMs: body.deadlineMs, proxyUrl }
  }

  // Returns { status: 200|202, invocation }.
  async submit(body) {
    if (this.closing) throw new RunnerError(503, 'runner_closing', 'Runner is shutting down')
    const request = this.#validate(body)
    return this.#locked(request.dispatchId, async () => {
      const hash = request.multi ? requestHash({ slotId: request.slot.slotId, steps: request.steps })
        : requestHash({ slotId: request.slot.slotId, operation: request.steps[0].operation, params: request.steps[0].params })
      const existing = await this.registry.read(request.dispatchId)
      if (existing) {
        if (existing.requestHash !== hash) throw new RunnerError(409, 'invocation_conflict', 'dispatchId already holds a different invocation')
        return { status: existing.state === 'completed' ? 200 : 202, invocation: invocationView(existing) }
      }
      const state = this.states.get(request.slot.slotId)
      if (!state?.available) throw new RunnerError(424, 'package_unavailable', `Package is not runnable here (${state?.reason || 'not_verified'})`)
      const running = [...this.active.values()]
      if (running.length >= this.limits.capacity || running.filter(entry => entry.slotId === request.slot.slotId).length >= this.limits.perSlot) {
        throw new RunnerError(429, 'runner_busy', 'No free capacity; nothing was started')
      }
      const now = this.now()
      const record = {
        dispatchId: request.dispatchId, slotId: request.slot.slotId, packageId: request.slot.packageId, packageSha256: request.slot.sha256,
        operation: request.steps.map(step => step.operation).join('+'), requestHash: hash, proxied: Boolean(request.proxyUrl), state: 'accepted',
        acceptedAt: new Date(now).toISOString(), deadlineAt: new Date(now + request.deadlineMs).toISOString(),
      }
      // Durable before anything starts.
      await this.registry.write(record)
      const controller = new AbortController()
      const entry = { slotId: request.slot.slotId, controller, done: null }
      this.active.set(request.dispatchId, entry)
      entry.done = this.#execute(request, record, controller.signal)
      return { status: 202, invocation: invocationView(record) }
    })
  }

  async #execute(request, record, signal) {
    const workDir = this.registry.workDir(request.slot.slotId, request.dispatchId)
    const inject = params => {
      const out = { ...params }
      if (request.slot.inject.work_dir) out.work_dir = join(workDir, 'data')
      if (request.slot.inject.run_dir) out.run_dir = join(workDir, 'data')
      if (request.slot.inject.runtime_dir) out.runtime_dir = join(request.slot.root, '.runtime')
      return out
    }
    let current = record
    let runningWrite = Promise.resolve()
    const ran = []
    try {
      for (const [index, step] of request.steps.entries()) {
        const result = await this.run({
          slot: request.slot, operation: step.operation, params: inject(step.params), workDir, deadlineAt: Date.parse(record.deadlineAt),
          proxyUrl: request.proxyUrl, nodePath: this.nodePath, signal,
          onStart: pid => {
            current = { ...current, state: 'running', startedAt: current.startedAt || new Date(this.now()).toISOString(), pid,
              ...(request.multi ? { step: index + 1 } : {}) }
            // Best effort: `accepted` already proves the dispatch arrived. The
            // completed write waits for it so a late rename cannot regress it.
            const write = this.registry.write(current).catch(() => {})
            runningWrite = runningWrite.then(() => write)
          },
        })
        ran.push({ operation: step.operation, result })
        // A later step only runs on usable output from the one before it.
        if (result.failure || !['success', 'partial'].includes(result.envelope?.status) || signal.aborted) break
      }
      await runningWrite
      const last = ran.at(-1).result
      const durationMs = ran.reduce((sum, item) => sum + item.result.durationMs, 0)
      current = { ...current, state: 'completed', startedAt: current.startedAt || record.acceptedAt, finishedAt: new Date(this.now()).toISOString(),
        durationMs, exitCode: last.exitCode, exitSignal: last.signal, envelope: last.envelope, failure: last.failure,
        ...(request.multi ? { steps: ran.map((item, index) => ({ operation: item.operation, durationMs: item.result.durationMs, exitCode: item.result.exitCode,
          status: item.result.envelope?.status ?? null, failure: item.result.failure, ...(index < ran.length - 1 ? { envelope: item.result.envelope } : {}) })) } : {}) }
      delete current.step
      await this.registry.write(current)
      this.log({ level: last.failure ? 'warn' : 'info', event: 'invocation_completed', dispatchId: record.dispatchId, slotId: record.slotId,
        operation: record.operation, steps: ran.length, durationMs, exitCode: last.exitCode, status: last.envelope?.status ?? null,
        failure: last.failure?.code ?? null, ...(last.failure || last.envelope?.status === 'error' ? { stderrTail: last.stderrTail.slice(-2048) } : {}) })
    } catch (error) {
      this.log({ level: 'error', event: 'invocation_record_failed', dispatchId: record.dispatchId, error: error?.code || error?.message })
    } finally {
      this.active.delete(record.dispatchId)
    }
  }

  async get(id) {
    if (typeof id !== 'string' || !DISPATCH_ID.test(id)) throw new RunnerError(404, 'invocation_not_found', 'Invocation not found')
    const record = await this.registry.read(id)
    if (!record) throw new RunnerError(404, 'invocation_not_found', 'Invocation not found')
    return invocationView(record)
  }

  // Stop the process group and wait for the record; the Hub frees its slot
  // only on a confirmed stop.
  async abort(id) {
    const entry = this.active.get(id)
    if (entry) {
      entry.controller.abort('aborted')
      await entry.done
    }
    return this.get(id)
  }

  async prune() {
    const removed = await this.registry.prune({ retentionMs: this.limits.retentionMs, now: this.now() }).catch(() => 0)
    this.diskBytes = await this.registry.usageBytes().catch(() => null)
    if (removed) this.log({ level: 'info', event: 'pruned', count: removed })
    return removed
  }

  async close() {
    this.closing = true
    const entries = [...this.active.values()]
    for (const entry of entries) entry.controller.abort('shutdown')
    await Promise.allSettled(entries.map(entry => entry.done))
  }
}
