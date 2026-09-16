/**
 * 出网通道：Rig 自己的请求走哪里。
 *
 * The egress page was read-only for a good reason, and that reason has not
 * changed: MX Rig does not own the machine's network. It still sets no system
 * proxy, no route, no DNS, no PAC and no NRPT, and it still cannot make other
 * applications' traffic move.
 *
 * What it can legitimately own is *its own* outbound sockets. Two of them
 * matter in practice:
 *
 * - `model`  — the Internal service's calls to an OpenAI-compatible gateway.
 *   Tunnelled from the server process through an HTTP CONNECT proxy.
 * - `browser` — the isolated Playwright context a desktop Runtime opens.
 *   Passed to Chromium as a per-context proxy.
 *
 * Everything else about the deployment's networking stays where it was. A
 * profile here changes where these two kinds of request go, nothing else, and
 * the observation half of the page keeps reporting the real environment, so
 * the two can never be confused.
 *
 * Credentials follow the Provider rule: the UI stores an environment variable
 * *name*, never a secret, and the value is read in the server process only.
 * That is also why a credentialed profile may not apply to the browser — the
 * desktop Runtime is a different process on someone else's machine and must
 * not receive server-side secrets to put on a socket.
 */
import { RigError, key, text } from '../../packages/contracts/index.mjs'

export const MAX_EGRESS_PROFILES = 6
export const EGRESS_SURFACES = ['model', 'browser']
/** Schemes a profile may name. Only CONNECT-capable ones can serve `model`. */
const PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:']
const TUNNEL_SCHEMES = ['http:', 'https:']
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

export const EMPTY_EGRESS = Object.freeze({ activeId: null, profiles: [] })

/** Normalise to `scheme://host:port`; anything else is a rejected profile. */
export function proxyEndpoint(raw) {
  const value = text(raw, '通道地址', 300)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new RigError('invalid_egress', '通道地址必须是 http://host:port 这样的完整地址')
  }
  if (!PROXY_SCHEMES.includes(url.protocol))
    throw new RigError('invalid_egress', '通道协议只支持 http、https、socks4 或 socks5')
  if (url.username || url.password)
    throw new RigError(
      'invalid_egress',
      '不要把凭据写进通道地址；用「凭据环境变量名」登记，由服务端读取'
    )
  if (url.search || url.hash || (url.pathname && url.pathname !== '/'))
    throw new RigError('invalid_egress', '通道地址不能带路径、查询参数或片段')
  if (!url.hostname) throw new RigError('invalid_egress', '通道地址缺少主机名')
  if (!url.port)
    throw new RigError(
      'invalid_egress',
      '请写明端口，例如 http://127.0.0.1:7890——默认端口太容易猜错'
    )
  return `${url.protocol}//${url.hostname}:${url.port}`
}

function readBypass(list) {
  if (!Array.isArray(list) || list.length > 30)
    throw new RigError('invalid_egress', '直连列表无效（最多 30 条）')
  return [
    ...new Set(
      list.map((entry) => {
        const value = text(entry, '直连条目', 200).toLowerCase()
        if (!/^\*?[a-z0-9.*_-]+$/.test(value))
          throw new RigError('invalid_egress', '直连条目只能是主机名或 .suffix / *.suffix 形式')
        return value
      })
    )
  ]
}

export function readEgressProfile(input) {
  if (!input || typeof input !== 'object') throw new RigError('invalid_egress', '出网通道配置无效')
  const surfaces = Array.isArray(input.appliesTo) ? [...new Set(input.appliesTo)] : ['model']
  for (const surface of surfaces)
    if (!EGRESS_SURFACES.includes(surface))
      throw new RigError('invalid_egress', '通道作用面只能是 model 或 browser')
  if (!surfaces.length) throw new RigError('invalid_egress', '通道至少要作用于一个面')
  const proxyUrl = proxyEndpoint(input.proxyUrl)
  const authEnv =
    typeof input.authEnv === 'string' && input.authEnv.trim() ? input.authEnv.trim() : ''
  if (authEnv && !/^[A-Z][A-Z0-9_]{0,100}$/.test(authEnv))
    throw new RigError('invalid_egress', '凭据环境变量名只能是大写字母、数字和下划线')
  const scheme = new URL(proxyUrl).protocol
  if (surfaces.includes('model') && !TUNNEL_SCHEMES.includes(scheme))
    throw new RigError(
      'invalid_egress',
      'socks 通道只能作用于隔离浏览器；模型调用需要 http/https 代理（CONNECT）'
    )
  if (surfaces.includes('browser') && authEnv)
    throw new RigError(
      'invalid_egress',
      '需要凭据的通道不能作用于浏览器：桌面 Runtime 是另一个进程，不接收服务端凭据'
    )
  return {
    id: key(input.id, '通道 ID'),
    displayName: text(input.displayName || input.id, '通道名称', 60),
    proxyUrl,
    bypass: readBypass(input.bypass ?? []),
    authEnv,
    appliesTo: EGRESS_SURFACES.filter((surface) => surfaces.includes(surface)),
    note: typeof input.note === 'string' && input.note.trim() ? text(input.note, '备注', 240) : ''
  }
}

export function readEgress(input) {
  if (input == null) return { ...EMPTY_EGRESS }
  if (typeof input !== 'object') throw new RigError('invalid_egress', '出网配置无效')
  const raw = Array.isArray(input.profiles) ? input.profiles : []
  if (raw.length > MAX_EGRESS_PROFILES)
    throw new RigError('invalid_egress', `最多配置 ${MAX_EGRESS_PROFILES} 条出网通道`)
  const profiles = raw.map(readEgressProfile)
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new RigError('invalid_egress', '通道 ID 重复')
  const activeId = input.activeId ? key(input.activeId, '启用的通道') : null
  if (activeId && !profiles.some((profile) => profile.id === activeId))
    throw new RigError('invalid_egress', `启用的通道 ${activeId} 不存在`)
  return { activeId, profiles }
}

/** The profile in force for one surface, or null for direct. */
export function activeProfile(egress, surface) {
  const store = egress ?? EMPTY_EGRESS
  if (!store.activeId) return null
  const found = (store.profiles ?? []).find((profile) => profile.id === store.activeId)
  if (!found) return null
  return !surface || found.appliesTo.includes(surface) ? found : null
}

/**
 * Hosts that stay direct.
 *
 * Loopback is always direct: a local model gateway or the service talking to
 * itself through a corporate proxy is a failure mode, not a policy.
 */
export function bypassed(hostname, bypass = []) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true
  return bypass.some((entry) => {
    if (entry === '*') return true
    const pattern = entry.startsWith('*') ? entry.slice(1) : entry
    return pattern.startsWith('.')
      ? host === pattern.slice(1) || host.endsWith(pattern)
      : host === pattern
  })
}

/** What the browser tool needs, in Playwright's shape. Credential-free by rule. */
export function browserProxy(egress) {
  const profile = activeProfile(egress, 'browser')
  if (!profile) return null
  return {
    id: profile.id,
    server: profile.proxyUrl,
    ...(profile.bypass.length ? { bypass: profile.bypass.join(',') } : {})
  }
}

/**
 * The surface-safe view.
 *
 * Shows whether the credential environment variable is actually set, because
 * "通道配好了但服务端没有那个变量" is the failure this page exists to name.
 */
export function publicEgress(egress, environment = {}) {
  const store = egress ?? EMPTY_EGRESS
  const describe = (profile) => ({
    id: profile.id,
    displayName: profile.displayName,
    proxyUrl: profile.proxyUrl,
    bypass: profile.bypass,
    appliesTo: profile.appliesTo,
    authEnv: profile.authEnv,
    authConfigured: profile.authEnv ? Boolean(environment[profile.authEnv]) : true,
    note: profile.note
  })
  const profiles = (store.profiles ?? []).map(describe)
  return {
    activeId: store.activeId ?? null,
    profiles,
    active: profiles.find((profile) => profile.id === store.activeId) ?? null,
    model: activeProfile(store, 'model')?.id ?? null,
    browser: activeProfile(store, 'browser')?.id ?? null
  }
}
