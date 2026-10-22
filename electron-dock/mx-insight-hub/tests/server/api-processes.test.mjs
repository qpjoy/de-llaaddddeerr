import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { superviseApiProcesses } from '../../server/core/api-processes.mjs'
import { apiProcessCount, processShareOf, setApiProcessCount } from '../../server/core/process-share.mjs'
import { currentAdmissionLimits } from '../../server/external-platforms/admission-runtime.mjs'
import { apiProcessesFor, configureApiProcess, PUBLIC_API_PROCESSES } from '../../server/index.mjs'

function fakeCluster() {
  const cluster = new EventEmitter()
  let nextId = 1
  cluster.workers = {}
  cluster.signals = []
  cluster.setupPrimary = (settings) => { cluster.settings = settings }
  cluster.fork = () => {
    const id = nextId++
    const worker = {
      id,
      process: {
        pid: 1000 + id,
        kill: (signal) => cluster.signals.push([id, signal]),
      },
    }
    cluster.workers[id] = worker
    return worker
  }
  cluster.die = (id, code = 1) => {
    const worker = cluster.workers[id]
    delete cluster.workers[id]
    cluster.emit('exit', worker, code, null)
  }
  return cluster
}

function harness(overrides = {}) {
  let clock = 0
  const timers = []
  const exits = []
  const host = new EventEmitter()
  const cluster = fakeCluster()
  superviseApiProcesses({
    cluster,
    processes: 4,
    host,
    exit: (code) => exits.push(code),
    logger: { log() {}, error() {} },
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, unref() {} }
      timers.push(timer)
      return timer
    },
    ...overrides,
  })
  return {
    cluster, host, exits, timers,
    advance(ms) { clock += ms },
    runTimers() { for (const timer of timers.splice(0)) timer.callback() },
  }
}

test('the Public API runs four processes; Admin and the in-memory store stay single', () => {
  assert.equal(PUBLIC_API_PROCESSES, 4)
  assert.equal(apiProcessesFor({ listenerMode: 'public', storeDriver: 'postgres' }), 4)
  assert.equal(apiProcessesFor({ listenerMode: 'admin', storeDriver: 'postgres' }), 1)
  assert.equal(apiProcessesFor({ listenerMode: 'combined', storeDriver: 'postgres' }), 1)
  assert.equal(apiProcessesFor({ listenerMode: 'public', storeDriver: 'memory' }), 1)
})

test('the supervisor forks every process with a bounded heap and replaces one that dies', () => {
  const h = harness()
  assert.equal(Object.keys(h.cluster.workers).length, 4)
  assert.ok(h.cluster.settings.execArgv.includes('--max-old-space-size=768'))

  h.advance(60_000)
  h.cluster.die(2)
  assert.equal(Object.keys(h.cluster.workers).length, 3)
  assert.equal(h.timers.at(-1).ms, 1_000)
  h.runTimers()
  assert.equal(Object.keys(h.cluster.workers).length, 4)
  assert.deepEqual(h.exits, [])
})

test('processes that keep dying right after start stop the pod so Kubernetes can surface it', () => {
  const h = harness()
  const delays = []
  for (let crash = 0; crash < 4; crash += 1) {
    const [id] = Object.keys(h.cluster.workers)
    h.cluster.die(Number(id))
    delays.push(h.timers.at(-1).ms)
    h.runTimers()
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000])
  assert.deepEqual(h.exits, [])

  const [id] = Object.keys(h.cluster.workers)
  h.cluster.die(Number(id))
  // The remaining processes are asked to stop; the pod exits non-zero once they have.
  assert.ok(h.cluster.signals.length >= 3)
  assert.ok(h.cluster.signals.every(([, signal]) => signal === 'SIGTERM'))
  for (const live of Object.keys(h.cluster.workers)) h.cluster.die(Number(live), 0)
  assert.deepEqual(h.exits, [1])
})

test('a stop signal drains every process gracefully, then exits cleanly', () => {
  const h = harness()
  h.host.emit('SIGTERM')
  assert.deepEqual(h.cluster.signals.map(([, signal]) => signal), ['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGTERM'])
  // Exiting processes are not replaced while the pod is stopping.
  for (const id of Object.keys(h.cluster.workers)) h.cluster.die(Number(id), 0)
  assert.deepEqual(h.exits, [0])
  assert.equal(Object.keys(h.cluster.workers).length, 0)
})

test('a process that will not stop is killed at the deadline', () => {
  const h = harness()
  h.host.emit('SIGTERM')
  h.cluster.die(1, 0)
  const deadline = h.timers.find((timer) => timer.ms === 25_000)
  deadline.callback()
  assert.equal(h.cluster.signals.filter(([, signal]) => signal === 'SIGKILL').length, 3)
  assert.deepEqual(h.exits, [0])
})

test('each process takes its share of the pool budget and of upstream concurrency', (t) => {
  t.after(() => setApiProcessCount(1))
  const config = configureApiProcess({ common: { postgres: { maxConnections: 10 } } }, 4)
  assert.equal(config.common.postgres.maxConnections, 5)
  assert.equal(apiProcessCount(), 4)
  assert.equal(processShareOf(1_200), 300)
  assert.equal(processShareOf(16), 4)
  assert.equal(processShareOf(1), 1)

  const gateway = {
    config: { maxConcurrency: 32, maxConsumerConcurrency: 8, maxRequestsPerMinute: 600,
      concurrencyQueue: { maxWaitMs: 30_000, maxPending: 256 } },
  }
  assert.deepEqual(currentAdmissionLimits(gateway), {
    maxConcurrency: 8, maxConsumerConcurrency: 2, maxRequestsPerMinute: 600, maxWaitMs: 30_000, maxPending: 64,
  })
  // A policy saved in Admin is shared the same way.
  gateway.admissionLimits = Object.freeze({ revision: 3, maxConcurrency: 6, maxConsumerConcurrency: 1,
    maxRequestsPerMinute: 120, maxWaitMs: 10_000, maxPending: 10 })
  assert.deepEqual(currentAdmissionLimits(gateway), {
    revision: 3, maxConcurrency: 2, maxConsumerConcurrency: 1, maxRequestsPerMinute: 120, maxWaitMs: 10_000, maxPending: 3,
  })

  setApiProcessCount(1)
  assert.equal(currentAdmissionLimits(gateway), gateway.admissionLimits)
  assert.equal(configureApiProcess({ common: { postgres: { maxConnections: 10 } } }, 1).common.postgres.maxConnections, 10)
})

const databaseUrl = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const native = { skip: databaseUrl ? false : 'Requires a disposable migrated MX_INSIGHT_TEST_DATABASE_URL' }

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

test('the real Public entry point serves from four processes on one port and stops cleanly', native, async () => {
  const port = await freePort()
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../server/index.mjs', import.meta.url))], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: databaseUrl,
      MX_INSIGHT_LISTENER_MODE: 'public',
      MX_INSIGHT_HOST: '127.0.0.1',
      MX_INSIGHT_PORT: String(port),
      MX_INSIGHT_API_KEY_PEPPER: 'api-processes-test-pepper-at-least-32-bytes',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    const deadline = Date.now() + 60_000
    while ((output.match(/listening on/g) || []).length < 4) {
      assert.ok(Date.now() < deadline, `four processes did not start:\n${output}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const workers = execFileSync('pgrep', ['-P', String(child.pid)]).toString().trim().split('\n')
    assert.equal(workers.length, 4)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`)
      assert.equal(response.status, 200)
    }
  } finally {
    child.kill('SIGTERM')
  }
  const result = await exited
  assert.deepEqual(result, { code: 0, signal: null }, output)
})
