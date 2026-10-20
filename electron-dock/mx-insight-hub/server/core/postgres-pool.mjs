import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'

// Request-scoped database lane. A data API request starts in `admission`: it
// has reserved nothing and dispatched nothing, so under pressure it waits in
// memory behind work that already holds a reservation or a paid call
// (`inflight`) and behind control traffic such as login, status reads and
// workers (`default`). Waiting here holds no PG client, wallet hold or
// provider slot. Each HTTP request owns one mutable holder.
const databaseLane = new AsyncLocalStorage()

export function runWithDatabaseLane(operation) {
  return databaseLane.run({ lane: 'default', arrivedAt: Date.now() }, operation)
}

export function enterAdmissionLane() {
  const holder = databaseLane.getStore()
  if (holder) holder.lane = 'admission'
}

function currentArrival() {
  return databaseLane.getStore()?.arrivedAt ?? Date.now()
}

// Called once a usage reservation exists. From here on the request's own
// settlement must not queue behind newer, not yet reserved, requests.
export function promoteAdmittedWork() {
  const holder = databaseLane.getStore()
  if (holder?.lane === 'admission') holder.lane = 'inflight'
}

export function currentDatabaseLane() {
  return databaseLane.getStore()?.lane ?? 'default'
}

// Runs `operation` in another lane without changing the request's own lane.
// Recording how a request ended is control work, even for a request that
// itself never got past admission; it must not queue behind the burst.
export function runInDatabaseLane(lane, operation) {
  if (!['default', 'admission', 'inflight'].includes(lane)) throw new TypeError('Unknown database lane')
  return databaseLane.run({ lane, arrivedAt: databaseLane.getStore()?.arrivedAt ?? Date.now() }, operation)
}

function inheritedGetter(object, name) {
  for (let prototype = Object.getPrototypeOf(object); prototype; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    if (descriptor?.get) return descriptor.get
  }
  return () => 0
}

// Hub-owned pools only. A checkout timeout removes the queued operation before
// it can run; it must not be simulated by racing a still-running DB write.
export function createHubPostgresPool(options = {}, { logger = console, Pool = pg.Pool } = {}) {
  const {
    maxWaitingClients = 512,
    // Lane waits are memory-only. In-flight work is the top lane, so its
    // longer limit is a safety net against `persistence_unknown`, not a delay.
    inflightCheckoutTimeoutMillis = 15000,
    // Long enough for a burst to drain oldest-first on a slow disk; short
    // enough to answer busy well inside a 60-second proxy budget.
    admissionCheckoutTimeoutMillis = 20000,
    ...pgOptions
  } = options
  for (const [name, value] of Object.entries({ maxWaitingClients, inflightCheckoutTimeoutMillis, admissionCheckoutTimeoutMillis })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  // Runtime pools only: migrations and source preparation use separate pools.
  // These are PostgreSQL-enforced limits, not a client-side query_timeout that
  // could report failure while a write continues. Transaction-local limits and
  // explicit pool options retain precedence.
  const pool = new Pool({ connectionTimeoutMillis: 5000,
    statement_timeout: 30000, lock_timeout: 5000, ...pgOptions })
  const capacity = pool.options.max
  const nativeWaiting = inheritedGetter(pool, 'waitingCount')
  // Checkouts are granted here, in lane order, before pg-pool sees them, so
  // pg-pool itself never holds more than `capacity` callers. `high` is FIFO
  // for default + inflight work; `low` only drains when `high` is empty and
  // is ordered by request arrival, so one request's sequential reads do not
  // re-queue behind every newer request of the same burst.
  const queues = { high: [], low: [] }
  const enqueue = (priority, entry) => {
    const queue = queues[priority]
    if (priority === 'high') { queue.push(entry); return }
    let index = queue.length
    while (index > 0 && queue[index - 1].arrivedAt > entry.arrivedAt) index -= 1
    queue.splice(index, 0, entry)
  }
  const granted = new Set()
  let checkedOut = 0
  let queueRejected = 0
  let acquireTimeouts = 0
  let waitingHighWatermark = 0
  let nextPressureLogAt = 0
  const laneWaiting = () => queues.high.length + queues.low.length
  Object.defineProperty(pool, 'waitingCount', {
    configurable: true,
    get: () => laneWaiting() + nativeWaiting.call(pool),
  })
  pool.getPressureSnapshot = () => ({
    maxConnections: pool.options.max,
    maxWaiting: maxWaitingClients,
    totalConnections: pool.totalCount,
    idleConnections: pool.idleCount,
    waitingConnections: pool.waitingCount,
    waitingByLane: {
      inflightOrDefault: queues.high.length,
      admission: queues.low.length,
    },
    waitingHighWatermark,
    queueRejected,
    acquireTimeouts,
  })
  const recordFailure = error => {
    if (hubDatabaseFailure(error)?.reason === 'connection_acquire_timeout') acquireTimeouts += 1
  }
  const grantNext = () => {
    while (checkedOut < capacity) {
      const entry = queues.high.shift() ?? queues.low.shift()
      if (!entry) return
      clearTimeout(entry.timer)
      checkedOut += 1
      entry.resolve()
    }
  }
  pool.on('release', (_error, client) => {
    if (!granted.delete(client)) return
    checkedOut -= 1
    // pg-pool emits before it returns the client to its idle list; grant the
    // slot once that bookkeeping has finished.
    queueMicrotask(grantNext)
  })
  const connect = pool.connect.bind(pool)
  const checkout = callback => {
    const settle = (error, client) => {
      if (error) {
        recordFailure(error)
        checkedOut -= 1
        grantNext()
      } else granted.add(client)
    }
    if (callback) {
      return connect((error, client, release) => {
        settle(error, client)
        callback(error, client, release)
      })
    }
    return connect().then(client => { settle(null, client); return client },
      error => { settle(error); throw error })
  }
  pool.connect = callback => {
    if (pool.ending) return connect(callback)
    const lane = currentDatabaseLane()
    const priority = lane === 'admission' ? 'low' : 'high'
    if (checkedOut < capacity && !queues.high.length && (priority === 'high' || !queues.low.length)) {
      checkedOut += 1
      return checkout(callback)
    }
    // A reserved or dispatched request must still be able to settle; the
    // cap sheds new and control work first.
    if (lane !== 'inflight' && pool.waitingCount >= maxWaitingClients) {
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
    const configured = pool.options.connectionTimeoutMillis || 0
    const timeoutMillis = configured === 0 ? 0
      : lane === 'inflight' ? Math.max(configured, inflightCheckoutTimeoutMillis)
        : lane === 'admission' ? Math.max(configured, admissionCheckoutTimeoutMillis)
          : configured
    const turn = new Promise((resolve, reject) => {
      const entry = { resolve, reject, arrivedAt: currentArrival() }
      if (timeoutMillis > 0) {
        entry.timer = setTimeout(() => {
          const queue = queues[priority]
          const index = queue.indexOf(entry)
          if (index < 0) return
          queue.splice(index, 1)
          const error = new Error('timeout exceeded when trying to connect')
          recordFailure(error)
          reject(error)
        }, timeoutMillis)
      }
      enqueue(priority, entry)
    })
    waitingHighWatermark = Math.max(waitingHighWatermark, pool.waitingCount)
    if (callback) {
      turn.then(() => checkout(callback), error => callback(error))
      return undefined
    }
    return turn.then(() => checkout())
  }
  const end = pool.end.bind(pool)
  pool.end = callback => {
    for (const entry of [...queues.high.splice(0), ...queues.low.splice(0)]) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Cannot use a pool after calling end on the pool'))
    }
    return end(callback)
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

// For workers whose PostgreSQL writes are bookkeeping derived from rows that
// another transaction already committed synchronously (e.g. projector outbox
// claims/acks). A server crash can lose the last few hundred milliseconds of
// such COMMITs, always as a WAL suffix, so the affected work is redone; it
// never makes another reader act on data that later disappears. Do not use it
// for request settlement, ingest that the projector reads, or billing.
export function relaxDerivedCommits(pool, synchronousCommit, { logger = console } = {}) {
  if (synchronousCommit !== 'off') return pool
  pool.on('connect', (client) => {
    // pg-pool emits this before handing the new client to its first caller,
    // so the SET is queued ahead of that caller's statements.
    client.query('SET synchronous_commit TO off').catch((error) => {
      try { logger.warn?.({ event: 'derived_commit_setting_failed', sqlState: /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : null }) } catch { /* diagnostics only */ }
    })
  })
  return pool
}

export function hubDatabaseFailure(error) {
  if (error?.code === 'HUB_PG_QUEUE_FULL') return { reason: 'connection_queue_full', sqlState: null }
  if (['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout'].includes(error?.message)) {
    return { reason: 'connection_acquire_timeout', sqlState: null }
  }
  // node-postgres' own wording when the server or network drops an active
  // session; these carry no SQLSTATE and otherwise surface as a bare 500.
  if (['Connection terminated unexpectedly', 'Connection terminated'].includes(error?.message)) {
    return { reason: 'connection_unavailable', sqlState: null }
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
