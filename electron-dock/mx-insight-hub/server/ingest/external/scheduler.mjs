import { EXTERNAL_PULL_QUEUE } from './sync-job.mjs'

/** Schedule one incremental scan for every active foreign database source. */
export async function scheduleActiveDatabaseSources({ store, queue, batchSize = 1_000 }) {
  const sources = await store.listExternalSources()
  let enqueued = 0
  for (const source of sources) {
    if (source.sourceKind !== 'database' || source.status !== 'active') continue
    const cursor = await queue.getCursor(`external:${source.sourceKey}`)
    // A running continuation owns this source. Failed cursors require an
    // operator to fix/probe and explicitly resume; automatic retries would
    // turn a deterministic mapping failure into an alert storm.
    if (cursor && cursor.status !== 'idle') continue
    const jobId = await queue.enqueue(
      EXTERNAL_PULL_QUEUE,
      { sourceKey: source.sourceKey, batchSize, chunk: 0 },
      { dedupeKey: `external-pull:${source.sourceKey}:0`, priority: 220 },
    )
    if (jobId != null) enqueued += 1
  }
  return { active: sources.filter((source) => source.sourceKind === 'database' && source.status === 'active').length, enqueued }
}

function waitForNextScan(intervalMs, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, intervalMs)
    function done() {
      signal?.removeEventListener?.('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}

/** Keep active sources incremental after their initial full scan reaches idle. */
export async function runExternalPullScheduler({ store, queue, batchSize, intervalMs, signal, logger = console }) {
  while (!signal?.aborted) {
    try {
      const result = await scheduleActiveDatabaseSources({ store, queue, batchSize })
      if (result.enqueued > 0) logger.log?.(`[external] scheduled ${result.enqueued}/${result.active} active database source(s)`)
    } catch (error) {
      const candidate = typeof error?.code === 'string' ? error.code : error?.name
      const code = typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate)
        ? candidate
        : 'scheduler_failed'
      logger.warn?.(`[external] scheduler failed code=${code}`)
    }
    await waitForNextScan(intervalMs, signal)
  }
}
