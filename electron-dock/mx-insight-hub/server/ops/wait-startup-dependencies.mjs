// Internal Kubernetes startup gate only. Do not import this from the API or workers.
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const MAX_RESPONSE_BYTES = 16 * 1024
const PROBE_TIMEOUT_MS = 3000
const STARTUP_TIMEOUT_MS = 900_000
const RETRY_MS = 2000

function startupPacket() {
  const fields = Buffer.from('user\0postgres\0database\0postgres\0application_name\0mx_hub_startup_probe\0\0')
  const packet = Buffer.alloc(8 + fields.length)
  packet.writeInt32BE(packet.length, 0)
  packet.writeInt32BE(196608, 4) // PostgreSQL protocol 3.0; no password or SQL.
  fields.copy(packet, 8)
  return packet
}

function errorSqlState(body) {
  let sqlState
  for (let offset = 0; offset < body.length;) {
    const type = body[offset++]
    if (type === 0) return offset === body.length && /^[0-9A-Z]{5}$/u.test(sqlState ?? '') ? sqlState : null
    const end = body.indexOf(0, offset)
    if (end < 0) return null
    if (type === 67) sqlState = body.toString('ascii', offset, end) // C: SQLSTATE
    offset = end + 1
  }
  return null
}

export function probePostgres({ host = '127.0.0.1', port = 5432, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let received = Buffer.alloc(0)
    const socket = net.createConnection({ host, port })
    const finish = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(status)
    }
    // An absolute deadline, not a socket idle timeout: trickled bytes cannot extend it.
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    socket.once('connect', () => socket.write(startupPacket()))
    socket.once('error', () => finish('unreachable'))
    socket.once('close', () => finish('invalid_response'))
    socket.on('data', (chunk) => {
      if (settled) return
      if (received.length + chunk.length > MAX_RESPONSE_BYTES) return finish('invalid_response')
      received = Buffer.concat([received, chunk])
      while (received.length >= 5) {
        const type = received[0]
        const length = received.readInt32BE(1)
        if (length < 4 || length > MAX_RESPONSE_BYTES - 1) return finish('invalid_response')
        if (received.length < length + 1) return
        const body = received.subarray(5, length + 1)
        // Same accepting/rejecting distinction as libpq PQping (pg_isready):
        // authentication proves availability; only SQLSTATE 57P03 means rejecting.
        // This does not verify database identity, credentials, schema or read/write mode.
        if (type === 82) return finish(body.length >= 4 ? 'ready' : 'invalid_response') // R
        if (type === 69) { // E
          const code = errorSqlState(body)
          return finish(!code ? 'invalid_response' : code === '57P03' ? 'rejecting' : 'ready')
        }
        if (type !== 78) return finish('invalid_response') // Only notices may precede R/E.
        received = received.subarray(length + 1)
      }
    })
  })
}

function hanlpHealthUrl(baseUrl) {
  if (!baseUrl?.trim()) throw new Error('not_configured')
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('invalid_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url')
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/health`
  url.search = ''
  url.hash = ''
  return url
}

export function probeHanlp(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let url
  try { url = hanlpHealthUrl(baseUrl) } catch (error) { return Promise.resolve(error.message) }
  return new Promise((resolve) => {
    let settled = false
    let bytes = 0
    const chunks = []
    // Native HTTP clients connect directly; a host proxy must not gate local readiness.
    const request = (url.protocol === 'https:' ? https : http).get(url, { agent: false })
    const finish = (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.destroy()
      resolve(status)
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    request.once('error', () => finish('unreachable'))
    request.once('response', (response) => {
      response.once('error', () => finish('invalid_response'))
      if (response.statusCode !== 200) return finish(`http_${response.statusCode}`)
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_RESPONSE_BYTES) return finish('invalid_response')
        chunks.push(chunk)
      })
      response.once('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          finish(body?.status === 'ready' ? 'ready' : 'not_ready')
        } catch { finish('invalid_response') }
      })
    })
  })
}

export async function waitForStartupDependencies({
  hanlpUrl = process.env.MX_COMMON_HANLP_URL,
  timeoutMs = STARTUP_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  retryMs = RETRY_MS,
  postgres = {},
  log = console.log,
} = {}) {
  try { hanlpHealthUrl(hanlpUrl) } catch (error) {
    log(`[startup-dependencies] hanlp=${error.message}; startup blocked`)
    return false
  }
  const deadline = performance.now() + timeoutMs
  let previousStatus
  while (performance.now() < deadline) {
    const budget = Math.max(1, Math.min(probeTimeoutMs, deadline - performance.now()))
    // Recheck both in the same pass; an earlier success is not latched forever.
    const [pg, hanlp] = await Promise.all([
      probePostgres({ ...postgres, timeoutMs: budget }),
      probeHanlp(hanlpUrl, { timeoutMs: budget }),
    ])
    const status = `postgres=${pg} hanlp=${hanlp}`
    if (status !== previousStatus) log(`[startup-dependencies] ${status}`)
    previousStatus = status
    if (pg === 'ready' && hanlp === 'ready') return true
    const remaining = deadline - performance.now()
    if (remaining > 0) await delay(Math.min(retryMs, remaining))
  }
  log('[startup-dependencies] deadline exceeded; startup blocked, Kubernetes will retry')
  return false
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!await waitForStartupDependencies()) process.exitCode = 1
  } catch {
    console.error('[startup-dependencies] probe failed; startup blocked')
    process.exitCode = 1
  }
}
