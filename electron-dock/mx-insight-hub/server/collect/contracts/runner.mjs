import { normalizeEngineBaseUrl } from '../../self-hosted/wechat-contract.mjs'
import { collectEgressProvider } from '../../../shared/collect-engines.mjs'
import { readBounded, parseJson, failed, unknown, notDelivered, transportCause, MAX_RESULT_BYTES } from '../http.mjs'

// Contract for mx-crawler-runner (integration plan phase 4). The runner runs
// one reviewed adapter.py process per invocation and keeps each invocation,
// keyed by dispatchId (= Hub job id), for at least 24 hours.
//
//   POST /v1/invocations              register durably, then start; 202 accepted
//   GET  /v1/invocations/{id}         accepted | running | completed (+ envelope | failure)
//   POST /v1/invocations/{id}/abort   stop the process group; answers once it has ended
//   GET  /v1/health                   { ok, version, capacity, running, slots }
//
// Implementation: electron-dock/mx-base/mx-crawler-runner. A slot whose
// package needs overseas egress (Google Play) gets the proxy chosen from its
// System Proxy binding on every start; the runner hands it to the process.
//
// Because the runner registers before it starts, 404 on an invocation that
// was never confirmed means it never started. Every other ambiguous answer is
// reconciled by reading the invocation again instead of guessing.

export const RUNNER_PROTOCOL = 'mx-crawler-runner.v1'
const REQUEST_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 5_000
const ACCEPTED = new Set(['accepted', 'running'])
const UNCONFIRMED_RECHECK_MS = 10_000
const UNCONFIRMED_MISSES = 3

const nextCheckMs = checks => Math.min(30_000, Math.round(2_000 * 1.5 ** Math.max(0, checks)))
const headers = credential => ({ 'content-type': 'application/json', accept: 'application/json',
  ...(credential ? { authorization: `Bearer ${credential}` } : {}) })

// Map one adapter envelope (status success|no_data|partial|unknown|error|stopped)
// to a job outcome. The process has ended in every case, so nothing here holds
// the slot; an adapter-reported unknown only marks the data and billing.
export function classifyEnvelope(envelope, definition = null) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.status !== 'string') {
    return failed('adapter_output_unusable', '适配器返回的结果外壳无法解析；进程已结束，不收费')
  }
  const itemCount = definition?.itemCount ? definition.itemCount(envelope) : null
  const reported = envelope.error && typeof envelope.error === 'object'
    ? { code: typeof envelope.error.code === 'string' ? envelope.error.code : null, message: typeof envelope.error.message === 'string' ? envelope.error.message.slice(0, 500) : null }
    : null
  switch (envelope.status) {
    case 'success': return { status: 'succeeded', dataStatus: 'success', result: envelope, itemCount, charge: true }
    case 'partial': return { status: 'succeeded', dataStatus: 'partial', result: envelope, itemCount, charge: true }
    case 'no_data': return { status: 'succeeded', dataStatus: 'no_data', result: envelope, itemCount: itemCount ?? 0, charge: true }
    case 'error': return { ...failed('adapter_error', reported?.message || '适配器报告采集失败', reported || undefined), result: envelope }
    case 'stopped': return { ...failed('adapter_stopped', '适配器在截止时间前停止；进程已结束', reported || undefined), result: envelope }
    case 'unknown': return { ...unknown('adapter_unknown', '适配器报告上游结果未知；进程已结束，待核实', reported || undefined, null), result: envelope }
    default: return failed('adapter_output_unusable', `适配器返回了未定义的状态 ${envelope.status}`)
  }
}

// Runner-side endings that produced no envelope. The process group has ended
// in every case, so none of them holds the slot or is charged.
const RUNNER_FAILURES = Object.freeze({
  deadline_exceeded: 'runner 在截止时间停止了适配器进程；不收费',
  aborted: 'runner 已按要求中止适配器进程；不收费',
  interrupted: 'runner 重启或停止时适配器仍在运行，进程已结束；不收费',
  output_too_large: '适配器输出超过 runner 的大小上限；进程已结束，不收费',
  output_unusable: '适配器没有输出可解析的结果外壳；进程已结束，不收费',
  spawn_failed: 'runner 无法启动适配器进程；不收费',
  workdir_unavailable: 'runner 无法创建工作目录，未启动适配器；不收费',
})

function completed(data, definition) {
  let outcome
  if (!data.envelope && data.failure && typeof data.failure.code === 'string') {
    const code = data.failure.code.slice(0, 64)
    outcome = failed(`runner_${code}`, RUNNER_FAILURES[code] || 'runner 报告调用失败；进程已结束，不收费',
      typeof data.failure.message === 'string' ? { runnerMessage: data.failure.message.slice(0, 300) } : undefined)
  } else outcome = classifyEnvelope(data.envelope, definition)
  if (Array.isArray(data.steps)) outcome = withSteps(outcome, data)
  return { outcome: { ...outcome, upstreamDurationMs: Number.isInteger(data.durationMs) ? data.durationMs : null } }
}

// Multi-step invocation (e.g. discover then collect). The last step that ran
// decides the outcome; every step's envelope is kept as the result, and a
// partial earlier step keeps the whole result partial.
function withSteps(outcome, data) {
  const steps = data.steps.map((step, index) => ({
    operation: typeof step?.operation === 'string' ? step.operation : null,
    status: typeof step?.status === 'string' ? step.status : null,
    failure: step?.failure ?? null,
    envelope: index === data.steps.length - 1 ? data.envelope ?? null : step?.envelope ?? null,
  }))
  const earlierPartial = steps.slice(0, -1).some(step => step.status === 'partial')
  const result = { runnerOperation: typeof data.operation === 'string' ? data.operation : null, steps }
  if (outcome.status !== 'succeeded') return { ...outcome, result }
  return { ...outcome, result, dataStatus: earlierPartial && outcome.dataStatus === 'success' ? 'partial' : outcome.dataStatus }
}

// Proxy for this engine's slot, chosen from its System Proxy binding. The
// calls are free public reads, so the selector may probe and fail over.
async function proxyFor(engine, deps) {
  const provider = collectEgressProvider(engine)
  if (!provider) return { proxyUrl: null }
  if (typeof deps?.egressFor !== 'function') return { proxyUrl: null }
  try {
    return { proxyUrl: await deps.egressFor(provider) }
  } catch (error) {
    return { error: failed('egress_unavailable', 'System Proxy 出口不可用，未调用 runner', { provider, cause: String(error?.code || 'proxy_route_unavailable') }) }
  }
}

async function exchange(fetchImpl, url, init) {
  const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init })
  const text = await readBounded(response, MAX_RESULT_BYTES)
  return { status: response.status, body: parseJson(text) }
}

export const runnerContract = Object.freeze({
  kind: 'runner',
  mode: 'async',
  // A dispatch whose executor vanished is resolved by reading the invocation.
  reconcilable: true,

  normalizeBaseUrl: value => normalizeEngineBaseUrl(value),
  normalizeConfig(config) {
    if (config && Object.keys(config).length) {
      throw Object.assign(new Error('runner engines take no extra configuration'), { code: 'invalid_engine_config' })
    }
    return {}
  },

  async start({ engine, job, definition, credential, fetchImpl, runDeadlineAt, deps }) {
    if (!engine.slotRef) return { outcome: failed('engine_slot_missing', 'runner 引擎没有填写插槽 ID，未调用 runner') }
    const call = definition.runner(job.input)
    const deadlineMs = Math.max(1_000, new Date(runDeadlineAt).getTime() - Date.now())
    const egress = await proxyFor(engine, deps)
    if (egress.error) return { outcome: egress.error }
    let answer
    try {
      answer = await exchange(fetchImpl, new URL('/v1/invocations', engine.baseUrl), {
        method: 'POST', headers: headers(credential),
        body: JSON.stringify({ protocol: RUNNER_PROTOCOL, dispatchId: job.id, slotId: engine.slotRef,
          ...(call.steps ? { steps: call.steps } : { operation: call.operation, params: call.params }), deadlineMs,
          ...(egress.proxyUrl ? { proxyUrl: egress.proxyUrl } : {}) }),
      })
    } catch (error) {
      if (notDelivered(error)) return { outcome: failed('engine_unreachable', '无法连接 runner，请求未送达', { cause: transportCause(error) }) }
      if (error?.code === 'response_too_large') return { outcome: unknown('runner_response_too_large', 'runner 的应答超过大小上限') }
      // The request may have arrived; read the invocation to find out.
      return { upstream: { ref: job.id, state: { confirmed: false } }, nextCheckMs: UNCONFIRMED_RECHECK_MS }
    }
    const { status, body } = answer
    const data = body?.data && typeof body.data === 'object' ? body.data : null
    if (status >= 200 && status < 300 && data?.state === 'completed') return completed(data, definition)
    if (status >= 200 && status < 300 && ACCEPTED.has(data?.state)) return { upstream: { ref: job.id, state: { confirmed: true } }, nextCheckMs: nextCheckMs(0) }
    const code = typeof body?.error?.code === 'string' ? body.error.code : null
    if (status === 429) return { outcome: failed('runner_busy', 'runner 没有空闲容量，未开始执行', { upstreamCode: code }) }
    if (status === 424) return { outcome: failed('runner_package_unavailable', 'runner 上该交付包不可运行（未安装或校验不符），未开始执行', { upstreamCode: code }) }
    if (status === 404 && code === 'slot_unknown') return { outcome: failed('runner_slot_unknown', 'runner 没有这个插槽的审核包，未开始执行', { upstreamCode: code }) }
    if (status === 409) return { outcome: unknown('runner_invocation_conflict', 'runner 已有同一 dispatchId 的不同调用', { upstreamCode: code }) }
    if (status >= 300 && status < 400) return { outcome: failed('upstream_redirect', 'runner 返回重定向，未跟随', { upstreamStatus: status }) }
    if (status >= 400 && status < 500) return { outcome: failed('upstream_rejected', 'runner 拒绝了调用，未开始执行', { upstreamStatus: status, upstreamCode: code }) }
    return { upstream: { ref: job.id, state: { confirmed: false } }, nextCheckMs: UNCONFIRMED_RECHECK_MS }
  },

  async check({ engine, job, definition, credential, fetchImpl }) {
    let answer
    try {
      answer = await exchange(fetchImpl, new URL(`/v1/invocations/${encodeURIComponent(job.id)}`, engine.baseUrl), { headers: headers(credential) })
    } catch {
      return { nextCheckMs: nextCheckMs(job.checks) }
    }
    const { status, body } = answer
    const data = body?.data && typeof body.data === 'object' ? body.data : null
    if (status === 200 && data?.state === 'completed') return completed(data, definition)
    if (status === 200 && ACCEPTED.has(data?.state)) return { upstream: { state: { confirmed: true } }, nextCheckMs: nextCheckMs(job.checks) }
    if (status === 404) {
      if (job.upstreamState?.confirmed) return { outcome: unknown('runner_lost_invocation', 'runner 已确认接收但现在查不到该调用，进程是否已停止未知') }
      // A request that timed out on our side may still be registering; only
      // repeated misses, spaced apart, prove it never arrived.
      if (job.checks < UNCONFIRMED_MISSES) return { nextCheckMs: UNCONFIRMED_RECHECK_MS }
      return { outcome: failed('engine_not_started', 'runner 没有收到该调用，未开始执行') }
    }
    return { nextCheckMs: nextCheckMs(job.checks) }
  },

  // Called at the run deadline. A completed answer (the runner's own
  // deadline usually got there first) is a confirmed stop.
  async abort({ engine, job, credential, fetchImpl }) {
    try {
      const { status, body } = await exchange(fetchImpl, new URL(`/v1/invocations/${encodeURIComponent(job.id)}/abort`, engine.baseUrl), {
        method: 'POST', headers: headers(credential) })
      const data = body?.data && typeof body.data === 'object' ? body.data : null
      return { stopped: status === 200 && data?.state === 'completed', status }
    } catch {
      return { stopped: false }
    }
  },

  async probe({ engine, credential, fetchImpl, baseUrl = engine.baseUrl }) {
    const started = Date.now()
    try {
      const response = await fetchImpl(new URL('/v1/health', baseUrl), {
        redirect: 'manual', headers: headers(credential), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const body = parseJson(await readBounded(response, 64 * 1024)) || {}
      const data = body.data && typeof body.data === 'object' ? body.data : {}
      // The engine is healthy only if the runner can run this engine's package.
      const slot = Array.isArray(data.slots) ? data.slots.find(item => item?.slotId === engine.slotRef) : null
      const slotState = slot ? { slotId: slot.slotId, available: slot.available === true, reason: typeof slot.reason === 'string' ? slot.reason : null,
        operations: Array.isArray(slot.operations) ? slot.operations.filter(op => typeof op === 'string').slice(0, 32) : [] } : null
      return { baseUrl, reachable: true, httpStatus: response.status, healthy: response.ok && data.ok === true && (!engine.slotRef || slotState?.available === true),
        durationMs: Date.now() - started, version: typeof data.version === 'string' ? data.version : null,
        capacity: Number.isInteger(data.capacity) ? data.capacity : null, running: Number.isInteger(data.running) ? data.running : null,
        slot: slotState, ...(engine.slotRef && !slotState && response.ok ? { error: 'slot_not_on_runner' } : {}) }
    } catch (error) {
      return { baseUrl, reachable: false, httpStatus: null, healthy: false, durationMs: Date.now() - started,
        error: error?.name === 'TimeoutError' ? 'timeout' : transportCause(error) }
    }
  },
})
