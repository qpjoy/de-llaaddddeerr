export const EXTERNAL_PULL_QUEUE = 'external-pull'

/** Run one bounded source batch and enqueue exactly one continuation if needed. */
export async function runExternalPullJob({
  puller,
  queue,
  payload,
  job,
  signal,
  logger = console,
  heartbeatIntervalMs = 30_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const sourceKey = payload?.sourceKey
  if (!sourceKey) throw new Error('external pull payload is missing sourceKey')
  const heartbeat = () => queue.heartbeat(job.id).catch(() => {})
  await heartbeat()
  const timer = setIntervalFn(heartbeat, heartbeatIntervalMs)
  timer?.unref?.()
  let result
  try {
    result = await puller.pullBatch(sourceKey, { batchSize: payload.batchSize ?? 1_000 })
  } finally {
    clearIntervalFn(timer)
  }
  await heartbeat()
  logger.log?.(
    `[external] ${sourceKey} pulled=${result.pulled} ingested=${result.ingested} changed=${result.changed || 0} rejected=${result.rejected || 0} done=${result.done}`,
  )

  if (!result.done) {
    const nextChunk = (payload.chunk ?? 0) + 1
    // Persist the hand-off even during graceful shutdown. pullBatch has already
    // marked the durable cursor `running`; omitting the continuation here would
    // leave no job for the next worker while the periodic scheduler correctly
    // refuses to overlap a running source.
    await queue.enqueue(
      EXTERNAL_PULL_QUEUE,
      { ...payload, chunk: nextChunk },
      { dedupeKey: `external-pull:${sourceKey}:${nextChunk}`, priority: 220 },
    )
  }
  return result
}
