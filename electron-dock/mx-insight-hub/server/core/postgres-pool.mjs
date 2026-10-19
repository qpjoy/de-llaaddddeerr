import pg from 'pg'

// Hub-owned pools only. A checkout timeout removes the queued operation in
// pg-pool itself; it must not be simulated by racing a still-running DB write.
export function createHubPostgresPool(options = {}, { logger = console, Pool = pg.Pool } = {}) {
  const { maxWaitingClients = 512, ...pgOptions } = options
  if (!Number.isSafeInteger(maxWaitingClients) || maxWaitingClients < 0) {
    throw new TypeError('maxWaitingClients must be a non-negative safe integer')
  }
  // Runtime pools only: migrations and source preparation use separate pools.
  // These are PostgreSQL-enforced limits, not a client-side query_timeout that
  // could report failure while a write continues. Transaction-local limits and
  // explicit pool options retain precedence.
  const pool = new Pool({ connectionTimeoutMillis: 5000,
    statement_timeout: 30000, lock_timeout: 5000, ...pgOptions })
  let queueRejected = 0
  let acquireTimeouts = 0
  let waitingHighWatermark = 0
  let nextPressureLogAt = 0
  pool.getPressureSnapshot = () => ({
    maxConnections: pool.options.max,
    maxWaiting: maxWaitingClients,
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingConnections: pool.waitingCount,
    waitingHighWatermark,
    queueRejected,
    acquireTimeouts,
  })
  const recordFailure = error => {
    if (hubDatabaseFailure(error)?.reason === 'connection_acquire_timeout') acquireTimeouts += 1
  }
  const connect = pool.connect.bind(pool)
  pool.connect = callback => {
    // pg-pool owns FIFO ordering, checkout timers and removal on timeout. Cap
    // its queue before adding an entry; keep native client/release semantics.
    // Idle checkouts briefly enter that queue too, so allow the first one even
    // when operators choose no waiting (maxWaitingClients=0).
    const mustWait = pool.waitingCount > 0 || (pool.idleCount === 0 && pool.totalCount >= pool.options.max)
    if (!pool.ending && mustWait && pool.waitingCount >= maxWaitingClients) {
      queueRejected += 1
      if (Date.now() >= nextPressureLogAt) {
        nextPressureLogAt = Date.now() + 30000
        try {
          logger.warn?.({ event: 'hub_postgres_queue_full', ...pool.getPressureSnapshot() })
        } catch { /* A diagnostic sink cannot change admission behavior. */ }
      }
      const error = Object.assign(new Error('Hub PostgreSQL connection queue is full'), { code: 'HUB_PG_QUEUE_FULL' })
      if (callback) { queueMicrotask(() => callback(error)); return undefined }
      return pool.Promise.reject(error)
    }
    const result = connect(callback ? (error, client, release) => {
      recordFailure(error)
      callback(error, client, release)
    } : undefined)
    waitingHighWatermark = Math.max(waitingHighWatermark, pool.waitingCount)
    return callback ? result : result.catch(error => { recordFailure(error); throw error })
  }
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
  if (error?.code === 'HUB_PG_QUEUE_FULL') return { reason: 'connection_queue_full', sqlState: null }
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
