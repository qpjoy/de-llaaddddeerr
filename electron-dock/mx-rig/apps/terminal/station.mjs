// mx-rig station — a station (工位) that takes procedure regression off the
// service's queue and replays it with its own browser. The service never
// opens a browser; whoever runs this does.
//
//   mx-rig station enroll --server https://rig.internal --code <一次性接入码> [--name 名字] [--kind server|local]
//   mx-rig station watch  [--once] [--headed]
//   mx-rig station status
//
// Credentials live in MX_RIG_STATION_DIR (default ~/.mx-rig/station), in the
// same runner.json the desktop writes when a person puts their computer on
// duty. A container that starts with no credentials and a code in
// MX_RIG_STATION_ENROLL_CODE enrols itself first.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, homedir, hostname, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { serviceUrl } from '../../packages/contracts/index.mjs'
import { BrowserTools } from '../../packages/runtime/browser.mjs'
import { progressLine, provisionFromEnv } from '../../packages/runtime/browser-provision.mjs'
import {
  ProcedureStation,
  STATION_ENGINES,
  STATION_SURFACES,
  enrollStation
} from '../../packages/runtime/station.mjs'
import { chromiumLauncher } from './launcher.mjs'

const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform()] ?? 'linux'
const DIR = resolve(
  process.env.MX_RIG_STATION_DIR || join(process.env.MX_RIG_HOME || join(homedir(), '.mx-rig'), 'station')
)
const CONFIG = join(DIR, 'runner.json')

const say = (message) => console.log(`[mx-rig] ${message}`)
function die(message) {
  console.error(`[mx-rig] ✗ ${message}`)
  process.exit(1)
}

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'))
    return process.argv[index + 1]
  const inline = process.argv.find((entry) => entry.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

async function config() {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8'))
  } catch {
    return {}
  }
}

function origin(value) {
  // Plain HTTP only for this machine or, when asked, a private address: a
  // runner token on the open network is a key to the queue.
  const privateHttp = process.env.MX_RIG_ALLOW_PRIVATE_HTTP === '1'
  const url = new URL(String(value))
  // A single-label name — a compose service, a LAN host — only resolves
  // inside the private network that names it; with private HTTP allowed it is
  // treated like a private address. The shape is still checked.
  if (privateHttp && url.protocol === 'http:' && /^[a-z0-9][a-z0-9-]{0,62}$/i.test(url.hostname)) {
    const shape = new URL(url.href)
    shape.protocol = 'https:'
    serviceUrl(shape.href)
    return url.origin
  }
  try {
    return serviceUrl(value, { privateHttp })
  } catch (error) {
    if (error.code !== 'tls_required' || privateHttp) throw error
    throw new Error('非本机服务必须使用 HTTPS；内网测试服务器的私有 IP 可设置 MX_RIG_ALLOW_PRIVATE_HTTP=1')
  }
}

async function enroll({ server, code, name, kind }) {
  const target = origin(server)
  const result = await enrollStation({
    server: target,
    code,
    name: String(name || hostname() || `${OS_NAME}-station`).slice(0, 96),
    kind,
    os: OS_NAME,
    arch: arch()
  })
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  await writeFile(
    CONFIG,
    `${JSON.stringify(
      {
        server: target,
        runnerId: result.runnerId,
        runnerToken: result.runnerToken,
        runnerName: result.name,
        engines: [...STATION_ENGINES],
        surfaces: [...STATION_SURFACES]
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  say(`已接入 ${target}：工位「${result.name}」（${result.runnerId}）`)
  return config()
}

async function watch() {
  let current = await config()
  const code = process.env.MX_RIG_STATION_ENROLL_CODE
  if (!current.runnerToken && code && process.env.MX_RIG_SERVER)
    current = await enroll({
      server: process.env.MX_RIG_SERVER,
      code,
      name: process.env.MX_RIG_STATION_NAME,
      kind: process.env.MX_RIG_STATION_KIND || 'server'
    })
  const server = process.env.MX_RIG_SERVER || current.server
  if (!current.runnerToken || !server)
    die(`还没有接入：先运行 mx-rig station enroll --server <地址> --code <接入码>（配置目录 ${DIR}）`)

  const headed = flag('headed') || process.env.MX_RIG_STATION_HEADED === '1'
  const launcher = await chromiumLauncher()
  // A desktop on duty passes its own browsers in; a bare station keeps one
  // under ~/.mx-rig/browsers.
  const provision = provisionFromEnv(process.env, {
    dir: join(process.env.MX_RIG_HOME || join(homedir(), '.mx-rig'), 'browsers')
  })
  const seen = { step: -1 }
  provision.onProgress = (event) => {
    const text = progressLine(event, seen)
    if (text) say(text)
  }
  const browser = new BrowserTools(join(DIR, 'evidence'), launcher, { headless: !headed, provision })
  const station = new ProcedureStation({
    server: origin(server),
    runnerToken: current.runnerToken,
    browser,
    log: say
  })

  if (flag('once')) {
    const outcome = await station.once()
    say(outcome ? `${outcome.runId}：${outcome.status}` : '队列里没有待回归的批次')
    await browser.close()
    return
  }

  // First request: finish the batch in hand, take no more. Second: stop now.
  const drain = new AbortController()
  const hard = new AbortController()
  const stop = (why) => {
    if (drain.signal.aborted) {
      say('再次收到停止请求：立即停止，当前批次记为受阻。')
      hard.abort()
      return
    }
    say(`${why}：当前批次完成后停止。`)
    drain.abort()
  }
  process.on('SIGINT', () => stop('收到退出信号'))
  process.on('SIGTERM', () => stop('收到退出信号'))
  // The terminal went away: nobody is left to wait for a polite stop.
  process.on('SIGHUP', () => {
    drain.abort()
    hard.abort()
  })
  // A managing host (the MX Rig desktop) asks over IPC: signals are not a
  // dependable way to ask a child to stop politely on every OS.
  process.on('message', (message) => {
    if (message === 'stop') stop('收到停止请求')
  })
  say(`工位「${current.runnerName ?? current.runnerId}」 → ${origin(server)}`)
  await station.watch({ signal: hard.signal, drain: drain.signal }).catch(() => {})
  await browser.close().catch(() => {})
  process.disconnect?.()
}

async function status() {
  const current = await config()
  if (!current.runnerToken) {
    say(`未接入（配置目录 ${DIR}）`)
    return
  }
  say(`工位「${current.runnerName}」（${current.runnerId}）`)
  say(`服务：${current.server}`)
  say(`执行：${(current.engines ?? []).join('、')} × ${(current.surfaces ?? []).join('、')}`)
  const response = await fetch(`${current.server}/healthz`).catch(() => null)
  say(`连通：${response?.ok ? '正常' : `不可达${response ? `（${response.status}）` : ''}`}`)
}

/** `mx-rig station <command>`. */
export async function stationCommand([command]) {
  try {
    if (command === 'enroll') {
      const server = arg('server', process.env.MX_RIG_SERVER)
      const code = arg('code', process.env.MX_RIG_STATION_ENROLL_CODE)
      if (!server || !code) die('需要 --server 和 --code（接入码在「执行机」页面由管理员生成）')
      const kind = arg('kind', 'server')
      if (!['server', 'local'].includes(kind)) die('--kind 只能是 server 或 local')
      await enroll({ server, code, name: arg('name'), kind })
    } else if (command === 'watch') await watch()
    else if (command === 'status') await status()
    else {
      console.log(
        '用法：\n  mx-rig station enroll --server <地址> --code <接入码> [--name 名字] [--kind server|local]\n  mx-rig station watch [--once] [--headed]\n  mx-rig station status'
      )
      process.exitCode = command ? 1 : 0
    }
  } catch (error) {
    die(error.message)
  }
}
