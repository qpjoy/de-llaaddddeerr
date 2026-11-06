// Dedicated worker for every file dataset ("文件数据集" cleaning tasks:
// Twitter 用户清洗计划, 邮箱库清洗计划, 手机号库清洗计划, ...).
//
// It is the only Hub process that streams the large source files. It writes
// PostgreSQL only (schema account_dictionary): no outbox, Elasticsearch, HanLP
// or embeddings, and it never touches Launcher, login or network paths. One
// session advisory lock keeps it single-flight even if scaled above one Pod,
// and it processes one dataset version at a time.
import { hostname } from 'node:os'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { loadConfig } from '../config.mjs'
import { ServerFileReader, parseServerFileRoots } from '../ingest/external/server-files.mjs'
import { runDictionaryWorker } from '../data/file-datasets/engine.mjs'
import { createFileDatasetEngines } from '../data/file-datasets/services.mjs'

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
    const engines = createFileDatasetEngines({ pool, fileReader, workerId: `${hostname()}:${process.pid}` })
    console.log(`[dictionary] worker started for ${engines.length} file datasets (PostgreSQL only; no Elasticsearch projection)`)
    await runDictionaryWorker({ pool, engines, signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
