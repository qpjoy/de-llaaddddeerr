import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { interpreterPath, pythonPath } from './catalog.mjs'

// One adapter process per invocation, in its own process group so a deadline,
// an abort or a shutdown stops the adapter and every helper it started (the
// Scrapy worker, the Node backend) together.

export const ENVELOPE_STATUSES = new Set(['success', 'no_data', 'partial', 'unknown', 'error', 'stopped'])
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 - 64 * 1024
const STDERR_TAIL_BYTES = 8 * 1024
const TERM_GRACE_MS = 5_000
const CLOSE_GRACE_MS = 2_000

function killGroup(pid, signal) {
  if (!pid) return
  try { process.kill(-pid, signal) } catch { /* already gone */ }
}

// The proxy may carry userinfo; it never reaches logs or records.
export function redactor(proxyUrl) {
  const secrets = []
  if (proxyUrl) {
    secrets.push(proxyUrl)
    try {
      const url = new URL(proxyUrl)
      if (url.password) secrets.push(decodeURIComponent(url.password), url.password)
      if (url.username) secrets.push(`${url.username}:`)
      // Error messages often name only host:port.
      secrets.push(url.host)
    } catch { /* validated before use */ }
  }
  return text => secrets.reduce((out, secret) => (secret ? out.split(secret).join('[redacted]') : out), text)
}

export function childEnv({ slot, workDir, proxyUrl, nodePath = process.execPath }) {
  const env = {
    PATH: [dirname(nodePath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: workDir,
    TMPDIR: join(workDir, 'tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    // The package source is imported in place (adapter.py and the helper
    // processes it spawns with `python -m`), never pip-installed over itself.
    PYTHONPATH: pythonPath(slot),
  }
  if (proxyUrl) {
    env.HTTPS_PROXY = proxyUrl; env.HTTP_PROXY = proxyUrl
    env.https_proxy = proxyUrl; env.http_proxy = proxyUrl
    env.NO_PROXY = 'localhost,127.0.0.1,::1'; env.no_proxy = env.NO_PROXY
  }
  return env
}

// Resolve with { exitCode, signal, durationMs, envelope, failure, stderrTail }.
// Never rejects: every way a process can end is an outcome.
export async function runAdapter({ slot, operation, params, workDir, deadlineAt, proxyUrl = null, nodePath = process.execPath,
  maxOutputBytes = MAX_OUTPUT_BYTES, onStart = () => {}, signal = null }) {
  const started = Date.now()
  const redact = redactor(proxyUrl)
  try {
    await mkdir(join(workDir, 'tmp'), { recursive: true, mode: 0o700 })
  } catch (error) {
    return { exitCode: null, signal: null, durationMs: 0, envelope: null, failure: { code: 'workdir_unavailable', message: `无法创建工作目录（${error?.code || 'error'}）` }, stderrTail: '' }
  }
  let child
  try {
    child = spawn(interpreterPath(slot, { nodePath }), [join(slot.root, slot.entry)], {
      cwd: workDir, env: childEnv({ slot, workDir, proxyUrl, nodePath }), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    return { exitCode: null, signal: null, durationMs: 0, envelope: null, failure: { code: 'spawn_failed', message: `无法启动适配器进程（${error?.code || 'error'}）` }, stderrTail: '' }
  }

  return await new Promise(resolve => {
    const stdout = []
    let stdoutBytes = 0
    let stderrTail = Buffer.alloc(0)
    let stopReason = null
    let exit = null
    let settled = false
    const timers = []

    const stop = reason => {
      if (stopReason) return
      stopReason = reason
      killGroup(child.pid, 'SIGTERM')
      timers.push(setTimeout(() => killGroup(child.pid, 'SIGKILL'), TERM_GRACE_MS))
    }
    const finish = () => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      // Whatever the adapter left behind in its group goes with it.
      killGroup(child.pid, 'SIGKILL')
      const tail = redact(stderrTail.toString('utf8'))
      const result = { exitCode: exit?.code ?? null, signal: exit?.signal ?? null, durationMs: Date.now() - started, envelope: null, failure: null, stderrTail: tail }
      if (stopReason === 'deadline') result.failure = { code: 'deadline_exceeded', message: '超过截止时间，runner 已停止适配器进程' }
      else if (stopReason === 'aborted') result.failure = { code: 'aborted', message: 'Hub 要求中止，runner 已停止适配器进程' }
      else if (stopReason === 'shutdown') result.failure = { code: 'interrupted', message: 'runner 停止时适配器仍在运行，进程已随 runner 停止' }
      else if (stopReason === 'output_too_large') result.failure = { code: 'output_too_large', message: `适配器输出超过 ${maxOutputBytes} 字节上限` }
      else if (stopReason === 'spawn_failed') result.failure = { code: 'spawn_failed', message: '无法启动适配器进程' }
      else {
        // Some adapters copy their worker's stderr into the result; the proxy
        // never reaches Hub that way either.
        const text = redact(Buffer.concat(stdout).toString('utf8').trim())
        let envelope = null
        try { envelope = JSON.parse(text) } catch { envelope = null }
        if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) && ENVELOPE_STATUSES.has(envelope.status)) result.envelope = envelope
        else result.failure = { code: 'output_unusable', message: text ? '适配器输出不是合法的结果外壳' : `适配器没有输出结果（退出码 ${exit?.code ?? exit?.signal ?? '未知'}）` }
      }
      resolve(result)
    }
    const onAbort = () => stop(signal.reason === 'shutdown' ? 'shutdown' : 'aborted')

    child.once('error', () => { stopReason ||= 'spawn_failed'; exit ||= { code: null, signal: null }; finish() })
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutputBytes) { stop('output_too_large'); return }
      stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      stderrTail = Buffer.concat([stderrTail, chunk])
      if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES)
    })
    child.stdin.on('error', () => {})
    child.once('exit', (code, sig) => {
      exit = { code, signal: sig }
      // Helpers that inherited stdout could hold the pipe open; do not wait
      // for them past a short grace.
      timers.push(setTimeout(finish, CLOSE_GRACE_MS))
    })
    child.once('close', (code, sig) => { exit ||= { code, signal: sig }; finish() })

    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) stop('deadline')
    else timers.push(setTimeout(() => stop('deadline'), remaining))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (child.pid) onStart(child.pid)
    child.stdin.end(JSON.stringify({ operation, params }))
  })
}
