import pg from 'pg'

// Hub-owned pools only. A checkout timeout removes the queued operation in
// pg-pool itself; it must not be simulated by racing a still-running DB write.
export function createHubPostgresPool(options = {}, { logger = console, Pool = pg.Pool } = {}) {
  const pool = new Pool({ connectionTimeoutMillis: 5000, ...options })
  // pg-pool has already removed an idle connection before emitting this event.
  // An unhandled EventEmitter error would otherwise terminate the whole API
  // process when PostgreSQL restarts, including unrelated in-flight requests.
  pool.on('error', error => {
    try {
      logger.error?.({ event: 'hub_postgres_idle_connection_error',
        sqlState: /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : null })
    } catch { /* Diagnostic output cannot turn a removed idle client into a crash. */ }
  })
  return pool
}

export function hubDatabaseFailure(error) {
  if (['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout'].includes(error?.message)) {
    return { reason: 'connection_acquire_timeout', sqlState: null }
  }
  const codes = {
    '55P03': 'lock_timeout', '57014': 'statement_cancelled',
    '53300': 'connection_capacity', '57P01': 'database_shutdown',
    '57P02': 'database_shutdown', '57P03': 'database_unavailable',
    '08000': 'connection_unavailable', '08003': 'connection_unavailable',
    '08006': 'connection_unavailable', '08001': 'connection_unavailable',
    '08004': 'connection_unavailable', '08007': 'connection_unavailable',
  }
  return Object.hasOwn(codes, error?.code || '') ? { reason: codes[error.code], sqlState: error.code } : null
}
