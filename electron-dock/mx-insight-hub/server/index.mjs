import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NightAllAdapter } from './adapters/night-all.mjs'
import { createApp } from './app.mjs'
import { loadConfig } from './config.mjs'
import { HubService } from './hub-service.mjs'
import { MemoryStore } from './stores/memory-store.mjs'
import { createPostgresStore } from './stores/postgres-store.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function createRuntime(config = loadConfig()) {
  const store = config.storeDriver === 'postgres'
    ? await createPostgresStore({ connectionString: config.databaseUrl })
    : new MemoryStore()
  const adapter = new NightAllAdapter(config.nightAll)
  const service = new HubService({
    store,
    adapter,
    apiKeyPepper: config.apiKeyPepper,
    reservationLeaseMs: config.reservationLeaseMs,
  })
  const app = createApp({
    service,
    store,
    adapter,
    adminToken: config.adminToken,
    listenerMode: config.listenerMode,
    staticRoot: config.listenerMode === 'public' ? null : resolve(projectRoot, 'dist/client'),
  })
  return { app, store, adapter, service }
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
