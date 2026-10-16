// Launcher 模式（docs/25 §3）：桌面端作为 Launcher 的独立端（productId mx-rig），
// 经自己的产品网络到达 Rig 服务。
//
// What it owns is Rig's alone: its lease range and service VIP as routes, its
// WireGuard profile and system service, and a credential vault. It sets no
// system DNS, PAC, NRPT or proxy and never touches another product's network,
// so it runs beside MX-H2I without either noticing.
//
// The flow:
//   1. connect(): anonymous lease through the public bootstrap → WireGuard for
//      the lease range and the VIP only → the VIP answers → network ready.
//      The Rig service is then reachable at http://<VIP> (Internal's gateway
//      routes that host to it).
//   2. signIn(): the unified account's token from User Center, asked for
//      through the VIP so it never crosses the internet in the clear, kept in
//      memory only; the lease is then swapped for the user's.
//   3. disconnect(): the data plane stops and the leases are released.
//
// The Launcher SDK, safe storage and fetch are passed in, so the whole flow is
// testable without a tunnel; the desktop hands in @qpjoy/electron-launcher.

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'

export const PRODUCT_ID = 'mx-rig'
export const DEFAULT_BOOTSTRAP_URLS = ['http://116.62.51.154:18090', 'https://h2i.minsight-ai.com']
const INTERNAL_PORT = 18090
export const SIGN_IN_SCOPE = 'auth.read oversea.subscription.ensure'
const STATE_FILE = 'mx-rig-launcher.json'
const PROFILE_NAME = 'mx-rig.conf'
const DISPLAY_NAME = 'MX Rig'
// The system service that keeps the tunnel: named for Rig, never another product.
export const SERVICE_IDENTITY = Object.freeze({
  displayName: 'MX Rig WireGuard',
  darwinLaunchDaemonLabelPrefix: 'com.qpjoy.mx-rig.wireguard',
  darwinSupportRoot: '/Library/Application Support/QPJoy/MX-Rig',
  darwinLogDir: '/Library/Logs/QPJoy-MX-Rig',
  darwinDaemonScriptName: 'mx-rig-wireguard-daemon.sh',
  staleDarwinLaunchDaemonLabelPrefixes: ['com.qpjoy.mx-rig.wireguard']
})

const CAPABILITY = /^mxlc1\.[A-Za-z0-9_-]{43}$/
const mintCapability = () => `mxlc1.${randomBytes(32).toString('base64url')}`
const isCapability = (value) => typeof value === 'string' && CAPABILITY.test(value)
const capabilityKey = (kind, userId) => (kind === 'user' ? `user:${userId || 'missing'}` : 'anonymous')
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

export const STATUS_TEXT = {
  idle: '未连接',
  resolving: '正在找入口',
  enrolling: '正在申请网络',
  applying: '正在建立隧道',
  ready: '已连接',
  pending: '隧道已建立，等待连通',
  disconnecting: '正在断开',
  error: '连接失败'
}

class NetworkError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** The lease capabilities to present: this identity's pending one first, then those held. */
function enrollmentCapabilities(vault, kind, userId, { installId, publicKey }) {
  const held = Object.values(vault.leaseCredentials)
    .filter((entry) => entry.productId === PRODUCT_ID && entry.installId === installId && entry.publicKey === publicKey && isCapability(entry.capability))
    .sort((a, b) => {
      const mine = (entry) => (entry.identityKind === kind && entry.userId === userId ? 1 : 0)
      return mine(b) - mine(a) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
    })
    .map((entry) => entry.capability)
  const list = [...new Set([vault.pendingCapabilities[capabilityKey(kind, userId)], ...held])].filter(isCapability).slice(0, 16)
  return list.length ? list.join(',') : undefined
}

export class LauncherNetwork {
  /**
   * `dir` holds the state file (the app's userData); `sdk` is the Launcher SDK;
   * `safeStorage` encrypts the credential vault (Electron's safeStorage).
   */
  constructor({ dir, sdk, safeStorage, fetchImpl = fetch, config = {}, appVersion = '', onChange = () => {} }) {
    this.dir = dir
    this.sdk = sdk
    this.safeStorage = safeStorage
    this.fetch = fetchImpl
    this.config = {
      bootstrapUrls: config.bootstrapUrls?.length ? config.bootstrapUrls : DEFAULT_BOOTSTRAP_URLS,
      serverUrl: text(config.serverUrl),
      deviceLabel: text(config.deviceLabel) ?? 'MX Rig Desktop'
    }
    this.appVersion = appVersion
    this.onChange = onChange
    this.queue = Promise.resolve()
    this.session = null
    this.accessToken = null
    this.bootstrapBaseUrl = null
    this.state = null
    this.vault = null
    // Set once a data plane was asked for in this run: only then is there
    // anything of ours on the system to stop.
    this.applied = false
  }

  static async open(options) {
    const network = new LauncherNetwork(options)
    await network.#load()
    return network
  }

  // -- state -------------------------------------------------------------------

  get #file() {
    return join(this.dir, STATE_FILE)
  }

  async #load() {
    const saved = await readFile(this.#file, 'utf8').then(JSON.parse, () => ({}))
    this.state = {
      version: 1,
      installId: text(saved.installId) ?? randomUUID(),
      deviceId: text(saved.deviceId) ?? randomUUID(),
      // Connected once before: the system service is installed, so connecting
      // again asks nobody for an administrator password.
      connectedOnce: saved.connectedOnce === true,
      identity: { kind: 'anonymous', userId: null, displayName: null },
      connection: { status: 'idle', message: '', updatedAt: new Date().toISOString() }
    }
    this.vault = this.#openVault(saved.vault)
    await this.#save()
  }

  #openVault(sealed) {
    const empty = { keyPair: null, leaseCredentials: {}, pendingCapabilities: {} }
    if (!sealed || !this.#storageReady()) return empty
    try {
      const value = record(JSON.parse(this.safeStorage.decryptString(Buffer.from(sealed, 'base64'))))
      return {
        keyPair: value.keyPair?.privateKey && value.keyPair?.publicKey ? value.keyPair : null,
        leaseCredentials: record(value.leaseCredentials),
        pendingCapabilities: record(value.pendingCapabilities)
      }
    } catch {
      // A vault this machine cannot open (copied profile, reset keychain): start over.
      return empty
    }
  }

  #storageReady() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) return false
    // Linux "basic_text" is not encryption.
    return this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  }

  async #save() {
    const sealed =
      this.#storageReady() && (this.vault.keyPair || Object.keys(this.vault.leaseCredentials).length || Object.keys(this.vault.pendingCapabilities).length)
        ? this.safeStorage.encryptString(JSON.stringify(this.vault)).toString('base64')
        : null
    const body = {
      version: 1,
      installId: this.state.installId,
      deviceId: this.state.deviceId,
      connectedOnce: this.state.connectedOnce,
      vault: sealed
    }
    await mkdir(this.dir, { recursive: true })
    const temp = `${this.#file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(body, null, 2), { mode: 0o600 })
    await rename(temp, this.#file)
  }

  #set(patch) {
    this.state.connection = { ...this.state.connection, ...patch, updatedAt: new Date().toISOString() }
    this.onChange(this.snapshot())
  }

  /** What the page may show: no keys, tokens or capabilities. */
  snapshot() {
    const { connection, identity } = this.state
    return {
      productId: PRODUCT_ID,
      status: connection.status,
      statusText: STATUS_TEXT[connection.status] ?? connection.status,
      message: connection.message ?? '',
      serviceVip: connection.serviceVip ?? null,
      leaseIp: connection.leaseIp ?? null,
      serverUrl: this.serverUrl(),
      serverReachable: connection.serverReachable ?? null,
      identity: { kind: identity.kind, displayName: identity.displayName },
      connectedOnce: this.state.connectedOnce,
      updatedAt: connection.updatedAt
    }
  }

  /** Where the Rig service is: configured, or the product's own VIP. */
  serverUrl() {
    if (this.config.serverUrl) return this.config.serverUrl
    const vip = this.state.connection.serviceVip
    return vip ? `http://${vip}` : null
  }

  /**
   * Where Release Center answers for this install (docs/25 P2): Launcher
   * Internal behind Rig's own VIP, and only while the network is ready —
   * never another product's VIP, never a fixed address.
   */
  releaseContext() {
    const { status, internalBaseUrl, serviceVip } = this.state.connection
    if (status !== 'ready' || !internalBaseUrl || !serviceVip) return null
    if (new URL(internalBaseUrl).hostname !== serviceVip) return null
    const { identity } = this.state
    return { baseUrl: internalBaseUrl, installId: this.state.installId, userId: identity.kind === 'user' ? identity.userId : null }
  }

  /**
   * The signed-in account, for the overseas channel (docs/25 P3): its token
   * travels only to Launcher Internal behind Rig's own VIP. Main process only.
   */
  overseaSession() {
    const context = this.releaseContext()
    if (!context?.userId || !this.accessToken) return null
    return { baseUrl: context.baseUrl, userId: context.userId, accessToken: this.accessToken }
  }

  /** The network as the update controller weighs it: nothing is installed mid-connect. */
  updateGate() {
    switch (this.state.connection.status) {
      case 'ready':
        return 'connected'
      case 'resolving':
      case 'enrolling':
      case 'applying':
        return 'connecting'
      case 'pending':
        return 'recovering'
      case 'error':
        return 'permission-required'
      default:
        return 'idle'
    }
  }

  #exclusive(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  // -- connecting --------------------------------------------------------------

  connect() {
    return this.#exclusive(() => this.#connect())
  }

  signIn(credentials) {
    return this.#exclusive(() => this.#signIn(credentials))
  }

  /** Back to an anonymous lease: the login page must still reach the service. */
  signOut() {
    return this.#exclusive(async () => {
      this.accessToken = null
      this.state.identity = { kind: 'anonymous', userId: null, displayName: null }
      return this.#connect()
    })
  }

  disconnect(reason = 'manual') {
    return this.#exclusive(() => this.#disconnect(reason))
  }

  async #bootstrap() {
    const resolution = await this.sdk.resolveElectronLauncherBootstrap({
      candidates: this.config.bootstrapUrls.map((url) => ({ url, source: 'mx-rig' })),
      timeoutMs: 3_000
    })
    if (!resolution.ok || !resolution.baseUrl) throw new NetworkError('bootstrap_unreachable', `连不上 Launcher 的入口：${resolution.message}`)
    this.bootstrapBaseUrl = resolution.baseUrl
    return resolution.baseUrl
  }

  #client(baseUrl) {
    const keyPair = this.vault.keyPair
    return this.sdk.createElectronLauncher({
      baseUrl,
      productId: PRODUCT_ID,
      mode: 'standalone',
      installId: this.state.installId,
      deviceId: this.state.deviceId,
      deviceLabel: this.config.deviceLabel,
      keyPair: keyPair ?? undefined,
      privateKey: keyPair?.privateKey,
      publicKey: keyPair?.publicKey
    })
  }

  #ownRoutes(plan) {
    if (plan.productId !== PRODUCT_ID) throw new NetworkError('foreign_route_plan', '拒绝了一份属于其他产品的路由')
    const routeCidrs = [...new Set([text(plan.leaseCidr), `${text(plan.serviceVip)}/32`])]
    if (routeCidrs.some((cidr) => !cidr || cidr.startsWith('null'))) throw new NetworkError('route_plan_invalid', 'Launcher 返回的路由不完整')
    return { ...plan, routeCidrs, allowedIps: routeCidrs, h2iDirectAllowedIps: routeCidrs }
  }

  async #connect() {
    const user = this.state.identity.kind === 'user' && this.accessToken
    if (!user) this.state.identity = { kind: 'anonymous', userId: null, displayName: null }
    const kind = user ? 'user' : 'anonymous'
    const userId = user ? this.state.identity.userId : null
    this.#set({ status: 'resolving', message: '正在找 Launcher 的入口……' })
    try {
      // A user's token only travels inside the tunnel, through the product VIP.
      const control = user && this.state.connection.internalBaseUrl ? this.state.connection.internalBaseUrl : await this.#bootstrap()
      const launcher = this.#client(control)
      let product
      try {
        product = await launcher.getProduct(PRODUCT_ID)
      } catch (error) {
        throw new NetworkError(
          'product_not_registered',
          `Launcher 上还没有 mx-rig 的产品网络（${error?.message ?? error}）。管理员运行 scripts/manage.sh launcher plan 查看要登记的内容。`
        )
      }
      if (product.productId !== PRODUCT_ID || product.mode !== 'standalone' || product.networkScope !== 'owner')
        throw new NetworkError('product_mismatch', 'mx-rig 的产品网络没有登记成独立端（standalone / owner）')
      if (product.enabled === false) throw new NetworkError('product_disabled', 'mx-rig 的产品网络已停用')
      if (!product.serviceVip || !isIP(product.serviceVip)) throw new NetworkError('product_vip_missing', 'mx-rig 的产品网络没有有效的 VIP')
      const internalBaseUrl = `http://${product.serviceVip}:${INTERNAL_PORT}`
      if (!this.#storageReady()) throw new NetworkError('storage_unavailable', '这台电脑不能安全保存网络凭据（系统钥匙串不可用），没法连接')
      this.vault.keyPair ??= this.sdk.createLauncherWireGuardKeyPair()
      const keyPair = this.vault.keyPair
      const key = capabilityKey(kind, userId)
      this.vault.pendingCapabilities[key] ??= mintCapability()
      const pending = this.vault.pendingCapabilities[key]
      const presented = enrollmentCapabilities(this.vault, kind, userId, { installId: this.state.installId, publicKey: keyPair.publicKey })
      // Saved before enrolling: a crash retries with the same key and capability.
      await this.#save()
      this.#set({ status: 'enrolling', serviceVip: product.serviceVip, internalBaseUrl, message: user ? '正在申请用户网络……' : '正在申请网络……' })
      const session = await launcher.connectNetwork({
        identityKind: kind,
        leaseProfile: user ? 'employee' : 'anonymous',
        userId: userId ?? undefined,
        accessToken: user ? this.accessToken : undefined,
        leaseCapability: presented,
        newLeaseCapability: pending,
        keyPair,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        platform: 'electron',
        appVersion: this.appVersion,
        requestedBy: 'mx-rig-desktop',
        requestId: `mx-rig-connect-${Date.now()}`
      })
      for (const lease of [session.lease, ...(session.lease.handoverLeases ?? [])]) this.#remember(lease, lease === session.lease ? pending : null)
      delete this.vault.pendingCapabilities[key]
      this.session = session
      const routePlan = this.#ownRoutes(session.routePlan)
      await this.#save()
      this.#set({ status: 'applying', leaseId: session.lease.leaseId, leaseIp: session.lease.leaseIp, routeCidrs: routePlan.routeCidrs, message: '正在建立隧道（第一次会请求管理员权限）……' })
      await this.#syncPeer(control, session)
      this.applied = true
      const applied = await this.sdk.applyElectronLauncherStandaloneDataPlane({
        userDataDir: this.dir,
        profileName: PROFILE_NAME,
        routePlan,
        privateKey: keyPair.privateKey,
        dnsDomains: [],
        suppressWireGuardDns: true,
        pathPreference: 'relay',
        requiredProbeTargets: ['lease-ip', 'service-vip'],
        ownerId: this.#ownerId(),
        productId: PRODUCT_ID,
        instanceId: this.state.installId,
        displayName: DISPLAY_NAME,
        metadata: { dataPlaneMode: 'standalone-wireguard', dataPlaneOwner: true, routeOnly: true },
        dnsHosts: [],
        dnsZones: [],
        routeCidrs: routePlan.routeCidrs,
        supersedeClaims: [],
        failOnOwnershipConflicts: true,
        allowSystemFallback: false,
        fallbackToAppManaged: false,
        darwinLaunchDaemon: true,
        darwinServiceIdentity: SERVICE_IDENTITY
      })
      if (!applied.ok) {
        this.#set({
          status: applied.state === 'ownership-conflict' ? 'error' : 'pending',
          dataPlane: { state: applied.state, message: applied.message },
          message: applied.state === 'ownership-conflict' ? `和这台电脑上的其他网络冲突：${applied.message}` : applied.message
        })
        await this.#save()
        return this.snapshot()
      }
      this.state.connectedOnce = true
      const launcherHealth = await this.#probe(`${internalBaseUrl}/healthz`)
      if (!launcherHealth.ok) {
        this.#set({ status: 'pending', dataPlane: { state: 'service-unreachable', message: launcherHealth.message }, message: `隧道已建立，但 VIP 还不通：${launcherHealth.message}` })
        await this.#save()
        return this.snapshot()
      }
      const rig = await this.#probe(`${this.serverUrl()}/readyz`)
      this.#set({
        status: 'ready',
        dataPlane: { state: 'network-ready', message: applied.message },
        serverReachable: rig.ok,
        message: rig.ok
          ? user
            ? '内网已连接（用户网络）'
            : '内网已连接'
          : `内网已连接，但 Rig 服务还没有经 VIP 发布：${rig.message}。管理员需要在 Launcher 里登记 Rig 的反代路由（scripts/manage.sh deploy 结束时会打印）。`
      })
      await this.#save()
      return this.snapshot()
    } catch (error) {
      this.#set({ status: 'error', message: error?.message ?? String(error) })
      await this.#save().catch(() => {})
      return this.snapshot()
    }
  }

  #remember(lease, fallback) {
    const capability = text(lease.capability) ?? text(fallback)
    const publicKey = this.vault.keyPair?.publicKey
    if (!isCapability(capability) || !publicKey || lease.productId !== PRODUCT_ID || lease.installId !== this.state.installId)
      throw new NetworkError('lease_invalid', 'Launcher 返回的 lease 不属于这台电脑上的 MX Rig')
    this.vault.leaseCredentials[lease.leaseId] = {
      leaseId: lease.leaseId,
      capability,
      identityKind: lease.identityKind === 'user' ? 'user' : 'anonymous',
      userId: lease.userId ?? null,
      productId: PRODUCT_ID,
      installId: this.state.installId,
      publicKey,
      expiresAt: text(lease.expiresAt),
      updatedAt: new Date().toISOString()
    }
  }

  async #syncPeer(control, session) {
    const credential = this.vault.leaseCredentials[session.lease.leaseId]
    const answer = await this.fetch(`${control}/internal/v1/launcher-network/leases/${encodeURIComponent(session.lease.leaseId)}/domestic-peer/sync`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/json',
        'x-mx-lease-capability': credential.capability,
        ...(session.lease.identityKind === 'user' && this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {})
      },
      body: JSON.stringify({ requestedBy: 'mx-rig-desktop', requestId: `mx-rig-peer-${Date.now()}` })
    })
    if (!answer.ok) throw new NetworkError('peer_sync_failed', `同步网络节点失败：HTTP ${answer.status}`)
  }

  async #probe(url) {
    try {
      const answer = await this.fetch(url, { method: 'GET', signal: AbortSignal.timeout(4_000), cache: 'no-store' })
      await answer.text().catch(() => '')
      return answer.ok ? { ok: true, message: 'ok' } : { ok: false, message: `HTTP ${answer.status}` }
    } catch (error) {
      return { ok: false, message: error?.message ?? String(error) }
    }
  }

  #ownerId() {
    return `${PRODUCT_ID}:${this.state.installId}`
  }

  // -- the unified account -----------------------------------------------------

  async #signIn({ account, password } = {}) {
    const name = text(account)
    if (!name || typeof password !== 'string' || !password) throw new NetworkError('invalid_input', '请输入账号和密码')
    const { status, internalBaseUrl, serviceVip } = this.state.connection
    if (status !== 'ready' || !internalBaseUrl) throw new NetworkError('network_not_ready', '先连上内网再登录')
    if (new URL(internalBaseUrl).hostname !== serviceVip) throw new NetworkError('vip_mismatch', '登录只走 Rig 自己的 VIP')
    const answer = await this.fetch(`${internalBaseUrl}/internal/v1/sdk/oauth/token`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json' },
      // oversea.subscription.ensure: the overseas channel (docs/25 P3) asks
      // for the account's subscription with this token. Guests are not granted it.
      body: JSON.stringify({ grant_type: 'password', username: name, password, audience: 'mx-sdk', scope: SIGN_IN_SCOPE, requestId: `mx-rig-oauth-${Date.now()}` })
    })
    const body = await answer.text()
    let payload = {}
    try {
      payload = body ? JSON.parse(body) : {}
    } catch {}
    if (!answer.ok) throw new NetworkError('sign_in_failed', `统一账号登录失败：${text(record(payload).message) ?? `HTTP ${answer.status}`}`)
    const token = record(record(payload).token ?? payload)
    const principal = record(token.principal)
    const subject = text(token.subject)
    const userId = text(principal.userId) ?? (subject?.startsWith('user:') ? text(subject.slice(5)) : null)
    const accessToken = text(token.access_token)
    if (!userId || !accessToken) throw new NetworkError('sign_in_contract', 'User Center 没有返回用户身份')
    // In memory only: a restart asks again, and the token never reaches disk.
    this.accessToken = accessToken
    this.state.identity = { kind: 'user', userId, displayName: text(principal.displayName) ?? name }
    return this.#connect()
  }

  // -- stopping ----------------------------------------------------------------

  async #disconnect(reason) {
    const active = this.session
    const leases = Object.keys(this.vault.leaseCredentials).length
    // Nothing was ever applied in this run (a connection that failed early, or
    // none at all): there is no tunnel to stop, and the system is not touched.
    if (!this.applied && !active) {
      if (leases) await this.#release().catch(() => leases)
      this.state.connection = { status: 'idle', message: '', updatedAt: new Date().toISOString() }
      this.onChange(this.snapshot())
      return this.snapshot()
    }
    const before = this.state.connection
    this.#set({ status: 'disconnecting', message: reason === 'shutdown' ? '正在关闭 MX Rig 的隧道……' : '正在断开……' })
    try {
      const stopped = await this.sdk.stopElectronLauncherStandaloneDataPlane({
        userDataDir: this.dir,
        profileName: PROFILE_NAME,
        routePlan: active ? this.#ownRoutes(active.routePlan) : undefined,
        ownerId: this.#ownerId(),
        darwinLaunchDaemon: true,
        allowSystemFallback: false,
        fallbackToAppManaged: false,
        darwinServiceIdentity: SERVICE_IDENTITY
      })
      if (!stopped.ok) {
        this.state.connection = { ...before, status: 'error', message: `停止隧道失败：${stopped.message}`, updatedAt: new Date().toISOString() }
        this.onChange(this.snapshot())
        return this.snapshot()
      }
      this.session = null
      this.applied = false
      const left = await this.#release()
      this.state.connection = {
        status: 'idle',
        message: left ? `隧道已停止，${left} 个 lease 稍后再释放` : '已断开',
        updatedAt: new Date().toISOString()
      }
      await this.#save()
      this.onChange(this.snapshot())
      return this.snapshot()
    } catch (error) {
      this.state.connection = { ...before, status: 'error', message: error?.message ?? String(error), updatedAt: new Date().toISOString() }
      this.onChange(this.snapshot())
      return this.snapshot()
    }
  }

  /** Release this computer's leases; those that cannot be reached now stay for the next time. */
  async #release() {
    const mine = Object.values(this.vault.leaseCredentials).filter(
      (entry) => entry.productId === PRODUCT_ID && entry.installId === this.state.installId && entry.publicKey === this.vault.keyPair?.publicKey
    )
    if (!mine.length) return 0
    let base
    try {
      base = this.bootstrapBaseUrl ?? (await this.#bootstrap())
    } catch {
      return mine.length
    }
    let left = 0
    for (const entry of mine) {
      try {
        const answer = await this.fetch(`${base}/internal/v1/launcher-network/leases/${encodeURIComponent(entry.leaseId)}/release`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', 'x-mx-lease-capability': entry.capability },
          body: JSON.stringify({ requestedBy: 'mx-rig-desktop', requestId: `mx-rig-release-${Date.now()}-${entry.leaseId}` })
        })
        const payload = await answer.json().catch(() => ({}))
        if (!answer.ok || record(payload.lease).status !== 'released') throw new Error('not released')
        delete this.vault.leaseCredentials[entry.leaseId]
      } catch {
        left += 1
      }
    }
    return left
  }
}
