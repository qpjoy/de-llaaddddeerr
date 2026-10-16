// 外网通道（docs/25 P3）：本机的海外代理，只给 Rig 的测试浏览器用。
//
// The chain, the same one Luopan uses, with Rig's own boundaries:
//   1. The signed-in unified account's token goes, through Rig's own VIP,
//      to Launcher Internal, which ensures the user's overseas subscription
//      (ensureElectronLauncherUserOverseaSubscription) and returns it as
//      Mihomo YAML.
//   2. The platform's compiler (@qpjoy/electron-core-mihomo) turns it into an
//      app-level config, and this module pins what makes it Rig's alone:
//      a free loopback port, no LAN, no TUN, no DNS listener, no controller,
//      no geodata download.
//   3. Mihomo (mihomo-engine.mjs) runs it as a child of this app; a request
//      to a site that is only reachable from abroad, through the proxy,
//      shows the line works.
//   4. A person chooses to send the test browser through it; the desktop
//      then hands the proxy to its Runtime (packages/runtime/local-egress.mjs).
//
// Nothing here sets a system proxy, a route, DNS or PAC, so MX-H2I and every
// other application see no change. The subscription holds a per-user
// password: it is written 0600 into this app's data folder while the proxy
// runs, removed when it stops, and never shown or logged.

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, createServer } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { promisify } from 'node:util'
import { parse, stringify } from 'yaml'

export const CHANNEL_ID = 'launcher-oversea'
// Reachable from abroad and not from inside: the platform's own health check.
export const PROBE_URL = 'https://www.gstatic.com/generate_204'
// Private addresses stay direct in the browser too; loopback always is.
export const BROWSER_BYPASS = '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,*.local'
const PREFS_FILE = 'mx-rig-oversea.json'
const RUN_DIR = 'mx-rig-oversea'
const ENSURE_ATTEMPTS = 4
const BUSY = new Set(['preparing', 'syncing', 'starting', 'verifying', 'stopping'])

const TEXT = {
  off: '海外通道没有开启。',
  unavailable: '用平台统一账号登录、连上内网后才能开启。',
  preparing: '正在向 Launcher 申请海外订阅（第一次可能要一两分钟）……',
  syncing: '海外线路还在开通，稍等……',
  starting: '正在启动本机的海外代理……',
  verifying: '正在经海外线路试访问……',
  stopping: '正在关闭……'
}

class OverseaError extends Error {}

// What a failed ensure means to the person, without the raw response.
function ensureFailure(error) {
  const message = String(error?.message ?? error)
  if (/HTTP 403/.test(message)) return '这个账号没有海外权限，请联系管理员开通。'
  if (/HTTP 401/.test(message)) return '统一账号的登录已经过期，请退出后重新登录。'
  if (/HTTP 404/.test(message)) return 'Launcher 还没有海外订阅接口，请联系管理员升级。'
  if (/user mismatch/i.test(message)) return 'Launcher 返回了别的账号的订阅，已拒绝。'
  if (/abort/i.test(message)) return '已取消。'
  return `申请海外订阅失败：${message.replace(/https?:\/\/\S+/g, '…').slice(0, 160)}`
}

/** A loopback port nothing is listening on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Turn the subscription into Rig's config. The compiler is the platform's;
 * what follows it removes every listener but the one loopback port.
 */
export function compileConfig(subscriptionYaml, { compiler, port }) {
  compiler.validateSubscriptionYaml(subscriptionYaml)
  // The subscription's own direct ranges (Internal's reserved CIDRs) survive
  // the compiler, which writes the rules afresh.
  const original = parse(subscriptionYaml)
  const directIps = (Array.isArray(original?.rules) ? original.rules : [])
    .map((rule) => /^IP-CIDR6?,([^,]+),DIRECT\b/.exec(String(rule))?.[1])
    .filter(Boolean)
  const rendered = compiler.renderRuntimeConfig({
    baseYaml: subscriptionYaml,
    // app-global: everything goes abroad except private addresses and the
    // compiler's list of common Chinese sites. No geo rules: they would make
    // Mihomo download GeoIP / GeoSite from GitHub before it starts.
    settings: { mode: 'app-global', ports: { admin: 0, controller: 0, mixed: port, dns: 0 }, controllerSecret: randomBytes(16).toString('hex'), tunInstalled: false, cnDirect: true },
    rules: [],
    useGeoRules: false,
    directIps
  })
  const config = parse(rendered.yaml)
  delete config['external-controller']
  delete config['external-ui']
  delete config.secret
  for (const key of ['port', 'socks-port', 'redir-port', 'tproxy-port']) delete config[key]
  if (config.dns && typeof config.dns === 'object') delete config.dns.listen
  config['bind-address'] = '127.0.0.1'
  config['log-level'] = 'warning'
  if (config['mixed-port'] !== port || config['allow-lan'] !== false || config.tun?.enable === true)
    throw new OverseaError('海外代理的配置不安全（端口、局域网或虚拟网卡），已拒绝启动')
  return { yaml: stringify(config, { lineWidth: 0 }), policy: rendered.proxyPolicyName }
}

/** Ask for PROBE_URL through the proxy: CONNECT, TLS, then a plain GET. */
export function probeThroughProxy({ port, url = PROBE_URL, timeoutMs = 10_000, tlsOptions = {} }) {
  const target = new URL(url)
  const started = Date.now()
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ ...result, latencyMs: Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false, reason: '超时' }), timeoutMs)
    const socket = netConnect(port, '127.0.0.1')
    socket.once('error', (error) => finish({ ok: false, reason: error.code ?? error.message }))
    socket.once('connect', () => {
      socket.write(`CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n\r\n`)
    })
    let head = ''
    const onData = (chunk) => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      socket.off('data', onData)
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1])
      if (status !== 200) return finish({ ok: false, reason: `代理拒绝了连接（${status || '无响应'}）` })
      const secure = tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'], ...tlsOptions })
      secure.once('error', (error) => finish({ ok: false, reason: error.code ?? error.message }))
      const req = httpRequest({
        host: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: { host: target.hostname, 'user-agent': 'mx-rig-oversea-probe', connection: 'close' },
        createConnection: () => secure
      })
      req.once('response', (res) => {
        res.resume()
        finish({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, reason: `HTTP ${res.statusCode}` })
      })
      req.once('error', (error) => finish({ ok: false, reason: error.code ?? error.message }))
      req.end()
    }
    socket.on('data', onData)
  })
}

const processNameOf = async (pid) => {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { windowsHide: true })
      return stdout
    }
    const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'comm='])
    return stdout
  } catch {
    return ''
  }
}

export class LauncherOversea {
  /**
   * `network` is the LauncherNetwork; `sdk` provides
   * ensureElectronLauncherUserOverseaSubscription; `compiler` is
   * @qpjoy/electron-core-mihomo; `engine()` resolves the Mihomo binary.
   */
  constructor({ dir, network, sdk, compiler, engine, spawnImpl = spawn, probe = probeThroughProxy, processName = processNameOf, retryDelayMs = 3000, onChange = () => {} }) {
    this.dir = dir
    this.runDir = join(dir, RUN_DIR)
    this.network = network
    this.sdk = sdk
    this.compiler = compiler
    this.engine = engine
    this.spawnImpl = spawnImpl
    this.probe = probe
    this.processName = processName
    this.retryDelayMs = retryDelayMs
    this.onChange = onChange
    this.prefs = { enabled: false, browser: false }
    this.state = { name: 'off', message: '', verified: null, latencyMs: null, sites: [], updatedAt: new Date().toISOString() }
    this.child = null
    this.port = null
    this.logTail = []
    this.abort = null
    this.queue = Promise.resolve()
    this.lastStatus = null
  }

  static async open(options) {
    const oversea = new LauncherOversea(options)
    const saved = await readFile(join(options.dir, PREFS_FILE), 'utf8').then(JSON.parse, () => ({}))
    oversea.prefs = { enabled: saved.enabled === true, browser: saved.browser === true }
    await oversea.#reapOrphan()
    return oversea
  }

  // -- what the page and the Runtime see ---------------------------------------

  snapshot() {
    const { name, message, verified, latencyMs, sites, updatedAt } = this.state
    const text =
      name === 'ready'
        ? verified
          ? `海外通道已就绪（试访问 ${latencyMs} ms）。`
          : `海外代理已启动，但试访问没有成功（${message}）。`
        : name === 'error'
          ? message
          : TEXT[name]
    return {
      channelId: CHANNEL_ID,
      state: name,
      text,
      enabled: this.prefs.enabled,
      browser: this.prefs.browser,
      usingBrowser: Boolean(this.browserProxy()),
      verified,
      latencyMs,
      sites,
      busy: BUSY.has(name),
      updatedAt
    }
  }

  /** The proxy for the test browser, when the channel is up and chosen. */
  browserProxy() {
    if (this.state.name !== 'ready' || !this.prefs.browser || !this.port) return null
    return { id: CHANNEL_ID, server: `http://127.0.0.1:${this.port}`, bypass: BROWSER_BYPASS }
  }

  #set(name, patch = {}) {
    this.state = { ...this.state, name, message: '', ...patch, updatedAt: new Date().toISOString() }
    this.onChange(this.snapshot())
  }

  async #savePrefs() {
    await mkdir(this.dir, { recursive: true })
    const file = join(this.dir, PREFS_FILE)
    await writeFile(`${file}.tmp`, JSON.stringify(this.prefs))
    await rename(`${file}.tmp`, file)
  }

  #exclusive(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  // -- what a person does ------------------------------------------------------

  start() {
    this.prefs.enabled = true
    return this.#exclusive(async () => {
      await this.#savePrefs()
      return this.#start()
    })
  }

  stop() {
    this.prefs.enabled = false
    // A start still asking Launcher is cancelled at once, not after it.
    this.abort?.abort()
    return this.#exclusive(async () => {
      await this.#savePrefs()
      await this.#halt()
      this.#set('off')
      return this.snapshot()
    })
  }

  async setBrowser(on) {
    this.prefs.browser = on === true
    await this.#savePrefs()
    this.onChange(this.snapshot())
    return this.snapshot()
  }

  /**
   * Follows the product network: a signed-out or disconnected network ends the
   * channel (the entitlement is the account's); each time the account's
   * network comes up again, a channel that was on starts again.
   */
  networkChanged(snapshot) {
    const user = snapshot?.identity?.kind === 'user'
    const previous = this.lastStatus
    this.lastStatus = user ? snapshot.status : 'anonymous'
    if (!user || snapshot.status === 'idle') {
      this.abort?.abort()
      if (this.child || BUSY.has(this.state.name) || this.state.name === 'ready')
        void this.#exclusive(async () => {
          await this.#halt()
          this.#set(this.prefs.enabled ? 'unavailable' : 'off')
        })
      else if (this.prefs.enabled && this.state.name !== 'unavailable') this.#set('unavailable')
      return
    }
    if (snapshot.status === 'ready' && previous !== 'ready' && this.prefs.enabled && !this.child && !BUSY.has(this.state.name))
      void this.#exclusive(() => this.#start())
  }

  /** On quit, and before an installer takes over. */
  shutdown() {
    this.abort?.abort()
    return this.#exclusive(() => this.#halt())
  }

  // -- the chain ---------------------------------------------------------------

  async #start() {
    if (this.child && this.state.name === 'ready') return this.snapshot()
    const session = this.network.overseaSession()
    if (!session) {
      this.#set('unavailable')
      return this.snapshot()
    }
    const abort = new AbortController()
    this.abort = abort
    try {
      this.#set('preparing', { verified: null, latencyMs: null })
      let ensured = null
      for (let attempt = 1; attempt <= ENSURE_ATTEMPTS; attempt += 1) {
        try {
          ensured = await this.sdk.ensureElectronLauncherUserOverseaSubscription({
            baseUrl: session.baseUrl,
            userId: session.userId,
            accessToken: session.accessToken,
            requestedBy: 'mx-rig-desktop',
            requestId: `mx-rig-oversea-${Date.now()}`,
            signal: abort.signal
          })
        } catch (error) {
          throw new OverseaError(ensureFailure(error))
        }
        if (ensured.ready && ensured.subscription?.yaml) break
        if (ensured.status !== 'pending-runtime-sync') break
        if (attempt < ENSURE_ATTEMPTS) {
          this.#set('syncing', { sites: ensured.siteIds })
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs))
          if (abort.signal.aborted) throw new OverseaError('已取消。')
        }
      }
      if (!ensured?.ready || !ensured.subscription?.yaml)
        throw new OverseaError(
          ensured?.status === 'pending-runtime-sync'
            ? '海外线路还在开通，过一会儿再点「开启」。'
            : '这个账号还没有可用的海外线路，请管理员在 Launcher 里开通后再试。'
        )
      this.#set('starting', { sites: ensured.siteIds })
      const port = await freePort()
      const { yaml } = compileConfig(ensured.subscription.yaml, { compiler: this.compiler, port })
      const binary = await this.engine()
      if (abort.signal.aborted) throw new OverseaError('已取消。')
      await this.#run(binary, yaml, port)
      this.#set('verifying')
      const probed = await this.probe({ port })
      if (abort.signal.aborted) throw new OverseaError('已取消。')
      this.#set('ready', { verified: probed.ok, latencyMs: probed.latencyMs, message: probed.ok ? '' : probed.reason })
    } catch (error) {
      await this.#halt()
      // Cancelled by a person (off) or by the network going away (waiting).
      if (abort.signal.aborted) this.#set(this.prefs.enabled ? 'unavailable' : 'off')
      else
        this.#set('error', {
          message: error instanceof OverseaError ? error.message : `海外通道启动失败：${String(error?.message ?? error).slice(0, 160)}`
        })
    } finally {
      if (this.abort === abort) this.abort = null
    }
    return this.snapshot()
  }

  async #run(binary, yaml, port) {
    await mkdir(this.runDir, { recursive: true })
    const config = join(this.runDir, 'config.yaml')
    await writeFile(config, yaml, { mode: 0o600 })
    this.logTail = []
    const child = this.spawnImpl(binary, ['-d', this.runDir, '-f', config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.port = port
    const keep = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) this.logTail = [...this.logTail.slice(-19), line.slice(0, 300)]
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.port = null
      if (this.state.name === 'ready' || this.state.name === 'verifying')
        this.#set('error', { message: `海外代理意外退出${this.#lastError() ? `：${this.#lastError()}` : ''}。` })
    })
    if (child.pid) await writeFile(join(this.runDir, 'mihomo.pid'), String(child.pid))
    // Up when its port answers; gone if it exits first.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (this.child !== child) throw new OverseaError(`海外代理没有启动${this.#lastError() ? `：${this.#lastError()}` : ''}`)
      if (await new Promise((resolve) => {
        const socket = netConnect(port, '127.0.0.1')
        socket.once('connect', () => (socket.destroy(), resolve(true)))
        socket.once('error', () => resolve(false))
      }))
        return
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new OverseaError('海外代理 10 秒内没有开始监听')
  }

  #lastError() {
    return [...this.logTail].reverse().find((line) => /level=(error|fatal)|error|fatal/i.test(line))?.replace(/^time="[^"]*"\s*/, '') ?? ''
  }

  /** Stop the process and remove the config that holds the subscription. */
  async #halt() {
    const child = this.child
    this.child = null
    this.port = null
    if (child && child.exitCode === null && child.signalCode === null) {
      this.#set('stopping')
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
      clearTimeout(timer)
    }
    await rm(join(this.runDir, 'config.yaml'), { force: true })
    await rm(join(this.runDir, 'mihomo.pid'), { force: true })
  }

  /** A proxy left by a crash of this app: stopped, but only if it is ours. */
  async #reapOrphan() {
    const pid = Number(await readFile(join(this.runDir, 'mihomo.pid'), 'utf8').catch(() => ''))
    if (Number.isInteger(pid) && pid > 0) {
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {}
      if (alive && /mihomo/i.test(await this.processName(pid))) {
        try {
          process.kill(pid)
        } catch {}
      }
    }
    await rm(join(this.runDir, 'config.yaml'), { force: true })
    await rm(join(this.runDir, 'mihomo.pid'), { force: true })
  }
}
