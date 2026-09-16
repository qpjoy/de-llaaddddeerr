import { RigError, serviceUrl } from '../contracts/index.mjs'

export class RigClient {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = serviceUrl(url)
    this.token = token
    this.fetch = fetchImpl
  }
  async request(path, body, signal) {
    if (!path.startsWith('/api/')) throw new RigError('invalid_path', '不允许的 API 路径')
    const response = await this.fetch(this.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        : AbortSignal.timeout(90_000)
    })
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new RigError('response_limit', '服务响应超过上限', 502)
      chunks.push(chunk)
    }
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      throw new RigError('invalid_response', '服务没有返回有效 JSON', 502)
    }
    if (!response.ok) throw failure(response, payload)
    return payload
  }

  /**
   * A model turn that reports text as it arrives.
   *
   * The service answers with NDJSON: any number of `{"delta":"…"}` lines, then
   * exactly one `{"message":…}` line (or `{"error":…}` if it broke after the
   * stream had already started). This is not SSE and not a WebSocket on
   * purpose — the Runtime already speaks HTTP to Internal with a bearer token,
   * and a second transport would need its own auth, its own reconnect story
   * and its own place to go wrong.
   *
   * `onDelta` is best-effort presentation: if it throws, the turn continues.
   * Losing a partial render must never lose the answer.
   */
  async stream(path, body, signal, onDelta) {
    if (!path.startsWith('/api/')) throw new RigError('invalid_path', '不允许的 API 路径')
    const response = await this.fetch(this.url + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        accept: 'application/x-ndjson'
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
        : AbortSignal.timeout(180_000)
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let payload = {}
      try {
        payload = JSON.parse(text)
      } catch {
        /* A non-JSON error body is still a rejection; the mapper defaults. */
      }
      throw failure(response, payload)
    }
    const decoder = new TextDecoder()
    let buffered = ''
    let size = 0
    let result = null
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) throw new RigError('response_limit', '服务响应超过上限', 502)
      buffered += decoder.decode(chunk, { stream: true })
      let cut = buffered.indexOf('\n')
      while (cut >= 0) {
        const line = buffered.slice(0, cut).trim()
        buffered = buffered.slice(cut + 1)
        cut = buffered.indexOf('\n')
        if (!line) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          throw new RigError('invalid_response', '流式响应包含无法解析的行', 502)
        }
        if (typeof event.delta === 'string') {
          try {
            onDelta?.(event.delta)
          } catch {
            /* Presentation only. */
          }
          continue
        }
        if (event.error)
          throw new RigError(
            event.error.code || 'model_error',
            event.error.message || '模型流式响应中断',
            502
          )
        if (event.message) result = event
      }
    }
    if (!result) throw new RigError('invalid_response', '流式响应没有给出最终结果', 502)
    return result
  }
}

/** One mapping for both paths, so a rejection reads the same either way. */
function failure(response, payload) {
  const code = payload.error?.code || 'service_error'
  const messages = {
    model_unconfigured: '请管理员在 Internal 配置模型；测试工作流不需要模型',
    model_key_missing: 'Internal 缺少模型凭据，请联系管理员',
    model_busy: '模型服务忙，请稍后继续',
    forbidden: '当前账号没有执行权限，请联系管理员'
  }
  return new RigError(
    code,
    response.status === 401
      ? '登录已失效，请重新登录'
      : messages[code] || `服务拒绝请求 (${response.status})`,
    response.status
  )
}
