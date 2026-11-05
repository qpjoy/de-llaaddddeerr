// Dedicated worker for the Twitter user-email dictionary ("Twitter 用户清洗计划").
//
// It is the only Hub process that streams the large source file. It writes
// PostgreSQL only (schema account_dictionary): no outbox, Elasticsearch, HanLP
// or embeddings, and it never touches Launcher, login or network paths. One
// session advisory lock keeps it single-flight even if scaled above one Pod.
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { loadConfig } from '../config.mjs'
import { ServerFileReader, parseServerFileRoots } from '../ingest/external/server-files.mjs'
import { TwitterUserEmailStore } from '../data/twitter-user-email/store.mjs'
import { TwitterUserEmailEngine, runDictionaryWorker } from '../data/twitter-user-email/engine.mjs'

export async function main(config = loadConfig()) {
  if (config.storeDriver !== 'postgres') throw new Error('dictionary worker requires MX_INSIGHT_STORE=postgres')
  // No statement timeout: index builds on a 12.5M-row partition take minutes.
  // Explicit lock timeouts are set around DDL that touches shared parents.
  const pool = new pg.Pool({
    connectionString: config.common.postgres.url,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'mx-insight-hub-dictionary-worker',
  })
  pool.on('error', () => console.warn('[dictionary] idle database connection lost'))
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    // Runs with MX_INSIGHT_LISTENER_MODE=public (no Admin token), where config
    // drops file roots; this worker reads the same deployment allowlist itself.
    const roots = config.serverFiles?.roots?.length ? config.serverFiles.roots : parseServerFileRoots(process.env.MX_INSIGHT_SERVER_FILE_ROOTS)
    const fileReader = await ServerFileReader.create({ roots })
    const store = new TwitterUserEmailStore(pool)
    const engine = new TwitterUserEmailEngine({ pool, store, fileReader, workerId: `${hostname()}:${process.pid}` })
    console.log('[dictionary] worker started (PostgreSQL only; no Elasticsearch projection)')
    await runDictionaryWorker({ pool, engine, signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
