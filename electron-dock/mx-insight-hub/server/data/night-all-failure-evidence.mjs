import { AppError } from '../core/errors.mjs'

// Retain structure, never arbitrary error messages/stack/URLs/params/bodyPreview.
// Nested candidate failures are evidence, not a single inferred root cause.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : null
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
const MAX_RETRY_SECONDS = 86400
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null
const isoDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null
  const normalized = new Date(value).toISOString()
  return normalized === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? normalized : null
}

export function projectNightAllRateLimit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = {}
  if (value.layer === 'night_all_ingress') result.layer = value.layer
  if (['data-search', 'public', 'search', 'raw', 'crawl', 'user-info'].includes(value.scope)) result.scope = value.scope
  if (value.keyType === 'ip') result.keyType = value.keyType
  for (const [key, maximum] of [['limit', 1_000_000_000], ['remaining', 1_000_000_000], ['windowMs', 86400000], ['retryAfterSeconds', MAX_RETRY_SECONDS]]) {
    if (integer(value[key], maximum) !== null) result[key] = value[key]
  }
  if (isoDate(value.resetAt)) result.resetAt = isoDate(value.resetAt)
  if (value.dispatched === false && result.layer === 'night_all_ingress') result.dispatched = false
  return Object.keys(result).length ? result : null
}

// Read only known rate-limit scalars. Header countdown takes precedence over
// JSON metadata; a generic RATE_LIMITED code never identifies the failing layer.
export function nightAllRateLimitEvidence(headers, body, { now = Date.now() } = {}) {
  const result = projectNightAllRateLimit(body?.error?.details?.rateLimit ?? body?.details?.rateLimit) || {}
  const headerInteger = (name, maximum) => {
    const value = headers?.get(name)
    return typeof value === 'string' && /^\d{1,12}$/.test(value) ? integer(Number(value), maximum) : null
  }
  for (const [header, key] of [['x-rate-limit-limit', 'limit'], ['x-rate-limit-remaining', 'remaining']]) {
    const value = headerInteger(header, 1_000_000_000)
    if (value !== null) result[key] = value
  }
  const reset = headerInteger('x-rate-limit-reset', 253402300799)
  if (reset !== null) result.resetAt = new Date(reset * 1000).toISOString()
  const retry = headers?.get('retry-after')
  let seconds = typeof retry === 'string' && /^\d{1,7}$/.test(retry) ? integer(Number(retry), MAX_RETRY_SECONDS) : null
  if (seconds === null && typeof retry === 'string' && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)) {
    const at = Date.parse(retry)
    if (Number.isFinite(at) && new Date(at).toUTCString() === retry) seconds = integer(Math.max(0, Math.ceil((at - now) / 1000)), MAX_RETRY_SECONDS)
  }
  if (seconds !== null) result.retryAfterSeconds = seconds
  return projectNightAllRateLimit(result)
}
const messages = {
  TIKHUB_ALL_ENDPOINTS_FAILED: 'Night-All 的 TikHub 候选端点均失败；查看各候选端点证据。',
  TIKHUB_HTTP_ERROR: 'TikHub 返回非成功 HTTP 状态。',
  TIKHUB_NETWORK_ERROR: 'Night-All 到 TikHub 的网络请求失败。',
  TIKHUB_API_KEY_MISSING: 'Night-All 未配置 TikHub API Key。',
  TIKHUB_DISABLED: 'Night-All 已禁用 TikHub。',
  CRAWLER_COMMAND_FAILED: 'Night-All 采集子进程失败；需关联日志确认原因。',
  invalid_upstream_content_type: 'Night-All 返回非 JSON 错误响应。',
  invalid_upstream_json: 'Night-All 返回的错误正文不是有效 JSON。',
}

export function nightAllRejectionError(error, httpStatus, requestId) {
  // Only the envelope's own code is public; nested candidate diagnostics and
  // arbitrary upstream messages remain restricted evidence.
  const upstreamCode = [error.body?.error?.code, error.body?.code].find(value =>
    identifier(value) || (typeof value === 'number' && Number.isFinite(value)),
  )
  const hasCode = upstreamCode !== undefined
  const rateLimit = projectNightAllRateLimit(error.rateLimit)
  return new AppError(
    httpStatus,
    'night_all_rejected',
    `Night-All rejected the request${hasCode ? ` (upstreamCode: ${upstreamCode})` : ''}`,
    { requestId, upstreamStatus: error.status, ...(hasCode ? { upstreamCode } : {}),
      ...(error.status === 429 && rateLimit?.retryAfterSeconds != null ? { retryAfterMs: rateLimit.retryAfterSeconds * 1000 } : {}),
      ...(error.status === 429 && upstreamCode === 'RATE_LIMITED' && rateLimit?.layer === 'night_all_ingress'
        && rateLimit.dispatched === false ? { upstreamLayer: rateLimit.layer } : {}) },
  )
}

export function projectNightAllFailureEvidence(value) {
  if (value?.version !== 1 || !Array.isArray(value.errors)) return null
  const result = {
    version: 1, requestId: identifier(value.requestId), traceId: identifier(value.traceId),
    httpStatus: status(value.httpStatus), truncated: value.truncated === true || value.errors.length > 16,
    errors: value.errors.slice(0, 16).map(entry => ({
      path: typeof entry?.path === 'string' && /^\$(?:\.(?:error|details|cause|errors|endpointTrace|attempts)|\[\d{1,3}\]){0,16}$/.test(entry.path) ? entry.path : '$',
      code: identifier(entry?.code), httpStatus: status(entry?.httpStatus),
      endpointId: identifier(entry?.endpointId), requestId: identifier(entry?.requestId),
      traceId: identifier(entry?.traceId), message: Object.hasOwn(messages, entry?.code) ? messages[entry.code] : null,
      originalMessageOmitted: entry?.originalMessageOmitted === true,
    })),
  }
  const rateLimit = projectNightAllRateLimit(value.rateLimit)
  if (rateLimit) result.rateLimit = rateLimit
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 15000 && result.errors.length) {
    result.errors.pop()
    result.truncated = true
  }
  return result
}

export function nightAllFailureEvidence(error) {
  const body = error?.body
  const errors = []
  let visited = 0, truncated = false
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object') return
    if (depth > 6 || visited++ >= 64 || errors.length >= 16) { truncated = true; return }
    if (Array.isArray(node)) {
      if (node.length > 16) truncated = true
      node.slice(0, 16).forEach((entry, i) => walk(entry, `${path}[${i}]`, depth + 1))
      return
    }
    const entry = { path, code: identifier(node.code),
      httpStatus: status(node.statusCode) || status(node.httpStatus) || status(node.upstreamStatus),
      endpointId: identifier(node.endpointId), requestId: identifier(node.requestId),
      traceId: identifier(node.traceId), originalMessageOmitted: typeof node.message === 'string' }
    if (entry.code || entry.httpStatus || entry.endpointId || entry.requestId || entry.traceId || entry.originalMessageOmitted) errors.push(entry)
    for (const key of ['error', 'details', 'cause', 'errors', 'endpointTrace', 'attempts']) walk(node[key], `${path}.${key}`, depth + 1)
  }
  walk(body, '$', 0)
  return projectNightAllFailureEvidence({ version: 1, httpStatus: error?.status ?? error?.upstreamHttpStatus,
    requestId: identifier(body?.requestId) || identifier(error?.upstreamRequestId),
    traceId: identifier(body?.traceId) || identifier(error?.upstreamTraceId), errors, truncated,
    rateLimit: error?.rateLimit })
}
