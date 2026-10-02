export const PRODUCT_ID = 'mx-rig'
export const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled'])
export const TOOL_NAMES = [
  'tests_apps',
  'tests_list',
  'tests_runs',
  'tests_run',
  'tests_result',
  'tests_wait',
  'tests_cases',
  'tests_case_results',
  'tests_artifacts',
  'tests_runners',
  'tests_cancel',
  'browser_open',
  'electron_launch',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_select',
  'browser_check',
  'browser_press',
  'browser_wait',
  'browser_assert',
  'browser_handoff',
  'native_launch',
  'native_snapshot',
  'native_click',
  'native_fill',
  'native_assert',
  'finding_submit',
  'case_draft',
  'procedure_propose',
  'workspace_list',
  'workspace_read',
  'workspace_search',
  'workspace_run',
  'workspace_write',
  'workspace_edit'
]

export class RigError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function text(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new RigError('invalid_input', `${label} 必须是 1–${max} 字符的文本`)
  return value.trim()
}

// Identifiers that travel into a URL path segment or a settings key. Keeping
// the character set closed means no caller has to remember to encode them and
// no stored key can collide with a path separator.
export function key(value, label, max = 64) {
  const raw = text(value, label, max)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw))
    throw new RigError('invalid_key', `${label} 只能使用小写字母、数字、- 和 _`)
  return raw
}

/** Whether a host is one the policy marks as production (exact or `.suffix`). */
export function isProductionHost(hostname, productionHosts = []) {
  const host = String(hostname ?? '').toLowerCase()
  return productionHosts.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry
  )
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/**
 * A private address written as an IP literal: RFC 1918, carrier-grade NAT
 * (where WireGuard overlays usually live) and IPv6 unique-local. A host name
 * does not qualify — it can resolve anywhere, which is exactly what "private
 * network" is supposed to rule out.
 */
export function isPrivateAddress(hostname) {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (v4.slice(1).some((part) => Number(part) > 255)) return false
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
  return /^\[f[cd][0-9a-f]{2}:/i.test(hostname)
}

/**
 * @param {object}  [options]
 * @param {boolean} [options.privateHttp] Accept plain HTTP to a private IP —
 *   a test server on the office LAN or a WireGuard overlay. Chosen by the
 *   person signing in, never implied.
 */
export function serviceUrl(value, { privateHttp = false } = {}) {
  const url = new URL(text(value, '服务地址', 2000))
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new RigError('invalid_url', '服务地址必须是无凭据、路径和查询参数的 HTTP(S) origin')
  }
  if (
    url.protocol !== 'https:' &&
    !LOOPBACK.includes(url.hostname) &&
    !(privateHttp && isPrivateAddress(url.hostname))
  ) {
    throw new RigError(
      'tls_required',
      privateHttp
        ? '只有私有网段的 IP 地址可以用 HTTP；其他地址请使用 HTTPS'
        : '非本机服务必须使用 HTTPS；内网测试服务器可勾选「内网 HTTP」'
    )
  }
  return url.origin
}

export function validateArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new RigError('invalid_arguments', '工具参数必须是对象')
  for (const key of Object.keys(args))
    if (!Object.hasOwn(schema.properties, key))
      throw new RigError('invalid_arguments', `未知参数 ${key}`)
  for (const key of schema.required || [])
    if (!Object.hasOwn(args, key)) throw new RigError('invalid_arguments', `缺少参数 ${key}`)
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key]
    if (property.type === 'integer') {
      if (!Number.isInteger(value) || value < property.minimum || value > property.maximum)
        throw new RigError('invalid_arguments', `${key} 超出允许的整数范围`)
    } else if (property.type === 'boolean') {
      if (typeof value !== 'boolean')
        throw new RigError('invalid_arguments', `${key} 必须是 true 或 false`)
    } else text(value, key, property.maxLength || 4000)
    // A closed set in the schema is a closed set at the door. Without this a
    // tool that documents an enum would still accept anything a model wrote,
    // and every caller would have to re-check it.
    if (Array.isArray(property.enum) && !property.enum.includes(value))
      throw new RigError('invalid_arguments', `${key} 只能是 ${property.enum.join(' / ')} 之一`)
  }
  return args
}

/**
 * Authored orchestrations render every argument from a text template. Turn the
 * rendered text into the type the tool declares, so `"5000"` can reach an
 * integer parameter and `"true"` a boolean one. An empty optional value is
 * dropped rather than passed as "". Validation still happens afterwards.
 */
export function coerceArgs(schema, args) {
  const result = {}
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key]
    if (!property || typeof value !== 'string') {
      result[key] = value
      continue
    }
    if (value === '' && !(schema.required || []).includes(key)) continue
    if (property.type === 'integer' && /^-?\d+$/.test(value.trim())) result[key] = Number(value)
    else if (property.type === 'boolean' && ['true', 'false'].includes(value.trim()))
      result[key] = value.trim() === 'true'
    else result[key] = value
  }
  return result
}

export function safeMessage(error) {
  // Never persist raw upstream bodies, credentials or stack traces as events.
  return error instanceof RigError
    ? error.message
    : '执行失败；请检查服务连接、工具环境或管理员日志'
}
