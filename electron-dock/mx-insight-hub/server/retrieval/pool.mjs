import pg from 'pg'
// Isolate expensive search/background work from public dispatch connections.
// Primary reads are intentional: stale/deleted evidence must fail closed.
export function createRetrievalPool(config, { worker = false } = {}) {
  const pool = new pg.Pool({
    connectionString: config.url,
    max: worker ? 5 : 4,
    statement_timeout: worker ? 15000 : 5000,
    connectionTimeoutMillis: 1500,
    idleTimeoutMillis: 30000,
    application_name: worker ? 'mx-insight-hub-retrieval-worker' : 'mx-insight-hub-retrieval-api',
  })
  // Idle connection failures must not crash the Admin API's unrelated routes.
  pool.on('error', () => console.warn('[retrieval] idle database connection lost'))
  return pool
}
