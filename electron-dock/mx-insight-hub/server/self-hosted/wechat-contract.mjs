import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { AppError } from '../core/errors.mjs'
import { WECHAT_SELF_HOSTED, WECHAT_SELF_HOSTED_LIMITS as LIMITS } from '../../shared/wechat-self-hosted.mjs'

// WeChat self-hosted engine contract: request validation, the Night-All call
// and how each Night-All answer is classified. Pure functions only; the store
// and executor own state. Design: docs/architecture/spider_man/03-self-hosted-engines.md

export const WECHAT_ENGINE_ID = 'night-all.wechat-mp'
export const WECHAT_SELF_HOSTED_VERSION = 'mx-insight-hub.wechat-self-hosted.v1'
export const DEFAULT_ENGINE_BASE_URL = 'http://127.0.0.1:13141'
// Night-All runs the crawler for at most 180 s after it leaves its own queue
// and then waits its 10 s interval; the remainder covers storage and transfer.
export const CRAWLER_TIMEOUT_MS = 180_000
export const DISPATCH_TIMEOUT_MS = 210_000
export const ENGINE_INTERVAL_MS = 10_000
export const DEFAULT_ITEM_MS = 180_000
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ITEMS = 100
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const CLIENT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/u
const SERVICE_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.svc(?:\.cluster\.local)?$/
// The connection was never established, so nothing reached Night-All.
const NOT_DELIVERED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

const invalid = (message, details) => new AppError(400, 'invalid_wechat_self_hosted_request', message, details)

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function assertIdempotencyKey(value) {
  if (!value) throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header is required')
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8-128 safe characters starting with a letter or digit')
  }
  return value
}

function integer(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer between ${min} and ${max}`, { field: name })
  return value
}

export function normalizeSearchItem(body, { allowClientRef = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object')
  const allowed = new Set(['query', 'limit', 'page', 'cacheMaxAgeHours', ...(allowClientRef ? ['clientRef'] : [])])
  const unsupported = Object.keys(body).filter(key => !allowed.has(key))
  if (unsupported.length) throw invalid(`Unsupported fields: ${unsupported.join(', ')}`, { fields: unsupported })
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query || [...query].length > LIMITS.queryLength || CONTROL.test(query)) {
    throw invalid(`query must be 1-${LIMITS.queryLength} characters without control characters`, { field: 'query' })
  }
  const input = {
    query,
    limit: integer(body.limit, 'limit', 1, LIMITS.limitMax, LIMITS.limitDefault),
    page: integer(body.page, 'page', 1, LIMITS.pageMax, 1),
    cacheMaxAgeHours: integer(body.cacheMaxAgeHours, 'cacheMaxAgeHours', 0, LIMITS.cacheHoursMax, LIMITS.cacheHoursDefault),
  }
  if (!allowClientRef || body.clientRef === undefined) return { clientRef: null, input }
  if (typeof body.clientRef !== 'string' || !CLIENT_REF.test(body.clientRef)) throw invalid('clientRef must be 1-64 safe characters', { field: 'clientRef' })
  return { clientRef: body.clientRef, input }
}

export function normalizeBatchRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object')
  const unsupported = Object.keys(body).filter(key => key !== 'items')
  if (unsupported.length) throw invalid(`Unsupported fields: ${unsupported.join(', ')}`, { fields: unsupported })
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > LIMITS.batchItems) {
    throw invalid(`items must contain 1-${LIMITS.batchItems} entries`, { field: 'items' })
  }
  const items = body.items.map(item => normalizeSearchItem(item, { allowClientRef: true }))
  const refs = items.map(item => item.clientRef).filter(Boolean)
  if (new Set(refs).size !== refs.length) throw invalid('clientRef values must be unique', { field: 'clientRef' })
  return items
}

function privateIPv4(host) {
  const [a, b] = host.split('.').map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// Operator-configured origin only: loopback (Admin is hostNetwork), private
// addresses, or an in-cluster Service name for the multi-node layout. Never a
// public host, credentials, path or an implicit port.
export function normalizeEngineBaseUrl(value) {
  const rejected = () => new AppError(400, 'invalid_engine_base_url',
    '地址须为 http(s)://主机:端口，主机限本机回环、内网 IP（10/8、172.16/12、192.168/16、100.64/10）或集群内 *.svc 名称，不能带路径、参数或账号')
  let url
  try { url = new URL(String(value ?? '').trim()) } catch { throw rejected() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname) || !url.port) throw rejected()
  const host = url.hostname
  if (!(host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && privateIPv4(host)) || SERVICE_NAME.test(host))) throw rejected()
  return url.origin
}

export function nightAllSearchBody(input) {
  return {
    businessId: 'hub-wechat-self-hosted',
    platform: 'wechat_mp',
    query: input.query,
    limit: input.limit,
    page: input.page,
    cacheMaxAgeHours: input.cacheMaxAgeHours,
    params: { provider: 'sogou', timeoutMs: CRAWLER_TIMEOUT_MS, timeoutSeconds: 10, noResolve: false },
  }
}

const boundedMs = value => Math.min(MAX_COOLDOWN_MS, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0))
const failed = (code, message, details) => ({ status: 'failed', charge: false, error: { code, message, ...(details ? { details } : {}) } })
const unknown = (code, message, details) => ({ status: 'unknown', charge: false, quarantine: code,
  error: { code, message, ...(details ? { details } : {}) } })

function rows(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw new TypeError('raw_data is not an array')
  return parsed.filter(row => row && typeof row === 'object' && !Array.isArray(row)).slice(0, MAX_ITEMS)
}

// Classify one completed HTTP exchange with Night-All. `charge` follows D10:
// live and fresh cache bill; stale fallback, failures and unknown never do.
export function classifyEngineResponse({ status, text, now = Date.now() }) {
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* handled below */ }
  if (status >= 200 && status < 300) {
    const data = body?.data
    if (!data || typeof data !== 'object') return failed('upstream_response_unusable', 'Night-All 返回的结果无法解析')
    let items
    try { items = rows(data.raw_data ?? '[]') } catch { return failed('upstream_response_unusable', 'Night-All 返回的结果无法解析') }
    const cache = data.meta?.cache || data.cache || null
    const warnings = [data.warnings, data.meta?.warnings].find(Array.isArray) || []
    const sourceMode = cache?.status === 'fresh' ? 'fresh_cache' : cache?.status === 'stale' ? 'stored_fallback' : 'live'
    const result = {
      items, page: data.page && typeof data.page === 'object' ? data.page : null,
      warnings: warnings.slice(0, 20), fetchedAt: typeof cache?.fetchedAt === 'string' ? cache.fetchedAt : null,
      upstream: { requestId: typeof body.requestId === 'string' ? body.requestId : null, traceId: typeof body.traceId === 'string' ? body.traceId : null },
    }
    if (sourceMode !== 'stored_fallback') return { status: 'succeeded', sourceMode, result, charge: true }
    if (cache?.reason === 'sogou_anti_spider') {
      // Either nothing ran (cooldown) or the crawler already reported the block.
      return { status: 'succeeded', sourceMode, result, charge: false, cooldownUntil: now + boundedMs(cache.retryAfterMs) }
    }
    return { ...unknown('upstream_stale_after_failure', '搜狗暂时失败并回退旧结果；Night-All 未确认爬虫已停止'), sourceMode, result }
  }
  const error = body?.error && typeof body.error === 'object' ? body.error : {}
  const code = typeof error.code === 'string' ? error.code : null
  if (status === 429 && code === 'SOGOU_RATE_LIMITED') {
    return { ...failed('upstream_cooldown', '搜狗触发访问限制，Night-All 冷却中'), cooldownUntil: now + boundedMs(error.details?.retryAfterMs) }
  }
  if (status === 503 && code === 'SOGOU_TEMPORARILY_UNAVAILABLE') {
    const cause = typeof error.details?.cause === 'string' ? error.details.cause : ''
    // Only a stated non-timeout cause proves the crawler process has ended.
    if (cause && !/timeout/i.test(cause)) return failed('upstream_unavailable', '搜狗暂时不可用，且没有可用的历史结果', { cause })
    return unknown('upstream_unavailable_after_timeout', '搜狗暂时不可用，可能因爬虫超时；Night-All 未确认爬虫已停止', cause ? { cause } : undefined)
  }
  if (status >= 300 && status < 400) return failed('upstream_redirect', 'Night-All 返回重定向，未跟随', { upstreamStatus: status })
  if (status >= 400 && status < 500) return failed('upstream_rejected', 'Night-All 拒绝了请求', { upstreamStatus: status, upstreamCode: code })
  return unknown('upstream_server_error', 'Night-All 返回服务端错误，爬虫是否已停止未知', { upstreamStatus: status, upstreamCode: code })
}

export function classifyTransportError(error) {
  const cause = error?.cause?.code || error?.code
  if (NOT_DELIVERED.has(cause)) return failed('engine_unreachable', '无法连接 Night-All，请求未送达', { cause })
  if (error?.code === 'response_too_large') return failed('upstream_response_too_large', 'Night-All 返回的结果超过大小上限')
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return unknown('upstream_timeout', '等待 Night-All 超时，爬虫是否已停止未知')
  return unknown('upstream_connection_lost', '与 Night-All 的连接中断，爬虫是否已停止未知', cause ? { cause: String(cause) } : undefined)
}

// Start estimate for a queued job. Durations vary from tens of seconds to
// minutes, so the recent median of live runs replaces a fixed guess.
export function estimateStart({ position, runningSince = null, medianMs = null, cooldownUntil = null, now = Date.now() }) {
  const each = (Number.isFinite(medianMs) && medianMs > 0 ? medianMs : DEFAULT_ITEM_MS) + ENGINE_INTERVAL_MS
  let start = Math.max(now, cooldownUntil || 0)
  if (runningSince != null) start += Math.max(ENGINE_INTERVAL_MS, each - Math.max(0, now - runningSince))
  start += Math.max(0, position - 1) * each
  return new Date(start).toISOString()
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

const iso = value => value == null ? null : new Date(value).toISOString()

export function publicJobView(job, { position = null, estimatedStartAt = null } = {}) {
  const prefix = WECHAT_SELF_HOSTED.apiPrefix
  return {
    jobId: job.id,
    batchId: job.batchId || null,
    clientRef: job.clientRef || null,
    status: job.status,
    input: job.input,
    queue: job.status === 'queued' ? { position, estimatedStartAt } : null,
    timing: { queuedAt: iso(job.queuedAt), deadlineAt: iso(job.deadlineAt), dispatchedAt: iso(job.dispatchedAt),
      finishedAt: iso(job.finishedAt), durationMs: job.durationMs ?? null },
    delivery: { available: Boolean(job.result), sourceMode: job.sourceMode || null,
      fetchedAt: job.result?.fetchedAt || null, itemCount: Array.isArray(job.result?.items) ? job.result.items.length : null },
    billing: { status: job.billing || 'none' },
    error: job.error ? { code: job.error.code, message: job.error.message } : null,
    links: { self: `${prefix}/jobs/${job.id}`, result: `${prefix}/jobs/${job.id}/result` },
  }
}
