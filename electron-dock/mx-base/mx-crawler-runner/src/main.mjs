#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadCatalog } from './catalog.mjs'
import { createRunnerServer } from './http.mjs'
import { LIMITS, PROTOCOL, Runner, VERSION } from './runner.mjs'

// mx-crawler-runner. Defaults are the deployed values (deploy/k8s); local
// runs override them with flags. No environment variables are read.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    listen: { type: 'string', default: '127.0.0.1:18190' },
    'data-dir': { type: 'string', default: '/var/lib/mx-crawler-runner' },
    'token-file': { type: 'string', default: '/run/secrets/mx-crawler-runner/token' },
    catalog: { type: 'string', default: join(ROOT, 'packages.json') },
  },
})

const log = entry => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
const [host, portText] = values.listen.includes(':') ? [values.listen.slice(0, values.listen.lastIndexOf(':')), values.listen.slice(values.listen.lastIndexOf(':') + 1)] : ['127.0.0.1', values.listen]
const port = Number(portText)
if (!Number.isInteger(port) || port < 1 || port > 65535) { log({ level: 'fatal', event: 'invalid_listen', listen: values.listen }); process.exit(2) }

let token
try {
  token = readFileSync(values['token-file'], 'utf8').trim()
} catch (error) {
  log({ level: 'fatal', event: 'token_unreadable', path: values['token-file'], error: error?.code })
  process.exit(2)
}

const runner = new Runner({ slots: loadCatalog(values.catalog), dataDir: values['data-dir'], logger: log })
await runner.init()
const server = createRunnerServer({ runner, token, logger: log })
server.requestTimeout = 30_000
server.headersTimeout = 10_000
server.keepAliveTimeout = 5_000
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen) })
log({ level: 'info', event: 'listening', host, port, protocol: PROTOCOL, version: VERSION, capacity: LIMITS.capacity, slots: runner.slots.size })

const pruneTimer = setInterval(() => { runner.prune().catch(() => {}) }, LIMITS.pruneEveryMs)
pruneTimer.unref()

let stopping = false
const shutdown = async signal => {
  if (stopping) return
  stopping = true
  log({ level: 'info', event: 'shutdown', signal, running: runner.active.size })
  server.close()
  // Running adapters are stopped and recorded as interrupted; the Hub reads
  // that record (or the restart recovery) instead of guessing.
  await runner.close()
  process.exit(0)
}
process.on('SIGTERM', () => { shutdown('SIGTERM') })
process.on('SIGINT', () => { shutdown('SIGINT') })
