import { app, BrowserWindow, clipboard, ipcMain, dialog, net, protocol, safeStorage, shell } from 'electron'
import { execFile, fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { RigClient } from '../../packages/runtime/client.mjs'
import { RigError, serviceUrl } from '../../packages/contracts/index.mjs'
import { REPORT_PATH } from './report-request.mjs'
import { MEDIA_SCHEME, mediaResponse } from './run-media.mjs'
import { ProjectWorkspaces, readPack } from '../../packages/runtime/project-workspace.mjs'
import { PUBLISH_POLICY, TestRepositories, taskBranch } from '../../packages/runtime/test-repository.mjs'
import { routeAction } from '../web/routes.js'
import { syncDesignAssets } from '../../scripts/design-assets.mjs'
import { LocalRunner, localStation } from './local-runner.mjs'
import { replayDocument } from '../../packages/runtime/replay.mjs'
import { firstRun } from './first-run.mjs'
import { DEFAULT_BOOTSTRAP_URLS, LauncherNetwork } from './launcher-network.mjs'
import { LauncherUpdates } from './launcher-updates.mjs'
import { LauncherOversea } from './launcher-oversea.mjs'
import { prepareEngine, shippedEngine } from './mihomo-engine.mjs'
import { browserSignIn } from './browser-sign-in.mjs'
import { existsSync, readdirSync } from 'node:fs'

// Read actions the workbench may forward. An explicit table means the renderer
// can never name an arbitrary path, and the desktop and web surfaces cannot
// drift into offering different data.
const READ_ACTIONS = {
  config: '/api/rig/v1/config',
  tools: '/api/rig/v1/tools',
  graph: '/api/rig/v1/graph',
  egress: '/api/rig/v1/egress',
  system: '/api/rig/v1/system',
  tasks: '/api/v1/tasks',
  runs: '/api/v1/runs?limit=20',
  apps: '/api/v1/apps',
  members: '/api/v1/members',
  runners: '/api/v1/runners',
  hooks: '/api/rig/v1/hooks',
  'tour-videos': '/api/rig/v1/tour-videos'
}

// The desktop hands nothing to the system browser any more: the old
// test-management console's functions are in the workbench (docs/21 M1–M3),
// and execution reports open in a window of the desktop's own
// (report-window.mjs).

const root = fileURLToPath(new URL('../../', import.meta.url))
const ui = fileURLToPath(new URL('../web/index.html', import.meta.url))

// The built-in proving ground (test-packs/proving-ground): a small app with
// planted defects, for learning and demos. It runs only on this computer, only
// when someone asks for it, and never stands for a real product. One already
// running on its usual port (npm run proving-ground) is used as it is.
const PROVING_GROUND_PORT = 4610
// Recording the tours (scripts/record-tours.mjs) points this at a neutral
// copy, so no one's home folder appears in a video meant to be shown around.
const provingGroundDir = process.env.MX_RIG_PROVING_GROUND_DIR || join(root, 'test-packs', 'proving-ground')
let provingGround = null
async function provingGroundAt(origin) {
  const answer = await fetch(origin, { signal: AbortSignal.timeout(1500) }).catch(() => null)
  return Boolean(answer?.ok && (await answer.text().catch(() => '')).includes('星港物资台'))
}
async function provingGroundStatus() {
  if (provingGround) return { running: true, origin: provingGround.origin, directory: provingGroundDir }
  const usual = `http://127.0.0.1:${PROVING_GROUND_PORT}`
  if (await provingGroundAt(usual)) return { running: true, origin: usual, directory: provingGroundDir }
  return { running: false, origin: null, directory: provingGroundDir }
}
async function provingGroundStart() {
  const status = await provingGroundStatus()
  if (status.running) return status
  const { startProvingGround } = await import(pathToFileURL(join(provingGroundDir, 'server.mjs')).href)
  // The usual port may be taken by something else: then any free one.
  provingGround = await startProvingGround({ port: PROVING_GROUND_PORT }).catch(() => startProvingGround({ port: 0 }))
  return provingGroundStatus()
}
let window,
  client,
  worker,
  member,
  localRunner = null,
  station = null,
  projectWorkspaces = null,
  testRepositories = null,
  quitting = false,
  loginPending = false,
  sequence = 0
const pending = new Map()
app.setAppUserModelId('dev.qpjoy.mx-rig')
// Electron derives a separate userData directory from this product identity.
app.setName('MX Rig')
if (process.env.MX_RIG_USER_DATA_DIR)
  app.setPath('userData', resolve(process.env.MX_RIG_USER_DATA_DIR))
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  window?.show()
  window?.focus()
})

function rpc(method, input = {}, timeoutMs = 15_000) {
  if (!worker?.connected)
    return Promise.reject(new RigError('runtime_offline', '本地 Runtime 不可用，请重新登录'))
  return new Promise((yes, no) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      no(new RigError('timeout', 'Runtime 请求超时'))
    }, timeoutMs)
    pending.set(id, { yes, no, timer })
    worker.send({ id, method, input })
  })
}
async function stopWorker() {
  if (!worker) return
  const old = worker
  try {
    await rpc('close')
  } catch {
    /* Worker owns only its own browser children. */
  }
  if (old.connected) old.disconnect()
  worker = null
  setTimeout(() => {
    if (old.exitCode === null) old.kill()
  }, 3000).unref()
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.no(new RigError('closed', 'Runtime 已关闭'))
  }
  pending.clear()
}
// -- where to log in, and which browser to test with ---------------------------
//
// A build made for a team carries its server address (scripts/package.mjs
// --server writes defaults.json); after a login, the address that worked is
// remembered on this computer and offered next time. The password never is.
const lastLoginFile = () => join(app.getPath('userData'), 'login.json')

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// Launcher mode (docs/25 §3): built into an installer with `launcher` in its
// defaults, or MX_RIG_LAUNCHER=1 from source. The desktop then reaches the Rig
// service through its own product network instead of an address typed in.
let network = null
// …and in Launcher mode its versions come from Launcher's Release Center (docs/25 P2).
let updates = null
// …and the account's overseas subscription can become a channel for the test browser (P3).
let oversea = null

// The Runtime takes the overseas channel with its policy; a Runtime started
// later gets it at init.
function syncLocalEgress() {
  if (!worker?.connected || !client) return
  rpc('local-egress', { channel: oversea?.browserProxy() ?? null }).catch(() => {})
}
async function launcherSettings() {
  const packaged = (await readJson(join(root, 'apps/desktop/defaults.json'))) ?? {}
  const enabled = process.env.MX_RIG_LAUNCHER === '1' || (process.env.MX_RIG_LAUNCHER !== '0' && packaged.launcher?.enabled === true)
  if (!enabled) return null
  const fromEnv = String(process.env.MX_RIG_BOOTSTRAP_URLS ?? '').split(',').map((url) => url.trim()).filter(Boolean)
  return {
    bootstrapUrls: fromEnv.length ? fromEnv : packaged.launcher?.bootstrapUrls?.length ? packaged.launcher.bootstrapUrls : DEFAULT_BOOTSTRAP_URLS,
    serverUrl: process.env.MX_RIG_SERVER_URL || packaged.launcher?.serverUrl || null,
    distribution: updateDistribution(packaged.launcher?.distribution)
  }
}

// Only an installed copy updates itself: from source it is 'development', a
// --dir build is 'portable'. MX_RIG_UPDATE_DISTRIBUTION=installed is the test
// entry for exercising updates from source; a packaged app ignores it.
function updateDistribution(packaged) {
  if (!app.isPackaged) return process.env.MX_RIG_UPDATE_DISTRIBUTION === 'installed' ? 'installed' : 'development'
  return packaged === 'portable' ? 'portable' : 'installed'
}

// The version Release Center compares: package.json's, the same from source
// (where Electron would report its own) and packaged.
async function appVersion() {
  return (await readJson(join(root, 'package.json')))?.version ?? app.getVersion()
}

async function loginDefaults() {
  if (network) {
    const last = (await readJson(lastLoginFile())) ?? {}
    return { server: network.serverUrl() ?? '', privateHttp: true, account: last.account ?? '', packaged: null, launcher: network.snapshot() }
  }
  const packaged = (await readJson(join(root, 'apps/desktop/defaults.json'))) ?? {}
  const last = (await readJson(lastLoginFile())) ?? {}
  const server = last.server || packaged.server || process.env.MX_RIG_SERVER_URL || 'http://127.0.0.1:8791'
  return {
    server,
    privateHttp: last.server ? last.privateHttp === true : packaged.privateHttp === true || process.env.MX_RIG_ALLOW_PRIVATE_HTTP === '1',
    account: last.account ?? '',
    packaged: packaged.server ?? null
  }
}

async function rememberLogin({ server, privateHttp, account }) {
  const file = lastLoginFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ server, privateHttp, account }, null, 2), { mode: 0o600 })
}

// The installer's own Chromium (scripts/package.mjs puts it in resources),
// and where a download goes when there is none. Every process this app starts
// gets both, so they share one copy.
function browserEnv() {
  const bundled = app.isPackaged ? join(process.resourcesPath, 'ms-playwright') : null
  return {
    ...(bundled && existsSync(bundled) ? { MX_RIG_BUNDLED_BROWSERS: bundled } : {}),
    MX_RIG_BROWSERS_DIR: join(app.getPath('userData'), 'browsers')
  }
}

/**
 * A test repository's own Playwright looks for browsers in its default cache.
 * Point it at this app's Chromium when there is one, so a run never starts by
 * downloading a browser.
 */
function playwrightBrowsers() {
  const env = browserEnv()
  for (const dir of [env.MX_RIG_BUNDLED_BROWSERS, env.MX_RIG_BROWSERS_DIR]) {
    if (dir && existsSync(dir) && readdirSync(dir).some((name) => name.startsWith('chromium'))) return { PLAYWRIGHT_BROWSERS_PATH: dir }
  }
  return {}
}

async function login(input) {
  await endSession()
  const { url, privateHttp } = loginTarget(input)
  const next = new RigClient({ url, token: '', privateHttp })
  const result = await next.request('/api/rig/v1/native-login', {
    account: input.account,
    password: input.password
  })
  next.token = result.token
  const { principal } = await next.request('/api/rig/v1/me')
  // Finish the unified account's lease handover before starting anything
  // that fetches from Rig. A tunnel restart must not race the first screen.
  // Local accounts and the service admin keep their anonymous network.
  if (network && !/^local:/.test(principal.id) && principal.id !== 'service-admin') {
    const connected = await network.signIn({ account: input.account, password: input.password })
    if (connected.status !== 'ready' || connected.identity.kind !== 'user' || connected.serverReachable !== true)
      throw new RigError('network_not_ready', '账号已验证，但用户内网尚未就绪。请查看内网连接状态，恢复连接后重试登录。')
  }
  return startSession({ next, token: result.token, principal, url, privateHttp, account: input.account })
}

/** Everything that runs for a signed-in member, however they signed in. */
async function startSession({ next, token, principal, url, privateHttp, account }) {
  const workspace = createHash('sha256')
    .update(`${url}\n${principal.id}`)
    .digest('hex')
    .slice(0, 32)
  const workerEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE|LANG|LC_ALL|DISPLAY|XAUTHORITY|PLAYWRIGHT_BROWSERS_PATH|MX_RIG_CHROMIUM_PATH|MX_RIG_BROWSER_MIRROR|MX_RIG_BROWSER_MIRROR_ONLY|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(
        name
      )
    )
  )
  Object.assign(workerEnv, browserEnv())
  worker = fork(join(root, 'packages/runtime/worker.mjs'), [], {
    env: { ...workerEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  })
  worker.on('message', (message) => {
    if (['frame', 'chooser', 'dialog', 'provision'].includes(message?.event)) {
      if (!window?.isDestroyed())
        window?.webContents.send(`mx-rig:${message.event}`, message.frame ?? message.info)
      return
    }
    const item = pending.get(message.id)
    if (!item) return
    clearTimeout(item.timer)
    pending.delete(message.id)
    message.error
      ? item.no(new RigError(message.error.code, message.error.message))
      : item.yes(message.result)
  })
  worker.on('exit', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.no(new RigError('runtime_exit', 'Runtime 已退出，请重新登录'))
    }
    pending.clear()
  })
  await rpc('init', {
    url,
    token,
    owner: principal.id,
    root: join(app.getPath('userData'), 'workspaces', workspace),
    electronApps: await loadElectronApps(),
    privateHttp,
    localEgress: oversea?.browserProxy() ?? null
  })
  client = next
  member = principal
  // A browser sign-in keeps the account last typed for the password form.
  const remembered = account ?? (await readJson(lastLoginFile()))?.account ?? ''
  await rememberLogin({ server: url, privateHttp, account: remembered }).catch(() => {})
  // Test projects' snapshots and QA repositories on this computer (docs/21 §5).
  projectWorkspaces = new ProjectWorkspaces(join(app.getPath('userData'), 'workspaces', workspace, 'project-workspaces'))
  // The same directory: a project's test repository is its workspace's qa/ (docs/23).
  testRepositories = new TestRepositories(projectWorkspaces.root)
  // This computer as a runner for this member on this service. Its token
  // lives next to the member's workspace, never in the renderer. It is told
  // where the project workspaces are, and where this app's Chromium is.
  localRunner = new LocalRunner({
    dir: join(app.getPath('userData'), 'workspaces', workspace, 'runner'),
    script: join(root, 'packages/test-platform/bin/mxt-runner.mjs'),
    extraEnv: { ELECTRON_RUN_AS_NODE: '1', MXT_PROJECT_WORKSPACES: projectWorkspaces.root, ...browserEnv(), ...playwrightBrowsers() }
  })
  // On duty (值守): procedure regression queued on the service is replayed
  // here, by the same `mx-rig station` a server would run, in its own process
  // with its own headless browser — the member's missions are not touched.
  station = localStation({
    dir: join(app.getPath('userData'), 'workspaces', workspace, 'station'),
    script: join(root, 'bin/mx-rig.mjs'),
    env: workerEnv,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1', ...(privateHttp ? { MX_RIG_ALLOW_PRIVATE_HTTP: '1' } : {}) }
  })
  // Said out loud once: a session token on plain HTTP is only as private as
  // the network it crosses.
  return {
    member: principal,
    cleartext:
      new URL(url).protocol === 'http:' &&
      !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url).hostname)
  }
}

// Whatever ran for the previous member stops before anyone signs in.
async function endSession() {
  await stopWorker()
  await Promise.allSettled([localRunner?.stop(), station?.stop()])
  localRunner = null
  station = null
  projectWorkspaces = null
  testRepositories = null
  client = null
  member = null
}

// Which service a sign-in goes to. Launcher mode: the one behind this
// product's VIP, inside the tunnel.
function loginTarget(input = {}) {
  const launched = network ? network.snapshot() : null
  if (launched && (launched.status !== 'ready' || !launched.serverUrl))
    throw new RigError('network_not_ready', '先连上内网再登录')
  const privateHttp = Boolean(launched) || input.privateHttp === true || process.env.MX_RIG_ALLOW_PRIVATE_HTTP === '1'
  const url = serviceUrl(launched?.serverUrl || input.url || process.env.MX_RIG_SERVER_URL || 'http://127.0.0.1:8791', {
    privateHttp
  })
  return { url, privateHttp }
}

/** What the service's login page offers: browser SSO (docs/25 P4), passwords. */
async function authMethods(input) {
  let target
  try {
    target = loginTarget(input)
  } catch {
    return { sso: { enabled: false }, password: true }
  }
  return new RigClient({ ...target, token: '' }).request('/api/rig/v1/auth-methods').catch(() => ({ sso: { enabled: false }, password: true }))
}

// The browser sign-in waiting for its callback, so it can be cancelled.
let browserSignInAbort = null

/**
 * Sign in through the system browser and the platform's unified
 * authentication (browser-sign-in.mjs). Rig's session only: the product
 * network stays anonymous and the overseas channel off, because the network
 * token comes from a password grant (docs/25 §11).
 */
async function browserLogin(input) {
  await endSession()
  const { url, privateHttp } = loginTarget(input)
  const next = new RigClient({ url, token: '', privateHttp })
  const methods = await next.request('/api/rig/v1/auth-methods')
  if (!methods.sso?.enabled) throw new RigError('sso_disabled', '这个 Rig 服务还没有开启统一认证登录')
  browserSignInAbort = new AbortController()
  let result
  try {
    result = await browserSignIn({
      ssoOrigin: methods.sso.origin,
      openExternal: (target) => shell.openExternal(target),
      redeem: (body) => next.request('/api/rig/v1/desktop-login', body),
      signal: browserSignInAbort.signal
    })
  } finally {
    browserSignInAbort = null
  }
  next.token = result.token
  const { principal } = await next.request('/api/rig/v1/me')
  const started = await startSession({ next, token: result.token, principal, url, privateHttp, account: null })
  return {
    ...started,
    ...(network ? { networkNote: '已用浏览器登录。内网仍是匿名网络，海外通道不可用；需要用户网络时，退出后用账号密码登录。' } : {})
  }
}

// -- Electron station: which apps this machine's user allowed an Agent to start --
//
// Kept on this machine, in this user's profile: an executable path means
// nothing on another computer, and it is this person — not a policy edited in
// a browser — who vouches for what may be launched here.
const electronAppsFile = () => join(app.getPath('userData'), 'electron-apps.json')

async function loadElectronApps() {
  try {
    const stored = JSON.parse(await readFile(electronAppsFile(), 'utf8'))
    return Array.isArray(stored) ? stored.slice(0, 20) : []
  } catch {
    return []
  }
}

async function saveElectronApps(apps) {
  const file = electronAppsFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(apps, null, 2), { mode: 0o600 })
  await rename(temp, file)
  if (worker?.connected) await rpc('set-electron-apps', { apps }).catch(() => {})
  return apps
}

/** A macOS .app bundle is a folder; the thing to launch is inside it. */
function plistValue(plist, key) {
  return new Promise((resolve) =>
    execFile(
      'plutil',
      ['-extract', key, 'raw', '-o', '-', plist],
      { timeout: 5_000 },
      (error, stdout) => resolve(error ? null : stdout.trim() || null)
    )
  )
}

/**
 * A native macOS app for the native station (preview). It is addressed by
 * bundle id — the Accessibility tree is found through its process — so that
 * is what is kept, next to the path the person picked.
 */
async function addNativeApp() {
  if (process.platform !== 'darwin')
    throw new RigError('native_unsupported', '原生桌面工位目前只支持 macOS', 409)
  const picked = await dialog.showOpenDialog(window, {
    title: '选择要交给 Agent 测试的原生应用（.app）',
    defaultPath: '/Applications',
    properties: ['openFile', 'openDirectory']
  })
  const path = picked.filePaths[0]
  if (picked.canceled || !path) return loadElectronApps()
  if (!path.endsWith('.app')) throw new RigError('invalid_app', '请选择一个 .app 应用')
  const plist = join(path, 'Contents', 'Info.plist')
  const bundleId = await plistValue(plist, 'CFBundleIdentifier')
  if (!bundleId || !/^[A-Za-z0-9.-]{3,200}$/.test(bundleId))
    throw new RigError('invalid_app', '没有在这个 .app 里读到 Bundle ID')
  const name = (await plistValue(plist, 'CFBundleName')) || basename(path, '.app')
  const id = `native-${bundleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)}`
  const apps = (await loadElectronApps()).filter((entry) => entry.id !== id)
  return saveElectronApps([...apps, { id, name, kind: 'native', path, bundleId }])
}

function procedureId(body) {
  const id = String(body?.id ?? '')
  if (!/^prc_[a-f0-9]{18}$/.test(id)) throw new RigError('invalid_input', '规程编号无效')
  return id
}

async function executableOf(picked) {
  if (process.platform === 'darwin' && picked.endsWith('.app')) {
    const plist = await readFile(join(picked, 'Contents', 'Info.plist'), 'utf8').catch(() => '')
    const named = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
    const folder = join(picked, 'Contents', 'MacOS')
    const candidate = named ? join(folder, named) : join(folder, (await readdir(folder))[0] ?? '')
    if ((await stat(candidate)).isFile()) return candidate
    throw new RigError('invalid_app', '没有在这个 .app 里找到可执行文件')
  }
  if (!(await stat(picked)).isFile()) throw new RigError('invalid_app', '请选择应用的可执行文件')
  return picked
}

/**
 * A mission artifact on this machine, by the name the record gives it. Only
 * the shapes the browser writes (`<mission>/<n>.png`, `<mission>/<n>-intent.png`)
 * are accepted; the renderer can never name another file.
 */
function artifactPath(path) {
  if (!/^[a-f0-9-]{36}\/\d+(-intent)?\.png$/.test(String(path ?? '')))
    throw new RigError('invalid_artifact', '产物路径无效')
  const workspace = createHash('sha256')
    .update(`${client.url}\n${member.id}`)
    .digest('hex')
    .slice(0, 32)
  return join(app.getPath('userData'), 'workspaces', workspace, 'artifacts', path)
}

function trusted(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== pathToFileURL(ui).href
  )
    throw new RigError('untrusted_frame', '拒绝非工作台请求')
}
// A run's recordings play inside the workbench (run-media.mjs). Streaming is
// what lets a <video> send Range requests, and so seek to a step.
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }
])

app
  .whenReady()
  .then(async () => {
    protocol.handle(MEDIA_SCHEME, (request) => mediaResponse(request, { session: client, fetch: net.fetch }))
    // A packaged build already carries the copy; in a source checkout this
    // picks up whatever version of the design system is installed.
    // Only from source: inside a packaged app the folder is part of the
    // read-only app.asar (writing there failed every packaged launch).
    if (!app.isPackaged) await syncDesignAssets()
    ipcMain.handle('mx-rig:request', async (event, input) => {
      trusted(event)
      if (!input || typeof input.action !== 'string')
        throw new RigError('invalid_request', '请求无效')
      if (input.action === 'login') {
        if (loginPending) throw new RigError('login_pending', '正在登录，请稍候')
        loginPending = true
        try {
          return await login(input.body || {})
        } finally {
          loginPending = false
        }
      }
      if (input.action === 'browser-login') {
        if (loginPending) throw new RigError('login_pending', '正在登录，请稍候')
        loginPending = true
        try {
          return await browserLogin(input.body || {})
        } finally {
          loginPending = false
        }
      }
      if (input.action === 'browser-login-cancel') {
        browserSignInAbort?.abort()
        return { cancelled: Boolean(browserSignInAbort) }
      }
      if (input.action === 'auth-methods') return authMethods(input.body || {})
      if (input.action === 'login-defaults') return loginDefaults()
      // The product network is there before anyone signs in: the login page needs it.
      if (input.action === 'network-status') return network ? network.snapshot() : null
      if (input.action === 'network-connect') {
        if (!network) throw new RigError('not_launcher', '这个安装包不是 Launcher 模式')
        if (loginPending) throw new RigError('login_pending', '正在登录，请等待网络切换完成')
        return network.connect()
      }
      if (input.action === 'network-disconnect') {
        if (!network) throw new RigError('not_launcher', '这个安装包不是 Launcher 模式')
        if (loginPending) throw new RigError('login_pending', '正在登录，请等待网络切换完成')
        return network.disconnect('manual')
      }
      if (input.action === 'network-recover') {
        if (!network) throw new RigError('not_launcher', '这个安装包不是 Launcher 模式')
        if (loginPending) throw new RigError('login_pending', '正在登录，请等待网络切换完成')
        return network.recoverIdentity()
      }
      // The overseas channel follows the account's network, not the Rig login.
      if (input.action === 'oversea-status') return oversea ? oversea.snapshot() : null
      if (input.action.startsWith('oversea-')) {
        if (!oversea) throw new RigError('not_launcher', '这个安装包不是 Launcher 模式')
        if (input.action === 'oversea-start') return oversea.start()
        if (input.action === 'oversea-stop') return oversea.stop()
        if (input.action === 'oversea-browser') return oversea.setBrowser(input.body?.on === true)
        throw new RigError('invalid_action', '未知动作')
      }
      // Updates too: a client too old to sign in can still be updated.
      if (input.action === 'update-status') return updates ? updates.status() : null
      if (input.action.startsWith('update-')) {
        if (!updates) throw new RigError('not_launcher', '这个安装包不是 Launcher 模式')
        if (input.action === 'update-check') return updates.check()
        if (input.action === 'update-download') return updates.download()
        if (input.action === 'update-install') return updates.install()
        if (input.action === 'update-cancel') return updates.cancel()
        throw new RigError('invalid_action', '未知动作')
      }
      if (input.action === 'me') return { principal: member }
      if (!client) throw new RigError('login_required', '请先登录')
      switch (input.action) {
        case 'logout': {
          // The worker goes first: closing it sends its last mission updates
          // with the session that is about to end. Then the session ends on
          // the server too; a failure there must not keep this machine signed in.
          const ending = client
          await stopWorker()
          await Promise.allSettled([localRunner?.stop(), station?.stop()])
          localRunner = null
          station = null
          projectWorkspaces = null
          testRepositories = null
          await ending.request('/api/rig/v1/logout', {}).catch(() => {})
          client = null
          member = null
          if (network?.snapshot().identity.kind === 'user') void network.signOut()
          return { ok: true }
        }
        case 'change-password':
          return client.request('/api/v1/auth/password', {
            current: String(input.body?.current ?? ''),
            next: String(input.body?.next ?? '')
          })
        case 'missions':
          return rpc('list')
        case 'project-access':
        case 'project-access-save': {
          const { app, ...body } = input.body ?? {}
          if (typeof app !== 'string' || !/^[a-z0-9-]{1,64}$/.test(app)) throw new RigError('invalid_input', '项目标识无效')
          return client.request(`/api/v1/apps/${app}/access`, input.action === 'project-access' ? undefined : body)
        }
        case 'project-create':
          return client.request('/api/v1/apps', input.body)
        case 'project-directory': {
          const picked = await dialog.showOpenDialog(window, { title: '选择被测项目目录', properties: ['openDirectory'] })
          return { directory: picked.canceled ? null : picked.filePaths[0] }
        }
        case 'source-connect': {
          const picked = await dialog.showOpenDialog(window, { title: '连接本任务源码（只读，所读内容会提供给模型）', properties: ['openDirectory'] })
          return picked.canceled ? rpc('source-status', input.body) : rpc('source-connect', { id: input.body?.id, directory: picked.filePaths[0] }, 60_000)
        }
        case 'source-git-connect':
        case 'source-refresh':
          return rpc(input.action, input.body, 180_000)
        case 'source-cancel':
        case 'source-status':
        case 'source-disconnect':
        case 'implementation-export':
          return rpc(input.action, input.body)
        case 'task-implementation':
        case 'task-implementation-save':
        case 'task-implementation-approve': {
          const { id, ...body } = input.body ?? {}
          if (!/^[a-f0-9-]{36}$/.test(id)) throw new RigError('invalid_input', '任务编号无效')
          const base = `/api/rig/v1/missions/${id}/implementation`
          if (input.action === 'task-implementation') return client.request(base + (body.revision ? `?revision=${encodeURIComponent(body.revision)}` : ''))
          return client.request(base + (input.action === 'task-implementation-approve' ? ':approve' : ''), body)
        }
        case 'test-task-create':
          if (!['admin', 'operator'].includes(member?.role)) throw new RigError('forbidden', '需要测试操作权限', 403)
          return rpc('test-task-create', input.body)
        case 'task-cases':
        case 'task-cases-save':
        case 'task-cases-confirm': {
          const id = String(input.body?.id ?? '')
          if (!/^[a-f0-9-]{36}$/.test(id)) throw new RigError('invalid_input', '任务编号无效')
          const base = `/api/rig/v1/missions/${id}/cases`
          if (input.action === 'task-cases')
            return client.request(base + (input.body.revision ? `?revision=${encodeURIComponent(input.body.revision)}` : ''))
          return client.request(base + (input.action === 'task-cases-confirm' ? ':confirm' : ''), {
            expectedRevision: input.body.expectedRevision,
            ...(input.action === 'task-cases-save' ? { cases: input.body.cases } : {})
          })
        }
        case 'task-executions':
        case 'task-execution-plan':
        case 'task-execution-dispatch': {
          const { id, ...body } = input.body ?? {}
          if (!/^[a-f0-9-]{36}$/.test(id)) throw new RigError('invalid_input', '任务编号无效')
          const base = `/api/rig/v1/missions/${id}/executions`
          return input.action === 'task-executions' ? client.request(base + (body.runId ? `?run=${encodeURIComponent(body.runId)}` : ''))
            : client.request(base + (input.action === 'task-execution-plan' ? ':plan' : ':dispatch'), body)
        }
        case 'start':
          return rpc('start', input.body)
        case 'followup':
          return rpc('followup', input.body)
        case 'approve':
          return rpc('approve', input.body)
        case 'cancel':
          return rpc('cancel', input.body)
        case 'export':
          return rpc('export', input.body)
        case 'takeover':
          return rpc('takeover', input.body)
        // Takeover in the live pane: the person's input goes to the page.
        case 'browser-input':
          return rpc('browser-input', { id: String(input.body?.id ?? ''), event: input.body?.event ?? {} })
        case 'browser-files': {
          // The person picks the files; the renderer never names a path.
          const picked = await dialog.showOpenDialog(window, {
            title: '选择要上传到页面的文件',
            properties: ['openFile', ...(input.body?.multiple ? ['multiSelections'] : [])]
          })
          if (picked.canceled || !picked.filePaths.length) return { files: 0 }
          return rpc('browser-files', { id: String(input.body?.id ?? ''), paths: picked.filePaths })
        }
        case 'browser-dialog':
          return rpc('browser-dialog', {
            id: String(input.body?.id ?? ''),
            accept: input.body?.accept === true,
            text: typeof input.body?.text === 'string' ? input.body.text.slice(0, 2000) : ''
          })
        // The test browser: what is used, and a download on request.
        case 'browser-status':
          return rpc('browser-status')
        case 'browser-download':
          return rpc('browser-download', { force: input.body?.force === true })
        case 'browser-copy': {
          // Straight to the clipboard: the selection never comes back to the
          // renderer, and is not kept anywhere.
          const { text } = await rpc('browser-copy', { id: String(input.body?.id ?? '') })
          if (text) clipboard.writeText(text)
          return { copied: text.length }
        }
        // 试验规程: stored on the service, played on this station.
        case 'procedures':
          return client.request('/api/rig/v1/procedures')
        case 'procedure':
          return client.request(`/api/rig/v1/procedures/${procedureId(input.body)}`)
        case 'procedure-create':
          return client.request('/api/rig/v1/procedures', { procedure: input.body?.procedure })
        case 'procedure-revise':
          return client.request(`/api/rig/v1/procedures/${procedureId(input.body)}:revise`, {
            expectedRevision: input.body?.expectedRevision,
            procedure: input.body?.procedure,
            reason: input.body?.reason
          })
        case 'procedure-status':
          return client.request(`/api/rig/v1/procedures/${procedureId(input.body)}:status`, {
            status: input.body?.status
          })
        case 'procedure-decide':
          return client.request(
            `/api/rig/v1/procedures/${procedureId(input.body)}/proposals/${String(
              input.body?.proposalId ?? ''
            ).replace(/[^a-z0-9_]/g, '')}:decide`,
            { approved: input.body?.approved === true }
          )
        case 'procedure-capture':
          return rpc('procedure-capture', input.body)
        case 'procedure-fire':
          // A replay takes as long as the procedure does.
          return rpc('procedure-fire', input.body, 15 * 60_000)
        case 'procedure-fire-all':
          return rpc('procedure-fire-all', input.body ?? {}, 2 * 60 * 60_000)
        case 'procedure-repair':
          return rpc('procedure-repair', input.body, 5 * 60_000)
        case 'hooks-save':
          return client.request('/api/rig/v1/hooks', {
            version: input.body?.version,
            rules: input.body?.rules
          })
        case 'hooks-tick':
          return client.request('/api/rig/v1/hooks:tick', {})
        case 'cases-import':
          return client.request('/api/rig/v1/cases:import', { cases: input.body?.cases })
        // A test project's workspace on this computer (docs/21 §5).
        case 'workspace-status': {
          const state = await projectWorkspaces.status(String(input.body?.app ?? ''))
          const behind = state.snapshot ? await projectWorkspaces.behind(state.app).catch(() => null) : null
          return { ...state, behind }
        }
        case 'workspace-pick': {
          const picked = await dialog.showOpenDialog(window, {
            title: '选择被测项目所在的目录',
            properties: ['openDirectory']
          })
          return picked.canceled || !picked.filePaths[0] ? { canceled: true } : { directory: picked.filePaths[0] }
        }
        case 'workspace-create': {
          const body = input.body ?? {}
          const pack = await readPack(join(root, 'test-packs'), String(body.pack ?? ''))
          const source =
            body.source?.kind === 'local'
              ? { kind: 'local', directory: String(body.source.directory ?? '') }
              : { kind: 'git', repoUrl: String(body.source?.repoUrl ?? '') }
          return projectWorkspaces.create({
            app: String(body.app ?? ''),
            pack,
            source,
            ref: typeof body.ref === 'string' && body.ref ? body.ref : undefined,
            commit: typeof body.commit === 'string' && body.commit ? body.commit : undefined
          })
        }
        case 'workspace-open': {
          const state = await projectWorkspaces.status(String(input.body?.app ?? ''))
          const target = input.body?.which === 'snapshot' ? state.snapshot?.dir : state.qa ? join(projectWorkspaces.root, state.app, 'qa') : null
          if (!target) throw new RigError('not_found', '这个项目在本机还没有工作区', 404)
          const { shell } = await import('electron')
          const failed = await shell.openPath(target)
          if (failed) throw new RigError('open_failed', failed)
          return { ok: true }
        }
        // A project's test repository on this computer, and its versions on the service (docs/23).
        case 'repository-status': {
          const appSlug = String(input.body?.app ?? '')
          const local = await testRepositories.status(appSlug)
          const server = await client.request(`/api/rig/v1/projects/${encodeURIComponent(appSlug)}/test-versions`).catch(() => ({ versions: [], head: null }))
          let task = null
          if (input.body?.missionId && local.exists) {
            const branch = taskBranch(String(input.body.missionId))
            const head = local.branches.find((entry) => entry.name === branch) ?? null
            task = { branch, commit: head?.commit ?? null, merged: Boolean(head?.merged), cases: head ? await testRepositories.cases(appSlug, head.commit) : [] }
          }
          return { local, server, task }
        }
        case 'repository-ensure': {
          // The repository, the fixed suite that runs it, and a plan pinned to this computer.
          const appSlug = String(input.body?.app ?? '')
          const repository = await testRepositories.ensure(appSlug)
          const { suite } = await client.request(`/api/v1/apps/${encodeURIComponent(appSlug)}/workspace-suite`, {})
          let runner = await localRunner.status()
          if (!runner.registered) runner = await localRunner.register(client, {})
          const { tasks } = await client.request(`/api/v1/tasks?app=${encodeURIComponent(appSlug)}`)
          let plan = tasks.find((task) => task.suiteId === suite.id && task.runnerId === runner.runnerId) ?? null
          if (!plan && input.body?.targetUrl) {
            plan = (
              await client.request('/api/v1/tasks', {
                app: appSlug,
                suite: suite.slug,
                name: `本机测试仓库 · ${runner.name ?? '本机'}`,
                targetUrl: String(input.body.targetUrl),
                runsOn: 'pinned-runner',
                runnerId: runner.runnerId,
                schedule: { kind: 'manual' }
              })
            ).task
          }
          return { repository, suite, plan, runner }
        }
        case 'repository-commit': {
          const appSlug = String(input.body?.app ?? '')
          const missionId = String(input.body?.missionId ?? '')
          if (!/^[a-f0-9-]{36}$/.test(missionId)) throw new RigError('invalid_input', '任务编号无效')
          const { proposal, stale } = await client.request(`/api/rig/v1/missions/${missionId}/implementation`)
          if (!proposal?.reviewedAt || stale) throw new RigError('implementation_not_reviewed', '请先批准当前用例对应的最新实现', 409)
          await testRepositories.ensure(appSlug)
          return testRepositories.commitImplementation(appSlug, { missionId, goal: proposal.summary, implementation: proposal })
        }
        case 'repository-merge':
          return testRepositories.mergeToMain(String(input.body?.app ?? ''), String(input.body?.commit ?? ''))
        case 'repository-publish': {
          const appSlug = String(input.body?.app ?? '')
          const commit = String(input.body?.commit ?? '')
          const base = `/api/rig/v1/projects/${encodeURIComponent(appSlug)}/test-versions`
          const { head } = await client.request(base)
          // The service's history is a line: a new version contains the latest one.
          if (head && !(await testRepositories.contains(appSlug, head.commit, commit)))
            throw new RigError(
              'version_not_on_line',
              (await testRepositories.has(appSlug, head.commit))
                ? `这个提交没有包含服务器最新版本 v${head.version}：先合入本机主线（它已同步到 v${head.version}）再发布`
                : `本机还没有服务器最新版本 v${head.version}：先「同步服务器版本」，合入后再发布`,
              409
            )
          const inspected = await testRepositories.inspect(appSlug, commit, head?.commit ?? null)
          if (inspected.problems.length)
            throw new RigError('publish_policy', `这些内容不能进测试版本：${inspected.problems.slice(0, 6).join('；')}`, 409)
          // Every tenth version is complete, so the service can drop the increments
          // before it. A history too big for one upload stays in increments, which
          // do not overlap: either way the service keeps about one copy of it.
          let checkpoint = !head || (head.version + 1) % 10 === 0
          let bundle = await testRepositories.bundle(appSlug, commit, checkpoint ? null : head.commit)
          if (checkpoint && head && Buffer.byteLength(bundle, 'base64') > PUBLISH_POLICY.uploadBytes) {
            checkpoint = false
            bundle = await testRepositories.bundle(appSlug, commit, head.commit)
          }
          const cases = (await testRepositories.cases(appSlug, commit)).map((entry) => entry.caseId)
          const { version } = await client.request(base, {
            commit,
            parent: head?.commit ?? null,
            branch: String(input.body?.branch ?? 'main'),
            summary: String(input.body?.summary ?? '').slice(0, 500) || `发布 ${commit.slice(0, 7)}`,
            runId: String(input.body?.runId ?? ''),
            cases,
            checkpoint,
            bundle
          })
          await testRepositories.importVersion(appSlug, { version: version.version, commit, bundle })
          return { version }
        }
        case 'repository-pull': {
          const appSlug = String(input.body?.app ?? '')
          const base = `/api/rig/v1/projects/${encodeURIComponent(appSlug)}/test-versions`
          const { versions } = await client.request(base)
          await testRepositories.ensure(appSlug)
          const local = await testRepositories.status(appSlug)
          const pulled = []
          const ascending = [...versions].sort((a, b) => a.version - b.version)
          for (const entry of ascending) {
            if (local.versions.some((tag) => tag.version === entry.version)) continue
            // Merged into a later full version: its commit arrives with that one.
            if (entry.pruned) continue
            const { bundle } = await client.request(`${base}/${entry.version}/bundle`)
            pulled.push(await testRepositories.importVersion(appSlug, { version: entry.version, commit: entry.commit, bundle }))
          }
          for (const entry of ascending.filter((row) => row.pruned)) await testRepositories.tagVersion(appSlug, entry.version, entry.commit)
          return { pulled, local: await testRepositories.status(appSlug) }
        }
        case 'repository-open': {
          const { shell } = await import('electron')
          const failed = await shell.openPath(testRepositories.path(String(input.body?.app ?? '')))
          if (failed) throw new RigError('open_failed', failed)
          return { ok: true }
        }
        // Rig's own proving ground (docs/24 M8b): a practice app, started here on request.
        case 'proving-ground-status':
          return provingGroundStatus()
        case 'proving-ground-start':
          return provingGroundStart()
        case 'runner-status':
          return localRunner.status()
        case 'runner-register':
          return localRunner.register(client, {
            name: String(input.body?.name ?? '').trim()
          })
        case 'runner-start':
          return localRunner.start()
        case 'runner-stop':
          return localRunner.stop()
        case 'runner-remove':
          return localRunner.remove(client)
        // This computer on duty as a station for procedure regression.
        case 'station-status':
          return station.status()
        case 'station-register':
          return station.register(client, { name: String(input.body?.name ?? '').trim() })
        case 'station-start':
          return station.start()
        case 'station-stop':
          return station.stop()
        case 'station-remove':
          return station.remove(client)
        // Regression set-up: the service schedules, stations replay.
        case 'procedure-tasks':
          return client.request('/api/rig/v1/procedure-tasks')
        case 'procedure-task-create':
          return client.request('/api/rig/v1/procedure-tasks', {
            app: input.body?.app,
            name: input.body?.name,
            cronExpr: input.body?.cronExpr ?? null,
            runsOn: input.body?.runsOn
          })
        case 'procedure-task-run':
          return client.request(
            `/api/rig/v1/procedure-tasks/${String(input.body?.id ?? '').replace(/[^A-Za-z0-9_-]/g, '')}:run`,
            {}
          )
        // One app's case catalogue; the renderer names the app, never a path.
        case 'electron-apps':
          return { apps: await loadElectronApps(), platform: process.platform }
        // The System Settings pane where a person grants what macOS asks for;
        // only these two, by name — the renderer cannot open anything else.
        case 'open-privacy': {
          const pane = { accessibility: 'Privacy_Accessibility', automation: 'Privacy_Automation' }[input.body?.pane]
          if (process.platform !== 'darwin' || !pane) throw new RigError('invalid_input', '只能打开 macOS 的辅助功能或自动化设置')
          const { shell } = await import('electron')
          await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
          return { ok: true }
        }
        case 'native-probe':
          // A person pressed the button: macOS may now ask them for consent.
          return rpc('native-probe', {})
        case 'electron-app-add': {
          if (input.body?.kind === 'native') return { apps: await addNativeApp() }
          // The person picks the file themselves; the renderer never names a path.
          const picked = await dialog.showOpenDialog(window, {
            title: '选择要交给 Agent 测试的 Electron 应用',
            properties: ['openFile', ...(process.platform === 'darwin' ? ['openDirectory'] : [])],
            filters:
              process.platform === 'win32' ? [{ name: '应用程序', extensions: ['exe'] }] : undefined
          })
          if (picked.canceled || !picked.filePaths[0]) return { apps: await loadElectronApps() }
          const path = await executableOf(picked.filePaths[0])
          const name = basename(picked.filePaths[0], extname(picked.filePaths[0]))
          const id =
            name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 40) || `app-${randomUUID().slice(0, 6)}`
          const apps = (await loadElectronApps()).filter((entry) => entry.id !== id)
          return { apps: await saveElectronApps([...apps, { id, name, path }]) }
        }
        case 'electron-app-remove': {
          const id = String(input.body?.id ?? '')
          return {
            apps: await saveElectronApps(
              (await loadElectronApps()).filter((entry) => entry.id !== id)
            )
          }
        }
        case 'admin-config':
          return client.request('/api/rig/v1/admin/config')
        case 'save-config':
          return client.request('/api/rig/v1/admin/config', input.body)
        case 'probe':
          return client.request('/api/rig/v1/admin/providers:probe', input.body)
        case 'preview-orchestration':
          return client.request('/api/rig/v1/admin/orchestrations:preview', input.body)
        case 'activate-egress':
          return client.request('/api/rig/v1/admin/egress:activate', input.body)
        case 'plan-dispatch':
          // The surface is added here, not by the renderer: it decides whether
          // desktop-only Agents are proposed at all.
          return client.request('/api/rig/v1/dispatch:plan', {
            text: String(input.body?.text ?? ''),
            surface: 'desktop'
          })
        case 'draft-flight-plan':
          // Drafted on the service (it holds the catalogue and the model); the
          // desktop says so, so exploration stages can be proposed.
          return client.request('/api/rig/v1/flight-plans:draft', {
            text: String(input.body?.text ?? ''),
            surface: 'desktop'
          })
        case 'system-signal':
          return client.request('/api/rig/v1/system/signal', input.body)
        case 'system-claim':
          return client.request('/api/rig/v1/system/claim', input.body)
        case 'system-seen':
          return client.request('/api/rig/v1/system/seen', input.body)
        case 'orchestration-graph':
          return client.request(
            `/api/rig/v1/graph?orchestration=${encodeURIComponent(String(input.body?.key ?? ''))}`
          )
        case 'insights': {
          const days = Number(input.body?.window) || 14
          return client.request(`/api/rig/v1/insights?window=${encodeURIComponent(days)}`)
        }
        // A run's report as a PDF file (docs/21 M4); the member picks where.
        case 'report-save': {
          const path = String(input.body?.path || '')
          if (!REPORT_PATH.test(path.split('?')[0])) throw new RigError('invalid_path', '只能保存执行报告')
          const { saveReport } = await import('./report-window.mjs')
          return saveReport({ origin: new URL(client.url).origin, path, token: () => client.token, parent: window, dialog })
        }
        case 'open-path': {
          const path = String(input.body?.path || '')
          if (!REPORT_PATH.test(path.split('?')[0])) throw new RigError('invalid_path', '桌面端只在应用内打开执行报告')
          const { openReport } = await import('./report-window.mjs')
          await openReport({ origin: new URL(client.url).origin, path, token: () => client.token, parent: window })
          return { ok: true }
        }
        case 'artifact': {
          const { shell } = await import('electron')
          await shell.openPath(artifactPath(input.body?.path))
          return { ok: true }
        }
        // A mission's screenshot for the activity view and the replay player.
        case 'artifact-image': {
          const bytes = await readFile(artifactPath(input.body?.path))
          return { src: `data:image/png;base64,${bytes.toString('base64')}` }
        }
        // One HTML file that plays the mission's browser steps back.
        case 'replay-export': {
          const { missions } = await rpc('list')
          const row = missions.find((entry) => entry.id === input.body?.id)
          if (!row) throw new RigError('not_found', '任务不存在', 404)
          const { html, frames } = await replayDocument(row, {
            readImage: (path) => readFile(artifactPath(path))
          })
          if (!frames) throw new RigError('invalid_input', '这项任务没有浏览器步骤可以回放')
          const saved = await dialog.showSaveDialog(window, {
            title: '导出回放',
            defaultPath: `mx-rig-回放-${row.id.slice(0, 8)}.html`,
            filters: [{ name: 'HTML', extensions: ['html'] }]
          })
          if (saved.canceled || !saved.filePath) return { saved: false }
          await writeFile(saved.filePath, html)
          return { saved: true, path: saved.filePath, frames }
        }
        default: {
          if (Object.hasOwn(READ_ACTIONS, input.action))
            return client.request(READ_ACTIONS[input.action])
          // Project and administration actions: the same table the browser
          // uses (apps/web/routes.js), sent with this process's token. A
          // one-time password in an answer goes to the page that asked, once.
          let routed
          try {
            routed = routeAction(input.action, input.body)
          } catch (error) {
            throw new RigError('invalid_input', error.message)
          }
          if (routed) return client.send(routed.method, routed.path, routed.body)
          throw new RigError('invalid_action', '未知动作')
        }
      }
    })
    const launcher = await launcherSettings()
    if (launcher) {
      const version = await appVersion()
      network = await LauncherNetwork.open({
        dir: app.getPath('userData'),
        sdk: await import('@qpjoy/electron-launcher'),
        safeStorage,
        config: launcher,
        appVersion: version,
        onChange: (snapshot) => {
          if (window && !window.isDestroyed()) window.webContents.send('mx-rig:network', snapshot)
          updates?.networkChanged(snapshot)
          oversea?.networkChanged(snapshot)
        }
      })
      oversea = await LauncherOversea.open({
        dir: app.getPath('userData'),
        network,
        sdk: await import('@qpjoy/electron-launcher'),
        compiler: await import('@qpjoy/electron-core-mihomo'),
        engine: () =>
          prepareEngine({
            shipped: shippedEngine({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
            cacheDir: join(app.getPath('userData'), 'mihomo-engine')
          }),
        onChange: (snapshot) => {
          if (window && !window.isDestroyed()) window.webContents.send('mx-rig:oversea', snapshot)
          syncLocalEgress()
        }
      })
      updates = new LauncherUpdates({
        sdk: await import('@qpjoy/electron-launcher/application-updater'),
        network,
        baseDir: app.getPath('userData'),
        appVersion: version,
        distribution: launcher.distribution,
        openInstaller: async (filePath) => {
          const message = await shell.openPath(filePath)
          if (message) throw new Error(`无法打开安装程序：${message}`)
        },
        // The installer is open: stop what this app started, as on quit, then
        // leave (app.exit skips before-quit, so it is done here).
        cleanup: async () => {
          quitting = true
          await stopEverything()
        },
        exit: (code) => app.exit(code),
        onChange: (state) => {
          if (window && !window.isDestroyed()) window.webContents.send('mx-rig:update', state)
        },
        // The raw reason stays in this process's log.
        log: (state) => console.info(`[mx-rig update] ${state.phase}${state.reason ? `: ${state.reason}` : ''}`)
      })
    }
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 920,
      minHeight: 680,
      title: 'MX Rig',
      backgroundColor: '#0b1018',
      webPreferences: {
        preload: join(root, 'apps/desktop/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_wc, _p, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    await window.loadFile(ui)
    // Unsigned on macOS: offer to move into Applications and clear the
    // quarantine flag, through the system's own prompt when needed.
    await firstRun({ app, dialog, window }).catch(() => false)
    // Connected before: the system service is installed, so reconnecting asks
    // for nothing. The first time waits for 连接内网 on the login page.
    if (network?.snapshot().connectedOnce) void network.connect()
  })
  .catch((error) => {
    dialog.showErrorBox('MX Rig 启动失败', error.message)
    app.quit()
  })
app.on('window-all-closed', () => app.quit())
// Everything this app started, stopped: on quit, and before an installer
// takes over.
function stopEverything() {
  // The tunnel lives as long as the app: it stops with it (at most 15 s).
  const tunnel = network ? Promise.race([network.disconnect('shutdown'), new Promise((resolve) => setTimeout(resolve, 15_000))]) : null
  return Promise.allSettled([stopWorker(), localRunner?.stop(10_000), station?.stop(10_000), provingGround?.close(), oversea?.shutdown(), tunnel])
}
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  stopEverything().finally(() => app.quit())
})
