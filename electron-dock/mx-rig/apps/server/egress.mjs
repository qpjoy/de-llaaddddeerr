/**
 * What this service's own outbound calls actually do.
 *
 * The environment half is read-only and stays that way. MX Rig does not own
 * the machine's network: it does not set a system proxy, a route, DNS, PAC or
 * NRPT, and it must never look like it did. This half exists so that
 * "模型连不上" can be told apart from "模型配置错了" without anyone guessing,
 * which is exactly the question a proxied Internal deployment asks first.
 *
 * The managed half (`egress-profiles.mjs`) is the narrow thing Rig *may*
 * decide: which proxy its own model calls and its own isolated browser use.
 * Both are reported side by side, because the failure mode worth preventing is
 * an operator reading one and believing the other.
 */
const NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']

// `new URL()` accepts anything with a colon in it, so `user:pw@host:7788`
// parses as scheme `user:` with the secret in the path and no username to
// redact. Only a recognised proxy scheme may take the structured path.
const PROXY_SCHEMES = ['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:']

/** Keep host and port (the diagnosis) and drop the credential (the secret). */
export function redactProxy(raw) {
  if (!raw) return { value: '', credentials: false }
  let url = null
  try {
    const parsed = new URL(raw)
    if (PROXY_SCHEMES.includes(parsed.protocol)) url = parsed
  } catch {
    /* handled below */
  }
  if (!url)
    // Report the shape, never the raw text: an unrecognised value may still be
    // `user:pass@host`.
    return /@/.test(raw)
      ? { value: `***@${raw.split('@').pop().slice(0, 200)}`, credentials: true }
      : { value: raw.slice(0, 200), credentials: false }
  const credentials = Boolean(url.username || url.password)
  if (credentials) {
    url.username = '***'
    url.password = '***'
  }
  return { value: url.toString().replace(/\/$/, ''), credentials }
}

function readVariable(env, name) {
  // Lower-case forms are the convention for curl and most CLIs; both are read
  // by libraries, so reporting only the upper-case one would hide a real one.
  const raw = env[name] ?? env[name.toLowerCase()] ?? ''
  const source = Object.hasOwn(env, name)
    ? name
    : Object.hasOwn(env, name.toLowerCase())
      ? name.toLowerCase()
      : null
  const { value, credentials } =
    name === 'NO_PROXY' ? { value: raw, credentials: false } : redactProxy(raw)
  return { name, source, value, credentials, set: Boolean(raw) }
}

/**
 * Node's own `fetch` ignores the proxy environment unless the runtime supports
 * `NODE_USE_ENV_PROXY` and it is switched on. Saying "已配置代理" while the
 * model call goes out direct would be the most expensive kind of wrong.
 */
export function proxyHonored(env, nodeVersion) {
  const major = Number.parseInt(
    String(nodeVersion || '')
      .replace(/^v/, '')
      .split('.')[0],
    10
  )
  if (!Number.isInteger(major) || major < 24)
    return {
      honored: false,
      reason: `当前 Node ${nodeVersion || '(未知)'} 的 fetch 不读取代理环境变量；服务出网为直连。`
    }
  if (env.NODE_USE_ENV_PROXY !== '1')
    return {
      honored: false,
      reason: '运行时支持 NODE_USE_ENV_PROXY，但未设置为 1；服务出网为直连。'
    }
  return { honored: true, reason: 'NODE_USE_ENV_PROXY=1，服务出网按代理环境变量走。' }
}

export function observeEgress({
  env = process.env,
  nodeVersion = process.version,
  platform = process.platform,
  hostname = '',
  managed = null
} = {}) {
  const variables = NAMES.map((name) => readVariable(env, name))
  const proxied = variables.filter((entry) => entry.name !== 'NO_PROXY' && entry.set)
  const { honored, reason } = proxyHonored(env, nodeVersion)
  const envEffective = honored && proxied.length > 0 ? 'proxy-env' : 'direct'
  // A managed channel wins for the two surfaces it covers: the tunnel is used
  // explicitly by our own transport, so it does not depend on the runtime
  // reading proxy variables at all.
  const route = {
    model: managed?.model ? 'rig-channel' : envEffective,
    browser: managed?.browser ? 'rig-channel' : 'direct',
    note: managed?.activeId
      ? `模型与浏览器按通道「${managed.active?.displayName ?? managed.activeId}」出网；其他一切仍由部署环境决定。`
      : '没有启用 Rig 通道：模型调用按上面的环境观测走，浏览器直连。'
  }
  return {
    observedAt: new Date().toISOString(),
    sourceKind: 'process-env',
    runtime: { node: nodeVersion, platform, hostname },
    configured: proxied.length > 0,
    honored,
    reason,
    effective: envEffective,
    variables,
    managed: managed ?? { activeId: null, profiles: [], active: null, model: null, browser: null },
    route
  }
}
