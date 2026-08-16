export const SEARCH_REINDEX_LOCK_NAME = 'mx-insight-hub:search:full-reindex:v1'

/**
 * Try to acquire the session-level fence for a full content+chunk rebuild.
 *
 * The returned client must remain healthy and checked out for the lifetime of
 * the rebuild. Callers that do background work should use that same client for
 * progress heartbeats so a lost lock session aborts the work promptly.
 */
export async function tryAcquireSearchReindexLock(pool) {
  if (!pool?.connect) throw new TypeError('Search reindex requires a PostgreSQL pool')
  const client = await pool.connect()
  try {
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [SEARCH_REINDEX_LOCK_NAME],
    )
    if (!rows[0]?.locked) {
      client.release()
      return null
    }
    let released = false
    return {
      client,
      async release() {
        if (released) return
        released = true
        let releaseError = null
        try {
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [SEARCH_REINDEX_LOCK_NAME],
          )
        } catch (error) {
          releaseError = error instanceof Error ? error : new Error(String(error))
        }
        client.release(releaseError || undefined)
      },
    }
  } catch (error) {
    client.release()
    throw error
  }
}

export async function requireSearchReindexLock(pool, { busyMessage } = {}) {
  const lock = await tryAcquireSearchReindexLock(pool)
  if (lock) return lock
  const error = new Error(
    busyMessage || 'another CLI, Admin, or Projector search reindex is already running',
  )
  error.code = 'search_reindex_busy'
  throw error
}

/** Verify that the session which owns the advisory lock is still alive. */
export async function heartbeatSearchReindexLock(lock) {
  if (!lock?.client?.query) throw new TypeError('Search reindex lock is not acquired')
  await lock.client.query('SELECT 1')
}

/**
 * Keep a long-running lock session out of PostgreSQL/proxy idle timeouts.
 *
 * Timer errors are retained rather than becoming unhandled rejections. The
 * rebuild checks the monitor at every batch boundary and before reporting
 * success, so work cannot continue into another batch after the fence is lost.
 */
export function monitorSearchReindexLock(lock, { intervalMs = 10_000 } = {}) {
  if (!lock?.client?.query) throw new TypeError('Search reindex lock is not acquired')
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new TypeError('Search reindex heartbeat interval must be positive')
  }

  let stopped = false
  let timer = null
  let inFlight = null
  let failure = null

  const recordFailure = (error) => {
    failure ||= error instanceof Error ? error : new Error(String(error))
    return failure
  }
  const assertHealthy = () => {
    if (failure) throw failure
  }
  const pulse = async () => {
    assertHealthy()
    try {
      await heartbeatSearchReindexLock(lock)
    } catch (error) {
      throw recordFailure(error)
    }
  }
  lock.client.on?.('error', recordFailure)
  const schedule = () => {
    if (stopped || failure) return
    timer = setTimeout(async () => {
      inFlight = pulse()
      await inFlight.catch(() => {})
      inFlight = null
      schedule()
    }, intervalMs)
    timer.unref?.()
  }
  schedule()

  return {
    assertHealthy,
    pulse,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await inFlight?.catch(() => {})
      lock.client.off?.('error', recordFailure)
    },
  }
}
