import { AppError } from '../core/errors.mjs'

export function peripheralOrigin(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error()
    return url.origin
  } catch { throw new AppError(400, 'peripheral_origin', '请输入不含路径、凭证或参数的 HTTP(S) 服务地址') }
}

// Exact deployment-owned origins, fixed paths, no redirects, retries or system proxy.
// ADB :18081 must remain private; an origin in the allowlist is an operator trust boundary.
export function createPeripheralTransport({ origins = [], timeoutMs = 35_000, fetchImpl = fetch } = {}) {
  const allowed = [...new Set(origins.filter(Boolean).map(peripheralOrigin))]
  const assertOrigin = origin => {
    if (!allowed.includes(peripheralOrigin(origin))) throw new AppError(409, 'peripheral_origin_not_allowed', '该地址尚未加入部署端 MX_INSIGHT_PERIPHERAL_ORIGINS 白名单')
  }
  return {
    origins: allowed, assertOrigin,
    async call(device, operation, input = {}) {
      assertOrigin(device.origin)
      if (!['state','search','next','note'].includes(operation)) throw new AppError(400, 'peripheral_operation', '不支持的外设操作')
      const url = new URL(`/api/${operation}`, device.origin)
      if (operation === 'search') url.searchParams.set('keyword', input.keyword)
      if (operation === 'note') url.searchParams.set('input', input.input)
      const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(operation === 'state' ? Math.min(5000, timeoutMs) : timeoutMs), headers: { accept: 'application/json' } })
      let size = 0
      const chunks = []
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > (operation === 'state' ? 64 * 1024 : 4 * 1024 * 1024)) throw new Error('peripheral_response_too_large')
        chunks.push(chunk)
      }
      const responseText = Buffer.concat(chunks).toString('utf8')
      let result = null
      try { result = JSON.parse(responseText) } catch { /* Preserve original evidence, never infer success from HTTP alone. */ }
      return { httpStatus: response.status, result, responseText }
    },
  }
}

export function validPeripheralResult(operation, input, result) {
  if (!result || result.ok !== true) return false
  // The usage document does not specify a `type` field on detail responses.
  if (operation === 'note') return typeof result.detail?.id === 'string'
    && result.detail.id === new URL(input.input).pathname.split('/')[2]
  return result.type === 'search' && result.keyword === input.keyword && Number.isSafeInteger(result.page)
    && result.page === (operation === 'search' ? 1 : input.expectedPage + 1)
    && typeof result.hasMore === 'boolean' && Array.isArray(result.items)
    && result.count === result.items.length
    && result.items.every(item => item && typeof item.id === 'string' && item.id
      && (item.title == null || typeof item.title === 'string')
      && (item.detailInput == null || typeof item.detailInput === 'string'))
}
