import { readFileSync } from 'node:fs'
import { createStaticService } from './service.mjs'
const readSecret = (name) => process.env[`${name}_FILE`] ? readFileSync(process.env[`${name}_FILE`], 'utf8').trim() : process.env[name]
const server = createStaticService({
  writerUrl: process.env.MX_STATIC_WRITER_URL || '',
  root: process.env.MX_STATIC_DATA_DIR || '/data',
  stateDir: process.env.MX_STATIC_STATE_DIR || '/state',
  queueOptions: { maxQueued: Number(process.env.MX_STATIC_MAX_QUEUED || 10000) },
  maxConcurrency: Number(process.env.MX_STATIC_WORKERS || 4),
  cacheOptions: { maxBytes: Number(process.env.MX_STATIC_CACHE_BYTES || 67108864), ttlMs: Number(process.env.MX_STATIC_CACHE_TTL_MS || 60000) },
  projects: JSON.parse(readSecret('MX_STATIC_PROJECTS') || '{}'),
  signingKey: readSecret('MX_STATIC_SIGNING_KEY'),
  publicUrl: process.env.MX_STATIC_PUBLIC_URL || '',
  allowedOrigins: (process.env.MX_STATIC_CORS_ORIGINS || '').split(',').filter(Boolean),
  readOnly: process.env.MX_STATIC_READ_ONLY === 'true',
})
server.listen(Number(process.env.PORT || 18200), '0.0.0.0', () => console.log('mx-static ready'))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  setTimeout(() => process.exit(1), 35_000).unref()
  const drained = new Promise(resolve => server.close(resolve))
  await server.shutdown()
  await drained
  process.exit(0)
})
