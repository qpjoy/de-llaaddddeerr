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
    if (!response.ok) {
      const code = payload.error?.code || 'service_error'
      const messages = {
        model_unconfigured: '请管理员在 Internal 配置模型；测试工作流不需要模型',
        model_key_missing: 'Internal 缺少模型凭据，请联系管理员',
        model_busy: '模型服务忙，请稍后继续',
        forbidden: '当前账号没有执行权限，请联系管理员'
      }
      throw new RigError(
        code,
        response.status === 401
          ? '登录已失效，请重新登录'
          : messages[code] || `服务拒绝请求 (${response.status})`,
        response.status
      )
    }
    return payload
  }
}
