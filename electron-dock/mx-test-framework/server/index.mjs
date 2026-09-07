import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createApp } from './app.mjs'
import { ArtifactStore } from './artifacts.mjs'
import { loadConfig } from './config.mjs'
import { RunEventBus, createRunEventRecorder, normalizeRunEvents } from './events/run-events.mjs'
import { createIdentity } from './identity/index.mjs'
import { deliverPending } from './notify/dispatch.mjs'
import { KubernetesDispatcher, dispatchQueued, reconcileServerRuns } from './runner/dispatcher.mjs'
import { startScheduler } from './scheduler.mjs'
import { MemoryStore } from './store/memory.mjs'

// Loaded on demand so memory mode — local development and the test suite —
// runs without the `pg` driver installed at all.
export async function createStore(config) {
  if (config.storeDriver !== 'postgres') return new MemoryStore()
  const { createPostgresStore } = await import('./store/postgres.mjs')
  return createPostgresStore({ connectionString: config.databaseUrl })
}

export async function createRuntime(config = loadConfig(), { schedule = true } = {}) {
  const store = await createStore(config)
  const identity = createIdentity({ store, config })
  const artifacts = new ArtifactStore({
    root: config.artifactsDir,
    maxFileBytes: config.artifactLimits.fileBytes,
    maxRunBytes: config.artifactLimits.runBytes,
    maxFilesPerRun: config.artifactLimits.filesPerRun,
    maxTotalBytes: config.artifactLimits.totalBytes,
    maxTotalEntries: config.artifactLimits.totalEntries,
    minFreeBytes: config.artifactLimits.minFreeBytes,
    minFreeInodes: config.artifactLimits.minFreeInodes,
  })
  const dispatcher = new KubernetesDispatcher({ config, namespace: config.namespace })
  // One bus per runtime rather than a module-level singleton: the test suite
  // starts several servers in one process, and a shared bus would deliver one
  // server's events to another's subscribers.
  const runEvents = new RunEventBus()
  // Per-runtime, so the retention clock is not shared between two servers in
  // one process.
  const retention = { lastSweepAt: 0 }
  const app = createApp({ store, config, identity, artifacts, runEvents })

  // Dispatching rides the scheduler tick: both are "look at what is due and act
  // on it", and keeping them on one timer means one place can double-fire.
  const stopScheduler = schedule
    ? startScheduler({
        store,
        intervalMs: config.schedulerIntervalMs,
        onTick: async () => {
          // Reconcile first: a run whose Job already died should be closed out
          // before this tick considers dispatching anything else, so the run
          // list never shows a finished failure as still running.
          await reconcileServerRuns({ store, dispatcher })
          // Drain the notification outbox on the same tick. Delivery failures
          // are retried on later ticks and must never stop dispatching.
          await deliverPending({ store }).catch(() => {})
          await sweepRetention({ store, artifacts, config, state: retention, logger: console }).catch(() => {})
          return dispatchServerRuns({ store, dispatcher, config, runEvents })
        },
      })
    : () => {}
  return { store, app, config, identity, artifacts, dispatcher, runEvents, stopScheduler }
}

async function dispatchServerRuns({ store, dispatcher, config, runEvents }) {
  const { runnerEnv } = await import('./app.mjs')
  const { newToken, sha256 } = await import('./core/ids.mjs')
  const record = createRunEventRecorder({ store, bus: runEvents })
  return dispatchQueued({
    store,
    dispatcher,
    config,
    // Progress is a nicety; dispatching is not. A timeline that cannot be
    // written must never stop a run from being dispatched.
    onProgress: (runId, events) =>
      record(runId, normalizeRunEvents(events)).catch(() => {}),
    buildEnv: async ({ run, suite, app }) => {
      const { resolveCaseFilter } = await import('./ingest/case-filter.mjs')
      return runnerEnv({
        run,
        suite,
        app,
        config,
        caseFilter: run.caseFilter
          ? await resolveCaseFilter({ store, appId: run.appId, filter: run.caseFilter })
          : null,
      })
    },
    issueRunToken: async (run) => {
      const token = newToken('mxt-run')
      await store.updateRun(run.id, { runTokenSha256: sha256(token) })
      return token
    },
  })
}

// How often the retention sweep is even considered. The scheduler ticks every
// minute; walking a month of directories every minute would be absurd.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Delete what has aged out: artifact directories, and the progress events that
 * belong to them.
 *
 * `purgeOlderThan` has existed since the artifact store was written and its only
 * caller was its own test — the retention policy in docs/10 was a sentence
 * nothing executed, and the volume would have filled with recordings nobody
 * could still open. See docs/26 §2.2.
 *
 * On the scheduler's own timer rather than a Kubernetes CronJob: the platform
 * already has one thing that wakes up on a schedule, and a second one is a
 * second thing that can stop without anyone noticing.
 *
 * `state` is passed in rather than kept module-level so that two runtimes in one
 * process — which is what the test suite is — do not share a clock.
 */
export async function sweepRetention({ store, artifacts, config, state, logger, now = Date.now() }) {
  if (now - (state.lastSweepAt ?? 0) < SWEEP_INTERVAL_MS) return null
  state.lastSweepAt = now

  const days = config.artifactRetainDays
  const before = new Date(now - days * 24 * 60 * 60 * 1000).toISOString()

  // Each half is attempted even when the other fails: a directory that cannot
  // be removed must not keep a month of rows alive, and vice versa.
  let runs = 0
  try {
    runs = (await artifacts.purgeOlderThan(days)).length
  } catch (error) {
    logger?.error?.(`[retention] 产物清理失败：${error.message}`)
  }
  let events = 0
  try {
    events = (await store.purgeRunEvents(before)) ?? 0
  } catch (error) {
    logger?.error?.(`[retention] 进度事件清理失败：${error.message}`)
  }
  if (runs > 0 || events > 0) {
    logger?.log?.(`[retention] 清理了 ${runs} 次执行的产物、${events} 条进度事件（保留 ${days} 天）`)
  }
  return { runs, events }
}

export async function start(config = loadConfig(), options) {
  const runtime = await createRuntime(config, options)
  const server = createServer(runtime.app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  const close = async () => {
    runtime.stopScheduler()
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await runtime.store.close()
  }
  return { ...runtime, server, port: server.address().port, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig()
  const runtime = await start(config)
  console.log(
    `mx-test-framework listening on http://${config.host}:${config.port} (store=${config.storeDriver})`,
  )
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await runtime.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
