import { normalizeEngineBaseUrl } from '../../self-hosted/wechat-contract.mjs'
import { readBounded, parseJson, failed, unknown, notDelivered, transportCause, MAX_RESULT_BYTES } from '../http.mjs'

// Contract for mx-crawler-runner (integration plan phase 4). The runner runs
// one reviewed adapter.py process per invocation and keeps each invocation,
// keyed by dispatchId (= Hub job id), for at least 24 hours.
//
//   POST /v1/invocations          register durably, then start; 202 accepted
//   GET  /v1/invocations/{id}     accepted | running | completed (+ envelope)
//   GET  /v1/health               { ok, version, capacity, running }
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

function completed(data, definition) {
  const outcome = classifyEnvelope(data.envelope, definition)
  return { outcome: { ...outcome, upstreamDurationMs: Number.isInteger(data.durationMs) ? data.durationMs : null } }
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

  async start({ engine, job, definition, credential, fetchImpl, runDeadlineAt }) {
    const call = definition.runner(job.input)
    const deadlineMs = Math.max(1_000, new Date(runDeadlineAt).getTime() - Date.now())
    let answer
    try {
      answer = await exchange(fetchImpl, new URL('/v1/invocations', engine.baseUrl), {
        method: 'POST', headers: headers(credential),
        body: JSON.stringify({ protocol: RUNNER_PROTOCOL, dispatchId: job.id, slotId: engine.slotRef, operation: call.operation, params: call.params, deadlineMs }),
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

  async probe({ engine, credential, fetchImpl, baseUrl = engine.baseUrl }) {
    const started = Date.now()
    try {
      const response = await fetchImpl(new URL('/v1/health', baseUrl), {
        redirect: 'manual', headers: headers(credential), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const body = parseJson(await readBounded(response, 64 * 1024)) || {}
      const data = body.data && typeof body.data === 'object' ? body.data : {}
      return { baseUrl, reachable: true, httpStatus: response.status, healthy: response.ok && data.ok === true, durationMs: Date.now() - started,
        version: typeof data.version === 'string' ? data.version : null,
        capacity: Number.isInteger(data.capacity) ? data.capacity : null, running: Number.isInteger(data.running) ? data.running : null }
    } catch (error) {
      return { baseUrl, reachable: false, httpStatus: null, healthy: false, durationMs: Date.now() - started,
        error: error?.name === 'TimeoutError' ? 'timeout' : transportCause(error) }
    }
  },
})
