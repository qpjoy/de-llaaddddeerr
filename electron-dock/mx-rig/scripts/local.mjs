// 本机一键体验：`bash scripts/manage.sh local <命令>`（macOS、Linux、Windows 的 Git Bash）。
//
//   init     装依赖、生成或询问配置、准备测试浏览器，然后启动
//   up       在后台启动服务（没有初始化过就先初始化）
//   desktop  打开桌面端，登录页已经填好本机服务地址
//   status   服务、模型、测试浏览器现在的状态
//   logs     服务日志（-f 持续跟随）
//   token    管理员密码（账号 admin）
//   down     停止服务
//   reset    停止并清空本机数据（保留配置）
//
// 选项：--yes 全部用默认值、不提问；--lan 允许局域网访问；--port <端口>；
//       --no-start（init 后不启动）；--no-browser（不准备测试浏览器）。
//
// Everything lives under .runtime/local: the answers in local.env (0600), the
// service's state, its log and pid. Values already in the environment win, so
// `MX_RIG_MODEL_API_KEY=… bash scripts/manage.sh local init --yes` needs no
// typing at all. Nothing here touches a system setting, another product's
// port or MX-H2I.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync, readFileSync, statSync, watch } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { BrowserProvision, installChromium, playwrightCache, progressLine } from '../packages/runtime/browser-provision.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const home = resolve(process.env.MX_RIG_LOCAL_HOME || resolve(root, '.runtime/local'))
const ENV_FILE = join(home, 'local.env')
const PID_FILE = join(home, 'server.pid')
const LOG_FILE = join(home, 'server.log')
const require = createRequire(import.meta.url)
const windows = process.platform === 'win32'

const argv = process.argv.slice(2)
const command = argv.find((arg) => !arg.startsWith('-')) ?? 'help'
const flag = (name) => argv.includes(`--${name}`)
const option = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const assumeYes = flag('yes') || process.env.CI === 'true' || process.env.MX_RIG_LOCAL_YES === '1'

const say = (message = '') => console.log(message ? `[mx-rig] ${message}` : '')
const warn = (message) => console.error(`[mx-rig] 注意：${message}`)
function die(message) {
  console.error(`[mx-rig] 错误：${message}`)
  process.exit(1)
}

// -- the answers --------------------------------------------------------------------

/** KEY=VALUE lines; a value is never quoted, so it must stay on one line. */
async function readEnv() {
  try {
    const lines = (await readFile(ENV_FILE, 'utf8')).split(/\r?\n/)
    return Object.fromEntries(
      lines
        .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim()))
        .filter(Boolean)
        .map((match) => [match[1], match[2]])
    )
  } catch {
    return null
  }
}

async function writeEnv(values) {
  await mkdir(home, { recursive: true })
  const body = [
    '# MX Rig 本机体验的配置：bash scripts/manage.sh local init 写入。',
    '# 含管理员密码和模型密钥，只给自己看；改完运行 local down 再 local up 生效。',
    ...Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, '')}`),
    ''
  ].join('\n')
  await writeFile(ENV_FILE, body, { mode: 0o600 })
  await chmod(ENV_FILE, 0o600).catch(() => {})
}

// -- asking -----------------------------------------------------------------------------

let stdinEnded = false
let rl = null
let lines = null
let muted = false

/**
 * One reader for the whole session: lines typed (or piped) ahead of a
 * question wait for it instead of being dropped, which a reader per question
 * would do.
 */
function readLine(prompt, { secret = false } = {}) {
  if (assumeYes || stdinEnded) return Promise.resolve(null)
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    // What is typed for a secret is not echoed.
    const write = rl._writeToOutput?.bind(rl)
    if (write) rl._writeToOutput = (text) => (muted ? undefined : write(text))
    lines = rl[Symbol.asyncIterator]()
  }
  rl.setPrompt(prompt)
  rl.prompt()
  muted = secret
  return lines.next().then(({ value, done }) => {
    muted = false
    if (secret && process.stdin.isTTY) process.stdout.write('\n')
    if (done) {
      stdinEnded = true
      process.stdout.write('\n')
      return null
    }
    return value
  })
}

/**
 * One line from the person; with --yes, or with no one there, the default.
 * The question goes on a line of its own and the prompt stays short: a
 * prompt wider than the terminal is redrawn on every keystroke, one copy per
 * key.
 */
async function ask(question, fallback = '') {
  if (assumeYes || stdinEnded) return fallback
  const hint = fallback ? `回车用默认值：${fallback}` : '可以留空'
  console.log(`  ${question}（${hint}）`)
  const text = String((await readLine('  › ')) ?? '').trim()
  return text || fallback
}

async function confirm(question, fallback = true) {
  const answer = await ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]`, fallback ? 'y' : 'n')
  return /^y(es)?$|^是$/i.test(answer.trim())
}

/**
 * A secret, not echoed. A terminal Node does not see as one (Git Bash's
 * mintty without winpty) still works, but shows what is typed — said first.
 */
async function askSecret(question) {
  if (assumeYes || stdinEnded) return ''
  if (!process.stdin.isTTY) warn('这个终端不能隐藏输入，输入的内容会显示出来')
  console.log(`  ${question}（输入时不显示，可以留空）`)
  return String((await readLine('  › ', { secret: true })) ?? '').trim()
}

// -- facts about this machine --------------------------------------------------------------

function portFree(port, host) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

async function firstFreePort(from, host) {
  for (let port = from; port < from + 20; port += 1) if (await portFree(port, host)) return port
  return from
}

/** This machine's address on the local network, for others to reach it. */
function lanAddress() {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))
        return entry.address
  return null
}

function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function runningPid() {
  try {
    const pid = Number((await readFile(PID_FILE, 'utf8')).trim())
    return alive(pid) ? pid : null
  } catch {
    return null
  }
}

async function healthy(url) {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

/** npm the way this platform runs it: a .cmd on Windows needs a shell. */
function npm(args, env = process.env) {
  return spawnSync(windows ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', env, shell: windows })
}

// -- the service's environment ------------------------------------------------------------

function serviceEnv(values) {
  const port = values.MX_RIG_PORT || '8791'
  const loopback = `http://127.0.0.1:${port}`
  return {
    ...process.env,
    ...values,
    MX_RIG_STORE: values.MX_RIG_DATABASE_URL ? 'postgres' : 'memory',
    MX_RIG_STATE_DIR: join(home, 'control'),
    MX_RIG_ARTIFACTS_DIR: join(home, 'artifacts'),
    MX_RIG_SELF_URL: loopback,
    MX_RIG_PUBLIC_URL: values.MX_RIG_PUBLIC_URL || loopback,
    // Plain HTTP on this machine or this network: the session cookie must not
    // demand HTTPS, or the browser drops it.
    MX_RIG_INSECURE_COOKIES: 'true',
    NODE_ENV: 'development'
  }
}

const publicUrl = (values) => values.MX_RIG_PUBLIC_URL || `http://127.0.0.1:${values.MX_RIG_PORT || '8791'}`
const localUrl = (values) => `http://127.0.0.1:${values.MX_RIG_PORT || '8791'}`

// -- commands --------------------------------------------------------------------------------

async function init() {
  say('MX Rig 本机体验：初始化')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) die(`需要 Node.js 22 或更新的版本，现在是 ${process.version}（https://nodejs.org）`)

  // 1. Dependencies. Electron's own download comes from GitHub; when that is
  // out of reach, the npmmirror copy is tried once.
  if (!existsSync(join(root, 'node_modules/.package-lock.json')) || flag('install')) {
    say('安装依赖（npm install）…')
    if (npm(['install']).status !== 0) {
      warn('npm install 没有成功，改用 npmmirror 下载 Electron 再试一次')
      const retry = npm(['install'], {
        ...process.env,
        ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
      })
      if (retry.status !== 0) die('依赖没有装好；请检查网络或 npm 源后重试 bash scripts/manage.sh local init')
    }
  } else say('依赖已安装')

  // 2. Answers: what can be generated is, the rest is asked once.
  const before = (await readEnv()) ?? {}
  const pick = (key) => process.env[key] || before[key] || ''
  const values = { ...before }
  say(before.MX_RIG_ADMIN_TOKEN ? '读取已有的配置，回车保留原值' : '生成配置（回车用默认值）')

  const lan = flag('lan') || (before.MX_RIG_HOST ? before.MX_RIG_HOST === '0.0.0.0' : await confirm('让局域网里的同事也能访问这台电脑上的服务？', false))
  const host = lan ? '0.0.0.0' : '127.0.0.1'
  const suggested = option('port') || pick('MX_RIG_PORT') || String(await firstFreePort(8791, host))
  let port = Number(await ask('服务端口', suggested))
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`端口无效：${port}`)
  if (!(await runningPid()) && !(await portFree(port, host))) {
    const free = await firstFreePort(port + 1, host)
    warn(`端口 ${port} 已被占用，改用 ${free}`)
    port = free
  }
  values.MX_RIG_PORT = String(port)
  values.MX_RIG_HOST = host
  const address = lan ? lanAddress() : null
  if (lan && !address) warn('没有找到这台电脑的局域网地址，先按本机地址配置')
  values.MX_RIG_PUBLIC_URL = `http://${address ?? '127.0.0.1'}:${port}`

  values.MX_RIG_ADMIN_TOKEN = pick('MX_RIG_ADMIN_TOKEN') || randomBytes(24).toString('base64url')
  values.MX_RIG_SECRET_KEY = pick('MX_RIG_SECRET_KEY') || randomBytes(32).toString('hex')
  if (!before.MX_RIG_ADMIN_TOKEN) say('已生成管理员密码（账号 admin），之后用 local token 查看')

  values.MX_RIG_DATABASE_URL =
    process.env.MX_RIG_DATABASE_URL ||
    (await ask('PostgreSQL 连接串（留空用内存模式：重启服务后，测试中心的应用、计划和成员会清空）', before.MX_RIG_DATABASE_URL || ''))

  say('模型（Agent 用；不配也能启动，Agent 任务会显示「受阻」）')
  values.MX_RIG_LOCAL_MODEL_BASE_URL = await ask(
    'OpenAI 兼容接口地址，带版本路径：DeepSeek 是 https://api.deepseek.com/v1，百度千帆是 https://qianfan.baidubce.com/v2',
    pick('MX_RIG_LOCAL_MODEL_BASE_URL')
  )
  if (values.MX_RIG_LOCAL_MODEL_BASE_URL) {
    if (!/^https?:\/\/[^\s]+$/.test(values.MX_RIG_LOCAL_MODEL_BASE_URL)) die(`接口地址无效：${values.MX_RIG_LOCAL_MODEL_BASE_URL}`)
    values.MX_RIG_LOCAL_MODEL_NAME = await ask('模型名称，例如 deepseek-chat', pick('MX_RIG_LOCAL_MODEL_NAME'))
    const key = process.env.MX_RIG_MODEL_API_KEY || (await askSecret(before.MX_RIG_MODEL_API_KEY ? 'API Key（回车保留原来的）' : 'API Key'))
    values.MX_RIG_MODEL_API_KEY = key || before.MX_RIG_MODEL_API_KEY || ''
    if (!values.MX_RIG_MODEL_API_KEY) warn('没有填 API Key：模型会连不上，可以之后重新运行 local init 补上')
  }
  await writeEnv(values)
  say(`配置已写入 ${ENV_FILE.replace(root, '')}（只有你能读）`)

  // 3. Migrations, when there is a database.
  if (values.MX_RIG_DATABASE_URL) {
    say('迁移数据库…')
    const migrated = spawnSync(process.execPath, [join(root, 'apps/server/migrate.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: serviceEnv(values)
    })
    if (migrated.status !== 0) die('数据库迁移没有成功；检查连接串，或者留空改用内存模式')
  }

  // 4. The test browser: whatever this machine has, or fetched once.
  if (!flag('no-browser')) await prepareBrowser()

  // 5. The design system copy the workbench is served with.
  spawnSync(process.execPath, [join(root, 'scripts/design-assets.mjs')], { cwd: root, stdio: 'inherit' })

  say('初始化完成')
  // A service started with the old answers would keep them.
  if (await runningPid()) {
    say('用新的配置重启服务')
    await down({ quiet: true })
  }
  if (flag('no-start')) return say('启动：bash scripts/manage.sh local up')
  await up({ fresh: true })
}

async function prepareBrowser() {
  const provision = new BrowserProvision({ dir: playwrightCache() })
  const found = provision.find()
  if (found) return say(`测试浏览器：${found.title}`)
  say('准备测试浏览器（第一次需要下载约 170 MB）…')
  const seen = { step: -1 }
  try {
    await installChromium({
      dir: playwrightCache(),
      onProgress: (event) => {
        const line = progressLine({ phase: 'downloading', ...event }, seen)
        if (line) say(line)
      }
    })
    say('测试浏览器已就绪')
  } catch (error) {
    warn(`${error.message}。装了 Google Chrome 的话 MX Rig 会直接用它；也可以之后运行 npm run browser:install 重试`)
  }
}

async function up({ fresh = false } = {}) {
  let values = await readEnv()
  if (!values) {
    say('还没有初始化，先初始化')
    return init()
  }
  const url = localUrl(values)
  const pid = await runningPid()
  if (pid && (await healthy(url))) {
    if (!fresh) say(`服务已经在运行（进程 ${pid}）`)
    return announce(values)
  }
  if (!(await portFree(Number(values.MX_RIG_PORT), values.MX_RIG_HOST || '127.0.0.1')))
    die(`端口 ${values.MX_RIG_PORT} 被别的程序占用了；运行 bash scripts/manage.sh local init --port <新端口>`)
  await mkdir(home, { recursive: true })
  const log = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [join(root, 'apps/server/index.mjs')], {
    cwd: root,
    env: serviceEnv(values),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true
  })
  child.unref()
  await writeFile(PID_FILE, String(child.pid))
  say(`启动服务（进程 ${child.pid}，日志 ${LOG_FILE.replace(root, '')}）…`)
  for (let waited = 0; waited < 60; waited += 1) {
    if (await healthy(url)) break
    if (!alive(child.pid)) {
      console.error(tail(30))
      die('服务没有启动起来，上面是日志的最后几行')
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  if (!(await healthy(url))) die(`服务 60 秒内没有就绪，看日志：bash scripts/manage.sh local logs`)
  await applyModel(values).catch((error) => warn(`模型配置没有写进去：${error.message}`))
  values = await readEnv()
  announce(values)
}

/**
 * The model answered in init, written into the service's own settings the
 * way the settings page would — only when it is not already there.
 */
async function applyModel(values) {
  const baseUrl = values.MX_RIG_LOCAL_MODEL_BASE_URL
  const model = values.MX_RIG_LOCAL_MODEL_NAME
  if (!baseUrl || !model) return
  const url = localUrl(values)
  const headers = { authorization: `Bearer ${values.MX_RIG_ADMIN_TOKEN}`, 'content-type': 'application/json' }
  const current = await (await fetch(`${url}/api/rig/v1/admin/config`, { headers })).json()
  const head = current.providers?.[0]
  if (head?.baseUrl === baseUrl && head?.model === model && head?.apiKeyEnv === 'MX_RIG_MODEL_API_KEY') return
  const provider = {
    id: 'local',
    displayName: '本机配置的模型',
    baseUrl,
    model,
    apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
    timeoutMs: 60_000,
    enabled: true,
    stream: true
  }
  const providers = [provider, ...(current.providers ?? []).filter((entry) => entry.id !== 'local' && entry.baseUrl)]
  const response = await fetch(`${url}/api/rig/v1/admin/config`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      revision: current.revision,
      maxTurns: current.maxTurns,
      allowedTools: current.allowedTools,
      browserOrigins: current.browserOrigins,
      providers,
      sequence: providers.map((entry) => entry.id),
      agents: current.agents
    })
  })
  if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error?.message ?? `HTTP ${response.status}`)
  say(`模型已配置：${model}（${new URL(baseUrl).host}）`)
  await checkModel(values)
}

/** The settings page's 连通性检查: GET /models with the key, no tokens spent. */
async function checkModel(values) {
  try {
    const response = await fetch(`${localUrl(values)}/api/rig/v1/admin/providers:probe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${values.MX_RIG_ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'local' }),
      signal: AbortSignal.timeout(20_000)
    })
    const { probe } = await response.json()
    if (probe?.ok) say(`模型连通性：可达，密钥被接受（${probe.latencyMs} ms）；模型名在第一个 Agent 任务里才会真正用到`)
    else warn(`模型连通性检查没有通过：${probe?.note ?? `HTTP ${response.status}`}`)
  } catch (error) {
    warn(`模型连通性检查没有完成：${error.message}`)
  }
}

function announce(values) {
  say()
  say(`网页工作台：${publicUrl(values)}/rig/`)
  say(`账号 admin，密码：bash scripts/manage.sh local token`)
  say(`桌面端：bash scripts/manage.sh local desktop`)
  if (values.MX_RIG_HOST === '0.0.0.0')
    say(`同事的桌面端填 ${publicUrl(values)}，并勾选「内网测试服务器」`)
  if (!values.MX_RIG_DATABASE_URL) say('内存模式：停止服务后，测试中心的应用、计划和成员会清空（任务记录和配置保留）')
}

async function down({ quiet = false } = {}) {
  const pid = await runningPid()
  if (!pid) {
    if (!quiet) say('服务没有在运行')
    await rm(PID_FILE, { force: true })
    return
  }
  try {
    process.kill(pid, windows ? undefined : 'SIGTERM')
  } catch {
    /* Gone meanwhile. */
  }
  for (let waited = 0; waited < 20 && alive(pid); waited += 1) await new Promise((resolve) => setTimeout(resolve, 250))
  if (alive(pid)) process.kill(pid, 'SIGKILL')
  await rm(PID_FILE, { force: true })
  if (!quiet) say(`服务已停止（进程 ${pid}）`)
}

async function status() {
  const values = await readEnv()
  if (!values) return say('还没有初始化：bash scripts/manage.sh local init')
  const pid = await runningPid()
  const url = localUrl(values)
  const up = pid && (await healthy(url))
  say(`服务：${up ? `运行中（进程 ${pid}）${publicUrl(values)}/rig/` : '没有运行'}`)
  if (up) {
    try {
      const config = await (
        await fetch(`${url}/api/rig/v1/config`, { headers: { authorization: `Bearer ${values.MX_RIG_ADMIN_TOKEN}` } })
      ).json()
      say(`模型：${config.model?.configured ? `${config.model.name}` : '没有配置（Agent 任务会受阻）'}`)
      if (config.model?.configured && values.MX_RIG_LOCAL_MODEL_BASE_URL) await checkModel(values)
      say(`浏览器测试：${config.policy?.allowedTools?.includes('browser_open') ? '已开启' : '没有开启'}`)
    } catch {
      /* The service answered health, not config: said by omission. */
    }
  }
  const found = new BrowserProvision({ dir: playwrightCache() }).find()
  say(`测试浏览器：${found ? found.title : '没有（运行 npm run browser:install，或者安装 Google Chrome）'}`)
  say(`存储：${values.MX_RIG_DATABASE_URL ? 'PostgreSQL' : '内存模式'}`)
}

function tail(lines = 80) {
  try {
    return readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '（还没有日志）'
  }
}

async function logs() {
  console.log(tail(flag('all') ? 100_000 : 80))
  if (!flag('f') && !argv.includes('-f')) return
  let offset = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0
  watch(LOG_FILE, () => {
    const size = statSync(LOG_FILE).size
    if (size < offset) offset = 0
    if (size === offset) return
    process.stdout.write(readFileSync(LOG_FILE).subarray(offset, size).toString('utf8'))
    offset = size
  })
  await new Promise(() => {})
}

async function token() {
  const values = await readEnv()
  if (!values) die('还没有初始化：bash scripts/manage.sh local init')
  console.log(values.MX_RIG_ADMIN_TOKEN)
}

async function desktop() {
  let values = await readEnv()
  if (!values || !(await runningPid())) {
    await up()
    values = await readEnv()
  }
  spawnSync(process.execPath, [join(root, 'scripts/design-assets.mjs')], { cwd: root, stdio: 'ignore' })
  const electron = require('electron')
  const log = openSync(join(home, 'desktop.log'), 'a')
  // Electron must not inherit a Node-mode switch from whatever ran this.
  const { ELECTRON_RUN_AS_NODE, ...inherited } = process.env
  const child = spawn(electron, [join(root, 'apps/desktop/main.mjs')], {
    cwd: root,
    env: { ...inherited, MX_RIG_SERVER_URL: localUrl(values) },
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: false
  })
  child.unref()
  say(`桌面端已打开（日志 .runtime/local/desktop.log）。登录：${localUrl(values)}，账号 admin，密码见 local token`)
}

async function reset() {
  if (!assumeYes && !(await confirm('停止服务并清空本机的任务、配置和测试数据（local.env 保留）？', false))) return say('没有清空')
  await down({ quiet: true })
  await rm(join(home, 'control'), { recursive: true, force: true })
  await rm(join(home, 'artifacts'), { recursive: true, force: true })
  await rm(LOG_FILE, { force: true })
  say('已清空。重新启动：bash scripts/manage.sh local up')
}

function help() {
  console.log(`MX Rig 本机体验（macOS、Linux、Windows 的 Git Bash）

  bash scripts/manage.sh local init      装依赖、生成或询问配置、准备测试浏览器，然后启动
  bash scripts/manage.sh local up        在后台启动服务（没有初始化过就先初始化）
  bash scripts/manage.sh local desktop   打开桌面端，登录页已填好本机地址
  bash scripts/manage.sh local status    服务、模型、测试浏览器的状态
  bash scripts/manage.sh local logs [-f] 服务日志
  bash scripts/manage.sh local token     管理员密码（账号 admin）
  bash scripts/manage.sh local down      停止服务
  bash scripts/manage.sh local reset     停止并清空本机数据（保留配置）

选项：--yes 全部用默认值；--lan 允许局域网访问；--port <端口>；--no-start；--no-browser
预先给值就不会再问：MX_RIG_MODEL_API_KEY、MX_RIG_LOCAL_MODEL_BASE_URL、MX_RIG_LOCAL_MODEL_NAME、MX_RIG_DATABASE_URL`)
}

const COMMANDS = { init, up, down, status, logs, token, desktop, reset, help }
const run = COMMANDS[command]
if (!run) {
  help()
  process.exit(1)
}
await run()
// Prompts leave stdin open; the service runs on its own.
if (command !== 'logs') process.exit(0)
