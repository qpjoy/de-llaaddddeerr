import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createApp } from './app.mjs'
import { ArtifactStore } from './artifacts.mjs'
import { loadConfig } from './config.mjs'
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
  const artifacts = new ArtifactStore({ root: config.artifactsDir })
  const dispatcher = new KubernetesDispatcher({ config, namespace: config.namespace })
  const app = createApp({ store, config, identity, artifacts })

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
          return dispatchServerRuns({ store, dispatcher, config })
        },
      })
    : () => {}
  return { store, app, config, identity, artifacts, dispatcher, stopScheduler }
}

async function dispatchServerRuns({ store, dispatcher, config }) {
  const { runnerEnv } = await import('./app.mjs')
  const { newToken, sha256 } = await import('./core/ids.mjs')
  return dispatchQueued({
    store,
    dispatcher,
    config,
    buildEnv: ({ run, suite, app }) => runnerEnv({ run, suite, app, config }),
    issueRunToken: async (run) => {
      const token = newToken('mxt-run')
      await store.updateRun(run.id, { runTokenSha256: sha256(token) })
      return token
    },
  })
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
