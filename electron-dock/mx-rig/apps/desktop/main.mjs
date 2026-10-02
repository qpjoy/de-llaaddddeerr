import { app, BrowserWindow, clipboard, ipcMain, dialog } from 'electron'
import { execFile, fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { RigClient } from '../../packages/runtime/client.mjs'
import { RigError, serviceUrl } from '../../packages/contracts/index.mjs'
import { syncDesignAssets } from '../../scripts/design-assets.mjs'
import { LocalRunner, localStation } from './local-runner.mjs'
import { replayDocument } from '../../packages/runtime/replay.mjs'
import { firstRun } from './first-run.mjs'
import { existsSync } from 'node:fs'

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
  runners: '/api/v1/runners',
  hooks: '/api/rig/v1/hooks'
}

// Pages the desktop will hand to the system browser. That session logs in
// separately; nothing from this process's credentials travels with it.
const EXTERNAL_PATHS = [/^\/test-center\/$/, /^\/api\/v1\/runs\/[A-Za-z0-9_-]{1,80}\/report$/]

const root = fileURLToPath(new URL('../../', import.meta.url))
const ui = fileURLToPath(new URL('../web/index.html', import.meta.url))
let window,
  client,
  worker,
  member,
  localRunner = null,
  station = null,
  quitting = false,
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

async function loginDefaults() {
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

async function login(input) {
  await stopWorker()
  await Promise.allSettled([localRunner?.stop(), station?.stop()])
  localRunner = null
  station = null
  client = null
  member = null
  const privateHttp = input.privateHttp === true || process.env.MX_RIG_ALLOW_PRIVATE_HTTP === '1'
  const url = serviceUrl(input.url || process.env.MX_RIG_SERVER_URL || 'http://127.0.0.1:8791', {
    privateHttp
  })
  const next = new RigClient({ url, token: '', privateHttp })
  const result = await next.request('/api/rig/v1/native-login', {
    account: input.account,
    password: input.password
  })
  next.token = result.token
  const { principal } = await next.request('/api/rig/v1/me')
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
    token: result.token,
    owner: principal.id,
    root: join(app.getPath('userData'), 'workspaces', workspace),
    electronApps: await loadElectronApps(),
    privateHttp
  })
  client = next
  member = principal
  await rememberLogin({ server: url, privateHttp, account: input.account }).catch(() => {})
  // This computer as a runner for this member on this service. Its token
  // lives next to the member's workspace, never in the renderer.
  localRunner = new LocalRunner({
    dir: join(app.getPath('userData'), 'workspaces', workspace, 'runner'),
    script: join(root, 'packages/test-platform/bin/mxt-runner.mjs'),
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
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
app
  .whenReady()
  .then(async () => {
    // A packaged build already carries the copy; in a source checkout this
    // picks up whatever version of the design system is installed.
    // Only from source: inside a packaged app the folder is part of the
    // read-only app.asar (writing there failed every packaged launch).
    if (!app.isPackaged) await syncDesignAssets()
    ipcMain.handle('mx-rig:request', async (event, input) => {
      trusted(event)
      if (!input || typeof input.action !== 'string')
        throw new RigError('invalid_request', '请求无效')
      if (input.action === 'login') return login(input.body || {})
      if (input.action === 'login-defaults') return loginDefaults()
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
          await ending.request('/api/rig/v1/logout', {}).catch(() => {})
          client = null
          member = null
          return { ok: true }
        }
        case 'change-password':
          return client.request('/api/v1/auth/password', {
            current: String(input.body?.current ?? ''),
            next: String(input.body?.next ?? '')
          })
        case 'missions':
          return rpc('list')
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
        case 'app-cases': {
          const app = String(input.body?.app ?? '')
          if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) throw new RigError('invalid_input', '应用标识无效')
          return client.request(`/api/v1/apps/${app}/cases`)
        }
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
        case 'test-center':
        case 'open-path': {
          const path = input.action === 'test-center' ? '/test-center/' : input.body?.path || ''
          if (!EXTERNAL_PATHS.some((pattern) => pattern.test(path)))
            throw new RigError('invalid_path', '不允许在外部浏览器打开该地址')
          const { shell } = await import('electron')
          await shell.openExternal(client.url + path)
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
        default:
          if (Object.hasOwn(READ_ACTIONS, input.action))
            return client.request(READ_ACTIONS[input.action])
          throw new RigError('invalid_action', '未知动作')
      }
    })
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
  })
  .catch((error) => {
    dialog.showErrorBox('MX Rig 启动失败', error.message)
    app.quit()
  })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  Promise.allSettled([stopWorker(), localRunner?.stop(10_000), station?.stop(10_000)]).finally(() =>
    app.quit()
  )
})
