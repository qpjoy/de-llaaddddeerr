import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { PriceSyncRestoreService } from '../commercial/price-sync-restore.mjs'

export function restoreArguments(args) {
  if (args.length === 4 && args[0] === '--preview' && args[2] === '--selection') {
    let selection
    try { selection = JSON.parse(args[3]) } catch { throw new Error('Usage: --selection requires a JSON object') }
    return { mode: 'preview', sourceBatchId: args[1], selection }
  }
  if (args.length === 2 && args[0] === '--show') return { mode: 'show', id: args[1] }
  if (args.length === 4 && args[0] === '--apply' && args[2] === '--preview-hash') return { mode: 'apply', id: args[1], hash: args[3] }
  throw new Error('Usage: --preview SOURCE_BATCH --selection JSON | --show RESTORE_BATCH | --apply RESTORE_BATCH --preview-hash HASH')
}
export async function main(args = process.argv.slice(2)) {
  const options = restoreArguments(args)
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 10000, statement_timeout: 60000, idle_in_transaction_session_timeout: 120000,
    application_name: 'hub-targeted-price-restore' })
  try {
    const service = new PriceSyncRestoreService({ pool })
    return options.mode === 'preview' ? await service.preview(options.sourceBatchId, options.selection)
      : options.mode === 'apply' ? await service.apply(options.id, options.hash) : await service.batch(options.id)
  } finally { await pool.end() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
    const safe = error.name === 'AppError' || error.message.startsWith('Usage:') || error.message === 'DATABASE_URL is required'
    console.error(JSON.stringify({ ok: false, code: error.name === 'AppError' ? error.code : 'price_restore_failed',
      message: safe ? error.message : 'Price restore failed; check the saved restore batch before retrying.' }))
    process.exitCode = 1
  })
}
