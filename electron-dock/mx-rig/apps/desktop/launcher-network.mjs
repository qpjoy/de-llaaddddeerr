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
const MAX_LEASE_CREDENTIALS = 16
const mintCapability = () => `mxlc1.${randomBytes(32).toString('base64url')}`
const isCapability = (value) => typeof value === 'string' && CAPABILITY.test(value)
const capabilityKey = (kind, userId) => (kind === 'user' ? `user:${userId || 'missing'}` : 'anonymous')
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

// Same requirements as Launcher's persisted handover, including Internal even
// when this desktop uses the relay path for its own traffic.
function requiredPeers(plan) {
  const direct = plan.h2iDirectEnabled === true && plan.h2iDirectEndpoint && plan.h2iDirectPublicKey
  const relay = plan.domesticRelayEndpoint && plan.domesticRelayPublicKey
  return [...(relay || !direct ? ['domestic'] : []), ...(direct ? ['internal'] : [])]
}

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
    .filter((entry) => entry.status !== 'released' || entry.identityKind === 'anonymous')
    .sort((a, b) => {
      const mine = (entry) => (entry.identityKind === kind && entry.userId === userId ? 1 : 0)
      return mine(b) - mine(a) || credentialNewestFirst(a, b)
    })
    .map((entry) => entry.capability)
  // enroll may succeed and rotate capabilities before its following snapshot
  // fails. That proof is still in another identity's pending slot in this vault.
  const pending = Object.values(vault.pendingCapabilities).reverse()
  const list = [...new Set([vault.pendingCapabilities[capabilityKey(kind, userId)], ...held, ...pending])].filter(isCapability)
  if (list.length > MAX_LEASE_CREDENTIALS)
    throw new NetworkError('lease_proof_limit', '待确认的网络凭据过多，已保留续租证明；请管理员核对，不能丢弃后重新申请')
  return list.length ? list.join(',') : undefined
}

function credentialNewestFirst(a, b) {
  return (Number(b.generation) || 0) - (Number(a.generation) || 0)
    || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
}

function retainedLeaseCredentials(credentials, pending) {
  const entries = Object.values(credentials).reverse().sort(credentialNewestFirst)
  const latestAnonymous = entries.find((entry) => entry.identityKind === 'anonymous')
  const protectedIds = new Set([
    ...entries.filter((entry) => entry.status !== 'released').map((entry) => entry.leaseId),
    latestAnonymous?.leaseId, pending?.oldSession?.lease?.leaseId, pending?.newSession?.lease?.leaseId
  ].filter(Boolean))
  const required = entries.filter((entry) => protectedIds.has(entry.leaseId))
  if (required.length > MAX_LEASE_CREDENTIALS)
    throw new NetworkError('lease_proof_limit', '待确认的网络租约过多，不能安全清理续租证明；请管理员核对')
  const retired = entries.filter((entry) => !protectedIds.has(entry.leaseId) && entry.identityKind !== 'anonymous')
  return Object.fromEntries([...required, ...retired].slice(0, MAX_LEASE_CREDENTIALS).map((entry) => [entry.leaseId, entry]))
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
    this.missingRenewalProof = false
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
      identityRecoveryAttempted: saved.identityRecoveryAttempted === true,
      identity: { kind: 'anonymous', userId: null, displayName: null },
      connection: { status: 'idle', message: '', updatedAt: new Date().toISOString() }
    }
    this.vault = this.#openVault(saved.vault)
    this.session = this.vault.activeSession
    // The system service can outlive the process. Keep its last confirmed
    // route plan so a restart never enrolls over an unfinished transition.
    this.applied = Boolean(this.session || this.vault.pendingHandover)
    if (this.session) this.#sessionConnection(this.session)
    await this.#save()
  }

  #openVault(sealed) {
    const empty = { keyPair: null, leaseCredentials: {}, pendingCapabilities: {}, activeSession: null, pendingHandover: null }
    if (!sealed || !this.#storageReady()) return empty
    try {
      const value = record(JSON.parse(this.safeStorage.decryptString(Buffer.from(sealed, 'base64'))))
      return {
        keyPair: value.keyPair?.privateKey && value.keyPair?.publicKey ? value.keyPair : null,
        leaseCredentials: record(value.leaseCredentials),
        pendingCapabilities: record(value.pendingCapabilities),
        activeSession: value.activeSession ?? null,
        pendingHandover: value.pendingHandover ?? null
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
      identityRecoveryAttempted: this.state.identityRecoveryAttempted === true,
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
      recoveryAvailable: this.#recoveryAvailable(),
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
      if (this.vault.pendingHandover) {
        const recovered = await this.#resumeHandover()
        if (this.vault.pendingHandover) return recovered
      }
      this.state.identity = { kind: 'anonymous', userId: null, displayName: null }
      return this.#connect()
    })
  }

  disconnect(reason = 'manual') {
    return this.#exclusive(() => this.#disconnect(reason))
  }

  #recoveryAvailable() {
    const pending = Object.keys(this.vault.pendingCapabilities)
    return this.missingRenewalProof && this.#storageReady() && this.state.connectedOnce && !this.state.identityRecoveryAttempted
      && this.state.identity.kind === 'anonymous' && !this.accessToken
      && !this.session && !this.vault.activeSession && !this.vault.pendingHandover
      && Object.keys(this.vault.leaseCredentials).length === 0
      && pending.length === 1 && pending[0] === 'anonymous' && isCapability(this.vault.pendingCapabilities.anonymous)
  }

  /** Explicit user recovery for old clients that erased their renewal proof. */
  recoverIdentity() {
    return this.#exclusive(async () => {
      if (!this.#recoveryAvailable()) {
        return this.snapshot()
      }
      const previousState = this.state
      const previousVault = this.vault
      try {
        const stopped = await this.sdk.stopElectronLauncherStandaloneDataPlane({
          userDataDir: this.dir, profileName: PROFILE_NAME, ownerId: this.#ownerId(),
          darwinLaunchDaemon: true, allowSystemFallback: false, fallbackToAppManaged: false,
          darwinServiceIdentity: SERVICE_IDENTITY
        })
        if (!stopped.ok) throw new Error(`停止本机 Rig 隧道失败：${stopped.message}`)
        const original = await readFile(this.#file)
        const backup = join(this.dir, `${STATE_FILE}.recovery-${Date.now()}-${randomUUID()}.bak`)
        await writeFile(backup, original, { mode: 0o600, flag: 'wx' })
        this.state = {
          ...previousState, installId: randomUUID(), deviceId: randomUUID(), connectedOnce: false,
          identityRecoveryAttempted: true,
          identity: { kind: 'anonymous', userId: null, displayName: null },
          connection: { status: 'idle', serverReachable: false, message: '', updatedAt: new Date().toISOString() }
        }
        this.vault = {
          keyPair: this.sdk.createLauncherWireGuardKeyPair(), leaseCredentials: {}, pendingCapabilities: {},
          activeSession: null, pendingHandover: null
        }
        try {
          await this.#save()
        } catch (error) {
          this.state = previousState
          this.vault = previousVault
          throw error
        }
        this.missingRenewalProof = false
        this.applied = false
        return this.#connect()
      } catch (error) {
        this.state = previousState
        this.vault = previousVault
        this.#set({ status: 'error', serverReachable: false, message: `重新登记未完成，已保留原网络身份：${error?.message ?? error}` })
        return this.snapshot()
      }
    })
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
    if (this.vault.pendingHandover) return this.#resumeHandover()
    this.missingRenewalProof = false
    const user = this.state.identity.kind === 'user' && this.accessToken
    if (!user) this.state.identity = { kind: 'anonymous', userId: null, displayName: null }
    const kind = user ? 'user' : 'anonymous'
    const userId = user ? this.state.identity.userId : null
    this.#set({ status: 'resolving', serverReachable: false, message: '正在找 Launcher 的入口……' })
    try {
      // A user's token only travels inside the tunnel, through the product VIP.
      if (user && (!this.state.connection.internalBaseUrl || new URL(this.state.connection.internalBaseUrl).hostname !== this.state.connection.serviceVip))
        throw new NetworkError('vip_mismatch', '用户网络申请只走 Rig 自己的 VIP；请先恢复内网连接')
      const control = user ? this.state.connection.internalBaseUrl : await this.#bootstrap()
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
      if (!this.vault.pendingCapabilities[key] && Object.keys(this.vault.pendingCapabilities).length >= MAX_LEASE_CREDENTIALS)
        throw new NetworkError('lease_proof_limit', '待确认的网络申请过多，已保留续租证明；请管理员核对')
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
      const next = this.#storedSession(session, this.state.identity)
      const previous = this.session
      if (previous && previous.lease.leaseId !== next.lease.leaseId) {
        this.#assertSession(previous)
        this.vault.pendingHandover = {
          transitionId: `mx-rig-${randomUUID()}`,
          phase: 'prepare',
          oldSession: previous,
          newSession: next,
          peers: requiredPeers(next.routePlan),
          control: internalBaseUrl
        }
        // Includes refreshed handoverLeases capabilities, never a bearer token.
        await this.#save()
        return this.#runHandover()
      }
      const routePlan = next.routePlan
      await this.#save()
      this.#set({ status: 'applying', leaseId: session.lease.leaseId, leaseIp: session.lease.leaseIp, routeCidrs: routePlan.routeCidrs, message: '正在建立隧道（第一次会请求管理员权限）……' })
      await this.#syncPeers(control, next)
      const applied = await this.#apply(next)
      this.session = next
      this.vault.activeSession = next
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
      this.missingRenewalProof = error?.status === 401 && error?.payload?.message === 'A valid launcher lease capability is required'
      const message = this.#recoveryAvailable()
        ? '本机缺少旧租约的续接凭据；旧版退出时已清理，可重新登记本机网络'
        : error?.status === 401 ? 'Launcher 账号或网络请求返回 401，请核对本机网络凭据与访问权限' : error?.message ?? String(error)
      this.#set({ status: 'error', serverReachable: false, message })
      await this.#save().catch(() => {})
      return this.snapshot()
    }
  }

  #storedSession(session, identity) {
    const { leaseId, productId, installId, deviceId, publicKey, leaseIp, identityKind, userId, generation } = session.lease
    const saved = {
      lease: { leaseId, productId, installId, deviceId, publicKey: publicKey ?? this.vault.keyPair.publicKey, leaseIp, identityKind, userId, generation },
      routePlan: this.#ownRoutes(session.routePlan),
      identity: { kind: identity.kind, userId: identity.userId, displayName: identity.displayName }
    }
    this.#assertSession(saved)
    return saved
  }

  #assertSession(session) {
    const { lease, routePlan } = session
    const credential = this.vault.leaseCredentials[lease?.leaseId]
    if (!lease || lease.productId !== PRODUCT_ID || lease.installId !== this.state.installId
      || (lease.deviceId && lease.deviceId !== this.state.deviceId) || lease.publicKey !== this.vault.keyPair?.publicKey
      || !credential || !isCapability(credential.capability) || credential.publicKey !== lease.publicKey
      || routePlan?.productId !== PRODUCT_ID || !isIP(routePlan.serviceVip) || !isIP(lease.leaseIp)
      || (routePlan.leaseIp && routePlan.leaseIp !== lease.leaseIp))
      throw new NetworkError('handover_invalid', '网络接管记录不属于这台电脑上的 MX Rig')
  }

  #sessionConnection(session) {
    const { lease, routePlan } = session
    Object.assign(this.state.connection, {
      serviceVip: routePlan.serviceVip,
      internalBaseUrl: `http://${routePlan.serviceVip}:${INTERNAL_PORT}`,
      leaseId: lease.leaseId,
      leaseIp: lease.leaseIp,
      routeCidrs: routePlan.routeCidrs,
      serverReachable: false
    })
  }

  async #apply(session) {
    this.#assertSession(session)
    this.applied = true
    const routePlan = this.#ownRoutes(session.routePlan)
    return this.sdk.applyElectronLauncherStandaloneDataPlane({
      userDataDir: this.dir, profileName: PROFILE_NAME, routePlan,
      privateKey: this.vault.keyPair.privateKey,
      dnsDomains: [], suppressWireGuardDns: true, pathPreference: 'relay',
      requiredProbeTargets: ['lease-ip', 'service-vip'],
      ownerId: this.#ownerId(), productId: PRODUCT_ID, instanceId: this.state.installId, displayName: DISPLAY_NAME,
      metadata: { dataPlaneMode: 'standalone-wireguard', dataPlaneOwner: true, routeOnly: true },
      dnsHosts: [], dnsZones: [], routeCidrs: routePlan.routeCidrs, supersedeClaims: [],
      failOnOwnershipConflicts: true, allowSystemFallback: false, fallbackToAppManaged: false,
      darwinLaunchDaemon: true, darwinServiceIdentity: SERVICE_IDENTITY
    })
  }

  async #handoverHealth(session) {
    const base = `http://${session.routePlan.serviceVip}:${INTERNAL_PORT}`
    const launcher = await this.#probe(`${base}/healthz`)
    if (!launcher.ok) throw new NetworkError('handover_probe_failed', `切换后的 Launcher VIP 不通：${launcher.message}`)
    const rig = await this.#probe(`${this.config.serverUrl ?? `http://${session.routePlan.serviceVip}`}/readyz`)
    if (!rig.ok) throw new NetworkError('handover_probe_failed', `切换后的 Rig 服务不通：${rig.message}`)
  }

  async #runHandover({ resume = false } = {}) {
    const pending = this.vault.pendingHandover
    try {
      if (!['prepare', 'apply', 'commit'].includes(pending.phase)) throw new NetworkError('handover_invalid', '网络接管阶段不明确，需恢复原连接')
      this.#assertSession(pending.oldSession)
      this.#assertSession(pending.newSession)
      if (pending.control !== `http://${pending.newSession.routePlan.serviceVip}:${INTERNAL_PORT}`
        || pending.oldSession.routePlan.serviceVip !== pending.newSession.routePlan.serviceVip
        || JSON.stringify(pending.peers) !== JSON.stringify(requiredPeers(pending.newSession.routePlan)))
        throw new NetworkError('handover_invalid', '网络接管只能通过 Rig 原有的产品 VIP')
      this.#set({ status: 'applying', serverReachable: false, message: '正在切换网络身份……' })
      if (pending.phase === 'prepare') {
        if (resume) {
          const restored = await this.#apply(pending.oldSession)
          if (!restored.ok) throw new NetworkError('handover_restore_failed', `恢复原隧道失败：${restored.message}`)
        }
        await this.#syncPeers(pending.control, pending.newSession, pending, 'prepare')
        pending.phase = 'apply'
        await this.#save()
      }
      if (pending.phase === 'apply' || (pending.phase === 'commit' && resume)) {
        const applied = await this.#apply(pending.newSession)
        if (!applied.ok) throw new NetworkError('handover_apply_failed', `切换隧道失败：${applied.message}`)
        await this.#handoverHealth(pending.newSession)
        pending.phase = 'commit'
        // A lost commit response may already have retired the old lease. Never
        // restore its IP just because this request times out.
        await this.#save()
      }
      await this.#syncPeers(pending.control, pending.newSession, pending, 'commit')
      this.state.connectedOnce = true
      await this.#completeHandover(pending.newSession, pending.oldSession.lease.leaseId)
      this.#set({ status: 'ready', serverReachable: true, message: this.state.identity.kind === 'user' ? '内网已连接（用户网络）' : '内网已连接' })
      return this.snapshot()
    } catch (error) {
      const message = error?.message ?? String(error)
      if (error?.code === 'handover_invalid') {
        this.#set({ status: 'error', serverReachable: false, message: `${message}；已保留接管记录，未变更隧道` })
      } else if (pending.phase === 'commit') {
        this.#set({ status: 'error', serverReachable: false, message: `${message}；接管状态无法确认，已保留接管记录，未自动回切旧租约。请重试；若仍失败，请管理员核对该 Rig 接管记录。` })
      } else {
        let recovery
        try {
          await this.#abortHandover({ preservePrepare: pending.phase === 'prepare' })
          recovery = '已恢复原网络；本次身份切换未完成，请重试'
        } catch (restoreError) {
          recovery = `原网络恢复尚未完成：${restoreError?.message ?? restoreError}；${this.vault.pendingHandover ? '已保留接管记录，' : ''}请重试连接`
        }
        this.#set({ status: 'error', serverReachable: false, message: `${message}；${recovery}` })
      }
      await this.#save().catch(() => {})
      return this.snapshot()
    }
  }

  async #completeHandover(session, retiredLeaseId) {
    const pending = this.vault.pendingHandover
    const active = this.vault.activeSession
    const credentials = this.vault.leaseCredentials
    const retired = credentials[retiredLeaseId]
    const retained = retainedLeaseCredentials({
      ...credentials,
      [retiredLeaseId]: { ...retired, status: 'released' }
    }, null)
    this.vault.activeSession = session
    this.vault.pendingHandover = null
    this.vault.leaseCredentials = retained
    try {
      await this.#save()
    } catch (error) {
      this.vault.activeSession = active
      this.vault.pendingHandover = pending
      this.vault.leaseCredentials = credentials
      throw error
    }
    this.session = session
    this.state.identity = { ...session.identity }
    this.#sessionConnection(session)
  }

  async #abortHandover({ preservePrepare = false } = {}) {
    const pending = this.vault.pendingHandover
    this.#assertSession(pending.oldSession)
    this.#assertSession(pending.newSession)
    if (pending.control !== `http://${pending.oldSession.routePlan.serviceVip}:${INTERNAL_PORT}`
      || JSON.stringify(pending.peers) !== JSON.stringify(requiredPeers(pending.newSession.routePlan)))
      throw new NetworkError('handover_invalid', '网络接管恢复记录不完整')
    if (!preservePrepare) pending.phase = 'abort'
    await this.#save()
    const restored = await this.#apply(pending.oldSession)
    if (!restored.ok) throw new NetworkError('handover_restore_failed', `恢复原隧道失败：${restored.message}`)
    // Old IP first: abort removes the new IP from the peer before replying.
    await this.#syncPeers(pending.control, pending.oldSession, pending, 'abort')
    await this.#completeHandover(pending.oldSession, pending.newSession.lease.leaseId)
    if (this.state.identity.kind !== 'user' || this.state.identity.userId !== pending.newSession.identity.userId) this.accessToken = null
    await this.#handoverHealth(this.session)
  }

  async #resumeHandover() {
    const pending = this.vault.pendingHandover
    if (pending.phase !== 'apply' && pending.phase !== 'abort') return this.#runHandover({ resume: true })
    this.#set({ status: 'applying', serverReachable: false, message: '正在恢复上次未完成的网络切换……' })
    try {
      await this.#abortHandover()
      this.#set({ status: 'error', serverReachable: false, message: '已恢复原网络；上次身份切换未完成，请重试连接' })
    } catch (error) {
      this.#set({ status: 'error', serverReachable: false, message: `网络接管恢复尚未完成：${error?.message ?? error}；${this.vault.pendingHandover ? '已保留记录，' : ''}请重试连接` })
    }
    return this.snapshot()
  }

  #remember(lease, fallback) {
    const capability = text(lease.capability) ?? text(fallback)
    const publicKey = this.vault.keyPair?.publicKey
    if (!isCapability(capability) || !publicKey || lease.productId !== PRODUCT_ID || lease.installId !== this.state.installId)
      throw new NetworkError('lease_invalid', 'Launcher 返回的 lease 不属于这台电脑上的 MX Rig')
    const credential = {
      leaseId: lease.leaseId,
      capability,
      status: lease.status === 'released' ? 'released' : 'active',
      generation: Number.isSafeInteger(Number(lease.generation)) ? Number(lease.generation) : 0,
      identityKind: lease.identityKind === 'user' ? 'user' : 'anonymous',
      userId: lease.userId ?? null,
      productId: PRODUCT_ID,
      installId: this.state.installId,
      publicKey,
      expiresAt: text(lease.expiresAt),
      updatedAt: new Date().toISOString()
    }
    this.vault.leaseCredentials = retainedLeaseCredentials({ ...this.vault.leaseCredentials, [lease.leaseId]: credential }, this.vault.pendingHandover)
  }

  async #syncPeers(control, session, pending = null, phase = null) {
    // A first relay connection still needs only its Domestic peer. A server
    // transition must complete every configured peer before it can retire IPs.
    const peers = pending?.peers ?? ['domestic']
    for (const peer of peers) await this.#syncPeer(control, session, peer, pending, phase)
  }

  async #syncPeer(control, session, peer, pending, phase) {
    this.#assertSession(session)
    const credential = this.vault.leaseCredentials[session.lease.leaseId]
    const other = pending && (phase === 'abort' ? pending.newSession : pending.oldSession)
    const otherCredential = other && this.vault.leaseCredentials[other.lease.leaseId]
    if (other && !isCapability(otherCredential?.capability)) throw new NetworkError('handover_capability_missing', '缺少原网络接管凭据')
    const endpoint = peer === 'internal' ? 'internal-direct-peer' : 'domestic-peer'
    const resultKey = peer === 'internal' ? 'internalDirectPeerSync' : 'domesticPeerSync'
    const answer = await this.fetch(`${control}/internal/v1/launcher-network/leases/${encodeURIComponent(session.lease.leaseId)}/${endpoint}/sync`, {
      method: 'POST',
      signal: AbortSignal.timeout(75_000),
      headers: {
        'content-type': 'application/json',
        'x-mx-lease-capability': credential.capability,
        ...(other ? { 'x-mx-peer-lease-capability': otherCredential.capability } : {})
      },
      body: JSON.stringify({
        requestedBy: 'mx-rig-desktop',
        requestId: pending ? `${pending.transitionId}:${phase}:${peer}` : `mx-rig-peer-${Date.now()}`,
        ...(pending ? { transitionId: pending.transitionId, peerLeaseId: other.lease.leaseId, handoverPhase: phase } : {})
      })
    })
    const payload = await answer.json().catch(() => ({}))
    const result = record(payload[resultKey])
    if (!answer.ok || result.status !== 'passed' || result.execution !== 'executed')
      throw new NetworkError('peer_sync_failed', `同步 ${peer} 网络节点失败：${answer.ok ? text(result.failures?.[0]) ?? text(result.error) ?? text(result.status) ?? '返回结果不完整' : `HTTP ${answer.status}`}`)
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
    const pendingSession = this.vault.pendingHandover
    const active = this.applied && pendingSession && ['apply', 'commit'].includes(pendingSession.phase)
      ? pendingSession.newSession
      : this.session
    const leases = Object.keys(this.vault.leaseCredentials).length
    // Nothing was ever applied in this run (a connection that failed early, or
    // none at all): there is no tunnel to stop, and the system is not touched.
    if (!this.applied && !active) {
      if (leases && !this.vault.pendingHandover) await this.#release().catch(() => leases)
      this.state.connection = { status: 'idle', message: this.vault.pendingHandover ? '已保留未完成的网络接管记录，下次连接时恢复' : '', updatedAt: new Date().toISOString() }
      await this.#save()
      this.onChange(this.snapshot())
      return this.snapshot()
    }
    const before = this.state.connection
    this.#set({ status: 'disconnecting', serverReachable: false, message: reason === 'shutdown' ? '正在关闭 MX Rig 的隧道……' : '正在断开……' })
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
        this.state.connection = { ...before, status: 'error', serverReachable: false, message: `停止隧道失败：${stopped.message}`, updatedAt: new Date().toISOString() }
        this.onChange(this.snapshot())
        return this.snapshot()
      }
      this.session = null
      this.applied = false
      this.vault.activeSession = null
      // Releasing either side of an unfinished transition would make its
      // commit/abort recovery impossible. A later connect resumes it first.
      const pending = Boolean(this.vault.pendingHandover)
      this.state.connection = {
        status: 'idle',
        message: pending ? '隧道已停止；已保留未完成的网络接管记录，下次连接时恢复' : '隧道已停止，正在释放网络租约……',
        updatedAt: new Date().toISOString()
      }
      // Shutdown has a hard deadline. Persist the stopped local state before
      // remote releases can time out or retire a lease whose response is lost.
      await this.#save()
      const left = pending ? 0 : await this.#release()
      if (!pending) this.state.connection.message = left ? `隧道已停止，${left} 个 lease 稍后再释放` : '已断开'
      await this.#save()
      this.onChange(this.snapshot())
      return this.snapshot()
    } catch (error) {
      this.state.connection = { ...before, status: 'error', serverReachable: false, message: error?.message ?? String(error), updatedAt: new Date().toISOString() }
      this.onChange(this.snapshot())
      return this.snapshot()
    }
  }

  /** Release this computer's leases; those that cannot be reached now stay for the next time. */
  async #release() {
    const mine = Object.values(this.vault.leaseCredentials).filter(
      (entry) => entry.status !== 'released' && entry.productId === PRODUCT_ID && entry.installId === this.state.installId && entry.publicKey === this.vault.keyPair?.publicKey
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
        this.vault.leaseCredentials = retainedLeaseCredentials({
          ...this.vault.leaseCredentials,
          [entry.leaseId]: { ...entry, status: 'released' }
        }, this.vault.pendingHandover)
      } catch {
        left += 1
      }
    }
    return left
  }
}
