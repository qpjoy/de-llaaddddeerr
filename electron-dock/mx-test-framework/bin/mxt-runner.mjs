#!/usr/bin/env node
// mxt-runner — run platform tasks on your own machine.
//
// This exists for the work a Linux container cannot do: driving a packaged
// Electron app on Windows or macOS. It logs in with the same mx-launcher
// account as the web UI, asks the platform for work it is capable of, runs it,
// uploads the artifacts, and reports the result.
//
//   mxt-runner login   --server https://mxt.internal
//   mxt-runner register --name "我的开发机" --engines playwright-electron --surfaces electron
//   mxt-runner watch
//   mxt-runner once
//   mxt-runner status

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { homedir, platform, arch } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

const CONFIG_DIR = join(homedir(), '.mxt')
const CONFIG_FILE = join(CONFIG_DIR, 'runner.json')
const POLL_IDLE_MS = 15_000

const say = (message) => console.log(`[mxt-runner] ${message}`)
const die = (message) => {
  console.error(`[mxt-runner] ✗ ${message}`)
  process.exit(1)
}

const OS_NAME = { darwin: 'macos', win32: 'windows', linux: 'linux' }[platform()] ?? 'linux'

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1]
  }
  const inline = process.argv.find((entry) => entry.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function saveConfig(patch) {
  await mkdir(CONFIG_DIR, { recursive: true })
  const merged = { ...(await loadConfig()), ...patch }
  // Mode 0600: this file holds tokens, and a home directory is not private on
  // a shared machine.
  await writeFile(CONFIG_FILE, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  return merged
}

async function api(config, method, path, { body, token, raw, headers = {} } = {}) {
  const response = await fetch(`${config.server.replace(/\/$/u, '')}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
    duplex: raw ? 'half' : undefined,
  })
  if (response.status === 204) return null
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    const error = payload?.error
    throw new Error(`${error?.message ?? response.statusText}${error?.hint ? `\n  提示：${error.hint}` : ''}`)
  }
  return payload
}

// -- commands ---------------------------------------------------------------

async function cmdLogin() {
  const server = argValue('server') || (await loadConfig()).server
  if (!server) die('需要 --server https://你的测试平台地址')

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const username = argValue('username') || (await rl.question('mx-launcher 账号: '))
  // Node has no portable way to mask input; say so rather than pretend.
  const password = argValue('password') || (await rl.question('密码（输入不显示是正常的，直接回车确认）: '))
  rl.close()

  const result = await api({ server }, 'POST', '/api/v1/auth/login', {
    body: { username, password },
  }).catch((error) => die(error.message))

  await saveConfig({ server, userToken: result.token, member: result.member })
  say(`✓ 已登录为 ${result.member.displayName}（权限：${result.member.role}）`)
  say('下一步：mxt-runner register --name "我的机器"')
}

async function cmdRegister() {
  const config = await loadConfig()
  if (!config.userToken) die('请先运行 mxt-runner login')

  const name = argValue('name') || `${OS_NAME}-${process.env.USER || process.env.USERNAME || 'runner'}`
  const engines = (argValue('engines') || 'playwright-electron,playwright').split(',')
  const surfaces = (argValue('surfaces') || 'electron').split(',')

  const result = await api(config, 'POST', '/runner/v1/runners:register', {
    token: config.userToken,
    body: { name, kind: 'local', os: OS_NAME, arch: arch(), engines, surfaces },
  }).catch((error) => die(error.message))

  await saveConfig({ runnerId: result.runner.id, runnerToken: result.token, runnerName: name })
  say(`✓ 已注册执行机「${name}」(${OS_NAME}/${arch()})`)
  say(`  可执行：${engines.join(', ')} × ${surfaces.join(', ')}`)
  say('下一步：mxt-runner watch  —— 常驻等待任务')
}

async function cmdStatus() {
  const config = await loadConfig()
  if (!config.server) return say('尚未配置。先运行 mxt-runner login --server <地址>')
  say(`平台：${config.server}`)
  say(`账号：${config.member?.displayName ?? '未登录'}`)
  say(`执行机：${config.runnerName ?? '未注册'} ${config.runnerId ? `(${config.runnerId})` : ''}`)
}

/** Walk a directory and upload every file, preserving relative paths. */
async function uploadArtifacts(config, runId, runToken, dir) {
  const files = []
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await walk(dir).catch(() => {})

  let uploaded = 0
  for (const file of files) {
    const relativePath = relative(dir, file).split(sep).join('/')
    const info = await stat(file)
    if (info.size === 0) continue
    try {
      await api(config, 'PUT', `/runner/v1/runs/${runId}/artifacts/${encodeURI(relativePath)}`, {
        token: runToken,
        raw: true,
        body: createReadStream(file),
        headers: { 'content-length': String(info.size) },
      })
      uploaded += 1
    } catch (error) {
      // One unreadable file must not cost the whole result.
      say(`  ! 产物 ${relativePath} 上传失败：${error.message}`)
    }
  }
  return uploaded
}

function runCommand(command, { cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('error', (error) => {
      console.error(`[mxt-runner] 无法启动命令：${error.message}`)
      resolvePromise(2)
    })
    child.on('close', (code) => resolvePromise(code ?? 2))
  })
}

async function executeOnce(config) {
  const claimed = await api(config, 'POST', '/runner/v1/runs:claim', {
    token: config.runnerToken,
    body: { runnerId: config.runnerId },
  })
  if (!claimed) return false

  const { runId, command, env, runToken } = claimed
  say(`▶ 认领 ${runId}（${claimed.suite.slug}）`)

  const workDir = resolve(argValue('workdir') || process.cwd())
  const artifactsDir = join(CONFIG_DIR, 'artifacts', runId)
  await rm(artifactsDir, { recursive: true, force: true })
  await mkdir(artifactsDir, { recursive: true })

  const childEnv = { ...process.env, ...env, MXT_ARTIFACTS_DIR: artifactsDir, E2E_ARTIFACTS_DIR: artifactsDir }
  const heartbeat = setInterval(() => {
    api(config, 'POST', `/runner/v1/runs/${runId}/heartbeat`, { token: runToken }).catch(() => {})
  }, 60_000)
  heartbeat.unref?.()

  let exitCode = 2
  if (!command || command.length === 0) {
    say('  ! 这条 suite 没有配置执行命令，判为受阻')
  } else {
    say(`  执行：${command.join(' ')}（工作目录 ${workDir}）`)
    exitCode = await runCommand(command, { cwd: workDir, env: childEnv })
  }
  clearInterval(heartbeat)

  const count = await uploadArtifacts(config, runId, runToken, artifactsDir)
  if (count > 0) say(`  已上传 ${count} 个产物`)

  let summary
  try {
    summary = JSON.parse(await readFile(join(artifactsDir, 'summary.json'), 'utf8'))
  } catch {
    // No summary is a result too — report it rather than leaving the run to
    // time out with no explanation on the run page.
    summary = {
      schemaVersion: 2,
      runId,
      app: env.MXT_APP,
      status: 'blocked',
      totals: { tests: 0 },
      blockedReason: '执行结束但没有生成 summary.json',
    }
  }

  const result = await api(config, 'POST', `/runner/v1/runs/${runId}:complete`, {
    token: runToken,
    body: { exitCode, summary },
  })
  const label = { passed: '✓ 通过', failed: '✗ 失败', blocked: '⚠ 受阻', flaky: '~ 不稳定' }
  say(`${label[result.run.status] ?? result.run.status}  ${config.server}/runs/${runId}`)
  return true
}

async function cmdWatch({ once = false } = {}) {
  const config = await loadConfig()
  if (!config.runnerToken) die('请先运行 mxt-runner register')

  say(`等待任务中（${config.runnerName}）。Ctrl-C 退出。`)
  let stop = false
  process.on('SIGINT', () => {
    stop = true
    say('收到退出信号，当前任务完成后停止。')
  })

  while (!stop) {
    let worked = false
    try {
      worked = await executeOnce(config)
    } catch (error) {
      say(`! ${error.message}`)
    }
    if (once) return
    if (!worked && !stop) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_IDLE_MS))
    }
  }
}

const usage = `mxt-runner — 在自己的电脑上执行测试平台派发的任务

  mxt-runner login --server <平台地址>   用 mx-launcher 账号登录
  mxt-runner register --name <名字>      把这台机器注册为执行机
      --engines  默认 playwright-electron,playwright
      --surfaces 默认 electron
  mxt-runner watch [--workdir <目录>]    常驻认领任务
  mxt-runner once  [--workdir <目录>]    只取一个任务
  mxt-runner status                      看当前配置

配置保存在 ~/.mxt/runner.json（权限 0600）。`

const command = process.argv[2]
try {
  if (command === 'login') await cmdLogin()
  else if (command === 'register') await cmdRegister()
  else if (command === 'watch') await cmdWatch()
  else if (command === 'once') await cmdWatch({ once: true })
  else if (command === 'status') await cmdStatus()
  else console.log(usage)
} catch (error) {
  die(error.message)
}
