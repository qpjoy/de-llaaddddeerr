import { createServer } from 'node:http'
import { createPool, createQueue } from '@qpjoy/mx-common'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NightAllAdapter } from './adapters/night-all.mjs'
import { createApp } from './app.mjs'
import { loadConfig } from './config.mjs'
import { HubService } from './hub-service.mjs'
import { createAgent } from './agent/index.mjs'
import { createSearch } from './search/index.mjs'
import { EmbeddingPipeline } from './embedding/pipeline.mjs'
import { ExternalImporter } from './ingest/external/importer.mjs'
import { DatabaseSourcePuller } from './ingest/external/database-source.mjs'
import { ProviderRegistry } from './ingest/external/provider-registry.mjs'
import { createIdentityService } from './identity/index.mjs'
import { MemoryStore } from './stores/memory-store.mjs'
import { createPostgresStore } from './stores/postgres-store.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function createRuntime(config = loadConfig()) {
  const store = config.storeDriver === 'postgres'
    ? await createPostgresStore({ connectionString: config.databaseUrl })
    : new MemoryStore()
  const adapter = new NightAllAdapter(config.nightAll)
  // The queue is only reachable with a real database. Without one the admin
  // backfill routes report unavailable rather than pretending to schedule work.
  const pool = config.storeDriver === 'postgres'
    ? createPool(config.common.postgres, { applicationName: 'mx-insight-hub-api' })
    : null
  const queue = pool ? createQueue({ ...config.common.queue, driver: 'postgres' }, { pool }) : null
  // Constructed unconditionally; it reports `enabled: false` when no Launcher
  // URL is configured, so the admin-token path is unaffected either way.
  const identity = createIdentityService({ store, launcher: config.launcher })
  // External imports write through the canonical path, which only the
  // PostgreSQL store implements.
  const importer = config.storeDriver === 'postgres' ? new ExternalImporter({ store }) : null
  const providerRegistry = config.storeDriver === 'postgres' && config.providerMasterKey
    ? new ProviderRegistry({ store, masterKey: config.providerMasterKey })
    : null
  const databasePuller = config.storeDriver === 'postgres'
    ? new DatabaseSourcePuller({ store, queue, providerRegistry })
    : null
  // Reports `available: false` with no providers configured; every caller has a
  // deterministic fallback, so the agent is an accelerator, not a dependency.
  const agent = createAgent({ config })
  // Read-only here. The API serves retrieval queries and reports pipeline
  // status; the writing stages belong to the projector workload.
  const search = pool ? createSearch({ pool, config: config.common }) : null
  const service = new HubService({
    store,
    adapter,
    apiKeyPepper: config.apiKeyPepper,
    reservationLeaseMs: config.reservationLeaseMs,
    searchQueries: search?.queries ?? null,
  })
  const embedding = pool && search
    ? new EmbeddingPipeline({
        pool,
        agent,
        client: search.client,
        segmenter: search.segmenter,
        chunkIndexSet: search.chunkIndexSet,
      })
    : null
  const app = createApp({
    service,
    store,
    adapter,
    identity,
    queue,
    importer,
    databasePuller,
    providerRegistry,
    agent,
    search,
    embedding,
    launcherAudience: config.launcher.audience,
    backfillPlatforms: config.backfill.platforms,
    adminToken: config.adminToken,
    listenerMode: config.listenerMode,
    staticRoot: config.listenerMode === 'public' ? null : resolve(projectRoot, 'dist/client'),
  })
  return {
    app, store, adapter, service, identity, queue, pool, importer,
    providerRegistry, databasePuller, agent, search, embedding,
  }
}

export async function start(config = loadConfig()) {
  const runtime = await createRuntime(config)
  const server = createServer(runtime.app)
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolveListen)
  })
  const close = async () => {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    await runtime.store.close()
    await runtime.pool?.end()
  }
  return { ...runtime, server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig()
  const runtime = await start(config)
  console.log(`mx-insight-hub listening on http://${config.host}:${config.port} (${config.listenerMode})`)
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await runtime.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
