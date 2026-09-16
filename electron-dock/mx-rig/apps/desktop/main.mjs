import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { RigClient } from '../../packages/runtime/client.mjs'
import { RigError, serviceUrl } from '../../packages/contracts/index.mjs'
import { syncDesignAssets } from '../../scripts/design-assets.mjs'

// Read actions the workbench may forward. An explicit table means the renderer
// can never name an arbitrary path, and the desktop and web surfaces cannot
// drift into offering different data.
const READ_ACTIONS = {
  config: '/api/rig/v1/config',
  tools: '/api/rig/v1/tools',
  graph: '/api/rig/v1/graph',
  egress: '/api/rig/v1/egress',
  tasks: '/api/v1/tasks',
  runs: '/api/v1/runs?limit=20',
  apps: '/api/v1/apps',
  runners: '/api/v1/runners'
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

function rpc(method, input = {}) {
  if (!worker?.connected)
    return Promise.reject(new RigError('runtime_offline', '本地 Runtime 不可用，请重新登录'))
  return new Promise((yes, no) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      no(new RigError('timeout', 'Runtime 请求超时'))
    }, 15_000)
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
async function login(input) {
  await stopWorker()
  client = null
  member = null
  const url = serviceUrl(input.url || process.env.MX_RIG_SERVER_URL || 'http://127.0.0.1:8791')
  const next = new RigClient({ url, token: '' })
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
      /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|SYSTEMDRIVE|LANG|LC_ALL|DISPLAY|XAUTHORITY|PLAYWRIGHT_BROWSERS_PATH)$/i.test(
        name
      )
    )
  )
  worker = fork(join(root, 'packages/runtime/worker.mjs'), [], {
    env: { ...workerEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  })
  worker.on('message', (message) => {
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
    root: join(app.getPath('userData'), 'workspaces', workspace)
  })
  client = next
  member = principal
  return { member: principal }
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
    await syncDesignAssets()
    ipcMain.handle('mx-rig:request', async (event, input) => {
      trusted(event)
      if (!input || typeof input.action !== 'string')
        throw new RigError('invalid_request', '请求无效')
      if (input.action === 'login') return login(input.body || {})
      if (input.action === 'me') return { principal: member }
      if (!client) throw new RigError('login_required', '请先登录')
      switch (input.action) {
        case 'logout':
          await stopWorker()
          client = null
          member = null
          return { ok: true }
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
        case 'admin-config':
          return client.request('/api/rig/v1/admin/config')
        case 'save-config':
          return client.request('/api/rig/v1/admin/config', input.body)
        case 'probe':
          return client.request('/api/rig/v1/admin/providers:probe', input.body)
        case 'preview-orchestration':
          return client.request('/api/rig/v1/admin/orchestrations:preview', input.body)
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
          if (!/^[a-f0-9-]{36}\/\d+\.png$/.test(input.body?.path || ''))
            throw new RigError('invalid_artifact', '产物路径无效')
          const workspace = createHash('sha256')
            .update(`${client.url}\n${member.id}`)
            .digest('hex')
            .slice(0, 32)
          const path = join(
            app.getPath('userData'),
            'workspaces',
            workspace,
            'artifacts',
            input.body.path
          )
          const { shell } = await import('electron')
          await shell.openPath(path)
          return { ok: true }
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
  stopWorker().finally(() => app.quit())
})
