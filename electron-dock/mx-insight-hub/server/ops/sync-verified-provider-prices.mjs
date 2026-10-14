import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { VerifiedPriceSyncService, summarizePriceSync } from '../commercial/price-sync.mjs'

export function priceSyncArguments(args) {
  if (args.length === 1 && args[0] === '--preview') return { mode: 'preview' }
  if ((args.length === 2 || (args.length === 3 && args[2] === '--details')) && args[0] === '--show') return { mode: 'show', id: args[1], details: args[2] === '--details' }
  if (args.length === 4 && args[0] === '--apply' && args[2] === '--preview-hash') return { mode: 'apply', id: args[1], hash: args[3] }
  throw new Error('Usage: --preview | --show BATCH_ID [--details] | --apply BATCH_ID --preview-hash SHA256')
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = priceSyncArguments(args)
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1,
    application_name: 'hub-verified-price-sync', connectionTimeoutMillis: 10000,
    statement_timeout: 60000, idle_in_transaction_session_timeout: 120000 })
  try {
    const service = new VerifiedPriceSyncService({ pool })
    if (options.mode === 'preview') return await service.preview()
    if (options.mode === 'apply') return await service.apply(options.id, options.hash)
    const batch = await service.batch(options.id)
    return options.details ? batch : { id: batch.id, status: batch.status, hash: batch.hash,
      expiresAt: batch.expiresAt, summary: summarizePriceSync(batch.preview), result: batch.result }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    // Database errors can contain connection details; only expose curated errors.
    const safe = error.name === 'AppError' || error.message.startsWith('Usage:') || error.message === 'DATABASE_URL is required'
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.name === 'AppError' ? error.code : 'price_sync_failed',
      message: safe ? error.message : 'Price synchronization failed; no confirmed success. Check the saved batch before retrying.' })}\n`)
    process.exitCode = 1
  })
}
