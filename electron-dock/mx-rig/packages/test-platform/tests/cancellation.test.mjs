import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MemoryStore } from '../server/store/memory.mjs'
import {
  KubernetesDispatcher,
  reconcileServerRuns,
  dispatchQueued
} from '../server/runner/dispatcher.mjs'
import { runCommand, watchLease, executeOnce } from '../bin/mxt-runner.mjs'
import { start } from '../server/index.mjs'
import { loadConfig } from '../server/config.mjs'

test('a late completion cannot overwrite cancellation or publish a build', async () => {
  const store = new MemoryStore()
  const app = await store.createApp({ slug: 'fixture', displayName: 'Fixture' })
  const run = await store.createRun({ appId: app.id })
  await store.updateRun(run.id, { status: 'cancelled' }, [run.status])
  await assert.rejects(
    store.completeRun(run.id, {
      run: { status: 'passed' },
      cases: [],
      latestPackage: { filename: 'cancelled-build.exe' }
    }),
    { code: 'run_already_finished' }
  )
  await assert.rejects(store.updateRun(run.id, { status: 'running' }, ['queued']), {
    code: 'run_state_changed'
  })
  assert.equal((await store.getRun(run.id)).status, 'cancelled')
  assert.equal((await store.getApp(app.id)).latestPackage ?? null, null)
})

test('Kubernetes cancellation waits for Job disappearance, and retries deletion failures', async () => {
  const store = new MemoryStore()
  const run = await store.createRun({ appId: 'fixture' })
  await store.updateRun(run.id, { status: 'cancelled', cancellation: { stopState: 'requested' } })
  let jobs = [{ runId: run.id, uid: 'fixture-uid' }]
  let refused = true
  const dispatcher = {
    available: true,
    listJobs: async () => jobs,
    cancel: async (id, uid) => {
      assert.equal(id, run.id)
      assert.equal(uid, 'fixture-uid')
      if (refused) throw new Error('503')
    }
  }
  const reconcile = () => reconcileServerRuns({ store, dispatcher, logger: { error() {} } })
  await reconcile()
  assert.equal((await store.getRun(run.id)).cancellation.stopState, 'requested')
  refused = false
  await reconcile()
  assert.equal((await store.getRun(run.id)).cancellation.stopState, 'stopping')
  jobs = []
  await reconcile()
  assert.equal((await store.getRun(run.id)).cancellation.stopState, 'stopped')
  assert.ok((await store.getRun(run.id)).cancellation.acknowledgedAt)
})

test('Job deletion is foreground and guarded by the observed UID', async () => {
  let request
  const dispatcher = new KubernetesDispatcher({
    config: {},
    namespace: 'rig-fixture',
    readFileImpl: async () => 'fixture-token',
    fetchImpl: async (url, options) => {
      request = { url, ...options }
      return new Response('{}')
    }
  })
  dispatcher.apiBase = 'https://kubernetes.fixture'
  await dispatcher.cancel('trun_123', 'job-uid')
  assert.equal(request.method, 'DELETE')
  assert.equal(
    request.url,
    'https://kubernetes.fixture/apis/batch/v1/namespaces/rig-fixture/jobs/mxt-run-trun123'
  )
  assert.deepEqual(JSON.parse(request.body), {
    propagationPolicy: 'Foreground',
    preconditions: { uid: 'job-uid' }
  })
})

test('cancellation during dispatch cannot resurrect a run', async () => {
  const store = new MemoryStore()
  const app = await store.createApp({ slug: 'dispatch-fixture' })
  const suite = await store.createSuite({
    appId: app.id,
    slug: 'web',
    runnerKind: 'server',
    surface: 'web'
  })
  const run = await store.createRun({ appId: app.id, suiteId: suite.id, runsOn: 'server' })
  await dispatchQueued({
    store,
    config: { runLeaseMs: 60000, maxConcurrentServerRuns: 1 },
    buildEnv: () => ({}),
    issueRunToken: async () => 'fixture',
    dispatcher: {
      available: true,
      imageFor: () => 'fixture',
      listJobs: async () => [],
      dispatch: async () => {
        await store.updateRun(run.id, { status: 'cancelled' })
      }
    }
  })
  assert.equal((await store.getRun(run.id)).status, 'cancelled')
})

test('an expired lease stops work even if every heartbeat fails to reach the server', async () => {
  const lease = watchLease({
    leaseSeconds: 0.03,
    intervalMs: 5,
    heartbeat: async () => {
      throw new Error('offline')
    }
  })
  try {
    await lease.ready
    await sleep(60)
    assert.equal(lease.signal.aborted, true)
  } finally {
    lease.close()
  }
})

test(
  'abort kills the owned parent and a grandchild that ignores SIGTERM',
  { skip: process.platform === 'win32', timeout: 5000 },
  async () => {
    const controller = new AbortController()
    let grandchild
    const script = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']}); c.stdout.once('data',()=>console.log(c.pid)); setInterval(()=>{},1000)`
    await assert.rejects(
      runCommand([process.execPath, '-e', script], {
        env: process.env,
        signal: controller.signal,
        killGraceMs: 30,
        onLine: (line) => {
          grandchild = Number(line)
          controller.abort(new Error('cancel fixture'))
        }
      }),
      /cancel fixture/
    )
    assert.ok(grandchild > 0)
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(grandchild, 0)
      } catch (error) {
        assert.equal(error.code, 'ESRCH')
        return
      }
      await sleep(10)
    }
    assert.fail('owned grandchild survived cancellation')
  }
)

test(
  'the real runner observes API cancellation, stops its command and acknowledges it',
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mx-rig-cancel-'))
    const previous = process.env.MXT_RUNNER_DATA_DIR
    process.env.MXT_RUNNER_DATA_DIR = root
    const runtime = await start(
      loadConfig({
        MXT_STORE: 'memory',
        MXT_ADMIN_TOKEN: 'cancel-fixture',
        MXT_PORT: '0',
        MXT_ARTIFACTS_DIR: join(root, 'server-artifacts'),
        MXT_RUN_LEASE_MS: '3000'
      }),
      { schedule: false }
    )
    t.after(async () => {
      if (previous === undefined) delete process.env.MXT_RUNNER_DATA_DIR
      else process.env.MXT_RUNNER_DATA_DIR = previous
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })
    const base = `http://127.0.0.1:${runtime.port}`
    const post = async (path, body, token = 'cancel-fixture') => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {})
      })
      return { status: response.status, body: await response.json() }
    }
    const marker = join(root, 'started.txt')
    const script = join(root, 'fixture.cjs')
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000)`
    )
    const store = runtime.store
    const app = await store.createApp({ slug: 'cancel-fixture', surfaces: ['web'] })
    const suite = await store.createSuite({
      appId: app.id,
      slug: 'web',
      engine: 'playwright',
      surface: 'web',
      runnerKind: 'local',
      command: [process.execPath, script]
    })
    const run = await store.createRun({
      appId: app.id,
      suiteId: suite.id,
      profile: 'mock',
      track: 'functional',
      runsOn: 'any-runner'
    })
    const registered = await post('/runner/v1/runners:register', {
      name: 'fixture',
      kind: 'local',
      os: 'macos',
      engines: ['playwright'],
      surfaces: ['web']
    })
    assert.equal(registered.status, 201)
    const job = executeOnce({
      server: base,
      runnerToken: registered.body.token,
      runnerId: registered.body.runner.id
    })
    let pid
    for (let i = 0; i < 100 && !pid; i++) {
      pid = Number(await readFile(marker, 'utf8').catch(() => ''))
      if (!pid) await sleep(20)
    }
    assert.ok(pid > 0, 'fixture command started')
    const cancelled = await post(`/api/v1/runs/${run.id}:cancel`)
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.run.cancellation.stopState, 'requested')
    await job
    const stopped = await store.getRun(run.id)
    assert.equal(stopped.status, 'cancelled')
    assert.equal(stopped.cancellation.stopState, 'stopped')
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    const late = await post(
      `/runner/v1/runs/${run.id}:complete`,
      { exitCode: 0 },
      registered.body.token
    )
    assert.equal(late.status, 409)
  }
)
