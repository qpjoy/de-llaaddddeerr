export const PRODUCT_ID = 'mx-rig'
export const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled'])
export const TOOL_NAMES = [
  'tests_apps',
  'tests_list',
  'tests_runs',
  'tests_run',
  'tests_result',
  'tests_cases',
  'tests_case_results',
  'tests_artifacts',
  'tests_runners',
  'tests_cancel',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_fill'
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

export function serviceUrl(value) {
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
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new RigError('tls_required', '非本机服务必须使用 HTTPS')
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
  for (const [key, value] of Object.entries(args))
    text(value, key, schema.properties[key].maxLength || 4000)
  return args
}

export function safeMessage(error) {
  // Never persist raw upstream bodies, credentials or stack traces as events.
  return error instanceof RigError
    ? error.message
    : '执行失败；请检查服务连接、工具环境或管理员日志'
}
