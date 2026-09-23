import { AppError } from '../core/errors.mjs'

// Retain structure, never arbitrary error messages/stack/URLs/params/bodyPreview.
// Nested candidate failures are evidence, not a single inferred root cause.
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : null
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null
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
  return new AppError(
    httpStatus,
    'night_all_rejected',
    `Night-All rejected the request${hasCode ? ` (upstreamCode: ${upstreamCode})` : ''}`,
    { requestId, upstreamStatus: error.status, ...(hasCode ? { upstreamCode } : {}) },
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
  return projectNightAllFailureEvidence({ version: 1, httpStatus: error?.status,
    requestId: identifier(body?.requestId) || identifier(error?.upstreamRequestId),
    traceId: identifier(body?.traceId) || identifier(error?.upstreamTraceId), errors, truncated })
}
