import { createServer } from 'node:http'
import { createPool, createQueue } from '@qpjoy/mx-common'
import { createSegmenter } from '@qpjoy/mx-common/segmenter'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NightAllAdapter } from './adapters/night-all.mjs'
import { JustOneAdapter } from './adapters/justone.mjs'
import { createApp } from './app.mjs'
import { loadConfig } from './config.mjs'
import { HubService } from './hub-service.mjs'
import { ExternalPlatformAdminService } from './external-platforms/admin.mjs'
import { ExternalPlatformGateway } from './external-platforms/gateway.mjs'
import { createExternalPlatformStore } from './external-platforms/store.mjs'
import { createAgentRuntime } from './agent/runtime.mjs'
import { AgentSettingsStore } from './agent/settings-store.mjs'
import { AgentControlStore } from './agent/control-store.mjs'
import { AgentPipelineStore } from './agent/pipeline-store.mjs'
import { AgentMarketStore } from './agent-market/store.ts'
import { AgentStudioStore } from './agent-studio/store.mjs'
import { createSearch } from './search/index.mjs'
import { AdminSearchReindex } from './search/admin-reindex.mjs'
import { EmbeddingPipeline } from './embedding/pipeline.mjs'
import { ExternalImporter } from './ingest/external/importer.mjs'
import { DatabaseSourcePuller } from './ingest/external/database-source.mjs'
import { SQLiteApiSourcePuller } from './ingest/external/sqlite-api-source.mjs'
import { ServerFileReader } from './ingest/external/server-files.mjs'
import { TelegramMonitorSourcePreparer } from './ingest/telegram/source-preparer.mjs'
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
  const serverFileReader = config.listenerMode === 'public'
    ? null
    : await ServerFileReader.create({ roots: config.serverFiles?.roots || [] })
  const databasePuller = config.storeDriver === 'postgres'
    ? new DatabaseSourcePuller({ store, queue })
    : null
  const sqliteApiPuller = config.storeDriver === 'postgres'
    ? new SQLiteApiSourcePuller({ store, queue })
    : null
  const telegramSourcePreparer = config.storeDriver === 'postgres'
    ? new TelegramMonitorSourcePreparer()
    : null
  // Reports `available: false` with no providers configured; every caller has a
  // deterministic fallback, so the agent is an accelerator, not a dependency.
  // Only the admin/combined API loads model credentials. The public listener has
  // no Agent route and must not query the plaintext credential table.
  const agentSettings = pool && config.listenerMode !== 'public'
    ? new AgentSettingsStore(pool)
    : null
  const agentControl = pool && config.listenerMode !== 'public'
    ? new AgentControlStore(pool, { deploymentEgress: config.deploymentEgress })
    : null
  const agentPipelines = pool && config.listenerMode !== 'public'
    ? new AgentPipelineStore(pool)
    : null
  const agentMarket = pool && config.listenerMode !== 'public'
    ? new AgentMarketStore(pool)
    : null
  const agentStudio = pool && config.listenerMode !== 'public'
    ? new AgentStudioStore(pool)
    : null
  const agent = await createAgentRuntime({
    config,
    settingsStore: agentSettings,
    controlStore: agentControl,
    // The public listener exposes neither Agent routes nor model-backed work.
    // Keep its runtime empty even if provider metadata exists in the ConfigMap.
    managedKinds: config.listenerMode === 'public' ? [] : ['chat', 'embedding'],
  })
  // Read-only here. The API serves retrieval queries and reports pipeline
  // status; the writing stages belong to the projector workload.
  const search = pool ? createSearch({ pool, config: config.common }) : null
  const searchReindex = search && config.listenerMode !== 'public'
    ? new AdminSearchReindex({ search, segmenterConfig: config.common.segmenter })
    : null
  const segmenter = search?.segmenter ?? createSegmenter(config.common.segmenter)
  const externalPlatformStore = createExternalPlatformStore({
    pool,
    usageStore: store,
    circuitFailureThreshold: config.justOne.circuitFailureThreshold,
    circuitOpenMs: config.justOne.circuitOpenMs,
    uncertainCooldownMs: config.justOne.unknownFingerprintCooldownMs,
  })
  // JustOne is optional and is never a Hub readiness dependency. The admin
  // listener still receives truthful configuration/analytics, while only a
  // listener that serves public APIs constructs the credentialed adapter.
  const justOneAdapter = config.justOne.dispatchEnabled && config.listenerMode !== 'admin'
    ? new JustOneAdapter({
        token: config.justOne.token,
        timeoutMs: config.justOne.timeoutMs,
      })
    : null
  const externalPlatformAdmin = new ExternalPlatformAdminService({
    store: externalPlatformStore,
    config: config.justOne,
    durable: Boolean(pool),
  })
  const externalPlatformGateway = new ExternalPlatformGateway({
    usageStore: store,
    platformStore: externalPlatformStore,
    adapter: justOneAdapter,
    config: config.justOne,
    apiKeyPepper: config.apiKeyPepper,
    reservationLeaseMs: config.reservationLeaseMs,
  })
  const service = new HubService({
    store,
    adapter,
    apiKeyPepper: config.apiKeyPepper,
    reservationLeaseMs: config.reservationLeaseMs,
    searchQueries: search?.queries ?? null,
    segmenter,
    externalPlatformCapabilities: () => externalPlatformGateway.capabilities(),
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
    serverFileReader,
    databasePuller,
    sqliteApiPuller,
    telegramSourcePreparer,
    agent,
    agentPipelines,
    agentMarket,
    agentStudio,
    search,
    searchReindex,
    embedding,
    externalPlatformAdmin,
    externalPlatformGateway,
    segmenterConfig: config.common.segmenter,
    launcherAudience: config.launcher.audience,
    backfillPlatforms: config.backfill.platforms,
    adminToken: config.adminToken,
    listenerMode: config.listenerMode,
    staticRoot: config.listenerMode === 'public' ? null : resolve(projectRoot, 'dist/client'),
  })
  return {
    app, store, adapter, service, identity, queue, pool, importer, serverFileReader,
    databasePuller, sqliteApiPuller, telegramSourcePreparer, agent, agentSettings,
    agentPipelines, agentMarket, agentStudio,
    search, searchReindex, embedding, externalPlatformStore,
    externalPlatformAdmin, externalPlatformGateway, justOneAdapter,
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
    runtime.agent.close()
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
